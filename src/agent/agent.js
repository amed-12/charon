import fs from 'node:fs';
import axios from 'axios';
import { bot } from '../telegram/bot.js';
import {
  CASUAL_CHAT_ENABLED,
  CHAT_MEMORY_ENABLED,
  DRY_RUN_LOCK,
  ENABLE_LLM,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  TELEGRAM_ALLOWED_USER_IDS,
  TELEGRAM_CHAT_ID,
} from '../config.js';
import { escapeHtml } from '../format.js';
import { boolSetting, setSetting } from '../db/settings.js';
import { now } from '../utils.js';
import { heuristicPlan } from './intentParser.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { parseAgentResponse } from './parser.js';
import { validateActionPlan } from './guard.js';
import { executeToolCall, getAgentState, getStateForIntent, listTools } from './tools.js';
import { detectUserLanguage, generateNaturalReply } from './responder.js';
import { detectFastLanguage, repairIntent, routeFastIntent, routeToPlan } from './fastRouter.js';
import { agentPerf, enqueueAgentRequest, setRequestStatus } from './queue.js';
import {
  formatConfirmationReply,
  formatMemoryReply,
  formatPnlReply,
  formatPositionsReply,
  formatQueueReply,
  formatStatusReply,
  formatStrategyReply,
} from './formatters.js';
import {
  createPendingAction,
  getRecentChatMessages,
  getUserPreferences,
  initAgentMemory,
  pendingActionById,
  saveChatMessage,
  saveDecisionLog,
  updatePendingAction,
} from './memory.js';

export async function handleCasualMessage(ctx, deps = {}) {
  initAgentMemory();
  const msg = ctx.message || ctx;
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = String(msg.text || '').trim();
  const telegram = deps.bot || bot;

  if (!text) return false;
  if (!chatEnabled()) {
    await telegram.sendMessage(chatId, 'Casual chat is disabled. Use /chat_on to enable it.');
    return true;
  }
  if (!isAuthorized(msg)) {
    if (msg.chat?.type === 'private') await telegram.sendMessage(chatId, 'not authorized');
    return true;
  }

  return enqueueAgentRequest({
    chatId,
    userId,
    message: text,
    run: request => withTotalTimeout(processCasualRequest({ msg, text, chatId, userId, telegram, request }), 20_000),
  }).then(() => true).catch(async (err) => {
    const language = detectFastLanguage(text);
    await telegram.sendMessage(chatId, language === 'id'
      ? `Prosesnya agak lama atau gagal sebentar: ${escapeHtml(err.message)}`
      : `That took too long or failed for a moment: ${escapeHtml(err.message)}`);
    return true;
  });
}

