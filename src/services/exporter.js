import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/connection.js';
import { now, safeJson } from '../utils.js';
import { windowCutoff } from './performance.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from './positionStatus.js';

const EXPORT_DIR = path.resolve(process.cwd(), 'exports');

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsv(name, columns, rows, reportType, windowArg) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = path.join(EXPORT_DIR, `${name}_${Date.now()}.csv`);
  const content = [
    columns.join(','),
    ...rows.map(row => columns.map(col => csvCell(row[col])).join(',')),
  ].join('\n');
  fs.writeFileSync(filePath, content);
  db.prepare(`
    INSERT INTO exported_reports (created_at_ms, report_type, window_arg, file_path, row_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), reportType, windowArg, filePath, rows.length);
  return { filePath, rowCount: rows.length };
}

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : '';
}

export const tradeColumns = [
  'trade_id', 'token_mint', 'token_symbol', 'strategy_id', 'mode', 'entry_time', 'exit_time',
  'hold_minutes', 'entry_mcap', 'exit_mcap', 'highest_mcap', 'lowest_mcap', 'entry_liquidity',
  'holders', 'top20_holder_percent', 'rug_ratio', 'bundler_rate', 'source_count',
  'llm_confidence', 'llm_reason', 'exit_reason', 'gross_pnl_sol', 'net_pnl_sol',
  'pnl_percent', 'max_unrealized_percent', 'max_drawdown_percent', 'partial_tp_done', 'notes',
];

export function exportTrades(windowArg = '24h') {
  const cutoff = windowCutoff(windowArg);
  const rows = db.prepare(`
    SELECT p.*, m.*
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.execution_mode = 'dry_run'
      AND p.status = '${POSITION_STATUS.CLOSED}'
      AND COALESCE(m.exit_at_ms, p.closed_at_ms, p.opened_at_ms) >= ?
    ORDER BY p.id DESC
  `).all(cutoff).map(row => ({
    trade_id: row.position_id || row.id,
    token_mint: row.token_mint || row.mint,
    token_symbol: row.token_symbol || row.symbol,
    strategy_id: row.strategy_id || 'sniper',
    mode: row.mode || row.execution_mode || 'dry_run',
    entry_time: iso(row.entry_at_ms || row.opened_at_ms),
    exit_time: iso(row.exit_at_ms || row.closed_at_ms),
    hold_minutes: ((Number(row.hold_duration_ms || ((row.closed_at_ms || row.opened_at_ms) - row.opened_at_ms) || 0)) / 60_000).toFixed(2),
    entry_mcap: row.entry_mcap,
    exit_mcap: row.exit_mcap,
    highest_mcap: row.highest_mcap || row.high_water_mcap,
    lowest_mcap: row.lowest_mcap,
    entry_liquidity: row.entry_liquidity,
    holders: row.holders,
    top20_holder_percent: row.top20_holder_percent,
    rug_ratio: row.rug_ratio,
    bundler_rate: row.bundler_rate,
    source_count: row.source_count,
    llm_confidence: row.llm_confidence,
    llm_reason: row.llm_reason,
    exit_reason: row.exit_reason,
    gross_pnl_sol: row.gross_pnl_sol ?? row.pnl_sol,
    net_pnl_sol: row.net_pnl_sol ?? row.pnl_sol,
    pnl_percent: row.pnl_percent,
    max_unrealized_percent: row.max_unrealized_percent,
    max_drawdown_percent: row.max_drawdown_percent,
    partial_tp_done: row.partial_tp_done ? 'true' : 'false',
    notes: row.notes,
  }));
  return writeCsv('trades', tradeColumns, rows, 'trades', windowArg);
}

export const openPositionColumns = [
  'position_id', 'token_mint', 'token_symbol', 'strategy', 'status', 'opened_at',
  'entry_mcap', 'current_mcap', 'entry_price', 'current_price', 'remaining_amount',
  'unrealized_pnl_sol', 'unrealized_pnl_percent', 'partial_tp_done', 'hold_minutes',
];

export function exportOpenPositions() {
  const rows = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
    ORDER BY opened_at_ms DESC
  `).all().map(row => ({
    position_id: row.id,
    token_mint: row.mint,
    token_symbol: row.symbol,
    strategy: row.strategy_id || 'sniper',
    status: row.status,
    opened_at: row.opened_at || iso(row.opened_at_ms),
    entry_mcap: row.entry_mcap,
    current_mcap: row.current_mcap ?? row.entry_mcap,
    entry_price: row.entry_price,
    current_price: row.current_price ?? row.entry_price,
    remaining_amount: row.remaining_amount,
    unrealized_pnl_sol: row.unrealized_pnl_sol,
    unrealized_pnl_percent: row.unrealized_pnl_percent,
    partial_tp_done: row.partial_tp_done ? 'true' : 'false',
    hold_minutes: ((now() - Number(row.opened_at_ms || now())) / 60_000).toFixed(2),
  }));
  return writeCsv('open_positions', openPositionColumns, rows, 'open_positions', 'active');
}

