import assert from 'node:assert/strict';
import { computeSoftScore, preScoreCandidate } from '../src/pipeline/sniperPolicy.js';

function isolatedScoreCandidate({
  route = 'graduated', liquidity = 12_000, marketCap = null, holders = null,
  botHolders = null, botPercentage = null, top10 = null, migrations = null,
  athDistance = null, bundlerRate = null, organicScore = null, smartDegenCount = null,
} = {}) {
  return {
    signals: { route },
    metrics: {
      liquidityUsd: liquidity,
      marketCapUsd: marketCap,
      holderCount: holders,
      bundlerRate,
      organicScore,
      trendingSmartDegenCount: smartDegenCount,
    },
    jupiterAsset: {
      organicScore,
      stats1h: { numOrganicBuyers: null },
      stats5m: { numOrganicBuyers: null },
      audit: {
        botHoldersCount: botHolders,
        botHoldersPercentage: botPercentage,
        topHoldersPercentage: top10,
        devMigrations: migrations,
      },
    },
    gmgn: { stat: {} },
    trending: null,
    chart: athDistance == null ? null : { distanceFromAthPercent: athDistance },
  };
}

function softPoints(name, options) {
  return computeSoftScore(isolatedScoreCandidate(options)).components
    .find(row => row.name === name)?.points ?? 0;
}

for (const [liquidity, expected] of [[2_999, -35], [3_000, -25], [5_000, -10], [10_000, 0]]) {
  assert.equal(softPoints('liquidity', { liquidity }), expected);
}
for (const [route, name, cases] of [
  ['pumpportal_graduated', 'bot_holders_pumpportal', [[80, -40], [50, -30], [30, -15], [29, 0]]],
  ['trenches_completed', 'bot_holders_trenches', [[100, -25], [50, -10], [49, 0]]],
  ['fee_trending', 'bot_holders_fee_trending', [[100, -30], [50, -15], [49, 0]]],
]) {
  for (const [botHolders, expected] of cases) assert.equal(softPoints(name, { route, botHolders }), expected);
}
for (const [botPercentage, expected] of [[50.01, -25], [30.01, -15], [30, 0]]) {
  assert.equal(softPoints('bot_percentage', { botPercentage }), expected);
}
for (const [route, name, cases] of [
  ['pumpportal_graduated', 'top10_pumpportal', [[15, -30], [25, -30], [50, -20], [26, 0]]],
  ['trenches_completed', 'top10_trenches', [[25, -20], [35, -20], [50, -15], [36, 0]]],
  ['graduated', 'top10_other', [[50, -20], [49.99, 0]]],
]) {
  for (const [top10, expected] of cases) assert.equal(softPoints(name, { route, top10 }), expected);
}
for (const [migrations, expected] of [[15, -30], [7, -20], [3, -5], [2, 0]]) {
  assert.equal(softPoints('developer_migrations', { migrations }), expected);
}
for (const [route, name, cases] of [
  ['pumpportal_graduated', 'holder_count_pumpportal', [[29, -20], [30, -10], [49, -10], [50, 0]]],
  ['trenches_completed', 'holder_count_trenches', [[29, -10], [30, 0]]],
]) {
  for (const [holders, expected] of cases) assert.equal(softPoints(name, { route, holders }), expected);
}
for (const [athDistance, expected] of [[-19.99, -15], [-20, -10], [-29.99, -10], [-30, 0]]) {
  assert.equal(softPoints('ath_distance', { athDistance }), expected);
}
assert.equal(softPoints('mcap_trenches', { route: 'trenches_completed', marketCap: 24_999 }), -15);
assert.equal(softPoints('mcap_fee_trending', { route: 'fee_trending', marketCap: 39_999 }), -15);
for (const [bundlerRate, expected] of [[0.5001, -20], [0.3001, -10], [0.3, 0]]) {
  assert.equal(softPoints('bundler_rate', { bundlerRate }), expected);
}
for (const [smartDegenCount, expected] of [[10, 25], [5, 15], [2, 5], [1, 0]]) {
  assert.equal(softPoints('smart_degen_count', { smartDegenCount }), expected);
}
for (const [organicScore, expected] of [[70, 20], [50, 10], [30, 5], [29, 0]]) {
  assert.equal(softPoints('organic_score', { organicScore }), expected);
}
for (const [bundlerRate, expected] of [[0.099, 15], [0.1, 5], [0.299, 5], [0.3, 0]]) {
  assert.equal(softPoints('clean_bundler', { bundlerRate }), expected);
}
assert.equal(softPoints('fresh_graduate_momentum', { route: 'pumpportal_graduated' }), 10);

function prePoints(name, options) {
  return preScoreCandidate(isolatedScoreCandidate(options)).components
    .find(row => row.name === name)?.points ?? 0;
}

// These assertions document the current reconstructed mapping; they are not evidence that
// the unavailable historical mapping used these feature bands.
for (const [smartDegenCount, expected] of [[10, 30], [5, 20], [2, 10], [1, 0]]) {
  assert.equal(prePoints('smart_degen_count', { smartDegenCount }), expected);
}
for (const [organicScore, expected] of [[70, 25], [50, 15], [30, 5], [29, 0]]) {
  assert.equal(prePoints('organic_score', { organicScore }), expected);
}
for (const [bundlerRate, expected] of [[0.099, 20], [0.1, 10], [0.299, 10], [0.3, 0]]) {
  assert.equal(prePoints('bundler_rate', { bundlerRate }), expected);
}
for (const [marketCap, expected] of [[25_000, 15], [100_000, 15], [10_000, 8], [250_000, 8], [9_999, 0]]) {
  assert.equal(prePoints('mcap_sweet_spot', { marketCap }), expected);
}
for (const [holders, expected] of [[100, 10], [50, 5], [49, 0]]) {
  assert.equal(prePoints('holder_count', { holders }), expected);
}
const prePass = preScoreCandidate(isolatedScoreCandidate({
  organicScore: 30, bundlerRate: 0.2, marketCap: 50_000, holders: 50,
}));
assert.equal(prePass.score, 35);
assert.equal(prePass.passed, true);
assert.equal(preScoreCandidate(isolatedScoreCandidate({
  organicScore: 30, bundlerRate: 0.2, marketCap: 50_000, holders: 49,
})).passed, false);

console.log('=== Charon Sniper score-tier tests complete ===');
