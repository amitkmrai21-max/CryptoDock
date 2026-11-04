#!/usr/bin/env python3
"""Which kinds of swing setups win more?  (Read-only; places no orders; FEES ARE NOT INCLUDED by default.)

Runs the same swing backtest as tools/backtest_swing.py (it reuses main._swing_setup, the exact function the app
runs, and the same trade simulation), but notes down a few facts about every setup when it appears, and then shows
how the results differ between groups, for example "stop under 0.6% away" against "stop over 2.5% away".

Facts noted for each setup (all known at that moment, from candles that were already closed):
  side, trend strength, wick of the rejection candle, stop distance, 4H trend agrees, BTC 1H trend agrees,
  RSI in the trade's direction, volatility (ATR%), session of the day (UTC), coin volume rank, how many hours
  ago the rejection candle closed, weekday / weekend.

For every group it shows the number of trades, how often Target 1 / Target 2 was reached and the average result in R
(A = exit at Target 1, B = exit at Target 2), for all data and for the two halves: the first 60% (tune) and the last
40% (holdout). A group is marked with a tick only if it beat the whole baseline in BOTH halves, by at least 0.05R on
both A and B, with at least 40 trades in each half. That is the only kind of result worth trusting: a group that
looks good in one half only is usually luck, and with this many groups some will look good by luck alone.

Run it on the server (where Binance is reachable), from the project folder:

    cd /var/www/CryptoDock && venv/bin/python tools/backtest_swing_features.py --days 90 --top 60

Add --fee 0.1 to include a fee of 0.1% per side (default is 0: this tool is about selection, not about costs).
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backtest_swing as bt  # noqa: E402  (also moves the working directory to the project folder)
import backtest_swing_filters as bf  # noqa: E402

HOUR = 3600
WARMUP = bf.WARMUP


def bucket_of(value, edges, labels):
    for edge, label in zip(edges, labels):
        if value < edge:
            return label
    return labels[-1]


class BtcTrend:
    """1H EMA 20 / 50 of BTC at any moment, looked up by candle time."""

    def __init__(self, app, candles):
        closes = [c[4] for c in candles]
        e20, e50 = app._ema(closes, 20), app._ema(closes, 50)
        self.by_time = {c[0]: (e20[k] > e50[k]) for k, c in enumerate(candles) if k >= 50}

    def up(self, t):
        return self.by_time.get(t)


def make_recorder(base, rank, app, btc, store):
    f_4h = bf.make_filters(app)[0]

    def accept(candles, i, setup):
        long = setup["side"] == "bullish"
        r = next((k for k in range(i, max(0, i - 6), -1) if candles[k][0] == setup["rejection_at"]), None)
        if r is None:
            return False
        _, o, h, l, c = candles[r]
        rng = h - l
        wick = (min(o, c) - l) if long else (h - max(o, c))
        wick_ratio = wick / rng if rng > 0 else 0
        stop_pct = abs(setup["entry"] - setup["stop"]) / setup["entry"] * 100
        try:
            rsi_value = app.rsi([x[4] for x in candles[max(0, i - 40): i + 1]])
        except ValueError:
            rsi_value = 50.0
        rsi_dir = rsi_value if long else 100 - rsi_value
        recent = candles[i - 13: i + 1]
        atr_pct = sum((x[2] - x[3]) / x[4] for x in recent) / len(recent) * 100
        t = candles[i][0]
        btc_up = btc.up(t) if btc else None
        days = t // 86400
        feats = {
            "side": setup["side"],
            "trend strength (score)": bucket_of(setup.get("trend_score") or 0, [60, 80], ["under 60", "60-79", "80 and over"]),
            "wick of rejection candle": bucket_of(wick_ratio, [0.55, 0.70], ["under 55%", "55-70%", "over 70%"]),
            "stop distance": bucket_of(stop_pct, [0.6, 1.2, 2.5], ["under 0.6%", "0.6-1.2%", "1.2-2.5%", "over 2.5%"]),
            "4H trend": "agrees" if f_4h(candles, i, setup) else "against",
            "BTC 1H trend": "n/a" if btc_up is None else ("agrees" if btc_up == long else "against"),
            "RSI (in trade direction)": bucket_of(rsi_dir, [40, 50, 60], ["under 40", "40-50", "50-60", "over 60"]),
            "volatility (ATR%)": bucket_of(atr_pct, [0.4, 0.8], ["under 0.4%", "0.4-0.8%", "over 0.8%"]),
            "session (UTC)": bucket_of((t // HOUR) % 24, [8, 16], ["00-08 Asia", "08-16 Europe", "16-24 US"]),
            "coin volume rank": bucket_of(rank, [11, 31], ["top 10", "11-30", "31 and below"]),
            "hours since rejection": bucket_of(i - r, [2, 3], ["0-1", "2", "3"]),
            "day": "weekend" if (days + 3) % 7 >= 5 else "weekday",
        }
        store[(base, t)] = feats
        return True

    return accept


def collect(coin_candles, ranks, app, args):
    btc = BtcTrend(app, coin_candles["BTC"]) if "BTC" in coin_candles else None
    store, trades = {}, []
    for base, candles in coin_candles.items():
        if base == "BTC" and base not in ranks:
            continue  # BTC fetched only for the trend lookup
        accept = make_recorder(base, ranks.get(base, 99), app, btc, store)
        got = bt.run_coin(base, candles, app, args.max_wait, args.max_hold, args.fee, accept=accept, min_index=WARMUP)
        for trade in got:
            trade["feats"] = store.get((base, trade["at"]), {})
        trades += got
    return trades


def group_stats(trades):
    s = bt.stats(trades)
    if not s.get("taken"):
        return None
    return {"n": s["taken"], "t1": s["t1_pct"], "t2": s["t2_pct"], "a": s["avg_a"], "b": s["avg_b"]}


def fmt(s):
    if s is None:
        return f"{'-':>5}"
    few = "*" if s["n"] < 40 else " "
    return f"{s['n']:>5}{few}{s['t1']:>5.0f}%{s['t2']:>5.0f}%{a_fmt(s['a'])}{a_fmt(s['b'])}"


def a_fmt(v):
    return f"{v:>+7.2f}"


def report(trades, args, cut):
    parts = {"ALL": trades, "TUNE": [t for t in trades if t["at"] < cut], "HOLD": [t for t in trades if t["at"] >= cut]}
    base = {k: group_stats(v) for k, v in parts.items()}
    lines = [f"Which swing setups win more · top {args.top} coins · last {args.days} days · fee {args.fee}% per side"
             + ("  (FEES NOT INCLUDED)" if args.fee == 0 else ""),
             "n = trades taken; T1 / T2 = share that reached Target 1 / 2; A / B = average R per trade (exit at T1 / exit at T2).",
             "Break-even without fees: A needs T1 >= 40%, B needs T2 >= 29%.  * = under 40 trades.  ✓ = beat the baseline in BOTH halves by 0.05R+ on A and B (40+ trades each).",
             "", "BASELINE (all setups)",
             f"  {'':<28}{'--- ALL ---':<40}{'--- TUNE (first 60%) ---':<40}{'--- HOLD (last 40%) ---'}",
             f"  {'':<28}" + ("{:>5} {:>6}{:>6}{:>7}{:>7}".format("n", "T1", "T2", "A", "B").ljust(40)) * 2 + "{:>5} {:>6}{:>6}{:>7}{:>7}".format("n", "T1", "T2", "A", "B")]
    lines.append(f"  {'swing rule as it is now':<28}{fmt(base['ALL']):<40}{fmt(base['TUNE']):<40}{fmt(base['HOLD'])}")
    ticks = []
    names = list(next(t for t in trades if t.get("feats"))["feats"].keys()) if trades else []
    for feat in names:
        lines += ["", feat.upper()]
        values = sorted({t["feats"].get(feat) for t in trades if t.get("feats")}, key=str)
        for value in values:
            sub = {k: group_stats([t for t in v if t.get("feats", {}).get(feat) == value]) for k, v in parts.items()}
            tune, hold = sub["TUNE"], sub["HOLD"]
            ok = (tune and hold and tune["n"] >= 40 and hold["n"] >= 40 and base["TUNE"] and base["HOLD"]
                  and tune["a"] >= base["TUNE"]["a"] + 0.05 and tune["b"] >= base["TUNE"]["b"] + 0.05
                  and hold["a"] >= base["HOLD"]["a"] + 0.05 and hold["b"] >= base["HOLD"]["b"] + 0.05)
            mark = "✓" if ok else " "
            if ok:
                ticks.append((feat, value, sub))
            lines.append(f" {mark}{value:<28}{fmt(sub['ALL']):<40}{fmt(sub['TUNE']):<40}{fmt(sub['HOLD'])}")
    lines += ["", "SUMMARY"]
    if ticks:
        lines.append("Groups that beat the baseline in BOTH halves (the only ones worth a closer look):")
        for feat, value, sub in ticks:
            lines.append(f"  - {feat}: {value}  (all: {sub['ALL']['n']} trades, T1 {sub['ALL']['t1']:.0f}%, A {sub['ALL']['a']:+.2f}R, B {sub['ALL']['b']:+.2f}R)")
    else:
        lines.append("No single group beat the baseline in both halves. That means none of these facts picks better setups on its own.")
    lines += ["", "Caution: about 35 groups are compared, so a few will look good by chance. Only trust a tick, and even then the past",
              "does not promise the future. Volume of the rejection candle is not included (the candle data used here has none)."]
    return "\n".join(lines)


def main_cli():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--fee", type=float, default=0.0, help="fee in percent per side (default 0: selection only)")
    ap.add_argument("--max-wait", type=int, default=12)
    ap.add_argument("--max-hold", type=int, default=48)
    ap.add_argument("--out", default="backtest_features_report.txt")
    args = ap.parse_args()

    import main as app  # noqa: E402
    bases = bt.top_bases(app, args.top)
    ranks = {b: n for n, b in enumerate(bases, 1)}
    fetch_list = bases + ([] if "BTC" in bases else ["BTC"])
    hours = args.days * 24 + WARMUP
    coin_candles, start, end = {}, None, None
    for idx, base in enumerate(fetch_list, 1):
        try:
            candles = bt.fetch_candles(app, base, hours)
        except Exception as error:
            print(f"[{idx}/{len(fetch_list)}] {base}: skipped ({error})", flush=True)
            continue
        if len(candles) < WARMUP + 100:
            print(f"[{idx}/{len(fetch_list)}] {base}: only {len(candles)} candles, skipped", flush=True)
            continue
        coin_candles[base] = candles
        s, e = candles[WARMUP][0], candles[-1][0]
        start = s if start is None else min(start, s)
        end = e if end is None else max(end, e)
        print(f"[{idx}/{len(fetch_list)}] {base}: {len(candles)} candles", flush=True)
    if not coin_candles:
        print("No coins loaded. Nothing to report.")
        return
    trades = collect(coin_candles, ranks, app, args)
    if not trades:
        print("No setups found. Nothing to report.")
        return
    cut = start + 0.6 * (end - start)
    text = report(trades, args, cut)
    print("\n" + text)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(f"\nSaved to {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main_cli()
