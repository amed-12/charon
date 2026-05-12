import { db } from '../db/connection.js';
import { activeStrategy, allStrategies, setActiveStrategy, strategyById, updateStrategyConfig, setSetting } from '../db/settings.js';
import { latestCandidateByMint } from '../db/candidates.js';
import { summarizeTrades, strategyBreakdown, windowCutoff } from '../services/performance.js';
import { exportClosedPositions, exportOpenPositions, exportTrades } from '../services/exporter.js';
import { currentRiskState } from '../services/risk.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from '../services/positionStatus.js';
import { fmtPct, fmtSol, fmtUsd, short } from '../format.js';
import { forgetPreference, listPreferences, recentAgentDecisions, savePreference } from './memory.js';
import { safeJson, json, now } from '../utils.js';
import { fetchGmgnFullTokenSnapshot, formatGmgnCheck } from '../services/gmgnToken.js';

function rowSummary(row) {
  return `${row.symbol || short(row.mint)} #${row.id} ${row.status} entry ${fmtUsd(row.entry_mcap)} current ${fmtUsd(row.current_mcap ?? row.entry_mcap)} PnL ${fmtSol(row.unrealized_pnl_sol ?? row.realized_pnl_sol ?? row.net_pnl_sol ?? 0)} SOL`;
}

