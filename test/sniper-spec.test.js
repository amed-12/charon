process.env.DB_PATH = ':memory:';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SNIPER_CONFIG, freshGraduateCandidate, sniperCandidate } from './fixtures/sniperSpec.js';

const [
  { initDb, db },
  { buildCandidate },
  { evaluateCandidateFilters },
  {
    computeSoftScore,
    dynamicSoftScoreThreshold,
    evaluateSniperHardFilters,
    momentumFeatures,
    preScoreCandidate,
  },
  { applySniperDecisionPipeline },
  { momentumFilter, MOMENTUM_MODEL, runMomentumPrediction },
  { buildRuleBasedDecision },
  { checkDuplicateCandidate, checkPastWinGuard, DUPLICATE_WINDOWS },
  { canOpenPositionAtCount, resolvePositionConfig },
  {
    atrStopPercent,
    evaluatePositionSignals,
    maxHoldExpired,
    standardExitReason,
    trailingExitHit,
  },
  { refreshCandidateForExecution },
  { sniperRouteForSignal },
  { isPregradRssrInWindow },
  { PUMPPORTAL_SUBSCRIPTIONS },
  { DRY_RUN_SLIPPAGE_BPS },
] = await Promise.all([
  import('../src/db/connection.js'),
  import('../src/pipeline/candidateBuilder.js'),
  import('../src/pipeline/candidateFilter.js'),
  import('../src/pipeline/sniperPolicy.js'),
  import('../src/pipeline/sniperPipeline.js'),
  import('../src/pipeline/momentumFilter.js'),
  import('../src/pipeline/ruleBasedDecision.js'),
  import('../src/pipeline/duplicateGuard.js'),
  import('../src/db/positionConfig.js'),
  import('../src/execution/positionPolicy.js'),
  import('../src/execution/positions.js'),
  import('../src/signals/sniperRoutes.js'),
  import('../src/signals/pumpfunPregrad.js'),
  import('../src/signals/pumpportal.js'),
  import('../src/config.js'),
]);
const { beginLivePosition, createDryRunPosition } = await import('../src/db/positions.js');

initDb();

// Hard filters and route exceptions.
const established = sniperCandidate();
assert.equal(evaluateCandidateFilters(established, SNIPER_CONFIG).passed, true);
assert.equal(evaluateSniperHardFilters(established, SNIPER_CONFIG).passed, true);

const legacyStrategyResult = evaluateCandidateFilters(established, {
  ...SNIPER_CONFIG,
  id: 'dip_buy',
  name: 'Dip Buy',
  use_llm: true,
});
assert.equal(typeof legacyStrategyResult.passed, 'boolean', 'Kaiser non-Sniper filter path remains executable');

for (const [field, value, fragment] of [
  ['liquidityUsd', 5_999, 'liquidity'],
  ['gmgnBuySellRatio', 0.99, 'GMGN buy/sell ratio'],
]) {
  const result = evaluateCandidateFilters(sniperCandidate({ metrics: { [field]: value } }), SNIPER_CONFIG);
  assert.equal(result.passed, false, `${field} must be a hard rejection`);
  assert.ok(result.failures.some(value => value.includes(fragment)));
}
function withJupiterFlow({ priceChange = 1, numNetBuyers = 2, numTraders = 10 } = {}) {
  return sniperCandidate({
    jupiterAsset: {
      stats1h: priceChange === 'missing' ? {} : { priceChange },
      stats5m: {
        ...(numNetBuyers === 'missing' ? {} : { numNetBuyers }),
        ...(numTraders === 'missing' ? {} : { numTraders }),
      },
    },
  });
}

