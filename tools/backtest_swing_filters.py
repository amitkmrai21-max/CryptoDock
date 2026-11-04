#!/usr/bin/env python3
"""Does adding the extra Lovable filters to the 1H swing rule make it better?  (Read-only; places no orders.)

Same simulation as tools/backtest_swing.py (it reuses main._swing_setup, the exact function the app runs, and the
same trade simulation, fees and tune / holdout split). The only difference: every variant below is the swing rule
PLUS extra filters, so each variant shows fewer setups. The question is whether the setups that are left do better.

Filters (all checked on candles that were already closed when the setup appeared):
  4H      the 4-hour trend agrees: EMA 20 above EMA 50 on 4H candles for a long (below for a short).
  RSI     RSI(14) pulled back and is turning: a long needs RSI <= 45 somewhere from the rejection candle until now
          and RSI now above that low (a short: RSI >= 55 and now below that high).
  CANDLE  the rejection candle closes in the trade's direction: green for a long, red for a short
          (a bullish / bearish engulfing candle is always one of those, so it passes).

Run it on the server (where Binance is reachable), from the project folder:

    cd /var/www/CryptoDock && venv/bin/python tools/backtest_swing_filters.py --days 90 --top 60

It only READS Binance candles (through the app's own rate-limited binance_get). The first 10 days are used only as
history for the 4H trend, so every variant is judged on exactly the same period.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backtest_swing as bt  # noqa: E402  (also moves the working directory to the project folder)

HOUR = 3600
WARMUP = 240  # candles used only as history (4H EMA 50 needs 200 hours)


def four_hour_closes(candles, i):
    """Closes of the completed 4H candles built from 1H candles[0..i] (4H blocks start at 00, 04, 08 ... UTC)."""
    blocks = {}
    for c in candles[: i + 1]:
        blocks.setdefault(c[0] // (4 * HOUR), []).append(c)
    closes = []
    for key in sorted(blocks):
        group = blocks[key]
        # complete = all four hourly candles of the block exist, and the block is not the one still running
        if len(group) == 4:
            closes.append(group[-1][4])
    return closes


def make_filters(app):
    def f_4h(candles, i, setup):
        closes = four_hour_closes(candles, i)
        if len(closes) < 55:
            return False
        e20, e50 = app._ema(closes, 20)[-1], app._ema(closes, 50)[-1]
        return e20 > e50 if setup["side"] == "bullish" else e20 < e50

    def rsi_at(candles, k):
        closes = [c[4] for c in candles[max(0, k - 40): k + 1]]
        try:
            return app.rsi(closes)
        except ValueError:
            return None

    def f_rsi(candles, i, setup):
        long = setup["side"] == "bullish"
        r = next((k for k in range(i, max(0, i - 6), -1) if candles[k][0] == setup["rejection_at"]), None)
        if r is None:
            return False
        values = [rsi_at(candles, k) for k in range(max(0, r - 1), i + 1)]
        values = [v for v in values if v is not None]
        if len(values) < 2:
            return False
        now = values[-1]
        if long:
            low = min(values)
            return low <= 45 and now > low
        high = max(values)
        return high >= 55 and now < high

    def f_candle(candles, i, setup):
        r = next((k for k in range(i, max(0, i - 6), -1) if candles[k][0] == setup["rejection_at"]), None)
        if r is None:
            return False
        o, c = candles[r][1], candles[r][4]
        return c > o if setup["side"] == "bullish" else c < o

    return f_4h, f_rsi, f_candle


def variants(app):
    f_4h, f_rsi, f_candle = make_filters(app)
    both = lambda *fs: (lambda candles, i, setup: all(f(candles, i, setup) for f in fs))
    return [
        ("swing rule as it is now", None),
        ("+ 4H trend", f_4h),
        ("+ RSI turning", f_rsi),
        ("+ green/red candle", f_candle),
        ("+ 4H + RSI", both(f_4h, f_rsi)),
        ("+ 4H + RSI + candle", both(f_4h, f_rsi, f_candle)),
    ]


def run_all(coin_candles, app, args):
    """coin_candles: {base: candles}. Returns {variant name: [trades]}."""
    out = {name: [] for name, _ in variants(app)}
    for base, candles in coin_candles.items():
        for name, accept in variants(app):
            out[name] += bt.run_coin(base, candles, app, args.max_wait, args.max_hold, args.fee, accept=accept, min_index=WARMUP)
    return out


def table(by_variant, base_name, trades_filter=None):
    rows = [f"  {'variant':<26}{'setups':>7}{'vs now':>8}{'taken':>7}{'stop':>7}{'T1':>7}{'T2':>7}{'avg A':>9}{'avg B':>9}"]
    base_n = len([t for t in by_variant[base_name] if trades_filter is None or trades_filter(t)]) or 1
    for name, trades in by_variant.items():
        ts = [t for t in trades if trades_filter is None or trades_filter(t)]
        s = bt.stats(ts)
        if not s.get("taken"):
            rows.append(f"  {name:<26}{s['setups']:>7}{100 * s['setups'] / base_n:>7.0f}%{'-':>7}")
            continue
        few = "*" if s["taken"] < 30 else " "
        rows.append(f"  {name:<26}{s['setups']:>7}{100 * s['setups'] / base_n:>7.0f}%{s['taken']:>6}{few}"
                    f"{s['stop_pct']:>6.0f}%{s['t1_pct']:>6.0f}%{s['t2_pct']:>6.0f}%{s['avg_a']:>+8.2f}R{s['avg_b']:>+8.2f}R")
    return rows


def report(by_variant, args, start, end):
    base_name = next(iter(by_variant))
    cut = start + 0.6 * (end - start)
    lines = [f"Swing rule + extra filters · top {args.top} coins · last {args.days} days · fee {args.fee}% per side",
             "setups = how many setups the variant shows ('vs now' = share of today's setups that are left); taken = price crossed the trigger;",
             "stop / T1 / T2 = share of taken trades; avg A = mean R per trade exiting at Target 1, avg B = exiting at Target 2 (after fees).",
             "break-even before fees: A needs T1 >= 40%, B needs T2 >= 29%.  * = under 30 taken trades: too few to trust.", ""]
    lines += ["ALL DATA"] + table(by_variant, base_name) + [""]
    lines += ["TUNE PART (first 60%)"] + table(by_variant, base_name, lambda t: t["at"] < cut) + [""]
    lines += ["HOLDOUT PART (last 40%): the fairer test"] + table(by_variant, base_name, lambda t: t["at"] >= cut) + [""]
    lines += ["How to read it: a filter is worth adding only if, in BOTH parts, the average goes up (closer to or above 0)",
              "and there are still enough taken trades. If a filter only removes setups and the average does not improve,",
              "it just makes the radar emptier. The past does not promise the future; slippage is not included."]
    return "\n".join(lines)


def main_cli():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--fee", type=float, default=0.1, help="fee in percent per side (Binance spot is 0.1)")
    ap.add_argument("--max-wait", type=int, default=12)
    ap.add_argument("--max-hold", type=int, default=48)
    ap.add_argument("--out", default="backtest_filters_report.txt")
    args = ap.parse_args()

    import main as app  # noqa: E402
    bases = bt.top_bases(app, args.top)
    hours = args.days * 24 + WARMUP
    coin_candles, start, end = {}, None, None
    for idx, base in enumerate(bases, 1):
        try:
            candles = bt.fetch_candles(app, base, hours)
        except Exception as error:
            print(f"[{idx}/{len(bases)}] {base}: skipped ({error})", flush=True)
            continue
        if len(candles) < WARMUP + 100:
            print(f"[{idx}/{len(bases)}] {base}: only {len(candles)} candles, skipped", flush=True)
            continue
        coin_candles[base] = candles
        s, e = candles[WARMUP][0], candles[-1][0]
        start = s if start is None else min(start, s)
        end = e if end is None else max(end, e)
        print(f"[{idx}/{len(bases)}] {base}: {len(candles)} candles", flush=True)
    if not coin_candles:
        print("No coins loaded. Nothing to report.")
        return
    by_variant = run_all(coin_candles, app, args)
    text = report(by_variant, args, start, end)
    print("\n" + text)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(f"\nSaved to {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main_cli()
