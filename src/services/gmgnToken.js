import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { GMGN_MAX_TOKEN_DATA_AGE_SECONDS, GMGN_TOKEN_CACHE_TTL_MS } from '../config.js';
import { gmgnFetchWithMeta } from '../enrichment/gmgn.js';
import { now } from '../utils.js';

const tokenCache = new Map();
const SOL_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const ENDPOINTS = {
  detail: '/v1/token/info',
  pool: '/v1/token/pool_info',
  security: '/v1/token/security',
  kline: '/v1/market/token_kline',
};

export function normalizeSolanaAddress(input) {
  const raw = String(input || '').trim();
  const address = extractAddress(raw);
  if (!address) throw classifiedError('invalid_address', 'No Solana address found.');
  try {
    const key = new PublicKey(address);
    if (!PublicKey.isOnCurve(key.toBytes()) && address.length < 32) {
      throw new Error('invalid');
    }
    return key.toBase58();
  } catch {
    throw classifiedError('invalid_address', 'Invalid Solana mint address.');
  }
}

export function detectAddressType(address) {
  const normalized = normalizeSolanaAddress(address);
  return {
    type: 'solana_address',
    normalized,
    uncertain: true,
    warning: 'Solana token mints and pool addresses cannot be distinguished by format alone; GMGN token detail must confirm it.',
  };
}

export async function fetchGmgnTokenDetail(mint, options = {}) {
  return fetchEndpoint('detail', mint, ENDPOINTS.detail, { chain: 'sol', address: mint }, options);
}

export async function fetchGmgnPoolInfo(mint, options = {}) {
  return fetchEndpoint('pool', mint, ENDPOINTS.pool, { chain: 'sol', address: mint }, options);
}

export async function fetchGmgnSecurityInfo(mint, options = {}) {
  return fetchEndpoint('security', mint, ENDPOINTS.security, { chain: 'sol', address: mint }, options);
}

export async function fetchGmgnKline(mint, interval = '5m', options = {}) {
  const to = Math.floor(now() / 1000);
  const from = to - intervalSeconds(interval) * 12;
  return fetchEndpoint('kline', mint, ENDPOINTS.kline, {
    chain: 'sol',
    address: mint,
    resolution: interval,
    from,
    to,
  }, options);
}

export async function fetchGmgnFullTokenSnapshot(input, options = {}) {
  const mint = normalizeSolanaAddress(input);
  const forceFresh = Boolean(options.forceFresh);
  const cached = tokenCache.get(mint);
  if (!forceFresh && cached && now() - cached.cachedAtMs <= GMGN_TOKEN_CACHE_TTL_MS) {
    return {
      ...cached.snapshot,
      cache: { hit: true, age_ms: now() - cached.cachedAtMs, ttl_ms: GMGN_TOKEN_CACHE_TTL_MS },
    };
  }

  const endpoints = [];
  const detail = await requiredEndpoint(() => fetchGmgnTokenDetail(mint, { forceFresh }), 'token detail');
  endpoints.push(endpointDebug('detail', detail));

  const [pool, security, kline] = await Promise.all([
    optionalEndpoint(() => fetchGmgnPoolInfo(mint, { forceFresh }), 'pool'),
    optionalEndpoint(() => fetchGmgnSecurityInfo(mint, { forceFresh }), 'security'),
    optionalEndpoint(() => fetchGmgnKline(mint, '5m', { forceFresh }), 'kline'),
  ]);
  endpoints.push(endpointDebug('pool', pool));
  endpoints.push(endpointDebug('security', security));
  endpoints.push(endpointDebug('kline', kline));

  const raw = {
    detail: unwrapData(detail.payload),
    pool: pool.ok ? unwrapData(pool.payload) : null,
    security: security.ok ? unwrapData(security.payload) : null,
    kline: kline.ok ? unwrapData(kline.payload) : null,
  };
  const mapped = mapGmgnFields(raw, { mint, endpoints });
  const snapshot = {
    ok: true,
    mapped,
    raw,
    endpoints,
    warnings: validationWarnings(mapped, endpoints),
    missing_fields: missingMappedFields(mapped),
    raw_field_names: rawFieldNames(raw),
    cache: { hit: false, age_ms: 0, ttl_ms: GMGN_TOKEN_CACHE_TTL_MS },
  };
  validateGmgnSnapshot(snapshot);
  tokenCache.set(mint, { cachedAtMs: now(), snapshot });
  return snapshot;
}

