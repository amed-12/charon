import { db } from '../db/connection.js';
import { now } from '../utils.js';

export const POSITION_STATUS = {
  OPEN: 'OPEN',
  PARTIALLY_CLOSED: 'PARTIALLY_CLOSED',
  CLOSED: 'CLOSED',
  FAILED_ENTRY: 'FAILED_ENTRY',
  FAILED_EXIT: 'FAILED_EXIT',
  CANCELLED: 'CANCELLED',
};

export const ACTIVE_STATUSES = [POSITION_STATUS.OPEN, POSITION_STATUS.PARTIALLY_CLOSED];
export const INACTIVE_STATUSES = [
  POSITION_STATUS.CLOSED,
  POSITION_STATUS.FAILED_ENTRY,
  POSITION_STATUS.FAILED_EXIT,
  POSITION_STATUS.CANCELLED,
];

export function canonicalStatus(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'OPEN') return POSITION_STATUS.OPEN;
  if (raw === 'PARTIALLY_CLOSED' || raw === 'PARTIAL') return POSITION_STATUS.PARTIALLY_CLOSED;
  if (raw === 'CLOSED') return POSITION_STATUS.CLOSED;
  if (raw === 'FAILED_ENTRY') return POSITION_STATUS.FAILED_ENTRY;
  if (raw === 'FAILED_EXIT') return POSITION_STATUS.FAILED_EXIT;
  if (raw === 'CANCELLED' || raw === 'CANCELED') return POSITION_STATUS.CANCELLED;
  return POSITION_STATUS.OPEN;
}

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(canonicalStatus(status));
}

export function isClosedStatus(status) {
  return canonicalStatus(status) === POSITION_STATUS.CLOSED;
}

export function normalizePositionStatus(position, { repair = false } = {}) {
  const issues = [];
  const current = canonicalStatus(position.status);
  let status = current;
  const hasClosedAt = Boolean(position.closed_at || position.closed_at_ms);
  const hasExit = Boolean(position.exit_reason || position.exit_mcap || position.exit_price);
  const remaining = Number(position.remaining_amount ?? position.token_amount_est ?? 0);

  if (current === POSITION_STATUS.OPEN && hasClosedAt) {
    status = POSITION_STATUS.CLOSED;
    issues.push('OPEN with closed_at');
  }
  if (current === POSITION_STATUS.CLOSED && !hasClosedAt) {
    issues.push('CLOSED without closed_at');
  }
  if (current === POSITION_STATUS.CLOSED && remaining > 0) {
    issues.push('CLOSED with remaining_amount > 0');
  }
  if (current === POSITION_STATUS.OPEN && Number(position.is_closed || 0) === 1) {
    issues.push('OPEN with is_closed = 1');
  }
  if (current === POSITION_STATUS.CLOSED && Number(position.is_closed || 0) === 0) {
    issues.push('CLOSED with is_closed = 0');
  }
  if (status === POSITION_STATUS.OPEN && Number(position.partial_tp_done || 0) === 1 && remaining > 0) {
    status = POSITION_STATUS.PARTIALLY_CLOSED;
  }
  if (current === POSITION_STATUS.FAILED_ENTRY || current === POSITION_STATUS.FAILED_EXIT || current === POSITION_STATUS.CANCELLED) {
    status = current;
  } else if (hasExit && !isActiveStatus(status)) {
    status = POSITION_STATUS.CLOSED;
  }

  const isClosed = INACTIVE_STATUSES.includes(status) ? 1 : 0;
  const closedAtMs = hasClosedAt ? Number(position.closed_at_ms || Date.parse(position.closed_at)) : null;
  const openedAtMs = Number(position.opened_at_ms || Date.parse(position.opened_at) || now());
  const repairs = {
    status,
    is_closed: isClosed,
    opened_at: position.opened_at || new Date(openedAtMs).toISOString(),
    closed_at: closedAtMs ? new Date(closedAtMs).toISOString() : null,
    remaining_amount: status === POSITION_STATUS.CLOSED ? 0 : Number(position.remaining_amount ?? position.token_amount_est ?? position.size_sol ?? 0),
  };

  if (repair && position.id && (issues.length || status !== current)) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = ?, is_closed = ?, opened_at = ?, closed_at = ?,
          remaining_amount = ?, closed_at_ms = CASE WHEN ? IS NULL THEN closed_at_ms ELSE ? END
      WHERE id = ?
    `).run(repairs.status, repairs.is_closed, repairs.opened_at, repairs.closed_at, repairs.remaining_amount, closedAtMs, closedAtMs, position.id);
  }

  return { ...position, ...repairs, status, issues };
}

export function auditPositions({ repair = false } = {}) {
  const rows = db.prepare('SELECT * FROM dry_run_positions ORDER BY id').all();
  const normalized = rows.map(row => normalizePositionStatus(row, { repair }));
  const count = status => normalized.filter(row => row.status === status).length;
  const inconsistent = normalized.filter(row => row.issues.length);
  return {
    total: normalized.length,
    open: count(POSITION_STATUS.OPEN),
    partiallyClosed: count(POSITION_STATUS.PARTIALLY_CLOSED),
    closed: count(POSITION_STATUS.CLOSED),
    failedEntries: count(POSITION_STATUS.FAILED_ENTRY),
    failedExits: count(POSITION_STATUS.FAILED_EXIT),
    cancelled: count(POSITION_STATUS.CANCELLED),
    inconsistent,
  };
}

export function statusSqlList(statuses) {
  return statuses.map(status => `'${status}'`).join(',');
}
