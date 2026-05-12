import { bot } from './bot.js';
import { TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_CHAT_ID } from '../config.js';
import { allStrategies, setActiveStrategy } from '../db/settings.js';
import { strategyKeyboard, strategyMenuText } from './menus.js';
import { formatPositionList } from './formatters/positionFormatter.js';
import {
  getAgentSummary,
  getAllTimeSummary,
  getDashboardSummary,
  getFilterSummary,
  getHealthSummary,
  getOpenPositionsSummary,
  getPnlSummary,
  getStrategySummary,
  getTodaySummary,
  getTopLosses,
  getTopWins,
  getWalletSummary,
} from '../services/dashboardData.js';

const activeTabs = new Map();
const DASHBOARD_REFRESH_MS = 2 * 60 * 1000;

export async function sendDashboard(chatId, fromUser = null, tab = 'home') {
  if (!isDashboardAuthorized(chatId, fromUser?.id)) return bot.sendMessage(chatId, 'not authorized');
  const rendered = renderByTab(tab);
  const message = await bot.sendMessage(chatId, withUpdatedAt(rendered.text), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...rendered.keyboard,
  });
  activeTabs.set(`${chatId}:${message.message_id}`, { chatId, messageId: message.message_id, tab });
  return message;
}

export async function handleDashboardCallback(query) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const userId = query.from?.id;
  if (!isDashboardAuthorized(chatId, userId)) {
    return bot.answerCallbackQuery(query.id, { text: 'not authorized', show_alert: false }).catch(() => {});
  }
  const parts = String(query.data || '').split(':');
  const action = parts[1] || 'home';
  const key = messageKey(query);
  if (action === 'config') {
    activeTabs.delete(key);
    return editDashboardMessage(query, strategyMenuText(), strategyKeyboard());
  }
  if (action === 'strategy_select') {
    const strategyId = parts[2];
    if (strategyId) setActiveStrategy(strategyId);
    activeTabs.set(key, { chatId, messageId: query.message.message_id, tab: 'strategy' });
    const rendered = renderDashboardStrategy();
    rendered.text = withUpdatedAt(rendered.text);
    return editDashboardMessage(query, rendered.text, rendered.keyboard);
  }
  const current = activeTabs.get(key)?.tab || 'home';
  if (action === 'close') {
    activeTabs.delete(key);
    return bot.deleteMessage(chatId, query.message.message_id)
      .catch(() => editDashboardMessage(query, 'Dashboard closed.', { reply_markup: { inline_keyboard: [] } }));
  }
  const tab = action || current;
  activeTabs.set(key, { chatId, messageId: query.message.message_id, tab });
  const rendered = renderByTab(tab);
  rendered.text = withUpdatedAt(rendered.text);
  return editDashboardMessage(query, rendered.text, rendered.keyboard);
}

export function forgetDashboardMessage(query) {
  activeTabs.delete(messageKey(query));
}

export function editDashboardTab(query, tab = 'home') {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const userId = query.from?.id;
  if (!isDashboardAuthorized(chatId, userId)) {
    return bot.answerCallbackQuery(query.id, { text: 'not authorized', show_alert: false }).catch(() => {});
  }
  const selectedTab = tab || 'home';
  activeTabs.set(messageKey(query), { chatId, messageId: query.message.message_id, tab: selectedTab });
  const rendered = renderByTab(selectedTab);
  return editDashboardMessage(query, withUpdatedAt(rendered.text), rendered.keyboard);
}

export function renderDashboardHome() {
  const summary = getDashboardSummary();
  const strategy = summary.strategy;
  const capitalText = `${fmtSol(summary.capital)} SOL (${strategy.maxOpenPositions} x ${fmtSol(strategy.positionSizeSol)})`;
  return {
    text: [
      '🟢 Charon',
      '',
      `Strategy: ${strategy.name} · Mode: ${summary.mode}`,
      `Dry Run Lock: ${summary.dryRunLock ? 'ON' : 'OFF'}`,
      `Capital: ${capitalText}`,
      '',
      sectionSummary('📊 All-Time', summary.allTime, summary.capital, summary.openCount),
      '',
      sectionSummary('🗓 Today', summary.today, summary.capital, summary.openCount),
    ].join('\n'),
    keyboard: getDashboardKeyboard('home'),
  };
}

