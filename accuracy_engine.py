"""
Accuracy Pattern Recognition & Confluence Engine
Written completely fresh from scratch for CryptoDock.
Adheres strictly to the user's uploaded chart pattern rules:
- BTC Liquidity Sweep + Market Structure Shift (MSS)
- Classical Reversal: Head & Shoulders, Double/Triple Tops/Bottoms, Wedges
- Continuation: Ascending/Descending/Symmetrical Triangles, Flags, Pennants
- Box Consolidation Range Breakouts
- Volume expansion and strictly CLOSED candle confirmation (candles[-2])
"""

import math
import time

def calculate_swings(candles, left=2, right=2):
    n = len(candles)
    highs, lows = [], []
    for i in range(left, n - right):
        h = candles[i]["h"]
        l = candles[i]["l"]
        is_high = all(candles[i-j]["h"] <= h for j in range(1, left+1)) and all(candles[i+j]["h"] <= h for j in range(1, right+1))
        is_low = all(candles[i-j]["l"] >= l for j in range(1, left+1)) and all(candles[i+j]["l"] >= l for j in range(1, right+1))
        if is_high:
            highs.append({"idx": i, "price": h, "candle": candles[i]})
        if is_low:
            lows.append({"idx": i, "price": l, "candle": candles[i]})
    return highs, lows

def get_volume_profile(candles, lookback=20):
    n = len(candles)
    vols = [c["v"] for c in candles[-lookback-2:-2]] if n >= lookback + 2 else [c["v"] for c in candles[:-2]]
    avg_vol = sum(vols) / len(vols) if vols else 1.0
    latest_closed_vol = candles[-2]["v"] if n >= 2 else 0.0
    ratio = round(latest_closed_vol / avg_vol, 2) if avg_vol > 0 else 1.0
    return ratio, avg_vol

def is_fresh_break(candles, level, side, min_vol_ratio=1.15):
    """Apply the user's strict breakout -> pullback -> confirmation sequence.

    LONG setup:
      A) Previous close at/below level; candle 1 closes above it; candle 2 is red
         and closes above the level (its wick may touch the level); candle 3 is green
         and closes above candle 2's high.
      B) Same breakout and pullback; candle 3 closes inside candle 2's range while
         staying above the level; candle 4 is green and closes above both candles'
         highs.

    SHORT setup is the exact inverse. A pullback/pause candle that closes on or
    inside the breakout line is rejected. The trigger is always the latest closed
    candle, and must retain the existing volume confirmation. The two exact
    sequences prevent late entries after a multi-candle runaway.
    """
    if len(candles) < 7 or side not in ("LONG", "SHORT"):
        return False

    trigger = candles[-2]  # latest closed candle; candles[-1] may still be live

    # Preserve the existing volume-surge confirmation on the trigger candle.
    lookback = 20
    vols = candles[-lookback-2:-2] if len(candles) >= lookback + 2 else candles[:-2]
    avg_vol = sum(c["v"] for c in vols) / len(vols) if vols else 1.0
    volume_ratio = trigger["v"] / avg_vol if avg_vol > 0 else 1.0
    if volume_ratio < min_vol_ratio:
        return False

    if side == "LONG":
        if not (trigger["c"] > trigger["o"] and trigger["c"] > level):
            return False

        # Scenario A: breakout, one red retest candle, then green close above its high.
        prev, breakout, pullback = candles[-5], candles[-4], candles[-3]
        if (
            prev["c"] <= level
            and breakout["c"] > level
            and pullback["c"] < pullback["o"]
            and pullback["c"] > level  # wick touch is allowed; close inside/on line is not
            and trigger["c"] > pullback["h"]
        ):
            return True

        # Scenario B: same breakout/retest, one inside-range pause, then confirmation.
        prev, breakout, pullback, pause = candles[-6], candles[-5], candles[-4], candles[-3]
        if (
            prev["c"] <= level
            and breakout["c"] > level
            and pullback["c"] < pullback["o"]
            and pullback["c"] > level
            and pullback["l"] <= pause["c"] <= pullback["h"]
            and pause["c"] > level
            and trigger["c"] > max(pullback["h"], pause["h"])
        ):
            return True
        return False

    if not (trigger["c"] < trigger["o"] and trigger["c"] < level):
        return False

    # Scenario A: breakdown, one green retest candle, then red close below its low.
    prev, breakout, pullback = candles[-5], candles[-4], candles[-3]
    if (
        prev["c"] >= level
        and breakout["c"] < level
        and pullback["c"] > pullback["o"]
        and pullback["c"] < level  # wick touch is allowed; close inside/on line is not
        and trigger["c"] < pullback["l"]
    ):
        return True

    # Scenario B: same breakdown/retest, one inside-range pause, then confirmation.
    prev, breakout, pullback, pause = candles[-6], candles[-5], candles[-4], candles[-3]
    if (
        prev["c"] >= level
        and breakout["c"] < level
        and pullback["c"] > pullback["o"]
        and pullback["c"] < level
        and pullback["l"] <= pause["c"] <= pullback["h"]
        and pause["c"] < level
        and trigger["c"] < min(pullback["l"], pause["l"])
    ):
        return True
    return False

