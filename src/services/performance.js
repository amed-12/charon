import { db } from '../db/connection.js';
import { numSetting } from '../db/settings.js';
import { now, json, safeJson } from '../utils.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from './positionStatus.js';

export const EXIT_REASONS = new Set(['TP', 'SL', 'TRAILING_TP', 'PARTIAL_TP', 'MAX_HOLD', 'MANUAL', 'FAILED_EXIT', 'ERROR']);

export function dryRunAssumptions() {
  return {
    slippageBps: numSetting('dry_run_simulated_slippage_bps', 300),
    platformFeeBps: numSetting('dry_run_platform_fee_bps', 100),
    priorityFeeSol: numSetting('dry_run_priority_fee_sol', 0.0005),
    failedTxRate: Math.max(0, Math.min(1, numSetting('dry_run_failed_tx_rate', 0.03))),
  };
}

export function shouldSimulateTxFailure(rate = dryRunAssumptions().failedTxRate, randomFn = Math.random) {
  return Number(rate) > 0 && randomFn() < Number(rate);
}

export function calculateDryRunPnl({
  sizeSol,
  entryMcap,
  exitMcap,
  slippageBps = dryRunAssumptions().slippageBps,
  platformFeeBps = dryRunAssumptions().platformFeeBps,
  priorityFeeSol = dryRunAssumptions().priorityFeeSol,
}) {
  const size = Number(sizeSol || 0);
  const entry = Number(entryMcap || 0);
  const exit = Number(exitMcap || 0);
  if (!size || !entry || !exit) {
    return { grossPnlSol: 0, netPnlSol: -priorityFeeSol, pnlPercent: 0, feesSol: priorityFeeSol };
  }
  const grossPnlSol = size * ((exit / entry) - 1);
  const entryEfficiency = 1 + Number(slippageBps) / 10_000;
  const exitEfficiency = 1 - Number(slippageBps) / 10_000;
  const exitValueSol = size * (exit / entry) * exitEfficiency / entryEfficiency;
  const platformFeesSol = (size + Math.max(0, exitValueSol)) * Number(platformFeeBps) / 10_000;
  const priorityFeesSol = Number(priorityFeeSol) * 2;
  const netPnlSol = exitValueSol - size - platformFeesSol - priorityFeesSol;
  return {
    grossPnlSol,
    netPnlSol,
    pnlPercent: size ? (netPnlSol / size) * 100 : 0,
    feesSol: platformFeesSol + priorityFeesSol,
  };
}

function top20(candidate) {
  return Number(candidate.holders?.top20Percent ?? candidate.holders?.maxHolderPercent ?? NaN);
}

