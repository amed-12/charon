import { escapeHtml, gmgnLink } from '../../format.js';
import { POSITION_STATUS } from '../../services/positionStatus.js';

const BAR = '━━━━━━━━━━━━━━━━━━';

export function formatOpenPosition(position, options = {}) {
  const view = normalizePosition(position, options);
  const decorations = getPositionDecorations(view);
  const statusNote = statusNoteFor(decorations);
  const tpSuffix = decorations.nearTp ? ' -> dekat target' : '';
  const slSuffix = decorations.nearSl ? ' -> hampir cut loss' : '';

  return [
    `<b>${escapeHtml(decorations.header)}</b>`,
    BAR,
    `📍 <b>${escapeHtml(view.symbol || shortMint(view.mint))}</b> #${view.id}`,
    `🪙 Token: <a href="${gmgnLink(view.mint)}">${escapeHtml(shortMint(view.mint))}</a>`,
    `⚙️ Mode: <b>${escapeHtml(view.executionMode)}</b> · Strategy: <b>${escapeHtml(view.strategyId)}</b>`,
    '',
    '💰 <b>ENTRY</b>',
    `Entry Mcap: ${formatUsd(view.entryMcap)}`,
    `Entry Price: ${formatPrice(view.entryPrice)}`,
    `Size: ${formatSol(view.sizeSol)}`,
    '',
    '📊 <b>CURRENT</b>',
    `Current Mcap: ${formatUsd(view.currentMcap)}`,
    `Current Price: ${formatPrice(view.currentPrice)}`,
    `High Mcap: ${formatUsd(view.highMcap)}`,
    `Low Mcap: ${formatUsd(view.lowMcap)}`,
    `PnL: ${decorations.pnlIcon} ${formatPercent(view.pnlPercent)} (${formatSignedSol(view.pnlSol)})`,
    '',
    '📏 <b>Distance</b>',
    `To TP: ${distanceToTp(view, decorations)}`,
    `To SL: ${distanceToSl(view, decorations)}`,
    '',
    '🎯 <b>EXIT PLAN</b>',
    `TP: 🟢 ${formatPercent(view.tpPercent)}${tpSuffix}`,
    `SL: 🔴 ${formatPercent(view.slPercent)}${slSuffix}`,
    `Trail: 🟡 ${view.trailingEnabled ? formatPercent(view.trailingPercent, { forceSign: false }) : 'off'}`,
    '',
    `📌 Status: <b>${escapeHtml(view.status)}</b> · ${escapeHtml(statusNote)}`,
    `🕒 Updated: ${escapeHtml(view.updatedLabel)} · Data source: ${escapeHtml(view.dataSource)}`,
  ].join('\n');
}

export function formatClosedPosition(position, options = {}) {
  const view = normalizePosition(position, options);
  return [
    '<b>✅ CLOSED POSITION</b>',
    BAR,
    `📍 <b>${escapeHtml(view.symbol || shortMint(view.mint))}</b> #${view.id}`,
    `🪙 Token: <a href="${gmgnLink(view.mint)}">${escapeHtml(shortMint(view.mint))}</a>`,
    `⚙️ Mode: <b>${escapeHtml(view.executionMode)}</b> · Strategy: <b>${escapeHtml(view.strategyId)}</b>`,
    '',
    '💰 <b>TRADE</b>',
    `Entry Mcap: ${formatUsd(view.entryMcap)}`,
    `Entry Price: ${formatPrice(view.entryPrice)}`,
    `Exit Mcap: ${formatUsd(view.exitMcap)}`,
    `Exit Price: ${formatPrice(view.exitPrice)}`,
    `Size: ${formatSol(view.sizeSol)}`,
    '',
    '📊 <b>RESULT</b>',
    `Realized PnL: ${view.pnlPercent >= 0 ? '🟢' : '🔴'} ${formatPercent(view.pnlPercent)} (${formatSignedSol(view.pnlSol)})`,
    `Exit reason: ${escapeHtml(view.exitReason || 'N/A')}`,
    `Hold duration: ${escapeHtml(holdDuration(view.openedAtMs, view.closedAtMs))}`,
  ].join('\n');
}

export function formatPositionList(positions, options = {}) {
  const rows = Array.isArray(positions) ? positions : [];
  if (!rows.length) return options.emptyText || 'No open positions right now.';
  const limit = options.limit || rows.length;
  const body = rows.slice(0, limit).map(row => {
    if (isActive(row.status)) return formatOpenPosition(row, options);
    return formatClosedPosition(row, options);
  }).join('\n\n');
  const more = rows.length > limit ? `\n\n...and ${rows.length - limit} more` : '';
  return `${body}${more}`;
}

export function getPositionDecorations(position) {
  const pnl = numberOr(position.pnlPercent ?? position.unrealized_pnl_percent ?? position.pnl_percent, 0);
  const tp = numberOr(position.tpPercent ?? position.tp_percent, 0);
  const sl = numberOr(position.slPercent ?? position.sl_percent, 0);
  const status = String(position.status || '').toUpperCase();
  const passedTp = tp > 0 && pnl >= tp;
  const passedSl = sl < 0 && pnl <= sl;
  const nearTp = !passedTp && tp > 0 && pnl >= tp * 0.75;
  const nearSl = !passedSl && sl < 0 && pnl <= sl * 0.75;
  const partial = status === POSITION_STATUS.PARTIALLY_CLOSED;

  let header;
  if (partial) header = '🟡 PARTIALLY CLOSED';
  else if (passedTp) header = '🎯 TP ZONE';
  else if (passedSl) header = '🛑 SL ZONE';
  else if (nearTp) header = '🚀 NEAR TAKE PROFIT';
  else if (nearSl) header = '⚠️ RISK ZONE — NEAR STOP LOSS';
  else header = pnl >= 0 ? '🟢 OPEN POSITION' : '🔴 OPEN POSITION';

  return {
    header,
    partial,
    passedTp,
    passedSl,
    nearTp,
    nearSl,
    profitable: pnl > 0,
    losing: pnl < 0,
    pnlIcon: pnl >= 0 ? '🟢' : '🔴',
  };
}