def check_liquidity_sweep_mss(candles, highs, lows):
    """
    BTC Liquidity Sweep + Market Structure Shift:
    Bearish:
      1. Prior swing high H_prev
      2. Price sweeps above H_prev (high > H_prev), rejects with upper wick / closed candle back below
      3. Subsequent pullback creates local swing low L_local
      4. Latest CLOSED candle (candles[-2]) closes strictly BELOW L_local -> Bearish MSS
    Bullish:
      1. Prior swing low L_prev
      2. Price sweeps below L_prev (low < L_prev), rejects with lower wick / closed candle back above
      3. Subsequent bounce creates local swing high H_local
      4. Latest CLOSED candle (candles[-2]) closes strictly ABOVE H_local -> Bullish MSS
    """
    n = len(candles)
    if n < 30 or len(highs) < 2 or len(lows) < 2:
        return None

    last_closed = candles[-2]
    curr_c = last_closed["c"]

    # Bearish Check
    for i in range(len(highs) - 1, 0, -1):
        sweep_h = highs[i]
        prev_h = highs[i-1]
        if sweep_h["price"] > prev_h["price"] and sweep_h["idx"] > prev_h["idx"]:
            sc = sweep_h["candle"]
            upper_wick = sc["h"] - max(sc["o"], sc["c"])
            c_range = sc["h"] - sc["l"]
            # Flexible Top Liquidity Sweep: Rejection wick (>=15%), candle closed back below prior top,
            # or subsequent candle immediately closed back below prior top (absorbing liquidity)
            has_rejection = (
                (c_range > 0 and upper_wick / c_range >= 0.15) or
                (sc["c"] < prev_h["price"]) or
                (sweep_h["idx"] + 1 < n and candles[sweep_h["idx"] + 1]["c"] < prev_h["price"])
            )
            
            if has_rejection and sweep_h["idx"] < n - 3:
                after_lows = [l for l in lows if sweep_h["idx"] < l["idx"] <= n - 3]
                if after_lows:
                    local_low = min(after_lows, key=lambda x: x["price"])
                    # Confirmed: closed candle below local_low
                    if curr_c < local_low["price"] and is_fresh_break(candles, local_low["price"], "SHORT"):
                        entry = curr_c
                        sl = round(sweep_h["price"] * 1.002, 6)
                        risk = (sl - entry) / entry
                        if 0.003 <= risk <= 0.045:
                            t1 = round(entry - (sl - entry) * 1.6, 6)
                            t2 = round(entry - (sl - entry) * 2.8, 6)
                            return {
                                "pattern": "Liquidity Sweep + MSS",
                                "category": "Smart Money Structure",
                                "side": "SHORT",
                                "status": "CONFIRMED",
                                "breakout_level": local_low["price"],
                                "sweep_level": sweep_h["price"],
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": t1,
                                "target_2": t2,
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Swept buy-side liquidity at {sweep_h['price']}, rejected, and closed candle broke below swing low {local_low['price']}."
                            }

    # Bullish Check
    for i in range(len(lows) - 1, 0, -1):
        sweep_l = lows[i]
        prev_l = lows[i-1]
        if sweep_l["price"] < prev_l["price"] and sweep_l["idx"] > prev_l["idx"]:
            sc = sweep_l["candle"]
            lower_wick = min(sc["o"], sc["c"]) - sc["l"]
            c_range = sc["h"] - sc["l"]
            # Flexible Bottom Liquidity Sweep: Rejection wick (>=15%), candle closed back above prior bottom,
            # or subsequent candle immediately closed back above prior bottom (absorbing liquidity)
            has_rejection = (
                (c_range > 0 and lower_wick / c_range >= 0.15) or
                (sc["c"] > prev_l["price"]) or
                (sweep_l["idx"] + 1 < n and candles[sweep_l["idx"] + 1]["c"] > prev_l["price"])
            )

            if has_rejection and sweep_l["idx"] < n - 3:
                after_highs = [h for h in highs if sweep_l["idx"] < h["idx"] <= n - 3]
                if after_highs:
                    local_high = max(after_highs, key=lambda x: x["price"])
                    if curr_c > local_high["price"] and is_fresh_break(candles, local_high["price"], "LONG"):
                        entry = curr_c
                        sl = round(sweep_l["price"] * 0.998, 6)
                        risk = (entry - sl) / entry
                        if 0.003 <= risk <= 0.045:
                            t1 = round(entry + (entry - sl) * 1.6, 6)
                            t2 = round(entry + (entry - sl) * 2.8, 6)
                            return {
                                "pattern": "Liquidity Sweep + MSS",
                                "category": "Smart Money Structure",
                                "side": "LONG",
                                "status": "CONFIRMED",
                                "breakout_level": local_high["price"],
                                "sweep_level": sweep_l["price"],
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": t1,
                                "target_2": t2,
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Swept sell-side liquidity at {sweep_l['price']}, rejected, and closed candle broke above swing high {local_high['price']}."
                            }
    return None

def check_head_and_shoulders(candles, highs, lows):
    """Head & Shoulders (Bearish) and Inverse Head & Shoulders (Bullish)."""
    n = len(candles)
    if len(highs) < 3 or len(lows) < 2:
        return None
    curr_c = candles[-2]["c"]

    # Bearish H&S
    for i in range(len(highs) - 3, -1, -1):
        s1, head, s2 = highs[i], highs[i+1], highs[i+2]
        if s1["idx"] < head["idx"] < s2["idx"] and s2["idx"] <= n - 3:
            if head["price"] > s1["price"] * 1.008 and head["price"] > s2["price"] * 1.008:
                shoulder_diff = abs(s1["price"] - s2["price"]) / max(s1["price"], s2["price"])
                if shoulder_diff < 0.040:
                    troughs = [l for l in lows if s1["idx"] < l["idx"] < s2["idx"]]
                    if len(troughs) >= 2:
                        neckline = sum(t["price"] for t in troughs) / len(troughs)
                        if curr_c < neckline and is_fresh_break(candles, neckline, "SHORT"):
                            entry = curr_c
                            sl = round(s2["price"] * 1.002, 6)
                            risk = (sl - entry) / entry
                            if 0.003 <= risk <= 0.045:
                                p_height = head["price"] - neckline
                                return {
                                    "pattern": "Head & Shoulders",
                                    "category": "Reversal Pattern",
                                    "side": "SHORT",
                                    "status": "CONFIRMED",
                                    "breakout_level": round(neckline, 6),
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": round(neckline - p_height * 0.8, 6),
                                    "target_2": round(neckline - p_height * 1.4, 6),
                                    "risk_pct": round(risk * 100, 2),
                                    "rr_1": "1:1.6",
                                    "rr_2": "1:2.8",
                                    "summary": f"Classic Head & Shoulders completed with closed candle below neckline {round(neckline, 4)}."
                                }

    # Inverse H&S (Bullish)
    for i in range(len(lows) - 3, -1, -1):
        s1, head, s2 = lows[i], lows[i+1], lows[i+2]
        if s1["idx"] < head["idx"] < s2["idx"] and s2["idx"] <= n - 3:
            if head["price"] < s1["price"] * 0.992 and head["price"] < s2["price"] * 0.992:
                shoulder_diff = abs(s1["price"] - s2["price"]) / min(s1["price"], s2["price"])
                if shoulder_diff < 0.040:
                    peaks = [h for h in highs if s1["idx"] < h["idx"] < s2["idx"]]
                    if len(peaks) >= 2:
                        neckline = sum(p["price"] for p in peaks) / len(peaks)
                        if curr_c > neckline and is_fresh_break(candles, neckline, "LONG"):
                            entry = curr_c
                            sl = round(s2["price"] * 0.998, 6)
                            risk = (entry - sl) / entry
                            if 0.003 <= risk <= 0.045:
                                p_height = neckline - head["price"]
                                return {
                                    "pattern": "Inverse Head & Shoulders",
                                    "category": "Reversal Pattern",
                                    "side": "LONG",
                                    "status": "CONFIRMED",
                                    "breakout_level": round(neckline, 6),
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": round(neckline + p_height * 0.8, 6),
                                    "target_2": round(neckline + p_height * 1.4, 6),
                                    "risk_pct": round(risk * 100, 2),
                                    "rr_1": "1:1.6",
                                    "rr_2": "1:2.8",
                                    "summary": f"Inverse Head & Shoulders completed with closed candle above neckline {round(neckline, 4)}."
                                }
    return None

