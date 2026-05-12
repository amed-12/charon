import { CHAT_ACTIONS_ENABLED, CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION, CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION, DRY_RUN_LOCK } from '../config.js';
import { toolRegistry } from './toolRegistry.js';
import { listTools } from './tools.js';

const READ_ONLY_INTENTS = new Set([
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
  'export_trades',
  'export_open_positions',
  'export_closed_positions',
  'fallback_chat',
]);

const MEMORY_INTENTS = new Set(['remember_user_preference', 'forget_user_preference']);
const TRADE_INTENTS = new Set(['manual_buy', 'close_position', 'close_all_positions']);
const CONFIG_INTENTS = new Set(['update_strategy_param', 'update_risk_param', 'set_strategy', 'set_mode']);
const HARD_BLOCK_PATTERNS = [/private[_\s-]?key/i, /dry[_\s-]?run[_\s-]?lock.*(false|off|disable)/i, /telegram_allowed_user_ids/i];
const TRADE_TOOLS = new Set(['create_trade_intent', 'approve_trade_intent', 'reject_trade_intent', 'manual_buy', 'close_position', 'close_all_positions', 'set_conditional_exit', 'cancel_pending_intent']);

export function validateActionPlan(plan, context = {}) {
  const denied = [];
  let requiresConfirmation = Boolean(plan.requires_confirmation);
  let toolRequiresConfirmation = false;
  const toolNames = new Set(listTools());
  const calls = Array.isArray(plan.tool_calls) ? plan.tool_calls : [];
  const userMessage = String(context.message || '');

  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(userMessage) || pattern.test(JSON.stringify(plan))) {
      denied.push('Blocked by safety guard.');
      break;
    }
  }

  for (const call of calls) {
    const toolName = call.tool === 'remember_user_preference'
      ? 'save_chat_memory'
      : call.tool === 'forget_user_preference'
        ? 'forget_memory'
        : call.tool;
    if (!toolNames.has(call.tool) && !toolRegistry[toolName]) {
      denied.push(`Unknown tool: ${call.tool}`);
      continue;
    }
    const kind = toolRegistry[toolName]?.kind;
    if (kind && kind !== 'read' && !CHAT_ACTIONS_ENABLED) denied.push('Chat actions are disabled.');
    if (kind === 'config' && CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION) toolRequiresConfirmation = true;
    if (kind === 'trade' && CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION) toolRequiresConfirmation = true;
    if (TRADE_TOOLS.has(toolName)) toolRequiresConfirmation = true;
    if (call.tool === 'set_mode' && ['live', 'confirm'].includes(String(call.args?.mode)) && DRY_RUN_LOCK) {
      denied.push('DRY_RUN_LOCK is active; live/confirm mode cannot be enabled from Telegram.');
    }
    if (call.tool === 'set_risk_param' && lowersRiskProtection(call.args)) toolRequiresConfirmation = true;
    if (call.tool === 'set_strategy_param' && increasesPositionSize(call.args)) toolRequiresConfirmation = true;
  }

  if (toolRequiresConfirmation) requiresConfirmation = true;
  if (TRADE_INTENTS.has(plan.intent)) requiresConfirmation = true;
  if (CONFIG_INTENTS.has(plan.intent) && CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION) requiresConfirmation = true;
  if (MEMORY_INTENTS.has(plan.intent)) requiresConfirmation = false;
  if (READ_ONLY_INTENTS.has(plan.intent) && !plan.requires_confirmation && !toolRequiresConfirmation) requiresConfirmation = false;
  if (TRADE_INTENTS.has(plan.intent) && CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION) requiresConfirmation = true;

  return {
    allowed: denied.length === 0,
    denied,
    requiresConfirmation,
    riskSummary: denied.join('; ') || riskSummary(plan, calls),
  };
}

function increasesPositionSize(args = {}) {
  return String(args.key || '').includes('position_size') && Number(args.value) > 0;
}

function lowersRiskProtection(args = {}) {
  const key = String(args.key || '').toLowerCase();
  const value = Number(args.value);
  if (!Number.isFinite(value)) return false;
  if (key.includes('loss') || key.includes('position_size') || key.includes('exposure')) return value > 0;
  if (key.includes('min_liquidity') || key.includes('min_holders')) return true;
  return false;
}

function riskSummary(plan, calls = []) {
  if (TRADE_INTENTS.has(plan.intent)) return 'Trade action requested; confirmation required before execution.';
  if (CONFIG_INTENTS.has(plan.intent)) return 'Configuration change requested; confirmation required.';
  const toolNames = calls.map(call => {
    if (call.tool === 'remember_user_preference') return 'save_chat_memory';
    if (call.tool === 'forget_user_preference') return 'forget_memory';
    return call.tool;
  });
  if (toolNames.some(tool => toolRegistry[tool]?.kind === 'trade' || TRADE_TOOLS.has(tool))) {
    return 'Trade action requested; confirmation required before execution.';
  }
  if (toolNames.some(tool => toolRegistry[tool]?.kind === 'config')) {
    return 'Configuration change requested; confirmation required.';
  }
  return 'No risky action detected.';
}
