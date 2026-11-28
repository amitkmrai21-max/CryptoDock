"""
Trader Strategies Confluence Engine for CryptoDock (Owner Only)
Specifically implements the trading frameworks of:
1. Gautam Jha (Stock Learners):
   - Previous Day High/Low (PDH / PDL) & Previous Week High/Low (PWH / PWL) Liquidity Traps
   - Equal Highs / Equal Lows (EQH / EQL) Stop-Hunt Reversals
   - Panic Point Theory (PPT) Trend Continuation Pullback Traps
   - Strict Avoid Rules:
     * "Other party SL hit" filter (Opposing extreme not pre-broken)
     * "Ek kadam peeche" operator candle confirmation (No blind anticipatory entry)
     * Giant falling knife / unstopped marubozu rejection
     * Minimum 1:1.4+ Risk-to-Reward ratio
2. Booming Bulls (Anish Singh Thakur):
   - VWAP + EMA 20/50 Trend Filter
   - Golden Fibonacci Retracement (0.5 - 0.618 Zone Pullback)
   - Stochastic RSI (14,14,3,3) Momentum Confluence & Candlestick Rejection
   - Minimum 1:1.3 to 1:2.8 Risk-to-Reward Ratio
"""

import math
import time


def format_price(val):
    if val is None:
        return "--"
    try:
        val = float(val)
    except (ValueError, TypeError):
        return str(val)
    if val >= 1000:
        return f"{val:,.2f}"
    elif val >= 1:
        return f"{val:,.4f}"
    elif val >= 0.01:
        return f"{val:,.5f}"
    elif val >= 0.0001:
        return f"{val:,.6f}"
    else:
        return f"{val:,.8f}"


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

def calculate_ema(prices, period):
    if len(prices) < period:
        return [prices[-1]] * len(prices) if prices else []
    k = 2.0 / (period + 1)
    ema = [sum(prices[:period]) / period]
    for p in prices[period:]:
        ema.append(p * k + ema[-1] * (1 - k))
    return [prices[0]] * (period - 1) + ema

def calculate_vwap(candles):
    cum_vol = 0.0
    cum_pv = 0.0
    vwap_series = []
    last_day_ts = None
    for c in candles:
        day_ts = c["t"] // 86400000
        if last_day_ts is None or day_ts != last_day_ts:
            cum_vol = 0.0
            cum_pv = 0.0
            last_day_ts = day_ts
        typical = (c["h"] + c["l"] + c["c"]) / 3.0
        v = c["v"]
        cum_vol += v
        cum_pv += typical * v
        vwap = cum_pv / cum_vol if cum_vol > 0 else typical
        vwap_series.append(vwap)
    return vwap_series

def calculate_stoch_rsi(closes, rsi_period=14, stoch_period=14, k_period=3, d_period=3):
    n = len(closes)
    if n < rsi_period + stoch_period + 5:
        return [50.0] * n, [50.0] * n
    gains, losses = [], []
    for i in range(1, n):
        diff = closes[i] - closes[i-1]
        gains.append(max(0.0, diff))
        losses.append(max(0.0, -diff))
    
    avg_gain = sum(gains[:rsi_period]) / rsi_period
    avg_loss = sum(losses[:rsi_period]) / rsi_period
    rsi = [50.0] * rsi_period
    for i in range(rsi_period, len(gains)):
        avg_gain = (avg_gain * (rsi_period - 1) + gains[i]) / rsi_period
        avg_loss = (avg_loss * (rsi_period - 1) + losses[i]) / rsi_period
        rs = avg_gain / avg_loss if avg_loss != 0 else 100.0
        rsi.append(100.0 - (100.0 / (1.0 + rs)))
    rsi = [50.0] + rsi
    
    stoch = [50.0] * n
    for i in range(stoch_period - 1, n):
        window = rsi[max(0, i - stoch_period + 1) : i + 1]
        min_r = min(window)
        max_r = max(window)
        if max_r - min_r > 0.0001:
            stoch[i] = ((rsi[i] - min_r) / (max_r - min_r)) * 100.0
        else:
            stoch[i] = 50.0
    
    k = [50.0] * n
    for i in range(k_period - 1, n):
        k[i] = sum(stoch[max(0, i - k_period + 1) : i + 1]) / k_period
    d = [50.0] * n
    for i in range(d_period - 1, n):
        d[i] = sum(k[max(0, i - d_period + 1) : i + 1]) / d_period
    return k, d

