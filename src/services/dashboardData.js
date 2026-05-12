import fs from 'node:fs';
import { DB_PATH, DRY_RUN_LOCK, EFFECTIVE_TRADING_MODE, GMGN_ENABLED, LLM_MODEL, SIGNAL_POLL_MS, SIGNAL_SERVER_URL, SOLANA_PRIVATE_KEY } from '../config.js';
import { db } from '../db/connection.js';
import { activeStrategy, boolSetting, numSetting, setting } from '../db/settings.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from './positionStatus.js';
import { perfSnapshot, queueSnapshot } from '../agent/queue.js';
import { gmgnStatusText } from '../enrichment/gmgn.js';

const DAY_MS = 24 * 60 * 60_000;
let cache = { at: 0, value: null };

export function getDashboardSummary() {
  if (cache.value && Date.now() - cache.at < 3000) return cache.value;
  const strategy = getStrategySummary();
  const capital = Number(strategy.positionSizeSol || 0) * Number(strategy.maxOpenPositions || 0);
  const value = {
    strategy,
    mode: EFFECTIVE_TRADING_MODE,
    dryRunLock: DRY_RUN_LOCK,
    privateKeyLoaded: Boolean(SOLANA_PRIVATE_KEY),
    capital,
    allTime: getAllTimeSummary(),
    today: getTodaySummary(),
    openCount: getOpenPositionsSummary().count,
  };
  cache = { at: Date.now(), value };
  return value;
}

export function getAllTimeSummary() {
  return closedSummary('1=1', []);
}

export function getTodaySummary() {
  const start = startOfTodayMs();
  return closedSummary('(COALESCE(closed_at_ms, opened_at_ms) >= ? OR opened_at_ms >= ?)', [start, start]);
}

export function getStrategySummary() {
  const strategy = activeStrategy();
  return {
    id: strategy.id,
    name: strategy.name || strategy.id,
    positionSizeSol: Number(strategy.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)),
    maxOpenPositions: Number(strategy.max_open_positions ?? numSetting('max_open_positions', 3)),
    tpPercent: Number(strategy.tp_percent ?? numSetting('default_tp_percent', 50)),
    slPercent: Number(strategy.sl_percent ?? numSetting('default_sl_percent', -25)),
    trailingEnabled: Boolean(strategy.trailing_enabled),
    trailingPercent: Number(strategy.trailing_percent ?? numSetting('default_trailing_percent', 20)),
    partialTp: Boolean(strategy.partial_tp),
    partialTpAtPercent: Number(strategy.partial_tp_at_percent || 0),
    partialTpSellPercent: Number(strategy.partial_tp_sell_percent || 0),
    llmMinConfidence: Number(strategy.llm_min_confidence ?? numSetting('llm_min_confidence', 75)),
  };
}

export function getAgentSummary() {
  const perf = perfSnapshot();
  const queue = queueSnapshot();
  return {
    casualChatEnabled: boolSetting('casual_chat_enabled', true),
    agentEnabled: boolSetting('agent_enabled', true),
    chatMemoryEnabled: process.env.CHAT_MEMORY_ENABLED !== 'false',
    llmModel: process.env.CHAT_AGENT_MODEL || LLM_MODEL,
    queue,
    perf,
    lastAgentError: queue.failedLastHour?.[0]?.error || '',
  };
}

export function getFilterSummary() {
  const strategy = activeStrategy();
  return {
    minMarketCap: Number(strategy.min_mcap_usd ?? numSetting('min_mcap_usd', 0)),
    maxMarketCap: Number(strategy.max_mcap_usd ?? numSetting('max_mcap_usd', 0)),
    minHolders: Number(strategy.min_holders ?? numSetting('min_holders', 0)),
    maxTopHolderPercent: Number(strategy.max_top_holder_percent ?? strategy.max_top20_holder_percent ?? numSetting('max_top20_holder_percent', 100)),
    maxTop20HolderPercent: Number(strategy.max_top20_holder_percent ?? numSetting('max_top20_holder_percent', 100)),
    maxRugRatio: Number(strategy.trending_max_rug_ratio ?? numSetting('trending_max_rug_ratio', 0.3)),
    maxBundlerRate: Number(strategy.trending_max_bundler_rate ?? numSetting('trending_max_bundler_rate', 0.5)),
    minLiquidity: Number(strategy.min_liquidity_usd ?? numSetting('min_liquidity_usd', 0)),
    llmMinConfidence: Number(strategy.llm_min_confidence ?? numSetting('llm_min_confidence', 75)),
  };
}