def check_double_triple_top_bottom(candles, highs, lows):
    """Double & Triple Tops/Bottoms."""
    n = len(candles)
    curr_c = candles[-2]["c"]

    # Triple Top
    if len(highs) >= 3:
        p1, p2, p3 = highs[-3], highs[-2], highs[-1]
        if p3["idx"] <= n - 3:
            top_max = max(p1["price"], p2["price"], p3["price"])
            top_min = min(p1["price"], p2["price"], p3["price"])
            if (top_max - top_min) / top_min <= 0.018:
                # Distinct troughs between p1 & p2 and between p2 & p3
                t1 = [l for l in lows if p1["idx"] < l["idx"] < p2["idx"]]
                t2 = [l for l in lows if p2["idx"] < l["idx"] < p3["idx"]]
                if t1 and t2:
                    neckline = min(min(t["price"] for t in t1), min(t["price"] for t in t2))
                    h = top_max - neckline
                    if (h / top_max >= 0.005) and curr_c < neckline and is_fresh_break(candles, neckline, "SHORT"):
                        entry = curr_c
                        sl = round(top_max * 1.002, 6)
                        risk = (sl - entry) / entry
                        if 0.003 <= risk <= 0.045:
                            h = top_max - neckline
                            return {
                                "pattern": "Triple Top",
                                "category": "Reversal Pattern",
                                "side": "SHORT",
                                "status": "CONFIRMED",
                                "breakout_level": neckline,
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": round(neckline - h * 0.8, 6),
                                "target_2": round(neckline - h * 1.4, 6),
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Triple Top resistance rejected 3 times at {round(top_max, 4)} with closed candle breakdown below {neckline}."
                            }

    # Triple Bottom
    if len(lows) >= 3:
        t1, t2, t3 = lows[-3], lows[-2], lows[-1]
        if t3["idx"] <= n - 3:
            bot_max = max(t1["price"], t2["price"], t3["price"])
            bot_min = min(t1["price"], t2["price"], t3["price"])
            if (bot_max - bot_min) / bot_min <= 0.018:
                # Distinct peaks between t1 & t2 and between t2 & t3
                pk1 = [h for h in highs if t1["idx"] < h["idx"] < t2["idx"]]
                pk2 = [h for h in highs if t2["idx"] < h["idx"] < t3["idx"]]
                if pk1 and pk2:
                    neckline = max(max(p["price"] for p in pk1), max(p["price"] for p in pk2))
                    h = neckline - bot_min
                    if (h / bot_min >= 0.005) and curr_c > neckline and is_fresh_break(candles, neckline, "LONG"):
                        entry = curr_c
                        sl = round(bot_min * 0.998, 6)
                        risk = (entry - sl) / entry
                        if 0.003 <= risk <= 0.045:
                            h = neckline - bot_min
                            return {
                                "pattern": "Triple Bottom",
                                "category": "Reversal Pattern",
                                "side": "LONG",
                                "status": "CONFIRMED",
                                "breakout_level": neckline,
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": round(neckline + h * 0.8, 6),
                                "target_2": round(neckline + h * 1.4, 6),
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Triple Bottom support held 3 times at {round(bot_min, 4)} with closed candle breakout above {neckline}."
                            }

    # Double Top
    if len(highs) >= 2:
        for i in range(len(highs) - 2, -1, -1):
            p1, p2 = highs[i], highs[i+1]
            if p2["idx"] <= n - 3 and 4 <= (p2["idx"] - p1["idx"]) <= 35:
                diff = abs(p1["price"] - p2["price"]) / max(p1["price"], p2["price"])
                if diff <= 0.016:
                    inter_lows = [l for l in lows if p1["idx"] < l["idx"] < p2["idx"]]
                    if inter_lows:
                        trough = min(inter_lows, key=lambda x: x["price"])
                        h = max(p1["price"], p2["price"]) - trough["price"]
                        if (h / max(p1["price"], p2["price"]) >= 0.005) and curr_c < trough["price"] and is_fresh_break(candles, trough["price"], "SHORT"):
                            entry = curr_c
                            sl = round(max(p1["price"], p2["price"]) * 1.002, 6)
                            risk = (sl - entry) / entry
                            if 0.003 <= risk <= 0.045:
                                h = max(p1["price"], p2["price"]) - trough["price"]
                                return {
                                    "pattern": "Double Top",
                                    "category": "Reversal Pattern",
                                    "side": "SHORT",
                                    "status": "CONFIRMED",
                                    "breakout_level": trough["price"],
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": round(trough["price"] - h * 0.8, 6),
                                    "target_2": round(trough["price"] - h * 1.4, 6),
                                    "risk_pct": round(risk * 100, 2),
                                    "rr_1": "1:1.5",
                                    "rr_2": "1:2.6",
                                    "summary": f"Double Top rejection at {round(max(p1['price'], p2['price']), 4)} with closed candle below neckline {trough['price']}."
                                }

    # Double Bottom
    if len(lows) >= 2:
        for i in range(len(lows) - 2, -1, -1):
            t1, t2 = lows[i], lows[i+1]
            if t2["idx"] <= n - 3 and 4 <= (t2["idx"] - t1["idx"]) <= 35:
                diff = abs(t1["price"] - t2["price"]) / min(t1["price"], t2["price"])
                if diff <= 0.016:
                    inter_highs = [h for h in highs if t1["idx"] < h["idx"] < t2["idx"]]
                    if inter_highs:
                        peak = max(inter_highs, key=lambda x: x["price"])
                        h = peak["price"] - min(t1["price"], t2["price"])
                        if (h / min(t1["price"], t2["price"]) >= 0.005) and curr_c > peak["price"] and is_fresh_break(candles, peak["price"], "LONG"):
                            entry = curr_c
                            sl = round(min(t1["price"], t2["price"]) * 0.998, 6)
                            risk = (entry - sl) / entry
                            if 0.003 <= risk <= 0.045:
                                h = peak["price"] - min(t1["price"], t2["price"])
                                return {
                                    "pattern": "Double Bottom",
                                    "category": "Reversal Pattern",
                                    "side": "LONG",
                                    "status": "CONFIRMED",
                                    "breakout_level": peak["price"],
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": round(peak["price"] + h * 0.8, 6),
                                    "target_2": round(peak["price"] + h * 1.4, 6),
                                    "risk_pct": round(risk * 100, 2),
                                    "rr_1": "1:1.5",
                                    "rr_2": "1:2.6",
                                    "summary": f"Double Bottom bounce at {round(min(t1['price'], t2['price']), 4)} with closed candle above neckline {peak['price']}."
                                }
    return None

