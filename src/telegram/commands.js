import { bot } from './bot.js';
import { DRY_RUN_LOCK, ENV_TRADING_MODE, EFFECTIVE_TRADING_MODE, SOLANA_PRIVATE_KEY, TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';
import { closeMetrics, closedTradeRows, strategyBreakdown, summarizeTrades, windowCutoff } from '../services/performance.js';
import { exportCandidates, exportClosedPositions, exportOpenPositions, exportTrades } from '../services/exporter.js';
import { currentRiskState } from '../services/risk.js';
import { readinessScore } from '../services/readiness.js';
import { ACTIVE_STATUSES, POSITION_STATUS, auditPositions, isActiveStatus, statusSqlList } from '../services/positionStatus.js';

let dryRunResetConfirmAt = 0;

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/mode')) return sendMode(chatId);
  if (text.startsWith('/unlock_confirm')) return sendUnlockInstructions(chatId);
  if (text.startsWith('/stats')) return sendStats(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/export_trades')) return sendTradeExport(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/export_candidates')) return sendCandidateExport(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/export_open_positions')) return sendOpenPositionExport(chatId);
  if (text.startsWith('/export_closed_positions')) return sendClosedPositionExport(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/compare_strategies')) return sendStrategyCompare(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/filter_report')) return sendFilterReport(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/risk')) return sendRisk(chatId);
  if (text.startsWith('/readiness')) return sendReadiness(chatId);
  if (text.startsWith('/position_audit')) return sendPositionAudit(chatId);
  if (text.startsWith('/dryrun_reset_confirm')) return confirmDryRunReset(chatId);
  if (text.startsWith('/dryrun_reset_execute')) return executeDryRunReset(chatId);
  if (text.startsWith('/open_positions')) return sendPositions(chatId);
  if (text.startsWith('/closed_positions')) return sendClosedPositions(chatId, text.split(/\s+/)[1] || '24h');
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId, query = null, backCallbackData = 'menu:main') {
  const rows = activePositionRows(30);
  const open = rows.filter(row => row.status === POSITION_STATUS.OPEN);
  const partial = rows.filter(row => row.status === POSITION_STATUS.PARTIALLY_CLOSED);
  const totalUnrealized = rows.reduce((sum, row) => sum + Number(row.unrealized_pnl_sol ?? row.pnl_sol ?? 0), 0);
  const text = [
    `<b>ACTIVE POSITIONS</b> · ${rows.length} open · Total PnL: <b>${fmtSol(totalUnrealized)} SOL</b>`,
    '',
    '<b>OPEN POSITIONS</b>',
    open.length ? open.map(formatActivePosition).join('\n\n') : 'None.',
    '',
    '<b>PARTIALLY CLOSED POSITIONS</b>',
    partial.length ? partial.map(formatActivePosition).join('\n\n') : 'None.',
  ].join('\n');
  const keyboardRows = [];
  if (rows.length) keyboardRows.push([{ text: 'Close All Positions', callback_data: 'closeall:confirm' }]);
  keyboardRows.push([{ text: 'Back', callback_data: backCallbackData }]);
  const keyboard = { reply_markup: { inline_keyboard: keyboardRows } };
  if (query) return editMenuMessage(query, text, keyboard);
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (isActiveStatus(row.status)) {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = isActiveStatus(row.status) ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || !isActiveStatus(row.status)) return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  const metrics = row.execution_mode === 'live'
    ? { grossPnlSol: pnlSol, netPnlSol: pnlSol, pnlPercent, maxUnrealizedPercent: row.max_unrealized_percent || 0, maxDrawdownPercent: row.max_drawdown_percent || 0, lowestMcap: row.lowest_mcap || mcap }
    : closeMetrics(row, { exitMcap: mcap, exitReason: reason || 'MANUAL', notes: 'Manual Telegram close.' });
  db.prepare(`
    UPDATE dry_run_positions
    SET status = ?, closed_at_ms = ?, closed_at = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, gross_pnl_sol = ?, net_pnl_sol = ?,
        realized_pnl_percent = ?, realized_pnl_sol = ?, unrealized_pnl_percent = 0, unrealized_pnl_sol = 0,
        remaining_amount = 0, is_closed = 1,
        max_unrealized_percent = ?, max_drawdown_percent = ?, lowest_mcap = ?, exit_signature = ?, exit_tx_hash = ?
    WHERE id = ?
  `).run(POSITION_STATUS.CLOSED, now(), new Date(now()).toISOString(), price, mcap, reason,
    metrics.pnlPercent, metrics.netPnlSol, metrics.grossPnlSol, metrics.netPnlSol,
    metrics.pnlPercent, metrics.netPnlSol,
    metrics.maxUnrealizedPercent, metrics.maxDrawdownPercent, metrics.lowestMcap, sell?.signature || null, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent: metrics.pnlPercent, pnlSol: metrics.netPnlSol, grossPnlSol: metrics.grossPnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(metrics.pnlPercent)} net ${fmtSol(metrics.netPnlSol)} SOL`, { parse_mode: 'HTML' });
}

export async function confirmCloseAllPositions(chatId, query = null) {
  const rows = activePositionRows(100);
  const dryRunCount = rows.filter(row => row.execution_mode !== 'live').length;
  const liveCount = rows.length - dryRunCount;
  const text = [
    '<b>Close All Positions?</b>',
    '',
    `Active positions: ${rows.length}`,
    `Dry-run positions that will close: ${dryRunCount}`,
    liveCount ? `Live positions skipped: ${liveCount}` : null,
    '',
    'This will close active dry-run positions at their latest current market cap.',
  ].filter(Boolean).join('\n');
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Yes, Close All Dry-Run', callback_data: 'closeall:execute' }],
        [{ text: 'Cancel', callback_data: 'menu:positions' }],
      ],
    },
  };
  if (query) return editMenuMessage(query, text, keyboard);
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
}

export async function executeCloseAllPositions(chatId, query = null) {
  const rows = activePositionRows(100).filter(row => row.execution_mode !== 'live');
  let closed = 0;
  let totalNet = 0;
  for (const row of rows) {
    const result = await refreshPosition(row, { autoExit: false }).catch(() => null);
    const price = result?.price ?? row.current_price ?? row.high_water_price ?? row.entry_price;
    const mcap = result?.mcap ?? row.current_mcap ?? row.entry_mcap;
    const metrics = closeMetrics(row, { exitMcap: mcap, exitReason: 'MANUAL_CLOSE_ALL', notes: 'Closed by Telegram close all.' });
    db.prepare(`
      UPDATE dry_run_positions
      SET status = ?, closed_at_ms = ?, closed_at = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, gross_pnl_sol = ?, net_pnl_sol = ?,
          realized_pnl_percent = ?, realized_pnl_sol = ?, unrealized_pnl_percent = 0, unrealized_pnl_sol = 0,
          remaining_amount = 0, current_mcap = ?, current_price = ?, is_closed = 1
      WHERE id = ?
    `).run(POSITION_STATUS.CLOSED, now(), new Date(now()).toISOString(), price, mcap, 'MANUAL_CLOSE_ALL',
      metrics.pnlPercent, metrics.netPnlSol, metrics.grossPnlSol, metrics.netPnlSol,
      metrics.pnlPercent, metrics.netPnlSol, mcap, price, row.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'MANUAL_CLOSE_ALL', ?)
    `).run(row.id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, json({ pnlPercent: metrics.pnlPercent, pnlSol: metrics.netPnlSol, grossPnlSol: metrics.grossPnlSol }));
    closed++;
    totalNet += Number(metrics.netPnlSol || 0);
  }
  const text = `Closed ${closed} dry-run positions. Net realized PnL: <b>${fmtSol(totalNet)} SOL</b>.`;
  if (query) return editMenuMessage(query, text, { reply_markup: { inline_keyboard: [[{ text: 'Back to Positions', callback_data: 'menu:positions' }]] } });
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

