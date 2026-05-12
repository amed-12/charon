import fs from 'node:fs';
import { db } from '../db/connection.js';
import { DRY_RUN_LOCK, EFFECTIVE_TRADING_MODE, ENV_TRADING_MODE } from '../config.js';
import { activeStrategy, allStrategies } from '../db/settings.js';
import { summarizeTrades } from '../services/performance.js';
import { currentRiskState } from '../services/risk.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from '../services/positionStatus.js';
import { safeJson } from '../utils.js';
import { toolRegistry } from './toolRegistry.js';
import { getRecentDecisionLogs, getUserPreferences } from './memory.js';
import { agentPerf, perfSnapshot, queueSnapshot } from './queue.js';

const TOOL_ALIASES = {
  remember_user_preference: 'save_chat_memory',
  forget_user_preference: 'forget_memory',
  set_active_strategy: 'set_active_strategy',
  get_memory: 'get_memory',
  get_queue_status: 'get_queue_status',
};

const READ_CACHE_TTL = {
  get_status: 5000,
  get_open_positions: 5000,
  get_pnl: 10000,
  get_active_strategy: 10000,
  get_lessons: 30000,
  get_recent_decisions: 30000,
};

const cache = new Map();

const PLACEHOLDER_TOOLS = new Set([]);

export function listTools() {
  return Object.keys(toolRegistry)
    .concat(['remember_user_preference', 'forget_user_preference', 'get_memory', 'get_queue_status', 'get_agent_perf'])
    .sort();
}

export function getMinimalState() {
  const openCount = db.prepare(`SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})`).get().count;
  return {
    mode: { effective: EFFECTIVE_TRADING_MODE, env: ENV_TRADING_MODE, dryRunLock: DRY_RUN_LOCK },
    activeStrategy: activeStrategy(),
    openCount,
  };
}

export function getPositionsState() {
  return {
    ...getMinimalState(),
    openPositions: db.prepare(`
      SELECT *
      FROM dry_run_positions
      WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
      ORDER BY opened_at_ms DESC
      LIMIT 20
    `).all(),
  };
}

export function getPnlState() {
  const realized = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0)), 0) AS pnl,
           SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) > 0 THEN 1 ELSE 0 END) AS wins
    FROM dry_run_positions
    WHERE status = ?
  `).get(POSITION_STATUS.CLOSED);
  const unrealized = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(unrealized_pnl_sol, pnl_sol, 0)), 0) AS pnl
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
  `).get();
  return {
    ...getMinimalState(),
    pnlData: {
      realized: Number(realized.pnl || 0),
      unrealized: Number(unrealized.pnl || 0),
      total: Number(realized.pnl || 0) + Number(unrealized.pnl || 0),
      winRate: Number(realized.count || 0) ? Number(realized.wins || 0) / Number(realized.count) * 100 : null,
      closedCount: Number(realized.count || 0),
      openCount: Number(unrealized.count || 0),
    },
  };
}

export function getStateForIntent(intent) {
  if (intent === 'ask_positions') return getPositionsState();
  if (intent === 'ask_pnl') return getPnlState();
  if (intent === 'ask_status' || intent === 'ask_queue') return getMinimalState();
  if (intent === 'ask_strategy') return { ...getMinimalState(), strategies: allStrategies() };
  return getAgentState();
}

export function getAgentState() {
  const openPositions = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
    ORDER BY opened_at_ms DESC
    LIMIT 20
  `).all();
  const recentClosed = db.prepare(`
    SELECT id, mint, symbol, strategy_id, exit_reason, realized_pnl_sol, pnl_percent, closed_at_ms
    FROM dry_run_positions
    WHERE status = ?
    ORDER BY closed_at_ms DESC
    LIMIT 20
  `).all(POSITION_STATUS.CLOSED);
  const candidates = db.prepare(`
    SELECT id, mint, status, created_at_ms, candidate_json
    FROM candidates
    ORDER BY id DESC
    LIMIT 10
  `).all().map(row => ({
    id: row.id,
    mint: row.mint,
    status: row.status,
    created_at_ms: row.created_at_ms,
    symbol: safeJson(row.candidate_json, {})?.token?.symbol || null,
  }));
  return {
    mode: { effective: EFFECTIVE_TRADING_MODE, env: ENV_TRADING_MODE, dryRunLock: DRY_RUN_LOCK },
    activeStrategy: activeStrategy(),
    strategies: allStrategies().map(s => ({ id: s.id, enabled: s.enabled })),
    pnl: summarizeTrades('24h'),
    risk: currentRiskState(),
    openPositions,
    recentClosed,
    recentCandidates: candidates,
    recentDecisions: getRecentDecisionLogs(8),
    preferences: getUserPreferences(),
  };
}

export async function executeToolCall(toolCall, context = {}) {
  const requested = String(toolCall?.tool || '');
  const toolName = TOOL_ALIASES[requested] || requested;
  if (toolName === 'get_memory') return getUserPreferences();
  if (toolName === 'get_queue_status') return queueSnapshot(context.chatId, context.userId);
  if (toolName === 'get_agent_perf') return perfSnapshot();
  if (PLACEHOLDER_TOOLS.has(toolName)) return 'Tool not implemented yet';
  const tool = toolRegistry[toolName];
  if (!tool) return 'Tool not implemented yet';
  const args = normalizeArgs(requested, toolCall.args || {}, context);
  const cached = readCache(toolName, args);
  if (cached.hit) return cached.value;
  const result = await tool.run(args);
  const parsed = maybeParseExportResult(result);
  if (toolName !== 'analyze_candidate') writeCache(toolName, args, parsed);
  return parsed;
}

function normalizeArgs(requested, args, context) {
  if (requested === 'remember_user_preference') {
    return {
      key: args.key || `preference:${Date.now()}`,
      value: args.value || args.text || context.message || '',
      scope: args.scope || 'chat',
    };
  }
  if (requested === 'forget_user_preference') {
    return { key: args.key || args.value || '' };
  }
  return args;
}

function maybeParseExportResult(result) {
  if (typeof result !== 'string') return result;
  try {
    const parsed = JSON.parse(result);
    if (parsed?.filePath && fs.existsSync(parsed.filePath)) return parsed;
  } catch {
    // Return original text below.
  }
  return result;
}

function readCache(toolName, args) {
  const ttl = READ_CACHE_TTL[toolName];
  if (!ttl) return { hit: false };
  const key = `${toolName}:${JSON.stringify(args || {})}`;
  const row = cache.get(key);
  if (row && Date.now() - row.at <= ttl) {
    agentPerf.cacheHits += 1;
    return { hit: true, value: row.value };
  }
  agentPerf.cacheMisses += 1;
  return { hit: false };
}

function writeCache(toolName, args, value) {
  const ttl = READ_CACHE_TTL[toolName];
  if (!ttl) return;
  cache.set(`${toolName}:${JSON.stringify(args || {})}`, { at: Date.now(), value });
}
