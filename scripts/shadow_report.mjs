import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

export const CANONICAL_ROUTES = Object.freeze([
  'pumpportal_graduated',
  'pumpfun_pregrad',
  'fee_claim',
  'fee_trending',
  'trenches_completed',
  'graduated',
  'other',
]);

const CONTINUOUS_FIELDS = new Set([
  'market_cap',
  'liquidity',
  'jupiter_price_change_1h',
  'net_buyer_ratio_5m',
  'gmgn_buy_sell_ratio',
  'organic_score',
  'bundler_rate',
  'top10_percentage',
  'bot_percentage',
  'ath_distance',
]);

const ENRICHMENT_FIELDS = Object.freeze([
  'market_cap',
  'liquidity',
  'holder_count',
  'jupiter_price_change_1h',
  'jupiter_net_buyers_5m',
  'jupiter_traders_5m',
  'net_buyer_ratio_5m',
  'gmgn_buy_sell_ratio',
  'smart_degen_count',
  'organic_score',
  'bundler_rate',
  'top10_percentage',
  'bot_holders',
  'bot_percentage',
  'developer_migrations',
  'ath_distance',
]);

export function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null) ?? null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function ratio(numerator, denominator) {
  const n = finite(numerator);
  const d = finite(denominator);
  return n != null && d != null && d > 0 ? n / d : null;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameArray(left = [], right = []) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function numericEqual(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Object.is(Number(left), Number(right));
}

export function canonicalRoute(value, kind = '') {
  const text = String(value || '').toLowerCase();
  const eventKind = String(kind || '').toLowerCase();
  if (text.includes('pumpportal') && (text.includes('graduat') || eventKind === 'pumpportal')) {
    return 'pumpportal_graduated';
  }
  if (text.includes('pregrad') || text.includes('pre_grad') || eventKind.includes('pregrad')) {
    return 'pumpfun_pregrad';
  }
  if (text.includes('trenches') || eventKind === 'trenches') return 'trenches_completed';
  if (text === 'graduated' || text.includes('helius_graduated')) return 'graduated';
  if (text === 'fee_trending') return 'fee_trending';
  if (text.startsWith('fee_') || text === 'fee_claim' || eventKind === 'fee_claim') return 'fee_claim';
  if (eventKind === 'trending' || text.includes('trending')) return 'fee_trending';
  return 'other';
}

function emptyRouteCounts() {
  return Object.fromEntries(CANONICAL_ROUTES.map(route => [route, 0]));
}

function countByRoute(rows) {
  const counts = emptyRouteCounts();
  for (const row of rows) counts[row.route] = (counts[row.route] || 0) + 1;
  return counts;
}

function uniqueMintsByRoute(rows) {
  const sets = Object.fromEntries(CANONICAL_ROUTES.map(route => [route, new Set()]));
  for (const row of rows) (sets[row.route] || sets.other).add(row.mint);
  return Object.fromEntries(Object.entries(sets).map(([route, mints]) => [route, mints.size]));
}

export function summarizeSourceEvents(events) {
  const byMint = new Map();
  for (const event of events) {
    if (!byMint.has(event.mint)) byMint.set(event.mint, new Set());
    byMint.get(event.mint).add(event.route);
  }
  const overlap = { oneRoute: 0, twoRoutes: 0, threeOrMoreRoutes: 0 };
  for (const routes of byMint.values()) {
    if (routes.size <= 1) overlap.oneRoute++;
    else if (routes.size === 2) overlap.twoRoutes++;
    else overlap.threeOrMoreRoutes++;
  }
  const timestamps = events.map(row => row.atMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    totalRawEvents: events.length,
    uniqueMints: byMint.size,
    eventsPerRoute: countByRoute(events),
    uniqueMintsPerRoute: uniqueMintsByRoute(events),
    firstEventAtMs: timestamps[0] ?? null,
    lastEventAtMs: timestamps.at(-1) ?? null,
    routeOverlap: overlap,
  };
}

function mintJaccard(left, right, route = null) {
  const leftMints = new Set(left.filter(row => route == null || row.route === route).map(row => row.mint));
  const rightMints = new Set(right.filter(row => route == null || row.route === route).map(row => row.mint));
  const intersection = [...leftMints].filter(mint => rightMints.has(mint)).length;
  const union = new Set([...leftMints, ...rightMints]).size;
  return {
    intersection,
    union,
    rate: union ? intersection / union : null,
  };
}

function extractEnrichment(candidate) {
  const asset = candidate.jupiterAsset || {};
  const audit = asset.audit || {};
  const stats1h = asset.stats1h || {};
  const stats5m = asset.stats5m || {};
  const gmgn = candidate.gmgn || {};
  const gmgnPrice = gmgn.price || {};
  const gmgnStat = gmgn.stat || {};
  const sniperMetrics = candidate.sniperPipeline?.hardFilters?.sniperMetrics
    || candidate.hardFilters?.sniperMetrics
    || candidate.filters?.sniperMetrics
    || {};
  const netBuyers = firstFinite(stats5m.numNetBuyers);
  const traders = firstFinite(stats5m.numTraders);
  const gmgnBuys = firstFinite(gmgnPrice.buys_5m, gmgn.buys_5m);
  const gmgnSells = firstFinite(gmgnPrice.sells_5m, gmgn.sells_5m);
  const gmgnRatio = firstFinite(sniperMetrics.gmgnBuySellRatio, candidate.metrics?.gmgnBuySellRatio)
    ?? (gmgnBuys != null && gmgnSells != null
      ? (gmgnSells === 0 ? (gmgnBuys > 0 ? Number.POSITIVE_INFINITY : null) : gmgnBuys / gmgnSells)
      : null);
  return {
    market_cap: firstFinite(candidate.metrics?.marketCapUsd, sniperMetrics.marketCap, asset.mcap, asset.fdv),
    liquidity: firstFinite(candidate.metrics?.liquidityUsd, sniperMetrics.liquidity, asset.liquidity),
    holder_count: firstFinite(candidate.metrics?.holderCount, sniperMetrics.holderCount, asset.holderCount),
    jupiter_price_change_1h: firstFinite(stats1h.priceChange),
    jupiter_net_buyers_5m: netBuyers,
    jupiter_traders_5m: traders,
    net_buyer_ratio_5m: ratio(netBuyers, traders),
    gmgn_buy_sell_ratio: gmgnRatio,
    smart_degen_count: firstFinite(sniperMetrics.smartDegenCount, candidate.metrics?.trendingSmartDegenCount),
    organic_score: firstFinite(sniperMetrics.organicScore, asset.organicScore),
    bundler_rate: firstFinite(sniperMetrics.bundlerRate, gmgnStat.top_bundler_trader_percentage),
    top10_percentage: firstFinite(sniperMetrics.top10Percentage, audit.topHoldersPercentage),
    bot_holders: firstFinite(sniperMetrics.botHolderCount, audit.botHoldersCount, gmgnStat.bot_degen_count),
    bot_percentage: firstFinite(sniperMetrics.botPercentage, audit.botHoldersPercentage, gmgnStat.bot_degen_rate),
    developer_migrations: firstFinite(sniperMetrics.developerMigrations, audit.devMigrations, gmgnStat.creator_created_count),
    ath_distance: firstFinite(sniperMetrics.athDistance, candidate.chart?.distanceFromAthPercent),
  };
}

function stageValue(candidate, filterResult, decision) {
  const pipeline = candidate.sniperPipeline || {};
  const hard = pipeline.hardFilters || candidate.hardFilters || candidate.filters || filterResult || {};
  const soft = pipeline.softScore || {};
  const pre = pipeline.preScore || {};
  const momentum = pipeline.momentum || {};
  const duplicate = candidate.duplicate || pipeline.duplicate || null;
  const softScore = finite(soft.score);
  const softThreshold = finite(soft.threshold);
  const preScore = finite(pre.score);
  const preThreshold = finite(pre.threshold);
  return {
    duplicate: duplicate ? {
      available: true,
      duplicate: Boolean(duplicate.duplicate),
      reason: duplicate.reason || duplicate.rule || null,
    } : { available: false, duplicate: null, reason: null },
    hard: {
      available: typeof hard.passed === 'boolean',
      passed: typeof hard.passed === 'boolean' ? hard.passed : null,
      failures: Array.isArray(hard.failures) ? hard.failures : [],
    },
    soft: {
      available: softScore != null && softThreshold != null,
      score: softScore,
      threshold: softThreshold,
      passed: softScore != null && softThreshold != null ? softScore >= softThreshold : null,
    },
    pre: {
      available: preScore != null,
      score: preScore,
      threshold: preThreshold ?? 35,
      passed: preScore != null ? preScore >= (preThreshold ?? 35) : null,
    },
    momentum: {
      available: Boolean(momentum.status || momentum.reason || finite(momentum.probability) != null),
      status: momentum.status || null,
      probability: finite(momentum.probability),
      reason: momentum.reason || null,
    },
    final: {
      available: Boolean(decision?.verdict),
      decision: decision?.verdict || null,
      confidence: finite(decision?.confidence),
    },
  };
}

function normalizeCandidateRow(row) {
  const candidate = safeJson(row.candidate_json);
  const filterResult = safeJson(row.filter_result_json);
  const decision = row.decision_verdict ? {
    verdict: row.decision_verdict,
    confidence: row.decision_confidence,
  } : null;
  return {
    id: row.id,
    mint: row.mint,
    route: canonicalRoute(candidate.signals?.route),
    rawRoute: candidate.signals?.route || 'unknown',
    atMs: Number(row.created_at_ms),
    status: row.status,
    enrichment: extractEnrichment(candidate),
    policy: stageValue(candidate, filterResult, decision),
  };
}

export function loadRuntime(path, sinceMs) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const sourceEvents = db.prepare(`
      SELECT id, mint, kind, source, at_ms, payload_json
      FROM signal_events WHERE at_ms >= ? ORDER BY at_ms, id
    `).all(sinceMs).map(row => ({
      id: row.id,
      mint: row.mint,
      kind: row.kind,
      source: row.source,
      route: canonicalRoute(row.source, row.kind),
      atMs: Number(row.at_ms),
    }));
    const candidates = db.prepare(`
      SELECT c.*,
             d.verdict AS decision_verdict,
             d.confidence AS decision_confidence
      FROM candidates c
      LEFT JOIN llm_decisions d ON d.id = (
        SELECT MAX(d2.id) FROM llm_decisions d2 WHERE d2.candidate_id = c.id
      )
      WHERE c.created_at_ms >= ?
      ORDER BY c.created_at_ms, c.id
    `).all(sinceMs).map(normalizeCandidateRow);
    return { sourceEvents, candidates };
  } finally {
    db.close();
  }
}

