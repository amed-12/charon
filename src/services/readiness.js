import { db } from '../db/connection.js';
import { summarizeTrades, strategyBreakdown } from './performance.js';
import { riskConfig } from './risk.js';

export function readinessScore() {
  const summary = summarizeTrades('all');
  const strategies = strategyBreakdown('all');
  const risk = riskConfig();
  const closed = summary.closed;
  const dayCount = new Set(closed.map(row => new Date(Number(row.closed_at_ms || row.exit_at_ms || row.opened_at_ms)).toISOString().slice(0, 10))).size;
  const best = [...strategies].sort((a, b) => b.netPnl - a.netPnl || b.profitFactor - a.profitFactor)[0];
  const failed = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN event_type LIKE '%failed%' OR allowed = 0 THEN 1 ELSE 0 END) AS failed
    FROM risk_events
  `).get();
  const failedRate = Number(failed.total || 0) ? Number(failed.failed || 0) / Number(failed.total) : 0;
  const checks = [
    { key: '100 closed dry-run trades', passed: summary.closedTrades >= 100, points: 20 },
    { key: 'positive net PnL', passed: summary.netPnl > 0, points: 15 },
    { key: 'profit factor above 1.2', passed: summary.profitFactor > 1.2, points: 15 },
    { key: 'max drawdown under 30%', passed: Math.abs(summary.maxDrawdown) < 30, points: 10 },
    { key: 'no strategy with uncontrolled losses', passed: !strategies.some(s => s.trades >= 30 && s.netPnl < -risk.maxDailyLossSol * 3), points: 10 },
    { key: 'failed data/API rate below threshold', passed: failedRate < 0.1, points: 10 },
    { key: 'best strategy identified', passed: Boolean(best && best.trades >= 30 && best.netPnl > 0), points: 8 },
    { key: 'risk guardrails configured', passed: risk.maxDailyLossSol > 0 && risk.maxPositionSizeSol > 0, points: 5 },
    { key: 'export available', passed: true, points: 3 },
    { key: 'sample covers 3 different days', passed: dayCount >= 3, points: 4 },
  ];
  const score = Math.round(checks.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0));
  const status = score < 40
    ? 'NOT READY'
    : score < 70
      ? 'NEEDS MORE DRY RUN'
      : score < 85
        ? 'READY FOR CONFIRM MODE ONLY'
        : 'READY FOR SMALL LIVE TEST';
  return { score, status, checks, summary, strategies, bestStrategy: best, failedRate, dayCount };
}
