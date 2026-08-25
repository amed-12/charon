import assert from 'node:assert/strict';

import {
  buildParityReport,
  canonicalRoute,
  classifyPair,
  compareEnrichment,
  latencyStats,
  matchCandidates,
  summarizeDuplicateChecks,
  summarizeSourceEvents,
} from '../scripts/shadow_report.mjs';

function policy({ hard = true, hardFailures = [], soft = 100, pre = 40, decision = 'BUY' } = {}) {
  return {
    duplicate: { available: false, duplicate: null, reason: null },
    hard: { available: true, passed: hard, failures: hardFailures },
    soft: { available: true, score: soft, threshold: 30, passed: soft >= 30 },
    pre: { available: true, score: pre, threshold: 35, passed: pre >= 35 },
    momentum: { available: true, status: 'pass', probability: 0.75, reason: null },
    final: { available: decision != null, decision, confidence: decision ? 100 : null },
  };
}

function candidate(id, mint, atMs, route, overrides = {}) {
  return {
    id, mint, atMs, route: canonicalRoute(route), rawRoute: route, status: 'buy',
    enrichment: {
      market_cap: 50_000, liquidity: 10_000, holder_count: 100,
      jupiter_price_change_1h: 1, jupiter_net_buyers_5m: 20,
      jupiter_traders_5m: 100, net_buyer_ratio_5m: 0.2,
      gmgn_buy_sell_ratio: 1.5, smart_degen_count: 5, organic_score: 60,
      bundler_rate: 0.1, top10_percentage: 20, bot_holders: 10,
      bot_percentage: 5, developer_migrations: 1, ath_distance: -25,
      ...(overrides.enrichment || {}),
    },
    policy: overrides.policy || policy(),
  };
}

assert.equal(canonicalRoute('pumpportal_graduated'), 'pumpportal_graduated');
assert.equal(canonicalRoute('helius_graduated'), 'graduated');
assert.equal(canonicalRoute('anything', 'fee_claim'), 'fee_claim');
assert.equal(canonicalRoute('jupiter_trending', 'trending'), 'fee_trending');

const sourceSummary = summarizeSourceEvents([
  { mint: 'A', route: 'pumpportal_graduated', atMs: 100 },
  { mint: 'A', route: 'graduated', atMs: 120 },
  { mint: 'B', route: 'trenches_completed', atMs: 140 },
]);
assert.equal(sourceSummary.totalRawEvents, 3);
assert.equal(sourceSummary.uniqueMints, 2);
assert.equal(sourceSummary.routeOverlap.twoRoutes, 1);
assert.equal(sourceSummary.routeOverlap.oneRoute, 1);

const duplicateTelemetry = {
  available: true,
  checks: [
    {
      checkedAtMs: 100, mint: 'A', symbol: 'AAA', route: 'pumpportal_graduated',
      duplicateChecked: true, duplicateResult: 'PASS', duplicateReason: 'none',
    },
    {
      checkedAtMs: 200, mint: 'B', symbol: 'BBB', route: 'graduated',
      duplicateChecked: true, duplicateResult: 'REJECT', duplicateReason: 'closed_72h',
    },
    {
      checkedAtMs: 300, mint: 'C', symbol: 'CCC', route: 'fee_claim',
      duplicateChecked: true, duplicateResult: 'REJECT', duplicateReason: 'same_symbol_24h',
    },
  ],
};
const duplicateSummary = summarizeDuplicateChecks(duplicateTelemetry);
assert.equal(duplicateSummary.available, true);
assert.equal(duplicateSummary.totalChecks, 3);
assert.equal(duplicateSummary.pass, 1);
assert.equal(duplicateSummary.reject, 2);
assert.equal(duplicateSummary.rejectionReasons.closed_72h, 1);
assert.equal(duplicateSummary.rejectionReasons.same_symbol_24h, 1);
assert.equal(duplicateSummary.byRoute.pumpportal_graduated.pass, 1);
assert.equal(duplicateSummary.byRoute.graduated.reject, 1);
assert.equal(summarizeDuplicateChecks({ available: false, checks: [] }).available, false);

const kaiserRows = [
  candidate(1, 'A', 100_000, 'pumpportal_graduated'),
  candidate(2, 'B', 500_000, 'graduated'),
  candidate(3, 'K_ONLY', 900_000, 'fee_claim'),
];
const charonRows = [
  candidate(11, 'A', 140_000, 'graduated'),
  candidate(12, 'B', 620_000, 'graduated'),
  candidate(13, 'C_ONLY', 900_000, 'fee_claim'),
];
const matched = matchCandidates(kaiserRows, charonRows, {
  strictWindowMs: 60_000, looseWindowMs: 300_000,
});
assert.equal(matched.pairs.length, 2);
assert.equal(matched.pairs[0].window, 'strict');
assert.equal(matched.pairs[0].routeMatch, false);
assert.equal(matched.pairs[1].window, 'loose');
assert.equal(matched.pairs[1].routeMatch, true);
assert.equal(matched.kaiserOnly[0].mint, 'K_ONLY');
assert.equal(matched.charonOnly[0].mint, 'C_ONLY');

