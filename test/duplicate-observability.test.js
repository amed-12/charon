import assert from 'node:assert/strict';

import { db, initDb } from '../src/db/connection.js';
import {
  normalizeDuplicateReason,
  recordShadowDuplicateCheck,
} from '../src/observability/duplicateAudit.js';

initDb();

assert.equal(normalizeDuplicateReason('open_position'), 'open_position');
assert.equal(normalizeDuplicateReason('recently_closed'), 'closed_72h');
assert.equal(normalizeDuplicateReason('recent_decision'), 'decision_24h');
assert.equal(normalizeDuplicateReason('recent_candidate'), 'candidate_10m');
assert.equal(normalizeDuplicateReason('same_symbol'), 'same_symbol_24h');
assert.equal(normalizeDuplicateReason(null), 'none');

const fixtures = [
  { timestamp: 1_000, mint: 'MINT_PASS', symbol: 'PASS', route: 'pumpportal_graduated', duplicateResult: 'PASS', duplicateReason: null },
  { timestamp: 2_000, mint: 'MINT_OPEN', symbol: 'OPEN', route: 'pumpfun_pregrad', duplicateResult: 'REJECT', duplicateReason: 'open_position' },
  { timestamp: 3_000, mint: 'MINT_CLOSED', symbol: 'CLOSED', route: 'fee_claim', duplicateResult: 'REJECT', duplicateReason: 'recently_closed' },
  { timestamp: 4_000, mint: 'MINT_DECISION', symbol: 'DECISION', route: 'fee_trending', duplicateResult: 'REJECT', duplicateReason: 'recent_decision' },
  { timestamp: 5_000, mint: 'MINT_CANDIDATE', symbol: 'CANDIDATE', route: 'trenches_completed', duplicateResult: 'REJECT', duplicateReason: 'recent_candidate' },
  { timestamp: 6_000, mint: 'MINT_SYMBOL', symbol: 'SYMBOL', route: 'graduated', duplicateResult: 'REJECT', duplicateReason: 'same_symbol' },
];

for (const fixture of fixtures) {
  assert.equal(recordShadowDuplicateCheck({
    ...fixture,
    duplicateChecked: true,
  }), true);
}

const rows = db.prepare(`
  SELECT checked_at_ms, mint, symbol, route,
         duplicate_checked, duplicate_result, duplicate_reason
  FROM shadow_duplicate_audit
  ORDER BY id
`).all();

assert.equal(rows.length, fixtures.length);
assert.deepEqual(rows[0], {
  checked_at_ms: 1_000,
  mint: 'MINT_PASS',
  symbol: 'PASS',
  route: 'pumpportal_graduated',
  duplicate_checked: 1,
  duplicate_result: 'PASS',
  duplicate_reason: 'none',
});
assert.deepEqual(rows.slice(1).map(row => row.duplicate_reason), [
  'open_position',
  'closed_72h',
  'decision_24h',
  'candidate_10m',
  'same_symbol_24h',
]);

const candidateColumns = db.prepare('PRAGMA table_info(candidates)').all().map(row => row.name);
assert.equal(candidateColumns.includes('duplicate_result'), false);
assert.equal(candidateColumns.includes('duplicate_reason'), false);

console.log('=== Charon shadow duplicate observability tests complete ===');
