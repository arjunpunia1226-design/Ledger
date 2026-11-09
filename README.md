# Ledger: cross-exchange crypto arbitrage bot

A paper-trading arbitrage bot that streams **real order books from 9 exchanges**, scores every
opportunity with an online-learning model, and simulates execution against the live market.
It uses no real money yet. The executor is swappable, so live trading can be added later.

```bash
npm start            # or: node server/index.js
# open http://localhost:8787
```

Requires Node 22+ (it uses Node's built-in WebSocket). It has **zero npm dependencies** and needs no API keys.

## What it does

| Piece | Details |
|---|---|
| **Live data** | Public WebSocket feeds from Binance, Coinbase, Kraken, OKX, Bybit, Bitstamp, Bitfinex, Gate.io, KuCoin for BTC, ETH, SOL, XRP, DOGE, ADA, LINK, LTC, AVAX. Auto-reconnect, watchdog, per-feed health. |
| **Quote normalization** | USDT venues are converted to USD using a live USDT/USD reference (median of Coinbase/Kraken/Bitstamp). USD venues with their own USDT market get their own factor too, which catches Bitfinex's USD premium. Without this, the USDT basis looks like a free 10+ bps "arbitrage" that doesn't exist. |
| **Scanner** | Event-driven: each book update re-checks every route for that coin (9 venues → 72 routes per coin, 648 total). |
| **AI scorer** | Online logistic regression. Every crossing is shadow-labeled after the simulated latency: did both legs still fill on the *real* books? It learns from staleness, depth, volatility, route history, persistence and cross-quote features. It gates execution with a confidence threshold. Skill is reported against a base-rate baseline, so you can see whether it's actually adding value. |
| **Paper execution** | Two IOC limit orders are placed in parallel after a simulated latency and filled against the live book at that moment. Taker fees apply. Fills consume book liquidity, and in-flight orders claim liquidity so routes can't double-book it. |
| **Smart hedging** | When one leg misses (the quote moved or the liquidity was taken), the leftover position is flattened at market on the venue with the best price right now. |
| **Inventory model** | Capital is pre-funded across venues (cash plus coins). An auto-rebalancer moves inventory with real withdrawal fees and transfer delay, and skips transfers that cost too much. |
| **Inventory hedge** | On by default. The coins parked on exchanges would otherwise make equity swing with the market even when nothing trades. A simulated short perpetual-futures position, sized to total coin inventory and re-sized every second, cancels that out. Its fees (2 bps on size changes) count against Trading P&L. Funding payments are not modeled. |
| **Risk** | Min net edge, max trade size, per-route cooldown, trades-per-minute cap, stale-quote filter, daily-loss kill switch, and an auto-halt if feeds drop. |
| **Dashboard** | Start/stop, P&L/equity/drift chart, fee-hurdle histogram, opportunity scanner with block reasons, per-coin pulse sparklines, spread heatmap, price ladder, AI calibration and weights, trade blotter with fill details, balances, transfers in transit, feed health, activity log, CSV export, toasts and sound, light/dark theme. |
| **Persistence** | State is saved to `data/state.json` every 10s and on shutdown. |

## What the real data says

At **retail taker fees** the cheapest round trip is ~20 bps, while observed cross-exchange spreads on
these coins are almost always 0–5 bps. So the bot (correctly) rarely trades. The *Fee hurdle* panel
shows this live. To watch the engine trade, open **Settings → Fees → VIP** or **Custom** and lower them.
Even at zero fees, expect legged trades: the widest spreads are the ones most likely to vanish
within ~200ms (adverse selection). That is what the AI model learns to score.

## Layout

```
server/
  index.js            HTTP server, REST control API, SSE live stream
  config.js           coins, exchanges, fee schedules, withdrawal fees, default settings
  market.js           book store, quote normalization, volatility
  feeds/base.js       WebSocket connect / keep-alive / reconnect
  feeds/index.js      per-exchange adapters
  bot.js              scanner, AI gating, risk, execution, hedging, stats
  ai.js               online logistic-regression scorer
  executors/paper.js  paper executor (fills, fees, balances, rebalancing)
  executors/live.js   stub + interface for real-money execution (next step)
  store.js            JSON persistence
public/               dashboard (vanilla JS, no build step)
```

## API

`GET /api/state` · `GET /api/stream` (SSE) · `POST /api/bot/start` · `POST /api/bot/stop` ·
`POST /api/settings` · `POST /api/account/reset` · `POST /api/ai/reset` · `GET /api/trades.csv`

By default the server binds to `127.0.0.1` only, with no login. See *Deploy* for cloud mode.

## Deploy to the cloud

The bot is a long-running Node process: it holds 9 exchange WebSockets open and trades on a timer.
**Static or serverless hosts (Vercel, Netlify, GitHub Pages) can't run it.** They'll serve the dashboard,
but it shows "Can't reach the bot engine". Use a host that keeps a process running.

### Render (one-click blueprint, recommended)

1. On [render.com](https://render.com): **New → Blueprint** → connect this GitHub repo.
2. Render reads `render.yaml`: Node 24, **Frankfurt** region, Starter plan (~$7/mo), 1 GB disk for state.
3. When asked, enter **LEDGER_PASSWORD** (12+ characters). That's your dashboard login.
4. Open the `https://ledger-xxxx.onrender.com` URL and sign in.

Why these choices: the free tier sleeps after 15 minutes idle (which stops the bot) and has no disk,
and Binance and Bybit block servers in the US.

### Anything with Docker (Railway, Fly.io, a VPS)

```bash
docker build -t ledger .
docker run -d -p 8787:8787 -e LEDGER_PASSWORD='choose-a-long-password' -v ledger-data:/data ledger
```

Pick a non-US region and put HTTPS in front of it (most platforms do this for you).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LEDGER_PASSWORD` | unset | Dashboard password. **Required** whenever `HOST` isn't localhost; the server refuses to start without it. |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept connections from other machines (cloud). |
| `PORT` | `8787` | Port to listen on (most hosts set this for you). |
| `DATA_DIR` | `./data` | Where `state.json` is saved. Point it at a persistent disk. |
| `SESSION_SECRET` | random per boot | Signs login cookies. Set it so logins survive restarts. |

Security: logins are signed HttpOnly, SameSite=Strict cookies (Secure over HTTPS). Failed logins are rate-limited
(10 per 15 min per IP), cross-site POSTs are rejected, and `/healthz` is the only unauthenticated endpoint.

## Going live (later)

Implement `server/executors/live.js` against exchange order APIs (or a wallet/DEX connector) and swap it
in for `PaperExecutor` in `bot.js`. Use trade-only API keys (never withdrawal), withdrawal allow-lists,
tiny size limits at first, and reconcile balances from the exchange after every fill.