async function processCasualRequest({ text, chatId, userId, telegram, request }) {
  const fast = routeFastIntent(text);
  const language = fast.language || detectUserLanguage(text);
  const memories = CHAT_MEMORY_ENABLED ? getRecentChatMessages(chatId) : [];
  const preferences = CHAT_MEMORY_ENABLED ? getUserPreferences() : [];
  saveChatMessage({ chatId, userId, role: 'user', content: text });

  if (fast.blocked || fast.intent === 'blocked_safety_request') {
    const plan = repairIntent(text, null);
    const state = getStateForIntent('ask_status');
    const reply = await generateNaturalReply({
      userMessage: text,
      plan,
      toolResults: { outputs: [{ call: { tool: 'guard' }, ok: false, result: plan.reply }] },
      state,
      memories: memories.concat(preferences),
      lessons: [],
      language,
      debug: boolSetting('chat_debug', false),
    });
    saveAssistant({ chatId, userId, plan, reply, result: plan.reply });
    await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    return { summary: 'Blocked safety request.' };
  }

  if (fast.hit && fast.confidence >= 90 && !fast.safetySensitive) {
    agentPerf.fastPathHits += 1;
    const plan = routeToPlan(fast);
    const state = getStateForIntent(plan.intent);
    const guard = validateActionPlan(plan, { message: text, state });
    if (!guard.allowed) {
      const reply = await generateNaturalReply({
        userMessage: text,
        plan: { ...plan, intent: 'fallback_chat', summary: guard.denied.join('; ') },
        toolResults: { outputs: [{ call: { tool: 'guard' }, ok: false, result: guard.denied.join('; ') }] },
        state,
        memories: memories.concat(preferences),
        lessons: [],
        language,
        debug: boolSetting('chat_debug', false),
      });
      saveAssistant({ chatId, userId, plan, reply, result: guard.denied.join('; ') });
      await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
      return { summary: 'Fast path guard denied.' };
    }
    setRequestStatus(request, 'FETCHING_DATA', 'Fast path data fetch.');
    const result = await executePlan(chatId, plan, { message: text, telegram, chatId, userId });
    const reply = deterministicReply({ plan, result, state, language, memories: preferences });
    saveAssistant({ chatId, userId, plan, reply, result: result.summary });
    saveDecisionLog({
      action: plan.intent,
      summary: plan.summary,
      reason: 'Fast-router read-only casual chat request.',
      userMessage: text,
      toolCalls: plan.tool_calls,
      result: result.summary,
    });
    await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    return { summary: plan.intent };
  }

  const progress = progressReporter({ telegram, chatId, language, request, queued: Boolean(request.summary) });
  progress.start();

  let state = getStateForIntent(fast.intent || 'ask_status');
  const lessons = state.recentDecisions || [];

  setRequestStatus(request, 'THINKING', 'Planning request.');
  let plan = await planWithLlm({ message: text, state, memories: memories.concat(preferences), lessons });
  if (!plan || plan.intent === 'fallback_chat' || !plan.tool_calls.length) {
    plan = normalizeFallbackPlan(heuristicPlan(text), text);
  }
  plan = repairIntent(text, plan);
  state = getStateForIntent(plan.intent);

  const guard = validateActionPlan(plan, { message: text, state });
  if (!guard.allowed) {
    progress.stop();
    const reply = await generateNaturalReply({
      userMessage: text,
      plan: { ...plan, intent: 'fallback_chat', summary: guard.denied.join('; ') },
      toolResults: { outputs: [{ call: { tool: 'guard' }, ok: false, result: guard.denied.join('; ') }] },
      state,
      memories: memories.concat(preferences),
      lessons,
      language,
      debug: boolSetting('chat_debug', false),
    });
    saveAssistant({ chatId, userId, plan, reply, result: guard.denied.join('; ') });
    await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    return { summary: 'Guard denied request.' };
  }

  if (guard.requiresConfirmation) {
    progress.stop();
    setRequestStatus(request, 'WAITING_CONFIRMATION', guard.riskSummary);
    const pendingId = createPendingAction({
      chatId,
      userId,
      actionType: plan.intent,
      payload: { plan },
      riskSummary: guard.riskSummary,
    });
    const reply = await generateNaturalReply({
      userMessage: text,
      plan: { ...plan, requires_confirmation: true, summary: `${plan.summary || plan.reply || 'Action requested.'} ${guard.riskSummary}` },
      toolResults: { outputs: [] },
      state,
      memories: memories.concat(preferences),
      lessons,
      language,
      debug: boolSetting('chat_debug', false),
    });
    saveAssistant({ chatId, userId, plan, reply: `Confirmation required: ${plan.summary}`, result: 'pending' });
    saveDecisionLog({
      action: plan.intent,
      summary: plan.summary,
      reason: 'Pending Telegram confirmation from casual chat.',
      keyRisks: guard.riskSummary,
      userMessage: text,
      toolCalls: plan.tool_calls,
      result: 'pending',
    });
    await telegram.sendMessage(chatId, reply, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: 'Execute', callback_data: `pending:execute:${pendingId}` },
        { text: 'Cancel', callback_data: `pending:reject:${pendingId}` },
      ]] },
    });
    return { summary: 'Waiting confirmation.' };
  }

  setRequestStatus(request, 'EXECUTING_TOOL', 'Executing tools.');
  const result = await executePlan(chatId, plan, { message: text, telegram });
  progress.gotData();
  const reply = await generateNaturalReply({
    userMessage: text,
    plan,
    toolResults: result,
    state,
    memories: memories.concat(preferences),
    lessons,
    language,
    debug: boolSetting('chat_debug', false),
  });
  progress.stop();
  saveAssistant({ chatId, userId, plan, reply, result: result.summary });
  saveDecisionLog({
    action: plan.intent,
    summary: plan.summary,
    reason: 'Executed casual chat request.',
    userMessage: text,
    toolCalls: plan.tool_calls,
    result: result.summary,
  });
  await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
  return { summary: plan.intent };
}