def check_triangles_and_wedges(candles, highs, lows):
    """Ascending, Descending, Symmetrical Triangles & Wedges."""
    n = len(candles)
    if len(highs) < 2 or len(lows) < 2:
        return None
    curr_c = candles[-2]["c"]

    recent_h = highs[-3:]
    recent_l = lows[-3:]
    if len(recent_h) >= 2 and len(recent_l) >= 2:
        h1, h2 = recent_h[-2], recent_h[-1]
        l1, l2 = recent_l[-2], recent_l[-1]

        # Ascending Triangle
        res_diff = abs(h1["price"] - h2["price"]) / max(h1["price"], h2["price"])
        if res_diff < 0.010 and l2["price"] > l1["price"] * 1.003:
            res_level = max(h1["price"], h2["price"])
            if curr_c > res_level and is_fresh_break(candles, res_level, "LONG"):
                entry = curr_c
                sl = round(l2["price"] * 0.998, 6)
                risk = (entry - sl) / entry
                if 0.003 <= risk <= 0.045:
                    height = res_level - l1["price"]
                    return {
                        "pattern": "Ascending Triangle",
                        "category": "Continuation Pattern",
                        "side": "LONG",
                        "status": "CONFIRMED",
                        "breakout_level": res_level,
                        "entry": entry,
                        "stop_loss": sl,
                        "target_1": round(res_level + height * 0.8, 6),
                        "target_2": round(res_level + height * 1.4, 6),
                        "risk_pct": round(risk * 100, 2),
                        "rr_1": "1:1.7",
                        "rr_2": "1:2.9",
                        "summary": f"Ascending Triangle breakout with candle close above resistance {res_level}."
                    }

        # Descending Triangle
        sup_diff = abs(l1["price"] - l2["price"]) / min(l1["price"], l2["price"])
        if sup_diff < 0.010 and h2["price"] < h1["price"] * 0.997:
            sup_level = min(l1["price"], l2["price"])
            if curr_c < sup_level and is_fresh_break(candles, sup_level, "SHORT"):
                entry = curr_c
                sl = round(h2["price"] * 1.002, 6)
                risk = (sl - entry) / entry
                if 0.003 <= risk <= 0.045:
                    height = h1["price"] - sup_level
                    return {
                        "pattern": "Descending Triangle",
                        "category": "Continuation Pattern",
                        "side": "SHORT",
                        "status": "CONFIRMED",
                        "breakout_level": sup_level,
                        "entry": entry,
                        "stop_loss": sl,
                        "target_1": round(sup_level - height * 0.8, 6),
                        "target_2": round(sup_level - height * 1.4, 6),
                        "risk_pct": round(risk * 100, 2),
                        "rr_1": "1:1.7",
                        "rr_2": "1:2.9",
                        "summary": f"Descending Triangle breakdown with candle close below support floor {sup_level}."
                    }

        # Falling Wedge
        if h2["price"] < h1["price"] and l2["price"] < l1["price"]:
            h_drop = (h1["price"] - h2["price"]) / h1["price"]
            l_drop = (l1["price"] - l2["price"]) / l1["price"]
            if h_drop > l_drop * 1.08:
                if curr_c > h2["price"] and is_fresh_break(candles, h2["price"], "LONG"):
                    entry = curr_c
                    sl = round(l2["price"] * 0.998, 6)
                    risk = (entry - sl) / entry
                    if 0.003 <= risk <= 0.045:
                        h = h1["price"] - l1["price"]
                        return {
                            "pattern": "Falling Wedge",
                            "category": "Reversal Pattern",
                            "side": "LONG",
                            "status": "CONFIRMED",
                            "breakout_level": h2["price"],
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": round(entry + h * 0.75, 6),
                            "target_2": round(entry + h * 1.3, 6),
                            "risk_pct": round(risk * 100, 2),
                            "rr_1": "1:1.7",
                            "rr_2": "1:2.9",
                            "summary": f"Falling Wedge bullish breakout with closed candle above descending resistance {h2['price']}."
                        }

        # Rising Wedge
        if h2["price"] > h1["price"] and l2["price"] > l1["price"]:
            h_gain = (h2["price"] - h1["price"]) / h1["price"]
            l_gain = (l2["price"] - l1["price"]) / l1["price"]
            if l_gain > h_gain * 1.08:
                if curr_c < l2["price"] and is_fresh_break(candles, l2["price"], "SHORT"):
                    entry = curr_c
                    sl = round(h2["price"] * 1.002, 6)
                    risk = (sl - entry) / entry
                    if 0.003 <= risk <= 0.045:
                        h = h2["price"] - l1["price"]
                        return {
                            "pattern": "Rising Wedge",
                            "category": "Reversal Pattern",
                            "side": "SHORT",
                            "status": "CONFIRMED",
                            "breakout_level": l2["price"],
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": round(entry - h * 0.75, 6),
                            "target_2": round(entry - h * 1.3, 6),
                            "risk_pct": round(risk * 100, 2),
                            "rr_1": "1:1.7",
                            "rr_2": "1:2.9",
                            "summary": f"Rising Wedge bearish breakdown with closed candle below ascending support {l2['price']}."
                        }

    return None