function activePositionRows(limit = 30) {
  return db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
    ORDER BY opened_at_ms DESC
    LIMIT ?
  `).all(limit);
}

function closedPositionRows(windowArg = '24h', limit = 30) {
  return db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE status = ?
      AND COALESCE(closed_at_ms, opened_at_ms) >= ?
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC
    LIMIT ?
  `).all(POSITION_STATUS.CLOSED, windowCutoff(windowArg), limit);
}

function holdMinutes(row) {
  const end = Number(row.closed_at_ms || now());
  return minutes(Math.max(0, end - Number(row.opened_at_ms || end)));
}

function formatActivePosition(row) {
  return [
    `<b>${escapeHtml(row.symbol || row.mint)}</b>`,
    `<code>${escapeHtml(row.mint)}</code>`,
    `Strategy: ${escapeHtml(row.strategy_id || 'sniper')} · Status: <b>${escapeHtml(row.status)}</b>`,
    `Entry mcap: ${fmtUsd(row.entry_mcap)} · Current mcap: ${fmtUsd(row.current_mcap ?? row.entry_mcap)}`,
    `High mcap: ${fmtUsd(row.high_water_mcap || row.entry_mcap)}`,
    `Unrealized: ${fmtSol(row.unrealized_pnl_sol || row.pnl_sol || 0)} SOL (${fmtPct(row.unrealized_pnl_percent ?? row.pnl_percent ?? 0)})`,
    `Hold: ${holdMinutes(row)}m · Remaining: ${fmtSol(row.remaining_amount ?? row.token_amount_est ?? row.size_sol)}`,
    row.partial_tp_done ? 'Partial TP: yes' : 'Partial TP: no',
  ].join('\n');
}

