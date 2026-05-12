import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS, DRY_RUN_LOCK } from '../config.js';
import { escapeHtml, fmtPct, fmtSol, short } from '../format.js';
import { boolSetting } from '../db/settings.js';
import { buildResponderPrompt } from './prompt.js';
import { agentPerf } from './queue.js';
import {
  formatConfirmationReply as formatConfirmation,
  formatErrorReply as formatError,
  formatMemoryReply as formatMemory,
  formatPnlReply as formatPnl,
  formatPositionsReply as formatPositions,
  formatQueueReply as formatQueue,
  formatStatusReply as formatStatus,
  formatStrategyReply as formatStrategy,
} from './formatters.js';

export async function generateNaturalReply({
  userMessage,
  plan,
  toolResults,
  state,
  memories = [],
  lessons = [],
  language = detectUserLanguage(userMessage),
  debug = false,
}) {
  if (plan.intent === 'analyze_candidate') {
    return appendDebug(fallbackReply({ userMessage, plan, toolResults, state, memories, language }), plan, debug);
  }
  if (!debug && plan.intent === 'fallback_chat' && looksLikeJson(outputText(toolResults))) {
    return appendDebug(fallbackReply({ userMessage, plan, toolResults, state, memories, language }), plan, debug);
  }
  const llm = await responderWithLlm({ userMessage, plan, toolResults, state, memories, lessons, language });
  if (!llm) agentPerf.fallbackFormatterCount += 1;
  const body = llm || fallbackReply({ userMessage, plan, toolResults, state, memories, language });
  return appendDebug(body, plan, debug);
}

export function detectUserLanguage(text = '') {
  const lower = String(text).toLowerCase();
  const idMarkers = ['saya', 'kamu', 'posisi', 'berapa', 'sekarang', 'jangan', 'tolong', 'kenapa', 'rugi', 'untung', 'ingat', 'close semua', 'strategi'];
  const enMarkers = ['what', 'why', 'show', 'check', 'position', 'profit', 'loss', 'remember', 'close', 'strategy'];
  const idScore = idMarkers.filter(marker => lower.includes(marker)).length;
  const enScore = enMarkers.filter(marker => lower.includes(marker)).length;
  if (idScore >= enScore && idScore > 0) return 'id';
  if (enScore > 0) return 'en';
  return 'id';
}

export function formatPositionsReply(toolResults, language = 'id', state = {}) {
  return formatPositions({ openPositions: state.openPositions || [] }, language);
  /*
  const rows = state.openPositions || [];
  if (!rows.length) {
    return language === 'id'
      ? 'Belum ada posisi open saat ini. Bot masih aman, tidak ada trade yang sedang berjalan.'
      : 'No open positions right now. Nothing is currently running.';
  }
  const lines = rows.slice(0, 5).map((row, index) => {
    const symbol = row.symbol || short(row.mint);
    const pnl = Number(row.unrealized_pnl_percent ?? row.pnl_percent ?? 0);
    const status = row.status || 'OPEN';
    const hold = holdMinutes(row.opened_at_ms);
    return `${index + 1}. ${escapeHtml(symbol)} - ${fmtPct(pnl)}, ${status}${hold ? `, ${hold}` : ''}`;
  });
  const worst = rows.reduce((min, row) => Number(row.unrealized_pnl_percent ?? 0) < Number(min.unrealized_pnl_percent ?? 0) ? row : min, rows[0]);
  const warning = worst && Number(worst.unrealized_pnl_percent ?? 0) < 0
    ? (language === 'id'
      ? `\n\nYang paling perlu diawasi: ${escapeHtml(worst.symbol || short(worst.mint))}, karena PnL-nya paling lemah.`
      : `\n\nWatch ${escapeHtml(worst.symbol || short(worst.mint))} closest, since it has the weakest PnL.`)
    : '';
  return language === 'id'
    ? `Posisi open sekarang ada ${rows.length}:\n\n${lines.join('\n')}${warning}`
    : `You have ${rows.length} open position${rows.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}${warning}`;
  */
}

