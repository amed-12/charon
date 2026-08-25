import {
  computeSoftScore,
  dynamicSoftScoreThreshold,
  preScoreCandidate,
  SNIPER_POLICY,
} from './sniperPolicy.js';
import { momentumFilter } from './momentumFilter.js';

function failedOverallFilters(hardFilters, failure) {
  return {
    ...hardFilters,
    passed: false,
    failures: [...(hardFilters?.failures || []), failure],
  };
}

export async function applySniperDecisionPipeline(candidate, {
  openPositionCount = 0,
  maxPositions = 5,
  runPrediction,
} = {}) {
  const hardFilters = candidate.filters;
  const pipeline = {
    hardFilters,
    softScore: null,
    preScore: null,
    momentum: null,
    passed: false,
    failedStage: null,
  };
  candidate.hardFilters = hardFilters;

  if (!hardFilters?.passed) {
    pipeline.failedStage = 'hard_filters';
    candidate.sniperPipeline = pipeline;
    return pipeline;
  }

  const soft = computeSoftScore(candidate);
  const softThreshold = dynamicSoftScoreThreshold(openPositionCount, maxPositions);
  pipeline.softScore = { ...soft, threshold: softThreshold, passed: soft.score >= softThreshold };
  if (!pipeline.softScore.passed) {
    pipeline.failedStage = 'soft_score';
    candidate.filters = failedOverallFilters(hardFilters, `soft score: ${soft.score} < ${softThreshold}`);
    candidate.sniperPipeline = pipeline;
    return pipeline;
  }

  pipeline.preScore = preScoreCandidate(candidate);
  if (!pipeline.preScore.passed) {
    pipeline.failedStage = 'pre_score';
    candidate.filters = failedOverallFilters(hardFilters, `pre-score: ${pipeline.preScore.score} < ${SNIPER_POLICY.preScoreThreshold}`);
    candidate.sniperPipeline = pipeline;
    return pipeline;
  }

  pipeline.momentum = await momentumFilter(candidate, { runPrediction });
  if (pipeline.momentum.failsafe) {
    console.log(`[momentum] FAILSAFE PASS ${candidate.token?.mint?.slice(0, 8) || 'unknown'} status=${pipeline.momentum.status}${pipeline.momentum.error ? ` error=${pipeline.momentum.error}` : ''}`);
  }
  if (!pipeline.momentum.passed) {
    pipeline.failedStage = 'momentum';
    candidate.filters = failedOverallFilters(hardFilters, `momentum: ${pipeline.momentum.probability} < ${SNIPER_POLICY.momentumThreshold}`);
    candidate.sniperPipeline = pipeline;
    return pipeline;
  }

  pipeline.passed = true;
  candidate.sniperPipeline = pipeline;
  return pipeline;
}
