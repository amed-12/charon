import WebSocket from 'ws';

const apiKey = process.env.PUMPPORTAL_API_KEY || '';
const timeoutMs = Number(process.env.PUMPPORTAL_PROBE_TIMEOUT_MS || 60_000);
const subscriptions = ['subscribeNewToken', 'subscribeMigration'];

if (!apiKey) {
  console.log(JSON.stringify({
    status: 'blocked_missing_api_key',
    connected: false,
    subscriptions,
  }, null, 2));
  process.exit(2);
}

const startedAtMs = Date.now();
const result = {
  status: 'connecting',
  connected: false,
  connectedAtMs: null,
  subscriptions,
  firstEvent: null,
};

const ws = new WebSocket(`wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(apiKey)}`);
let finished = false;

function finish(status, exitCode = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  result.status = status;
  result.elapsedMs = Date.now() - startedAtMs;
  console.log(JSON.stringify(result, null, 2));
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(exitCode), 50);
}

const timeout = setTimeout(() => {
  finish(result.connected ? 'connected_silent' : 'connection_timeout', result.connected ? 0 : 1);
}, timeoutMs);

ws.on('open', () => {
  result.connected = true;
  result.connectedAtMs = Date.now();
  for (const method of subscriptions) ws.send(JSON.stringify({ method }));
});

ws.on('message', (raw) => {
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (payload?.txType !== 'create' && payload?.txType !== 'migrate') return;
  result.firstEvent = {
    txType: payload.txType,
    mint: payload.mint || null,
    symbol: payload.symbol || null,
    receivedAtMs: Date.now(),
  };
  finish('event_received');
});

ws.on('error', (error) => {
  result.error = String(error?.message || error).replaceAll(apiKey, '[redacted]');
  finish('connection_error', 1);
});

ws.on('close', (code) => {
  result.closeCode = code;
  if (!finished) finish(result.connected ? 'closed_after_connect' : 'closed_before_connect', 1);
});