export function formatPnlReply(toolResults, language = 'id') {
  const parsed = parsePnlOutput(outputText(toolResults));
  return formatPnl(parsed, language);
  /*
  const text = outputText(toolResults);
  const realized = matchNumber(text, /Realized:\s*([+-]?\d+(?:\.\d+)?)/i);
  const unrealized = matchNumber(text, /Unrealized:\s*([+-]?\d+(?:\.\d+)?)/i);
  const total = matchNumber(text, /Total:\s*([+-]?\d+(?:\.\d+)?)/i);
  if (realized == null && unrealized == null && total == null) {
    return language === 'id'
      ? `Saya belum bisa membaca PnL dari data saat ini.\n\n${escapeHtml(text || 'Belum ada data PnL.')}`
      : `I could not read PnL from the current data.\n\n${escapeHtml(text || 'No PnL data yet.')}`;
  }
  return language === 'id'
    ? [
      'PnL saat ini:',
      `Realized: ${fmtSol(realized || 0)} SOL`,
      `Unrealized: ${fmtSol(unrealized || 0)} SOL`,
      `Total sementara: ${fmtSol(total || 0)} SOL`,
      '',
      'Win rate dihitung dari posisi yang sudah closed saja.',
    ].join('\n')
    : [
      'Current PnL:',
      `Realized: ${fmtSol(realized || 0)} SOL`,
      `Unrealized: ${fmtSol(unrealized || 0)} SOL`,
      `Running total: ${fmtSol(total || 0)} SOL`,
      '',
      'Win rate is based only on closed positions.',
    ].join('\n');
  */
}

export function formatStatusReply(toolResults, language = 'id', state = {}) {
  return formatStatus(state, language);
}

export function formatMemoryReply(toolResults, language = 'id') {
  const text = outputText(toolResults);
  if (/remembered|saved|disimpan/i.test(text)) {
    return language === 'id'
      ? 'Siap, saya simpan preferensi itu.'
      : 'Got it, I saved that preference.';
  }
  return language === 'id'
    ? `Ini memori yang tersimpan:\n\n${escapeHtml(text || 'Belum ada memori.')}`
    : `Saved memory:\n\n${escapeHtml(text || 'No memory saved yet.')}`;
}

export function formatConfirmationReply(plan, language = 'id') {
  return formatConfirmation(plan, language, 'dry_run', DRY_RUN_LOCK);
}

export function formatErrorReply(error, language = 'id') {
  return formatError(error, language);
}

function fallbackReply({ plan, toolResults, state, memories, language }) {
  const failed = toolResults.outputs?.find(item => !item.ok);
  if (failed && plan.intent === 'analyze_candidate') return formatGmgnFailure(failed.result, language);
  if (failed) return formatErrorReply(failed.result, language);
  if (plan.requires_confirmation) return formatConfirmationReply(plan, language);
  if (plan.intent === 'ask_positions') return formatPositionsReply(toolResults, language, state);
  if (plan.intent === 'ask_pnl') return formatPnlReply(toolResults, language);
  if (plan.intent === 'ask_status') return formatStatusReply(toolResults, language, state);
  if (plan.intent === 'ask_queue') return formatQueue(firstObjectResult(toolResults) || {}, language);
  if (plan.intent === 'ask_risk') return formatRiskReply(toolResults, language);
  if (plan.intent === 'remember_user_preference') return formatMemoryReply(toolResults, language);
  if (plan.intent === 'ask_strategy') return formatStrategyReply(state, memories, language);
  if (plan.intent === 'ask_lessons') return formatLessonsReply(toolResults, language);
  if (plan.intent === 'ask_trade_reason') return formatReasonReply(toolResults, language);
  if (plan.intent === 'analyze_candidate') return formatTokenAnalysisReply(toolResults, language);
  if (plan.intent.startsWith('export_')) return formatExportReply(toolResults, language);
  if (plan.reply) return escapeHtml(plan.reply);
  const text = outputText(toolResults);
  if (text) {
    const safe = safeVisibleText(text, language);
    return language === 'id' ? `Saya cek ya:\n\n${safe}` : `I checked:\n\n${safe}`;
  }
  return language === 'id'
    ? 'Saya belum cukup yakin memahami instruksinya. Bisa tulis lebih spesifik?'
    : 'I am not fully sure what you want me to do. Can you be a bit more specific?';
}