function formatClosedPosition(row) {
  return [
    `<b>${escapeHtml(row.symbol || row.mint)}</b>`,
    `<code>${escapeHtml(row.mint)}</code>`,
    `Strategy: ${escapeHtml(row.strategy_id || 'sniper')} · Exit: <b>${escapeHtml(row.exit_reason || '-')}</b>`,
    `Opened: ${escapeHtml(row.opened_at || new Date(Number(row.opened_at_ms || 0)).toISOString())}`,
    `Closed: ${escapeHtml(row.closed_at || (row.closed_at_ms ? new Date(Number(row.closed_at_ms)).toISOString() : '-'))}`,
    `Hold: ${holdMinutes(row)}m`,
    `Entry/Exit mcap: ${fmtUsd(row.entry_mcap)} / ${fmtUsd(row.exit_mcap)}`,
    `Realized: ${fmtSol(row.realized_pnl_sol ?? row.net_pnl_sol ?? row.pnl_sol ?? 0)} SOL (${fmtPct(row.realized_pnl_percent ?? row.pnl_percent ?? 0)})`,
  ].join('\n');
}

async function sendClosedPositions(chatId, windowArg) {
  const rows = closedPositionRows(windowArg, 20);
  const text = [
    `<b>CLOSED POSITIONS (${escapeHtml(windowArg)})</b>`,
    '',
    rows.length ? rows.map(formatClosedPosition).join('\n\n') : 'None.',
  ].join('\n');
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function sendMode(chatId) {
  const text = [
    '<b>Mode</b>',
    '',
    `Effective mode: <b>${escapeHtml(EFFECTIVE_TRADING_MODE)}</b>`,
    `Env TRADING_MODE: <b>${escapeHtml(ENV_TRADING_MODE)}</b>`,
    `Dry run lock: <b>${DRY_RUN_LOCK ? 'ACTIVE' : 'off'}</b>`,
    `Private key loaded: <b>${SOLANA_PRIVATE_KEY ? 'yes' : 'no'}</b>`,
    DRY_RUN_LOCK ? '' : 'Live/confirm remains subject to risk checks and wallet config.',
    DRY_RUN_LOCK ? '<b>DRY RUN LOCK ACTIVE — live trading disabled.</b>' : '',
  ].filter(Boolean).join('\n');
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function sendUnlockInstructions(chatId) {
  return bot.sendMessage(chatId, [
    '<b>Unlock Confirmation</b>',
    '',
    'This command does not enable live trading.',
    'To unlock, manually set <code>DRY_RUN_LOCK=false</code> in <code>.env</code>, verify wallet/risk settings, and restart the bot.',
    'Keep <code>TRADING_MODE=dry_run</code> until /readiness supports confirm mode.',
  ].join('\n'), { parse_mode: 'HTML' });
}

function fmtMaybe(value, digits = 4) {
  const n = Number(value);
  if (n === Infinity) return 'inf';
  if (!Number.isFinite(n)) return '?';
  return n.toFixed(digits);
}

function minutes(ms) {
  return (Number(ms || 0) / 60_000).toFixed(1);
}

async function sendStats(chatId, windowArg) {
  const summary = summarizeTrades(windowArg);
  const strategies = strategyBreakdown(windowArg);
  const warn = summary.closedTrades < 30 ? '\n\n<b>Warning:</b> not enough sample size.' : '';
  const lines = [
    `<b>Dry-run Stats (${escapeHtml(windowArg)})</b>`,
    '',
    `Trades: ${summary.totalTrades} total · ${summary.openTrades} open · ${summary.closedTrades} closed`,
    `Win/Loss: ${fmtPct(summary.winRate)} / ${fmtPct(summary.lossRate)}`,
    `Gross PnL: ${fmtSol(summary.grossPnl)} SOL · Net PnL: ${fmtSol(summary.netPnl)} SOL`,
    `Avg win/loss: ${fmtSol(summary.averageWin)} / ${fmtSol(summary.averageLoss)} SOL`,
    `Profit factor: ${fmtMaybe(summary.profitFactor, 2)} · Expectancy: ${fmtSol(summary.expectancy)} SOL`,
    `Max drawdown: ${fmtPct(summary.maxDrawdown)} · Median hold: ${minutes(summary.medianHoldMs)}m`,
    `Best: ${summary.bestTrade ? `${escapeHtml(summary.bestTrade.symbol || summary.bestTrade.token_symbol || summary.bestTrade.mint)} ${fmtSol(summary.bestTrade.net_pnl_sol ?? summary.bestTrade.pnl_sol)} SOL` : '-'}`,
    `Worst: ${summary.worstTrade ? `${escapeHtml(summary.worstTrade.symbol || summary.worstTrade.token_symbol || summary.worstTrade.mint)} ${fmtSol(summary.worstTrade.net_pnl_sol ?? summary.worstTrade.pnl_sol)} SOL` : '-'}`,
    `Exits: TP ${summary.tpCount} · SL ${summary.slCount} · Trail ${summary.trailingTpCount} · Max hold ${summary.maxHoldCount}`,
    `Failures: entry ${summary.failedEntryCount} · exit ${summary.failedExitCount}`,
    '',
    '<b>By strategy</b>',
    ...strategies.map(s => `${escapeHtml(s.strategyId)}: ${s.trades} trades · win ${fmtPct(s.winRate)} · net ${fmtSol(s.netPnl)} SOL · PF ${fmtMaybe(s.profitFactor, 2)} · hold ${minutes(s.averageHoldMs)}m · exit ${escapeHtml(s.mostCommonExitReason)}`),
    warn,
  ];
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function sendTradeExport(chatId, windowArg) {
  const result = exportTrades(windowArg);
  return bot.sendDocument(chatId, result.filePath, {}, { filename: result.filePath.split(/[\\/]/).pop(), contentType: 'text/csv' })
    .then(() => bot.sendMessage(chatId, `Exported ${result.rowCount} trades to ${escapeHtml(result.filePath)}.`, { parse_mode: 'HTML' }));
}

async function sendCandidateExport(chatId, windowArg) {
  const result = exportCandidates(windowArg);
  return bot.sendDocument(chatId, result.filePath, {}, { filename: result.filePath.split(/[\\/]/).pop(), contentType: 'text/csv' })
    .then(() => bot.sendMessage(chatId, `Exported ${result.rowCount} candidates to ${escapeHtml(result.filePath)}.`, { parse_mode: 'HTML' }));
}

async function sendOpenPositionExport(chatId) {
  const result = exportOpenPositions();
  return bot.sendDocument(chatId, result.filePath, {}, { filename: result.filePath.split(/[\\/]/).pop(), contentType: 'text/csv' })
    .then(() => bot.sendMessage(chatId, `Exported ${result.rowCount} active positions to ${escapeHtml(result.filePath)}.`, { parse_mode: 'HTML' }));
}

async function sendClosedPositionExport(chatId, windowArg) {
  const result = exportClosedPositions(windowArg);
  return bot.sendDocument(chatId, result.filePath, {}, { filename: result.filePath.split(/[\\/]/).pop(), contentType: 'text/csv' })
    .then(() => bot.sendMessage(chatId, `Exported ${result.rowCount} closed positions to ${escapeHtml(result.filePath)}.`, { parse_mode: 'HTML' }));
}

function sampleLabel(count) {
  if (count < 30) return 'LOW SAMPLE';
  if (count < 100) return 'MEDIUM SAMPLE';
  return 'DECENT SAMPLE';
}

async function sendStrategyCompare(chatId, windowArg) {
  const ranked = strategyBreakdown(windowArg)
    .map(s => ({ ...s, sample: sampleLabel(s.trades) }))
    .sort((a, b) => b.netPnl - a.netPnl || b.profitFactor - a.profitFactor || b.maxDrawdown - a.maxDrawdown || b.winRate - a.winRate);
  const best = ranked.find(s => s.trades > 0);
  const lines = [
    `<b>Strategy Comparison (${escapeHtml(windowArg)})</b>`,
    '',
    ...ranked.map((s, i) => `${i + 1}. <b>${escapeHtml(s.strategyId)}</b> — ${s.sample}\nTrades ${s.trades} · Net ${fmtSol(s.netPnl)} SOL · PF ${fmtMaybe(s.profitFactor, 2)} · DD ${fmtPct(s.maxDrawdown)} · Win ${fmtPct(s.winRate)}`),
    '',
    best ? `Evidence-based pick: <b>${escapeHtml(best.strategyId)}</b> (${best.sample}).` : 'No closed dry-run data yet.',
  ];
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

function bucket(value, buckets) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  for (const [label, min, max] of buckets) if (n >= min && n < max) return label;
  return buckets[buckets.length - 1][0];
}

function groupStats(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, trades]) => {
    const wins = trades.filter(r => Number(r.net_pnl_sol ?? r.pnl_sol ?? 0) > 0);
    const losses = trades.filter(r => Number(r.net_pnl_sol ?? r.pnl_sol ?? 0) < 0);
    const winSum = wins.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
    const lossSum = Math.abs(losses.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0));
    const net = trades.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
    return { key, count: trades.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, net, avg: trades.length ? net / trades.length : 0, pf: lossSum ? winSum / lossSum : (winSum > 0 ? Infinity : 0) };
  }).sort((a, b) => b.net - a.net).slice(0, 8);
}

