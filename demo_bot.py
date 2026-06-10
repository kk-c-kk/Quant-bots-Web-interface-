"""Demo data feeder — simulates two bots so you can see the dashboard working.

Start the server first (uvicorn server:app --port 8000), then:
    python demo_bot.py
and open http://localhost:8000
"""

import logging
import random
import threading
import time

from reporter import Reporter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


def run_fake_bot(bot_id: str, name: str, asset: str, start_price: float, vol: float):
    rep = Reporter(bot_id=bot_id, name=name, asset=asset)
    price = start_price
    position_entry = None

    while True:
        # random-walk price tick
        price *= 1 + random.gauss(0, vol)
        rep.price(price)

        roll = random.random()
        if position_entry is None and roll < 0.06:
            position_entry = price
            rep.trade(side="BUY", price=price, size=1.0, pnl=0.0, note="signal long")
        elif position_entry is not None and roll < 0.10:
            pnl = (price - position_entry) * 1.0
            rep.trade(side="SELL", price=price, size=1.0, pnl=pnl, note="take profit" if pnl > 0 else "stop out")
            position_entry = None
        elif roll < 0.16:
            rep.skip(random.choice([
                "spread too wide",
                "signal below threshold",
                "max position reached",
                "low liquidity",
            ]))

        time.sleep(1)


if __name__ == "__main__":
    threading.Thread(
        target=run_fake_bot,
        args=("demo-sol", "Demo SOL Bot", "SOL/USDC", 145.0, 0.0015),
        daemon=True,
    ).start()
    threading.Thread(
        target=run_fake_bot,
        args=("demo-poly", "Demo Polymarket Bot", "ELECTION-YES", 0.62, 0.004),
        daemon=True,
    ).start()

    print("Feeding demo data for 2 bots… open http://localhost:8000  (Ctrl+C to stop)")
    while True:
        time.sleep(60)
