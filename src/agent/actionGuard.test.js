import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db/connection.js';
import { guardActionPlan } from './actionGuard.js';
import { validateActionPlan } from './guard.js';

initDb();

test('read-only chat action executes without confirmation', () => {
  const guard = guardActionPlan({
    intent: 'ask_pnl',
    requires_confirmation: false,
    tool_calls: [{ tool: 'get_pnl', args: {} }],
  });
  assert.equal(guard.allowed, true);
  assert.equal(guard.requiresConfirmation, false);
});

test('trade chat action requires confirmation', () => {
  const guard = guardActionPlan({
    intent: 'close_all_positions',
    requires_confirmation: false,
    tool_calls: [{ tool: 'close_all_positions', args: {} }],
  });
  assert.equal(guard.allowed, true);
  assert.equal(guard.requiresConfirmation, true);
});

test('DRY_RUN_LOCK blocks chat request to live mode', () => {
  const guard = guardActionPlan({
    intent: 'update_mode',
    requires_confirmation: true,
    tool_calls: [{ tool: 'set_mode', args: { mode: 'live' } }],
  });
  assert.equal(guard.allowed, false);
  assert.ok(guard.denied.some(reason => reason.includes('DRY_RUN_LOCK')));
});

test('active guard requires confirmation for config tools even with fallback intent', () => {
  const guard = validateActionPlan({
    intent: 'fallback_chat',
    requires_confirmation: false,
    tool_calls: [{ tool: 'set_strategy_param', args: { strategyId: 'sniper', key: 'position_size_sol', value: 0.2 } }],
  });
  assert.equal(guard.allowed, true);
  assert.equal(guard.requiresConfirmation, true);
  assert.match(guard.riskSummary, /Configuration change/);
});

test('active guard requires confirmation for trade tools even with fallback intent', () => {
  const guard = validateActionPlan({
    intent: 'fallback_chat',
    requires_confirmation: false,
    tool_calls: [{ tool: 'close_all_positions', args: {} }],
  });
  assert.equal(guard.allowed, true);
  assert.equal(guard.requiresConfirmation, true);
  assert.match(guard.riskSummary, /Trade action/);
});