function formatGmgnFailure(error, language) {
  const reason = String(error || '').split(':')[0].slice(0, 80) || 'fetch failed';
  return language === 'id'
    ? `Saya belum berhasil ambil data GMGN untuk token ini. Bisa coba refresh atau kirim ulang CA.\n\nReason: ${escapeHtml(reason)}`
    : `I could not fetch GMGN data for this token yet. Try refresh or resend the CA.\n\nReason: ${escapeHtml(reason)}`;
}

function formatTokenAnalysisReply(toolResults, language) {
  const text = outputText(toolResults);
  if (!text) {
    return language === 'id'
      ? 'Saya belum berhasil ambil data GMGN untuk token ini. Bisa coba refresh atau kirim ulang CA.'
      : 'I could not fetch GMGN data for this token yet. Try refresh or resend the CA.';
  }
  return text;
}

function formatRiskReply(toolResults, language) {
  const parsed = firstJsonResult(toolResults);
  if (!parsed) {
    return language === 'id'
      ? `Saya belum bisa membaca status risk dengan rapi, tapi datanya tersedia untuk dicek lewat /risk.`
      : `I could not read the risk status cleanly, but the data is available through /risk.`;
  }
  const allowed = parsed.allowed ?? parsed.canTakeNextTrade ?? parsed.can_trade;
  const reasons = parsed.reasons || parsed.blockReasons || parsed.blocks || [];
  if (language === 'id') {
    return [
      `Status risk: ${allowed === false ? 'belum aman untuk entry baru' : 'tidak ada blok utama saat ini'}.`,
      Array.isArray(reasons) && reasons.length ? `Catatan: ${reasons.slice(0, 3).join('; ')}` : null,
    ].filter(Boolean).join('\n');
  }
  return [
    `Risk status: ${allowed === false ? 'not clear for a new entry yet' : 'no major block right now'}.`,
    Array.isArray(reasons) && reasons.length ? `Notes: ${reasons.slice(0, 3).join('; ')}` : null,
  ].filter(Boolean).join('\n');
}

function formatStrategyReply(state, memories, language) {
  return formatStrategy({ ...state, memories }, language);
}

function formatLessonsReply(toolResults, language) {
  const lines = outputText(toolResults).split('\n').filter(Boolean).slice(0, 3);
  if (!lines.length) return language === 'id' ? 'Belum ada lesson yang cukup berguna.' : 'No useful lessons yet.';
  return language === 'id'
    ? `Pelajaran terbaru:\n\n${escapeHtml(lines.join('\n\n'))}`
    : `Latest lessons:\n\n${escapeHtml(lines.join('\n\n'))}`;
}

function formatReasonReply(toolResults, language) {
  const text = outputText(toolResults);
  return language === 'id'
    ? `Ini yang saya temukan dari decision log:\n\n${escapeHtml(text || 'Belum ada alasan yang tercatat.')}`
    : `Here is what I found in the decision log:\n\n${escapeHtml(text || 'No recorded reason yet.')}`;
}

function formatExportReply(toolResults, language) {
  const first = toolResults.outputs?.[0]?.result;
  const rowCount = typeof first === 'object' ? first.rowCount : null;
  return language === 'id'
    ? `CSV sudah dibuat${rowCount != null ? ` (${rowCount} baris)` : ''}. Saya juga kirim filenya ke Telegram.`
    : `CSV is ready${rowCount != null ? ` (${rowCount} rows)` : ''}. I also sent the file to Telegram.`;
}