for (const [priceChange, passed] of [
  [-0.01, false], [0, true], [0.01, true], ['missing', true], [Number.NaN, true],
]) {
  const result = evaluateCandidateFilters(withJupiterFlow({ priceChange }), SNIPER_CONFIG);
  assert.equal(result.passed, passed, `Jupiter 1h priceChange=${String(priceChange)}`);
}
for (const [numNetBuyers, numTraders, passed] of [
  [1.999, 10, false], [2, 10, true], [2.001, 10, true],
  ['missing', 10, true], [2, 'missing', true], [2, 0, true],
  [Number.NaN, 10, true], [2, Number.POSITIVE_INFINITY, true],
]) {
  const result = evaluateCandidateFilters(
    withJupiterFlow({ numNetBuyers, numTraders }),
    SNIPER_CONFIG,
  );
  assert.equal(result.passed, passed, `Jupiter 5m flow=${String(numNetBuyers)}/${String(numTraders)}`);
}
assert.equal(
  evaluateCandidateFilters(sniperCandidate({ trending: { is_wash_trading: true } }), SNIPER_CONFIG).passed,
  false,
  'wash trading is fail-closed',
);

const fresh = freshGraduateCandidate();
assert.equal(evaluateCandidateFilters(fresh, SNIPER_CONFIG).passed, true, 'fresh route skips GMGN buy pressure');
assert.equal(
  evaluateCandidateFilters(freshGraduateCandidate({ graduation: { migrationSeconds: 0 } }), SNIPER_CONFIG).passed,
  false,
  'zero-second migration is rejected',
);
assert.equal(
  evaluateCandidateFilters(freshGraduateCandidate({ jupiterAsset: null }), SNIPER_CONFIG).passed,
  false,
  'fresh route requires Jupiter asset data',
);
assert.equal(
  evaluateCandidateFilters(freshGraduateCandidate({ metrics: { holderCount: 0 } }), SNIPER_CONFIG).passed,
  false,
  'fresh route requires at least one holder',
);
assert.equal(evaluateCandidateFilters(sniperCandidate({ metrics: { liquidityUsd: 6_000 } }), SNIPER_CONFIG).passed, true);
assert.equal(evaluateCandidateFilters(sniperCandidate({
  metrics: { priceChange1h: 0 },
  jupiterAsset: { stats1h: { priceChange: 0, numOrganicBuyers: 10 } },
}), SNIPER_CONFIG).passed, true);
assert.equal(evaluateCandidateFilters(sniperCandidate({ metrics: { netBuyerRatio5m: 0.2 } }), SNIPER_CONFIG).passed, true);
assert.equal(evaluateCandidateFilters(sniperCandidate({ metrics: { gmgnBuySellRatio: 1 } }), SNIPER_CONFIG).passed, true);
assert.equal(evaluateCandidateFilters(sniperCandidate({ feeClaim: null }), SNIPER_CONFIG).passed, true, 'fee claim is disabled');
assert.equal(evaluateCandidateFilters(sniperCandidate({ createdAtMs: -1 }), SNIPER_CONFIG).passed, true, 'token age hard filter is disabled');
assert.equal(
  evaluateCandidateFilters(sniperCandidate({ chart: { distanceFromAthPercent: 25 } }), SNIPER_CONFIG).passed,
  true,
  'ATH hard filter is disabled',
);

const auditOnlyRisk = sniperCandidate({
  jupiterAsset: {
    audit: { botHoldersCount: 500, botHoldersPercentage: 99, topHoldersPercentage: 99, devMigrations: 99 },
  },
});
assert.equal(
  evaluateCandidateFilters(auditOnlyRisk, SNIPER_CONFIG).passed,
  true,
  'v40 audit metrics are scored but are not hard filters',
);
assert.equal(
  evaluateCandidateFilters(sniperCandidate({ signals: { route: 'dual_source' } }), SNIPER_CONFIG).passed,
  false,
  'unsupported routes do not enter Sniper',
);