export async function executePendingAgentAction(chatId, pendingId, query = null) {
  const pending = pendingActionById(pendingId);
  if (!pending) return bot.sendMessage(chatId, 'Pending action not found.');
  const callbackUserId = query?.from?.id == null ? null : String(query.from.id);
  if (String(pending.chat_id) !== String(chatId)) {
    return bot.sendMessage(chatId, 'Pending action belongs to another chat.');
  }
  if (pending.user_id && callbackUserId && String(pending.user_id) !== callbackUserId) {
    return bot.answerCallbackQuery(query.id, { text: 'Only the requester can execute this action.', show_alert: true })
      .catch(() => bot.sendMessage(chatId, 'Only the requester can execute this action.'));
  }
  if (pending.status !== 'pending') return bot.sendMessage(chatId, `Pending action is already ${pending.status}.`);
  if (Number(pending.expires_at) < now()) {
    updatePendingAction(pendingId, 'expired');
    return bot.sendMessage(chatId, 'Pending action expired.');
  }
  const plan = pending.payload?.plan;
  const guard = validateActionPlan({ ...plan, requires_confirmation: false }, { message: '', state: getAgentState() });
  if (!guard.allowed) {
    updatePendingAction(pendingId, 'blocked');
    return bot.sendMessage(chatId, `Action blocked: ${guard.denied.join('; ')}`);
  }
  const result = await executePlan(chatId, plan, { message: '', telegram: bot });
  updatePendingAction(pendingId, 'executed');
  saveDecisionLog({
    action: plan.intent,
    summary: plan.summary,
    reason: 'Executed after Telegram confirmation.',
    keyRisks: pending.risk_summary,
    toolCalls: plan.tool_calls,
    result: result.summary,
  });
  const reply = await generateNaturalReply({
    userMessage: '',
    plan,
    toolResults: result,
    state: getAgentState(),
    memories: [],
    lessons: [],
    language: 'en',
    debug: boolSetting('chat_debug', false),
  });
  if (query?.message?.message_id) {
    return bot.editMessageText(reply, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch(() => bot.sendMessage(chatId, reply, { parse_mode: 'HTML' }));
  }
  return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
}

export async function rejectPendingAgentAction(chatId, pendingId, query = null) {
  const pending = pendingActionById(pendingId);
  if (!pending) return bot.sendMessage(chatId, 'Pending action not found.');
  const callbackUserId = query?.from?.id == null ? null : String(query.from.id);
  if (String(pending.chat_id) !== String(chatId)) {
    return bot.sendMessage(chatId, 'Pending action belongs to another chat.');
  }
  if (pending.user_id && callbackUserId && String(pending.user_id) !== callbackUserId) {
    return bot.answerCallbackQuery(query.id, { text: 'Only the requester can cancel this action.', show_alert: true })
      .catch(() => bot.sendMessage(chatId, 'Only the requester can cancel this action.'));
  }
  updatePendingAction(pendingId, 'rejected');
  const reply = 'Cancelled chat action.';
  if (query?.message?.message_id) {
    return bot.editMessageText(reply, { chat_id: chatId, message_id: query.message.message_id })
      .catch(() => bot.sendMessage(chatId, reply));
  }
  return bot.sendMessage(chatId, reply);
}

export function chatEnabled() {
  return boolSetting('casual_chat_enabled', CASUAL_CHAT_ENABLED);
}

export function setChatEnabled(enabled) {
  setSetting('casual_chat_enabled', enabled ? 'true' : 'false');
}

export function formatMemory() {
  const rows = getUserPreferences();
  return rows.length
    ? rows.map(row => `<b>${escapeHtml(row.key)}</b>: ${escapeHtml(row.value)}`).join('\n')
    : 'No saved chat memories yet.';
}

async function planWithLlm({ message, state, memories, lessons }) {
  const apiKey = LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
  if ((!ENABLE_LLM && !process.env.OPENROUTER_API_KEY) || !apiKey) return null;
  agentPerf.plannerCalls += 1;
  const baseUrl = process.env.OPENROUTER_API_KEY && !LLM_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : LLM_BASE_URL.replace(/\/$/, '');
  const model = process.env.CHAT_AGENT_MODEL || LLM_MODEL;
  const res = await axios.post(`${baseUrl}/chat/completions`, {
    model,
    messages: [
      { role: 'system', content: `${buildSystemPrompt()}\n\nAvailable tools: ${listTools().join(', ')}` },
      { role: 'user', content: buildUserPrompt({ message, state, memories, lessons }) },
    ],
    temperature: Number(process.env.CHAT_AGENT_TEMPERATURE || 0.2),
  }, {
    timeout: Math.min(LLM_TIMEOUT_MS, 8000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  }).catch((err) => {
    console.log(`[chat-agent] LLM failed: ${err.message}`);
    return null;
  });
  const raw = res?.data?.choices?.[0]?.message?.content;
  return raw ? parseAgentResponse(raw) : null;
}

async function executePlan(chatId, plan, context) {
  const outputs = [];
  for (const call of plan.tool_calls || []) {
    try {
      const result = await withTotalTimeout(executeToolCall(call, context), 10_000);
      outputs.push({ call, ok: true, result });
      await maybeSendExport(chatId, result, context.telegram);
    } catch (err) {
      outputs.push({ call, ok: false, result: err.message });
    }
  }
  return {
    outputs,
    summary: outputs.map(item => `${item.call.tool}: ${typeof item.result === 'string' ? item.result : JSON.stringify(item.result)}`).join('\n').slice(0, 3000),
  };
}

function deterministicReply({ plan, result, state, language, memories }) {
  const debug = boolSetting('chat_debug', false)
    ? `\n\n---\nDebug:\nIntent: ${plan.intent}\nConfidence: ${plan.confidence}\nTools: ${(plan.tool_calls || []).map(call => call.tool).join(', ') || 'none'}`
    : '';
  if (plan.intent === 'ask_positions') return `${formatPositionsReply(state, language)}${debug}`;
  if (plan.intent === 'ask_pnl') return `${formatPnlReply(state.pnlData || parsePnlResult(result), language)}${debug}`;
  if (plan.intent === 'ask_status') return `${formatStatusReply(state, language)}${debug}`;
  if (plan.intent === 'ask_strategy') return `${formatStrategyReply({ ...state, memories }, language)}${debug}`;
  if (plan.intent === 'ask_memory' || plan.intent === 'remember_user_preference') {
    const saved = plan.intent === 'remember_user_preference';
    return `${formatMemoryReply({ saved, preferences: memories }, language)}${debug}`;
  }
  if (plan.intent === 'ask_queue') {
    return `${formatQueueReply(result.outputs?.[0]?.result || {}, language)}${debug}`;
  }
  if (plan.requires_confirmation) return `${formatConfirmationReply(plan, language, state.mode?.effective, state.mode?.dryRunLock)}${debug}`;
  return `${result.summary || (language === 'id' ? 'Selesai saya cek.' : 'Done.')}${debug}`;
}

function parsePnlResult(result) {
  const text = result.summary || '';
  const get = regex => Number(text.match(regex)?.[1] || 0);
  return {
    realized: get(/Realized:\s*([+-]?\d+(?:\.\d+)?)/i),
    unrealized: get(/Unrealized:\s*([+-]?\d+(?:\.\d+)?)/i),
    total: get(/Total:\s*([+-]?\d+(?:\.\d+)?)/i),
  };
}

function withTotalTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

function progressReporter({ telegram, chatId, language, request, queued }) {
  const timers = [];
  let stopped = false;
  const send = text => {
    if (stopped || ['COMPLETED', 'FAILED'].includes(request.status)) return;
    telegram.sendMessage(chatId, text).catch(() => {});
  };
  return {
    start() {
      if (queued) {
        send(language === 'id'
          ? 'Aksi ini masuk antrian karena ada proses lain yang belum selesai.'
          : 'This request is queued because another task is still running.');
      }
      timers.push(setTimeout(() => {
        setRequestStatus(request, 'FETCHING_DATA', 'Progress update sent.');
        send(language === 'id' ? 'Saya cek dulu datanya...' : 'Checking the latest data...');
      }, 1500));
      timers.push(setTimeout(() => {
        setRequestStatus(request, 'THINKING', 'Longer analysis progress sent.');
        send(language === 'id' ? 'Sedang saya analisis, sebentar...' : 'Analyzing it now...');
      }, 6000));
    },
    gotData() {
      setRequestStatus(request, 'EXECUTING_TOOL', 'Data fetched.');
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

function normalizeFallbackPlan(plan, message) {
  const reply = detectUserLanguage(message) === 'id' ? 'Saya cek datanya dulu.' : 'I checked the current data.';
  return {
    intent: plan.intent || 'fallback_chat',
    confidence: plan.confidence || 50,
    requires_confirmation: Boolean(plan.requires_confirmation),
    summary: plan.summary || reply,
    reply,
    tool_calls: Array.isArray(plan.tool_calls) ? plan.tool_calls : [],
  };
}

async function maybeSendExport(chatId, result, telegram) {
  if (!result?.filePath || !fs.existsSync(result.filePath)) return;
  await telegram.sendDocument(chatId, result.filePath, {}, { filename: result.filePath.split(/[\\/]/).pop() });
}

function saveAssistant({ chatId, userId, plan, reply, result }) {
  saveChatMessage({
    chatId,
    userId,
    role: 'assistant',
    content: reply,
    intent: plan.intent,
    toolCalls: plan.tool_calls,
    resultSummary: result,
  });
}

function isAuthorized(msg) {
  const chatId = String(msg.chat?.id || '');
  const userId = String(msg.from?.id || '');
  const chatType = msg.chat?.type || 'private';
  if (TELEGRAM_ALLOWED_USER_IDS.length) return TELEGRAM_ALLOWED_USER_IDS.includes(userId);
  if (chatType === 'private') return true;
  return !TELEGRAM_CHAT_ID || chatId === String(TELEGRAM_CHAT_ID);
}