const timing = latencyStats(matched.pairs);
assert.equal(timing.samples, 2);
assert.equal(timing.absoluteDeltaMs.p50, 40_000);
assert.equal(timing.absoluteDeltaMs.p95, 120_000);
assert.equal(timing.absoluteDeltaMs.max, 120_000);

const enrichment = compareEnrichment(
  candidate(20, 'E', 1, 'fee_claim').enrichment,
  candidate(21, 'E', 1, 'fee_claim', {
    enrichment: { liquidity: 9_000, organic_score: null },
  }).enrichment,
);
assert.equal(enrichment.fields.liquidity.status, 'different');
assert.equal(enrichment.fields.liquidity.absoluteDelta, 1_000);
assert.equal(enrichment.fields.organic_score.status, 'missing_on_charon');
assert.equal(enrichment.fields.holder_count.status, 'same');

const failOpenPair = {
  window: 'strict', routeMatch: true,
  kaiser: candidate(30, 'FLOW', 1, 'fee_claim', {
    enrichment: { jupiter_price_change_1h: null, net_buyer_ratio_5m: null },
  }),
  charon: candidate(31, 'FLOW', 1, 'fee_claim', {
    enrichment: { jupiter_price_change_1h: null, net_buyer_ratio_5m: null },
    policy: policy({
      hard: false,
      hardFailures: ['5m net buyer ratio: missing < 0.2'],
      decision: null,
    }),
  }),
};
const failOpenEnrichment = compareEnrichment(
  failOpenPair.kaiser.enrichment, failOpenPair.charon.enrichment,
);
const classification = classifyPair(failOpenPair, failOpenEnrichment);
assert.ok(classification.all.includes('HARD_FILTER_DIFFERENCE'));
assert.ok(classification.all.includes('POLICY_VERSION_DIFFERENCE:JUPITER_FLOW_FAIL_OPEN'));
assert.ok(classification.all.includes('FINAL_DECISION_DIFFERENCE'));

const report = buildParityReport({
  kaiser: {
    sourceEvents: [{ mint: 'A', route: 'pumpportal_graduated', atMs: 100_000 }],
    candidates: kaiserRows,
    duplicateChecks: duplicateTelemetry,
  },
  charon: {
    sourceEvents: [{ mint: 'A', route: 'graduated', atMs: 140_000 }],
    candidates: charonRows,
    duplicateChecks: { available: false, checks: [] },
  },
  sinceMs: 0, untilMs: 1_000_000,
  strictWindowMs: 60_000, looseWindowMs: 300_000, lowSampleThreshold: 30,
});
assert.equal(report.candidateParity.strictMatched, 1);
assert.equal(report.candidateParity.looseOnlyMatched, 1);
assert.equal(report.candidateParity.sameRouteMatched, 1);
assert.equal(report.candidateParity.crossRouteMatched, 1);
assert.equal(report.candidateParity.matchUnion, 4);
assert.equal(report.candidateParity.matchJaccardRate, 0.5);
assert.equal(report.sourceParity.mintJaccard.rate, 1);
assert.equal(report.policyParity.comparablePairs, 2);
assert.equal(report.policyParity.sampleWarning, 'INSUFFICIENT SAMPLE');
assert.equal(report.policyParity.stages.final.comparable, 2);
assert.equal(report.policyParity.stages.final.identical, 2);
assert.equal(report.policyParity.stages.duplicate.comparable, 0);
assert.equal(report.duplicateFunnel.kaiser.totalChecks, 3);
assert.equal(report.duplicateFunnel.kaiser.pass, 1);
assert.equal(report.duplicateFunnel.kaiser.reject, 2);
assert.equal(report.duplicateFunnel.kaiser.byRoute.fee_claim.reject, 1);
assert.equal(report.duplicateFunnel.charon.available, false);
assert.equal(report.duplicateFunnel.referenceComparisonAvailable, false);
assert.ok(report.unresolved.some(value => value.includes('duplicate parity')));
assert.ok(report.unresolved.some(value => value.includes('Charon reference duplicate audit telemetry is unavailable')));

console.log('=== Charon shadow report V2 tests complete ===');
