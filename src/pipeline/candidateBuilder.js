import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { evaluateCandidateFilters } from './candidateFilter.js';

const DEFAULT_CANDIDATE_DEPENDENCIES = {
  activeStrategy,
  fetchGmgnTokenInfo,
  fetchJupiterAsset,
  fetchJupiterHolders,
  fetchJupiterChartContext,
  fetchSavedWalletExposure,
  fetchTwitterNarrative,
  now,
};

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  return evaluateCandidateFilters(candidate, activeStrategy());
}

export async function buildCandidate(
  {
    mint,
    fee = null,
    signature = null,
    graduatedCoin = null,
    trendingToken = null,
    trenchesEntry = null,
    pregradToken = null,
    route,
  },
  dependencies = {},
) {
  const deps = { ...DEFAULT_CANDIDATE_DEPENDENCIES, ...dependencies };
  const strat = deps.activeStrategy();
  const freshGraduate = route === 'pumpportal_graduated';
  let gmgn = null;
  let chart = null;
  let savedWalletExposure = { holderCount: 0, checked: 0, holders: [] };
  let twitterNarrative = null;
  let jupiterAsset;
  let holders;

  if (freshGraduate) {
    [jupiterAsset, holders] = await Promise.all([
      deps.fetchJupiterAsset(mint),
      deps.fetchJupiterHolders(mint),
    ]);
  } else {
    [gmgn, jupiterAsset, holders, chart] = await Promise.all([
      deps.fetchGmgnTokenInfo(mint),
      deps.fetchJupiterAsset(mint),
      deps.fetchJupiterHolders(mint),
      deps.fetchJupiterChartContext(mint),
    ]);
    [savedWalletExposure, twitterNarrative] = await Promise.all([
      deps.fetchSavedWalletExposure(mint, holders),
      deps.fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
    ]);
  }

  const priceUsd = firstPositiveNumber(
    tokenPriceFromGmgn(gmgn),
    jupiterAsset?.usdPrice,
    trendingToken?.price,
    trenchesEntry?.price,
  );
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
    trenchesEntry?.market_cap,
    trenchesEntry?.marketCap,
    trenchesEntry?.fdv,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    pregradToken ? 'pregrad' : null,
    trendingToken ? 'trending' : null,
    trenchesEntry ? 'trenches' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || trenchesEntry?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || trenchesEntry?.symbol || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? trenchesEntry?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? trenchesEntry?.holder_count ?? trenchesEntry?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? trenchesEntry?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? trenchesEntry?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? trenchesEntry?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? trenchesEntry?.smart_degen_count ?? 0),
      pregradRssrSol: Number(pregradToken?.real_sol_reserves_sol ?? 0),
      pregradRssrPctToGrad: Number(pregradToken?.rssr_pct_to_grad ?? 0),
      pregradReplyCount: Number(pregradToken?.reply_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken || trenchesEntry),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken || trenchesEntry),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    trenchesEntry,
    pregradToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: deps.now(),
  };
  candidate.filters = evaluateCandidateFilters(candidate, deps.activeStrategy());
  return candidate;
}