async function sendFilterReport(chatId, windowArg) {
  const rows = closedTradeRows(windowArg);
  if (!rows.length) return bot.sendMessage(chatId, `No closed dry-run trades for ${windowArg}.`);
  const mcapBuckets = [['0-10k', 0, 10000], ['10k-30k', 10000, 30000], ['30k-50k', 30000, 50000], ['50k-100k', 50000, 100000], ['100k-250k', 100000, 250000], ['250k+', 250000, Infinity]];
  const reports = [
    ['Market cap', r => bucket(r.entry_mcap, mcapBuckets)],
    ['Holders', r => bucket(r.holders, [['0-100', 0, 100], ['100-300', 100, 300], ['300-1000', 300, 1000], ['1000+', 1000, Infinity]])],
    ['Top20', r => bucket(r.top20_holder_percent, [['0-30', 0, 30], ['30-60', 30, 60], ['60+', 60, Infinity]])],
    ['Rug ratio', r => bucket(r.rug_ratio, [['0-0.2', 0, 0.2], ['0.2-0.3', 0.2, 0.3], ['0.3+', 0.3, Infinity]])],
    ['Bundler', r => bucket(r.bundler_rate, [['0-0.2', 0, 0.2], ['0.2-0.4', 0.2, 0.4], ['0.4+', 0.4, Infinity]])],
    ['Source count', r => String(r.source_count ?? 'unknown')],
    ['LLM confidence', r => bucket(r.llm_confidence, [['0-50', 0, 50], ['50-70', 50, 70], ['70-85', 70, 85], ['85+', 85, Infinity]])],
    ['Hour UTC', r => r.entry_at_ms ? `${new Date(Number(r.entry_at_ms)).getUTCHours()}:00` : 'unknown'],
    ['Strategy', r => r.strategy_id || 'sniper'],
  ];
  const chunks = reports.map(([title, fn]) => {
    const lines = groupStats(rows, fn).map(g => `${escapeHtml(g.key)}: n=${g.count}${g.count < 10 ? ' small' : ''} · win ${fmtPct(g.winRate)} · net ${fmtSol(g.net)} · avg ${fmtSol(g.avg)} · PF ${fmtMaybe(g.pf, 2)}`);
    return `<b>${title}</b>\n${lines.join('\n')}`;
  });
  return bot.sendMessage(chatId, [`<b>Filter Report (${escapeHtml(windowArg)})</b>`, '', ...chunks].join('\n\n'), { parse_mode: 'HTML' });
}

