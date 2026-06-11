# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single web reporter service that ALL of the user's signal trading bots report
into — the foundation for an all-in-one web terminal. Exactly one instance of
this service runs on the Ubuntu AWS VPS; bots (separate processes/repos) push
events to it over HTTP. Everything is keyed by `bot_id`, and the dashboard has
a bot-selector dropdown, so new bots require zero changes here to show up.

## Run / develop

```powershell
pip install -r requirements.txt
python -m uvicorn server:app --port 8000   # the service
python demo_bot.py                          # second terminal: fake data feeder
# open http://localhost:8000
```

There are no tests or linters configured. Verify changes by running the server
with `demo_bot.py` and checking the dashboard and the JSON endpoints
(`/api/bots`, `/api/bots/{bot_id}/dashboard`).

Deployment is a systemd unit on the VPS (see README.md). Remote:
https://github.com/kk-c-kk/Quant-bots-Web-interface- — every module the
runtime imports must be committed (a past bot lost code that lived only on the
VPS).

## Architecture

```
bot N ── reporter.py (HTTP POST, fire-and-forget) ──> server.py (FastAPI + SQLite) ──> static/ dashboard (3s polling)
```

- **`server.py`** — entire backend. SQLite tables `bots`, `trades`, `skips`,
  `prices` (prices auto-pruned past `REPORTER_PRICE_RETENTION`, default 24h).
  Ingest endpoints (`/api/ingest/*`) optionally require `X-API-Key` =
  `REPORTER_API_KEY`; the read API and dashboard are deliberately unauthenticated
  (network-level protection assumed — AWS security group / nginx).
- **`reporter.py`** — the client library bots copy/import. Must stay
  **stdlib-only** and **non-blocking** (queue + daemon thread): a down reporter
  service must never stall or crash a trading loop. Failures are logged via
  `logging`, never silently swallowed — keep it that way.
- **`static/`** — vanilla HTML/CSS/JS dashboard, deliberately **zero CDNs or
  external dependencies** (must render with no outbound internet). The price
  chart is hand-drawn on a canvas in `app.js` (`drawChart`), not a chart library.
  `app.js` polls `/api/bots/{bot_id}/dashboard` — one combined endpoint returns
  stats + today's trades + price series in a single call.
- **`demo_bot.py`** — dev-only fake bots; also the reference example for wiring
  a real bot.

## Conventions that matter

- **PnL model:** bots report realized pnl on the *closing* trade (entry fills
  carry `pnl=0`). Total/daily PnL are plain `SUM(pnl)` — there is no position
  tracking server-side.
- **"Daily" resets at 00:00 UTC** (`utc_day_start()` in server.py); the UI
  states this, so change both together if it ever changes.
- **Online/offline:** a bot is "online" if any ingest arrived within
  `ONLINE_WINDOW_SECONDS` (20s). `.price()` ticks double as heartbeats;
  `.heartbeat()` exists for idle bots.
- **Adding a new stat/panel is additive:** extend the dashboard endpoint in
  `server.py`, add a `Reporter` method if bots must send new data, add a panel
  in `static/`. Always key by `bot_id` — never build anything single-bot.
- **Theme:** dark purple, CSS variables at the top of `static/style.css`
  (`--border-bright`/`--glow` drive the purple edge-glow on cards). Match it
  for new UI.
- `reporter.db` is live runtime data and is gitignored — never commit it or
  assume it exists in a fresh checkout (server.py creates the schema on start).