def check_box_range_breakout(candles):
    """Horizontal Box Range Consolidation Breakout."""
    n = len(candles)
    if n < 35:
        return None
    box_candles = candles[-28:-2]
    highs = [c["h"] for c in box_candles]
    lows = [c["l"] for c in box_candles]
    box_high = max(highs)
    box_low = min(lows)
    box_range = (box_high - box_low) / box_low

    if 0.012 <= box_range <= 0.065:
        last_closed = candles[-2]
        curr_c = last_closed["c"]

        # Bullish Box Breakout
        if curr_c > box_high and is_fresh_break(candles, box_high, "LONG"):
            entry = curr_c
            sl = round(box_low + (box_high - box_low) * 0.5, 6)
            risk = (entry - sl) / entry
            if 0.003 <= risk <= 0.045:
                h = box_high - box_low
                return {
                    "pattern": "Box Range Breakout",
                    "category": "Consolidation Breakout",
                    "side": "LONG",
                    "status": "CONFIRMED",
                    "breakout_level": box_high,
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": round(box_high + h * 1.0, 6),
                    "target_2": round(box_high + h * 2.0, 6),
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.8",
                    "rr_2": "1:3.2",
                    "summary": f"Decisive closed candle breakout above {round(box_range*100, 1)}% consolidation range ceiling {box_high}."
                }

        # Bearish Box Breakdown
        if curr_c < box_low and is_fresh_break(candles, box_low, "SHORT"):
            entry = curr_c
            sl = round(box_low + (box_high - box_low) * 0.5, 6)
            risk = (sl - entry) / entry
            if 0.003 <= risk <= 0.045:
                h = box_high - box_low
                return {
                    "pattern": "Box Range Breakdown",
                    "category": "Consolidation Breakout",
                    "side": "SHORT",
                    "status": "CONFIRMED",
                    "breakout_level": box_low,
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": round(box_low - h * 1.0, 6),
                    "target_2": round(box_low - h * 2.0, 6),
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.8",
                    "rr_2": "1:3.2",
                    "summary": f"Decisive closed candle breakdown below {round(box_range*100, 1)}% consolidation range floor {box_low}."
                }
    return None

def check_flag_pennant(candles):
    """Bullish and Bearish Flags/Pennants."""
    n = len(candles)
    if n < 25:
        return None
    curr_c = candles[-2]["c"]
    flag_candles = candles[-9:-2]
    pole_candles = candles[-18:-9]
    if not flag_candles or not pole_candles:
        return None

    pole_start = pole_candles[0]["o"]
    pole_end = pole_candles[-1]["c"]
    pole_pct = (pole_end - pole_start) / pole_start

    flag_high = max(c["h"] for c in flag_candles)
    flag_low = min(c["l"] for c in flag_candles)
    flag_range = (flag_high - flag_low) / flag_low

    if pole_pct >= 0.022 and flag_range <= 0.028:
        if curr_c > flag_high and is_fresh_break(candles, flag_high, "LONG"):
            entry = curr_c
            sl = round(flag_low * 0.998, 6)
            risk = (entry - sl) / entry
            if 0.003 <= risk <= 0.045:
                pole_h = pole_end - pole_start
                return {
                    "pattern": "Bullish Flag / Pennant",
                    "category": "Continuation Pattern",
                    "side": "LONG",
                    "status": "CONFIRMED",
                    "breakout_level": flag_high,
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": round(entry + pole_h * 0.618, 6),
                    "target_2": round(entry + pole_h * 1.0, 6),
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.8",
                    "rr_2": "1:3.0",
                    "summary": f"Bullish flag breakout after +{round(pole_pct*100, 1)}% impulse pole with closed candle above {flag_high}."
                }

    if pole_pct <= -0.022 and flag_range <= 0.028:
        if curr_c < flag_low and is_fresh_break(candles, flag_low, "SHORT"):
            entry = curr_c
            sl = round(flag_high * 1.002, 6)
            risk = (sl - entry) / entry
            if 0.003 <= risk <= 0.045:
                pole_h = pole_start - pole_end
                return {
                    "pattern": "Bearish Flag / Pennant",
                    "category": "Continuation Pattern",
                    "side": "SHORT",
                    "status": "CONFIRMED",
                    "breakout_level": flag_low,
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": round(entry - pole_h * 0.618, 6),
                    "target_2": round(entry - pole_h * 1.0, 6),
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.8",
                    "rr_2": "1:3.0",
                    "summary": f"Bearish flag breakdown after {round(pole_pct*100, 1)}% impulse drop with closed candle below {flag_low}."
                }
    return None


# -------------------------------------------------------------
# 7. FAIR VALUE GAP (FVG) / IMBALANCE MITIGATION
# -------------------------------------------------------------
# =====================================================================
# MODULAR SMC / ICT STRATEGIES (ISOLATED & CAN BE TOGGLED ON/OFF)
# If user wants to disable these 4 strategies anytime without affecting
# the 16 original classical chart patterns, set ENABLE_SMC_STRATEGIES = False.
# =====================================================================
ENABLE_SMC_STRATEGIES = True

def _check_trigger_volume(candles, min_vol_ratio=1.15):
    """
    Ensures the trigger/reaction candle (candles[-2]) has institutional volume expansion.
    Filters out false signals during low-volume sideways drift.
    """
    if len(candles) < 22:
        return True, 1.0
    trigger = candles[-2]
    lookback = 20
    vols = [c["v"] for c in candles[-lookback-2:-2]]
    avg_vol = sum(vols) / len(vols) if vols else 1.0
    if avg_vol <= 0:
        return True, 1.0
    ratio = trigger["v"] / avg_vol
    return ratio >= min_vol_ratio, ratio

