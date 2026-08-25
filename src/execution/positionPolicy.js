/**
 * Pure position-policy helpers. These expose the existing comparisons for deterministic
 * tests without moving or reordering the monitor's max-hold, stale, partial-TP, and standard
 * exit stages.
 */

export function trailingPctFor(fixedPct, atrPct, {
  enabled = false,
  mult = 2.5,
  min = 8,
  max = 45,
} = {}) {
  const fixed = Math.abs(Number(fixedPct));
  if (!enabled) return fixed;
  const atr = Number(atrPct);
  if (!Number.isFinite(atr) || atr <= 0) return fixed;
  const scaled = atr * Number(mult);
  if (!Number.isFinite(scaled) || scaled <= 0) return fixed;
  return Math.min(Math.max(scaled, Number(min)), Number(max));
}

export function atrStopPercent(baseStopPercent, atrPct, { mult = 2.5, floor = -50, ceiling = -8 } = {}) {
  const fallback = Number(baseStopPercent);
  const atr = Number(atrPct);
  if (!Number.isFinite(atr) || atr <= 0) return fallback;
  const scaled = -Math.abs(atr * Number(mult));
  if (!Number.isFinite(scaled)) return fallback;
  const lower = Math.min(Number(floor), Number(ceiling));
  const upper = Math.max(Number(floor), Number(ceiling));
  return Math.min(upper, Math.max(lower, scaled));
}

export function evaluatePositionSignals({
  hasLiveQuote,
  pnlPercent,
  tpPercent,
  slPercent,
  trailingArmed,
  trailingEnabled,
  mcap,
  highWaterMcap,
}) {
  const tpHit = hasLiveQuote && pnlPercent >= Number(tpPercent);
  const slHit = hasLiveQuote && pnlPercent <= Number(slPercent);
  const nextTrailingArmed = trailingArmed || (trailingEnabled && tpHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  return { tpHit, slHit, trailingArmed: nextTrailingArmed, trailDrop };
}

export function trailingExitHit({ hasLiveQuote, trailingArmed, trailingEnabled, trailDrop, trailingPercent }) {
  return hasLiveQuote && trailingArmed && trailingEnabled && trailDrop <= -trailingPercent;
}

export function maxHoldExpired(maxHoldMs, openedAtMs, nowMs) {
  return maxHoldMs > 0 && (nowMs - openedAtMs) >= maxHoldMs;
}

export function standardExitReason({ slHit, tpHit, trailingEnabled, trailingHit }) {
  if (slHit) return 'SL';
  if (tpHit && !trailingEnabled) return 'TP';
  if (trailingHit) return 'TRAILING_TP';
  return null;
}