export function matchCandidates(kaiser, charon, { strictWindowMs = 60_000, looseWindowMs = 300_000 } = {}) {
  if (strictWindowMs > looseWindowMs) throw new Error('strict window must not exceed loose window');
  const byMint = new Map();
  for (const row of charon) {
    if (!byMint.has(row.mint)) byMint.set(row.mint, []);
    byMint.get(row.mint).push(row);
  }
  const used = new Set();
  const pairs = [];
  for (const left of [...kaiser].sort((a, b) => a.atMs - b.atMs)) {
    const nearest = (byMint.get(left.mint) || [])
      .filter(row => !used.has(row.id))
      .map(row => ({ row, delta: left.atMs - row.atMs }))
      .filter(item => Math.abs(item.delta) <= looseWindowMs)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    if (!nearest) continue;
    used.add(nearest.row.id);
    pairs.push({
      kaiser: left,
      charon: nearest.row,
      deltaMs: nearest.delta,
      window: Math.abs(nearest.delta) <= strictWindowMs ? 'strict' : 'loose',
      routeMatch: left.route === nearest.row.route,
    });
  }
  const pairedKaiser = new Set(pairs.map(pair => pair.kaiser.id));
  return {
    pairs,
    kaiserOnly: kaiser.filter(row => !pairedKaiser.has(row.id)),
    charonOnly: charon.filter(row => !used.has(row.id)),
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1);
  return ordered[Math.max(0, index)];
}