async function responderWithLlm({ userMessage, plan, toolResults, state, memories, lessons, language }) {
  const apiKey = LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
  if ((!ENABLE_LLM && !process.env.OPENROUTER_API_KEY) || !apiKey) return null;
  agentPerf.responderCalls += 1;
  const baseUrl = process.env.OPENROUTER_API_KEY && !LLM_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : LLM_BASE_URL.replace(/\/$/, '');
  const res = await axios.post(`${baseUrl}/chat/completions`, {
    model: process.env.CHAT_AGENT_MODEL || LLM_MODEL,
    messages: [
      { role: 'system', content: buildResponderPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          userMessage,
          language,
          plan,
          toolResults: safeToolResults(toolResults),
          state: slimState(state),
          memories,
          lessons,
        }, null, 2),
      },
    ],
    temperature: Number(process.env.CHAT_AGENT_TEMPERATURE || 0.2),
  }, {
    timeout: Math.min(LLM_TIMEOUT_MS, 6000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  }).catch(() => null);
  const text = res?.data?.choices?.[0]?.message?.content?.trim();
  const clean = stripRawJson(text);
  return clean ? escapeHtml(clean).slice(0, 3500) : null;
}

function appendDebug(body, plan, debug) {
  if (!debug && !boolSetting('chat_debug', false)) return body;
  const tools = (plan.tool_calls || []).map(call => call.tool).join(', ') || 'none';
  return [
    body,
    '',
    '---',
    'Debug:',
    `Intent: ${plan.intent}`,
    `Confidence: ${plan.confidence}`,
    `Tools: ${tools}`,
  ].join('\n');
}

function outputText(toolResults) {
  return (toolResults.outputs || [])
    .map(item => typeof item.result === 'string' ? item.result : JSON.stringify(item.result))
    .join('\n')
    .trim();
}

function firstObjectResult(toolResults) {
  return (toolResults.outputs || []).find(item => item.result && typeof item.result === 'object')?.result;
}

function firstJsonResult(toolResults) {
  for (const item of toolResults.outputs || []) {
    if (item.result && typeof item.result === 'object') return item.result;
    if (typeof item.result === 'string') {
      try {
        return JSON.parse(item.result);
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function safeVisibleText(text, language) {
  const raw = String(text || '').trim();
  if (looksLikeJson(raw)) {
    return language === 'id'
      ? 'Datanya tersedia, tapi saya tidak akan menampilkan JSON mentah di chat. Aktifkan /chat_debug on kalau kamu mau lihat detail internalnya.'
      : 'The data is available, but I will not show raw JSON in chat. Turn /chat_debug on if you want internal details.';
  }
  return escapeHtml(raw).slice(0, 2500);
}

function looksLikeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) return true;
  return /"tool_calls"\s*:|"intent"\s*:|"args"\s*:/.test(raw);
}

function matchNumber(text, regex) {
  const match = String(text || '').match(regex);
  return match ? Number(match[1]) : null;
}

function parsePnlOutput(text) {
  const realized = matchNumber(text, /Realized:\s*([+-]?\d+(?:\.\d+)?)/i);
  const unrealized = matchNumber(text, /Unrealized:\s*([+-]?\d+(?:\.\d+)?)/i);
  const total = matchNumber(text, /Total:\s*([+-]?\d+(?:\.\d+)?)/i);
  return {
    realized: realized || 0,
    unrealized: unrealized || 0,
    total: total ?? (Number(realized || 0) + Number(unrealized || 0)),
  };
}

function holdMinutes(openedAtMs) {
  const opened = Number(openedAtMs || 0);
  if (!opened) return '';
  const minutes = Math.max(0, Math.round((Date.now() - opened) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function safeToolResults(toolResults) {
  return {
    outputs: (toolResults.outputs || []).map(item => ({
      tool: item.call?.tool,
      ok: item.ok,
      result: typeof item.result === 'string' ? item.result.slice(0, 1500) : item.result,
    })),
  };
}

function slimState(state) {
  return {
    mode: state.mode,
    activeStrategy: state.activeStrategy?.id,
    openPositions: state.openPositions?.slice(0, 5),
    pnl: state.pnl,
    risk: state.risk,
  };
}

function stripRawJson(text) {
  const clean = String(text || '').replace(/```(?:json)?[\s\S]*?```/gi, '').trim();
  return looksLikeJson(clean) ? '' : clean;
}