export function renderDashboardStrategy() {
  const s = getStrategySummary();
  const rows = allStrategies().map(strategy => [{
    text: `${strategy.enabled ? '▶ ' : ''}${strategy.name}`,
    callback_data: `dash:strategy_select:${strategy.id}`,
  }]);
  return {
    text: [
      'Strategy',
      '',
      `Active: ${s.name} (${s.id})`,
      `Position size: ${fmtSol(s.positionSizeSol)} SOL`,
      `Max open positions: ${s.maxOpenPositions}`,
      `TP: ${fmtPct(s.tpPercent)}`,
      `SL: ${fmtPct(s.slPercent)}`,
      `Trailing: ${s.trailingEnabled ? `ON (${fmtPct(s.trailingPercent)})` : 'OFF'}`,
      `Partial TP: ${s.partialTp ? `ON at ${fmtPct(s.partialTpAtPercent)}, sell ${fmtPct(s.partialTpSellPercent)}` : 'OFF'}`,
      `LLM min confidence: ${fmtPct(s.llmMinConfidence)}`,
    ].join('\n'),
    keyboard: appendKeyboardRows(getDashboardKeyboard('strategy'), [
      [{ text: 'Select Strategy', callback_data: 'noop' }],
      ...rows,
    ]),
  };
}

export function renderDashboardAgent() {
  const a = getAgentSummary();
  return {
    text: [
      'Agent',
      '',
      `Signal agent: ${a.agentEnabled ? 'ON' : 'OFF'}`,
      `Casual chat: ${a.casualChatEnabled ? 'ON' : 'OFF'}`,
      `LLM model: ${a.llmModel || 'not configured'}`,
      `Chat memory: ${a.chatMemoryEnabled ? 'ON' : 'OFF'}`,
      `Queue active: ${a.queue.active ? `${a.queue.active.id} (${a.queue.active.status})` : 'none'}`,
      `Pending requests: ${a.queue.pendingCount || 0}`,
      `Average response: ${a.perf.averageResponseMs} ms`,
      `Fast path hits: ${a.perf.fastPathHits}`,
      `Last agent error: ${a.lastAgentError || 'none'}`,
    ].join('\n'),
    keyboard: getDashboardKeyboard('agent'),
  };
}

export function renderDashboardFilters() {
  const f = getFilterSummary();
  return {
    text: [
      'Filters',
      '',
      `Min market cap: ${fmtUsd(f.minMarketCap)}`,
      `Max market cap: ${fmtUsd(f.maxMarketCap)}`,
      `Min holders: ${f.minHolders}`,
      `Max top holder: ${fmtPct(f.maxTopHolderPercent)}`,
      `Max top20 holders: ${fmtPct(f.maxTop20HolderPercent)}`,
      `Max rug ratio: ${fmtPct(Number(f.maxRugRatio) * 100)}`,
      `Max bundler rate: ${fmtPct(Number(f.maxBundlerRate) * 100)}`,
      `Min liquidity: ${fmtUsd(f.minLiquidity)}`,
      `LLM min confidence: ${fmtPct(f.llmMinConfidence)}`,
    ].join('\n'),
    keyboard: getDashboardKeyboard('filters'),
  };
}

export function renderDashboardWallets() {
  const wallets = getWalletSummary();
  const lines = wallets.length
    ? wallets.map(row => `- ${row.label}: ${row.shortAddress}${row.solBalance == null ? '' : ` · ${fmtSol(row.solBalance)} SOL`}`)
    : ['No wallets configured.'];
  return { text: ['Wallets', '', ...lines].join('\n'), keyboard: getDashboardKeyboard('wallets') };
}

export function renderDashboardPositions() {
  const { rows, count } = getOpenPositionsSummary();
  if (!rows.length) return { text: 'Positions\n\nNo open positions right now.', keyboard: getDashboardKeyboard('positions') };
  const lines = [formatPositionList(rows, { limit: 10 })];
  if (count > 10) lines.push(`...and ${count - 10} more`);
  return { text: ['Positions', '', ...lines].join('\n\n'), keyboard: getDashboardKeyboard('positions') };
}

