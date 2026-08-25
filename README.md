# Kaiser.Charon

This is my working fork of [Charon](https://github.com/yunus-0x/charon) by [@yunus-0x](https://github.com/yunus-0x). All credit for the original idea and codebase goes to him — I just kept changing things while running it, and at some point the diff got big enough that it needed its own home.

Charon is a Telegram bot that screens Solana pump.fun tokens, runs them through strategy filters, optionally asks an LLM to pick entries, and trades via Jupiter. Three modes: `dry_run` (paper trading into SQLite), `confirm` (Telegram approve/reject buttons), and `live` (real swaps, real money, real regret potential).

## What changed in this fork

- **Jupiter flow hard filters** — finite `stats1h.priceChange < 0` and finite `stats5m.numNetBuyers / numTraders < 0.2` reject; missing/non-finite flow data passes.
- **PumpPortal WebSocket source** — real-time graduated-token stream instead of polling. Also feeds the pre-graduation scanner.
- **Pre-grad scanner** — optional module that watches tokens before they hit the bonding curve cap.
- **GMGN signed auth** — enrichment calls use Ed25519-signed requests against GMGN's API for holder counts, fees, and socials.
- **Verified Sniper trailing policy** — +75% arms the fixed 10% high-water trail; fixed TP only closes immediately when trailing is disabled.
- **Dry-run safety** — paper entries use 2% simulated slippage and never sign or broadcast transactions; read-only Jupiter data/quotes may still be used for monitoring.
- **Telegram reports + visual cards** — daily PnL reports and rendered entry/exit cards.
- **Backtest tooling** — scripts that run filter candidates against local trade history so changes get measured before they get deployed.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

Everything from the original still applies: signal server, strategies (`sniper`, `dip_buy`, `smart_money`, `degen`), hot-reloaded config in SQLite, Telegram menus, the works.

## Latest additions (August 2026)

This fork now includes:

- **LLM Decision Cache** (`migrations/001_decision_cache.sql`) — WATCH/PASS verdicts cached 10min/60min to cut redundant LLM calls by ~60-70%. Invalidates on >20% mcap or >30% holder change.
- **Momentum V2 adapter** (`src/pipeline/momentumFilter.js` + `scripts/predict_momentum.py`) — fixed 8-feature contract, threshold 0.5, 8-second timeout, and fail-open errors. The bundled 41-feature Gradient Boosting artifact is retained as lineage but is not compatible or enabled.
- **Soft audit scoring** — bot holders, bot percentage, top-10 concentration, developer migrations, and bundler quality remain scoring inputs rather than Sniper hard rejects.
- **Verified Sniper policy integration** — full executable contract and compatibility notes are documented in [`docs/SNIPER_POLICY_INTEGRATION.md`](docs/SNIPER_POLICY_INTEGRATION.md).
- **Code Audit** (`AUDIT_OPUS_2026-07-07.md`) — Claude Opus 4.8 static audit: 3 CRITICAL findings including C1 (Jupiter slippage cap never sent) and C2 (post-swap dedup → orphaned tokens).
- **Backtest Edge Analysis** (`BACKTEST_EDGE_2026-07-07.md`) — 1,146-position split-half backtest showing regime decay: 40.3% WR (+5.1 SOL) → 25.7% WR (-3.9 SOL).
- **Bug Fixes** (`BUGFIX_SUMMARY.md`) — 4 LLM-layer fixes: cache, pre-filter guard, execution failure logging, past-win audit trail.

## Requirements

- **Node.js 20+** (developed on v22).
- **Native build tools** — `better-sqlite3` and `canvas` compile from source:
  - Debian/Ubuntu: `sudo apt install -y build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
  - macOS: `xcode-select --install` and `brew install pkg-config cairo pango libpng jpeg giflib librsvg`
- A **Telegram bot token** and your chat ID.
- A **signal server key** — see the [original repo](https://github.com/yunus-0x/charon) for access.
- A **Helius RPC endpoint** (free tier is fine for `dry_run`).
- For `live` mode only: a **Solana wallet private key** and a **Jupiter API key**.

## Setup

```bash
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon
npm install
cp .env.example .env
# fill in .env — at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# SIGNAL_SERVER_KEY, HELIUS_API_KEY / SOLANA_RPC_URL
npm run check   # syntax check before first boot
npm start
```

The SQLite database is created automatically at `DB_PATH` on first run. Nothing else to provision.

If `npm install` fails on `better-sqlite3` or `canvas`, it's the native build — install the build tools listed above and retry.

## Configuration

`.env.example` documents every environment variable the bot reads. The ones without a default are the ones you actually have to fill in; the rest have sane values already.

Optional subsystems are off by default and stay off until you set their flag:

- `GMGN_ENABLED=true` — enrichment via GMGN (on by default; set `false` to fall back to Jupiter data)
- `PUMPPORTAL_ENABLED=true` — real-time WebSocket signals, needs `PUMPPORTAL_API_KEY`
- `PREGRAD_ENABLED=true` — pre-graduation scanner
- `ENABLE_LLM=true` — LLM entry selection (on by default; needs `LLM_API_KEY`)

Strategy parameters live in SQLite, not `.env`, and are hot-read — most tuning happens from the Telegram chat without restarts. API keys and RPC URLs are env values, so those need a restart.

## Usage

Run it, open Telegram, `/menu`.

Start with `TRADING_MODE=dry_run`. Watch it for a week. Dry-run applies 2% simulated slippage and sends no transaction, but it is still an estimate: RPC/API failures can trigger price fallbacks and live swaps add wallet state, confirmation, and timing risk. Only then decide if live is worth it.

## Honest warnings

- This trades memecoins. Most memecoins go to zero. The bot's edge is catching the few that don't — one good runner pays for a lot of small losses, and that's the whole strategy. If the runners don't show up, the PnL is negative. That's not a bug.
- Live mode signs transactions automatically. Use a dedicated wallet with money you can afford to lose completely.
- GMGN rate limits are aggressive. Don't lower `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned API keys.
- Never commit your `.env`. It's gitignored — keep it that way.

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you're looking for the upstream version, that's the one. This fork is my personal trading setup, shared as-is.
