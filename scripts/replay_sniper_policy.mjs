#!/usr/bin/env node
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = option('--db');
const referenceRoot = option('--reference-root', '/home/ubuntu/charon');
const limit = Number(option('--limit', '0'));
if (!dbPath) {
  console.error('usage: node scripts/replay_sniper_policy.mjs --db <snapshot.sqlite> [--reference-root <path>] [--limit N]');
  process.exit(2);
}

const integrated = await import('../src/pipeline/sniperPolicy.js');
const reference = await import(pathToFileURL(path.resolve(referenceRoot, 'src/pipeline/sniperPolicy.js')).href);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const strategyRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'sniper'").get();
const strategy = { id: 'sniper', ...(strategyRow ? JSON.parse(strategyRow.config_json) : {}) };
const rows = db.prepare(`
  SELECT id, mint, created_at_ms, candidate_json
  FROM candidates
  ORDER BY created_at_ms ASC, id ASC
  ${limit > 0 ? 'LIMIT ?' : ''}
`).all(...(limit > 0 ? [limit] : []));

function verdict(policy, candidate) {
  const hard = policy.evaluateSniperHardFilters(candidate, strategy);
  const soft = policy.computeSoftScore(candidate);
  const pre = policy.preScoreCandidate(candidate);
  const ml = policy.momentumFeatures(candidate);
  const momentumPassed = ml.missing.length > 0 || 0.75 >= policy.SNIPER_POLICY.momentumThreshold;
  return {
    route: candidate?.signals?.route || null,
    hardPassed: hard.passed,
    hardFailures: hard.failures,
    softScore: soft.score,
    thresholds: [20, 30, 40].map(threshold => soft.score >= threshold),
    preScore: pre.score,
    prePassed: pre.passed,
    momentumStatus: ml.missing.length ? 'failsafe_missing_data' : 'fixture_pass_0.75',
    momentumPassed,
    decision: hard.passed && soft.score >= 30 && pre.passed && momentumPassed ? 'BUY' : 'REJECT',
    confidence: hard.passed && soft.score >= 30 && pre.passed && momentumPassed ? 100 : null,
    sizeSol: strategy.position_size_sol,
  };
}

const result = {
  snapshot: dbPath,
  referenceRoot,
  sharedCandidates: 0,
  identical: 0,
  different: 0,
  parseErrors: 0,
  differenceAreas: {},
  examples: [],
  decisionDifferenceExamples: [],
};
for (const row of rows) {
  let candidate;
  try {
    candidate = JSON.parse(row.candidate_json);
  } catch {
    result.parseErrors += 1;
    continue;
  }
  result.sharedCandidates += 1;
  const before = verdict(reference, candidate);
  const after = verdict(integrated, candidate);
  const areas = Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (areas.length === 0) {
    result.identical += 1;
    continue;
  }
  result.different += 1;
  for (const area of areas) result.differenceAreas[area] = (result.differenceAreas[area] || 0) + 1;
  const difference = { candidateId: row.id, route: after.route, areas, before, after };
  if (result.examples.length < 20) result.examples.push(difference);
  if (areas.includes('decision') && result.decisionDifferenceExamples.length < 20) {
    result.decisionDifferenceExamples.push(difference);
  }
}
db.close();
console.log(JSON.stringify(result, null, 2));
