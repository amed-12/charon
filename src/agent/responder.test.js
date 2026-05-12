import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUserLanguage, formatPnlReply, formatPositionsReply, formatStatusReply, generateNaturalReply } from './responder.js';

test('detects Indonesian casual trading messages', () => {
  assert.equal(detectUserLanguage('cek posisi saya sekarang'), 'id');
  assert.equal(detectUserLanguage('ingat jangan pakai degen'), 'id');
});

test('detects English casual trading messages', () => {
  assert.equal(detectUserLanguage('show my open positions'), 'en');
});

test('formats empty open positions naturally in Indonesian', () => {
  const reply = formatPositionsReply({ outputs: [] }, 'id', { openPositions: [] });
  assert.match(reply, /Belum ada posisi open/);
  assert.doesNotMatch(reply, /Intent|Tool/i);
});

test('formats pnl without exposing tool language', () => {
  const reply = formatPnlReply({
    outputs: [{ result: 'Realized: 0.04 SOL (2 closed). Unrealized: -0.01 SOL (1 active). Total: 0.03 SOL.' }],
  }, 'id');
  assert.match(reply, /PnL/);
  assert.match(reply, /Realized/);
  assert.doesNotMatch(reply, /get_pnl|Tool result/i);
});

test('formats status with dry-run lock context', () => {
  const reply = formatStatusReply({ outputs: [] }, 'en', {
    mode: { effective: 'dry_run', dryRunLock: true },
    activeStrategy: { id: 'smart_money' },
    openPositions: [],
  });
  assert.match(reply, /dry_run/);
  assert.match(reply, /DRY_RUN_LOCK/);
});

test('natural responder does not expose raw planner JSON by default', async () => {
  const reply = await generateNaturalReply({
    userMessage: 'cek posisi saya',
    plan: {
      intent: 'fallback_chat',
      confidence: 0,
      requires_confirmation: false,
      summary: '',
      tool_calls: [],
    },
    toolResults: {
      outputs: [{ call: { tool: 'noop' }, ok: true, result: '{"intent":"ask_positions","tool_calls":[{"tool":"get_open_positions"}]}' }],
    },
    state: {},
    language: 'id',
    debug: false,
  });
  assert.doesNotMatch(reply, /"intent"|"tool_calls"|get_open_positions/);
  assert.match(reply, /tidak akan menampilkan JSON mentah/);
});

test('debug mode appends concise intent and tool names', async () => {
  const reply = await generateNaturalReply({
    userMessage: 'cek posisi saya',
    plan: {
      intent: 'ask_positions',
      confidence: 92,
      requires_confirmation: false,
      summary: '',
      tool_calls: [{ tool: 'get_open_positions', args: {} }],
    },
    toolResults: { outputs: [] },
    state: { openPositions: [] },
    language: 'id',
    debug: true,
  });
  assert.match(reply, /Debug:/);
  assert.match(reply, /Intent: ask_positions/);
  assert.match(reply, /Tools: get_open_positions/);
});