function sourceCount(candidate) {
  return [
    candidate.signals?.hasFeeClaim,
    candidate.signals?.hasGraduated,
    candidate.signals?.hasTrending,
  ].filter(Boolean).length || Number(candidate.signals?.sourceCount || 0);
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function createEntryMetrics({ positionId, tradeId = null, candidateId, candidate, decision, strategyId, mode, reason, failed = false }) {
  const signalAt = Number(candidate.createdAtMs || now());
  const decisionAt = Number(decision.created_at_ms || now());
  const entryAt = now();
  const mcap = Number(candidate.metrics?.marketCapUsd || candidate.metrics?.graduatedMarketCapUsd || 0) || null;
  const payload = {
    candidateId,
    decisionId: decision.id || null,
    reason,
    assumptions: dryRunAssumptions(),
    candidate,
    decision,
  };
  db.prepare(`
    INSERT INTO dryrun_trade_metrics (
      position_id, trade_id, token_mint, token_symbol, strategy_id, mode,
      signal_at_ms, decision_at_ms, entry_at_ms, simulated_latency_seconds,
      entry_price_source, entry_mcap, highest_mcap, lowest_mcap, entry_liquidity,
      holders, top20_holder_percent, rug_ratio, bundler_rate, source_count,
      llm_confidence, llm_reason, entry_failed, notes, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      trade_id = excluded.trade_id,
      entry_at_ms = excluded.entry_at_ms,
      payload_json = excluded.payload_json
  `).run(
    positionId,
    tradeId,
    candidate.token?.mint,
    candidate.token?.symbol || '',
    strategyId,
    mode || 'dry_run',
    signalAt,
    decisionAt,
    entryAt,
    Math.max(0, (entryAt - signalAt) / 1000),
    candidate.executionRefresh ? 'fresh_execution' : 'candidate_snapshot',
    mcap,
    mcap,
    mcap,
    Number(candidate.metrics?.liquidityUsd || 0) || null,
    Number(candidate.metrics?.holderCount || 0) || null,
    Number.isFinite(top20(candidate)) ? top20(candidate) : null,
    finiteOrNull(candidate.trending?.rug_ratio ?? candidate.gmgn?.rug_ratio),
    finiteOrNull(candidate.trending?.bundler_rate ?? candidate.gmgn?.bundler_rate),
    sourceCount(candidate),
    Number(decision.confidence ?? 0),
    String(decision.reason || ''),
    failed ? 1 : 0,
    failed ? 'Simulated failed entry transaction.' : '',
    json(payload),
  );
}

export function updateOpenMetrics(position, currentMcap) {
  const entry = Number(position.entry_mcap || 0);
  const current = Number(currentMcap || 0);
  if (!entry || !current) return { maxUnrealizedPercent: 0, maxDrawdownPercent: 0, lowestMcap: current || null };
  const metric = db.prepare('SELECT * FROM dryrun_trade_metrics WHERE position_id = ?').get(position.id);
  const highest = Math.max(Number(metric?.highest_mcap || position.high_water_mcap || 0), current);
  const lowest = metric?.lowest_mcap ? Math.min(Number(metric.lowest_mcap), current) : current;
  const maxUnrealized = ((highest / entry) - 1) * 100;
  const maxDrawdown = ((lowest / entry) - 1) * 100;
  const unrealizedPnlPercent = ((current / entry) - 1) * 100;
  const unrealizedPnlSol = Number(position.size_sol || 0) * unrealizedPnlPercent / 100;
  db.prepare(`
    UPDATE dryrun_trade_metrics
    SET highest_mcap = ?, lowest_mcap = ?, max_unrealized_percent = ?, max_drawdown_percent = ?
    WHERE position_id = ?
  `).run(highest, lowest, maxUnrealized, maxDrawdown, position.id);
  db.prepare(`
    UPDATE dry_run_positions
    SET lowest_mcap = ?, max_unrealized_percent = ?, max_drawdown_percent = ?,
        unrealized_pnl_percent = ?, unrealized_pnl_sol = ?, current_mcap = ?
    WHERE id = ?
  `).run(lowest, maxUnrealized, maxDrawdown, unrealizedPnlPercent, unrealizedPnlSol, current, position.id);
  return { maxUnrealizedPercent: maxUnrealized, maxDrawdownPercent: maxDrawdown, lowestMcap: lowest, unrealizedPnlPercent, unrealizedPnlSol };
}

export function closeMetrics(position, { exitMcap, exitReason, exitFailed = false, notes = '' }) {
  const assumptions = dryRunAssumptions();
  const pnl = calculateDryRunPnl({
    sizeSol: position.size_sol,
    entryMcap: position.entry_mcap,
    exitMcap,
    ...assumptions,
  });
  const opened = Number(position.opened_at_ms || now());
  const closed = now();
  const metric = db.prepare('SELECT * FROM dryrun_trade_metrics WHERE position_id = ?').get(position.id);
  const highest = Math.max(Number(metric?.highest_mcap || position.high_water_mcap || 0), Number(exitMcap || 0));
  const lowest = metric?.lowest_mcap
    ? Math.min(Number(metric.lowest_mcap), Number(exitMcap || metric.lowest_mcap))
    : Number(exitMcap || position.entry_mcap || 0);
  const entry = Number(position.entry_mcap || 0);
  const maxUnrealized = entry && highest ? ((highest / entry) - 1) * 100 : 0;
  const maxDrawdown = entry && lowest ? ((lowest / entry) - 1) * 100 : 0;
  db.prepare(`
    UPDATE dryrun_trade_metrics
    SET exit_at_ms = ?, exit_mcap = ?, highest_mcap = ?, lowest_mcap = ?, exit_reason = ?,
        gross_pnl_sol = ?, net_pnl_sol = ?, pnl_percent = ?, max_unrealized_percent = ?,
        max_drawdown_percent = ?, hold_duration_ms = ?, partial_tp_done = ?,
        exit_failed = ?, notes = ?
    WHERE position_id = ?
  `).run(
    closed,
    exitMcap,
    highest,
    lowest,
    exitReason,
    pnl.grossPnlSol,
    pnl.netPnlSol,
    pnl.pnlPercent,
    maxUnrealized,
    maxDrawdown,
    Math.max(0, closed - opened),
    position.partial_tp_done ? 1 : 0,
    exitFailed ? 1 : 0,
    notes,
    position.id,
  );
  return { ...pnl, maxUnrealizedPercent: maxUnrealized, maxDrawdownPercent: maxDrawdown, highestMcap: highest, lowestMcap: lowest };
}

export function windowCutoff(windowArg) {
  const raw = String(windowArg || '24h').trim().toLowerCase();
  if (raw === 'all') return 0;
  const match = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) return now() - 24 * 60 * 60_000;
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return now() - Number(match[1]) * multipliers[match[2]];
}