export function latencyStats(pairs) {
  const deltas = pairs.map(pair => pair.deltaMs);
  const absolute = deltas.map(Math.abs);
  return {
    samples: deltas.length,
    medianSignedDeltaMs: percentile(deltas, 0.5),
    absoluteDeltaMs: {
      p50: percentile(absolute, 0.5),
      p90: percentile(absolute, 0.9),
      p95: percentile(absolute, 0.95),
      max: absolute.length ? Math.max(...absolute) : null,
    },
  };
}

export function compareEnrichment(left, right) {
  const fields = {};
  const totals = { same: 0, missingOnCharon: 0, missingOnKaiser: 0, different: 0 };
  for (const field of ENRICHMENT_FIELDS) {
    const kaiser = left[field];
    const charon = right[field];
    let status;
    if (kaiser == null && charon == null) status = 'same';
    else if (kaiser == null) status = 'missing_on_kaiser';
    else if (charon == null) status = 'missing_on_charon';
    else status = numericEqual(kaiser, charon) ? 'same' : 'different';
    if (status === 'same') totals.same++;
    else if (status === 'missing_on_kaiser') totals.missingOnKaiser++;
    else if (status === 'missing_on_charon') totals.missingOnCharon++;
    else totals.different++;
    const absoluteDelta = status === 'different' ? Number(kaiser) - Number(charon) : null;
    const percentageDelta = status === 'different' && Number(charon) !== 0
      ? absoluteDelta / Math.abs(Number(charon)) * 100
      : null;
    fields[field] = {
      status,
      kaiser,
      charon,
      discrete: !CONTINUOUS_FIELDS.has(field),
      absoluteDelta,
      percentageDelta,
    };
  }
  return { fields, totals };
}