def _is_decisive_candle(candle, min_body_ratio=0.35):
    """
    Ensures reaction candle has a real body and is not an indecisive doji.
    """
    rng = candle["h"] - candle["l"]
    if rng <= 0:
        return False
    body = abs(candle["c"] - candle["o"])
    return (body / rng) >= min_body_ratio

# -------------------------------------------------------------
# 7. FAIR VALUE GAP (FVG) / IMBALANCE MITIGATION (STRICT QUALITY)
# -------------------------------------------------------------
def check_fair_value_gap(candles):
    """
    Fair Value Gap (FVG) with strict quality & volume confirmation:
    - Imbalance gap size >= 0.35% (prevents micro-noise traps).
    - Recent formation (within last 14 candles, not stale).
    - Institutional Volume Surge >= 1.15x on confirmation candle.
    - Decisive rejection candle closing firmly in trade direction.
    """
    n = len(candles)
    if n < 22:
        return None
    last_closed = candles[-2]
    curr_c = last_closed["c"]

    has_vol, vol_ratio = _check_trigger_volume(candles, min_vol_ratio=1.15)
    if not has_vol:
        return None

    if not _is_decisive_candle(last_closed, min_body_ratio=0.35):
        return None

    # Bullish FVG
    for k in range(n - 4, max(3, n - 14), -1):
        c1, c2, c3 = candles[k-2], candles[k-1], candles[k]
        if c2["c"] > c2["o"] and c3["l"] > c1["h"]:
            gap_bottom = c1["h"]
            gap_top = c3["l"]
            gap_size = (gap_top - gap_bottom) / gap_bottom
            if gap_size >= 0.0035:  # High-quality gap >= 0.35%
                subsequent = candles[k+1:-2]
                if not any(c["c"] < gap_bottom for c in subsequent):
                    tapped = any(c["l"] <= gap_top for c in subsequent) or (last_closed["l"] <= gap_top)
                    if tapped:
                        if last_closed["c"] > last_closed["o"] and last_closed["c"] >= gap_bottom:
                            prev_c = candles[-3]
                            if last_closed["c"] > prev_c["c"]:
                                entry = curr_c
                                sl = round(gap_bottom * 0.997, 6)
                                risk = (entry - sl) / entry
                                if 0.003 <= risk <= 0.045:
                                    t1 = round(entry + (entry - sl) * 1.6, 6)
                                    t2 = round(entry + (entry - sl) * 2.8, 6)
                                    return {
                                        "pattern": "Fair Value Gap (FVG)",
                                        "category": "Smart Money Structure",
                                        "side": "LONG",
                                        "status": "CONFIRMED",
                                        "breakout_level": gap_top,
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "risk_pct": round(risk * 100, 2),
                                        "rr_1": "1:1.6",
                                        "rr_2": "1:2.8",
                                        "summary": f"Bullish FVG mitigation at {gap_bottom}-{gap_top} with 1.15x volume confirmation."
                                    }

    # Bearish FVG
    for k in range(n - 4, max(3, n - 14), -1):
        c1, c2, c3 = candles[k-2], candles[k-1], candles[k]
        if c2["c"] < c2["o"] and c3["h"] < c1["l"]:
            gap_top = c1["l"]
            gap_bottom = c3["h"]
            gap_size = (gap_top - gap_bottom) / gap_bottom
            if gap_size >= 0.0035:  # High-quality gap >= 0.35%
                subsequent = candles[k+1:-2]
                if not any(c["c"] > gap_top for c in subsequent):
                    tapped = any(c["h"] >= gap_bottom for c in subsequent) or (last_closed["h"] >= gap_bottom)
                    if tapped:
                        if last_closed["c"] < last_closed["o"] and last_closed["c"] <= gap_top:
                            prev_c = candles[-3]
                            if last_closed["c"] < prev_c["c"]:
                                entry = curr_c
                                sl = round(gap_top * 1.003, 6)
                                risk = (sl - entry) / entry
                                if 0.003 <= risk <= 0.045:
                                    t1 = round(entry - (sl - entry) * 1.6, 6)
                                    t2 = round(entry - (sl - entry) * 2.8, 6)
                                    return {
                                        "pattern": "Fair Value Gap (FVG)",
                                        "category": "Smart Money Structure",
                                        "side": "SHORT",
                                        "status": "CONFIRMED",
                                        "breakout_level": gap_bottom,
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "risk_pct": round(risk * 100, 2),
                                        "rr_1": "1:1.6",
                                        "rr_2": "1:2.8",
                                        "summary": f"Bearish FVG mitigation at {gap_bottom}-{gap_top} with 1.15x volume confirmation."
                                    }
    return None

