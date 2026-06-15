# Quant Bot Web Reporter

One web service that all signal trading bots report into. Pick which bot's
stats you're viewing from the dropdown — this is the foundation for the
all-in-one web terminal, so only **one** service ever runs on the VPS.

## What's shown per bot

- Total PnL (all time) · Daily PnL (resets 00:00 UTC)
- Trades today · Signals skipped today
- Today's trade list (time, side, price, size, pnl, note)
- Live price line chart of the traded asset
- Online/offline dot (offline if no ingest for 20s)

## Architecture

```
bot 1 ──┐
bot 2 ──┼── reporter.py (HTTP POST) ──> server.py (FastAPI + SQLite) ──> browser
bot N ──┘
```

- `server.py` — the web service. SQLite (`reporter.db`), everything keyed by `bot_id`.
- `reporter.py` — drop next to any bot. Stdlib-only, non-blocking (background
  thread + queue), logs failures instead of crashing or silently swallowing.
- `static/` — self-contained dashboard, zero CDNs/external deps.
- `demo_bot.py` — fake data feeder for local dev.

## Run locally (Windows dev)

```powershell
pip install -r requirements.txt
python -m uvicorn server:app --port 8000
# in a second terminal:
python demo_bot.py
```

Open http://localhost:8000

## Wire a real bot

```python
from reporter import Reporter

rep = Reporter(
    bot_id="sol-meanrev-v1",          # unique per bot — this is the dropdown key
    name="SOL Mean Reversion",
    asset="SOL/USDC",
    base_url="http://127.0.0.1:8000", # same VPS -> localhost
    api_key=os.environ.get("REPORTER_API_KEY"),
)

rep.price(tick_price)                              # every tick (drives the chart + online dot)
rep.trade(side="BUY", price=p, size=s, pnl=0)      # on entry fill
rep.trade(side="SELL", price=p, size=s, pnl=realized)  # on exit fill (pnl = realized)
rep.skip("spread too wide")                        # whenever a signal is passed on
rep.heartbeat()                                    # only needed if the bot is idle (no ticks)
```

PnL convention: report **realized pnl on the closing trade**; total/daily PnL
are just `SUM(pnl)`.

## Deploy on the Ubuntu VPS

```bash
sudo apt install python3-venv
cd ~/quant-reporter
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Install the unit (binds `127.0.0.1` — see security note) and the shared key:

```bash
KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
echo "REPORTER_API_KEY=$KEY" | sudo tee /etc/quant-reporter.env
sudo chmod 600 /etc/quant-reporter.env
sudo cp deploy/quant-reporter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now quant-reporter
```

(See `deploy/quant-reporter.service`. Each bot's own unit reads the same
`/etc/quant-reporter.env` via `EnvironmentFile=-/etc/quant-reporter.env`.)

**Security note:** the *read* API and dashboard are unauthenticated by design.
The unit binds `127.0.0.1`, so the dashboard is not exposed at all — view it via
an SSH tunnel (`ssh -L 8000:localhost:8000 botuser@<vps>`, then open
`http://localhost:8000`). To reach it from a phone/browser with a password and
TLS, put nginx + basic auth + Let's Encrypt in front: see
**`deploy/REVERSE_PROXY.md`**. `REPORTER_API_KEY` only protects the *ingest*
endpoints (so nobody can fake your stats), not viewing.

## Env vars (server)

| var | default | meaning |
|---|---|---|
| `REPORTER_DB` | `./reporter.db` | sqlite path |
| `REPORTER_API_KEY` | *(unset = no auth)* | required `X-API-Key` on ingest |
| `REPORTER_PRICE_RETENTION` | `86400` | seconds of price history kept |

## Extending toward the full terminal

Everything is already multi-bot (keyed by `bot_id`); future work is additive:
add columns/tables in `server.py`, a method in `reporter.py`, and a panel in
`static/`. Candidates: equity-curve chart (cumulative pnl over time), per-bot
config display, log tail, win-rate stats.
