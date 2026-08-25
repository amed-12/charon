import assert from 'node:assert/strict';
import fs from 'node:fs';

import { GRADUATED_POLL_MS } from '../src/config.js';
import {
  GRADUATED_SOURCE_STATUS,
  graduated,
  setCandidateHandler,
  startGraduationPolling,
  stopGraduationPolling,
} from '../src/signals/graduated.js';
import { sniperRouteForSignal } from '../src/signals/sniperRoutes.js';

assert.equal(GRADUATED_POLL_MS, 30_000, 'graduated default remains 30 seconds');
assert.equal(GRADUATED_SOURCE_STATUS.source, 'helius');
assert.equal(GRADUATED_SOURCE_STATUS.route, 'graduated');
assert.equal(GRADUATED_SOURCE_STATUS.healthy, false);
assert.ok(['disabled', 'degraded'].includes(GRADUATED_SOURCE_STATUS.state));
assert.match(GRADUATED_SOURCE_STATUS.reason, /missing_helius_credential|helius_graduation_detector_unresolved/);

let emitted = 0;
setCandidateHandler(() => { emitted++; });
const status = startGraduationPolling();
stopGraduationPolling();
assert.equal(status, GRADUATED_SOURCE_STATUS);
assert.equal(emitted, 0, 'unverified detector must not fabricate fresh graduation signals');
assert.equal(graduated.size >= 0, true);

assert.equal(
  sniperRouteForSignal({ sources: ['pumpportal_graduated'] }, {}),
  'pumpportal_graduated',
);
assert.equal(
  sniperRouteForSignal({ sources: ['helius_graduated'] }, {}),
  'graduated',
);

const appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(appSource, /fetchGraduatedCoins/, 'runtime must not call legacy unauthenticated endpoint');

console.log('=== Charon graduated source status tests complete ===');
