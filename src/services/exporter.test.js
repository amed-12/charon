import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDb } from '../db/connection.js';
import { exportCandidates, exportTrades } from './exporter.js';

initDb();

test('CSV exporters create local files', () => {
  const trades = exportTrades('all');
  const candidates = exportCandidates('all');
  assert.equal(fs.existsSync(trades.filePath), true);
  assert.equal(fs.existsSync(candidates.filePath), true);
  assert.match(fs.readFileSync(trades.filePath, 'utf8'), /^trade_id,/);
  assert.match(fs.readFileSync(candidates.filePath, 'utf8'), /^candidate_id,/);
});
