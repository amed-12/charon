export const PUMP_FUN_PREGRAD_RSSR = Object.freeze({ minSol: 76.5, maxSol: 85 });

export function pregradRssrSol(signal = {}) {
  const raw = [
    signal.rssrSol,
    signal.rssr,
    signal.realSolReservesSol,
    signal.realSolReserves,
    signal.real_sol_reserves,
    signal.pregrad?.rssrSol,
    signal.pregrad?.rssr,
    signal.pregrad?.realSolReserves,
    signal.pumpfun?.realSolReserves,
  ].find(value => value != null && value !== '');
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 1_000_000 ? numeric / 1_000_000_000 : numeric;
}

export function pregradRssrInRange(signal) {
  const rssrSol = pregradRssrSol(signal);
  return rssrSol != null
    && rssrSol >= PUMP_FUN_PREGRAD_RSSR.minSol
    && rssrSol <= PUMP_FUN_PREGRAD_RSSR.maxSol;
}

export function sniperRouteForSignal(signal, { hasFee, hasTrending }) {
  const sources = (signal?.sources || []).map(source => String(source).toLowerCase());
  if (sources.some(source => source.includes('pumpportal') && source.includes('graduat'))) {
    return 'pumpportal_graduated';
  }
  if (sources.some(source => source.includes('pregrad') || source.includes('pre_grad')) && pregradRssrInRange(signal)) {
    return 'pumpfun_pregrad';
  }
  if (sources.some(source => source.includes('trenches') && source.includes('completed'))) {
    return 'trenches_completed';
  }
  if (hasFee && hasTrending) return 'fee_trending';
  if (hasFee) {
    const feeSource = sources.find(source => source.startsWith('fee_'));
    return feeSource || 'fee_claim';
  }
  if (sources.some(source => source === 'graduated' || source.includes('helius_graduated'))) {
    return 'graduated';
  }
  return null;
}