export function closedTradeRows(windowArg = '24h') {
  const cutoff = windowCutoff(windowArg);
  return db.prepare(`
    SELECT p.*, m.*
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.status = '${POSITION_STATUS.CLOSED}'
      AND p.execution_mode = 'dry_run'
      AND COALESCE(m.exit_at_ms, p.closed_at_ms, p.opened_at_ms) >= ?
    ORDER BY p.id DESC
  `).all(cutoff);
}

export function summarizeTrades(windowArg = '24h') {
  const closed = closedTradeRows(windowArg);
  const open = db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) AND execution_mode = 'dry_run'`).get().count;
  const wins = closed.filter(r => Number(r.net_pnl_sol ?? r.pnl_sol ?? 0) > 0);
  const losses = closed.filter(r => Number(r.net_pnl_sol ?? r.pnl_sol ?? 0) < 0);
  const grossPnl = closed.reduce((sum, r) => sum + Number(r.gross_pnl_sol ?? r.pnl_sol ?? 0), 0);
  const netPnl = closed.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
  const grossWins = wins.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0));
  const hold = closed.map(r => Number(r.hold_duration_ms || (r.closed_at_ms && r.opened_at_ms ? r.closed_at_ms - r.opened_at_ms : 0))).filter(Boolean).sort((a, b) => a - b);
  const byReason = reason => closed.filter(r => (r.exit_reason || r.exitReason) === reason).length;
  return {
    closed,
    totalTrades: closed.length + open,
    openTrades: open,
    closedTrades: closed.length,
    winRate: closed.length ? wins.length / closed.length * 100 : 0,
    lossRate: closed.length ? losses.length / closed.length * 100 : 0,
    grossPnl,
    netPnl,
    averageWin: wins.length ? grossWins / wins.length : 0,
    averageLoss: losses.length ? -grossLosses / losses.length : 0,
    profitFactor: grossLosses ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
    expectancy: closed.length ? netPnl / closed.length : 0,
    maxDrawdown: Math.min(0, ...closed.map(r => Number(r.max_drawdown_percent || 0))),
    medianHoldMs: hold.length ? hold[Math.floor(hold.length / 2)] : 0,
    bestTrade: [...closed].sort((a, b) => Number(b.net_pnl_sol ?? b.pnl_sol ?? 0) - Number(a.net_pnl_sol ?? a.pnl_sol ?? 0))[0] || null,
    worstTrade: [...closed].sort((a, b) => Number(a.net_pnl_sol ?? a.pnl_sol ?? 0) - Number(b.net_pnl_sol ?? b.pnl_sol ?? 0))[0] || null,
    tpCount: byReason('TP'),
    slCount: byReason('SL'),
    trailingTpCount: byReason('TRAILING_TP'),
    maxHoldCount: byReason('MAX_HOLD'),
    failedEntryCount: db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get(POSITION_STATUS.FAILED_ENTRY).count,
    failedExitCount: db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get(POSITION_STATUS.FAILED_EXIT).count,
  };
}

export function strategyBreakdown(windowArg = '24h') {
  const rows = closedTradeRows(windowArg);
  const strategies = ['sniper', 'dip_buy', 'smart_money', 'degen'];
  return strategies.map(strategyId => {
    const trades = rows.filter(row => (row.strategy_id || 'sniper') === strategyId);
    const wins = trades.filter(row => Number(row.net_pnl_sol ?? row.pnl_sol ?? 0) > 0);
    const losses = trades.filter(row => Number(row.net_pnl_sol ?? row.pnl_sol ?? 0) < 0);
    const winSum = wins.reduce((sum, row) => sum + Number(row.net_pnl_sol ?? row.pnl_sol ?? 0), 0);
    const lossSum = Math.abs(losses.reduce((sum, row) => sum + Number(row.net_pnl_sol ?? row.pnl_sol ?? 0), 0));
    const reasonCounts = new Map();
    for (const trade of trades) reasonCounts.set(trade.exit_reason || 'UNKNOWN', (reasonCounts.get(trade.exit_reason || 'UNKNOWN') || 0) + 1);
    const commonReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
    const hold = trades.map(r => Number(r.hold_duration_ms || (r.closed_at_ms && r.opened_at_ms ? r.closed_at_ms - r.opened_at_ms : 0))).filter(Boolean);
    return {
      strategyId,
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      netPnl: trades.reduce((sum, row) => sum + Number(row.net_pnl_sol ?? row.pnl_sol ?? 0), 0),
      profitFactor: lossSum ? winSum / lossSum : (winSum > 0 ? Infinity : 0),
      averageHoldMs: hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : 0,
      mostCommonExitReason: commonReason,
      maxDrawdown: Math.min(0, ...trades.map(r => Number(r.max_drawdown_percent || 0))),
    };
  });
}

export function metricPayload(row) {
  return safeJson(row.payload_json, {});
}
