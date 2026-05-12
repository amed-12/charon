import { db } from '../db/connection.js';
import { CHAT_HISTORY_LIMIT } from '../config.js';
import { json, safeJson, now } from '../utils.js';

export function initAgentMemory() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      created_at TEXT,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT,
      tool_calls TEXT,
      tool_calls_json TEXT,
      result_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      pending_action_id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      user_id TEXT,
      chat_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      risk_summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS agent_decision_logs (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      created_at TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      token_mint TEXT,
      token_symbol TEXT,
      position_id TEXT,
      strategy_id TEXT,
      summary TEXT,
      reason TEXT,
      key_risks TEXT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      rejected_alternatives TEXT,
      user_message TEXT,
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      result TEXT
    );
  `);
  ensureColumn('chat_messages', 'created_at', 'TEXT');
  ensureColumn('chat_messages', 'tool_calls_json', 'TEXT');
  ensureColumn('chat_messages', 'timestamp', 'INTEGER');
  ensureColumn('user_preferences', 'scope', "TEXT DEFAULT 'global'");
  ensureColumn('agent_decision_logs', 'created_at', 'TEXT');
  ensureColumn('agent_decision_logs', 'timestamp', 'INTEGER');
}

export function saveChatMessage({ chatId, userId = null, role, content, intent = null, toolCalls = [], resultSummary = '' }) {
  initAgentMemory();
  const at = now();
  db.prepare(`
    INSERT INTO chat_messages (timestamp, created_at, chat_id, user_id, role, content, intent, tool_calls, tool_calls_json, result_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(at, new Date(at).toISOString(), String(chatId), userId == null ? null : String(userId), role, String(content || ''), intent, json(toolCalls), json(toolCalls), resultSummary);
}

export function recentChatHistory(chatId, limit = CHAT_HISTORY_LIMIT) {
  initAgentMemory();
  return db.prepare(`
    SELECT role, content, intent, result_summary
    FROM chat_messages
    WHERE chat_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(chatId), Math.max(1, limit)).reverse();
}

export function savePreference(key, value, scope = 'global') {
  initAgentMemory();
  const at = new Date(now()).toISOString();
  db.prepare(`
    INSERT INTO user_preferences (key, value, scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, scope = excluded.scope, updated_at = excluded.updated_at
  `).run(String(key), String(value), String(scope), at, at);
}

export function forgetPreference(key) {
  initAgentMemory();
  return db.prepare('DELETE FROM user_preferences WHERE key = ?').run(String(key)).changes;
}

export function listPreferences(limit = 20) {
  initAgentMemory();
  return db.prepare('SELECT key, value, scope, updated_at FROM user_preferences ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function createPendingAction({ chatId, userId, actionType, payload, riskSummary }) {
  initAgentMemory();
  const at = now();
  const result = db.prepare(`
    INSERT INTO pending_actions (created_at, expires_at, user_id, chat_id, action_type, payload_json, risk_summary, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(at, at + 5 * 60_000, userId == null ? null : String(userId), String(chatId), actionType, json(payload), riskSummary);
  return Number(result.lastInsertRowid);
}

export function pendingActionById(id) {
  initAgentMemory();
  const row = db.prepare('SELECT * FROM pending_actions WHERE pending_action_id = ?').get(Number(id));
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}

export function updatePendingAction(id, status) {
  initAgentMemory();
  db.prepare('UPDATE pending_actions SET status = ? WHERE pending_action_id = ?').run(status, Number(id));
}

export function logAgentDecision({ actor = 'chat_agent', action, summary = '', reason = '', userMessage = '', toolCalls = [], result = '', positionId = null, tokenMint = null, tokenSymbol = null, strategyId = null, keyRisks = '', metrics = {}, rejectedAlternatives = '' }) {
  initAgentMemory();
  const at = now();
  db.prepare(`
    INSERT INTO agent_decision_logs (
      timestamp, created_at, actor, action, token_mint, token_symbol, position_id, strategy_id,
      summary, reason, key_risks, metrics_json, rejected_alternatives, user_message,
      tool_calls_json, result
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(at, new Date(at).toISOString(), actor, action, tokenMint, tokenSymbol, positionId == null ? null : String(positionId), strategyId, summary, reason, keyRisks, json(metrics), rejectedAlternatives, userMessage, json(toolCalls), result);
}

export function recentAgentDecisions(limit = 10) {
  initAgentMemory();
  return db.prepare(`
    SELECT *
    FROM agent_decision_logs
    ORDER BY decision_id DESC
    LIMIT ?
  `).all(Math.max(1, limit));
}

export const getRecentChatMessages = recentChatHistory;
export const saveUserPreference = savePreference;
export const getUserPreferences = listPreferences;
export const forgetUserPreference = forgetPreference;
export const saveDecisionLog = logAgentDecision;
export const getRecentDecisionLogs = recentAgentDecisions;

export function approvePendingAction(id) {
  updatePendingAction(id, 'approved');
}

export function rejectPendingAction(id) {
  updatePendingAction(id, 'rejected');
}

function ensureColumn(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!exists) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}
