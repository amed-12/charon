import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { strictJsonFromText } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { chatSystemPrompt } from './systemPrompt.js';
import { availableToolNames } from './toolRegistry.js';

export async function parseIntent({ message, context = {} }) {
  if (ENABLE_LLM && LLM_API_KEY) {
    try {
      const plan = await parseWithLlm(message, context);
      return normalizePlan(plan);
    } catch (err) {
      console.log(`[chat-agent] LLM intent parse failed: ${err.message}`);
    }
  }
  return heuristicPlan(message);
}

export function heuristicPlan(message = '') {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const window = parseWindow(lower);
  const strategyId = parseStrategy(lower) || activeStrategy().id;
  const mint = parseMint(text);
  const positionId = parsePositionId(lower);

  if (/\b(export|csv)\b/.test(lower) && /open/.test(lower)) {
    return plan('export_open_positions', 'Export active positions.', [{ tool: 'export_open_positions', args: {} }]);
  }
  if (/\b(export|csv)\b/.test(lower) && /(closed|close|selesai)/.test(lower)) {
    return plan('export_closed_positions', `Export closed positions for ${window}.`, [{ tool: 'export_closed_positions', args: { window } }]);
  }
  if (/\b(export|csv)\b/.test(lower)) {
    return plan('export_trades', `Export trades for ${window}.`, [{ tool: 'export_trades', args: { window } }]);
  }
  if (/\b(stats|performance|performa|ringkasan|summary)\b/.test(lower)) {
    return plan('generate_stats', `Show performance summary for ${window}.`, [{ tool: 'generate_stats', args: { window } }]);
  }
  if (/\b(compare|banding|strateg)\b/.test(lower)) {
    return plan('compare_strategies', `Compare strategies for ${window}.`, [{ tool: 'compare_strategies', args: { window } }]);
  }
  if (/\b(pnl|profit|loss|untung|rugi)\b/.test(lower) && !/\b(close|tutup)\b/.test(lower)) {
    return plan('ask_pnl', 'Check realized and unrealized PnL.', [{ tool: 'get_pnl', args: { window } }]);
  }
  if (/\b(position|positions|posisi|open)\b/.test(lower) && !/\b(close|tutup|export)\b/.test(lower)) {
    return plan('ask_positions', 'Show active positions.', [{ tool: 'get_open_positions', args: {} }]);
  }
  if (/\b(closed|close positions|posisi selesai)\b/.test(lower) && !/\b(close all|tutup semua)\b/.test(lower)) {
    return plan('ask_positions', `Show closed positions for ${window}.`, [{ tool: 'get_closed_positions', args: { window } }]);
  }
  if (/\b(risk|risiko|guard|guardrail)\b/.test(lower)) {
    return plan('ask_risk', 'Check risk guardrail status.', [{ tool: 'get_risk_status', args: {} }]);
  }
  if (/\b(lesson|lessons|pelajaran|learn)\b/.test(lower)) {
    return plan('ask_lessons', 'Show recent lessons.', [{ tool: 'get_lessons', args: { window } }]);
  }
  if (/\b(decision|decisions|keputusan|why|kenapa)\b/.test(lower)) {
    const calls = mint
      ? [{ tool: 'get_position_by_symbol_or_mint', args: { query: mint } }, { tool: 'get_recent_decisions', args: { limit: 8 } }]
      : [{ tool: 'get_recent_decisions', args: { limit: 8 } }];
    return plan('ask_recent_decisions', 'Look up recent Charon decisions.', calls);
  }
  if (mint && isOnlyMint(text)) {
    return plan('fallback_chat', 'Token address detected. Ask whether to analyze it with GMGN.', [], false, 'Saya lihat itu CA/token mint. Mau saya analisa pakai data GMGN fresh?');
  }
  if (/\b(analyze|analisa|analisis|cek|check|ca|token)\b/.test(lower) && mint) {
    return plan('analyze_candidate', `Analyze ${mint} with fresh GMGN token detail.`, [{ tool: 'analyze_candidate', args: { mint, forceFresh: true } }]);
  }
  if (/\b(mulai dry|dry run|dry-run)\b/.test(lower)) {
    return plan('update_mode', 'Switch requested mode to dry_run.', [{ tool: 'set_mode', args: { mode: 'dry_run' } }], true);
  }
  if (/\b(go live|live mode|confirm mode)\b/.test(lower)) {
    const mode = /confirm mode/.test(lower) ? 'confirm' : 'live';
    return plan('update_mode', `Request mode change to ${mode}.`, [{ tool: 'set_mode', args: { mode } }], true);
  }
  if (/\b(set|ubah|ganti)\b/.test(lower) && /size|position_size|sol/.test(lower)) {
    const value = parseNumber(lower);
    if (value != null) {
      return plan('update_strategy_param', `Set ${strategyId} position size to ${value} SOL.`, [
        { tool: 'set_strategy_param', args: { strategyId, key: 'position_size_sol', value } },
      ], true);
    }
  }
  if (/\b(top holder|top20|holder)\b/.test(lower) && /\b(jangan|block|above|atas|max|lebih)\b/.test(lower)) {
    const value = parseNumber(lower);
    if (value != null) {
      return plan('update_strategy_param', `Set ${strategyId} top20 holder cap to ${value}%.`, [
        { tool: 'set_strategy_param', args: { strategyId, key: 'max_top20_holder_percent', value } },
      ], true);
    }
  }
  if (/\b(remember|ingat)\b/.test(lower)) {
    const value = text.replace(/^\/?remember\s*/i, '').replace(/^ingat\s*/i, '').trim();
    return plan('remember_user_preference', 'Save this preference.', [
      { tool: 'save_chat_memory', args: { key: `note:${Date.now()}`, value, scope: 'chat' } },
    ], false);
  }
  if (/\b(forget|lupakan)\b/.test(lower)) {
    const key = text.split(/\s+/).slice(1).join(' ').trim();
    return plan('forget_user_preference', `Forget ${key}.`, [{ tool: 'forget_memory', args: { key } }], true);
  }
  if (/\b(close all|tutup semua)\b/.test(lower)) {
    return plan('close_all_positions', 'Close all active dry-run positions.', [
      { tool: 'close_all_positions', args: { reason: 'CHAT_CLOSE_ALL' } },
    ], true);
  }
  if (/\b(close|tutup)\b/.test(lower) && positionId != null) {
    return plan('close_position', `Close position #${positionId}.`, [
      { tool: 'close_position', args: { positionId, reason: 'CHAT_CLOSE' } },
    ], true);
  }

  return plan('ask_status', 'Show current Charon status.', [{ tool: 'get_status', args: {} }]);
}