function stageEqual(stage, left, right) {
  if (!left.available || !right.available) return null;
  if (stage === 'duplicate') return left.duplicate === right.duplicate && left.reason === right.reason;
  if (stage === 'hard') return left.passed === right.passed && sameArray(left.failures, right.failures);
  if (stage === 'soft' || stage === 'pre') {
    return numericEqual(left.score, right.score)
      && numericEqual(left.threshold, right.threshold)
      && left.passed === right.passed;
  }
  if (stage === 'momentum') {
    return left.status === right.status
      && numericEqual(left.probability, right.probability)
      && left.reason === right.reason;
  }
  return left.decision === right.decision && numericEqual(left.confidence, right.confidence);
}

function stageDifferent(stage, left, right) {
  if (left.available !== right.available) return true;
  return stageEqual(stage, left, right) === false;
}

function jupiterFailOpenDifference(pair) {
  const hardDifferent = stageEqual('hard', pair.kaiser.policy.hard, pair.charon.policy.hard) === false;
  if (!hardDifferent) return false;
  const missingOnEither = [
    pair.kaiser.enrichment.jupiter_price_change_1h,
    pair.kaiser.enrichment.net_buyer_ratio_5m,
    pair.charon.enrichment.jupiter_price_change_1h,
    pair.charon.enrichment.net_buyer_ratio_5m,
  ].some(value => value == null);
  const failures = [
    ...pair.kaiser.policy.hard.failures,
    ...pair.charon.policy.hard.failures,
  ].join(' ').toLowerCase();
  return missingOnEither && (failures.includes('price flow') || failures.includes('net buyer ratio'));
}

export function classifyPair(pair, enrichment) {
  const categories = [];
  if (!pair.routeMatch) categories.push('SOURCE_DIFFERENCE');
  if (pair.window !== 'strict') categories.push('TIMING_DIFFERENCE');
  if (enrichment.totals.different || enrichment.totals.missingOnCharon || enrichment.totals.missingOnKaiser) {
    categories.push('ENRICHMENT_DIFFERENCE');
  }
  for (const [stage, category] of [
    ['duplicate', 'DUPLICATE_STATE_DIFFERENCE'],
    ['hard', 'HARD_FILTER_DIFFERENCE'],
    ['soft', 'SOFT_SCORE_DIFFERENCE'],
    ['pre', 'PRE_SCORE_DIFFERENCE'],
    ['momentum', 'MOMENTUM_DIFFERENCE'],
    ['final', 'FINAL_DECISION_DIFFERENCE'],
  ]) {
    if (stageDifferent(stage, pair.kaiser.policy[stage], pair.charon.policy[stage])) categories.push(category);
  }
  if (jupiterFailOpenDifference(pair)) categories.push('POLICY_VERSION_DIFFERENCE:JUPITER_FLOW_FAIL_OPEN');
  return {
    primary: categories[0] || 'IDENTICAL_AVAILABLE_DATA',
    secondary: categories.slice(1),
    all: categories,
  };
}