export function validateGmgnSnapshot(snapshot) {
  if (!snapshot?.mapped) throw classifiedError('response_schema_changed', 'GMGN token snapshot is missing mapped data.');
  if (snapshot.mapped.source !== 'GMGN') throw classifiedError('response_schema_changed', 'Token snapshot source is not GMGN.');
  if (!snapshot.mapped.mint) throw classifiedError('not_found', 'GMGN did not return a token mint.');
  if (!snapshot.mapped.symbol && !snapshot.mapped.name && snapshot.mapped.price_usd == null) {
    throw classifiedError('not_found', 'GMGN token detail did not look like a token mint. It may be a pool address or unknown token.');
  }
  return true;
}

export function mapGmgnFields(raw, context = {}) {
  const detail = raw?.detail || {};
  const pool = firstObject(raw?.pool);
  const security = raw?.security || {};
  const stat = detail.stat || {};
  const walletTags = detail.wallet_tags_stat || {};
  const kline = klineList(raw?.kline);
  const fetchedAtMs = now();
  const sourceTs = maxTimestamp(
    detail.updated_at,
    detail.update_timestamp,
    detail.open_timestamp,
    detail.creation_timestamp,
    pool?.updated_at,
    pool?.creation_timestamp,
    latestKlineTime(kline),
  );
  const price = firstNumber(detail.price, pool?.price, latestKlineClose(kline));
  const circulatingSupply = firstNumber(detail.circulating_supply);
  const totalSupply = firstNumber(detail.total_supply, detail.max_supply);
  const directMcap = firstNumber(detail.market_cap, detail.mcap);
  const marketCap = directMcap ?? (price != null && circulatingSupply != null ? price * circulatingSupply : null);
  const fdv = firstNumber(detail.fdv, detail.fully_diluted_valuation)
    ?? (price != null && totalSupply != null ? price * totalSupply : null);

  return {
    source: 'GMGN',
    chain: 'sol',
    mint: context.mint || detail.address || detail.base_address || '',
    symbol: stringOrEmpty(detail.symbol),
    name: stringOrEmpty(detail.name),
    price_usd: price,
    market_cap_usd: finiteOrNull(marketCap),
    fdv_usd: finiteOrNull(fdv),
    liquidity_usd: firstNumber(detail.liquidity, pool?.liquidity),
    volume_5m_usd: firstNumber(stat.volume_5m, stat.volume_5m_usd, detail.volume_5m, detail.volume_5m_usd),
    volume_1h_usd: firstNumber(stat.volume_1h, stat.volume_1h_usd, detail.volume_1h, detail.volume_1h_usd),
    volume_24h_usd: firstNumber(stat.volume_24h, stat.volume_24h_usd, detail.volume_24h, detail.volume_24h_usd),
    swaps_5m: firstNumber(stat.swaps_5m, stat.swap_5m, stat.trade_5m, detail.swaps_5m),
    swaps_1h: firstNumber(stat.swaps_1h, stat.swap_1h, stat.trade_1h, detail.swaps_1h),
    swaps_24h: firstNumber(stat.swaps_24h, stat.swap_24h, stat.trade_24h, detail.swaps_24h),
    buy_count_5m: firstNumber(stat.buy_5m, stat.buy_count_5m, detail.buy_count_5m),
    sell_count_5m: firstNumber(stat.sell_5m, stat.sell_count_5m, detail.sell_count_5m),
    holder_count: firstNumber(detail.holder_count, security.holder_count),
    top10_holder_percent: percent(firstNumber(stat.top_10_holder_rate, security.top_10_holder_rate)),
    top20_holder_percent: percent(firstNumber(stat.top_20_holder_rate, security.top_20_holder_rate)),
    dev_hold_percent: percent(firstNumber(security.dev_team_hold_rate, security.creator_balance_rate, detail.dev?.creator_balance_rate)),
    sniper_percent: percent(firstNumber(walletTags.sniper_wallet_rate, security.sniper_wallet_rate)),
    insider_percent: percent(firstNumber(security.suspected_insider_hold_rate, security.rat_trader_amount_rate, detail.rat_trader_amount_rate)),
    rug_ratio: firstNumber(security.rug_ratio, detail.rug_ratio),
    bundler_rate: firstNumber(security.bundler_trader_amount_rate, detail.bundler_trader_amount_rate),
    pool_address: stringOrEmpty(pool?.address || detail.biggest_pool_address),
    dex: stringOrEmpty(pool?.exchange || pool?.dex),
    pair_created_at: isoFromTimestamp(pool?.creation_timestamp),
    open_timestamp: isoFromTimestamp(detail.open_timestamp),
    fetched_at: new Date(fetchedAtMs).toISOString(),
    data_age_seconds: sourceTs ? Math.max(0, Math.round((fetchedAtMs - sourceTs) / 1000)) : null,
    raw_source_endpoint: endpointNames(context.endpoints || []),
  };
}