export function normalizePosition(position, options = {}) {
  const currentMcap = firstNumber(
    options.currentMcap,
    position.current_mcap,
    position.currentMcap,
    isActive(position.status) ? null : position.exit_mcap,
  );
  const currentPrice = firstNumber(
    options.currentPrice,
    position.current_price,
    position.currentPrice,
    isActive(position.status) ? null : position.exit_price,
  );
  const entryMcap = firstNumber(position.entry_mcap, position.entryMcap);
  const sizeSol = firstNumber(position.size_sol, position.sizeSol) ?? 0;
  const pnlPercent = firstNumber(
    position.unrealized_pnl_percent,
    position.pnl_percent,
    currentMcap != null && entryMcap ? ((currentMcap / entryMcap) - 1) * 100 : null,
  ) ?? 0;
  const pnlSol = firstNumber(
    position.unrealized_pnl_sol,
    position.realized_pnl_sol,
    position.net_pnl_sol,
    position.pnl_sol,
    sizeSol * pnlPercent / 100,
  ) ?? 0;

  return {
    id: position.id,
    mint: position.mint || '',
    symbol: position.symbol || '',
    status: String(position.status || 'OPEN').toUpperCase(),
    executionMode: position.execution_mode || position.executionMode || 'dry_run',
    strategyId: position.strategy_id || position.strategyId || 'sniper',
    entryPrice: firstNumber(position.entry_price, position.entryPrice),
    currentPrice,
    entryMcap,
    currentMcap,
    highMcap: firstNumber(position.high_water_mcap, position.highMcap, position.current_mcap, position.entry_mcap),
    lowMcap: firstNumber(position.lowest_mcap, position.lowMcap),
    exitPrice: firstNumber(position.exit_price, position.exitPrice),
    exitMcap: firstNumber(position.exit_mcap, position.exitMcap),
    sizeSol,
    pnlPercent,
    pnlSol,
    tpPercent: firstNumber(position.tp_percent, position.tpPercent) ?? 0,
    slPercent: firstNumber(position.sl_percent, position.slPercent) ?? 0,
    trailingEnabled: Boolean(Number(position.trailing_enabled ?? position.trailingEnabled ?? 0)),
    trailingPercent: firstNumber(position.trailing_percent, position.trailingPercent) ?? 0,
    exitReason: position.exit_reason || position.exitReason || '',
    openedAtMs: firstNumber(position.opened_at_ms, position.openedAtMs),
    closedAtMs: firstNumber(position.closed_at_ms, position.closedAtMs),
    updatedLabel: options.updatedLabel || position.updatedLabel || (currentMcap != null || currentPrice != null ? 'monitor snapshot' : 'N/A'),
    dataSource: options.dataSource || position.dataSource || (currentMcap != null || currentPrice != null ? 'monitor' : 'N/A'),
  };
}

export function formatSol(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(4)} SOL` : 'N/A';
}

export function formatSignedSol(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)} SOL`;
}

export function formatPercent(value, { forceSign = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = forceSign && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export function formatUsd(value) {
  if (value == null || value === '') return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'N/A';
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (n >= 0.0000000001) return `$${n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toExponential(4)}`;
}

export function shortMint(mint = '') {
  const value = String(mint || '');
  if (value.length <= 14) return value || 'N/A';
  if (value.endsWith('pump') && value.length > 12) return `${value.slice(0, 6)}...pump`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isActive(status) {
  const value = String(status || '').toUpperCase();
  return value === POSITION_STATUS.OPEN || value === POSITION_STATUS.PARTIALLY_CLOSED;
}

function distanceToTp(view, decorations) {
  const distance = Number(view.tpPercent) - Number(view.pnlPercent);
  if (!Number.isFinite(distance)) return 'N/A';
  return decorations.nearTp || decorations.passedTp
    ? `${formatPercent(Math.max(0, distance), { forceSign: false })} away`
    : formatPercent(distance, { forceSign: false });
}

function distanceToSl(view, decorations) {
  const distance = Number(view.pnlPercent) - Number(view.slPercent);
  if (!Number.isFinite(distance)) return 'N/A';
  return decorations.nearSl || decorations.passedSl
    ? `${formatPercent(Math.max(0, distance), { forceSign: false })} away`
    : formatPercent(distance, { forceSign: false });
}

function statusNoteFor(decorations) {
  if (decorations.partial) return 'Sebagian posisi sudah closed';
  if (decorations.passedTp) return 'Sudah masuk zona TP';
  if (decorations.passedSl) return 'Sudah masuk zona SL';
  if (decorations.nearTp) return 'Hampir TP';
  if (decorations.nearSl) return 'Mendekati SL';
  return 'Belum menyentuh TP/SL';
}

function holdDuration(openedAtMs, closedAtMs) {
  const opened = Number(openedAtMs || 0);
  const closed = Number(closedAtMs || Date.now());
  if (!opened) return 'N/A';
  const minutes = Math.max(0, Math.round((closed - opened) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
