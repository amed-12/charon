import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDryRunPnl, shouldSimulateTxFailure, strategyBreakdown } from './performance.js';
import { readinessScore } from './readiness.js';
import { initDb } from '../db/connection.js';

initDb();

test('dry-run PnL applies slippage and fees', () => {
  const pnl = calculateDryRunPnl({
    sizeSol: 1,
    entryMcap: 100,
    exitMcap: 150,
    slippageBps: 300,
    platformFeeBps: 100,
    priorityFeeSol: 0.0005,
  });
  assert.equal(pnl.grossPnlSol, 0.5);
  assert.ok(pnl.netPnlSol < pnl.grossPnlSol);
  assert.ok(pnl.feesSol > 0);
});

test('failed transaction simulation respects rate', () => {
  assert.equal(shouldSimulateTxFailure(0, () => 0), false);
  assert.equal(shouldSimulateTxFailure(1, () => 0.99), true);
  assert.equal(shouldSimulateTxFailure(0.03, () => 0.02), true);
  assert.equal(shouldSimulateTxFailure(0.03, () => 0.5), false);
});

test('strategy comparison returns known strategy rows', () => {
  const rows = strategyBreakdown('all');
  assert.deepEqual(rows.map(row => row.strategyId).sort(), ['degen', 'dip_buy', 'smart_money', 'sniper']);
});

test('readiness score is conservative', () => {
  const readiness = readinessScore();
  assert.ok(readiness.score >= 0);
  assert.ok(readiness.score <= 100);
  assert.notEqual(readiness.status, 'READY FOR FULL LIVE');
});