// Route-aware enrichment: fresh is intentionally Jupiter-only; established adds GMGN,
// chart, wallet exposure, and narrative enrichment.
function enrichmentDependencies(calls) {
  const gmgn = {
    name: 'GMGN', symbol: 'GMGN', liquidity: 12_000, market_cap: 50_000, holder_count: 120,
    price: { price: 0.01, price_1m: 0.0098, price_5m: 0.0095, price_1h: 0.009, buys_5m: 20, sells_5m: 10 },
    stat: { bot_degen_count: 0, bot_degen_rate: 0, top_10_holder_rate: 0.1 }, link: {},
  };
  const asset = {
    name: 'Asset', symbol: 'ASSET', usdPrice: 0.01, mcap: 50_000, liquidity: 12_000,
    holderCount: 120, organicScore: 80,
    stats1h: { priceChange: 10, numOrganicBuyers: 10 },
    stats5m: { priceChange: 5, numNetBuyers: 30, numTraders: 60, numOrganicBuyers: 10 },
    audit: {},
  };
  const holders = { count: 120, holders: [{ address: 'saved' }], top20: [], top20Percent: 10, maxHolderPercent: 5 };
  return {
    activeStrategy: () => SNIPER_CONFIG,
    now: () => 1234,
    fetchGmgnTokenInfo: async () => { calls.push('gmgn'); return gmgn; },
    fetchJupiterAsset: async () => { calls.push('asset'); return asset; },
    fetchJupiterHolders: async () => { calls.push('holders'); return holders; },
    fetchJupiterChartContext: async () => { calls.push('chart'); return { distanceFromAthPercent: -40 }; },
    fetchSavedWalletExposure: async () => { calls.push('wallets'); return { holderCount: 1, checked: 1, holders: ['saved'] }; },
    fetchTwitterNarrative: async () => { calls.push('twitter'); return { text: 'fixture' }; },
  };
}

{
  const calls = [];
  const candidate = await buildCandidate({
    mint: fresh.token.mint,
    graduatedCoin: { ticker: 'FRESH', migrationSeconds: 12 },
    route: 'pumpportal_graduated',
  }, enrichmentDependencies(calls));
  assert.equal(candidate.filters.passed, true);
  assert.deepEqual(calls.sort(), ['asset', 'holders']);
}
{
  const calls = [];
  const candidate = await buildCandidate({
    mint: established.token.mint,
    fee: { mint: established.token.mint, distributed: 100_000_000n, shareholders: [] },
    trendingToken: { is_wash_trading: false, bundler_rate: 0.05, smart_degen_count: 10 },
    route: 'fee_trending',
  }, enrichmentDependencies(calls));
  assert.equal(candidate.filters.passed, true);
  assert.deepEqual(calls.sort(), ['asset', 'chart', 'gmgn', 'holders', 'twitter', 'wallets']);
}

// Soft score, dynamic threshold, and separate pre-score.
const scored = computeSoftScore(established);
assert.equal(scored.score, 150);
assert.equal(dynamicSoftScoreThreshold(0, 5), 20);
assert.equal(dynamicSoftScoreThreshold(1, 5), 30);
assert.equal(dynamicSoftScoreThreshold(4, 5), 40);
assert.equal(dynamicSoftScoreThreshold(5, 5), 40);
assert.equal(preScoreCandidate(established).score, 100);
assert.equal(preScoreCandidate(established).passed, true);

const missingOptionalScoreData = computeSoftScore({
  signals: { route: 'graduated' },
  metrics: { liquidityUsd: 12_000 },
  chart: null,
  gmgn: null,
  jupiterAsset: null,
  trending: null,
});
assert.equal(missingOptionalScoreData.score, 100, 'missing optional metrics must not create a score component');
assert.equal(missingOptionalScoreData.components.length, 0);

const unusualTop10 = computeSoftScore(freshGraduateCandidate({
  metrics: { bundlerRate: 0.4, organicScore: 0, trendingSmartDegenCount: 0 },
  chart: { distanceFromAthPercent: -40 },
  jupiterAsset: { audit: { topHoldersPercentage: 20 } },
}));
assert.equal(unusualTop10.components.find(row => row.name === 'top10_pumpportal')?.points, -30);
const highTop10 = computeSoftScore(freshGraduateCandidate({
  metrics: { bundlerRate: 0.4, organicScore: 0, trendingSmartDegenCount: 0 },
  chart: { distanceFromAthPercent: -40 },
  jupiterAsset: { audit: { topHoldersPercentage: 60 } },
}));
assert.equal(highTop10.components.find(row => row.name === 'top10_pumpportal')?.points, -20);

