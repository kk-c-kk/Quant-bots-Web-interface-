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

`/etc/systemd/system/quant-reporter.service`:

```ini
[Unit]
Description=Quant bot web reporter
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/quant-reporter
Environment=REPORTER_API_KEY=change-me-long-random-string
ExecStart=/home/ubuntu/quant-reporter/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now quant-reporter
```

**Security note:** if port 8000 is open to the internet, the *read* API and
dashboard are public. Either restrict the port to your IP in the AWS security
group, or put nginx + basic auth in front. `REPORTER_API_KEY` only protects
the *ingest* endpoints (so nobody can fake your stats); set the same value in
each bot's environment.

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
