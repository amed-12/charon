import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { momentumFeatures, SNIPER_POLICY } from './sniperPolicy.js';

export const MOMENTUM_MODEL = Object.freeze({
  type: 'Random Forest',
  version: 'V2',
  dated: '2026-07-15',
  featureOrder: [
    'price_change_1h',
    'price_change_5m',
    'price_change_1m',
    'smart_degen_count',
    'holder_count',
    'liquidity',
    'bundler_rate',
    'organic_score',
  ],
});

const DEFAULT_SCRIPT = fileURLToPath(new URL('../../scripts/predict_momentum.py', import.meta.url));

export function runMomentumPrediction(features, { timeoutMs = SNIPER_POLICY.momentumTimeoutMs, script = DEFAULT_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.PYTHON_BIN || 'python3',
      [script, JSON.stringify(features)],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.details = String(stderr || '').trim();
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || '').trim()));
        } catch (parseError) {
          reject(new Error(`invalid momentum output: ${parseError.message}`));
        }
      },
    );
  });
}

export async function momentumFilter(candidate, { runPrediction = runMomentumPrediction } = {}) {
  const { features, missing } = momentumFeatures(candidate);
  if (missing.length) {
    return {
      passed: true,
      failsafe: true,
      status: 'missing_data',
      probability: null,
      threshold: SNIPER_POLICY.momentumThreshold,
      features,
      missing,
    };
  }
  try {
    const prediction = await runPrediction(features);
    const probability = Number(prediction?.runner_probability ?? prediction?.probability);
    if (!Number.isFinite(probability)) throw new Error('runner probability missing');
    return {
      passed: probability >= SNIPER_POLICY.momentumThreshold,
      failsafe: false,
      status: 'predicted',
      probability,
      threshold: SNIPER_POLICY.momentumThreshold,
      features,
      missing: [],
      model: prediction?.model || MOMENTUM_MODEL,
    };
  } catch (error) {
    return {
      passed: true,
      failsafe: true,
      status: error?.killed || error?.code === 'ETIMEDOUT' ? 'timeout' : 'model_error',
      probability: null,
      threshold: SNIPER_POLICY.momentumThreshold,
      features,
      missing: [],
      error: String(error?.details || error?.message || error),
    };
  }
}
