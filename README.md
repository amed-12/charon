# Charon

Charon is a Telegram trench agent for screening noisy Pump-token flow with overlap signals, strategy gates, LLM selection, and dry-run/confirm/live execution.

## Alert

This codebase is in a testing period. Do not assume profitability. Start with dry-run only, collect enough evidence, and treat all strategy output as experimental.

## Recommended Mode

Charon now defaults to a hard dry-run safety posture:

```env
TRADING_MODE=dry_run
DRY_RUN_LOCK=true
```

When `DRY_RUN_LOCK=true`:

- effective mode is forced to `dry_run`
- `SOLANA_PRIVATE_KEY` is not loaded or required
- live buy/sell execution paths are blocked
- Telegram shows `DRY RUN LOCK ACTIVE - live trading disabled.`

Use `/mode` to verify the effective mode, `.env` mode, dry-run lock status, and whether a private key is loaded. Use `/unlock_confirm` only for instructions; it does not enable live trading.

## Flow

1. Charon polls the Charon signal server every `SIGNAL_POLL_MS`.
2. The active strategy gates source count, fee requirement, token age, market cap, holders, fees, trend quality, ATH distance, and position caps.
3. Passing candidates are enriched with token info, Jupiter asset/holders/chart data, saved-wallet exposure, GMGN data, and narrative data when available.
4. The LLM screens up to `LLM_CANDIDATE_PICK_COUNT` recent candidates and may pick one `BUY`.
5. Charon routes approved buys through the effective execution mode.
6. Dry-run positions are monitored every `POSITION_CHECK_MS` for TP, SL, trailing TP, max hold, and partial TP rules.
7. Closed positions are excluded from future monitoring and realized PnL.

## Install

```bash
git clone git@github.com:yunus-0x/charon.git
cd charon
npm install
cp .env.example .env
```

Edit `.env`, then run:

```bash
npm start
```

On Windows PowerShell, if script execution blocks `npm`, use:

```powershell
npm.cmd start
```

For PM2:

```bash
pm2 start index.js --name charon
pm2 save
```

## Required Config

Telegram:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_TOPIC_ID=
```

Signal server:

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000
```

RPC endpoint:

```env
HELIUS_API_KEY=
SOLANA_RPC_URL=
SOLANA_WS_URL=
```

If `SOLANA_RPC_URL` and `SOLANA_WS_URL` are not set, Charon falls back to Helius mainnet URLs and requires `HELIUS_API_KEY`.

## Dry-Run Simulation Config

Dry-run mode stores simulated entries/exits in SQLite and applies conservative execution assumptions:

```env
DRY_RUN_SIMULATED_SLIPPAGE_BPS=300
DRY_RUN_PLATFORM_FEE_BPS=100
DRY_RUN_PRIORITY_FEE_SOL=0.0005
DRY_RUN_FAILED_TX_RATE=0.03
```

These affect net PnL and can simulate failed entry/exit transactions. Gross PnL and net PnL are tracked separately.

## Future Live Guardrails

Even in dry-run, Charon simulates whether a trade would be blocked by future live risk controls:

```env
MAX_DAILY_LOSS_SOL=0.2
MAX_DAILY_TRADES=20
MAX_CONSECUTIVE_LOSSES=3
COOLDOWN_AFTER_LOSS_STREAK_MINUTES=60
MAX_POSITION_SIZE_SOL=0.05
MAX_WALLET_EXPOSURE_PERCENT=30
MIN_LIQUIDITY_USD=5000
MIN_HOLDERS_FOR_LIVE=300
BLOCK_IF_TOP20_HOLDER_PERCENT_ABOVE=60
BLOCK_IF_RUG_RATIO_ABOVE=0.3
BLOCK_IF_BUNDLER_RATE_ABOVE=0.4
```

Use `/risk` to see daily loss usage, trade count, loss streak, cooldown, open exposure, and whether the next trade would be allowed.

## LLM Config

