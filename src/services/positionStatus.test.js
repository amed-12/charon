import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initDb } from '../db/connection.js';
import { now, json } from '../utils.js';
import { exportClosedPositions, exportOpenPositions } from './exporter.js';
import { calculateDryRunPnl } from './performance.js';
import { ACTIVE_STATUSES, POSITION_STATUS, normalizePositionStatus, statusSqlList } from './positionStatus.js';

initDb();

function insertPosition(overrides = {}) {
  const at = now();
  const row = {
    mint: `TEST${Math.random().toString(36).slice(2)}111111111111111111111111111111`,
    symbol: 'TST',
    status: POSITION_STATUS.OPEN,
    opened_at_ms: at,
    opened_at: new Date(at).toISOString(),
    size_sol: 1,
    entry_price: 0.001,
    entry_mcap: 100,
    high_water_price: 0.001,
    high_water_mcap: 100,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: 0,
    trailing_percent: 0,
    trailing_armed: 0,
    strategy_id: 'sniper',
    remaining_amount: 1,
    is_closed: 0,
    snapshot_json: json({ test: true }),
    ...overrides,
  };
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, opened_at, closed_at_ms, closed_at,
      size_sol, entry_price, entry_mcap, high_water_price, high_water_mcap,
      exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
      realized_pnl_sol, unrealized_pnl_sol, realized_pnl_percent, unrealized_pnl_percent,
      tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed,
      strategy_id, remaining_amount, partial_tp_done, is_closed, snapshot_json
    ) VALUES (
      @mint, @symbol, @status, @opened_at_ms, @opened_at, @closed_at_ms, @closed_at,
      @size_sol, @entry_price, @entry_mcap, @high_water_price, @high_water_mcap,
      @exit_price, @exit_mcap, @exit_reason, @pnl_percent, @pnl_sol,
      @realized_pnl_sol, @unrealized_pnl_sol, @realized_pnl_percent, @unrealized_pnl_percent,
      @tp_percent, @sl_percent, @trailing_enabled, @trailing_percent, @trailing_armed,
      @strategy_id, @remaining_amount, @partial_tp_done, @is_closed, @snapshot_json
    )
  `).run({
    closed_at_ms: null,
    closed_at: null,
    exit_price: null,
    exit_mcap: null,
    exit_reason: null,
    pnl_percent: 0,
    pnl_sol: 0,
    realized_pnl_sol: 0,
    unrealized_pnl_sol: 0,
    realized_pnl_percent: 0,
    unrealized_pnl_percent: 0,
    partial_tp_done: 0,
    ...row,
  });
  return Number(result.lastInsertRowid);
}

function cleanup(ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM dry_run_positions WHERE id IN (${placeholders})`).run(...ids);
}

test('open and closed position separation rules', () => {
  const ids = [];
  try {
    ids.push(insertPosition());
    const partialId = insertPosition({
      status: POSITION_STATUS.PARTIALLY_CLOSED,
      partial_tp_done: 1,
      remaining_amount: 0.5,
      realized_pnl_sol: 0.2,
      realized_pnl_percent: 20,
      high_water_mcap: 160,
      unrealized_pnl_sol: 0.1,
      unrealized_pnl_percent: 10,
    });
    ids.push(partialId);
    const closedAt = now();
    ids.push(insertPosition({
      status: POSITION_STATUS.CLOSED,
      closed_at_ms: closedAt,
      closed_at: new Date(closedAt).toISOString(),
      exit_mcap: 80,
      exit_price: 0.0008,
      exit_reason: 'SL',
      realized_pnl_sol: -0.2,
      realized_pnl_percent: -20,
      remaining_amount: 0,
      is_closed: 1,
    }));

    const active = db.prepare(`SELECT id FROM dry_run_positions WHERE status IN (${statusSqlList(ACTIVE_STATUSES)}) AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id);
    const closed = db.prepare(`SELECT id FROM dry_run_positions WHERE status = ? AND id IN (${ids.map(() => '?').join(',')})`).all(POSITION_STATUS.CLOSED, ...ids).map(r => r.id);
    assert.equal(active.includes(ids[0]), true);
    assert.equal(active.includes(partialId), true);
    assert.equal(closed.includes(ids[0]), false);
    assert.equal(closed.length, 1);
    assert.equal(db.prepare('SELECT realized_pnl_sol FROM dry_run_positions WHERE id = ?').get(partialId).realized_pnl_sol, 0.2);
  } finally {
    cleanup(ids);
  }
});

test('normalizer detects inconsistent records', () => {
  const row = normalizePositionStatus({ id: 999999, status: 'CLOSED', remaining_amount: 1, is_closed: 0 });
  assert.equal(row.status, POSITION_STATUS.CLOSED);
  assert.ok(row.issues.includes('CLOSED with remaining_amount > 0'));
  assert.ok(row.issues.includes('CLOSED with is_closed = 0'));
});

test('open and closed exports stay separated', () => {
  const ids = [];
  try {
    ids.push(insertPosition());
    const closedAt = now();
    ids.push(insertPosition({
      status: POSITION_STATUS.CLOSED,
      closed_at_ms: closedAt,
      closed_at: new Date(closedAt).toISOString(),
      exit_mcap: 150,
      exit_price: 0.0015,
      exit_reason: 'TP',
      ...calculateDryRunPnl({ sizeSol: 1, entryMcap: 100, exitMcap: 150 }),
      realized_pnl_sol: 0.4,
      realized_pnl_percent: 40,
      remaining_amount: 0,
      is_closed: 1,
    }));
    const openExport = exportOpenPositions();
    const closedExport = exportClosedPositions('all');
    assert.match(openExport.filePath, /open_positions_/);
    assert.match(closedExport.filePath, /closed_positions_/);
  } finally {
    cleanup(ids);
  }
});
