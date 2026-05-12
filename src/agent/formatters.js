import { escapeHtml, fmtPct, fmtSol, short } from '../format.js';
import { formatPositionList } from '../telegram/formatters/positionFormatter.js';

const variants = new Map();

export function formatPositionsReply(data = {}, language = 'id') {
  const rows = data.openPositions || [];
  if (!rows.length) {
    return pick(language, 'no_positions', [
      'Belum ada posisi open sekarang. Aman, belum ada trade yang perlu dipantau.',
      'Saat ini tidak ada posisi yang sedang berjalan.',
      'Belum ada open position. Jadi PnL sementara masih bergantung dari trade yang sudah closed.',
    ], [
      'No open positions right now. Nothing needs monitoring.',
      'There are no running positions at the moment.',
      'No open positions yet. Current PnL depends only on closed trades.',
    ]);
  }
  const lines = formatPositionList(rows, { limit: 5 });
  const worst = rows.reduce((min, row) => Number(row.unrealized_pnl_percent ?? 0) < Number(min.unrealized_pnl_percent ?? 0) ? row : min, rows[0]);
  const watch = worst && Number(worst.unrealized_pnl_percent ?? 0) < 0
    ? (language === 'id'
      ? `\n\nYang paling perlu diawasi: ${escapeHtml(worst.symbol || short(worst.mint))}.`
      : `\n\nWatch ${escapeHtml(worst.symbol || short(worst.mint))} closest.`)
    : '';
  return language === 'id'
    ? `Posisi open saat ini ada ${rows.length}:\n\n${lines}${watch}`
    : `You have ${rows.length} open position${rows.length === 1 ? '' : 's'}:\n\n${lines}${watch}`;
}

export function formatPnlReply(data = {}, language = 'id') {
  const realized = Number(data.realized ?? data.realizedPnl ?? 0);
  const unrealized = Number(data.unrealized ?? data.unrealizedPnl ?? 0);
  const total = Number(data.total ?? realized + unrealized);
  const winRate = data.winRate == null ? null : Number(data.winRate);
  const lines = language === 'id'
    ? [
      'PnL 24 jam terakhir:',
      `Realized: ${fmtSol(realized)} SOL`,
      `Unrealized: ${fmtSol(unrealized)} SOL`,
      `Total sementara: ${fmtSol(total)} SOL`,
      '',
      winRate == null ? 'Win rate saya hitung dari posisi yang sudah closed saja.' : `Win rate closed trade: ${fmtPct(winRate)}.`,
    ]
    : [
      'PnL over the last 24h:',
      `Realized: ${fmtSol(realized)} SOL`,
      `Unrealized: ${fmtSol(unrealized)} SOL`,
      `Running total: ${fmtSol(total)} SOL`,
      '',
      winRate == null ? 'Win rate is counted from closed positions only.' : `Closed-trade win rate: ${fmtPct(winRate)}.`,
    ];
  return lines.join('\n');
}

export function formatStatusReply(data = {}, language = 'id') {
  const mode = data.mode || {};
  const strategy = data.activeStrategy?.id || data.strategy || '?';
  const count = Number(data.openCount ?? data.openPositions?.length ?? 0);
  return language === 'id'
    ? `Sekarang bot di mode ${mode.effective || data.effectiveMode || 'dry_run'}. ${mode.dryRunLock ?? data.dryRunLock ? 'DRY_RUN_LOCK masih aktif, jadi live trade tidak bisa jalan.' : 'Dry-run lock tidak aktif.'}\n\nStrategi aktif: ${strategy}\nPosisi open: ${count}`
    : `The bot is in ${mode.effective || data.effectiveMode || 'dry_run'} mode. ${mode.dryRunLock ?? data.dryRunLock ? 'DRY_RUN_LOCK is active, so live trading cannot run.' : 'Dry-run lock is not active.'}\n\nActive strategy: ${strategy}\nOpen positions: ${count}`;
}

export function formatStrategyReply(data = {}, language = 'id') {
  const strategy = data.activeStrategy?.id || data.strategy || '?';
  const avoidsDegen = JSON.stringify(data.memories || data.preferences || []).toLowerCase().includes('degen');
  return language === 'id'
    ? `Strategi aktif sekarang: ${strategy}.${avoidsDegen && strategy !== 'degen' ? '\n\nIni sesuai preferensi kamu untuk menghindari degen kecuali diminta.' : ''}`
    : `Current active strategy: ${strategy}.${avoidsDegen && strategy !== 'degen' ? '\n\nThat matches your preference to avoid degen unless explicitly requested.' : ''}`;
}

export function formatMemoryReply(data = {}, language = 'id') {
  if (data.saved) return language === 'id' ? 'Siap, saya simpan preferensi itu.' : 'Got it, I saved that preference.';
  const rows = data.preferences || [];
  if (!rows.length) return language === 'id' ? 'Belum ada preferensi yang tersimpan.' : 'No saved preferences yet.';
  return rows.slice(0, 10).map(row => `- ${escapeHtml(row.key)}: ${escapeHtml(row.value)}`).join('\n');
}

export function formatQueueReply(data = {}, language = 'id') {
  const active = data.active;
  const age = active?.createdAt ? `${Math.round((Date.now() - active.createdAt) / 1000)}s` : '-';
  if (language === 'id') {
    return [
      'Status antrian agent:',
      `Aktif: ${active ? `${active.id} (${active.status}, ${age})` : 'tidak ada'}`,
      `Pending: ${data.pendingCount || 0}`,
      `Terakhir selesai: ${data.lastCompleted?.summary || '-'}`,
      `Gagal 1 jam terakhir: ${data.failedLastHour?.length || 0}`,
    ].join('\n');
  }
  return [
    'Agent queue:',
    `Active: ${active ? `${active.id} (${active.status}, ${age})` : 'none'}`,
    `Pending: ${data.pendingCount || 0}`,
    `Last completed: ${data.lastCompleted?.summary || '-'}`,
    `Failed in last hour: ${data.failedLastHour?.length || 0}`,
  ].join('\n');
}

export function formatErrorReply(error, language = 'id') {
  return language === 'id'
    ? `Ada yang gagal sebentar: ${escapeHtml(error || 'error tidak diketahui')}`
    : `Something failed for a moment: ${escapeHtml(error || 'unknown error')}`;
}

export function formatConfirmationReply(plan, language = 'id', mode = 'dry_run', dryRunLock = true) {
  const action = plan.intent === 'close_all_positions' ? 'Close semua posisi' : plan.summary || plan.intent;
  if (language === 'id') {
    return [
      'Ini aksi trading, jadi saya butuh konfirmasi dulu.',
      '',
      `Action: ${escapeHtml(action)}`,
      `Mode: ${mode}`,
      `Risk: posisi akan dianggap keluar`,
      dryRunLock ? 'DRY_RUN_LOCK masih aktif, jadi ini hanya bisa disimulasikan. Mau lanjut simulasi?' : 'Lanjutkan?',
    ].join('\n');
  }
  return [
    'This is a trading action, so I need confirmation first.',
    '',
    `Action: ${escapeHtml(action)}`,
    `Mode: ${mode}`,
    'Risk: the position will be treated as exited',
    dryRunLock ? 'DRY_RUN_LOCK is active, so this can only be simulated. Continue simulation?' : 'Continue?',
  ].join('\n');
}

function pick(language, key, idOptions, enOptions) {
  const options = language === 'id' ? idOptions : enOptions;
  const index = variants.get(key) || 0;
  variants.set(key, index + 1);
  return options[index % options.length];
}
