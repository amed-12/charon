import { now } from '../utils.js';

const queues = new Map();
const requests = new Map();
const recentCompleted = [];
const recentFailed = [];
let seq = 0;

export const agentPerf = {
  totalResponseMs: 0,
  responseCount: 0,
  lastResponseMs: 0,
  fastPathHits: 0,
  plannerCalls: 0,
  responderCalls: 0,
  fallbackFormatterCount: 0,
  failedRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

export function enqueueAgentRequest({ chatId, userId, message, run }) {
  const key = `${chatId}:${userId || 'anon'}`;
  const request = {
    id: `agent-${++seq}`,
    chatId,
    userId,
    message,
    status: 'QUEUED',
    createdAt: now(),
    startedAt: null,
    completedAt: null,
    summary: '',
    error: '',
  };
  const queue = queues.get(key) || Promise.resolve();
  const pendingBefore = activeForKey(key);
  requests.set(request.id, request);
  const task = queue
    .catch(() => {})
    .then(async () => {
      request.status = 'THINKING';
      request.startedAt = now();
      try {
        if (pendingBefore) request.summary = 'Queued behind another chat request.';
        const result = await run(request, pendingBefore);
        request.status = 'COMPLETED';
        request.summary = result?.summary || request.summary || 'Completed.';
        return result;
      } catch (err) {
        request.status = 'FAILED';
        request.error = err.message;
        request.summary = err.message;
        agentPerf.failedRequests += 1;
        recentFailed.unshift({ ...request });
        throw err;
      } finally {
        request.completedAt = now();
        agentPerf.lastResponseMs = request.completedAt - request.createdAt;
        agentPerf.totalResponseMs += agentPerf.lastResponseMs;
        agentPerf.responseCount += 1;
        if (request.status === 'COMPLETED') recentCompleted.unshift({ ...request });
        recentCompleted.splice(10);
        recentFailed.splice(20);
      }
    });
  queues.set(key, task);
  return task;
}

export function setRequestStatus(request, status, summary = '') {
  if (!request) return;
  request.status = status;
  if (summary) request.summary = summary;
}

export function queueSnapshot(chatId = null, userId = null) {
  const rows = Array.from(requests.values());
  const scoped = chatId == null ? rows : rows.filter(row => String(row.chatId) === String(chatId) && (userId == null || String(row.userId) === String(userId)));
  const active = scoped.find(row => !['COMPLETED', 'FAILED'].includes(row.status) && row.startedAt);
  const pending = scoped.filter(row => row.status === 'QUEUED');
  const failedSince = now() - 60 * 60_000;
  return {
    active,
    pendingCount: pending.length,
    lastCompleted: recentCompleted.find(row => chatId == null || String(row.chatId) === String(chatId)) || null,
    failedLastHour: recentFailed.filter(row => row.createdAt >= failedSince && (chatId == null || String(row.chatId) === String(chatId))),
  };
}

export function perfSnapshot() {
  const active = Array.from(requests.values()).filter(row => !['COMPLETED', 'FAILED'].includes(row.status));
  return {
    averageResponseMs: agentPerf.responseCount ? Math.round(agentPerf.totalResponseMs / agentPerf.responseCount) : 0,
    lastResponseMs: agentPerf.lastResponseMs,
    fastPathHits: agentPerf.fastPathHits,
    plannerCalls: agentPerf.plannerCalls,
    responderCalls: agentPerf.responderCalls,
    fallbackFormatterCount: agentPerf.fallbackFormatterCount,
    failedRequests: agentPerf.failedRequests,
    activeQueueSize: active.length,
    cacheHits: agentPerf.cacheHits,
    cacheMisses: agentPerf.cacheMisses,
  };
}

function activeForKey(key) {
  const [chatId, userId] = key.split(':');
  return Array.from(requests.values()).some(row =>
    String(row.chatId) === chatId &&
    String(row.userId || 'anon') === userId &&
    !['COMPLETED', 'FAILED'].includes(row.status)
  );
}
