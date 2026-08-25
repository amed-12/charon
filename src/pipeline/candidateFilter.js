import { evaluateSniperHardFilters } from './sniperPolicy.js';
import { evaluateLegacyCandidateFilters } from './legacyCandidateFilter.js';

/**
 * @typedef {object} StrategyFilterConfig
 * @property {string} id
 * @property {boolean} require_fee_claim
 * @property {number} min_fee_claim_sol
 * @property {number} min_mcap_usd
 * @property {number} max_mcap_usd
 * @property {number} min_gmgn_total_fee_sol
 * @property {number} min_graduated_volume_usd
 * @property {number} min_holders
 * @property {number} max_top20_holder_percent
 * @property {number} min_saved_wallet_holders
 * @property {number} max_ath_distance_pct
 * @property {number} trending_min_volume_usd
 * @property {number} trending_min_swaps
 * @property {number} trending_max_rug_ratio
 * @property {number} trending_max_bundler_rate
 */

/**
 * Evaluate the current strategy's hard filters without reading mutable runtime state.
 *
 * Keeping this function pure makes the exact legacy filter order and missing-value
 * semantics fixture-testable. The caller remains responsible for choosing the active
 * strategy; no thresholds or route rules are introduced here.
 *
 * @param {object} candidate
 * @param {StrategyFilterConfig & Record<string, unknown>} strat
 * @returns {{passed: boolean, failures: string[], strategy: string, thresholds: object}}
 */
export function evaluateCandidateFilters(candidate, strat) {
  if (strat.id === 'sniper') return evaluateSniperHardFilters(candidate, strat);
  return evaluateLegacyCandidateFilters(candidate, strat);
}