# -------------------------------------------------------------
# 8. INSTITUTIONAL ORDER BLOCK (OB) + BOS RETEST (STRICT VOLUME)
# -------------------------------------------------------------
def check_order_block_bos(candles, highs, lows):
    """
    Institutional Order Block (OB) + BOS Retest with volume confirmation:
    - Impulsive break of swing high/low within recent 16 candles.
    - OB is the origin candle before the impulse.
    - Institutional Volume Surge >= 1.15x on rejection candle.
    - Decisive rejection holding the OB zone without breaking structure.
    """
    n = len(candles)
    if n < 30 or len(highs) < 2 or len(lows) < 2:
        return None
    last_closed = candles[-2]
    curr_c = last_closed["c"]

    has_vol, vol_ratio = _check_trigger_volume(candles, min_vol_ratio=1.15)
    if not has_vol:
        return None

    if not _is_decisive_candle(last_closed, min_body_ratio=0.35):
        return None

    # Bullish OB
    for h in reversed(highs[-4:]):
        h_idx, h_price = h["idx"], h["price"]
        if h_idx < n - 18:
            continue
        bos_c = [c for c in candles[h_idx+1:-3] if c["c"] > h_price]
        if bos_c:
            first_bos = bos_c[0]
            bos_idx = candles.index(first_bos)
            ob_candidates = [candles[j] for j in range(bos_idx, max(0, bos_idx - 5), -1) if candles[j]["c"] < candles[j]["o"]]
            if ob_candidates:
                ob = ob_candidates[0]
                ob_top = ob["h"]
                ob_bottom = ob["l"]
                retest_candles = candles[bos_idx:-2]
                if any(c["l"] <= ob_top for c in retest_candles) and not any(c["c"] < ob_bottom for c in retest_candles):
                    if last_closed["c"] > last_closed["o"] and last_closed["c"] >= ob_bottom:
                        entry = curr_c
                        sl = round(ob_bottom * 0.997, 6)
                        risk = (entry - sl) / entry
                        if 0.003 <= risk <= 0.045:
                            t1 = round(entry + (entry - sl) * 1.6, 6)
                            t2 = round(entry + (entry - sl) * 2.8, 6)
                            return {
                                "pattern": "Institutional Order Block (OB)",
                                "category": "Smart Money Structure",
                                "side": "LONG",
                                "status": "CONFIRMED",
                                "breakout_level": ob_top,
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": t1,
                                "target_2": t2,
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Bullish Order Block retest at {ob_bottom}-{ob_top} with 1.15x volume surge."
                            }

    # Bearish OB
    for l in reversed(lows[-4:]):
        l_idx, l_price = l["idx"], l["price"]
        if l_idx < n - 18:
            continue
        bos_c = [c for c in candles[l_idx+1:-3] if c["c"] < l_price]
        if bos_c:
            first_bos = bos_c[0]
            bos_idx = candles.index(first_bos)
            ob_candidates = [candles[j] for j in range(bos_idx, max(0, bos_idx - 5), -1) if candles[j]["c"] > candles[j]["o"]]
            if ob_candidates:
                ob = ob_candidates[0]
                ob_top = ob["h"]
                ob_bottom = ob["l"]
                retest_candles = candles[bos_idx:-2]
                if any(c["h"] >= ob_bottom for c in retest_candles) and not any(c["c"] > ob_top for c in retest_candles):
                    if last_closed["c"] < last_closed["o"] and last_closed["c"] <= ob_top:
                        entry = curr_c
                        sl = round(ob_top * 1.003, 6)
                        risk = (sl - entry) / entry
                        if 0.003 <= risk <= 0.045:
                            t1 = round(entry - (sl - entry) * 1.6, 6)
                            t2 = round(entry - (sl - entry) * 2.8, 6)
                            return {
                                "pattern": "Institutional Order Block (OB)",
                                "category": "Smart Money Structure",
                                "side": "SHORT",
                                "status": "CONFIRMED",
                                "breakout_level": ob_bottom,
                                "entry": entry,
                                "stop_loss": sl,
                                "target_1": t1,
                                "target_2": t2,
                                "risk_pct": round(risk * 100, 2),
                                "rr_1": "1:1.6",
                                "rr_2": "1:2.8",
                                "summary": f"Bearish Order Block retest at {ob_bottom}-{ob_top} with 1.15x volume surge."
                            }
    return None

# -------------------------------------------------------------
# 9. ASIAN RANGE / SESSION LIQUIDITY RAID (JUDAS SWING)
# -------------------------------------------------------------
def check_session_liquidity_raid(candles):
    """
    Asian Range / Session Liquidity Raid (Judas Swing) with volume confirmation:
    - Base consolidation range established over 20-30 candles.
    - Sweep of range high/low followed by firm rejection candle back inside range.
    - Institutional Volume Surge >= 1.15x on confirmation candle.
    """
    n = len(candles)
    if n < 35:
        return None
    last_closed = candles[-2]
    curr_c = last_closed["c"]

    has_vol, vol_ratio = _check_trigger_volume(candles, min_vol_ratio=1.15)
    if not has_vol:
        return None

    if not _is_decisive_candle(last_closed, min_body_ratio=0.35):
        return None

    base_window = candles[-32:-7]
    range_high = max(c["h"] for c in base_window)
    range_low = min(c["l"] for c in base_window)
    range_pct = (range_high - range_low) / range_low

    if not (0.008 <= range_pct <= 0.04):
        return None

    recent_window = candles[-7:-2]

    # Bearish Judas Swing
    sweeps_high = [c for c in recent_window if c["h"] > range_high]
    if sweeps_high:
        highest_sweep = max(sweeps_high, key=lambda x: x["h"])
        if last_closed["c"] < last_closed["o"] and last_closed["c"] < range_high:
            entry = curr_c
            sl = round(highest_sweep["h"] * 1.002, 6)
            risk = (sl - entry) / entry
            if 0.003 <= risk <= 0.045:
                t1 = round(range_low, 6)
                t2 = round(range_low - (range_high - range_low) * 0.5, 6)
                return {
                    "pattern": "Asian Range Sweep (Judas Swing)",
                    "category": "Smart Money Structure",
                    "side": "SHORT",
                    "status": "CONFIRMED",
                    "breakout_level": range_high,
                    "sweep_level": highest_sweep["h"],
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": t1,
                    "target_2": t2,
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.6",
                    "rr_2": "1:2.8",
                    "summary": f"Asian Range High sweep fakeout at {highest_sweep['h']} with 1.15x volume surge."
                }

    # Bullish Judas Swing
    sweeps_low = [c for c in recent_window if c["l"] < range_low]
    if sweeps_low:
        lowest_sweep = min(sweeps_low, key=lambda x: x["l"])
        if last_closed["c"] > last_closed["o"] and last_closed["c"] > range_low:
            entry = curr_c
            sl = round(lowest_sweep["l"] * 0.998, 6)
            risk = (entry - sl) / entry
            if 0.003 <= risk <= 0.045:
                t1 = round(range_high, 6)
                t2 = round(range_high + (range_high - range_low) * 0.5, 6)
                return {
                    "pattern": "Asian Range Sweep (Judas Swing)",
                    "category": "Smart Money Structure",
                    "side": "LONG",
                    "status": "CONFIRMED",
                    "breakout_level": range_low,
                    "sweep_level": lowest_sweep["l"],
                    "entry": entry,
                    "stop_loss": sl,
                    "target_1": t1,
                    "target_2": t2,
                    "risk_pct": round(risk * 100, 2),
                    "rr_1": "1:1.6",
                    "rr_2": "1:2.8",
                    "summary": f"Asian Range Low sweep fakeout at {lowest_sweep['l']} with 1.15x volume surge."
                }
    return None

