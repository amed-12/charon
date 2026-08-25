/**
 * Resolve the persisted entry/exit terms exactly as the position writers historically did.
 * In particular, TP/SL preserve the existing truthy (`||`) fallback semantics.
 */
export function resolvePositionConfig(strat, decision, {
  defaultSizeSol = 0.1,
  defaultTpPercent = 50,
  defaultSlPercent = -25,
  defaultTrailingEnabled = true,
  defaultTrailingPercent = 20,
} = {}) {
  return {
    sizeSol: strat.position_size_sol ?? defaultSizeSol,
    tpPercent: Number(decision.suggested_tp_percent || strat.tp_percent || defaultTpPercent),
    slPercent: Number(decision.suggested_sl_percent || strat.sl_percent || defaultSlPercent),
    trailingEnabled: (strat.trailing_enabled ?? defaultTrailingEnabled) ? 1 : 0,
    trailingPercent: strat.trailing_percent ?? defaultTrailingPercent,
  };
}

export function positionLimitFor(strat, defaultMaxOpenPositions = 3) {
  return strat.max_open_positions ?? defaultMaxOpenPositions;
}

export function canOpenPositionAtCount(openCount, strat, defaultMaxOpenPositions = 3) {
  const max = positionLimitFor(strat, defaultMaxOpenPositions);
  return max <= 0 || openCount < max;
}
