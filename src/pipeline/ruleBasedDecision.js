/**
 * Build the existing synthetic decision used by any strategy with use_llm=false.
 * This is intentionally separate from candidate filtering: passing a filter and creating
 * a decision remain distinct pipeline stages.
 */
export function buildRuleBasedDecision(candidateId, candidate, selectedRow, strat, {
  defaultTpPercent = 50,
  defaultSlPercent = -25,
} = {}) {
  return {
    verdict: 'BUY',
    confidence: 100,
    selected_candidate_id: candidateId,
    selected_mint: candidate.token.mint,
    selected_row: selectedRow,
    reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
    risks: [],
    suggested_tp_percent: strat.tp_percent ?? defaultTpPercent,
    suggested_sl_percent: strat.sl_percent ?? defaultSlPercent,
    raw: null,
  };
}