export function renderDashboardHealth() {
  const h = getHealthSummary();
  const queueActive = h.queue.active ? `${h.queue.active.id} (${h.queue.active.status})` : 'none';
  return {
    text: [
      'Health',
      '',
      `Mode: ${h.mode} · Dry lock: ${h.dryRunLock ? 'ON' : 'OFF'}`,
      `Signal: ${h.signalServerUrl}`,
      `Poll: ${Math.round(Number(h.signalPollMs || 0) / 1000)}s`,
      '',
      `GMGN token: ${h.gmgnTokenStatus}`,
      `GMGN trending: ${h.gmgnTrendingStatus}`,
      `GMGN enabled: ${h.gmgnEnabled ? 'yes' : 'no'}`,
      '',
      `Open positions: ${h.openCount}`,
      `Latest position: ${latestPositionText(h.latestPosition)}`,
      `Latest candidate: ${latestCandidateText(h.latestCandidate)}`,
      `Latest decision: ${latestDecisionText(h.latestDecision)}`,
      '',
      `Candidates 24h: ${h.candidates24h}`,
      `Failed entries/exits: ${h.failedPositions}`,
      `DB size: ${formatBytes(h.dbSizeBytes)}`,
      '',
      `Queue: ${queueActive} · pending ${h.queue.pendingCount || 0}`,
      `Avg response: ${h.perf.averageResponseMs} ms`,
      `Failures 1h: ${h.queue.failedLastHour?.length || 0}`,
    ].join('\n'),
    keyboard: getDashboardKeyboard('health'),
  };
}

function latestPositionText(row) {
  if (!row) return 'none';
  return `#${row.id} ${row.symbol || short(row.mint)} (${row.status})`;
}

function latestCandidateText(row) {
  if (!row) return 'none';
  return `#${row.id} ${short(row.mint)} ${row.status || ''} ${age(row.updated_at_ms)} ago`;
}

function latestDecisionText(row) {
  if (!row) return 'none';
  return `#${row.id} ${row.action || ''} ${age(row.at_ms)} ago`;
}
export function renderDashboardPnl() {
  const p = getPnlSummary();
  return {
    text: [
      'PnL',
      '',
      `Realized: ${fmtSol(p.realizedPnl)} SOL`,
      `Unrealized: ${fmtSol(p.unrealizedPnl)} SOL`,
      `Total: ${fmtSol(p.totalPnl)} SOL`,
      `Win rate: ${fmtPct(p.winRate)}`,
      `Profit factor: ${p.profitFactor.toFixed(2)}`,
      '',
      `Today PnL: ${fmtSol(p.todayPnl)} SOL`,
      `All-time PnL: ${fmtSol(p.allTimePnl)} SOL`,
      `Open: ${p.openCount} · Closed: ${p.closedCount}`,
    ].join('\n'),
    keyboard: getDashboardKeyboard('pnl'),
  };
}

export function renderDashboardTopWins() {
  return renderTopTrades('🏆 Top Wins', getTopWins(), 'top_wins');
}

export function renderDashboardTopLosses() {
  return renderTopTrades('📉 Top Losses', getTopLosses(), 'top_losses');
}

export function getDashboardKeyboard(activeTab) {
  const b = (label, tab) => ({ text: `${activeTab === tab ? '• ' : ''}${label}`, callback_data: `dash:${tab}` });
  return {
    reply_markup: {
      inline_keyboard: [
        [b('Agent', 'agent'), b('Health', 'health')],
        [b('Filters', 'filters')],
        [b('Wallets', 'wallets'), b('Positions', 'positions'), b('PnL', 'pnl')],
        [b('🏆 Top Wins', 'top_wins'), b('📉 Top Losses', 'top_losses')],
        [{ text: '⚙ Config', callback_data: 'menu:strategy' }, { text: '❌ Close', callback_data: 'dash:close' }],
      ],
    },
  };
}

