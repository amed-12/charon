import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { HOLDING_STATUSES } from '../db/positions.js';

export const DUPLICATE_WINDOWS = Object.freeze({
  recentlyClosedMs: 72 * 60 * 60 * 1000,
  recentDecisionMs: 24 * 60 * 60 * 1000,
  recentCandidateMs: 10 * 60 * 1000,
  sameSymbolMs: 24 * 60 * 60 * 1000,
});

function holdingPosition(mint) {
  const marks = HOLDING_STATUSES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, status FROM dry_run_positions
    WHERE mint = ? AND status IN (${marks})
    ORDER BY id DESC LIMIT 1
  `).get(mint, ...HOLDING_STATUSES);
}

export function checkDuplicateCandidate({ mint, symbol = null, atMs = now() }) {
  const open = holdingPosition(mint);
  if (open) return { duplicate: true, rule: 'open_position', detail: `position ${open.id} is ${open.status}` };

  const closed = db.prepare(`
    SELECT id, closed_at_ms FROM dry_run_positions
    WHERE mint = ? AND status = 'closed' AND closed_at_ms >= ?
    ORDER BY closed_at_ms DESC LIMIT 1
  `).get(mint, atMs - DUPLICATE_WINDOWS.recentlyClosedMs);
  if (closed) return { duplicate: true, rule: 'recently_closed', detail: `position ${closed.id} closed within 72h` };

  const decision = db.prepare(`
    SELECT id, created_at_ms FROM llm_decisions
    WHERE mint = ? AND created_at_ms >= ?
    ORDER BY created_at_ms DESC LIMIT 1
  `).get(mint, atMs - DUPLICATE_WINDOWS.recentDecisionMs);
  if (decision) return { duplicate: true, rule: 'recent_decision', detail: `decision ${decision.id} exists within 24h` };

  const candidate = db.prepare(`
    SELECT id, created_at_ms FROM candidates
    WHERE mint = ? AND created_at_ms >= ?
    ORDER BY created_at_ms DESC LIMIT 1
  `).get(mint, atMs - DUPLICATE_WINDOWS.recentCandidateMs);
  if (candidate) return { duplicate: true, rule: 'recent_candidate', detail: `candidate ${candidate.id} exists within 10m` };

  const normalizedSymbol = String(symbol || '').trim();
  if (normalizedSymbol) {
    const sameSymbol = db.prepare(`
      SELECT id, mint, closed_at_ms, opened_at_ms FROM dry_run_positions
      WHERE mint <> ? AND symbol <> '' AND UPPER(symbol) = UPPER(?)
        AND COALESCE(closed_at_ms, opened_at_ms) >= ?
      ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC LIMIT 1
    `).get(mint, normalizedSymbol, atMs - DUPLICATE_WINDOWS.sameSymbolMs);
    if (sameSymbol) return { duplicate: true, rule: 'same_symbol', detail: `symbol ${normalizedSymbol} traded within 24h` };
  }

  return { duplicate: false, rule: null, detail: null };
}

export function checkPastWinGuard(mint) {
  const win = db.prepare(`
    SELECT id FROM dry_run_positions
    WHERE mint = ? AND status = 'closed'
      AND (COALESCE(pnl_percent, 0) > 0 OR COALESCE(pnl_sol, 0) > 0)
    ORDER BY closed_at_ms DESC LIMIT 1
  `).get(mint);
  return win
    ? { allowed: false, reason: `past winning position ${win.id} blocks re-entry` }
    : { allowed: true, reason: null };
}
