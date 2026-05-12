import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db/connection.js';
import { evaluateCandidateRisk } from './risk.js';

initDb();

test('risk guardrails block weak live candidates', () => {
  const result = evaluateCandidateRisk({
    metrics: { liquidityUsd: 100, holderCount: 10 },
    holders: { top20Percent: 90 },
    trending: { rug_ratio: 0.9, bundler_rate: 0.9 },
  }, 1);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some(reason => reason.includes('position size')));
  assert.ok(result.reasons.some(reason => reason.includes('liquidity')));
  assert.ok(result.reasons.some(reason => reason.includes('holders')));
});