def get_volume_surge(candles, lookback=20):
    n = len(candles)
    if n < 5:
        return 1.0
    vols = [c["v"] for c in candles[-lookback-2:-2]] if n >= lookback + 2 else [c["v"] for c in candles[:-2]]
    avg_vol = sum(vols) / len(vols) if vols else 1.0
    latest_vol = candles[-2]["v"]
    return round(latest_vol / avg_vol, 2) if avg_vol > 0 else 1.0

def detect_equal_levels(candles, lookback=45, tolerance=0.0035):
    """
    Detect Equal Highs (EQH) and Equal Lows (EQL) liquidity pools.
    Retail traders place double-top/bottom stop losses just outside these boundaries.
    """
    highs, lows = calculate_swings(candles[-lookback:-2], left=2, right=2)
    eq_high = None
    eq_low = None
    
    if len(highs) >= 2:
        for i in range(len(highs) - 1):
            for j in range(i + 1, len(highs)):
                h1, h2 = highs[i]["price"], highs[j]["price"]
                diff = abs(h1 - h2) / ((h1 + h2) / 2.0)
                if diff <= tolerance and (highs[j]["idx"] - highs[i]["idx"]) >= 4:
                    eq_high = max(h1, h2)
                    break
            if eq_high:
                break
                
    if len(lows) >= 2:
        for i in range(len(lows) - 1):
            for j in range(i + 1, len(lows)):
                l1, l2 = lows[i]["price"], lows[j]["price"]
                diff = abs(l1 - l2) / ((l1 + l2) / 2.0)
                if diff <= tolerance and (lows[j]["idx"] - lows[i]["idx"]) >= 4:
                    eq_low = min(l1, l2)
                    break
            if eq_low:
                break
                
    return eq_high, eq_low


