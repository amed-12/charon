process.env.DB_PATH = ':memory:';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

import assert from 'node:assert/strict';

const [
  { initDb, db },
  { checkDuplicateCandidate, DUPLICATE_WINDOWS },
] = await Promise.all([
  import('../src/db/connection.js'),
  import('../src/pipeline/duplicateGuard.js'),
]);

initDb();
const atMs = 10 * DUPLICATE_WINDOWS.recentlyClosedMs;
const mint = 'BoundaryMint111111111111111111111111111111';
const symbol = 'BOUNDARY';

function clear() {
  db.prepare('DELETE FROM llm_decisions').run();
  db.prepare('DELETE FROM candidates').run();
  db.prepare('DELETE FROM dry_run_positions').run();
}

function insertPosition({ targetMint = mint, targetSymbol = symbol, status = 'closed', closedAt = atMs - 1 }) {
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
      tp_percent, sl_percent, trailing_enabled, trailing_percent, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, 0.1, 50000, 75, -35, 1, 10, '{}')
  `).run(targetMint, targetSymbol, status, atMs - 1_000, status === 'closed' ? closedAt : null);
}

insertPosition({ status: 'open' });
db.prepare(`INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, risks_json, raw_json)
  VALUES (1, ?, ?, 'BUY', 100, '[]', '{}')`).run(mint, atMs - 1);
assert.equal(checkDuplicateCandidate({ mint, symbol, atMs }).rule, 'open_position', 'open-position guard has first priority');
clear();
insertPosition({ status: 'entering' });
assert.equal(checkDuplicateCandidate({ mint, symbol, atMs }).rule, 'open_position', 'entering position counts as exposure');
clear();
insertPosition({ status: 'exiting' });
assert.equal(checkDuplicateCandidate({ mint, symbol, atMs }).rule, 'open_position', 'exiting position counts as exposure');

clear();
insertPosition({ closedAt: atMs - DUPLICATE_WINDOWS.recentlyClosedMs });
assert.equal(checkDuplicateCandidate({ mint, atMs }).rule, 'recently_closed', '72h cutoff is inclusive in executable SQL');
clear();
insertPosition({ closedAt: atMs - DUPLICATE_WINDOWS.recentlyClosedMs - 1 });
assert.equal(checkDuplicateCandidate({ mint, atMs }).duplicate, false);

clear();
db.prepare(`INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, risks_json, raw_json)
  VALUES (1, ?, ?, 'BUY', 100, '[]', '{}')`).run(mint, atMs - DUPLICATE_WINDOWS.recentDecisionMs);
assert.equal(checkDuplicateCandidate({ mint, atMs }).rule, 'recent_decision', '24h decision cutoff is inclusive in executable SQL');
clear();
db.prepare(`INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, risks_json, raw_json)
  VALUES (1, ?, ?, 'BUY', 100, '[]', '{}')`).run(mint, atMs - DUPLICATE_WINDOWS.recentDecisionMs - 1);
assert.equal(checkDuplicateCandidate({ mint, atMs }).duplicate, false);

clear();
db.prepare(`INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signal_key, candidate_json, filter_result_json)
  VALUES (?, 'filtered', ?, ?, 'different-route', '{}', '{}')`).run(
  mint, atMs - DUPLICATE_WINDOWS.recentCandidateMs, atMs - DUPLICATE_WINDOWS.recentCandidateMs,
);
assert.equal(checkDuplicateCandidate({ mint, atMs }).rule, 'recent_candidate', '10m candidate cutoff is inclusive and route-independent');
clear();
db.prepare(`INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signal_key, candidate_json, filter_result_json)
  VALUES (?, 'filtered', ?, ?, 'different-route', '{}', '{}')`).run(
  mint, atMs - DUPLICATE_WINDOWS.recentCandidateMs - 1, atMs - DUPLICATE_WINDOWS.recentCandidateMs - 1,
);
assert.equal(checkDuplicateCandidate({ mint, atMs }).duplicate, false);

clear();
insertPosition({
  targetMint: 'CopycatBoundaryMint111111111111111111111111',
  closedAt: atMs - DUPLICATE_WINDOWS.sameSymbolMs,
});
assert.equal(checkDuplicateCandidate({ mint, symbol, atMs }).rule, 'same_symbol', 'same-symbol 24h cutoff is inclusive');
clear();
insertPosition({
  targetMint: 'CopycatBoundaryMint111111111111111111111111',
  closedAt: atMs - DUPLICATE_WINDOWS.sameSymbolMs - 1,
});
assert.equal(checkDuplicateCandidate({ mint, symbol, atMs }).duplicate, false);

console.log('=== Charon Sniper duplicate-boundary tests complete ===');
