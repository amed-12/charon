import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOpenPosition, formatPositionList, getPositionDecorations } from './positionFormatter.js';
import { POSITION_STATUS } from '../../services/positionStatus.js';

function position(overrides = {}) {
  return {
    id: 141,
    mint: '5Sw1AU111111111111111111111111111111pump',
    symbol: 'GOATSE',
    status: POSITION_STATUS.OPEN,
    execution_mode: 'dry_run',
    strategy_id: 'sniper',
    entry_mcap: 17_900,
    current_mcap: 17_700,
    entry_price: 0.0000179,
    current_price: 0.0000177,
    high_water_mcap: 17_900,
    lowest_mcap: 17_500,
    size_sol: 0.02,
    unrealized_pnl_percent: -1,
    unrealized_pnl_sol: -0.0002,
    tp_percent: 40,
    sl_percent: -15,
    trailing_enabled: 1,
    trailing_percent: 20,
    ...overrides,
  };
}

test('decorates losing open position and includes current fields', () => {
  const text = formatOpenPosition(position());
  assert.match(text, /🔴 OPEN POSITION/);
  assert.match(text, /Current Price:/);
  assert.match(text, /Current Mcap:/);
  assert.match(text, /To TP: 41.0%/);
  assert.match(text, /To SL: 14.0%/);
});

test('decorates profitable, near TP, near SL, TP zone, and partial states', () => {
  assert.equal(getPositionDecorations(position({ unrealized_pnl_percent: 5 })).header, '🟢 OPEN POSITION');
  assert.equal(getPositionDecorations(position({ unrealized_pnl_percent: 34.5 })).header, '🚀 NEAR TAKE PROFIT');
  assert.equal(getPositionDecorations(position({ unrealized_pnl_percent: -12.8 })).header, '⚠️ RISK ZONE — NEAR STOP LOSS');
  assert.equal(getPositionDecorations(position({ unrealized_pnl_percent: 42 })).header, '🎯 TP ZONE');
  assert.equal(getPositionDecorations(position({ status: POSITION_STATUS.PARTIALLY_CLOSED })).header, '🟡 PARTIALLY CLOSED');
});

test('missing current price shows N/A without crashing', () => {
  const text = formatOpenPosition(position({ current_price: null, current_mcap: null }));
  assert.match(text, /Current Price: N\/A/);
  assert.match(text, /Current Mcap: N\/A/);
});

test('position list uses decorated format', () => {
  const text = formatPositionList([position({ unrealized_pnl_percent: 34.5 })]);
  assert.match(text, /🚀 NEAR TAKE PROFIT/);
});
