import fs from 'node:fs';
import { bot } from '../telegram/bot.js';
import { CASUAL_CHAT_ENABLED, CHAT_MEMORY_ENABLED, TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_CHAT_ID } from '../config.js';
import { escapeHtml } from '../format.js';
import { db } from '../db/connection.js';
import { activeStrategy, boolSetting, setSetting } from '../db/settings.js';
import { summarizeTrades } from '../services/performance.js';
import { currentRiskState } from '../services/risk.js';
import { ACTIVE_STATUSES, statusSqlList } from '../services/positionStatus.js';
import { now } from '../utils.js';
import { guardActionPlan } from './actionGuard.js';
import { parseIntent } from './intentParser.js';
import { runToolCall } from './toolRegistry.js';
import {
  createPendingAction,
  listPreferences,
  logAgentDecision,
  pendingActionById,
  recentAgentDecisions,
  recentChatHistory,
  saveChatMessage,
  updatePendingAction,
} from './memory.js';

export function chatEnabled() {
  return boolSetting('casual_chat_enabled', CASUAL_CHAT_ENABLED);
}

export function setChatEnabled(enabled) {
  setSetting('casual_chat_enabled', enabled ? 'true' : 'false');
}

export async function handleCasualChat(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = String(msg.text || '').trim();
  if (!text || !chatEnabled()) return false;
  if (!allowedUser(chatId, userId)) {
    await bot.sendMessage(chatId, 'Chat agent is restricted to allowed Telegram users.');
    return true;
  }

  const context = loadAgentContext(chatId);
  saveChatMessage({ chatId, userId, role: 'user', content: text });

  const plan = await parseIntent({ message: text, context });
  const guard = guardActionPlan(plan);
  if (!guard.allowed) {
    const reply = `I cannot do that.\n\n${guard.denied.map(item => `- ${item}`).join('\n')}`;
    saveAssistant(chatId, userId, reply, plan, guard.denied.join('; '));
    return bot.sendMessage(chatId, reply);
  }

  if (guard.requiresConfirmation) {
    const pendingId = createPendingAction({
      chatId,
      userId,
      actionType: plan.intent,
      payload: { plan },
      riskSummary: guard.riskSummary,
    });
    const textOut = [
      `<b>Confirm Chat Action</b>`,
      '',
      escapeHtml(plan.summary || 'Action requested.'),
      '',
      `<b>Risk check</b>: ${escapeHtml(guard.riskSummary)}`,
      '',
      `This expires in 5 minutes.`,
    ].join('\n');
    saveAssistant(chatId, userId, `Confirmation required: ${plan.summary}`, plan, 'pending');
    logAgentDecision({
      action: plan.intent,
      summary: plan.summary,
      reason: 'Pending user confirmation from casual chat.',
      userMessage: text,
      toolCalls: plan.tool_calls,
      result: 'pending',
      keyRisks: guard.riskSummary,
    });
    await bot.sendMessage(chatId, textOut, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: 'Execute', callback_data: `pending:execute:${pendingId}` },
        { text: 'Cancel', callback_data: `pending:reject:${pendingId}` },
      ]] },
    });
    return true;
  }

  const result = await executePlan(chatId, plan);
  const reply = formatPlanResult(plan, result);
  saveAssistant(chatId, userId, reply, plan, result.summary);
  logAgentDecision({
    action: plan.intent,
    summary: plan.summary,
    reason: 'Executed read-only or low-risk casual chat request.',
    userMessage: text,
    toolCalls: plan.tool_calls,
    result: result.summary,
  });
  await bot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
  return true;
}

