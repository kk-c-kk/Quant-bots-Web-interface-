"""Quant bot web reporter — single web service for all signal trading bots.

Bots POST their events (trades, skips, price ticks) to this service via
reporter.py. The dashboard at "/" lets you pick a bot and view its stats.

Run:
    uvicorn server:app --host 0.0.0.0 --port 8000

Env vars:
    REPORTER_DB               path to sqlite db (default: ./reporter.db)
    REPORTER_API_KEY          if set, ingest endpoints require X-API-Key header
    REPORTER_PRICE_RETENTION  seconds of price history to keep (default 86400)
"""

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("REPORTER_DB", BASE_DIR / "reporter.db"))
API_KEY = os.environ.get("REPORTER_API_KEY", "")
PRICE_RETENTION_SECONDS = int(os.environ.get("REPORTER_PRICE_RETENTION", "86400"))
ONLINE_WINDOW_SECONDS = 20  # bot counts as online if any ingest within this window

SCHEMA = """
CREATE TABLE IF NOT EXISTS bots (
    bot_id     TEXT PRIMARY KEY,
    name       TEXT,
    asset      TEXT,
    first_seen REAL,
    last_seen  REAL
);
CREATE TABLE IF NOT EXISTS trades (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    ts     REAL NOT NULL,
    side   TEXT,
    price  REAL,
    size   REAL,
    pnl    REAL NOT NULL DEFAULT 0,
    note   TEXT
);
CREATE TABLE IF NOT EXISTS skips (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    ts     REAL NOT NULL,
    reason TEXT
);
CREATE TABLE IF NOT EXISTS prices (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    ts     REAL NOT NULL,
    price  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_bot_ts ON trades (bot_id, ts);
CREATE INDEX IF NOT EXISTS idx_skips_bot_ts  ON skips  (bot_id, ts);
CREATE INDEX IF NOT EXISTS idx_prices_bot_ts ON prices (bot_id, ts);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


with db() as _conn:
    _conn.executescript(SCHEMA)

app = FastAPI(title="Quant Bot Reporter")


def utc_day_start() -> float:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def check_key(x_api_key: Optional[str]) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


def upsert_bot(conn: sqlite3.Connection, bot_id: str,
               name: Optional[str], asset: Optional[str], ts: float) -> None:
    conn.execute(
        """INSERT INTO bots (bot_id, name, asset, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET
               last_seen = excluded.last_seen,
               name  = COALESCE(excluded.name,  bots.name),
               asset = COALESCE(excluded.asset, bots.asset)""",
        (bot_id, name, asset, ts, ts),
    )


# ---------------------------------------------------------------- ingest

class TradeIn(BaseModel):
    bot_id: str
    name: Optional[str] = None
    asset: Optional[str] = None
    side: str = ""
    price: Optional[float] = None
    size: Optional[float] = None
    pnl: float = 0.0
    note: str = ""
    ts: Optional[float] = None


class SkipIn(BaseModel):
    bot_id: str
    name: Optional[str] = None
    asset: Optional[str] = None
    reason: str = ""
    ts: Optional[float] = None


class PriceIn(BaseModel):
    bot_id: str
    name: Optional[str] = None
    asset: Optional[str] = None
    price: float
    ts: Optional[float] = None


class HeartbeatIn(BaseModel):
    bot_id: str
    name: Optional[str] = None
    asset: Optional[str] = None
    ts: Optional[float] = None


@app.post("/api/ingest/trade")
def ingest_trade(body: TradeIn, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    ts = body.ts or time.time()
    with db() as conn:
        upsert_bot(conn, body.bot_id, body.name, body.asset, ts)
        conn.execute(
            "INSERT INTO trades (bot_id, ts, side, price, size, pnl, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (body.bot_id, ts, body.side, body.price, body.size, body.pnl, body.note),
        )
    return {"ok": True}


@app.post("/api/ingest/skip")
def ingest_skip(body: SkipIn, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    ts = body.ts or time.time()
    with db() as conn:
        upsert_bot(conn, body.bot_id, body.name, body.asset, ts)
        conn.execute(
            "INSERT INTO skips (bot_id, ts, reason) VALUES (?, ?, ?)",
            (body.bot_id, ts, body.reason),
        )
    return {"ok": True}


@app.post("/api/ingest/price")
def ingest_price(body: PriceIn, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    ts = body.ts or time.time()
    with db() as conn:
        upsert_bot(conn, body.bot_id, body.name, body.asset, ts)
        conn.execute(
            "INSERT INTO prices (bot_id, ts, price) VALUES (?, ?, ?)",
            (body.bot_id, ts, body.price),
        )
        conn.execute(
            "DELETE FROM prices WHERE bot_id = ? AND ts < ?",
            (body.bot_id, ts - PRICE_RETENTION_SECONDS),
        )
    return {"ok": True}


@app.post("/api/ingest/heartbeat")
def ingest_heartbeat(body: HeartbeatIn, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    ts = body.ts or time.time()
    with db() as conn:
        upsert_bot(conn, body.bot_id, body.name, body.asset, ts)
    return {"ok": True}


# ---------------------------------------------------------------- read API

@app.get("/api/bots")
def list_bots():
    now = time.time()
    with db() as conn:
        rows = conn.execute("SELECT * FROM bots ORDER BY name, bot_id").fetchall()
    return [
        {
            "bot_id": r["bot_id"],
            "name": r["name"] or r["bot_id"],
            "asset": r["asset"] or "",
            "last_seen": r["last_seen"],
            "online": (now - (r["last_seen"] or 0)) < ONLINE_WINDOW_SECONDS,
        }
        for r in rows
    ]


@app.get("/api/bots/{bot_id}/dashboard")
def bot_dashboard(bot_id: str, points: int = 900, trade_limit: int = 200):
    """Everything the dashboard needs for one bot, in one call."""
    points = max(2, min(points, 5000))
    trade_limit = max(1, min(trade_limit, 1000))
    day_start = utc_day_start()
    now = time.time()

    with db() as conn:
        bot = conn.execute("SELECT * FROM bots WHERE bot_id = ?", (bot_id,)).fetchone()
        if bot is None:
            raise HTTPException(status_code=404, detail=f"unknown bot_id {bot_id!r}")

        total_pnl = conn.execute(
            "SELECT COALESCE(SUM(pnl), 0) AS s FROM trades WHERE bot_id = ?",
            (bot_id,),
        ).fetchone()["s"]
        daily = conn.execute(
            "SELECT COALESCE(SUM(pnl), 0) AS s, COUNT(*) AS n FROM trades WHERE bot_id = ? AND ts >= ?",
            (bot_id, day_start),
        ).fetchone()
        skips_today = conn.execute(
            "SELECT COUNT(*) AS n FROM skips WHERE bot_id = ? AND ts >= ?",
            (bot_id, day_start),
        ).fetchone()["n"]
        trades_today = conn.execute(
            "SELECT ts, side, price, size, pnl, note FROM trades "
            "WHERE bot_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
            (bot_id, day_start, trade_limit),
        ).fetchall()
        price_rows = conn.execute(
            "SELECT ts, price FROM prices WHERE bot_id = ? ORDER BY ts DESC LIMIT ?",
            (bot_id, points),
        ).fetchall()

    price_rows = list(reversed(price_rows))
    return {
        "bot": {
            "bot_id": bot["bot_id"],
            "name": bot["name"] or bot["bot_id"],
            "asset": bot["asset"] or "",
            "last_seen": bot["last_seen"],
            "online": (now - (bot["last_seen"] or 0)) < ONLINE_WINDOW_SECONDS,
        },
        "stats": {
            "total_pnl": total_pnl,
            "daily_pnl": daily["s"],
            "trades_today": daily["n"],
            "skips_today": skips_today,
        },
        "trades": [dict(r) for r in trades_today],
        "prices": [{"ts": r["ts"], "price": r["price"]} for r in price_rows],
        "day_start_utc": day_start,
        "server_time": now,
    }


# ---------------------------------------------------------------- static UI

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")
