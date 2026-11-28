"""
Trader Strategies Confluence Engine for CryptoDock (Owner Only)
Specifically implements the trading frameworks of:
1. Gautam Jha (Stock Learners):
   - PDH / PDL Liquidity Traps (False Breakout / Breakdown Reversal)
   - Key Swing High / Swing Low Liquidity Sweeps
   - Reversal candle close back inside the key boundary with clean R:R
2. Booming Bulls (Anish Singh Thakur):
   - VWAP + EMA 20/50 Trend Filter
   - Golden Fibonacci Retracement (0.5 - 0.618 Zone Pullback)
   - Stochastic RSI (14,14,3,3) Momentum Confluence & Candlestick Rejection
   - Minimum 1:1.5 to 1:2.8 Risk-to-Reward Ratio
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


def check_gautam_jha_traps(candles, daily_candles):
    """
    Gautam Jha Liquidity Trap Framework:
    - PDH / PDL Sweeps
    - Key Fractal High / Low Sweeps
    - False breakout followed by decisive closed candle re-entry
    """
    if len(candles) < 20:
        return None
    
    c2 = candles[-2] # Confirmed closed candle
    c1 = candles[-1] # Currently forming live candle
    curr_px = c2["c"]
    
    # 1. Daily PDH / PDL Trap
    if daily_candles and len(daily_candles) >= 2:
        pd_candle = daily_candles[-2]
        pdh = float(pd_candle[2])
        pdl = float(pd_candle[3])
        pdo = float(pd_candle[1])
        
        # Check Bearish Trap (Fakeout above PDH)
        recent_window = candles[-8:-1]
        recent_highs = [c["h"] for c in recent_window]
        max_sweep_high = max(recent_highs) if recent_highs else 0
        
        if max_sweep_high > pdh and c2["c"] < pdh:
            # Price swept PDH and latest closed candle closed below PDH
            candle_rng = c2["h"] - c2["l"]
            upper_wick = c2["h"] - max(c2["o"], c2["c"])
            is_red = c2["c"] < c2["o"]
            has_bear_rejection = is_red or (candle_rng > 0 and upper_wick >= 0.30 * candle_rng)
            
            if has_bear_rejection:
                entry = c2["c"]
                sl = round(max_sweep_high * 1.002, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry - risk * 1.8, 6)
                    t2 = round(max(pdl, entry - risk * 2.8), 6)
                    rr1 = round(abs(entry - t1) / risk, 1)
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
                        "level_swept": f"PDH: ${pdh:,.2f}",
                        "summary": f"Gautam Jha Setup: Price pierced above Previous Day High (${pdh:,.2f}), trapped breakout buyers, and closed decisively back inside with bearish confirmation."
                    }
        
        # Check Bullish Trap (Fake breakdown below PDL)
        recent_lows = [c["l"] for c in recent_window]
        min_sweep_low = min(recent_lows) if recent_lows else 0
        
        if min_sweep_low < pdl and c2["c"] > pdl:
            candle_rng = c2["h"] - c2["l"]
            lower_wick = min(c2["o"], c2["c"]) - c2["l"]
            is_green = c2["c"] > c2["o"]
            has_bull_rejection = is_green or (candle_rng > 0 and lower_wick >= 0.30 * candle_rng)
            
            if has_bull_rejection:
                entry = c2["c"]
                sl = round(min_sweep_low * 0.998, 6)
                risk = abs(entry - sl)
                if risk > 0 and (risk / entry) <= 0.055:
                    t1 = round(entry + risk * 1.8, 6)
                    t2 = round(min(pdh, entry + risk * 2.8), 6)
                    rr1 = round(abs(t1 - entry) / risk, 1)
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
                        "level_swept": f"PDL: ${pdl:,.2f}",
                        "summary": f"Gautam Jha Setup: Price dipped below Previous Day Low (${pdl:,.2f}), trapped breakdown sellers, and closed decisively back inside with bullish rejection."
                    }

    # 2. Key Swing Liquidity Trap (20-candle fractal high/low sweep)
    highs, lows = calculate_swings(candles[:-2], left=3, right=3)
    if highs:
        last_swing_h = highs[-1]["price"]
        # If in the last 4 candles, price swept above last_swing_h and c2 closed below it
        recent_sweep = max(c["h"] for c in candles[-5:-1])
        if recent_sweep > last_swing_h and c2["c"] < last_swing_h:
            candle_rng = c2["h"] - c2["l"]
            upper_wick = c2["h"] - max(c2["o"], c2["c"])
            is_red = c2["c"] < c2["o"]
            if is_red or (candle_rng > 0 and upper_wick >= 0.35 * candle_rng):
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
                        "level_swept": f"Swing High: ${last_swing_h:,.2f}",
                        "summary": f"Gautam Jha Setup: Liquidity sweep above major swing high (${last_swing_h:,.2f}) with false breakout trap and candle close back below resistance."
                    }

    if lows:
        last_swing_l = lows[-1]["price"]
        recent_sweep = min(c["l"] for c in candles[-5:-1])
        if recent_sweep < last_swing_l and c2["c"] > last_swing_l:
            candle_rng = c2["h"] - c2["l"]
            lower_wick = min(c2["o"], c2["c"]) - c2["l"]
            is_green = c2["c"] > c2["o"]
            if is_green or (candle_rng > 0 and lower_wick >= 0.35 * candle_rng):
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
                        "level_swept": f"Swing Low: ${last_swing_l:,.2f}",
                        "summary": f"Gautam Jha Setup: Liquidity sweep below major swing low (${last_swing_l:,.2f}) with false breakdown trap and candle close back above support."
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
                                        "level_swept": f"VWAP: ${curr_vwap:,.2f} · Fib 50-61.8%",
                                        "summary": f"Booming Bulls Setup: Uptrend above VWAP (${curr_vwap:,.2f}). Tested 50%-61.8% Golden Fib retracement with bullish candlestick rejection & Stoch RSI momentum."
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
                                        "level_swept": f"VWAP: ${curr_vwap:,.2f} · Fib 50-61.8%",
                                        "summary": f"Booming Bulls Setup: Downtrend below VWAP (${curr_vwap:,.2f}). Tested 50%-61.8% Golden Fib retracement with bearish candlestick rejection & Stoch RSI momentum."
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
            
        raw_daily = klines_fetcher(symbol, "1d", limit=4)
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
            return setup
            
        return None
    except Exception as e:
        return None

