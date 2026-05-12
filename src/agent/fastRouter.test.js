import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db/connection.js';
import { repairIntent, routeFastIntent } from './fastRouter.js';

initDb();

test('fast router handles common Indonesian position request', () => {
  const route = routeFastIntent('cek posisi saya');
  assert.equal(route.hit, true);
  assert.equal(route.intent, 'ask_positions');
  assert.equal(route.toolCalls[0].tool, 'get_open_positions');
  assert.ok(route.confidence >= 90);
});

test('fast router handles pnl without planner LLM', () => {
  const route = routeFastIntent('berapa pnl hari ini?');
  assert.equal(route.hit, true);
  assert.equal(route.intent, 'ask_pnl');
});

test('fast router keeps trading actions confirmation-sensitive', () => {
  const route = routeFastIntent('close semua posisi rugi');
  assert.equal(route.hit, true);
  assert.equal(route.intent, 'close_all_positions');
  assert.equal(route.safetySensitive, true);
  assert.equal(route.requiresConfirmation, true);
});

test('intent repair fixes fallback position request', () => {
  const repaired = repairIntent('cek posisi', { intent: 'fallback_chat', tool_calls: [] });
  assert.equal(repaired.intent, 'ask_positions');
});