function parityCounter(pairs, stage) {
  let comparable = 0;
  let identical = 0;
  for (const pair of pairs) {
    const equal = stageEqual(stage, pair.kaiser.policy[stage], pair.charon.policy[stage]);
    if (equal == null) continue;
    comparable++;
    if (equal) identical++;
  }
  return { identical, comparable, rate: comparable ? identical / comparable : null };
}

function countClassifications(comparisons) {
  const counts = {};
  for (const comparison of comparisons) {
    for (const category of comparison.classification.all) counts[category] = (counts[category] || 0) + 1;
    if (!comparison.classification.all.length) counts.IDENTICAL_AVAILABLE_DATA = (counts.IDENTICAL_AVAILABLE_DATA || 0) + 1;
  }
  return counts;
}

function shortMint(mint) {
  return mint ? `${mint.slice(0, 8)}...` : 'unknown';
}

export function buildParityReport({
  kaiser,
  charon,
  sinceMs,
  untilMs = Date.now(),
  strictWindowMs = 60_000,
  looseWindowMs = 300_000,
  lowSampleThreshold = 30,
}) {
  const matched = matchCandidates(kaiser.candidates, charon.candidates, { strictWindowMs, looseWindowMs });
  const comparisons = matched.pairs.map(pair => {
    const enrichment = compareEnrichment(pair.kaiser.enrichment, pair.charon.enrichment);
    return { pair, enrichment, classification: classifyPair(pair, enrichment) };
  });
  const strictPairs = matched.pairs.filter(pair => pair.window === 'strict');
  const looseOnlyPairs = matched.pairs.filter(pair => pair.window === 'loose');
  const policyComparable = matched.pairs.filter(pair => pair.kaiser.policy.hard.available && pair.charon.policy.hard.available);
  const stageParity = Object.fromEntries(
    ['duplicate', 'hard', 'soft', 'pre', 'momentum', 'final'].map(stage => [stage, parityCounter(policyComparable, stage)]),
  );
  const routes = Object.fromEntries(CANONICAL_ROUTES.map(route => {
    const routePairs = policyComparable.filter(pair => pair.kaiser.route === route && pair.charon.route === route);
    return [route, {
      pairs: routePairs.length,
      hard: parityCounter(routePairs, 'hard'),
      soft: parityCounter(routePairs, 'soft'),
      pre: parityCounter(routePairs, 'pre'),
      momentum: parityCounter(routePairs, 'momentum'),
      final: parityCounter(routePairs, 'final'),
    }];
  }));
  return {
    generatedAtMs: Date.now(),
    window: { sinceMs, untilMs, strictWindowMs, looseWindowMs },
    sourceParity: {
      kaiser: summarizeSourceEvents(kaiser.sourceEvents),
      charon: summarizeSourceEvents(charon.sourceEvents),
      mintJaccard: mintJaccard(kaiser.sourceEvents, charon.sourceEvents),
      mintJaccardByRoute: Object.fromEntries(CANONICAL_ROUTES.map(route => [
        route, mintJaccard(kaiser.sourceEvents, charon.sourceEvents, route),
      ])),
    },
    routeCoverage: {
      kaiserCandidates: countByRoute(kaiser.candidates),
      charonCandidates: countByRoute(charon.candidates),
    },
    candidateParity: {
      kaiserCandidates: kaiser.candidates.length,
      charonCandidates: charon.candidates.length,
      uniqueKaiserMints: new Set(kaiser.candidates.map(row => row.mint)).size,
      uniqueCharonMints: new Set(charon.candidates.map(row => row.mint)).size,
      strictMatched: strictPairs.length,
      looseOnlyMatched: looseOnlyPairs.length,
      sameRouteMatched: matched.pairs.filter(pair => pair.routeMatch).length,
      crossRouteMatched: matched.pairs.filter(pair => !pair.routeMatch).length,
      kaiserOnlyCandidates: matched.kaiserOnly.length,
      charonOnlyCandidates: matched.charonOnly.length,
      kaiserOnlyMints: new Set(matched.kaiserOnly.map(row => row.mint)).size,
      charonOnlyMints: new Set(matched.charonOnly.map(row => row.mint)).size,
      matchUnion: kaiser.candidates.length + charon.candidates.length - matched.pairs.length,
      matchJaccardRate: matched.pairs.length / (kaiser.candidates.length + charon.candidates.length - matched.pairs.length || 1),
    },
    timing: latencyStats(matched.pairs),
    enrichmentParity: comparisons.reduce((totals, item) => {
      for (const [key, value] of Object.entries(item.enrichment.totals)) totals[key] += value;
      return totals;
    }, { same: 0, missingOnCharon: 0, missingOnKaiser: 0, different: 0 }),
    policyParity: {
      comparablePairs: policyComparable.length,
      lowSampleThreshold,
      sampleWarning: policyComparable.length < lowSampleThreshold ? 'INSUFFICIENT SAMPLE' : null,
      stages: stageParity,
      byRoute: routes,
    },
    differenceClassifications: countClassifications(comparisons),
    mismatchExamples: comparisons
      .filter(item => item.classification.all.length)
      .slice(0, 20)
      .map(item => ({
        mint: shortMint(item.pair.kaiser.mint),
        kaiserRoute: item.pair.kaiser.rawRoute,
        charonRoute: item.pair.charon.rawRoute,
        kaiserAtMs: item.pair.kaiser.atMs,
        charonAtMs: item.pair.charon.atMs,
        deltaMs: item.pair.deltaMs,
        categories: item.classification.all,
        enrichment: Object.fromEntries(Object.entries(item.enrichment.fields).filter(([, value]) => value.status !== 'same')),
      })),
    kaiserOnlyExamples: matched.kaiserOnly.slice(0, 20).map(row => ({ mint: shortMint(row.mint), route: row.rawRoute, atMs: row.atMs })),
    charonOnlyExamples: matched.charonOnly.slice(0, 20).map(row => ({ mint: shortMint(row.mint), route: row.rawRoute, atMs: row.atMs })),
    unresolved: [
      stageParity.duplicate.comparable === 0 ? 'Duplicate outcomes are not persisted on accepted candidate rows.' : null,
      policyComparable.length < lowSampleThreshold ? `Only ${policyComparable.length} policy-comparable pairs; threshold is ${lowSampleThreshold}.` : null,
    ].filter(Boolean),
  };
}