export async function executePendingChatAction(chatId, pendingId, query = null) {
  const pending = pendingActionById(pendingId);
  if (!pending) return bot.sendMessage(chatId, 'Pending action not found.');
  if (pending.status !== 'pending') return bot.sendMessage(chatId, `Pending action is already ${pending.status}.`);
  if (Number(pending.expires_at) < now()) {
    updatePendingAction(pendingId, 'expired');
    return bot.sendMessage(chatId, 'Pending action expired.');
  }
  const plan = pending.payload?.plan;
  const guard = guardActionPlan({ ...plan, requires_confirmation: false });
  if (!guard.allowed) {
    updatePendingAction(pendingId, 'blocked');
    return bot.sendMessage(chatId, `Action blocked: ${guard.denied.join('; ')}`);
  }
  const result = await executePlan(chatId, plan);
  updatePendingAction(pendingId, 'executed');
  logAgentDecision({
    action: plan.intent,
    summary: plan.summary,
    reason: 'Executed after Telegram button confirmation.',
    toolCalls: plan.tool_calls,
    result: result.summary,
    keyRisks: pending.risk_summary,
  });
  const reply = `<b>Executed</b>\n\n${escapeHtml(formatPlanResult(plan, result))}`;
  if (query) {
    return bot.editMessageText(reply, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch(() => bot.sendMessage(chatId, reply, { parse_mode: 'HTML' }));
  }
  return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
}

export async function rejectPendingChatAction(chatId, pendingId, query = null) {
  const pending = pendingActionById(pendingId);
  if (!pending) return bot.sendMessage(chatId, 'Pending action not found.');
  updatePendingAction(pendingId, 'rejected');
  const reply = 'Cancelled chat action.';
  if (query) {
    return bot.editMessageText(reply, { chat_id: chatId, message_id: query.message.message_id })
      .catch(() => bot.sendMessage(chatId, reply));
  }
  return bot.sendMessage(chatId, reply);
}

export async function executePlan(chatId, plan) {
  const outputs = [];
  for (const call of plan.tool_calls || []) {
    try {
      const result = await runToolCall(call);
      outputs.push({ call, ok: true, result: String(result || '') });
      await maybeSendReport(chatId, call.tool, result);
    } catch (err) {
      outputs.push({ call, ok: false, result: err.message });
    }
  }
  return {
    outputs,
    summary: outputs.map(item => `${item.call.tool}: ${item.result}`).join('\n').slice(0, 3000) || 'No tool output.',
  };
}

export function loadAgentContext(chatId) {
  const open = db.prepare(`SELECT id, mint, symbol, status, strategy_id, entry_mcap, current_mcap, unrealized_pnl_sol, unrealized_pnl_percent FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) ORDER BY opened_at_ms DESC LIMIT 10`).all();
  const closed = db.prepare("SELECT id, mint, symbol, exit_reason, realized_pnl_sol, pnl_percent, closed_at_ms FROM dry_run_positions WHERE status = 'CLOSED' ORDER BY closed_at_ms DESC LIMIT 10").all();
  const candidates = db.prepare('SELECT id, mint, status, created_at_ms FROM candidates ORDER BY id DESC LIMIT 10').all();
  return {
    mode: db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run',
    activeStrategy: activeStrategy(),
    pnl24h: summarizeTrades('24h'),
    risk: currentRiskState(),
    openPositions: open,
    recentClosedPositions: closed,
    recentCandidates: candidates,
    preferences: CHAT_MEMORY_ENABLED ? listPreferences(20) : [],
    recentDecisions: recentAgentDecisions(8),
    chatHistory: CHAT_MEMORY_ENABLED ? recentChatHistory(chatId) : [],
  };
}

export function formatMemory() {
  const rows = listPreferences(30);
  return rows.length
    ? rows.map(row => `<b>${escapeHtml(row.key)}</b>: ${escapeHtml(row.value)}`).join('\n')
    : 'No saved chat memories yet.';
}

function formatPlanResult(plan, result) {
  const body = result.outputs.map(item => {
    const prefix = item.ok ? `<b>${escapeHtml(item.call.tool)}</b>` : `<b>${escapeHtml(item.call.tool)} failed</b>`;
    return `${prefix}\n${escapeHtml(String(item.result || '').slice(0, 1200))}`;
  }).join('\n\n');
  return `${escapeHtml(plan.summary || 'Done.')}\n\n${body || escapeHtml(result.summary)}`;
}

async function maybeSendReport(chatId, tool, result) {
  if (!tool.startsWith('export_')) return;
  let parsed = null;
  try {
    parsed = JSON.parse(result);
  } catch {
    return;
  }
  if (parsed?.filePath && fs.existsSync(parsed.filePath)) {
    await bot.sendDocument(chatId, parsed.filePath, {}, { filename: parsed.filePath.split(/[\\/]/).pop() });
  }
}

function saveAssistant(chatId, userId, content, plan, resultSummary) {
  saveChatMessage({
    chatId,
    userId,
    role: 'assistant',
    content,
    intent: plan?.intent,
    toolCalls: plan?.tool_calls || [],
    resultSummary,
  });
}

function allowedUser(chatId, userId) {
  const chatAllowed = !TELEGRAM_CHAT_ID || String(chatId) === String(TELEGRAM_CHAT_ID);
  const userAllowed = !TELEGRAM_ALLOWED_USER_IDS.length || TELEGRAM_ALLOWED_USER_IDS.includes(String(userId));
  return chatAllowed && userAllowed;
}