def check_gautam_jha_traps(candles, daily_candles):
    """
    Complete Gautam Jha Liquidity Trap Framework (Stock Learners):
    1. Previous Day High/Low (PDH/PDL) & Previous Week High/Low (PWH/PWL) Traps
    2. Panic Point Theory (PPT) Trend Continuation Pullback Setup
       - Requires strong prior trend (EMA20/50 alignment)
       - Retracement into Panic Point (prior swing low in uptrend / swing high in downtrend)
       - Strict Avoid Filter: Other Party SL must NOT be hit (opposing extreme not pre-broken)
       - Operator Confirmation: Closed rejection / green/red candle ("Ek kadam peeche")
    3. Equal Highs / Equal Lows (EQH / EQL) Stop-Hunt Traps
    4. Strict Avoid Rules:
       - Falling Knife / Unstopped giant marubozu
       - Premature entry (waits for closed operator confirmation candle)
       - Minimum 1:1.4+ Risk-to-Reward ratio
    """
    if len(candles) < 30:
        return None
    
    c2 = candles[-2] # Confirmed closed candle
    curr_px = c2["c"]
    vol_surge = get_volume_surge(candles, lookback=20)
    
    candle_rng = c2["h"] - c2["l"]
    upper_wick = c2["h"] - max(c2["o"], c2["c"])
    lower_wick = min(c2["o"], c2["c"]) - c2["l"]
    body = abs(c2["c"] - c2["o"])
    is_green = c2["c"] > c2["o"]
    is_red = c2["c"] < c2["o"]
    
    # Avoid rule: Giant unstopped Marubozu without opposite wick (falling knife)
    is_giant_knife = (candle_rng > 0 and body / candle_rng >= 0.85 and vol_surge >= 2.0)

    # -------------------------------------------------------------
    # 1. HTF Daily & Weekly Liquidity Traps (PDH/PDL & PWH/PWL)
    # -------------------------------------------------------------
    if daily_candles and len(daily_candles) >= 2:
        pd_candle = daily_candles[-2]
        pdh = float(pd_candle[2])
        pdl = float(pd_candle[3])
        
        # 7-day lookback for Previous Week High/Low (PWH / PWL)
        pwh, pwl = None, None
        if len(daily_candles) >= 8:
            week_candles = daily_candles[-8:-1]
            pwh = max(float(c[2]) for c in week_candles)
            pwl = min(float(c[3]) for c in week_candles)

        recent_window = candles[-7:-1]
        max_sweep = max(c["h"] for c in recent_window)
        min_sweep = min(c["l"] for c in recent_window)
        
        # Check PWH Sweep (Major Weekly Institutional Trap)
        if pwh and max_sweep > pwh and c2["c"] < pwh:
            has_bear_rejection = is_red or (candle_rng > 0 and upper_wick >= 0.25 * candle_rng)
            if has_bear_rejection and not (is_giant_knife and is_green):
                entry = c2["c"]
                sl = round(max_sweep * 1.002, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry - risk * 1.8, 6)
                    t2 = round(max(pdl, entry - risk * 3.0), 6)
                    rr1 = round(abs(entry - t1) / risk, 1)
                    if rr1 >= 1.4:
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "PWH Major Liquidity Trap (Weekly Reversal)",
                            "category": "HTF Trap",
                            "side": "SHORT",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": f"1:{rr1}",
                            "rr_2": "1:3.0",
                            "level_swept": f"PWH: ${format_price(pwh)}",
                            "summary": f"Gautam Jha Setup: Swept Previous Week High (${format_price(pwh)}) institutional liquidity. Breakout buyers trapped, decisive closed rejection back inside."
                        }

        # Check PWL Sweep (Major Weekly Bull Trap)
        if pwl and min_sweep < pwl and c2["c"] > pwl:
            has_bull_rejection = is_green or (candle_rng > 0 and lower_wick >= 0.25 * candle_rng)
            if has_bull_rejection and not (is_giant_knife and is_red):
                entry = c2["c"]
                sl = round(min_sweep * 0.998, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry + risk * 1.8, 6)
                    t2 = round(min(pdh, entry + risk * 3.0), 6)
                    rr1 = round(abs(t1 - entry) / risk, 1)
                    if rr1 >= 1.4:
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "PWL Major Liquidity Trap (Weekly Reversal)",
                            "category": "HTF Trap",
                            "side": "LONG",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": f"1:{rr1}",
                            "rr_2": "1:3.0",
                            "level_swept": f"PWL: ${format_price(pwl)}",
                            "summary": f"Gautam Jha Setup: Swept Previous Week Low (${format_price(pwl)}) institutional liquidity. Breakdown sellers trapped, decisive closed rejection back inside."
                        }

        # Check Bearish Trap (Fakeout above PDH)
        if max_sweep > pdh and c2["c"] < pdh:
            has_bear_rejection = is_red or (candle_rng > 0 and upper_wick >= 0.25 * candle_rng)
            if has_bear_rejection and not (is_giant_knife and is_green):
                entry = c2["c"]
                sl = round(max_sweep * 1.002, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry - risk * 1.8, 6)
                    t2 = round(max(pdl, entry - risk * 2.8), 6)
                    rr1 = round(abs(entry - t1) / risk, 1)
                    if rr1 >= 1.4:
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "PDH Liquidity Trap (Fakeout Short)",
                            "category": "Liquidity Trap",
                            "side": "SHORT",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": f"1:{rr1}",
                            "rr_2": "1:2.8",
                            "level_swept": f"PDH: ${format_price(pdh)}",
                            "summary": f"Gautam Jha Setup: Pierced above Previous Day High (${format_price(pdh)}), trapped breakout buyers, closed back inside with operator rejection ('Ek kadam peeche')."
                        }
        
        # Check Bullish Trap (Fake breakdown below PDL)
        if min_sweep < pdl and c2["c"] > pdl:
            has_bull_rejection = is_green or (candle_rng > 0 and lower_wick >= 0.25 * candle_rng)
            if has_bull_rejection and not (is_giant_knife and is_red):
                entry = c2["c"]
                sl = round(min_sweep * 0.998, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry + risk * 1.8, 6)
                    t2 = round(min(pdh, entry + risk * 2.8), 6)
                    rr1 = round(abs(t1 - entry) / risk, 1)
                    if rr1 >= 1.4:
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "PDL Liquidity Trap (Fakeout Long)",
                            "category": "Liquidity Trap",
                            "side": "LONG",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": f"1:{rr1}",
                            "rr_2": "1:2.8",
                            "level_swept": f"PDL: ${format_price(pdl)}",
                            "summary": f"Gautam Jha Setup: Pierced below Previous Day Low (${format_price(pdl)}), trapped breakdown sellers, closed back inside with operator rejection ('Ek kadam peeche')."
                        }

    # -------------------------------------------------------------
    # 2. Equal Highs (EQH) / Equal Lows (EQL) Stop Hunt Traps
    # -------------------------------------------------------------
    eq_high, eq_low = detect_equal_levels(candles, lookback=45, tolerance=0.0035)
    
    if eq_high:
        recent_sweep = max(c["h"] for c in candles[-6:-1])
        if recent_sweep > eq_high and c2["c"] < eq_high:
            has_bear_rejection = is_red or (candle_rng > 0 and upper_wick >= 0.30 * candle_rng)
            if has_bear_rejection and not (is_giant_knife and is_green):
                entry = c2["c"]
                sl = round(recent_sweep * 1.002, 6)
                risk = abs(entry - sl)
                if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                    t1 = round(entry - risk * 1.8, 6)
                    t2 = round(entry - risk * 2.8, 6)
                    return {
                        "strategy": "Gautam Jha",
                        "setup_name": "Equal Highs (EQH) Stop Hunt Trap",
                        "category": "Liquidity Trap",
                        "side": "SHORT",
                        "status": "CONFIRMED",
                        "entry": entry,
                        "stop_loss": sl,
                        "target_1": t1,
                        "target_2": t2,
                        "rr_1": "1:1.8",
                        "rr_2": "1:2.8",
                        "level_swept": f"EQH Pool: ${format_price(eq_high)}",
                        "summary": f"Gautam Jha Setup: Retail double top liquidity swept at ${format_price(eq_high)}. Stop hunt triggered and followed by closed rejection back inside range."
                    }

    if eq_low:
        recent_sweep = min(c["l"] for c in candles[-6:-1])
        if recent_sweep < eq_low and c2["c"] > eq_low:
            has_bull_rejection = is_green or (candle_rng > 0 and lower_wick >= 0.30 * candle_rng)
            if has_bull_rejection and not (is_giant_knife and is_red):
                entry = c2["c"]
                sl = round(recent_sweep * 0.998, 6)
                risk = abs(entry - sl)
                if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                    t1 = round(entry + risk * 1.8, 6)
                    t2 = round(entry + risk * 2.8, 6)
                    return {
                        "strategy": "Gautam Jha",
                        "setup_name": "Equal Lows (EQL) Stop Hunt Trap",
                        "category": "Liquidity Trap",
                        "side": "LONG",
                        "status": "CONFIRMED",
                        "entry": entry,
                        "stop_loss": sl,
                        "target_1": t1,
                        "target_2": t2,
                        "rr_1": "1:1.8",
                        "rr_2": "1:2.8",
                        "level_swept": f"EQL Pool: ${format_price(eq_low)}",
                        "summary": f"Gautam Jha Setup: Retail double bottom liquidity swept at ${format_price(eq_low)}. Stop hunt triggered and followed by closed rejection back inside range."
                    }

    # -------------------------------------------------------------
    # 3. Panic Point Theory (PPT) Trend Continuation Pullback Setup
    # -------------------------------------------------------------
    closes = [c["c"] for c in candles]
    ema20 = calculate_ema(closes, 20)
    ema50 = calculate_ema(closes, 50)
    highs, lows = calculate_swings(candles[:-2], left=3, right=3)
    
    # BULLISH PPT (Uptrend Continuation)
    if ema20[-2] >= ema50[-2] * 0.996 and len(lows) >= 2 and len(highs) >= 1:
        panic_point = lows[-1]["price"]
        panic_idx = lows[-1]["idx"]
        last_high = highs[-1]["price"]
        last_high_idx = highs[-1]["idx"]
        
        if panic_idx < len(candles) - 3:
            # Check AVOID RULE: "Other party SL not hit"
            approach_candles = candles[last_high_idx + 1 : -2]
            opposing_sl_hit = any(c["h"] > last_high for c in approach_candles) if approach_candles else False
            
            if not opposing_sl_hit:
                recent_sweep = min(c["l"] for c in candles[-5:-1])
                if recent_sweep < panic_point and c2["c"] > panic_point:
                    has_operator_green = is_green or (candle_rng > 0 and lower_wick >= 0.30 * candle_rng)
                    if has_operator_green and not is_giant_knife:
                        entry = c2["c"]
                        sl = round(recent_sweep * 0.998, 6)
                        risk = abs(entry - sl)
                        if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                            t1 = round(last_high, 6)
                            rr1 = round(abs(t1 - entry) / risk, 1) if risk > 0 else 0
                            if rr1 >= 1.4:
                                t2 = round(last_high + (last_high - panic_point) * 0.618, 6)
                                return {
                                    "strategy": "Gautam Jha",
                                    "setup_name": "Panic Point Pullback Trap (PPT Long)",
                                    "category": "Panic Point Theory",
                                    "side": "LONG",
                                    "status": "CONFIRMED",
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": t1,
                                    "target_2": t2,
                                    "rr_1": f"1:{rr1}",
                                    "rr_2": "1:2.8",
                                    "level_swept": f"Panic Point: ${format_price(panic_point)}",
                                    "summary": f"Gautam Jha PPT: Uptrend retraced into Panic Point (${format_price(panic_point)}). Retail stops flushed, opposite high intact ('Other SL not hit'), operator green candle closed above level."
                                }

    # BEARISH PPT (Downtrend Continuation)
    if ema20[-2] <= ema50[-2] * 1.004 and len(highs) >= 2 and len(lows) >= 1:
        panic_point = highs[-1]["price"]
        panic_idx = highs[-1]["idx"]
        last_low = lows[-1]["price"]
        last_low_idx = lows[-1]["idx"]
        
        if panic_idx < len(candles) - 3:
            # Check AVOID RULE: "Other party SL not hit"
            approach_candles = candles[last_low_idx + 1 : -2]
            opposing_sl_hit = any(c["l"] < last_low for c in approach_candles) if approach_candles else False
            
            if not opposing_sl_hit:
                recent_sweep = max(c["h"] for c in candles[-5:-1])
                if recent_sweep > panic_point and c2["c"] < panic_point:
                    has_operator_red = is_red or (candle_rng > 0 and upper_wick >= 0.30 * candle_rng)
                    if has_operator_red and not is_giant_knife:
                        entry = c2["c"]
                        sl = round(recent_sweep * 1.002, 6)
                        risk = abs(entry - sl)
                        if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                            t1 = round(last_low, 6)
                            rr1 = round(abs(entry - t1) / risk, 1) if risk > 0 else 0
                            if rr1 >= 1.4:
                                t2 = round(last_low - (panic_point - last_low) * 0.618, 6)
                                return {
                                    "strategy": "Gautam Jha",
                                    "setup_name": "Panic Point Pullback Trap (PPT Short)",
                                    "category": "Panic Point Theory",
                                    "side": "SHORT",
                                    "status": "CONFIRMED",
                                    "entry": entry,
                                    "stop_loss": sl,
                                    "target_1": t1,
                                    "target_2": t2,
                                    "rr_1": f"1:{rr1}",
                                    "rr_2": "1:2.8",
                                    "level_swept": f"Panic Point: ${format_price(panic_point)}",
                                    "summary": f"Gautam Jha PPT: Downtrend rallied into Panic Point (${format_price(panic_point)}). Retail breakout buyers trapped, opposite low intact ('Other SL not hit'), operator red candle closed below level."
                                }

    # -------------------------------------------------------------
    # 4. Key Swing Liquidity Trap (20-candle fractal high/low sweep)
    # -------------------------------------------------------------
    if highs:
        last_swing_h = highs[-1]["price"]
        recent_sweep = max(c["h"] for c in candles[-5:-1])
        if recent_sweep > last_swing_h and c2["c"] < last_swing_h:
            if is_red or (candle_rng > 0 and upper_wick >= 0.35 * candle_rng):
                if not (is_giant_knife and is_green):
                    entry = c2["c"]
                    sl = round(recent_sweep * 1.002, 6)
                    risk = abs(entry - sl)
                    if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                        t1 = round(entry - risk * 1.7, 6)
                        t2 = round(entry - risk * 2.6, 6)
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "Swing High Trap (False Breakout Short)",
                            "category": "Liquidity Trap",
                            "side": "SHORT",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": "1:1.7",
                            "rr_2": "1:2.6",
                            "level_swept": f"Swing High: ${format_price(last_swing_h)}",
                            "summary": f"Gautam Jha Setup: Liquidity sweep above major swing high (${format_price(last_swing_h)}) with false breakout trap and candle close back below resistance."
                        }

    if lows:
        last_swing_l = lows[-1]["price"]
        recent_sweep = min(c["l"] for c in candles[-5:-1])
        if recent_sweep < last_swing_l and c2["c"] > last_swing_l:
            if is_green or (candle_rng > 0 and lower_wick >= 0.35 * candle_rng):
                if not (is_giant_knife and is_red):
                    entry = c2["c"]
                    sl = round(recent_sweep * 0.998, 6)
                    risk = abs(entry - sl)
                    if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                        t1 = round(entry + risk * 1.7, 6)
                        t2 = round(entry + risk * 2.6, 6)
                        return {
                            "strategy": "Gautam Jha",
                            "setup_name": "Swing Low Trap (False Breakdown Long)",
                            "category": "Liquidity Trap",
                            "side": "LONG",
                            "status": "CONFIRMED",
                            "entry": entry,
                            "stop_loss": sl,
                            "target_1": t1,
                            "target_2": t2,
                            "rr_1": "1:1.7",
                            "rr_2": "1:2.6",
                            "level_swept": f"Swing Low: ${format_price(last_swing_l)}",
                            "summary": f"Gautam Jha Setup: Liquidity sweep below major swing low (${format_price(last_swing_l)}) with false breakdown trap and candle close back above support."
                        }
    return None


