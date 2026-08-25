import { SHADOW_MODE } from '../config.js';
import { db } from '../db/connection.js';
import { now } from '../utils.js';

export const DUPLICATE_AUDIT_REASONS = Object.freeze([
  'open_position',
  'closed_72h',
  'decision_24h',
  'candidate_10m',
  'same_symbol_24h',
  'none',
]);

const REASON_BY_RULE = Object.freeze({
  open_position: 'open_position',
  recently_closed: 'closed_72h',
  recent_decision: 'decision_24h',
  recent_candidate: 'candidate_10m',
  same_symbol: 'same_symbol_24h',
});

let initialized = false;

export function normalizeDuplicateReason(rule) {
  return REASON_BY_RULE[rule] || 'none';
}

function ensureDuplicateAuditTable() {
  if (initialized) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_duplicate_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at_ms INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      route TEXT NOT NULL,
      duplicate_checked INTEGER NOT NULL,
      duplicate_result TEXT NOT NULL CHECK (duplicate_result IN ('PASS', 'REJECT')),
      duplicate_reason TEXT NOT NULL CHECK (
        duplicate_reason IN (
          'open_position', 'closed_72h', 'decision_24h',
          'candidate_10m', 'same_symbol_24h', 'none'
        )
      )
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_duplicate_audit_checked_at
      ON shadow_duplicate_audit(checked_at_ms);
    CREATE INDEX IF NOT EXISTS idx_shadow_duplicate_audit_route
      ON shadow_duplicate_audit(route, checked_at_ms);
    CREATE INDEX IF NOT EXISTS idx_shadow_duplicate_audit_mint
      ON shadow_duplicate_audit(mint, checked_at_ms);
  `);
  initialized = true;
}

export function recordShadowDuplicateCheck({
  timestamp = now(),
  mint,
  symbol = null,
  route = 'unknown',
  duplicateChecked = true,
  duplicateResult,
  duplicateReason = null,
}) {
  if (!SHADOW_MODE) return false;

  try {
    ensureDuplicateAuditTable();
    const result = duplicateResult === 'REJECT' ? 'REJECT' : 'PASS';
    const reason = result === 'REJECT' ? normalizeDuplicateReason(duplicateReason) : 'none';
    db.prepare(`
      INSERT INTO shadow_duplicate_audit (
        checked_at_ms, mint, symbol, route,
        duplicate_checked, duplicate_result, duplicate_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestamp,
      String(mint || ''),
      String(symbol || '').trim() || null,
      String(route || 'unknown'),
      duplicateChecked ? 1 : 0,
      result,
      reason,
    );
    return true;
  } catch (error) {
    console.warn(`[shadow-duplicate-audit] write failed: ${error.message}`);
    return false;
  }
}
