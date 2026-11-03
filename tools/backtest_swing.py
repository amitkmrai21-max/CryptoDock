#!/usr/bin/env python3
"""Backtest of the Focus Radar swing rule (1H EMA 20/50 pullback) on past candles.

It reuses main._swing_setup, the exact function the app runs, so the test and the app cannot drift
apart. Run it on the server (where Binance is reachable), from the project folder:

    cd /var/www/CryptoDock && venv/bin/python tools/backtest_swing.py --days 90

It only READS Binance candles (through the app's own rate-limited binance_get). It places no orders.

What it simulates, per coin, hour by hour:
  1. A setup is taken when it first appears in state "ready" (rejection candle closed, trigger not hit yet).
     Only one trade per coin at a time: setups that appear while the previous one is still open are skipped.
  2. The trade starts when price crosses the trigger within --max-wait hours (gap fills at the open).
     If the stop is broken first, or nothing triggers, the setup is dropped ("no trigger").
  3. After entry, candle by candle: stop first, then targets (when a candle touches both, the stop is
     assumed to hit first, which is the pessimistic order). Exit at the stop, at Target 1 / Target 2,
     or at the close after --max-hold hours (timeout).
  4. Result in R (1R = the distance entry -> stop), after a round-trip fee (--fee % per side).
     Policy A = exit everything at Target 1 (1.5R). Policy B = exit everything at Target 2 (2.5R).
Results are split by direction, by Score bucket, and into a "tune" part (first 60% of the period) and a
"holdout" part (last 40%) so that a rule that only fits the past is easier to spot.
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

HOUR = 3600
WINDOW = 119  # closed candles the live scan sees (it asks Binance for 120, the last one is still forming)


def simulate_trade(candles, i, setup, max_wait, max_hold, fee_pct):
    """Outcome of one setup that appeared (state "ready") after candle i. Candle = [t, o, h, l, c]."""
    long = setup["side"] == "bullish"
    entry, stop, t1, t2 = setup["entry"], setup["stop"], setup["t1"], setup["t2"]
    sign = 1 if long else -1
    n = len(candles)

    fill, j = None, None
    for k in range(i + 1, min(n, i + 1 + max_wait)):
        _, o, h, l, c = candles[k]
        if (l < stop) if long else (h > stop):
            return {"outcome": "no_trigger", "end": k}    # stop level broken before the trigger
        crossed = (h >= entry) if long else (l <= entry)
        if crossed:
            gap = (o > entry) if long else (o < entry)
            fill = o if gap else entry
            j = k
            break
    if fill is None:
        return {"outcome": "no_trigger", "end": min(n - 1, i + max_wait)}

    risk = abs(fill - stop)
    if risk <= 0:
        return {"outcome": "no_trigger", "end": j}
    fee_r = (2 * fee_pct / 100 * fill) / risk

    hit_t1 = hit_t2 = False
    stop_after_t1 = False
    exit_candle = None
    result = None
    last = min(n, j + 1 + max_hold)
    for k in range(j, last):
        _, o, h, l, c = candles[k]
        if (l <= stop) if long else (h >= stop):
            result = "stop"
            exit_candle = k
            break
        if not hit_t1 and ((h >= t1) if long else (l <= t1)):
            hit_t1 = True
        if hit_t1 and ((h >= t2) if long else (l <= t2)):
            hit_t2 = True
            result = "t2"
            exit_candle = k
            break
    timed_out = result is None
    if timed_out:
        exit_candle = last - 1
        mark = candles[exit_candle][4]
    held = exit_candle - j

    r_t1 = abs(t1 - fill) / risk   # R gained when Target 1 is reached (1.5 unless the entry gapped)
    r_t2 = abs(t2 - fill) / risk
    if result == "stop":
        # Policy A already banked Target 1 if price reached it before the stop; B and plain stops lose 1R.
        outcome = "t1_then_stop" if hit_t1 else "stop"
        r_a = r_t1 if hit_t1 else -1.0
        r_b = -1.0
    elif result == "t2":
        outcome = "t2"
        r_a, r_b = r_t1, r_t2
    else:
        outcome = "t1_timeout" if hit_t1 else "timeout"
        mtm = sign * (mark - fill) / risk
        r_a = r_t1 if hit_t1 else mtm
        r_b = mtm
    r_a -= fee_r
    r_b -= fee_r
    return {"outcome": outcome, "r_a": r_a, "r_b": r_b, "held": held, "gap_fill": fill != entry, "end": exit_candle}


def run_coin(base, candles, main, max_wait=12, max_hold=48, fee_pct=0.1):
    """All taken setups for one coin, oldest first."""
    trades, seen = [], set()
    busy_until = -1  # one trade per coin at a time: a new setup is skipped while the last one is still open
    for i in range(60, len(candles) - 1):
        if i <= busy_until:
            continue
        window = candles[max(0, i - WINDOW + 1): i + 1]
        now = candles[i][0] + HOUR  # candle i has just closed
        setup = main._swing_setup(window, candles[i][4], now)
        if not setup or setup.get("rejection_at") is None:
            continue
        key = setup["rejection_at"]
        if key in seen:
            continue
        seen.add(key)
        if setup["state"] != "ready":
            continue  # already triggered when first noticed: nobody could have taken it at the trigger
        trade = simulate_trade(candles, i, setup, max_wait, max_hold, fee_pct)
        busy_until = trade.get("end", i)
        trade.update(base=base, side=setup["side"], score=setup.get("score"), at=candles[i][0])
        trades.append(trade)
    return trades


def fetch_candles(main, base, hours):
    """Last `hours` 1H candles of BASE/USDT through the app's rate-limited Binance helper."""
    rows, end = [], None
    while len(rows) < hours:
        params = {"symbol": base + "USDT", "interval": "1h", "limit": 1000}
        if end:
            params["endTime"] = end
        raw = main.binance_get("/api/v3/klines", params, weight=2, timeout=20)
        if not raw:
            break
        chunk = [[int(c[0]) // 1000, float(c[1]), float(c[2]), float(c[3]), float(c[4])] for c in raw]
        rows = chunk + rows
        end = int(raw[0][0]) - 1
        if len(raw) < 1000:
            break
        time.sleep(0.25)
    seen, out = set(), []
    for c in rows:
        if c[0] not in seen:
            seen.add(c[0])
            out.append(c)
    out.sort(key=lambda c: c[0])
    return out[-hours:]


def top_bases(main, top):
    payload = main._build_markets_payload()
    coins = json.loads(payload["raw"]).get("coins") or []
    ranked = [c for c in sorted(coins, key=lambda c: c.get("volume_usdt") or 0, reverse=True) if not main._is_stable_like(c.get("base", ""))]
    return [c["base"] for c in ranked[:top]]


# ---------- report ----------
def stats(trades):
    taken = [t for t in trades if t["outcome"] != "no_trigger"]
    n_all = len(trades)
    if not taken:
        return {"setups": n_all, "taken": 0}
    n = len(taken)
    count = lambda *names: sum(1 for t in taken if t["outcome"] in names)
    reached_t1 = count("t2", "t1_then_stop", "t1_timeout")
    return {
        "setups": n_all, "taken": n,
        "trigger_pct": 100 * n / n_all,
        "stop_pct": 100 * count("stop") / n,
        "t1_pct": 100 * reached_t1 / n,
        "t2_pct": 100 * count("t2") / n,
        "timeout_pct": 100 * count("timeout", "t1_timeout") / n,
        "avg_a": sum(t["r_a"] for t in taken) / n,
        "avg_b": sum(t["r_b"] for t in taken) / n,
    }


def bucket(score):
    if score is None:
        return "no score"
    return "score 70+" if score >= 70 else "score 50-69" if score >= 50 else "score <50"


def fmt_row(name, s):
    if not s.get("taken"):
        return f"  {name:<14}{s['setups']:>7}{'-':>8}"
    few = "*" if s["taken"] < 30 else " "
    return (f"  {name:<14}{s['setups']:>7}{s['taken']:>6}{few}{s['trigger_pct']:>6.0f}%"
            f"{s['stop_pct']:>7.0f}%{s['t1_pct']:>7.0f}%{s['t2_pct']:>7.0f}%{s['timeout_pct']:>7.0f}%"
            f"{s['avg_a']:>+8.2f}R{s['avg_b']:>+8.2f}R")


HEADER = f"  {'group':<14}{'setups':>7}{'taken':>7}{'trig':>7}{'stop':>8}{'T1':>8}{'T2':>8}{'t/out':>8}{'avg A':>9}{'avg B':>9}"


def report(trades, args, cut):
    lines = [f"Focus Radar swing backtest · top {args.top} coins · last {args.days} days · fee {args.fee}% per side · max wait {args.max_wait}h · max hold {args.max_hold}h",
             f"setups = first seen as 'ready'; taken = price crossed the trigger; stop/T1/T2/t-out = share of taken trades; avg = mean R per taken trade after fees",
             f"break-even (before fees): policy A (exit at T1, 1.5R) needs T1 >= 40% ; policy B (exit at T2, 2.5R) needs T2 >= 29%", ""]
    groups = lambda ts: [("all", ts)] + [(s, [t for t in ts if t["side"] == s]) for s in ("bullish", "bearish")] + \
        [(b, [t for t in ts if bucket(t["score"]) == b]) for b in ("score 70+", "score 50-69", "score <50")]
    for title, subset in (("ALL DATA", trades),
                          ("TUNE PART (first 60% of the period)", [t for t in trades if t["at"] < cut]),
                          ("HOLDOUT PART (last 40%, not used for any tuning)", [t for t in trades if t["at"] >= cut])):
        lines += [title, HEADER]
        for name, ts in groups(subset):
            lines.append(fmt_row(name, stats(ts)))
        lines.append("")
    lines += ["How to read it: avg A / avg B above 0 means the rule made money per trade in the past, after fees;",
              "below 0 means it lost. Compare 'score 70+' with 'score <50': if they look alike, the Score adds nothing.",
              "* = fewer than 30 taken trades: too small to trust, the numbers can swing a lot by luck alone.",
              "The past does not promise the future, and trading costs beyond the fee (slippage) are not included."]
    return "\n".join(lines)


def main_cli():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--fee", type=float, default=0.1, help="fee in percent per side (Binance spot is 0.1)")
    ap.add_argument("--max-wait", type=int, default=12, help="hours to wait for the trigger after the rejection candle")
    ap.add_argument("--max-hold", type=int, default=48, help="hours to hold a trade before closing at market")
    ap.add_argument("--out", default="backtest_report.txt")
    args = ap.parse_args()

    import main as app  # noqa: E402  (after chdir/sys.path)
    bases = top_bases(app, args.top)
    hours = args.days * 24
    all_trades, start, end = [], None, None
    for idx, base in enumerate(bases, 1):
        try:
            candles = fetch_candles(app, base, hours)
        except Exception as error:  # a coin that fails is skipped, the rest still count
            print(f"[{idx}/{len(bases)}] {base}: skipped ({error})", flush=True)
            continue
        if len(candles) < 150:
            print(f"[{idx}/{len(bases)}] {base}: only {len(candles)} candles, skipped", flush=True)
            continue
        start = candles[0][0] if start is None else min(start, candles[0][0])
        end = candles[-1][0] if end is None else max(end, candles[-1][0])
        got = run_coin(base, candles, app, args.max_wait, args.max_hold, args.fee)
        all_trades += got
        print(f"[{idx}/{len(bases)}] {base}: {len(candles)} candles, {len(got)} setups", flush=True)
    if not all_trades:
        print("No setups found. Nothing to report.")
        return
    cut = start + 0.6 * (end - start)
    text = report(all_trades, args, cut)
    print("\n" + text)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(f"\nSaved to {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main_cli()
