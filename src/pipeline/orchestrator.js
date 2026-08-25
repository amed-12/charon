import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { buildRuleBasedDecision } from './ruleBasedDecision.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';
import { applySniperDecisionPipeline } from './sniperPipeline.js';
import { checkDuplicateCandidate, checkPastWinGuard } from './duplicateGuard.js';
import { recordShadowDuplicateCheck } from '../observability/duplicateAudit.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export function signalSymbol(signals) {
  return signals.symbol || signals.trendingToken?.symbol || signals.graduatedCoin?.ticker || signals.graduatedCoin?.symbol || '';
}

export async function processCandidateFromSignals(signals) {
  const strategyAtSignal = activeStrategy();
  if (strategyAtSignal.id === 'sniper') {
    const symbol = signalSymbol(signals);
    const duplicate = checkDuplicateCandidate({ mint: signals.mint, symbol });
    recordShadowDuplicateCheck({
      timestamp: now(),
      mint: signals.mint,
      symbol,
      route: signals.route,
      duplicateChecked: true,
      duplicateResult: duplicate.duplicate ? 'REJECT' : 'PASS',
      duplicateReason: duplicate.rule,
    });
    if (duplicate.duplicate) {
      console.log(`[duplicate] skip ${signals.mint.slice(0, 8)}... rule=${duplicate.rule} ${duplicate.detail}`);
      return;
    }
    pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
    const seenKey = `sniper:${signals.mint}`;
    if (seenSignalCandidates.has(seenKey)) {
      console.log(`[duplicate] skip ${signals.mint.slice(0, 8)}... rule=in_flight_candidate`);
      return;
    }
    seenSignalCandidates.set(seenKey, now());
  }
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = strategyAtSignal.max_open_positions ?? numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const strat = activeStrategy();
  if (strat.id === 'sniper') {
    await applySniperDecisionPipeline(candidate, {
      openPositionCount: openPositionCount(),
      maxPositions: strat.max_open_positions ?? 5,
    });
  }
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }
  console.log(`[candidate] passed ${candidate.token.mint.slice(0, 8)}... strategy=${candidate.filters.strategy} route=${candidate.signals.route}`);

  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = buildRuleBasedDecision(candidateId, candidate, selfRow, strat, {
      defaultTpPercent: strat.tp_percent == null ? numSetting('default_tp_percent', 50) : 50,
      defaultSlPercent: strat.sl_percent == null ? numSetting('default_sl_percent', -25) : -25,
    });
    console.log(`[decision] rule-based BUY ${candidate.token.mint.slice(0, 8)}... confidence=100 strategy=${strat.id}`);
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence', 75)) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 75),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (freshSelectedRow.candidate.filters?.strategy === 'sniper') {
    const pastWin = checkPastWinGuard(freshSelectedRow.candidate.token.mint);
    if (!pastWin.allowed) {
      updateCandidateStatus(freshSelectedRow.id, 'reentry_rejected');
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'entry_rejected_past_win',
        guardrails: { reason: pastWin.reason },
      });
      return;
    }
  }

  if (mode === 'dry_run') {
    const { id: positionId, isNew } = await createDryRunPosition(
      freshSelectedRow.id,
      freshSelectedRow.candidate,
      decision,
      `rule_based_${freshSelectedRow.candidate.filters?.strategy || 'strategy'}`,
    );
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: isNew ? 'dry_run_entry' : 'dry_run_duplicate_position',
      guardrails: {
        maxOpenPositions: activeStrategy().max_open_positions ?? numSetting('max_open_positions', 3),
        openPositions: openPositionCount(),
      },
      execution: { positionId, isNew },
    });
    if (isNew) await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
