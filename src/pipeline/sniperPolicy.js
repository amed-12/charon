const FRESH_GRADUATE_ROUTE = 'pumpportal_graduated';

export const SNIPER_POLICY = Object.freeze({
  minLiquidityUsd: 6_000,
  minPriceChange1hPercent: 0,
  minNetBuyerRatio5m: 0.2,
  minBuySellRatio: 1,
  softScoreBase: 100,
  softScoreMin: 0,
  softScoreMax: 150,
  softScoreThreshold: 30,
  positionPressureThreshold: 40,
  idleThreshold: 20,
  preScoreThreshold: 35,
  momentumThreshold: 0.5,
  momentumTimeoutMs: 8_000,
});

function numeric(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function percentage(value, { rate = false } = {}) {
  const parsed = numeric(value);
  if (parsed == null) return null;
  return rate && Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
}

function rate(value, { percentageValue = false } = {}) {
  const parsed = numeric(value);
  if (parsed == null) return null;
  return percentageValue && Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

function priceChange(current, previous) {
  const currentPrice = numeric(current);
  const previousPrice = numeric(previous);
  if (currentPrice == null || previousPrice == null || previousPrice <= 0) return null;
  return (currentPrice / previousPrice - 1) * 100;
}

function maxFinite(...values) {
  const finite = values.map(value => numeric(value)).filter(value => value != null);
  return finite.length ? Math.max(...finite) : null;
}

export function isFreshGraduate(candidate) {
  return candidate?.signals?.route === FRESH_GRADUATE_ROUTE;
}

export function isSupportedSniperRoute(route) {
  return route === 'pumpportal_graduated'
    || route === 'pumpfun_pregrad'
    || route === 'trenches_completed'
    || route === 'graduated'
    || String(route || '').startsWith('fee_');
}

export function extractSniperMetrics(candidate) {
  const asset = candidate?.jupiterAsset || {};
  const audit = asset.audit || {};
  const gmgn = candidate?.gmgn || {};
  const gmgnPrice = gmgn.price || {};
  const gmgnStat = gmgn.stat || {};
  const trending = candidate?.trending || {};
  const stats1h = asset.stats1h || trending.stats1h || {};
  const stats5m = asset.stats5m || trending.stats5m || {};
  const stats1m = asset.stats1m || trending.stats1m || {};
  const currentPrice = numeric(gmgnPrice.price, gmgn.price, asset.usdPrice, candidate?.metrics?.priceUsd);
  const numNetBuyers5m = numeric(stats5m.numNetBuyers);
  const numTraders5m = numeric(stats5m.numTraders);
  const numBuys5m = numeric(stats5m.numBuys, gmgnPrice.buys_5m);
  const numSells5m = numeric(stats5m.numSells, gmgnPrice.sells_5m);
  let netBuyerRatio5m = numeric(candidate?.metrics?.netBuyerRatio5m, trending.net_buyer_ratio_5m);
  if (netBuyerRatio5m == null && numNetBuyers5m != null) {
    const denominator = numTraders5m > 0 ? numTraders5m : (numBuys5m || 0) + (numSells5m || 0);
    if (denominator > 0) netBuyerRatio5m = numNetBuyers5m / denominator;
  }
  const gmgnBuys5m = numeric(gmgnPrice.buys_5m, gmgn.buys_5m);
  const gmgnSells5m = numeric(gmgnPrice.sells_5m, gmgn.sells_5m);
  let gmgnBuySellRatio = numeric(candidate?.metrics?.gmgnBuySellRatio, gmgn.buy_sell_ratio);
  if (gmgnBuySellRatio == null && gmgnBuys5m != null && gmgnSells5m != null) {
    gmgnBuySellRatio = gmgnSells5m === 0
      ? (gmgnBuys5m > 0 ? Number.POSITIVE_INFINITY : null)
      : gmgnBuys5m / gmgnSells5m;
  }
  const bundlerRate = rate(candidate?.metrics?.bundlerRate)
    ?? rate(trending.bundler_rate)
    ?? rate(gmgnStat.top_bundler_trader_percentage)
    ?? rate(audit.bundlerStats?.holdingPct, { percentageValue: true });
  const botPercentage = percentage(
    audit.botHoldersPercentage,
  ) ?? percentage(gmgnStat.bot_degen_rate, { rate: true });
  const top10Percentage = percentage(
    audit.topHoldersPercentage,
  ) ?? percentage(gmgnStat.top_10_holder_rate, { rate: true });
  const zeroSecondPattern = Array.isArray(candidate?.graduation?.patternFlags)
    && candidate.graduation.patternFlags.includes('fast_migration_0s');
  const migrationSeconds = zeroSecondPattern ? 0 : numeric(
    candidate?.graduation?.migrationSeconds,
    candidate?.graduation?.migration_seconds,
    candidate?.graduation?.migrationDurationSeconds,
    candidate?.graduation?.migration_duration_seconds,
    asset.migrationSeconds,
  );

  return {
    liquidity: numeric(candidate?.metrics?.liquidityUsd, gmgn.liquidity, asset.liquidity, trending.liquidity),
    marketCap: numeric(candidate?.metrics?.marketCapUsd, gmgn.market_cap, gmgn.mcap, asset.mcap, asset.fdv, trending.market_cap),
    holderCount: numeric(candidate?.metrics?.holderCount, gmgn.holder_count, asset.holderCount, trending.holder_count, candidate?.holders?.count),
    priceChange1h: numeric(stats1h.priceChange, candidate?.metrics?.priceChange1h)
      ?? priceChange(currentPrice, numeric(gmgnPrice.price_1h, gmgn.price_1h)),
    priceChange5m: numeric(stats5m.priceChange, candidate?.metrics?.priceChange5m)
      ?? priceChange(currentPrice, numeric(gmgnPrice.price_5m, gmgn.price_5m)),
    priceChange1m: numeric(stats1m.priceChange, candidate?.metrics?.priceChange1m)
      ?? priceChange(currentPrice, numeric(gmgnPrice.price_1m, gmgn.price_1m)),
    netBuyerRatio5m,
    gmgnBuySellRatio,
    botHolderCount: numeric(audit.botHoldersCount, gmgnStat.bot_degen_count),
    botPercentage,
    top10Percentage,
    developerMigrations: numeric(audit.devMigrations, gmgnStat.creator_created_count),
    bundlerRate,
    organicScore: numeric(asset.organicScore, trending.organicScore, candidate?.metrics?.organicScore),
    smartDegenCount: maxFinite(
      candidate?.metrics?.trendingSmartDegenCount,
      trending.smart_degen_count,
      stats5m.numOrganicBuyers,
      stats1h.numOrganicBuyers,
    ),
    athDistance: numeric(candidate?.chart?.distanceFromAthPercent, candidate?.chart?.belowRangeHighPercent),
    migrationSeconds,
    washTrading: trending.is_wash_trading === true
      || trending.is_wash_trading === 1
      || gmgn.is_wash_trading === true
      || gmgn.is_wash_trading === 1,
  };
}

/**
 * Jupiter flow gates intentionally use only the Jupiter statistics contract.
 * Missing, invalid, or zero-denominator data remains unavailable (null), which
 * makes both hard filters fail open exactly as the audited policy requires.
 */
export function extractJupiterFlowMetrics(candidate) {
  const priceChange1h = numeric(candidate?.jupiterAsset?.stats1h?.priceChange);
  const numNetBuyers = numeric(candidate?.jupiterAsset?.stats5m?.numNetBuyers);
  const numTraders = numeric(candidate?.jupiterAsset?.stats5m?.numTraders);
  const netBuyerRatio5m = numNetBuyers != null && numTraders != null && numTraders > 0
    ? numNetBuyers / numTraders
    : null;
  return { priceChange1h, numNetBuyers, numTraders, netBuyerRatio5m };
}

export function evaluateSniperHardFilters(candidate, strat) {
  const failures = [];
  const metrics = extractSniperMetrics(candidate);
  const jupiterFlow = extractJupiterFlowMetrics(candidate);
  const fresh = isFreshGraduate(candidate);

  if (!isSupportedSniperRoute(candidate?.signals?.route)) {
    failures.push(`unsupported Sniper route: ${candidate?.signals?.route || 'missing'}`);
  }

  if (fresh) {
    if (!candidate.jupiterAsset) failures.push('fresh graduate: Jupiter asset missing');
    if (!(metrics.holderCount > 0)) failures.push('fresh graduate: holders missing');
    if (metrics.migrationSeconds === 0) failures.push('fresh graduate: zero-second migration');
  }
  if (!(metrics.liquidity >= SNIPER_POLICY.minLiquidityUsd)) {
    failures.push(`liquidity: ${metrics.liquidity ?? 'missing'} < ${SNIPER_POLICY.minLiquidityUsd}`);
  }
  if (Number.isFinite(jupiterFlow.priceChange1h)
      && jupiterFlow.priceChange1h < SNIPER_POLICY.minPriceChange1hPercent) {
    failures.push(`1h price flow: ${jupiterFlow.priceChange1h} < ${SNIPER_POLICY.minPriceChange1hPercent}%`);
  }
  if (Number.isFinite(jupiterFlow.netBuyerRatio5m)
      && jupiterFlow.netBuyerRatio5m < SNIPER_POLICY.minNetBuyerRatio5m) {
    failures.push(`5m net buyer ratio: ${jupiterFlow.netBuyerRatio5m} < ${SNIPER_POLICY.minNetBuyerRatio5m}`);
  }
  if (!fresh && !(metrics.gmgnBuySellRatio >= SNIPER_POLICY.minBuySellRatio)) {
    failures.push(`GMGN buy/sell ratio: ${metrics.gmgnBuySellRatio ?? 'missing'} < ${SNIPER_POLICY.minBuySellRatio}`);
  }
  if (metrics.washTrading) failures.push('trending wash trading');

  return {
    passed: failures.length === 0,
    failures,
    strategy: strat.id,
    thresholds: { ...strat },
    sniperMetrics: { ...metrics, jupiterFlow },
    auditMode: 'v40-2026-07-05',
  };
}

function component(components, name, points, value) {
  if (!points) return;
  components.push({ name, points, value });
}

export function computeSoftScore(candidate) {
  const metrics = extractSniperMetrics(candidate);
  const route = candidate?.signals?.route || '';
  const components = [];
  const liquidity = metrics.liquidity;
  if (liquidity != null) {
    if (liquidity < 3_000) component(components, 'liquidity', -35, liquidity);
    else if (liquidity < 5_000) component(components, 'liquidity', -25, liquidity);
    else if (liquidity < 10_000) component(components, 'liquidity', -10, liquidity);
  }

  const bots = metrics.botHolderCount;
  if (bots != null && route === 'pumpportal_graduated') {
    if (bots >= 80) component(components, 'bot_holders_pumpportal', -40, bots);
    else if (bots >= 50) component(components, 'bot_holders_pumpportal', -30, bots);
    else if (bots >= 30) component(components, 'bot_holders_pumpportal', -15, bots);
  } else if (bots != null && route === 'trenches_completed') {
    if (bots >= 100) component(components, 'bot_holders_trenches', -25, bots);
    else if (bots >= 50) component(components, 'bot_holders_trenches', -10, bots);
  } else if (bots != null && route === 'fee_trending') {
    if (bots >= 100) component(components, 'bot_holders_fee_trending', -30, bots);
    else if (bots >= 50) component(components, 'bot_holders_fee_trending', -15, bots);
  }

  if (metrics.botPercentage > 50) component(components, 'bot_percentage', -25, metrics.botPercentage);
  else if (metrics.botPercentage > 30) component(components, 'bot_percentage', -15, metrics.botPercentage);

  const top10 = metrics.top10Percentage;
  if (top10 != null && route === 'pumpportal_graduated') {
    if (top10 >= 15 && top10 <= 25) component(components, 'top10_pumpportal', -30, top10);
    else if (top10 >= 50) component(components, 'top10_pumpportal', -20, top10);
  } else if (top10 != null && route === 'trenches_completed') {
    if (top10 >= 25 && top10 <= 35) component(components, 'top10_trenches', -20, top10);
    else if (top10 >= 50) component(components, 'top10_trenches', -15, top10);
  } else if (top10 >= 50) component(components, 'top10_other', -20, top10);

  const migrations = metrics.developerMigrations;
  if (migrations >= 15) component(components, 'developer_migrations', -30, migrations);
  else if (migrations >= 7) component(components, 'developer_migrations', -20, migrations);
  else if (migrations >= 3) component(components, 'developer_migrations', -5, migrations);

  if (metrics.holderCount != null && route === 'pumpportal_graduated') {
    if (metrics.holderCount < 30) component(components, 'holder_count_pumpportal', -20, metrics.holderCount);
    else if (metrics.holderCount < 50) component(components, 'holder_count_pumpportal', -10, metrics.holderCount);
  } else if (metrics.holderCount != null && route === 'trenches_completed' && metrics.holderCount < 30) {
    component(components, 'holder_count_trenches', -10, metrics.holderCount);
  }

  if (metrics.athDistance != null && metrics.athDistance > -20) component(components, 'ath_distance', -15, metrics.athDistance);
  else if (metrics.athDistance != null && metrics.athDistance > -30) component(components, 'ath_distance', -10, metrics.athDistance);
  if (route === 'trenches_completed' && metrics.marketCap != null && metrics.marketCap < 25_000) component(components, 'mcap_trenches', -15, metrics.marketCap);
  if (route === 'fee_trending' && metrics.marketCap != null && metrics.marketCap < 40_000) component(components, 'mcap_fee_trending', -15, metrics.marketCap);
  if (metrics.bundlerRate > 0.5) component(components, 'bundler_rate', -20, metrics.bundlerRate);
  else if (metrics.bundlerRate > 0.3) component(components, 'bundler_rate', -10, metrics.bundlerRate);

  if (metrics.smartDegenCount >= 10) component(components, 'smart_degen_count', 25, metrics.smartDegenCount);
  else if (metrics.smartDegenCount >= 5) component(components, 'smart_degen_count', 15, metrics.smartDegenCount);
  else if (metrics.smartDegenCount >= 2) component(components, 'smart_degen_count', 5, metrics.smartDegenCount);
  if (metrics.organicScore >= 70) component(components, 'organic_score', 20, metrics.organicScore);
  else if (metrics.organicScore >= 50) component(components, 'organic_score', 10, metrics.organicScore);
  else if (metrics.organicScore >= 30) component(components, 'organic_score', 5, metrics.organicScore);
  if (metrics.bundlerRate != null && metrics.bundlerRate < 0.1) component(components, 'clean_bundler', 15, metrics.bundlerRate);
  else if (metrics.bundlerRate != null && metrics.bundlerRate < 0.3) component(components, 'clean_bundler', 5, metrics.bundlerRate);
  if (route === 'pumpportal_graduated') component(components, 'fresh_graduate_momentum', 10, metrics.priceChange1h);

  const rawScore = SNIPER_POLICY.softScoreBase + components.reduce((sum, row) => sum + row.points, 0);
  return {
    score: Math.min(SNIPER_POLICY.softScoreMax, Math.max(SNIPER_POLICY.softScoreMin, rawScore)),
    rawScore,
    components,
    metrics,
  };
}

export function dynamicSoftScoreThreshold(openPositionCount, maxPositions = 5) {
  const open = Math.max(0, Number(openPositionCount) || 0);
  if (open === 0) return SNIPER_POLICY.idleThreshold;
  if (open >= Math.max(0, Number(maxPositions) - 1)) return SNIPER_POLICY.positionPressureThreshold;
  return SNIPER_POLICY.softScoreThreshold;
}

export function preScoreCandidate(candidate) {
  const metrics = extractSniperMetrics(candidate);
  const components = [];
  if (metrics.smartDegenCount >= 10) component(components, 'smart_degen_count', 30, metrics.smartDegenCount);
  else if (metrics.smartDegenCount >= 5) component(components, 'smart_degen_count', 20, metrics.smartDegenCount);
  else if (metrics.smartDegenCount >= 2) component(components, 'smart_degen_count', 10, metrics.smartDegenCount);
  if (metrics.organicScore >= 70) component(components, 'organic_score', 25, metrics.organicScore);
  else if (metrics.organicScore >= 50) component(components, 'organic_score', 15, metrics.organicScore);
  else if (metrics.organicScore >= 30) component(components, 'organic_score', 5, metrics.organicScore);
  if (metrics.bundlerRate != null && metrics.bundlerRate < 0.1) component(components, 'bundler_rate', 20, metrics.bundlerRate);
  else if (metrics.bundlerRate != null && metrics.bundlerRate < 0.3) component(components, 'bundler_rate', 10, metrics.bundlerRate);
  if (metrics.marketCap >= 25_000 && metrics.marketCap <= 100_000) component(components, 'mcap_sweet_spot', 15, metrics.marketCap);
  else if (metrics.marketCap >= 10_000 && metrics.marketCap <= 250_000) component(components, 'mcap_sweet_spot', 8, metrics.marketCap);
  if (metrics.holderCount >= 100) component(components, 'holder_count', 10, metrics.holderCount);
  else if (metrics.holderCount >= 50) component(components, 'holder_count', 5, metrics.holderCount);
  const score = Math.min(100, components.reduce((sum, row) => sum + row.points, 0));
  return { score, passed: score >= SNIPER_POLICY.preScoreThreshold, threshold: SNIPER_POLICY.preScoreThreshold, components, metrics };
}

export function momentumFeatures(candidate) {
  const metrics = extractSniperMetrics(candidate);
  const features = {
    price_change_1h: metrics.priceChange1h,
    price_change_5m: metrics.priceChange5m,
    price_change_1m: metrics.priceChange1m,
    smart_degen_count: metrics.smartDegenCount,
    holder_count: metrics.holderCount,
    liquidity: metrics.liquidity,
    bundler_rate: metrics.bundlerRate,
    organic_score: metrics.organicScore,
  };
  return { features, missing: Object.entries(features).filter(([, value]) => value == null || !Number.isFinite(Number(value))).map(([key]) => key) };
}
