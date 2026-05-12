import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db/connection.js';
import { heuristicPlan } from './intentParser.js';

initDb();

test('heuristic parser routes Indonesian position request to read-only tool', () => {
  const plan = heuristicPlan('cek posisi saya sekarang');
  assert.equal(plan.intent, 'ask_positions');
  assert.equal(plan.tool_calls[0].tool, 'get_open_positions');
  assert.equal(plan.requires_confirmation, false);
});

test('heuristic parser routes closed export with window', () => {
  const plan = heuristicPlan('export closed positions 7d');
  assert.equal(plan.intent, 'export_closed_positions');
  assert.equal(plan.tool_calls[0].tool, 'export_closed_positions');
  assert.deepEqual(plan.tool_calls[0].args, { window: '7d' });
  assert.equal(plan.requires_confirmation, false);
});

test('heuristic parser routes strategy size change to guarded config tool', () => {
  const plan = heuristicPlan('set smart_money size jadi 0.03 SOL');
  assert.equal(plan.intent, 'update_strategy_param');
  assert.equal(plan.tool_calls[0].tool, 'set_strategy_param');
  assert.equal(plan.tool_calls[0].args.strategyId, 'smart_money');
  assert.equal(plan.tool_calls[0].args.value, 0.03);
  assert.equal(plan.requires_confirmation, true);
});