export const toolRegistry = {
  get_status: {
    kind: 'read',
    run: async () => {
      const strategy = activeStrategy();
      const mode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
      const open = db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})`).get().count;
      const closed = db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get(POSITION_STATUS.CLOSED).count;
      return `Mode setting: ${mode}. Active strategy: ${strategy.id}. Open positions: ${open}. Closed positions: ${closed}.`;
    },
  },
  get_open_positions: {
    kind: 'read',
    run: async () => {
      const rows = db.prepare(`SELECT * FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) ORDER BY opened_at_ms DESC LIMIT 20`).all();
      return rows.length ? rows.map(rowSummary).join('\n') : 'No open positions.';
    },
  },
  get_closed_positions: {
    kind: 'read',
    run: async ({ window = '24h' } = {}) => {
      const rows = db.prepare(`
        SELECT * FROM dry_run_positions
        WHERE status = ? AND COALESCE(closed_at_ms, opened_at_ms) >= ?
        ORDER BY closed_at_ms DESC LIMIT 20
      `).all(POSITION_STATUS.CLOSED, windowCutoff(window));
      return rows.length ? rows.map(row => `${row.symbol || short(row.mint)} #${row.id} ${row.exit_reason || ''} realized ${fmtSol(row.realized_pnl_sol ?? row.net_pnl_sol ?? row.pnl_sol ?? 0)} SOL`).join('\n') : `No closed positions for ${window}.`;
    },
  },
  get_pnl: {
    kind: 'read',
    run: async () => {
      const realized = db.prepare("SELECT COUNT(*) count, COALESCE(SUM(COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0)),0) pnl FROM dry_run_positions WHERE status='CLOSED'").get();
      const unrealized = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(COALESCE(unrealized_pnl_sol, pnl_sol, 0)),0) pnl FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})`).get();
      return `Realized: ${fmtSol(realized.pnl)} SOL (${realized.count} closed). Unrealized: ${fmtSol(unrealized.pnl)} SOL (${unrealized.count} active). Total: ${fmtSol(Number(realized.pnl) + Number(unrealized.pnl))} SOL.`;
    },
  },
  get_candidate: {
    kind: 'read',
    run: async ({ mint }) => {
      const row = latestCandidateByMint(mint);
      if (!row) return 'Candidate not found.';
      const c = row.candidate;
      return `${c.token?.symbol || short(c.token?.mint || mint)} ${c.token?.mint}\nMcap ${fmtUsd(c.metrics?.marketCapUsd)} liq ${fmtUsd(c.metrics?.liquidityUsd)} holders ${c.metrics?.holderCount || '?'} top20 ${fmtPct(c.holders?.top20Percent)}\nFilters: ${c.filters?.passed ? 'passed' : (c.filters?.failures || []).join('; ')}`;
    },
  },
  get_recent_candidates: {
    kind: 'read',
    run: async ({ window = '24h' } = {}) => {
      const rows = db.prepare('SELECT id, mint, status, created_at_ms, candidate_json FROM candidates WHERE created_at_ms >= ? ORDER BY id DESC LIMIT 10').all(windowCutoff(window));
      return rows.map(row => {
        const c = safeJson(row.candidate_json, {});
        return `#${row.id} ${c.token?.symbol || short(row.mint)} ${row.status} mcap ${fmtUsd(c.metrics?.marketCapUsd)}`;
      }).join('\n') || 'No recent candidates.';
    },
  },
  get_strategy_config: {
    kind: 'read',
    run: async ({ strategyId }) => JSON.stringify(strategyById(strategyId) || activeStrategy(), null, 2),
  },
  get_active_strategy: {
    kind: 'read',
    run: async () => JSON.stringify(activeStrategy(), null, 2),
  },
  get_lessons: {
    kind: 'read',
    run: async () => {
      const rows = db.prepare('SELECT finding, evidence, recommendation, confidence_level FROM generated_lessons ORDER BY lesson_id DESC LIMIT 5').all();
      return rows.length ? rows.map(r => `${r.finding} Evidence: ${r.evidence}. Recommendation: ${r.recommendation} [${r.confidence_level}]`).join('\n') : 'No generated lessons yet.';
    },
  },
  get_recent_decisions: {
    kind: 'read',
    run: async ({ limit = 10 } = {}) => {
      const rows = recentAgentDecisions(limit);
      if (rows.length) return rows.map(r => `#${r.decision_id} ${r.action}: ${r.summary || r.result || ''}`).join('\n');
      const fallback = db.prepare('SELECT id, action, verdict, confidence, reason FROM decision_logs ORDER BY id DESC LIMIT ?').all(limit);
      return fallback.map(r => `#${r.id} ${r.action} ${r.verdict || ''} ${r.confidence || ''}: ${r.reason || ''}`).join('\n') || 'No decisions logged.';
    },
  },
  get_risk_status: { kind: 'read', run: async () => JSON.stringify(currentRiskState(), null, 2) },
  get_position_by_symbol_or_mint: {
    kind: 'read',
    run: async ({ query }) => {
      const q = `%${String(query || '').toLowerCase()}%`;
      const rows = db.prepare('SELECT * FROM dry_run_positions WHERE LOWER(symbol) LIKE ? OR LOWER(mint) LIKE ? ORDER BY id DESC LIMIT 5').all(q, q);
      return rows.length ? rows.map(rowSummary).join('\n') : 'Position not found.';
    },
  },
  set_active_strategy: {
    kind: 'config',
    run: async ({ strategyId }) => {
      if (!strategyById(strategyId)) throw new Error(`Unknown strategy ${strategyId}`);
      setActiveStrategy(strategyId);
      return `Active strategy set to ${strategyId}.`;
    },
  },
  set_strategy_param: {
    kind: 'config',
    run: async ({ strategyId, key, value }) => {
      const strat = strategyById(strategyId);
      if (!strat) throw new Error(`Unknown strategy ${strategyId}`);
      const config = { ...strat };
      delete config.id;
      delete config.name;
      config[key] = parseValue(value);
      updateStrategyConfig(strategyId, config);
      return `${strategyId}.${key} set to ${value}.`;
    },
  },
  set_mode: { kind: 'config', run: async ({ mode }) => { setSetting('trading_mode', mode); return `Trading mode setting updated to ${mode}.`; } },
  set_risk_param: { kind: 'config', run: async ({ key, value }) => { setSetting(key, value); return `${key} set to ${value}.`; } },
  blacklist_token: { kind: 'memory', run: async ({ mint, reason = '' }) => { savePreference(`blacklist:${mint}`, reason || 'blacklisted from chat', 'token'); return `Blacklisted ${mint}.`; } },
  analyze_candidate: {
    kind: 'read',
    run: async ({ mint, forceFresh = true } = {}) => {
      if (!mint) throw new Error('Token mint is required.');
      const snapshot = await fetchGmgnFullTokenSnapshot(mint, { forceFresh });
      return formatGmgnCheck(snapshot);
    },
  },
  create_trade_intent: {
    kind: 'trade',
    run: async ({ mint, strategyId = activeStrategy().id, reason = 'Chat trade intent' }) => {
      const row = latestCandidateByMint(mint);
      if (!row) return `Candidate ${mint} not found; no intent created.`;
      return `Trade intent prepared for ${row.candidate?.token?.symbol || short(mint)} using ${strategyId}. Reason: ${reason}. Use existing Telegram confirmation before execution.`;
    },
  },
  approve_trade_intent: {
    kind: 'trade',
    run: async ({ intentId }) => `Chat cannot approve live/confirm intent #${intentId} directly. Use the original Telegram confirmation buttons.`,
  },
  reject_trade_intent: {
    kind: 'trade',
    run: async ({ intentId }) => `Trade intent #${intentId} rejection noted. Use original intent controls if it exists.`,
  },
  manual_buy: {
    kind: 'trade',
    run: async ({ mint }) => `Manual buy from casual chat is disabled for safety. Analyze ${mint || 'the mint'} first, then use the existing candidate buy button.`,
  },
  close_position: {
    kind: 'trade',
    run: async ({ positionId, reason = 'CHAT_CLOSE' }) => closeDryRunPosition(positionId, reason),
  },
  close_all_positions: {
    kind: 'trade',
    run: async ({ reason = 'CHAT_CLOSE_ALL' } = {}) => {
      const rows = db.prepare(`SELECT id FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) AND execution_mode != 'live'`).all();
      const results = [];
      for (const row of rows) results.push(await closeDryRunPosition(row.id, reason));
      return `Closed ${results.length} dry-run positions.`;
    },
  },
  set_conditional_exit: {
    kind: 'trade',
    run: async ({ positionId, condition, action }) => `Conditional exit for #${positionId} is not automated from chat yet. Requested condition: ${condition}; action: ${action}.`,
  },
  cancel_pending_intent: {
    kind: 'trade',
    run: async ({ intentId }) => `Pending intent #${intentId || ''} cancellation noted. Use the original Telegram reject button if it exists.`,
  },
  export_open_positions: { kind: 'report', run: async () => JSON.stringify(exportOpenPositions()) },
  export_closed_positions: { kind: 'report', run: async ({ window = '24h' } = {}) => JSON.stringify(exportClosedPositions(window)) },
  export_trades: { kind: 'report', run: async ({ window = '24h' } = {}) => JSON.stringify(exportTrades(window)) },
  generate_stats: { kind: 'report', run: async ({ window = '24h' } = {}) => JSON.stringify(summarizeTrades(window), null, 2) },
  compare_strategies: { kind: 'report', run: async ({ window = '24h' } = {}) => JSON.stringify(strategyBreakdown(window), null, 2) },
  generate_lessons: { kind: 'report', run: async () => toolRegistry.get_lessons.run() },
  save_chat_memory: { kind: 'memory', run: async ({ key, value, scope = 'global' }) => { savePreference(key, value, scope); return `Remembered ${key}.`; } },
  save_lesson: { kind: 'memory', run: async ({ finding, evidence = '', recommendation = '' }) => {
    db.prepare('INSERT INTO generated_lessons (created_at_ms, window, metric, finding, evidence, recommendation, confidence_level) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), 'chat', 'manual', finding, evidence, recommendation, 'MANUAL');
    return 'Lesson saved.';
  } },
  add_trade_note: { kind: 'memory', run: async ({ positionId, note }) => {
    db.prepare('UPDATE dryrun_trade_metrics SET notes = COALESCE(notes, \'\') || ? WHERE position_id = ?').run(`\n${note}`, Number(positionId));
    return `Note added to position #${positionId}.`;
  } },
  forget_memory: { kind: 'memory', run: async ({ key }) => forgetPreference(key) ? `Forgot ${key}.` : `No memory found for ${key}.` },
};