async function parseWithLlm(message, context) {
  const prompt = [
    `Available tools: ${availableToolNames().join(', ')}`,
    '',
    'Current context JSON:',
    JSON.stringify(context).slice(0, 12000),
    '',
    `User message: ${message}`,
  ].join('\n');
  const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: chatSystemPrompt() },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
  }, {
    timeout: LLM_TIMEOUT_MS,
    headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
  });
  return strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
}

function normalizePlan(raw) {
  const toolNames = new Set(availableToolNames());
  const calls = Array.isArray(raw?.tool_calls) ? raw.tool_calls : [];
  return {
    intent: raw?.intent || 'fallback_chat',
    confidence: Number(raw?.confidence || 0),
    requires_confirmation: Boolean(raw?.requires_confirmation),
    summary: String(raw?.summary || 'I can help with that.'),
    user_response_style: raw?.user_response_style === 'detailed' ? 'detailed' : 'short',
    tool_calls: calls
      .filter(call => call && toolNames.has(call.tool))
      .map(call => ({ tool: call.tool, args: call.args || {} })),
  };
}

function plan(intent, summary, toolCalls, requiresConfirmation = false, reply = '') {
  return {
    intent,
    confidence: 70,
    requires_confirmation: requiresConfirmation,
    summary,
    user_response_style: 'short',
    tool_calls: toolCalls,
    reply,
  };
}

function parseWindow(text) {
  if (/\ball\b/.test(text)) return 'all';
  const match = text.match(/\b(\d+)\s*(m|h|d)\b/);
  return match ? `${match[1]}${match[2]}` : '24h';
}

function parseStrategy(text) {
  return ['smart_money', 'dip_buy', 'sniper', 'degen'].find(id => text.includes(id));
}

function parseMint(text) {
  return text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/)?.[0] || null;
}

function isOnlyMint(text) {
  const mint = parseMint(text);
  return mint && String(text || '').trim() === mint;
}

function parseNumber(text) {
  const match = text.match(/(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parsePositionId(text) {
  const match = text.match(/(?:#|position\s+|posisi\s+)(\d+)/i);
  return match ? Number(match[1]) : null;
}