async function sendRisk(chatId) {
  const r = currentRiskState();
  const lines = [
    '<b>Risk Guardrails</b>',
    '',
    `Daily loss used: ${fmtSol(r.dailyLossUsedSol)} / ${fmtSol(r.maxDailyLossSol)} SOL`,
    `Daily trades used: ${r.dailyTradesUsed} / ${r.maxDailyTrades}`,
    `Consecutive losses: ${r.consecutiveLosses} / ${r.maxConsecutiveLosses}`,
    `Cooldown: ${r.cooldownActive ? `active until ${new Date(r.cooldownUntilMs).toISOString()}` : 'off'}`,
    `Max position size: ${fmtSol(r.maxPositionSizeSol)} SOL`,
    `Open exposure: ${fmtSol(r.openExposureSol)} SOL`,
    `Next trade allowed by live guardrails: <b>${r.allowed ? 'yes' : 'no'}</b>`,
    r.reasons.length ? `Reasons: ${escapeHtml(r.reasons.join('; '))}` : null,
  ].filter(Boolean);
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function sendReadiness(chatId) {
  const r = readinessScore();
  const lines = [
    '<b>Pre-live Readiness</b>',
    '',
    `Score: <b>${r.score}/100</b>`,
    `Status: <b>${escapeHtml(r.status)}</b>`,
    `Closed trades: ${r.summary.closedTrades} · Net ${fmtSol(r.summary.netPnl)} SOL · PF ${fmtMaybe(r.summary.profitFactor, 2)} · DD ${fmtPct(r.summary.maxDrawdown)}`,
    `Dry-run days covered: ${r.dayCount}`,
    `Best strategy: ${r.bestStrategy ? escapeHtml(r.bestStrategy.strategyId) : '-'}`,
    '',
    ...r.checks.map(c => `${c.passed ? 'OK' : 'MISS'} ${escapeHtml(c.key)}`),
    '',
    'Highest possible recommendation is a small live test; never full live trading.',
  ];
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function sendPositionAudit(chatId) {
  const audit = auditPositions({ repair: true });
  const ids = audit.inconsistent.slice(0, 20).map(row => `#${row.id}: ${row.issues.join(', ')}`).join('\n');
  return bot.sendMessage(chatId, [
    '<b>Position Audit</b>',
    '',
    `Total positions: ${audit.total}`,
    `Open positions: ${audit.open}`,
    `Partially closed: ${audit.partiallyClosed}`,
    `Closed positions: ${audit.closed}`,
    `Failed entries: ${audit.failedEntries}`,
    `Failed exits: ${audit.failedExits}`,
    `Cancelled: ${audit.cancelled}`,
    `Inconsistent records: ${audit.inconsistent.length}`,
    ids ? `\n${escapeHtml(ids)}` : '',
  ].join('\n'), { parse_mode: 'HTML' });
}

async function confirmDryRunReset(chatId) {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM dry_run_positions WHERE execution_mode = 'dry_run') AS positions,
      (SELECT COUNT(*) FROM dry_run_trades WHERE position_id IN (SELECT id FROM dry_run_positions WHERE execution_mode = 'dry_run')) AS trades,
      (SELECT COUNT(*) FROM dryrun_trade_metrics) AS metrics,
      (SELECT COUNT(*) FROM candidates) AS candidates
  `).get();
  dryRunResetConfirmAt = now();
  return bot.sendMessage(chatId, [
    '<b>Dry-run Reset Confirmation</b>',
    '',
    'This will delete:',
    `dry-run positions: ${counts.positions}`,
    `dry-run trade rows: ${counts.trades}`,
    `dry-run metrics: ${counts.metrics}`,
    `candidates: ${counts.candidates}`,
    '',
    'It will not delete strategy config, wallets, settings, env config, or live-mode rows.',
    'Run /dryrun_reset_execute within 5 minutes to proceed.',
  ].join('\n'), { parse_mode: 'HTML' });
}

async function executeDryRunReset(chatId) {
  if (!dryRunResetConfirmAt || now() - dryRunResetConfirmAt > 5 * 60_000) {
    return bot.sendMessage(chatId, 'Run /dryrun_reset_confirm first. Confirmation expires after 5 minutes.');
  }
  db.transaction(() => {
    db.prepare("DELETE FROM dry_run_trades WHERE position_id IN (SELECT id FROM dry_run_positions WHERE execution_mode = 'dry_run')").run();
    db.prepare("DELETE FROM dryrun_trade_metrics WHERE position_id IN (SELECT id FROM dry_run_positions WHERE execution_mode = 'dry_run')").run();
    db.prepare("DELETE FROM tp_sl_rules WHERE position_id IN (SELECT id FROM dry_run_positions WHERE execution_mode = 'dry_run')").run();
    db.prepare("DELETE FROM dry_run_positions WHERE execution_mode = 'dry_run'").run();
    db.prepare('DELETE FROM candidates').run();
    db.prepare('DELETE FROM llm_decisions').run();
    db.prepare('DELETE FROM llm_batches').run();
    db.prepare('DELETE FROM decision_logs').run();
    db.prepare('DELETE FROM risk_events').run();
  })();
  dryRunResetConfirmAt = 0;
  return bot.sendMessage(chatId, 'Dry-run trades/candidates reset complete. Strategy config, wallets, settings, and env config were preserved.');
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'mode', description: 'Show effective trading mode and dry-run lock' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show active dry-run positions' },
    { command: 'open_positions', description: 'Show active positions only' },
    { command: 'closed_positions', description: 'Show closed positions by window' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show gross/net dry-run PnL' },
    { command: 'stats', description: 'Show dry-run performance stats' },
    { command: 'export_trades', description: 'Export dry-run trades CSV' },
    { command: 'export_candidates', description: 'Export candidates CSV' },
    { command: 'export_open_positions', description: 'Export active positions CSV' },
    { command: 'export_closed_positions', description: 'Export closed positions CSV' },
    { command: 'compare_strategies', description: 'Rank strategies by dry-run evidence' },
    { command: 'filter_report', description: 'Analyze filter attribution' },
    { command: 'risk', description: 'Show live-mode risk guardrail state' },
    { command: 'readiness', description: 'Score confirm/live readiness' },
    { command: 'dryrun_reset_confirm', description: 'Preview dry-run reset scope' },
    { command: 'dryrun_reset_execute', description: 'Execute confirmed dry-run reset' },
    { command: 'position_audit', description: 'Audit position status consistency' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => console.log(`[telegram] commands ${telegramErrorText(err)}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${telegramErrorText(err)}`));
}

function telegramErrorText(err) {
  const parts = [
    err?.code,
    err?.response?.statusCode ? `HTTP ${err.response.statusCode}` : null,
    err?.response?.body?.description,
    err?.message,
  ].filter(Boolean);
  if (Array.isArray(err?.errors) && err.errors.length) {
    parts.push(err.errors.map(inner => [inner.code, inner.address, inner.port, inner.message].filter(Boolean).join(' ')).join(' | '));
  }
  return parts.join(': ') || String(err);
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

export async function sendPnl(chatId, query = null) {
  const realized = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0)), 0) AS pnl,
      SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) < 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN COALESCE(realized_pnl_sol, net_pnl_sol, pnl_sol, 0) = 0 THEN 1 ELSE 0 END) AS breakeven
    FROM dry_run_positions
    WHERE status = ?
  `).get(POSITION_STATUS.CLOSED);
  const unrealized = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(unrealized_pnl_sol, pnl_sol, 0)), 0) AS pnl
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)})
  `).get();
  const winRate = Number(realized.count || 0) ? Number(realized.wins || 0) / Number(realized.count) * 100 : 0;
  const separatedText = [
    '<b>REALIZED PNL</b>',
    '',
    `Closed positions: ${realized.count}`,
    `Realized PnL: <b>${fmtSol(realized.pnl)} SOL</b>`,
    `Win rate: ${fmtPct(winRate)} (${realized.wins || 0}W / ${realized.losses || 0}L / ${realized.breakeven || 0}BE)`,
    '',
    '<b>UNREALIZED PNL</b>',
    '',
    `Active positions: ${unrealized.count}`,
    `Unrealized PnL: <b>${fmtSol(unrealized.pnl)} SOL</b>`,
    '',
    '<b>SUMMARY</b>',
    '',
    `Total PnL: <b>${fmtSol(Number(realized.pnl || 0) + Number(unrealized.pnl || 0))} SOL</b>`,
  ].join('\n');
  return query ? editMenuMessage(query, separatedText, navKeyboard()) : bot.sendMessage(chatId, separatedText, { parse_mode: 'HTML' });
  const summary = summarizeTrades('all');
  const dryRunText = [
    '<b>Dry-run PnL</b>',
    '',
    `Closed trades: ${summary.closedTrades}`,
    `Gross PnL: <b>${fmtSol(summary.grossPnl)} SOL</b>`,
    `Net PnL: <b>${fmtSol(summary.netPnl)} SOL</b>`,
    `Win rate: ${fmtPct(summary.winRate)}`,
    `Profit factor: ${fmtMaybe(summary.profitFactor, 2)}`,
    `Expectancy: ${fmtSol(summary.expectancy)} SOL/trade`,
  ].join('\n');
  return query ? editMenuMessage(query, dryRunText, navKeyboard()) : bot.sendMessage(chatId, dryRunText, { parse_mode: 'HTML' });
  const wallets = savedWallets();
  if (!wallets.length) {
    const text = '📊 <b>PnL</b>\n\nNo saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }
  const chunks = [];
  for (const wallet of wallets) {
    const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
    if (!pnl) {
      chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
      continue;
    }
    chunks.push([
      `• <b>${escapeHtml(wallet.label)}</b>`,
      `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
      `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
    ].join('\n'));
  }
  const text = `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`;
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