export function availableToolNames() {
  return Object.keys(toolRegistry);
}

export async function runToolCall(call) {
  const tool = toolRegistry[call.tool];
  if (!tool) throw new Error(`Tool not allowed: ${call.tool}`);
  return tool.run(call.args || {});
}

export function preferencesText() {
  const rows = listPreferences();
  return rows.length ? rows.map(row => `${row.key}: ${row.value}`).join('\n') : 'No saved preferences.';
}

function parseValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

async function closeDryRunPosition(positionId, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(Number(positionId));
  if (!row) return `Position #${positionId} not found.`;
  if (!ACTIVE_STATUSES.includes(row.status)) return `Position #${positionId} is not active.`;
  if (row.execution_mode === 'live') return `Position #${positionId} is live; chat cannot execute live close.`;
  const exitMcap = Number(row.current_mcap || row.high_water_mcap || row.entry_mcap || 0);
  const entryMcap = Number(row.entry_mcap || 0);
  const pnlPercent = entryMcap ? (exitMcap / entryMcap - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol || 0) * pnlPercent / 100;
  db.prepare(`
    UPDATE dry_run_positions
    SET status = ?, closed_at_ms = ?, closed_at = ?, exit_mcap = ?, exit_price = current_price,
        exit_reason = ?, pnl_percent = ?, pnl_sol = ?, realized_pnl_percent = ?,
        realized_pnl_sol = ?, unrealized_pnl_percent = 0, unrealized_pnl_sol = 0,
        remaining_amount = 0, is_closed = 1
    WHERE id = ?
  `).run(POSITION_STATUS.CLOSED, now(), new Date().toISOString(), exitMcap, reason, pnlPercent, pnlSol, pnlPercent, pnlSol, Number(positionId));
  db.prepare('INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.mint, 'sell', now(), row.current_price || row.entry_price, exitMcap, row.size_sol, row.token_amount_est, reason, json({ chatClose: true, pnlPercent, pnlSol }));
  return `Closed dry-run position #${row.id} (${row.symbol || short(row.mint)}) at ${fmtSol(pnlSol)} SOL PnL.`;
}
