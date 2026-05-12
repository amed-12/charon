import { activeStrategy } from '../db/settings.js';

const TRADE_WORDS = /\b(buy|sell|close|tutup|jual|beli|go live|live|increase size|disable risk|disable dry run lock)\b/i;

export function routeFastIntent(message = '') {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const language = detectFastLanguage(text);

  if (!text) return miss(language);
  const mint = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/)?.[0] || null;
  if (mint && text === mint) {
    return hit('fallback_chat', [], language, 95, false, false, language === 'id'
      ? 'Saya lihat itu CA/token mint. Mau saya analisa pakai data GMGN fresh?'
      : 'That looks like a token mint. Do you want me to analyze it with fresh GMGN data?');
  }
  if (mint && /\b(analyze|analisa|analisis|cek|check|ca|token)\b/i.test(lower)) {
    return hit('analyze_candidate', [{ tool: 'analyze_candidate', args: { mint, forceFresh: true } }], language, 96);
  }
  if (/disable\s+dry\s+run\s+lock|matikan\s+dry\s+run\s+lock/i.test(lower)) {
    return hit('blocked_safety_request', [], language, 100, true);
  }
  if (TRADE_WORDS.test(lower)) {
    if (/\b(close all|close semua|tutup semua)\b/i.test(lower)) {
      return hit('close_all_positions', [{ tool: 'close_all_positions', args: { reason: 'CHAT_CLOSE_ALL' } }], language, 95, true);
    }
    return miss(language, true);
  }
  if (/\b(cek posisi|posisi saya|ada posisi|open position|check positions|show positions|open positions)\b/i.test(lower)) {
    return hit('ask_positions', [{ tool: 'get_open_positions', args: {} }], language, 96);
  }
  if (/\b(pnl|profit|loss|rugi|untung|berapa pnl)\b/i.test(lower)) {
    return hit('ask_pnl', [{ tool: 'get_pnl', args: { window: '24h' } }], language, 95);
  }
  if (/\b(mode|status bot|bot aktif|status)\b/i.test(lower)) {
    return hit('ask_status', [{ tool: 'get_status', args: {} }], language, 94);
  }
  if (/\b(strategi|strategy|pakai strategi apa|what strategy)\b/i.test(lower)) {
    return hit('ask_strategy', [{ tool: 'get_active_strategy', args: {} }], language, 92);
  }
  if (/\b(memory|apa yang kamu ingat)\b/i.test(lower)) {
    return hit('ask_memory', [{ tool: 'get_memory', args: {} }], language, 90);
  }
  if (/^(ingat|remember)\b/i.test(lower)) {
    const value = text.replace(/^(ingat|remember)\b[,:\s]*/i, '').trim();
    return hit('remember_user_preference', [{
      tool: 'remember_user_preference',
      args: { key: `preference:${Date.now()}`, value: value || text, scope: 'chat' },
    }], language, 95);
  }
  if (/\b(kenapa|why)\b/i.test(lower)) {
    return hit('ask_trade_reason', [{ tool: 'get_recent_decisions', args: { limit: 8 } }], language, 78);
  }
  if (/\b(queue|antrian|progress)\b/i.test(lower)) {
    return hit('ask_queue', [{ tool: 'get_queue_status', args: {} }], language, 96);
  }

  return miss(language);
}

export function repairIntent(userMessage, plan) {
  const routed = routeFastIntent(userMessage);
  if (routed.blocked) {
    return {
      intent: 'fallback_chat',
      confidence: 100,
      requires_confirmation: false,
      summary: 'Blocked safety request.',
      reply: routed.language === 'id' ? 'Saya tidak bisa menonaktifkan dry-run lock dari Telegram.' : 'I cannot disable dry-run lock from Telegram.',
      tool_calls: [],
      blocked: true,
    };
  }
  const lower = String(userMessage || '').toLowerCase();
  if (routed.confidence >= 90 && (!plan || plan.intent === 'fallback_chat' || !plan.tool_calls?.length)) {
    return routeToPlan(routed);
  }
  if (/\b(close|sell|buy|tutup|jual|beli)\b/i.test(lower)) {
    return { ...plan, requires_confirmation: true };
  }
  return plan;
}

export function routeToPlan(route) {
  return {
    intent: route.intent,
    confidence: route.confidence,
    requires_confirmation: route.requiresConfirmation,
    summary: summaryForRoute(route),
    reply: route.reply || '',
    tool_calls: route.toolCalls,
  };
}

export function detectFastLanguage(text = '') {
  const lower = String(text).toLowerCase();
  const id = ['saya', 'kamu', 'posisi', 'berapa', 'sekarang', 'jangan', 'tolong', 'kenapa', 'rugi', 'untung', 'ingat', 'antrian', 'strategi'];
  const en = ['what', 'why', 'show', 'check', 'position', 'profit', 'loss', 'remember', 'queue', 'strategy'];
  const idScore = id.filter(word => lower.includes(word)).length;
  const enScore = en.filter(word => lower.includes(word)).length;
  if (idScore >= enScore && idScore > 0) return 'id';
  if (enScore > 0) return 'en';
  return 'id';
}

function hit(intent, toolCalls, language, confidence, requiresConfirmation = false, safetySensitive = requiresConfirmation, reply = '') {
  return { hit: true, intent, toolCalls, language, confidence, requiresConfirmation, safetySensitive, reply };
}

function miss(language, safetySensitive = false) {
  return { hit: false, intent: null, toolCalls: [], language, confidence: 0, requiresConfirmation: false, safetySensitive };
}

function summaryForRoute(route) {
  if (route.intent === 'ask_strategy') return `Check active strategy ${activeStrategy().id}.`;
  return `Fast route: ${route.intent}`;
}
