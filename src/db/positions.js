import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';
import { canOpenPositionAtCount, positionLimitFor, resolvePositionConfig } from './positionConfig.js';

export const HOLDING_STATUSES = ['open', 'entering', 'exiting'];

function holdingMarks() {
  return HOLDING_STATUSES.map(() => '?').join(', ');
}

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  const marks = holdingMarks();
  return db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN (${marks})`)
    .get(...HOLDING_STATUSES).count;
}

export function hasClosedPosition(mint) {
  return Boolean(db.prepare(
    "SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1",
  ).get(mint));
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = positionLimitFor(strat, numSetting('max_open_positions', 3));
  return canOpenPositionAtCount(openPositionCount(), strat, max);
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function positionConfig(strat, decision) {
  return resolvePositionConfig(strat, decision, {
    defaultSizeSol: numSetting('dry_run_buy_sol', 0.1),
    defaultTpPercent: numSetting('default_tp_percent', 50),
    defaultSlPercent: numSetting('default_sl_percent', -25),
    defaultTrailingEnabled: boolSetting('default_trailing_enabled', true),
    defaultTrailingPercent: numSetting('default_trailing_percent', 20),
  });
}

function existingHolding(mint) {
  const marks = holdingMarks();
  return db.prepare(
    `SELECT id, status FROM dry_run_positions WHERE mint = ? AND status IN (${marks}) LIMIT 1`,
  ).get(mint, ...HOLDING_STATUSES);
}

function assertAtomicCapacity(strat) {
  const max = positionLimitFor(strat, numSetting('max_open_positions', 3));
  const count = openPositionCount();
  if (!canOpenPositionAtCount(count, strat, max)) {
    throw new Error(`max open positions reached (${count}/${max})`);
  }
}

function insertRules(positionId, config) {
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(positionId, config.tpPercent, config.slPercent, config.trailingEnabled, config.trailingPercent, now());
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'rule_based_buy') {
  const strat = activeStrategy();
  let config = positionConfig(strat, decision);
  if (strat.id !== 'sniper') {
    const riskFlags = candidate.riskFlags || [];
    const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
    if (totalRiskSeverity >= 2) {
      config = { ...config, sizeSol: config.sizeSol * 0.5 };
      console.log(`[position] risk-adjusted size: ${config.sizeSol * 2} → ${config.sizeSol} SOL (total risk severity: ${totalRiskSeverity}, flags: ${riskFlags.map((flag) => flag.type).join(', ')})`);
    }
  }
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const rawEntryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const entryMcap = slippageAdjustedMcap(rawEntryMcap, 'entry');

  return db.transaction(() => {
    const existing = existingHolding(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };
    assertAtomicCapacity(strat);
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId, candidate.token.mint, candidate.token.symbol, now(), config.sizeSol,
      entryPrice, entryMcap, null, entryPrice, entryMcap, config.tpPercent, config.slPercent,
      config.trailingEnabled, config.trailingPercent, decision.id || null, strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const id = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, candidate.token.mint, now(), entryPrice, entryMcap, config.sizeSol, null, reason, json({ candidateId, decision }));
    insertRules(id, config);
    return { id, isNew: true };
  })();
}

export function beginLivePosition(candidateId, candidate, decision, reason = 'live_buy') {
  const strat = activeStrategy();
  const config = positionConfig(strat, decision);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  return db.transaction(() => {
    const existing = existingHolding(candidate.token.mint);
    if (existing) return { positionId: existing.id, duplicate: true, status: existing.status };
    assertAtomicCapacity(strat);
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'entering', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?)
    `).run(
      candidateId, candidate.token.mint, candidate.token.symbol, now(), config.sizeSol,
      entryPrice, entryMcap, null, entryPrice, entryMcap, config.tpPercent, config.slPercent,
      config.trailingEnabled, config.trailingPercent, decision.id || null, strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    insertRules(positionId, config);
    return { positionId, duplicate: false, status: 'entering' };
  })();
}

export function completeLivePosition(positionId, swap, reason = 'live_buy') {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
    if (!row) throw new Error(`position ${positionId} missing during live completion`);
    const snapshot = { ...JSON.parse(row.snapshot_json || '{}'), swap };
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'open', opened_at_ms = ?, entry_signature = ?, token_amount_raw = ?, snapshot_json = ?
      WHERE id = ? AND status = 'entering'
    `).run(now(), swap.signature || null, swap.outputAmount || null, json(snapshot), positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, row.mint, now(), row.entry_price, row.entry_mcap, row.size_sol, null, reason, json({ candidateId: row.candidate_id, swap }));
    return positionId;
  })();
}

export function failLivePosition(positionId, error) {
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_reason = 'FAILED_ENTRY', pnl_percent = 0, pnl_sol = 0
    WHERE id = ? AND status = 'entering'
  `).run(now(), positionId);
  if (error) {
    const row = db.prepare('SELECT snapshot_json FROM dry_run_positions WHERE id = ?').get(positionId);
    const snapshot = { ...JSON.parse(row?.snapshot_json || '{}'), entryError: String(error.message || error) };
    db.prepare('UPDATE dry_run_positions SET snapshot_json = ? WHERE id = ?').run(json(snapshot), positionId);
  }
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const reservation = beginLivePosition(candidateId, candidate, decision, reason);
  if (reservation.duplicate) return { id: reservation.positionId, isNew: false };
  completeLivePosition(reservation.positionId, swap, reason);
  return { id: reservation.positionId, isNew: true };
}