// Momentum schema/order, threshold, and intentional fail-open behavior.
assert.deepEqual(Object.keys(momentumFeatures(established).features), MOMENTUM_MODEL.featureOrder);
assert.equal((await momentumFilter(established, { runPrediction: async () => ({ runner_probability: 0.5 }) })).passed, true);
assert.equal((await momentumFilter(established, { runPrediction: async () => ({ runner_probability: 0.499 }) })).passed, false);
const modelError = await momentumFilter(established, { runPrediction: async () => { throw new Error('model offline'); } });
assert.equal(modelError.passed, true);
assert.equal(modelError.failsafe, true);
assert.equal(modelError.status, 'model_error');
const timeout = await momentumFilter(established, {
  runPrediction: async () => { throw Object.assign(new Error('timeout'), { killed: true }); },
});
assert.equal(timeout.passed, true);
assert.equal(timeout.status, 'timeout');
const missingMl = await momentumFilter({});
assert.equal(missingMl.passed, true);
assert.equal(missingMl.status, 'missing_data');
const savedModelPath = process.env.MOMENTUM_MODEL_PATH;
process.env.MOMENTUM_MODEL_PATH = '/tmp/charon-definitely-missing-momentum-model.joblib';
const missingArtifact = await momentumFilter(established);
if (savedModelPath == null) delete process.env.MOMENTUM_MODEL_PATH;
else process.env.MOMENTUM_MODEL_PATH = savedModelPath;
assert.equal(missingArtifact.passed, true);
assert.equal(missingArtifact.failsafe, true);
assert.equal(missingArtifact.status, 'model_error');
assert.match(missingArtifact.error, /artifact not found/i);
const slowMomentumScript = fileURLToPath(new URL('./fixtures/slow_momentum.py', import.meta.url));
const actualTimeout = await momentumFilter(established, {
  runPrediction: features => runMomentumPrediction(features, { timeoutMs: 20, script: slowMomentumScript }),
});
assert.equal(actualTimeout.passed, true);
assert.equal(actualTimeout.failsafe, true);
assert.equal(actualTimeout.status, 'timeout');

const pipelineCandidate = sniperCandidate();
pipelineCandidate.filters = evaluateCandidateFilters(pipelineCandidate, SNIPER_CONFIG);
let predictionCalls = 0;
const pipeline = await applySniperDecisionPipeline(pipelineCandidate, {
  openPositionCount: 1,
  maxPositions: 5,
  runPrediction: async () => { predictionCalls += 1; return { runner_probability: 0.8 }; },
});
assert.equal(pipeline.passed, true);
assert.equal(predictionCalls, 1);
assert.deepEqual(Object.keys(pipeline), ['hardFilters', 'softScore', 'preScore', 'momentum', 'passed', 'failedStage']);

const hardRejected = sniperCandidate({ metrics: { liquidityUsd: 1 } });
hardRejected.filters = evaluateCandidateFilters(hardRejected, SNIPER_CONFIG);
predictionCalls = 0;
assert.equal((await applySniperDecisionPipeline(hardRejected, {
  runPrediction: async () => { predictionCalls += 1; return { runner_probability: 1 }; },
})).failedStage, 'hard_filters');
assert.equal(predictionCalls, 0, 'ML cannot run before hard filters pass');