# -------------------------------------------------------------
# 10. QUASIMODO (QM) / OVER-UNDER REVERSAL PATTERN (STRICT VOLUME)
# -------------------------------------------------------------
def check_quasimodo(candles, highs, lows):
    """
    Quasimodo (QM) / Over-Under Advanced Reversal with volume confirmation:
    - Retest of Left Shoulder level after Liquidity Sweep / BOS.
    - Institutional Volume Surge >= 1.15x on rejection candle.
    - Rejection candle with decisive body.
    """
    n = len(candles)
    if n < 35 or len(highs) < 2 or len(lows) < 2:
        return None
    last_closed = candles[-2]
    curr_c = last_closed["c"]

    has_vol, vol_ratio = _check_trigger_volume(candles, min_vol_ratio=1.15)
    if not has_vol:
        return None

    if not _is_decisive_candle(last_closed, min_body_ratio=0.35):
        return None

    # Bearish QM
    for i in range(len(highs) - 1, 0, -1):
        h2 = highs[i]
        for h1 in reversed(highs[:i]):
            if h2["price"] > h1["price"] * 1.002 and h2["idx"] > h1["idx"]:
                l1_candidates = [l for l in lows if h1["idx"] < l["idx"] < h2["idx"]]
                if l1_candidates:
                    l1 = min(l1_candidates, key=lambda x: x["price"])
                    l2_candidates = [l for l in lows if l["idx"] > h2["idx"] and l["price"] < l1["price"]]
                    if l2_candidates:
                        l2 = min(l2_candidates, key=lambda x: x["price"])
                        # Retest back up to H1 level (within 0.5%)
                        if last_closed["h"] >= h1["price"] * 0.995 and last_closed["c"] <= h1["price"] * 1.005:
                            if last_closed["c"] < last_closed["o"]:
                                entry = curr_c
                                sl = round(h2["price"] * 1.002, 6)
                                risk = (sl - entry) / entry
                                if 0.003 <= risk <= 0.045:
                                    t1 = round(l1["price"], 6)
                                    t2 = round(l2["price"], 6)
                                    return {
                                        "pattern": "Quasimodo Reversal (QM)",
                                        "category": "Reversal Pattern",
                                        "side": "SHORT",
                                        "status": "CONFIRMED",
                                        "breakout_level": h1["price"],
                                        "head_level": h2["price"],
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "risk_pct": round(risk * 100, 2),
                                        "rr_1": "1:1.6",
                                        "rr_2": "1:2.8",
                                        "summary": f"Bearish Quasimodo (Over-Under) rejection at Left Shoulder {h1['price']} with 1.15x volume."
                                    }

    # Bullish QM
    for i in range(len(lows) - 1, 0, -1):
        l2 = lows[i]
        for l1 in reversed(lows[:i]):
            if l2["price"] < l1["price"] * 0.998 and l2["idx"] > l1["idx"]:
                h1_candidates = [h for h in highs if l1["idx"] < h["idx"] < l2["idx"]]
                if h1_candidates:
                    h1 = max(h1_candidates, key=lambda x: x["price"])
                    h2_candidates = [h for h in highs if h["idx"] > l2["idx"] and h["price"] > h1["price"]]
                    if h2_candidates:
                        h2 = max(h2_candidates, key=lambda x: x["price"])
                        if last_closed["l"] <= l1["price"] * 1.005 and last_closed["c"] >= l1["price"] * 0.995:
                            if last_closed["c"] > last_closed["o"]:
                                entry = curr_c
                                sl = round(l2["price"] * 0.998, 6)
                                risk = (entry - sl) / entry
                                if 0.003 <= risk <= 0.045:
                                    t1 = round(h1["price"], 6)
                                    t2 = round(h2["price"], 6)
                                    return {
                                        "pattern": "Quasimodo Reversal (QM)",
                                        "category": "Reversal Pattern",
                                        "side": "LONG",
                                        "status": "CONFIRMED",
                                        "breakout_level": l1["price"],
                                        "head_level": l2["price"],
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "risk_pct": round(risk * 100, 2),
                                        "rr_1": "1:1.6",
                                        "rr_2": "1:2.8",
                                        "summary": f"Bullish Quasimodo rejection at Left Shoulder {l1['price']} with 1.15x volume."
                                    }
    return None

def analyze_symbol_accuracy(symbol, klines_fetcher, interval="15m"):
    """
    Evaluates all image-based patterns for a symbol.
    Strictly verifies closed candle confirmation.
    Original 16 patterns execute first.
    Optional SMC strategies execute only if ENABLE_SMC_STRATEGIES is True.
    """
    try:
        raw = klines_fetcher(symbol, interval, limit=100)
        if not raw or len(raw) < 35:
            return None
        # Discard stale or delisted pairs (last candle older than 2 hours)
        last_kline_time = raw[-1][0] / 1000.0
        if time.time() - last_kline_time > 7200:
            return None
        candles = []
        for c in raw:
            candles.append({
                "t": c[0],
                "o": float(c[1]),
                "h": float(c[2]),
                "l": float(c[3]),
                "c": float(c[4]),
                "v": float(c[5])
            })

        highs, lows = calculate_swings(candles, left=2, right=2)
        vol_ratio, avg_vol = get_volume_profile(candles, lookback=20)

        # 1. Classical Chart Patterns & Sweeps (Always Active)
        detectors = [
            lambda: check_liquidity_sweep_mss(candles, highs, lows),
            lambda: check_head_and_shoulders(candles, highs, lows),
            lambda: check_double_triple_top_bottom(candles, highs, lows),
            lambda: check_triangles_and_wedges(candles, highs, lows),
            lambda: check_box_range_breakout(candles),
            lambda: check_flag_pennant(candles),
        ]

        # 2. Modular SMC Strategies (Can be turned off independently)
        if ENABLE_SMC_STRATEGIES:
            detectors.extend([
                lambda: check_fair_value_gap(candles),
                lambda: check_order_block_bos(candles, highs, lows),
                lambda: check_session_liquidity_raid(candles),
                lambda: check_quasimodo(candles, highs, lows)
            ])

        for det in detectors:
            result = det()
            if result:
                result["symbol"] = symbol
                result["interval"] = interval
                result["volume_surge"] = vol_ratio
                result["current_price"] = candles[-1]["c"]
                result["candle_close_time"] = candles[-2]["t"]
                result["scanned_at"] = int(time.time())
                return result
        return None
    except Exception as e:
        return None
