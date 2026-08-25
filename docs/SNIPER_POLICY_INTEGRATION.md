# Kaiser Sniper Policy Integration

## Sources and authority

- Kaiser.charon commit `3c8e56b` remains the infrastructure and signal chassis.
- The verified local Charon policy was read from commit `1f7b825a1d60f3b2ba60497aaa8cbd93fe8cf3dc` plus its audited working-tree policy/tests.
- Integration work is isolated on `integration/sniper-policy`.
- No production database or PM2 process is used by this branch.

## Executable Sniper pipeline

```text
Kaiser signal acquisition
→ early capacity check
→ inclusive duplicate guard
→ route-aware enrichment/normalization
→ hard filters
→ soft score
→ dynamic threshold
→ pre-score
→ Momentum V2 adapter
→ rule-based BUY (confidence 100)
→ fresh enrichment and hard re-filter
→ indefinite past-win guard
→ capacity recheck
→ atomic position reservation/creation
→ Jupiter execution or dry-run simulation
→ position monitoring
```

Sniper has `use_llm=false`. The LLM path remains available for other strategies.

## Signal routes preserved

| Kaiser source | Normalized Sniper route |
| --- | --- |
| PumpPortal WebSocket graduation/migration | `pumpportal_graduated` |
| PumpFun pre-graduation scanner | `pumpfun_pregrad` |
| Fee claim watcher/server fee source | `fee_*` |
| Fee claim plus tracked GMGN/Jupiter trending | `fee_trending` |
| GMGN Trenches completion | `trenches_completed` |
| Graduation poll | `graduated` |

Direct trending remains an enrichment source for Sniper and does not independently enter
the Sniper policy. Other strategies retain Kaiser's legacy route behavior.

PumpPortal uses `PUMPPORTAL_ENABLED` and `PUMPPORTAL_API_KEY`, subscribes to
`subscribeNewToken` and `subscribeMigration`, and emits
`pumpportal_graduated`. PumpPortal signal acquisition does not change the Jupiter
execution backend.

## Policy contract

- Duplicate windows are inclusive: closed 72h, decision 24h, candidate 10m across routes,
  same symbol 24h. `open`, `entering`, and `exiting` count as held exposure.
- Liquidity must be at least $6,000.
- Jupiter `stats1h.priceChange` rejects only finite values below zero.
- Jupiter `stats5m.numNetBuyers / numTraders` rejects only a finite ratio below 0.2.
  Missing, invalid, non-finite, or zero-denominator Jupiter flow data passes.
- Established routes require GMGN buy/sell ratio >= 1.0. PumpPortal fresh graduates are exempt.
- Wash trading is rejected. Audit metrics remain soft.
- Soft score starts at 100 and is clamped to 0–150. This is tested runtime behavior;
  its older historical calibration remains unproven.
- Dynamic thresholds are 20 idle, 30 normal, and 40 at 4/5 or more open.
- The reconstructed pre-score mapping is retained; threshold 35 is inclusive.
- Momentum threshold is 0.5, timeout is 8 seconds, and every inference failure fails open.

## Position contract

| Setting | Sniper behavior |
| --- | --- |
| Maximum exposure | 5 holding positions |
| Size | 0.1 SOL |
| TP / trailing arm | +75%; arms trailing when enabled |
| Trailing distance | 10% from high-water |
| Base SL | -35% fallback |
| Valid ATR stop | clamp(-ATR% × 2.5, -50%, -8%) |
| Max hold | 1,800,000 ms |
| Partial TP | disabled |
| Sideways timeout | disabled |
| Dry-run slippage | 200 bps (2%) |

At +75% with trailing enabled, the position stays open and trailing is armed. A later drop
of 10% from high-water closes it as `TRAILING_TP`. With trailing disabled, +75% closes
as `TP`. `MAX_HOLD` is evaluated before standard TP/SL/trailing exits.

## Momentum artifact verdict

The Kaiser artifacts are not enabled by the Momentum V2 adapter:

- `models/momentum_model.pkl`: `GradientBoostingClassifier`, not Random Forest.
- `models/momentum_scaler.pkl`: mandatory `StandardScaler`.
- `models/momentum_features.json`: 41 ordered features.
- Pickle metadata: scikit-learn 1.9.0, `n_features_in_=41`, classes `[0, 1]`.
- Target Momentum V2 contract: 8 ordered features and no arbitrary zero-filling.

Verdict: **KAISER MODEL INCOMPATIBLE — FAILSAFE PASS RETAINED**.

The legacy Kaiser predictor remains in `src/pipeline/predict_momentum.py` as artifact
lineage/tooling; Sniper runtime calls `scripts/predict_momentum.py`, which requires a
compatible `models/momentum_rf_v2.joblib`. No model was renamed, fabricated, or trained.

## Replay and database safety

A SQLite backup was created at `/tmp/kaiser-sniper-integration.sqlite`, then migrated
using Kaiser initialization. The source database was not modified. Strategy overrides
remained 5 positions, 0.1 SOL, TP 75, SL -35, trailing 10, max hold 30 minutes, no LLM,
and dry-run mode.

Replay command:

```bash
node scripts/replay_sniper_policy.mjs \
  --db /tmp/kaiser-sniper-integration.sqlite \
  --reference-root /home/ubuntu/charon
```

Replay uses identical stored candidate snapshots and a deterministic passing Momentum
fixture (0.75) when required features exist. It compares route, hard result/reasons,
soft score, thresholds, pre-score, Momentum availability, decision, confidence, and size.
It does not reproduce historical API timing or historical duplicate-cache state.

The replay found 1,116 parseable shared candidates: 997 fully identical and 119 with a
difference. All 119 differences involved the explicit Jupiter missing-data fail-open
contract. Three hard-filter booleans changed and one final decision changed from reject
to BUY because the old local reference rejected missing 5m flow. This is an intentional
specific task requirement, not a calibration change.