const softRejected = freshGraduateCandidate({
  metrics: { holderCount: 29, liquidityUsd: 6_000, bundlerRate: 0.4, organicScore: 0, trendingSmartDegenCount: 0 },
  jupiterAsset: {
    liquidity: 6_000, holderCount: 29, organicScore: 0,
    stats1h: { priceChange: 1, numOrganicBuyers: 0 },
    stats5m: { numNetBuyers: 30, numTraders: 60, numOrganicBuyers: 0 },
    audit: { botHoldersCount: 80, botHoldersPercentage: 99, topHoldersPercentage: 20, devMigrations: 15 },
  },
  chart: { distanceFromAthPercent: -20 },
});
softRejected.filters = evaluateCandidateFilters(softRejected, SNIPER_CONFIG);
predictionCalls = 0;
assert.equal((await applySniperDecisionPipeline(softRejected, {
  openPositionCount: 1,
  maxPositions: 5,
  runPrediction: async () => { predictionCalls += 1; return { runner_probability: 1 }; },
})).failedStage, 'soft_score');
assert.equal(predictionCalls, 0, 'ML cannot run before soft score passes');

const preRejected = sniperCandidate({
  metrics: { marketCapUsd: 5_000, holderCount: 1, bundlerRate: 0.4, organicScore: 0, trendingSmartDegenCount: 0 },
  trending: { smart_degen_count: 0, bundler_rate: 0.4 },
  jupiterAsset: {
    mcap: 5_000, holderCount: 1, organicScore: 0,
    stats1h: { priceChange: 10, numOrganicBuyers: 0 },
    stats5m: { priceChange: 5, numNetBuyers: 30, numTraders: 60, numOrganicBuyers: 0 },
  },
});
preRejected.filters = evaluateCandidateFilters(preRejected, SNIPER_CONFIG);
predictionCalls = 0;
assert.equal((await applySniperDecisionPipeline(preRejected, {
  runPrediction: async () => { predictionCalls += 1; return { runner_probability: 1 }; },
})).failedStage, 'pre_score');
assert.equal(predictionCalls, 0, 'ML cannot run before pre-score passes');

// Successful Sniper candidates use the non-LLM BUY/100 decision.
const selectedRow = { id: 7, candidate: pipelineCandidate };
const decision = buildRuleBasedDecision(7, pipelineCandidate, selectedRow, SNIPER_CONFIG);
assert.equal(decision.verdict, 'BUY');
assert.equal(decision.confidence, 100);
assert.equal(SNIPER_CONFIG.use_llm, false);