function renderByTab(tab) {
  if (tab === 'strategy') return renderDashboardStrategy();
  if (tab === 'agent') return renderDashboardAgent();
  if (tab === 'health') return renderDashboardHealth();
  if (tab === 'filters') return renderDashboardFilters();
  if (tab === 'wallets') return renderDashboardWallets();
  if (tab === 'positions') return renderDashboardPositions();
  if (tab === 'pnl') return renderDashboardPnl();
  if (tab === 'top_wins') return renderDashboardTopWins();
  if (tab === 'top_losses') return renderDashboardTopLosses();
  return renderDashboardHome();
}

function sectionSummary(title, data, capital, openCount) {
  const roiCapital = capital ? data.pnl / capital * 100 : 0;
  const roiDeployed = data.deployed ? data.pnl / data.deployed * 100 : 0;
  return [
    `${title} (${data.positions} positions)`,
    `PnL: ${fmtSol(data.pnl)} SOL (${fmtPct(roiCapital)} of capital)`,
    `Deployed: ${fmtSol(data.deployed)} SOL (ROI ${fmtPct(roiDeployed)})`,
    `Win: ${data.wins} (${fmtSol(data.winPnl)} SOL)`,
    `Loss: ${data.losses} (${fmtSol(data.lossPnl)} SOL)`,
    `Win Rate: ${fmtPct(data.winRate)}`,
    `Open: ${openCount}`,
  ].join('\n');
}

function renderTopTrades(title, rows, tab) {
  const lines = rows.length ? rows.map(row => [
    `${row.symbol || short(row.mint)} · ${fmtSol(row.pnl)} SOL · ${fmtPct(row.pnl_percent || 0)}`,
    `${row.exit_reason || 'exit'} · hold ${hold(row.opened_at_ms, row.closed_at_ms)}`,
  ].join('\n')) : ['No closed trades yet.'];
  return { text: [title, '', ...lines].join('\n\n'), keyboard: getDashboardKeyboard(tab) };
}

function editDashboardMessage(query, text, keyboard) {
  return bot.editMessageText(text, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...keyboard,
  }).catch(() => bot.sendMessage(query.message.chat.id, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...keyboard,
  }));
}

function appendKeyboardRows(keyboard, rows) {
  return {
    ...keyboard,
    reply_markup: {
      inline_keyboard: [
        ...rows,
        ...(keyboard.reply_markup?.inline_keyboard || []),
      ],
    },
  };
}

function isDashboardAuthorized(chatId, userId) {
  if (TELEGRAM_ALLOWED_USER_IDS.length) return TELEGRAM_ALLOWED_USER_IDS.includes(String(userId));
  return !TELEGRAM_CHAT_ID || String(chatId) === String(TELEGRAM_CHAT_ID);
}

function messageKey(query) {
  return `${query.message?.chat?.id}:${query.message?.message_id}`;
}

function fmtSol(value) {
  const n = Number(value || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)}`;
}

function fmtPct(value) {
  const n = Number(value || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtUsd(value) {
  const n = Number(value || 0);
  if (!n) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function short(value = '') {
  return value.length > 10 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function hold(openedAtMs, closedAtMs = Date.now()) {
  const opened = Number(openedAtMs || 0);
  if (!opened) return '-';
  const minutes = Math.max(0, Math.round((Number(closedAtMs || Date.now()) - opened) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function age(timestampMs) {
  const ts = Number(timestampMs || 0);
  if (!ts) return '-';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return 'N/A';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function timeNow() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function withUpdatedAt(text) {
  return `${text}\n\nUpdated: ${timeNow()} · auto refresh 2m`;
}

const refreshTimer = setInterval(() => {
  for (const [key, state] of activeTabs.entries()) {
    const rendered = renderByTab(state.tab);
    bot.editMessageText(withUpdatedAt(rendered.text), {
      chat_id: state.chatId,
      message_id: state.messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...rendered.keyboard,
    }).catch(() => activeTabs.delete(key));
  }
}, DASHBOARD_REFRESH_MS);
refreshTimer.unref?.();