export function formatGmgnCheck(snapshot) {
  const m = snapshot.mapped;
  const cache = snapshot.cache?.hit ? `cached ${(snapshot.cache.age_ms / 1000).toFixed(1)}s` : 'fresh';
  return [
    '<b>GMGN Check</b>',
    '',
    `<b>Token</b>: ${esc(m.symbol || '-')} / ${esc(m.name || '-')}`,
    `<b>Mint</b>: <code>${esc(m.mint)}</code>`,
    '',
    `<b>Source</b>: GMGN`,
    `<b>Fetched</b>: ${timeOnly(m.fetched_at)}`,
    `<b>Data age</b>: ${m.data_age_seconds == null ? 'live timestamp unavailable' : `${m.data_age_seconds}s`}`,
    `<b>Cache</b>: ${cache}`,
    `<b>Endpoint</b>: ${esc(m.raw_source_endpoint)}`,
    '',
    `<b>Price</b>: ${money(m.price_usd)}`,
    `<b>Market cap</b>: ${money(m.market_cap_usd)}`,
    `<b>FDV</b>: ${money(m.fdv_usd)}`,
    `<b>Liquidity</b>: ${money(m.liquidity_usd)}`,
    `<b>Holders</b>: ${num(m.holder_count)}`,
    `<b>Top10 / Top20</b>: ${pct(m.top10_holder_percent)} / ${pct(m.top20_holder_percent)}`,
    `<b>Rug / Bundler</b>: ${ratio(m.rug_ratio)} / ${ratio(m.bundler_rate)}`,
    `<b>Volume 5m / 1h / 24h</b>: ${money(m.volume_5m_usd)} / ${money(m.volume_1h_usd)} / ${money(m.volume_24h_usd)}`,
    `<b>Swaps 5m / 1h / 24h</b>: ${num(m.swaps_5m)} / ${num(m.swaps_1h)} / ${num(m.swaps_24h)}`,
    `\n<b>Risk summary</b>: ${esc(riskSummary(m))}`,
    snapshot.missing_fields.length ? `\n<b>Missing</b>: ${esc(snapshot.missing_fields.join(', ')).slice(0, 700)}` : '',
    snapshot.warnings.length ? `\n<b>Warnings</b>: ${esc(snapshot.warnings.join('; '))}` : '',
  ].filter(Boolean).join('\n');
}

export function formatGmgnRawDebug(snapshot, addressType) {
  return [
    '<b>GMGN Raw Debug</b>',
    '',
    `<b>Normalized mint</b>: <code>${esc(snapshot.mapped.mint)}</code>`,
    `<b>Detected address type</b>: ${esc(addressType.type)}${addressType.uncertain ? ' (format-only; GMGN detail confirmed token data)' : ''}`,
    `<b>Fetched</b>: ${timeOnly(snapshot.mapped.fetched_at)}`,
    `<b>Cache hit</b>: ${snapshot.cache?.hit ? 'true' : 'false'}`,
    '',
    '<b>Endpoints</b>:',
    ...snapshot.endpoints.map(e => `- ${e.name}: HTTP ${e.status || 'n/a'}${e.error ? ` (${esc(e.error)})` : ''}`),
    '',
    `<b>Mapped fields</b>: ${esc(JSON.stringify(snapshot.mapped)).slice(0, 1800)}`,
    `<b>Missing fields</b>: ${esc(snapshot.missing_fields.join(', ') || 'none')}`,
    `<b>Raw field names</b>: ${esc(JSON.stringify(snapshot.raw_field_names)).slice(0, 1200)}`,
  ].join('\n');
}

