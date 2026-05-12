const VALID_INTENTS = new Set([
  'ask_positions',
  'ask_pnl',
  'ask_status',
  'ask_strategy',
  'ask_lessons',
  'ask_memory',
  'ask_queue',
  'ask_risk',
  'ask_recent_decisions',
  'ask_trade_reason',
  'ask_candidate_analysis',
  'update_strategy_param',
  'update_risk_param',
  'set_strategy',
  'close_position',
  'close_all_positions',
  'manual_buy',
  'export_trades',
  'export_open_positions',
  'export_closed_positions',
  'remember_user_preference',
  'forget_user_preference',
  'fallback_chat',
]);

export function parseAgentResponse(rawText) {
  try {
    const parsed = JSON.parse(extractJson(rawText));
    const intent = VALID_INTENTS.has(parsed.intent) ? parsed.intent : 'fallback_chat';
    const confidence = Number(parsed.confidence);
    return {
      intent,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0,
      requires_confirmation: Boolean(parsed.requires_confirmation),
      summary: String(parsed.summary || ''),
      reply: String(parsed.reply || ''),
      tool_calls: Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
          .filter(call => call && typeof call.tool === 'string')
          .map(call => ({ tool: call.tool, args: call.args || {} }))
        : [],
    };
  } catch {
    return fallbackPlan();
  }
}

export function fallbackPlan() {
  return {
    intent: 'fallback_chat',
    confidence: 0,
    requires_confirmation: false,
    summary: 'Could not safely parse agent output.',
    tool_calls: [],
    reply: 'Saya belum bisa memahami instruksi itu dengan aman. Bisa tulis lebih spesifik?',
  };
}

function extractJson(rawText) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const object = text.match(/\{[\s\S]*\}/)?.[0];
  return (object || text).trim();
}