function pct(metric) {
  return metric.comparable ? `${metric.identical}/${metric.comparable} = ${(metric.rate * 100).toFixed(1)}%` : '0/0 = unavailable';
}

function printRoutes(title, counts) {
  console.log(title);
  for (const route of CANONICAL_ROUTES) console.log(`  ${route}: ${counts[route] || 0}`);
}

export function printHumanReport(report) {
  console.log('A. Time Window');
  console.log(`  ${new Date(report.window.sinceMs).toISOString()} → ${new Date(report.window.untilMs).toISOString()}`);
  console.log(`  strict=${report.window.strictWindowMs}ms loose=${report.window.looseWindowMs}ms`);
  console.log('\nB. Source Parity');
  for (const name of ['kaiser', 'charon']) {
    const summary = report.sourceParity[name];
    console.log(`  ${name}: raw=${summary.totalRawEvents} unique_mints=${summary.uniqueMints}`);
    console.log(`    overlap 1 route=${summary.routeOverlap.oneRoute}, 2 routes=${summary.routeOverlap.twoRoutes}, 3+ routes=${summary.routeOverlap.threeOrMoreRoutes}`);
  }
  printRoutes('  Kaiser source events:', report.sourceParity.kaiser.eventsPerRoute);
  printRoutes('  Charon source events:', report.sourceParity.charon.eventsPerRoute);
  const sourceRate = report.sourceParity.mintJaccard;
  console.log(`  unique-mint Jaccard: ${sourceRate.intersection}/${sourceRate.union} = ${sourceRate.rate == null ? 'n/a' : `${(sourceRate.rate * 100).toFixed(1)}%`}`);
  console.log('\nC. Route Coverage');
  printRoutes('  Kaiser candidates:', report.routeCoverage.kaiserCandidates);
  printRoutes('  Charon candidates:', report.routeCoverage.charonCandidates);
  console.log('\nD. Candidate Parity');
  const candidate = report.candidateParity;
  console.log(`  raw candidates: Kaiser=${candidate.kaiserCandidates}, Charon=${candidate.charonCandidates}`);
  console.log(`  unique mints: Kaiser=${candidate.uniqueKaiserMints}, Charon=${candidate.uniqueCharonMints}`);
  console.log(`  strict matched=${candidate.strictMatched}, loose-only matched=${candidate.looseOnlyMatched}`);
  console.log(`  same route=${candidate.sameRouteMatched}, cross route=${candidate.crossRouteMatched}`);
  console.log(`  Kaiser-only=${candidate.kaiserOnlyCandidates} candidates/${candidate.kaiserOnlyMints} mints`);
  console.log(`  Charon-only=${candidate.charonOnlyCandidates} candidates/${candidate.charonOnlyMints} mints`);
  console.log(`  candidate Jaccard: ${candidate.strictMatched + candidate.looseOnlyMatched}/${candidate.matchUnion} = ${(candidate.matchJaccardRate * 100).toFixed(1)}%`);
  console.log('\nE. Candidate Timing');
  const timing = report.timing;
  console.log(`  samples=${timing.samples}, signed median=${timing.medianSignedDeltaMs ?? 'n/a'}ms`);
  console.log(`  absolute p50=${timing.absoluteDeltaMs.p50 ?? 'n/a'} p90=${timing.absoluteDeltaMs.p90 ?? 'n/a'} p95=${timing.absoluteDeltaMs.p95 ?? 'n/a'} max=${timing.absoluteDeltaMs.max ?? 'n/a'} ms`);
  console.log('\nF. Enrichment Parity');
  const enrichment = report.enrichmentParity;
  console.log(`  fields: same=${enrichment.same}, missing_on_charon=${enrichment.missingOnCharon}, missing_on_kaiser=${enrichment.missingOnKaiser}, different=${enrichment.different}`);
  console.log('\nG. Policy Parity');
  console.log(`  comparable pairs=${report.policyParity.comparablePairs}`);
  for (const stage of ['duplicate', 'hard', 'soft', 'pre', 'momentum']) {
    console.log(`  ${stage}: ${pct(report.policyParity.stages[stage])}`);
  }
  if (report.policyParity.sampleWarning) console.log(`  ${report.policyParity.sampleWarning}`);
  console.log('\nH. Final Decision Parity');
  console.log(`  ${pct(report.policyParity.stages.final)}`);
  if (report.policyParity.sampleWarning) console.log(`  ${report.policyParity.sampleWarning}`);
  console.log('\nI. Difference Classification');
  const classifications = Object.entries(report.differenceClassifications);
  if (!classifications.length) console.log('  none');
  for (const [name, count] of classifications) console.log(`  ${name}: ${count}`);
  console.log('\nJ. Kaiser-only Candidates');
  console.log(`  ${JSON.stringify(report.kaiserOnlyExamples)}`);
  console.log('\nK. Charon-only Candidates');
  console.log(`  ${JSON.stringify(report.charonOnlyExamples)}`);
  console.log('\nL. Unresolved / Insufficient Data');
  if (!report.unresolved.length) console.log('  none');
  for (const item of report.unresolved) console.log(`  ${item}`);
}

function option(name, fallback = null) {
  const equals = process.argv.find(value => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseSince(value) {
  if (value == null) return Date.now() - 24 * 60 * 60 * 1000;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid --since value: ${value}`);
  return parsed;
}

export function runCli() {
  const kaiserPath = option('kaiser', 'runtime/kaiser-shadow.sqlite');
  const charonPath = option('charon', '/home/ubuntu/charon/charon.sqlite');
  const sinceMs = parseSince(option('since-ms', option('since')));
  const strictWindowMs = Number(option('strict-window-ms', Number(option('strict-window', 60)) * 1000));
  const looseWindowMs = Number(option('loose-window-ms', Number(option('loose-window', 300)) * 1000));
  const lowSampleThreshold = Number(option('low-sample', 30));
  const untilMs = Date.now();
  const report = buildParityReport({
    kaiser: loadRuntime(kaiserPath, sinceMs),
    charon: loadRuntime(charonPath, sinceMs),
    sinceMs,
    untilMs,
    strictWindowMs,
    looseWindowMs,
    lowSampleThreshold,
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(`[shadow-report] ${error.message}`);
    process.exitCode = 1;
  }
}