def check_booming_bulls_setups(candles):
    """
    Booming Bulls (Anish Singh Thakur) Confluence Framework:
    - Trend Alignment: VWAP + EMA 20/50
    - Golden Fibonacci Retracement: Pullback into 50% - 61.8% zone
    - Stochastic RSI Momentum turn
    - Clean Candlestick Rejection Confirmation
    """
    if len(candles) < 35:
        return None
    
    closes = [c["c"] for c in candles]
    vwap = calculate_vwap(candles)
    ema20 = calculate_ema(closes, 20)
    ema50 = calculate_ema(closes, 50)
    stoch_k, stoch_d = calculate_stoch_rsi(closes)
    
    c2 = candles[-2]
    curr_px = c2["c"]
    curr_vwap = vwap[-2]
    curr_ema20 = ema20[-2]
    curr_ema50 = ema50[-2]
    curr_k = stoch_k[-2]
    curr_d = stoch_d[-2]
    prev_k = stoch_k[-3]
    prev_d = stoch_d[-3]
    
    # 1. Bullish Trend Continuation
    if curr_px >= curr_vwap * 0.997 and curr_ema20 >= curr_ema50 * 0.997:
        window = candles[-30:-2]
        if len(window) >= 10:
            low_pt = min(window, key=lambda x: x["l"])
            high_pt = max(window, key=lambda x: x["h"])
            
            if low_pt["t"] < high_pt["t"]:
                impulse = high_pt["h"] - low_pt["l"]
                if impulse > 0 and (impulse / low_pt["l"]) >= 0.010:
                    fib_50 = high_pt["h"] - impulse * 0.50
                    fib_618 = high_pt["h"] - impulse * 0.618
                    fib_786 = high_pt["h"] - impulse * 0.786
                    
                    recent_low = min(c["l"] for c in candles[-6:-1])
                    in_golden_zone = (recent_low <= fib_50 * 1.004 and c2["c"] >= fib_618 * 0.996)
                    near_vwap = abs(c2["l"] - curr_vwap) / curr_vwap <= 0.008 or (c2["l"] <= curr_vwap and c2["c"] >= curr_vwap)
                    
                    if in_golden_zone or near_vwap:
                        is_bull = c2["c"] > c2["o"]
                        lower_wick = min(c2["o"], c2["c"]) - c2["l"]
                        rng = c2["h"] - c2["l"]
                        has_rejection = is_bull or (rng > 0 and lower_wick >= 0.30 * rng)
                        stoch_ok = curr_k > curr_d or curr_k <= 45 or (prev_k <= prev_d and curr_k > curr_d)
                        
                        if has_rejection and stoch_ok:
                            entry = curr_px
                            sl = round(min(recent_low, fib_786) * 0.997, 6)
                            risk = abs(entry - sl)
                            if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                                t1 = round(high_pt["h"], 6)
                                t2 = round(high_pt["h"] + impulse * 0.272, 6)
                                rr1 = round(abs(t1 - entry) / risk, 1)
                                if rr1 >= 1.3:
                                    return {
                                        "strategy": "Booming Bulls",
                                        "setup_name": "VWAP & Golden Fib Pullback (Bullish)",
                                        "category": "Trend Continuation",
                                        "side": "LONG",
                                        "status": "CONFIRMED",
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "rr_1": f"1:{rr1}",
                                        "rr_2": "1:2.6",
                                        "level_swept": f"VWAP: ${format_price(curr_vwap)} · Fib 50-61.8%",
                                        "summary": f"Booming Bulls Setup: Uptrend above VWAP (${format_price(curr_vwap)}). Tested 50%-61.8% Golden Fib retracement with bullish candlestick rejection & Stoch RSI momentum."
                                    }

    # 2. Bearish Trend Continuation
    if curr_px <= curr_vwap * 1.003 and curr_ema20 <= curr_ema50 * 1.003:
        window = candles[-30:-2]
        if len(window) >= 10:
            high_pt = max(window, key=lambda x: x["h"])
            low_pt = min(window, key=lambda x: x["l"])
            
            if high_pt["t"] < low_pt["t"]:
                impulse = high_pt["h"] - low_pt["l"]
                if impulse > 0 and (impulse / high_pt["h"]) >= 0.010:
                    fib_50 = low_pt["l"] + impulse * 0.50
                    fib_618 = low_pt["l"] + impulse * 0.618
                    fib_786 = low_pt["l"] + impulse * 0.786
                    
                    recent_high = max(c["h"] for c in candles[-6:-1])
                    in_golden_zone = (recent_high >= fib_50 * 0.996 and c2["c"] <= fib_618 * 1.004)
                    near_vwap = abs(c2["h"] - curr_vwap) / curr_vwap <= 0.008 or (c2["h"] >= curr_vwap and c2["c"] <= curr_vwap)
                    
                    if in_golden_zone or near_vwap:
                        is_bear = c2["c"] < c2["o"]
                        upper_wick = c2["h"] - max(c2["o"], c2["c"])
                        rng = c2["h"] - c2["l"]
                        has_rejection = is_bear or (rng > 0 and upper_wick >= 0.30 * rng)
                        stoch_ok = curr_k < curr_d or curr_k >= 55 or (prev_k >= prev_d and curr_k < curr_d)
                        
                        if has_rejection and stoch_ok:
                            entry = curr_px
                            sl = round(max(recent_high, fib_786) * 1.003, 6)
                            risk = abs(entry - sl)
                            if risk > 0 and 0.003 <= (risk / entry) <= 0.045:
                                t1 = round(low_pt["l"], 6)
                                t2 = round(low_pt["l"] - impulse * 0.272, 6)
                                rr1 = round(abs(entry - t1) / risk, 1)
                                if rr1 >= 1.3:
                                    return {
                                        "strategy": "Booming Bulls",
                                        "setup_name": "VWAP & Golden Fib Pullback (Bearish)",
                                        "category": "Trend Continuation",
                                        "side": "SHORT",
                                        "status": "CONFIRMED",
                                        "entry": entry,
                                        "stop_loss": sl,
                                        "target_1": t1,
                                        "target_2": t2,
                                        "rr_1": f"1:{rr1}",
                                        "rr_2": "1:2.6",
                                        "level_swept": f"VWAP: ${format_price(curr_vwap)} · Fib 50-61.8%",
                                        "summary": f"Booming Bulls Setup: Downtrend below VWAP (${format_price(curr_vwap)}). Tested 50%-61.8% Golden Fib retracement with bearish candlestick rejection & Stoch RSI momentum."
                                    }
    return None