export function saveGmgnRawDebug(snapshot) {
  const dir = path.resolve('debug');
  fs.mkdirSync(dir, { recursive: true });
  const mint = snapshot.mapped.mint.slice(0, 8);
  const filePath = path.join(dir, `gmgn_${mint}_${now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return filePath;
}

function extractAddress(input) {
  try {
    const url = new URL(input);
    return url.pathname.match(SOL_ADDRESS_RE)?.[0] || url.search.match(SOL_ADDRESS_RE)?.[0] || input.match(SOL_ADDRESS_RE)?.[0];
  } catch {
    return input.match(SOL_ADDRESS_RE)?.[0];
  }
}

async function fetchEndpoint(name, mint, pathname, params, options = {}) {
  const meta = await gmgnFetchWithMeta(pathname, { params });
  return { ok: true, name, mint, pathname, payload: meta.payload, status: meta.status, headers: meta.headers, url: meta.url, fetched_at: new Date().toISOString() };
}

async function requiredEndpoint(fn, label) {
  try {
    return await fn();
  } catch (err) {
    throw classifiedError(classifyFetchError(err), `GMGN ${label} fetch failed: ${err.message}`, err);
  }
}

async function optionalEndpoint(fn, label) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, name: label, error: err.message, reason: classifyFetchError(err), status: err.response?.status || null };
  }
}

function endpointDebug(name, result) {
  return {
    name,
    endpoint: result.pathname || ENDPOINTS[name],
    status: result.status || null,
    ok: Boolean(result.ok),
    fetched_at: result.fetched_at || new Date().toISOString(),
    error: result.error || null,
  };
}

function unwrapData(payload) {
  return payload?.data?.data || payload?.data || payload || {};
}

function firstObject(value) {
  if (Array.isArray(value)) return value[0] || {};
  if (Array.isArray(value?.list)) return value.list[0] || {};
  if (Array.isArray(value?.pools)) return value.pools[0] || {};
  if (Array.isArray(value?.pool)) return value.pool[0] || {};
  return value || {};
}

function klineList(value) {
  const list = value?.list || value?.data?.list || value?.kline || value;
  return Array.isArray(list) ? list : [];
}

function latestKlineTime(list) {
  const last = list[list.length - 1] || {};
  return last.time || last.timestamp || last.t;
}

function latestKlineClose(list) {
  const last = list[list.length - 1] || {};
  return last.close || last.c;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percent(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function maxTimestamp(...values) {
  const timestamps = values.map(timestampMs).filter(Boolean);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function timestampMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 10_000_000_000 ? n : n * 1000;
}

function isoFromTimestamp(value) {
  const ts = timestampMs(value);
  return ts ? new Date(ts).toISOString() : '';
}

function stringOrEmpty(value) {
  return value == null ? '' : String(value);
}

function endpointNames(endpoints) {
  return endpoints.filter(e => e.ok).map(e => e.name === 'detail' ? 'token detail' : e.name === 'pool' ? 'pool info' : e.name).join(' + ');
}

function missingMappedFields(mapped) {
  return Object.entries(mapped)
    .filter(([key, value]) => key !== 'data_age_seconds' && value === null)
    .map(([key]) => key);
}

function validationWarnings(mapped, endpoints) {
  const warnings = [];
  if (mapped.data_age_seconds == null) warnings.push('live timestamp unavailable');
  if (mapped.data_age_seconds != null && mapped.data_age_seconds > GMGN_MAX_TOKEN_DATA_AGE_SECONDS) {
    warnings.push('Data GMGN terlihat stale, analisis ini jangan dipakai untuk entry cepat.');
  }
  for (const endpoint of endpoints.filter(e => !e.ok)) warnings.push(`${endpoint.name} unavailable: ${endpoint.error}`);
  return warnings;
}

function rawFieldNames(raw) {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, fieldNames(value)]));
}

function fieldNames(value) {
  if (!value) return [];
  const object = Array.isArray(value) ? value[0] : firstObject(value);
  return object && typeof object === 'object' ? Object.keys(object).sort() : [];
}

function intervalSeconds(interval) {
  return { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[interval] || 300;
}

function classifyFetchError(err) {
  const status = err.response?.status;
  if (status === 404) return 'not_found';
  if (status === 408 || /timeout/i.test(err.message)) return 'timeout';
  if (status === 429 || /rate/i.test(err.message)) return 'rate_limited';
  if (/schema|JSON/i.test(err.message)) return 'response_schema_changed';
  return status ? `http_${status}` : 'fetch_failed';
}

function classifiedError(reason, message, cause = null) {
  const err = new Error(message);
  err.reason = reason;
  if (cause) err.cause = cause;
  return err;
}

function timeOnly(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) : '-';
}

function money(value) {
  if (value == null) return 'data tidak tersedia';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) < 0.01 && n !== 0) return `$${n.toPrecision(4)}`;
  return `$${n.toFixed(4)}`;
}

function num(value) {
  return value == null ? 'data tidak tersedia' : Number(value).toLocaleString('en-US');
}

function pct(value) {
  return value == null ? 'data tidak tersedia' : `${Number(value).toFixed(2)}%`;
}

function ratio(value) {
  return value == null ? 'data tidak tersedia' : Number(value).toFixed(4);
}

function riskSummary(mapped) {
  const flags = [];
  if (mapped.liquidity_usd != null && mapped.liquidity_usd < 5000) flags.push('liquidity tipis');
  if (mapped.top20_holder_percent != null && mapped.top20_holder_percent > 60) flags.push('top20 holder tinggi');
  if (mapped.rug_ratio != null && mapped.rug_ratio > 0.3) flags.push('rug ratio tinggi');
  if (mapped.bundler_rate != null && mapped.bundler_rate > 0.4) flags.push('bundler rate tinggi');
  if (mapped.holder_count != null && mapped.holder_count < 300) flags.push('holder masih rendah');
  return flags.length ? flags.join(', ') : 'tidak ada red flag utama dari field GMGN yang tersedia';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