```env
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

`LLM_BASE_URL` accepts any OpenAI-compatible endpoint. Set `ENABLE_LLM=false` to disable LLM globally. Individual strategies also have a `use_llm` flag.

## Casual Chat Agent

Charon supports natural-language Telegram messages in addition to slash commands. If a message does not start with `/`, it is routed to the chat agent.

Examples:

```text
cek posisi saya sekarang
kenapa kamu buy token ini?
token mana yang paling berisiko?
close all positions
jangan entry token dengan top holder di atas 50%
mulai dry run dulu
buatkan ringkasan performa 24 jam
analyze this mint: <mint>
set smart_money size jadi 0.03 SOL
show me only open positions
export closed positions 7d
```

Chat agent config:

```env
CASUAL_CHAT_ENABLED=true
CHAT_MEMORY_ENABLED=true
CHAT_HISTORY_LIMIT=12
CHAT_ACTIONS_ENABLED=true
CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION=true
CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION=true
TELEGRAM_ALLOWED_USER_IDS=
OPENROUTER_API_KEY=
CHAT_AGENT_MODEL=
CHAT_AGENT_TEMPERATURE=0.2
```

How it works:

1. Slash commands still use the existing command handler.
2. Free-form messages load current mode, active strategy, open positions, recent closed positions, PnL, latest candidates, risk status, recent decisions, lessons, preferences, and chat history.
3. The LLM must return structured JSON with an intent and allowed tool calls.
4. Charon validates the plan with the action guard before anything runs.
5. Read-only tools execute immediately.
6. Risky config/trade actions create Telegram confirmation buttons.
7. Conversation messages, preferences, pending actions, and agent decisions are stored in SQLite.

If `ENABLE_LLM=false` or `LLM_API_KEY` is missing, Charon falls back to a conservative heuristic router for common requests like positions, PnL, exports, stats, strategy size changes, and close-all confirmation.

The runtime entrypoint is `src/agent/agent.js`. It builds prompts with `src/agent/prompt.js`, parses model JSON with `src/agent/parser.js`, validates actions with `src/agent/guard.js`, runs registered tools through `src/agent/tools.js`, and persists chat memory through `src/agent/memory.js`.

The LLM cannot call arbitrary code. It can only request tools registered through the agent tool registry.

Common read-only chat requests use a fast deterministic router before the LLM planner. Messages such as `cek posisi saya`, `berapa pnl hari ini?`, `mode sekarang apa?`, and `strategi apa?` avoid full LLM planning and use cached read-only tool results when fresh.

If a request takes longer than about 1.5 seconds, Charon sends one short progress update. If it is still running after about 6 seconds, it may send one more update. Requests are processed sequentially per user to avoid racing config/trade actions.

## Chat Safety Rules

The chat agent is intentionally conservative:

- read-only requests can run immediately
- config changes require confirmation when `CHAT_CONFIG_CHANGES_REQUIRE_CONFIRMATION=true`
- trade actions require confirmation when `CHAT_LIVE_ACTIONS_REQUIRE_CONFIRMATION=true`
- live trade execution is never performed directly from casual chat
- manual buy from chat is disabled; use the existing candidate flow
- live/confirm mode changes are blocked while `DRY_RUN_LOCK=true`
- private keys are never shown, loaded under dry-run lock, or written to chat memory
- `TELEGRAM_ALLOWED_USER_IDS` cannot be changed from chat
- disabling all risk guardrails from chat is blocked

Confirmation buttons expire after 5 minutes. Confirmed chat actions are written to the agent decision log.

## Execution Modes

```env
TRADING_MODE=dry_run
DRY_RUN_LOCK=true
```

Modes:

- `dry_run`: stores simulated buys/sells in SQLite. No wallet needed.
- `confirm`: creates a Telegram confirmation intent before live execution.
- `live`: signs and executes Jupiter swaps immediately after approval.

With `DRY_RUN_LOCK=true`, `confirm` and `live` are blocked even if `TRADING_MODE` says otherwise.

Live/confirm require the lock to be manually disabled and these values:

```env
DRY_RUN_LOCK=false
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
```

Do not disable the lock until dry-run evidence is strong. The readiness command never recommends full live trading; the highest status is a small live test.

## Position Status Model

Every position has one normalized status:

- `OPEN`: active and monitored
- `PARTIALLY_CLOSED`: partial TP happened, remaining balance is still monitored
- `CLOSED`: fully exited and no longer monitored
- `FAILED_ENTRY`: entry failed
- `FAILED_EXIT`: exit failed
- `CANCELLED`: cancelled before entry

Active statuses are only:

```text
OPEN
PARTIALLY_CLOSED
```

Inactive statuses are:

```text
CLOSED
FAILED_ENTRY
FAILED_EXIT
CANCELLED
```

Closed positions are never monitored again. Open positions are not counted as realized PnL or win-rate evidence.

## PnL Rules

`/pnl` separates:

- realized PnL from `CLOSED` positions only
- unrealized PnL from `OPEN` and `PARTIALLY_CLOSED` positions only
- total PnL as realized plus unrealized
- win rate from `CLOSED` positions only

Open positions do not affect realized PnL, win rate, or profit factor.

## Strategies

Use `/menu -> Strategy` or commands:

```text
/strategy
/strategy sniper
/strategy dip_buy
/strategy smart_money
/strategy degen
/stratset sniper tp_percent 75
```

Default strategies:

- `sniper`: fee-claim overlap, immediate entry, LLM on
- `dip_buy`: waits for ATH-distance dip alerts
- `smart_money`: stricter holder/trending quality, partial TP support
- `degen`: lower source threshold, rule-based

Strategy settings are stored in SQLite and hot-read. Menu changes apply without restart.

## Telegram Commands

Core:

```text
/menu
/chat_on
/chat_off
/memory
/recent_decisions
/why <token_or_position>
/remember <text>
/forget <key>
/chat_debug on|off
/queue
/agent_perf
/mode
/unlock_confirm
/strategy
/stratset <strategy_id> <key> <value>
/filters
/setfilter <name> <value>
/candidate <mint>
```

Positions and PnL:

```text
/positions
/open_positions
/closed_positions <window>
/pnl
/position_audit
```

Examples:

```text
/closed_positions 24h
/closed_positions 7d
/closed_positions all
```

Performance lab:

```text
/stats <window>
/compare_strategies <window>
/filter_report <window>
/risk
/readiness
/learn <window>
/lessons
```

Exports:

```text
/export_trades <window>
/export_candidates <window>
/export_open_positions
/export_closed_positions <window>
```

Reset dry-run data:

```text
/dryrun_reset_confirm
/dryrun_reset_execute
```

`/dryrun_reset_execute` only works shortly after confirmation. It does not delete strategy config, wallets, `.env`, or settings.

## Export Files

CSV exports are saved locally in:

```text
exports/
```

Telegram also sends the generated CSV file.

Open-position exports include only `OPEN` and `PARTIALLY_CLOSED`. Closed-position exports include only `CLOSED`.

## Storage

Charon uses `charon.sqlite` as source of truth. It stores:

- candidates and filter results
- LLM decisions and batches
- dry-run/live positions and trades
- position metrics
- risk events
- exported reports
- generated lessons
- chat messages
- user preferences
- pending chat actions
- agent decision logs
- trade intents
- saved wallets
- strategy configs
- price alerts
- learning runs and lessons

Migrations are idempotent. Existing databases remain usable.

## Verification

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

On Windows PowerShell:

```powershell
npm.cmd run check
npm.cmd test
```

## Dry-Run Test Workflow

1. Set `DRY_RUN_LOCK=true` and `TRADING_MODE=dry_run`.
2. Start Charon.
3. Run `/mode` and confirm the lock is active.
4. Let candidates flow into dry-run positions.
5. Use `/positions` for active positions only.
6. Use `/closed_positions 24h` for realized exits.
7. Use `/pnl` to inspect realized vs unrealized PnL.
8. Use `/stats 7d`, `/compare_strategies 7d`, and `/filter_report 7d` after enough closed samples.
9. Use `/readiness` before considering confirm mode.

## Config Reloading

SQLite/menu settings are hot-read by the bot. API keys, wallet key, RPC URLs, Jupiter base URL, dry-run lock, and polling intervals are `.env` values and require restart.

## API Usage Notes

- **GMGN**: Rate-limited. Keep `GMGN_REQUEST_DELAY_MS=2500` or higher.
- **Jupiter**: Asset and holder data are called per candidate and per position refresh cycle.
- **Helius RPC**: Position monitoring polls every `POSITION_CHECK_MS`.
- **LLM**: One API call per batch cycle, up to `LLM_CANDIDATE_PICK_COUNT` candidates.

## Notes

- Live execution uses `@solana/web3.js` v1.
- The position monitor sends a Telegram alert after repeated polling failures.
- Treat `/readiness` as a conservative dry-run lab score, not a guarantee of future live performance.
