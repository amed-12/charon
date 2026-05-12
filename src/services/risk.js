import {
  BLOCK_IF_BUNDLER_RATE_ABOVE,
  BLOCK_IF_RUG_RATIO_ABOVE,
  BLOCK_IF_TOP20_HOLDER_PERCENT_ABOVE,
  COOLDOWN_AFTER_LOSS_STREAK_MINUTES,
  MAX_CONSECUTIVE_LOSSES,
  MAX_DAILY_LOSS_SOL,
  MAX_DAILY_TRADES,
  MAX_POSITION_SIZE_SOL,
  MAX_WALLET_EXPOSURE_PERCENT,
  MIN_HOLDERS_FOR_LIVE,
  MIN_LIQUIDITY_USD,
} from '../config.js';
import { db } from '../db/connection.js';
import { activeStrategy } from '../db/settings.js';
import { now, json } from '../utils.js';
import { ACTIVE_STATUSES, POSITION_STATUS, statusSqlList } from './positionStatus.js';

export function riskConfig() {
  return {
    maxDailyLossSol: MAX_DAILY_LOSS_SOL,
    maxDailyTrades: MAX_DAILY_TRADES,
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    cooldownAfterLossStreakMinutes: COOLDOWN_AFTER_LOSS_STREAK_MINUTES,
    maxPositionSizeSol: MAX_POSITION_SIZE_SOL,
    maxWalletExposurePercent: MAX_WALLET_EXPOSURE_PERCENT,
    minLiquidityUsd: MIN_LIQUIDITY_USD,
    minHoldersForLive: MIN_HOLDERS_FOR_LIVE,
    blockIfTop20HolderPercentAbove: BLOCK_IF_TOP20_HOLDER_PERCENT_ABOVE,
    blockIfRugRatioAbove: BLOCK_IF_RUG_RATIO_ABOVE,
    blockIfBundlerRateAbove: BLOCK_IF_BUNDLER_RATE_ABOVE,
  };
}

function dayStartMs(at = now()) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function consecutiveLosses() {
  const rows = db.prepare(`
    SELECT COALESCE(m.net_pnl_sol, p.net_pnl_sol, p.pnl_sol, 0) AS pnl
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.status = '${POSITION_STATUS.CLOSED}' AND p.execution_mode = 'dry_run'
    ORDER BY COALESCE(m.exit_at_ms, p.closed_at_ms, p.opened_at_ms) DESC
    LIMIT 20
  `).all();
  let count = 0;
  for (const row of rows) {
    if (Number(row.pnl) < 0) count++;
    else break;
  }
  return count;
}

export function currentRiskState() {
  const cfg = riskConfig();
  const start = dayStartMs();
  const daily = db.prepare(`
    SELECT
      COUNT(*) AS trades,
      COALESCE(SUM(CASE WHEN COALESCE(m.net_pnl_sol, p.net_pnl_sol, p.pnl_sol, 0) < 0 THEN COALESCE(m.net_pnl_sol, p.net_pnl_sol, p.pnl_sol, 0) ELSE 0 END), 0) AS losses
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.execution_mode = 'dry_run'
      AND COALESCE(m.entry_at_ms, p.opened_at_ms) >= ?
  `).get(start);
  const open = db.prepare(`
    SELECT COALESCE(SUM(size_sol), 0) AS exposure
    FROM dry_run_positions
    WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) AND execution_mode = 'dry_run'
  `).get();
  const lossStreak = consecutiveLosses();
  const latestLoss = db.prepare(`
    SELECT COALESCE(m.exit_at_ms, p.closed_at_ms, p.opened_at_ms) AS at_ms
    FROM dry_run_positions p
    LEFT JOIN dryrun_trade_metrics m ON m.position_id = p.id
    WHERE p.status = '${POSITION_STATUS.CLOSED}'
      AND p.execution_mode = 'dry_run'
      AND COALESCE(m.net_pnl_sol, p.net_pnl_sol, p.pnl_sol, 0) < 0
    ORDER BY COALESCE(m.exit_at_ms, p.closed_at_ms, p.opened_at_ms) DESC
    LIMIT 1
  `).get();
  const cooldownUntil = lossStreak >= cfg.maxConsecutiveLosses && latestLoss
    ? Number(latestLoss.at_ms) + cfg.cooldownAfterLossStreakMinutes * 60_000
    : 0;
  const reasons = [];
  if (Math.abs(Number(daily.losses || 0)) >= cfg.maxDailyLossSol) reasons.push('max daily loss reached');
  if (Number(daily.trades || 0) >= cfg.maxDailyTrades) reasons.push('max daily trades reached');
  if (cooldownUntil > now()) reasons.push('loss-streak cooldown active');
  return {
    ...cfg,
    dailyLossUsedSol: Math.abs(Number(daily.losses || 0)),
    dailyTradesUsed: Number(daily.trades || 0),
    consecutiveLosses: lossStreak,
    cooldownUntilMs: cooldownUntil,
    cooldownActive: cooldownUntil > now(),
    openExposureSol: Number(open.exposure || 0),
    allowed: reasons.length === 0,
    reasons,
  };
}

export function evaluateCandidateRisk(candidate, sizeSol = activeStrategy().position_size_sol) {
  const cfg = riskConfig();
  const state = currentRiskState();
  const top20 = Number(candidate.holders?.top20Percent ?? candidate.holders?.maxHolderPercent ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? candidate.gmgn?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? candidate.gmgn?.bundler_rate ?? 0);
  const reasons = [...state.reasons];
  if (Number(sizeSol || 0) > cfg.maxPositionSizeSol) reasons.push(`position size ${sizeSol} SOL > ${cfg.maxPositionSizeSol} SOL`);
  if (Number(candidate.metrics?.liquidityUsd || 0) < cfg.minLiquidityUsd) reasons.push(`liquidity below ${cfg.minLiquidityUsd}`);
  if (Number(candidate.metrics?.holderCount || 0) < cfg.minHoldersForLive) reasons.push(`holders below ${cfg.minHoldersForLive}`);
  if (top20 > cfg.blockIfTop20HolderPercentAbove) reasons.push(`top20 holder percent above ${cfg.blockIfTop20HolderPercentAbove}`);
  if (rugRatio > cfg.blockIfRugRatioAbove) reasons.push(`rug ratio above ${cfg.blockIfRugRatioAbove}`);
  if (bundlerRate > cfg.blockIfBundlerRateAbove) reasons.push(`bundler rate above ${cfg.blockIfBundlerRateAbove}`);
  return {
    allowed: reasons.length === 0,
    reasons,
    state,
    checks: { sizeSol, top20, rugRatio, bundlerRate },
  };
}

export function recordRiskEvent({ eventType, positionId = null, candidateId = null, strategyId = null, allowed = true, reasons = [], payload = {} }) {
  db.prepare(`
    INSERT INTO risk_events (created_at_ms, event_type, position_id, candidate_id, strategy_id, allowed, reasons_json, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now(), eventType, positionId, candidateId, strategyId, allowed ? 1 : 0, json(reasons), json(payload));
}
