import { CHAT_ACTIONS_ENABLED, CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION, CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION, DRY_RUN_LOCK } from '../config.js';
import { toolRegistry } from './toolRegistry.js';

const DANGEROUS_TOOLS = new Set([
  'create_trade_intent', 'approve_trade_intent', 'reject_trade_intent', 'close_position',
  'close_all_positions', 'manual_buy', 'set_conditional_exit', 'set_active_strategy',
  'set_strategy_param', 'set_risk_param', 'set_mode', 'blacklist_token',
]);

const HARD_BLOCKED_TOOLS = new Set(['disable_dry_run_lock', 'expose_private_key']);

export function guardActionPlan(plan) {
  const toolCalls = Array.isArray(plan.tool_calls) ? plan.tool_calls : [];
  const denied = [];
  let requiresConfirmation = Boolean(plan.requires_confirmation);
  for (const call of toolCalls) {
    const tool = toolRegistry[call.tool];
    if (!tool || HARD_BLOCKED_TOOLS.has(call.tool)) {
      denied.push(`Tool not allowed: ${call.tool}`);
      continue;
    }
    if (tool.kind !== 'read' && !CHAT_ACTIONS_ENABLED) denied.push('Chat actions are disabled.');
    if (call.tool === 'set_mode' && ['live', 'confirm'].includes(String(call.args?.mode)) && DRY_RUN_LOCK) {
      denied.push('DRY_RUN_LOCK is active; chat cannot enable live/confirm execution.');
    }
    if (tool.kind === 'trade' && CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION) requiresConfirmation = true;
    if (tool.kind === 'config' && CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION) requiresConfirmation = true;
    if (DANGEROUS_TOOLS.has(call.tool)) requiresConfirmation = true;
  }
  return {
    allowed: denied.length === 0,
    denied,
    requiresConfirmation,
    riskSummary: denied.join('; ') || riskSummaryForTools(toolCalls),
  };
}

function riskSummaryForTools(toolCalls) {
  const names = toolCalls.map(call => call.tool).join(', ');
  return names ? `Chat action requires confirmation: ${names}` : 'No risky action.';
}
