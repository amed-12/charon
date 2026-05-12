import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { closedTradeRows, strategyBreakdown } from '../services/performance.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Charon learning from dry-run trading evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes.',
            'Create compact operational lessons that can improve the next screening prompt.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze this dry-run window and produce up to 6 lessons for future candidate screening.',
            output_schema: {
              lessons: [{ lesson: 'short actionable rule', evidence: 'specific supporting data' }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({
          lesson: String(item.lesson || '').slice(0, 500),
          evidence: item.evidence ?? {},
        })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, 'active', ?, ?)
  `);
  const generated = generateEvidenceLessons(windowMs);
  const richLessons = generated.length ? generated : lessons;
  for (const item of richLessons) insert.run(runId, now(), item.lesson || item.finding, json(item.evidence || item));
  const insertGenerated = db.prepare(`
    INSERT INTO generated_lessons (created_at_ms, window, metric, finding, evidence, recommendation, confidence_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of generated) {
    insertGenerated.run(now(), item.window, item.metric, item.finding, item.evidenceText, item.recommendation, item.confidenceLevel);
  }
  return runId;
}

function confidenceLevel(n) {
  if (n < 30) return 'LOW CONFIDENCE';
  if (n < 100) return 'MEDIUM CONFIDENCE';
  return 'HIGH CONFIDENCE';
}

function windowLabel(windowMs) {
  if (windowMs % (24 * 60 * 60_000) === 0) return `${windowMs / (24 * 60 * 60_000)}d`;
  if (windowMs % (60 * 60_000) === 0) return `${windowMs / (60 * 60_000)}h`;
  return `${Math.round(windowMs / 60_000)}m`;
}

export function generateEvidenceLessons(windowMs) {
  const label = windowLabel(windowMs);
  const rows = closedTradeRows(label);
  const lessons = [];
  for (const s of strategyBreakdown(label)) {
    if (s.trades < 5) continue;
    if (s.netPnl > 0 && s.winRate >= 40) {
      lessons.push({
        window: label,
        metric: 'strategy',
        finding: `${s.strategyId} produced positive net PnL with ${s.winRate.toFixed(1)}% win rate.`,
        evidenceText: `n=${s.trades}, net=${s.netPnl.toFixed(4)} SOL, profit_factor=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'}`,
        recommendation: `Keep ${s.strategyId} enabled for dry-run collection; avoid increasing live size until n>=100.`,
        confidenceLevel: confidenceLevel(s.trades),
        lesson: `${s.strategyId} had ${s.winRate.toFixed(1)}% win rate and ${s.netPnl.toFixed(4)} SOL net over ${label} (n=${s.trades}). Suggest keeping it in dry-run rotation; ${confidenceLevel(s.trades)}.`,
        evidence: s,
      });
    }
    if (s.netPnl < 0) {
      lessons.push({
        window: label,
        metric: 'strategy',
        finding: `${s.strategyId} had negative expectancy.`,
        evidenceText: `n=${s.trades}, net=${s.netPnl.toFixed(4)} SOL, win_rate=${s.winRate.toFixed(1)}%`,
        recommendation: `Tighten ${s.strategyId} filters or disable it until the next dry-run review.`,
        confidenceLevel: confidenceLevel(s.trades),
        lesson: `${s.strategyId} produced negative net PnL of ${s.netPnl.toFixed(4)} SOL over ${label} (n=${s.trades}). Suggest tightening filters; ${confidenceLevel(s.trades)}.`,
        evidence: s,
      });
    }
  }
  const lowConfidence = rows.filter(r => Number(r.llm_confidence || 0) < 70);
  if (lowConfidence.length >= 5) {
    const net = lowConfidence.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
    if (net < 0) {
      lessons.push({
        window: label,
        metric: 'llm_confidence',
        finding: 'LLM confidence below 70 underperformed.',
        evidenceText: `n=${lowConfidence.length}, net=${net.toFixed(4)} SOL`,
        recommendation: 'Consider raising llm_min_confidence or only using low-confidence entries as watchlist candidates.',
        confidenceLevel: confidenceLevel(lowConfidence.length),
        lesson: `LLM confidence below 70 lost ${Math.abs(net).toFixed(4)} SOL net over ${label} (n=${lowConfidence.length}). Consider raising llm_min_confidence; ${confidenceLevel(lowConfidence.length)}.`,
        evidence: { count: lowConfidence.length, net },
      });
    }
  }
  const highMcap = rows.filter(r => Number(r.entry_mcap || 0) >= 250000);
  if (highMcap.length >= 5) {
    const net = highMcap.reduce((sum, r) => sum + Number(r.net_pnl_sol ?? r.pnl_sol ?? 0), 0);
    if (net < 0) {
      lessons.push({
        window: label,
        metric: 'entry_mcap',
        finding: 'Entries above 250k mcap produced negative net PnL.',
        evidenceText: `n=${highMcap.length}, net=${net.toFixed(4)} SOL`,
        recommendation: 'Consider lowering max_mcap_usd for affected strategies.',
        confidenceLevel: confidenceLevel(highMcap.length),
        lesson: `Entries above 250k mcap lost ${Math.abs(net).toFixed(4)} SOL net over ${label} (n=${highMcap.length}). Consider lowering max_mcap_usd; ${confidenceLevel(highMcap.length)}.`,
        evidence: { count: highMcap.length, net },
      });
    }
  }
  return lessons.slice(0, 8);
}