// Duplicate checks are intentionally ordered and use cross-route candidate identity.
const atMs = 10 * DUPLICATE_WINDOWS.recentlyClosedMs;
function clearDuplicateTables() {
  db.prepare('DELETE FROM llm_decisions').run();
  db.prepare('DELETE FROM candidates').run();
  db.prepare('DELETE FROM dry_run_positions').run();
}
function insertPosition({ mint, symbol = 'SNIPE', status = 'closed', openedAt = atMs - 1_000, closedAt = atMs - 500, pnl = -1 }) {
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
      tp_percent, sl_percent, trailing_enabled, trailing_percent, snapshot_json, pnl_percent
    ) VALUES (?, ?, ?, ?, ?, 0.1, 50000, 75, -35, 1, 10, '{}', ?)
  `).run(mint, symbol, status, openedAt, status === 'closed' ? closedAt : null, pnl);
}

clearDuplicateTables();
insertPosition({ mint: established.token.mint, status: 'open' });
assert.equal(checkDuplicateCandidate({ mint: established.token.mint, atMs }).rule, 'open_position');
clearDuplicateTables();
insertPosition({ mint: established.token.mint, closedAt: atMs - DUPLICATE_WINDOWS.recentlyClosedMs + 1 });
assert.equal(checkDuplicateCandidate({ mint: established.token.mint, atMs }).rule, 'recently_closed');
clearDuplicateTables();
db.prepare(`INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, risks_json, raw_json)
  VALUES (1, ?, ?, 'BUY', 100, '[]', '{}')`).run(established.token.mint, atMs - 1);
assert.equal(checkDuplicateCandidate({ mint: established.token.mint, atMs }).rule, 'recent_decision');
clearDuplicateTables();
db.prepare(`INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signal_key, candidate_json, filter_result_json)
  VALUES (?, 'filtered', ?, ?, 'other-route-key', '{}', '{}')`).run(established.token.mint, atMs - 1, atMs - 1);
assert.equal(checkDuplicateCandidate({ mint: established.token.mint, atMs }).rule, 'recent_candidate');
clearDuplicateTables();
insertPosition({ mint: 'CopycatMint111111111111111111111111111111', symbol: established.token.symbol });
assert.equal(checkDuplicateCandidate({ mint: established.token.mint, symbol: established.token.symbol, atMs }).rule, 'same_symbol');
clearDuplicateTables();
insertPosition({ mint: established.token.mint, pnl: 10 });
assert.equal(checkPastWinGuard(established.token.mint).allowed, false);

// Fresh data is re-fetched and re-filtered before execution. Fresh graduates must stay on
// the light Jupiter-only path even during this second check.
const initialFresh = freshGraduateCandidate();
initialFresh.filters = evaluateCandidateFilters(initialFresh, SNIPER_CONFIG);
const refreshCalls = [];
const snapshots = [];
const refreshed = await refreshCandidateForExecution({ id: 42, candidate: initialFresh }, {
  fetchGmgnTokenInfo: async () => { refreshCalls.push('gmgn'); throw new Error('fresh route must not call GMGN'); },
  fetchJupiterAsset: async () => {
    refreshCalls.push('asset');
    return {
      usdPrice: 0.01, mcap: 50_000, liquidity: 5_999, holderCount: 120, organicScore: 80,
      stats1h: { priceChange: 10 }, stats5m: { numNetBuyers: 30, numTraders: 60 }, audit: {},
    };
  },
  fetchJupiterHolders: async () => { refreshCalls.push('holders'); return initialFresh.holders; },
  fetchJupiterChartContext: async () => { refreshCalls.push('chart'); throw new Error('fresh route must not call chart'); },
  fetchSavedWalletExposure: async () => { refreshCalls.push('wallets'); throw new Error('fresh route must not call wallets'); },
  getTrendingToken: () => null,
  filterCandidate: candidate => evaluateCandidateFilters(candidate, SNIPER_CONFIG),
  now: () => atMs,
  updateCandidateSnapshot: (...args) => snapshots.push(args),
});
assert.equal(refreshed.candidate.filters.passed, false);
assert.ok(refreshed.candidate.filters.failures.some(value => value.includes('liquidity')));
assert.deepEqual(refreshCalls.sort(), ['asset', 'holders']);
assert.equal(snapshots[0][2], 'filtered');

// Position sizing, capacity, exits, ATR bounds, trailing, max hold, and dry-run slippage.
assert.deepEqual(resolvePositionConfig(SNIPER_CONFIG, decision), {
  sizeSol: 0.1,
  tpPercent: 75,
  slPercent: -35,
  trailingEnabled: 1,
  trailingPercent: 10,
});
assert.equal(canOpenPositionAtCount(4, SNIPER_CONFIG), true);
assert.equal(canOpenPositionAtCount(5, SNIPER_CONFIG), false);
clearDuplicateTables();
for (let index = 0; index < 5; index += 1) {
  insertPosition({ mint: `CapacityMint${index}`, symbol: `CAP${index}`, status: 'open' });
}
assert.throws(
  () => beginLivePosition(null, established, decision, 'capacity_fixture'),
  /max open positions/,
);
clearDuplicateTables();
assert.equal(DRY_RUN_SLIPPAGE_BPS, 200);
const dryPosition = createDryRunPosition(null, established, decision, 'dry_run_contract');
const dryRow = db.prepare('SELECT execution_mode, size_sol, entry_mcap FROM dry_run_positions WHERE id = ?').get(dryPosition.id);
assert.equal(dryRow.execution_mode, 'dry_run');
assert.equal(dryRow.size_sol, 0.1);
assert.equal(dryRow.entry_mcap, established.metrics.marketCapUsd * 1.02, 'dry-run entry applies 2% slippage');
clearDuplicateTables();
assert.equal(atrStopPercent(-35, null), -35);
assert.equal(atrStopPercent(-35, 2), -8);
assert.equal(atrStopPercent(-35, 10), -25);
assert.equal(atrStopPercent(-35, 30), -50);

const belowTrailingArm = evaluatePositionSignals({
  hasLiveQuote: true, pnlPercent: 74.9, tpPercent: 75, slPercent: -35,
  trailingArmed: 0, trailingEnabled: 1, mcap: 174.9, highWaterMcap: 174.9,
});
assert.equal(belowTrailingArm.trailingArmed, false);
const trailingArmed = evaluatePositionSignals({
  hasLiveQuote: true, pnlPercent: 75, tpPercent: 75, slPercent: -35,
  trailingArmed: 0, trailingEnabled: 1, mcap: 175, highWaterMcap: 175,
});
assert.equal(trailingArmed.trailingArmed, true, 'runtime-authoritative Sniper trailing arm is +75%');
assert.equal(standardExitReason({ slHit: true, tpHit: false, trailingEnabled: 1, trailingHit: false }), 'SL');
assert.equal(standardExitReason({ slHit: false, tpHit: true, trailingEnabled: 0, trailingHit: false }), 'TP');
assert.equal(standardExitReason({ slHit: false, tpHit: true, trailingEnabled: 1, trailingHit: false }), null, 'fixed TP does not close while trailing is enabled');
assert.equal(trailingExitHit({
  hasLiveQuote: true, trailingArmed: true, trailingEnabled: 1, trailDrop: -10, trailingPercent: 10,
}), true);
assert.equal(standardExitReason({ slHit: false, tpHit: false, trailingEnabled: 1, trailingHit: true }), 'TRAILING_TP');
assert.equal(maxHoldExpired(1_800_000, 100, 1_800_100), true);

assert.deepEqual(PUMPPORTAL_SUBSCRIPTIONS, ['subscribeNewToken', 'subscribeMigration']);
assert.equal(sniperRouteForSignal({ sources: ['pumpportal_graduated'] }, {}), 'pumpportal_graduated');
assert.equal(isPregradRssrInWindow(76.49e9, 76.5e9, 85e9), false);
assert.equal(isPregradRssrInWindow(76.5e9, 76.5e9, 85e9), true);
assert.equal(isPregradRssrInWindow(80e9, 76.5e9, 85e9), true);
assert.equal(isPregradRssrInWindow(85e9, 76.5e9, 85e9), true);
assert.equal(isPregradRssrInWindow(85.01e9, 76.5e9, 85e9), false);
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'], rssrSol: 76.5 }, {}), 'pumpfun_pregrad');
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'], rssrSol: 80 }, {}), 'pumpfun_pregrad');
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'], real_sol_reserves: 85_000_000_000 }, {}), 'pumpfun_pregrad');
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'], rssrSol: 76.49 }, {}), null);
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'], rssrSol: 85.01 }, {}), null);
assert.equal(sniperRouteForSignal({ sources: ['pumpfun_pregrad'] }, {}), null);
assert.equal(sniperRouteForSignal({ sources: ['trenches_completed'] }, {}), 'trenches_completed');
assert.equal(sniperRouteForSignal({ sources: ['fee_claim'] }, { hasFee: true, hasTrending: false }), 'fee_claim');
assert.equal(sniperRouteForSignal({ sources: ['fee_claim'] }, { hasFee: true, hasTrending: true }), 'fee_trending');
assert.equal(sniperRouteForSignal({ sources: ['helius_graduated'] }, {}), 'graduated');

assert.equal(sniperRouteForSignal({ sources: ['jupiter_trending'] }, { hasGraduated: true, hasTrending: true }), null);
console.log('=== Charon Sniper specification tests complete ===');
