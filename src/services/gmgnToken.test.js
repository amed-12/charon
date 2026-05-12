import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGmgnFields, normalizeSolanaAddress, validateGmgnSnapshot } from './gmgnToken.js';

const SOL = 'So11111111111111111111111111111111111111112';

test('normalizes raw Solana mint and GMGN URL', () => {
  assert.equal(normalizeSolanaAddress(SOL), SOL);
  assert.equal(normalizeSolanaAddress(`https://gmgn.ai/sol/token/${SOL}`), SOL);
});

test('maps GMGN fields without cross-mapping unsafe values', () => {
  const mapped = mapGmgnFields({
    detail: {
      address: SOL,
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      price: '100',
      fdv: '999',
      liquidity: '12345',
      holder_count: '42',
      stat: {
        volume_5m: '5',
        volume_1h: '60',
        volume_24h: '1440',
        top_10_holder_rate: '0.12',
        top_20_holder_rate: '0.34',
      },
    },
    security: {
      rug_ratio: '0.01',
      bundler_trader_amount_rate: '0.02',
    },
    pool: { address: 'Pool1111111111111111111111111111111111111', exchange: 'raydium' },
  }, { mint: SOL, endpoints: [{ name: 'detail', ok: true }] });

  assert.equal(mapped.source, 'GMGN');
  assert.equal(mapped.mint, SOL);
  assert.equal(mapped.market_cap_usd, null);
  assert.equal(mapped.fdv_usd, 999);
  assert.equal(mapped.liquidity_usd, 12345);
  assert.equal(mapped.volume_5m_usd, 5);
  assert.equal(mapped.volume_1h_usd, 60);
  assert.equal(mapped.volume_24h_usd, 1440);
  assert.equal(mapped.top10_holder_percent, 12);
  assert.equal(mapped.top20_holder_percent, 34);
});

test('validation rejects snapshots that do not look like GMGN token detail', () => {
  assert.throws(() => validateGmgnSnapshot({
    mapped: {
      source: 'GMGN',
      mint: SOL,
      symbol: '',
      name: '',
      price_usd: null,
    },
  }), /pool address|unknown token/);
});
