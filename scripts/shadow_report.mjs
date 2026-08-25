import Database from 'better-sqlite3';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const kaiserPath = arg('--kaiser');
const charonPath = arg('--charon');
const sinceMs = Number(arg('--since-ms', 0));
const toleranceMs = Number(arg('--tolerance-ms', 10 * 60 * 1000));

if (!kaiserPath || !charonPath) {
  console.error('usage: node scripts/shadow_report.mjs --kaiser <db> --charon <db> [--since-ms N] [--tolerance-ms N]');
  process.exit(2);
}

function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function loadCandidates(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT c.*,
             d.verdict AS decision_verdict,
             d.confidence AS decision_confidence,
             d.created_at_ms AS decision_at_ms
      FROM candidates c
      LEFT JOIN llm_decisions d ON d.id = (
        SELECT MAX(d2.id) FROM llm_decisions d2 WHERE d2.candidate_id = c.id
      )
      WHERE c.created_at_ms >= ?
      ORDER BY c.created_at_ms, c.id
    `).all(sinceMs);
    return rows.map((row) => {
      const candidate = safeJson(row.candidate_json);
      const pipeline = candidate.sniperPipeline || {};
      const hard = candidate.hardFilters || pipeline.hardFilters || candidate.filters || {};
      return {
        candidateId: row.id,
        mint: row.mint,
        route: candidate.signals?.route || 'unknown',
        atMs: row.created_at_ms,
        status: row.status,
        hardPassed: hard.passed ?? null,
        hardFailures: hard.failures || [],
        softScore: pipeline.softScore?.score ?? null,
        softThreshold: pipeline.softScore?.threshold ?? null,
        preScore: pipeline.preScore?.score ?? null,
        momentumStatus: pipeline.momentum?.status ?? null,
        momentumProbability: pipeline.momentum?.probability ?? null,
        decision: row.decision_verdict || null,
        confidence: row.decision_confidence ?? null,
        decisionAtMs: row.decision_at_ms ?? null,
      };
    });
  } finally {
    db.close();
  }
}

function routeCounts(rows) {
  return Object.fromEntries([...rows.reduce((map, row) => {
    map.set(row.route, (map.get(row.route) || 0) + 1);
    return map;
  }, new Map())].sort(([a], [b]) => a.localeCompare(b)));
}

function decisionCounts(rows) {
  return Object.fromEntries([...rows.reduce((map, row) => {
    const key = row.decision || `NO_DECISION:${row.status}`;
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())].sort(([a], [b]) => a.localeCompare(b)));
}

function pairRows(kaiserRows, charonRows) {
  const byKey = new Map();
  for (const row of charonRows) {
    const key = `${row.mint}|${row.route}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const used = new Set();
  const pairs = [];
  for (const kaiser of kaiserRows) {
    const key = `${kaiser.mint}|${kaiser.route}`;
    const matches = (byKey.get(key) || [])
      .filter((row) => !used.has(row.candidateId) && Math.abs(row.atMs - kaiser.atMs) <= toleranceMs)
      .sort((a, b) => Math.abs(a.atMs - kaiser.atMs) - Math.abs(b.atMs - kaiser.atMs));
    if (!matches.length) continue;
    const charon = matches[0];
    used.add(charon.candidateId);
    const identicalDecision = kaiser.decision === charon.decision
      && kaiser.confidence === charon.confidence;
    pairs.push({
      mint: kaiser.mint,
      route: kaiser.route,
      deltaMs: kaiser.atMs - charon.atMs,
      identicalDecision,
      kaiser,
      charon,
    });
  }
  return pairs;
}

const kaiser = loadCandidates(kaiserPath);
const charon = loadCandidates(charonPath);
const pairs = pairRows(kaiser, charon);
const mismatches = pairs.filter((pair) => !pair.identicalDecision);

console.log(JSON.stringify({
  generatedAtMs: Date.now(),
  sinceMs,
  toleranceMs,
  kaiser: { candidates: kaiser.length, routes: routeCounts(kaiser), decisions: decisionCounts(kaiser) },
  charon: { candidates: charon.length, routes: routeCounts(charon), decisions: decisionCounts(charon) },
  paired: pairs.length,
  identicalDecisions: pairs.length - mismatches.length,
  differentDecisions: mismatches.length,
  unmatchedKaiser: kaiser.length - pairs.length,
  mismatchExamples: mismatches.slice(0, 25),
}, null, 2));
