import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';
import { DRY_RUN_LOCK } from '../config.js';
import { createEntryMetrics, shouldSimulateTxFailure } from '../services/performance.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from '../services/positionStatus.js';

export function openPositions() {
  return db.prepare(`SELECT * FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) ORDER BY opened_at_ms DESC`).all();
}

export function openPositionCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})`).get().count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  if (DRY_RUN_LOCK) return 'dry_run';
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const tp = entryTpPercent(decision, strat, trailingEnabled);
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status IN (${statusSqlList(ACTIVE_STATUSES)}) LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    if (shouldSimulateTxFailure()) {
      const failed = db.prepare(`
        INSERT INTO dry_run_positions (
          candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_price, entry_mcap,
          token_amount_est, high_water_price, high_water_mcap, current_price, current_mcap, tp_percent, sl_percent,
          trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id,
          simulated_entry_failed, exit_reason, pnl_percent, pnl_sol, gross_pnl_sol, net_pnl_sol,
          opened_at, closed_at, remaining_amount, realized_pnl_sol, realized_pnl_percent, is_closed, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidateId,
        candidate.token.mint,
        candidate.token.symbol,
        POSITION_STATUS.FAILED_ENTRY,
        now(),
        now(),
        sizeSol,
        entryPrice,
        entryMcap,
        null,
        entryPrice,
        entryMcap,
        entryPrice,
        entryMcap,
        tp,
        sl,
        trailingEnabled,
        trailingPercent,
        0,
        decision.id || null,
        strat.id,
        1,
        'FAILED_ENTRY',
        0,
        -numSetting('dry_run_priority_fee_sol', 0.0005),
        0,
        -numSetting('dry_run_priority_fee_sol', 0.0005),
        new Date(now()).toISOString(),
        new Date(now()).toISOString(),
        0,
        -numSetting('dry_run_priority_fee_sol', 0.0005),
        0,
        1,
        json({ candidate, decision, reason, strategy: strat.id, simulatedFailure: 'entry' }),
      );
      const positionId = Number(failed.lastInsertRowid);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'FAILED_ENTRY', ?)
      `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, json({ candidateId, decision, simulatedFailure: true }));
      createEntryMetrics({ positionId, candidateId, candidate, decision, strategyId: strat.id, mode: 'dry_run', reason, failed: true });
      db.prepare(`
        UPDATE dryrun_trade_metrics
        SET exit_at_ms = ?, exit_reason = 'FAILED_ENTRY', net_pnl_sol = ?, gross_pnl_sol = 0, notes = ?
        WHERE position_id = ?
      `).run(now(), -numSetting('dry_run_priority_fee_sol', 0.0005), 'Simulated failed entry transaction.', positionId);
      return positionId;
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, opened_at, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, current_price, current_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id,
        remaining_amount, is_closed, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      POSITION_STATUS.OPEN,
      now(),
      new Date(now()).toISOString(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      0,
      decision.id || null,
      strat.id,
      sizeSol,
      0,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    createEntryMetrics({ positionId, candidateId, candidate, decision, strategyId: strat.id, mode: 'dry_run', reason });
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  if (DRY_RUN_LOCK) throw new Error('DRY RUN LOCK ACTIVE - live trading disabled.');
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const tp = entryTpPercent(decision, strat, trailingEnabled);
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status IN (${statusSqlList(ACTIVE_STATUSES)}) LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, opened_at, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, current_price, current_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, entry_tx_hash, token_amount_raw, strategy_id, remaining_amount, is_closed, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      POSITION_STATUS.OPEN,
      now(),
      new Date(now()).toISOString(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      0,
      decision.id || null,
      'live',
      swap.signature,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      swap.outputAmount ? Number(swap.outputAmount) : sizeSol,
      0,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

function entryTpPercent(decision, strat, trailingEnabled) {
  const strategyTp = Number(strat.tp_percent ?? numSetting('default_tp_percent', 50));
  const suggestedTp = Number(decision.suggested_tp_percent ?? strategyTp);
  if (trailingEnabled) return Math.min(suggestedTp, strategyTp, 50);
  return Number.isFinite(suggestedTp) ? suggestedTp : strategyTp;
}