export const closedPositionColumns = [
  'position_id', 'token_mint', 'token_symbol', 'strategy', 'status', 'opened_at', 'closed_at',
  'hold_minutes', 'entry_mcap', 'exit_mcap', 'entry_price', 'exit_price', 'realized_pnl_sol',
  'realized_pnl_percent', 'exit_reason', 'partial_tp_done', 'gross_pnl_sol', 'net_pnl_sol', 'notes',
];

export function exportClosedPositions(windowArg = '24h') {
  const cutoff = windowCutoff(windowArg);
  const rows = db.prepare(`
    SELECT p.*, m.notes
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.status = ?
      AND COALESCE(p.closed_at_ms, p.opened_at_ms) >= ?
    ORDER BY p.closed_at_ms DESC
  `).all(POSITION_STATUS.CLOSED, cutoff).map(row => ({
    position_id: row.id,
    token_mint: row.mint,
    token_symbol: row.symbol,
    strategy: row.strategy_id || 'sniper',
    status: row.status,
    opened_at: row.opened_at || iso(row.opened_at_ms),
    closed_at: row.closed_at || iso(row.closed_at_ms),
    hold_minutes: ((Number(row.closed_at_ms || row.opened_at_ms) - Number(row.opened_at_ms || 0)) / 60_000).toFixed(2),
    entry_mcap: row.entry_mcap,
    exit_mcap: row.exit_mcap,
    entry_price: row.entry_price,
    exit_price: row.exit_price,
    realized_pnl_sol: row.realized_pnl_sol ?? row.net_pnl_sol ?? row.pnl_sol,
    realized_pnl_percent: row.realized_pnl_percent ?? row.pnl_percent,
    exit_reason: row.exit_reason,
    partial_tp_done: row.partial_tp_done ? 'true' : 'false',
    gross_pnl_sol: row.gross_pnl_sol,
    net_pnl_sol: row.net_pnl_sol,
    notes: row.notes,
  }));
  return writeCsv('closed_positions', closedPositionColumns, rows, 'closed_positions', windowArg);
}

export const candidateColumns = [
  'candidate_id', 'mint', 'symbol', 'timestamp', 'strategy_id', 'passed_filters', 'rejected_reason',
  'source_count', 'market_cap', 'liquidity', 'holders', 'top20_holder_percent', 'rug_ratio',
  'bundler_rate', 'gmgn_total_fee_sol', 'ath_distance_percent', 'llm_score', 'llm_decision', 'llm_reason',
];

function candidateSourceCount(candidate) {
  return [candidate.signals?.hasFeeClaim, candidate.signals?.hasGraduated, candidate.signals?.hasTrending].filter(Boolean).length;
}

export function exportCandidates(windowArg = '24h') {
  const cutoff = windowCutoff(windowArg);
  const rows = db.prepare(`
    SELECT c.*, d.verdict, d.confidence, d.reason
    FROM candidates c
    LEFT JOIN llm_decisions d ON d.id = (
      SELECT id FROM llm_decisions WHERE candidate_id = c.id ORDER BY id DESC LIMIT 1
    )
    WHERE c.created_at_ms >= ?
    ORDER BY c.id DESC
  `).all(cutoff).map(row => {
    const candidate = safeJson(row.candidate_json, {});
    const filters = safeJson(row.filter_result_json, candidate.filters || {});
    return {
      candidate_id: row.id,
      mint: row.mint,
      symbol: candidate.token?.symbol || '',
      timestamp: iso(row.created_at_ms),
      strategy_id: filters.strategy || candidate.signals?.strategy || '',
      passed_filters: filters.passed ? 'true' : 'false',
      rejected_reason: (filters.failures || []).join('; '),
      source_count: candidateSourceCount(candidate),
      market_cap: candidate.metrics?.marketCapUsd,
      liquidity: candidate.metrics?.liquidityUsd,
      holders: candidate.metrics?.holderCount,
      top20_holder_percent: candidate.holders?.top20Percent ?? candidate.holders?.maxHolderPercent,
      rug_ratio: candidate.trending?.rug_ratio ?? candidate.gmgn?.rug_ratio,
      bundler_rate: candidate.trending?.bundler_rate ?? candidate.gmgn?.bundler_rate,
      gmgn_total_fee_sol: candidate.metrics?.gmgnTotalFeesSol,
      ath_distance_percent: candidate.chart?.distanceFromAthPercent,
      llm_score: row.confidence,
      llm_decision: row.verdict,
      llm_reason: row.reason,
    };
  });
  return writeCsv('candidates', candidateColumns, rows, 'candidates', windowArg);
}