export function getWalletSummary() {
  const rows = db.prepare('SELECT label, address, created_at_ms FROM saved_wallets ORDER BY label').all();
  return rows.map(row => ({
    label: row.label,
    address: row.address,
    shortAddress: shortAddress(row.address),
    solBalance: null,
  }));
}

export function getOpenPositionsSummary() {
  const rows = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
    ORDER BY opened_at_ms DESC
  `).all();
  return { count: rows.length, rows };
}

export function getPnlSummary() {
  const realized = closedSummary('1=1', []);
  const today = getTodaySummary();
  const open = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(unrealized_pnl_sol, pnl_sol, 0)), 0) AS pnl
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
  `).get();
  return {
    realizedPnl: realized.pnl,
    unrealizedPnl: Number(open.pnl || 0),
    totalPnl: realized.pnl + Number(open.pnl || 0),
    winRate: realized.winRate,
    profitFactor: realized.profitFactor,
    todayPnl: today.pnl,
    allTimePnl: realized.pnl,
    openCount: Number(open.count || 0),
    closedCount: realized.positions,
  };
}

export function getTopWins(limit = 5) {
  return topTrades('DESC', 'COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) > 0', limit);
}

export function getTopLosses(limit = 5) {
  return topTrades('ASC', 'COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) < 0', limit);
}

export function getHealthSummary() {
  const queue = queueSnapshot();
  const perf = perfSnapshot();
  const latestPosition = db.prepare(`
    SELECT id, symbol, mint, status, opened_at_ms, current_mcap, current_price
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
    ORDER BY opened_at_ms DESC
    LIMIT 1
  `).get();
  const latestCandidate = db.prepare('SELECT id, mint, status, updated_at_ms FROM candidates ORDER BY updated_at_ms DESC LIMIT 1').get();
  const latestDecision = db.prepare('SELECT id, action, at_ms FROM decision_logs ORDER BY at_ms DESC LIMIT 1').get();
  const open = getOpenPositionsSummary();
  const candidates24h = db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE created_at_ms >= ?').get(Date.now() - DAY_MS).count;
  const failedPositions = db.prepare("SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN ('FAILED_ENTRY','FAILED_EXIT')").get().count;
  const dbSize = fileSize(DB_PATH);
  return {
    mode: EFFECTIVE_TRADING_MODE,
    dryRunLock: DRY_RUN_LOCK,
    privateKeyLoaded: Boolean(SOLANA_PRIVATE_KEY),
    signalServerUrl: SIGNAL_SERVER_URL || 'standalone',
    signalPollMs: SIGNAL_POLL_MS,
    gmgnEnabled: GMGN_ENABLED,
    gmgnTokenStatus: gmgnStatusText('token'),
    gmgnTrendingStatus: gmgnStatusText('trending'),
    openCount: open.count,
    latestPosition,
    latestCandidate,
    latestDecision,
    candidates24h: Number(candidates24h || 0),
    failedPositions: Number(failedPositions || 0),
    queue,
    perf,
    dbSizeBytes: dbSize,
  };
}

function closedSummary(whereSql, params) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS positions,
      COALESCE(SUM(size_sol), 0) AS deployed,
      COALESCE(SUM(COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0)), 0) AS pnl,
      SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) < 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) > 0 THEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) ELSE 0 END), 0) AS winPnl,
      COALESCE(SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) < 0 THEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) ELSE 0 END), 0) AS lossPnl
    FROM dry_run_positions
    WHERE status = ? AND ${whereSql}
  `).get(POSITION_STATUS.CLOSED, ...params);
  const positions = Number(row.positions || 0);
  const lossesAbs = Math.abs(Number(row.lossPnl || 0));
  return {
    positions,
    deployed: Number(row.deployed || 0),
    pnl: Number(row.pnl || 0),
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    winPnl: Number(row.winPnl || 0),
    lossPnl: Number(row.lossPnl || 0),
    winRate: positions ? Number(row.wins || 0) / positions * 100 : 0,
    profitFactor: lossesAbs ? Number(row.winPnl || 0) / lossesAbs : 0,
  };
}

function topTrades(order, whereSql, limit) {
  return db.prepare(`
    SELECT id, mint, symbol, strategy_id, opened_at_ms, closed_at_ms, entry_mcap, exit_mcap,
           exit_reason, size_sol, pnl_percent, COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) AS pnl
    FROM dry_run_positions
    WHERE status = ? AND ${whereSql}
    ORDER BY COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) ${order}
    LIMIT ?
  `).all(POSITION_STATUS.CLOSED, limit);
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function shortAddress(address = '') {
  return address.length > 12 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}