def analyze_symbol_traders(symbol, klines_fetcher, interval="15m"):
    """
    Run confluence analysis for a single symbol using Gautam Jha and Booming Bulls frameworks.
    """
    try:
        limit = 120 if interval == "5m" else 80
        raw = klines_fetcher(symbol, interval, limit=limit)
        if not raw or len(raw) < 30:
            return None
        
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
            
        raw_daily = klines_fetcher(symbol, "1d", limit=10)
        vol_ratio = get_volume_surge(candles, lookback=20)
        
        # Check Gautam Jha setups first
        setup = check_gautam_jha_traps(candles, raw_daily)
        if not setup:
            # Check Booming Bulls setups
            setup = check_booming_bulls_setups(candles)
            
        if setup:
            setup["symbol"] = symbol
            setup["interval"] = interval
            setup["volume_surge"] = vol_ratio
            setup["current_price"] = candles[-1]["c"]
            setup["candle_close_time"] = candles[-2]["t"]
            setup["scanned_at"] = int(time.time())
            if "risk_pct" not in setup and "entry" in setup and "stop_loss" in setup and setup["entry"] > 0:
                setup["risk_pct"] = round((abs(setup["entry"] - setup["stop_loss"]) / setup["entry"]) * 100, 2)
            return setup
            
        return None
    except Exception as e:
        return None
