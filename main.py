import json
import math
import os
import re
import time
from datetime import datetime, timezone

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="CryptoDock - BTC & Crypto Intelligence")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The HTML shell and service worker carry no Cache-Control by default, so
# browsers/WebViews heuristically cache index.html off its Last-Modified and
# keep loading an old app.js?v=... reference for a while after a deploy.
# "no-cache" still allows a cheap ETag 304 revalidation on every load.
NO_CACHE_PATHS = {"/", "/frontend/index.html", "/frontend/sw.js"}


@app.middleware("http")
async def no_cache_app_shell(request, call_next):
    response = await call_next(request)
    if request.url.path in NO_CACHE_PATHS:
        response.headers["Cache-Control"] = "no-cache"
    return response


# Same project/publishable key the frontend uses (frontend/app.js) — safe to
# hardcode, matches the client-side values. Only the service role key below
# is a secret and must come from an environment variable.
SUPABASE_URL = "https://qvgfxtjwgrtytjdjcebj.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_DRsCPkKaKRYPrQDFtqV0xQ_7QeP4kYh"

BINANCE_BASE_URL = "https://data-api.binance.vision"
TECHNICAL_CACHE_SECONDS = 30
TECHNICAL_DELAYED_SECONDS = 90

price_cache = {"data": None, "updated_at": 0}
chart_cache = {"data": {}, "updated_at": 0}
technical_cache = {"data": None, "updated_at": 0}
rrg_cache = {"data": {}, "updated_at": 0}


def get_ticker(symbol="BTCUSDT"):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/ticker/24hr",
        params={"symbol": symbol},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_ticker():
    return get_ticker("BTCUSDT")


def get_klines(symbol="BTCUSDT", interval="1h", limit=250):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/klines",
        params={"symbol": symbol, "interval": interval, "limit": limit},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_klines(interval="1h", limit=250):
    return get_klines("BTCUSDT", interval, limit)


def get_btc_daily_change(current_price):
    daily_candles = get_btc_klines(interval="1d", limit=2)
    if len(daily_candles) < 2:
        raise ValueError("Not enough daily candle data to calculate daily change.")
    previous_daily_close = float(daily_candles[-2][4])
    if previous_daily_close == 0:
        raise ValueError("Previous daily close is zero.")
    return previous_daily_close, ((current_price - previous_daily_close) / previous_daily_close) * 100


def average(values):
    return sum(values) / len(values) if values else 0.0


def round_value(value, digits=2):
    return round(float(value), digits)


def sma(values, period):
    if len(values) < period:
        raise ValueError(f"Need {period} values for SMA.")
    return average(values[-period:])


def ema_series(values, period):
    if len(values) < period:
        raise ValueError(f"Need {period} values for EMA.")
    multiplier = 2 / (period + 1)
    current = average(values[:period])
    series = [None] * (period - 1) + [current]
    for value in values[period:]:
        current = (value - current) * multiplier + current
        series.append(current)
    return series


def ema(values, period):
    return ema_series(values, period)[-1]


def rsi(values, period=14):
    if len(values) < period + 1:
        raise ValueError(f"Need {period + 1} values for RSI.")
    changes = [values[index] - values[index - 1] for index in range(1, len(values))]
    recent = changes[-period:]
    avg_gain = average([max(change, 0) for change in recent])
    avg_loss = average([max(-change, 0) for change in recent])
    if avg_loss == 0:
        return 100.0
    relative_strength = avg_gain / avg_loss
    return 100 - (100 / (1 + relative_strength))


def standard_deviation(values):
    if not values:
        return 0.0
    mean = average(values)
    return math.sqrt(average([(value - mean) ** 2 for value in values]))


def percentage_change(start_value, end_value):
    if start_value == 0:
        return 0.0
    return ((end_value - start_value) / start_value) * 100


def macd(values, fast=12, slow=26, signal=9):
    if len(values) < slow + signal:
        raise ValueError("Not enough candle data for MACD.")
    fast_series = ema_series(values, fast)
    slow_series = ema_series(values, slow)
    macd_line_series = [
        fast_value - slow_value
        for fast_value, slow_value in zip(fast_series, slow_series)
        if fast_value is not None and slow_value is not None
    ]
    signal_line_series = ema_series(macd_line_series, signal)
    macd_line = macd_line_series[-1]
    signal_line = signal_line_series[-1]
    histogram = macd_line - signal_line
    previous_histogram = (
        macd_line_series[-2] - signal_line_series[-2]
        if len(macd_line_series) > 1
        else histogram
    )
    direction = "Bullish" if macd_line > signal_line else "Bearish"
    strength = "Strengthening" if histogram > previous_histogram else "Weakening"
    return {
        "macd_line": round_value(macd_line, 4),
        "signal_line": round_value(signal_line, 4),
        "histogram": round_value(histogram, 4),
        "state": f"{direction}, {strength}",
    }


def atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for ATR.")
    true_ranges = []
    for index in range(1, len(closes)):
        true_ranges.append(
            max(
                highs[index] - lows[index],
                abs(highs[index] - closes[index - 1]),
                abs(lows[index] - closes[index - 1]),
            )
        )
    return average(true_ranges[-period:])


def adx(highs, lows, closes, period=14):
    if len(closes) < (period * 2) + 1:
        raise ValueError("Not enough candle data for ADX.")
    plus_dm, minus_dm, true_ranges = [], [], []
    for index in range(1, len(closes)):
        up_move = highs[index] - highs[index - 1]
        down_move = lows[index - 1] - lows[index]
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0)
        true_ranges.append(
            max(
                highs[index] - lows[index],
                abs(highs[index] - closes[index - 1]),
                abs(lows[index] - closes[index - 1]),
            )
        )
    dx_values, plus_di_values, minus_di_values = [], [], []
    for index in range(period - 1, len(true_ranges)):
        tr_average = average(true_ranges[index - period + 1:index + 1])
        plus_average = average(plus_dm[index - period + 1:index + 1])
        minus_average = average(minus_dm[index - period + 1:index + 1])
        plus_di = 100 * plus_average / tr_average if tr_average else 0
        minus_di = 100 * minus_average / tr_average if tr_average else 0
        total_di = plus_di + minus_di
        dx = 100 * abs(plus_di - minus_di) / total_di if total_di else 0
        plus_di_values.append(plus_di)
        minus_di_values.append(minus_di)
        dx_values.append(dx)
    adx_value = average(dx_values[-period:])
    return {
        "adx_14": round_value(adx_value),
        "plus_di_14": round_value(plus_di_values[-1]),
        "minus_di_14": round_value(minus_di_values[-1]),
        "trend_strength": "Strong" if adx_value >= 25 else "Moderate" if adx_value >= 20 else "Weak / ranging",
    }


def bollinger_bands(values, period=20, multiplier=2):
    if len(values) < period:
        raise ValueError("Not enough candle data for Bollinger Bands.")
    window = values[-period:]
    middle = average(window)
    deviation = standard_deviation(window)
    upper = middle + multiplier * deviation
    lower = middle - multiplier * deviation
    width_percent = ((upper - lower) / middle) * 100 if middle else 0
    position_percent = ((values[-1] - lower) / (upper - lower)) * 100 if upper != lower else 50
    return {
        "upper": round_value(upper),
        "middle": round_value(middle),
        "lower": round_value(lower),
        "width_percent": round_value(width_percent),
        "price_position_percent": round_value(position_percent),
    }


def obv(closes, volumes):
    value = 0.0
    values = [value]
    for index in range(1, len(closes)):
        if closes[index] > closes[index - 1]:
            value += volumes[index]
        elif closes[index] < closes[index - 1]:
            value -= volumes[index]
        values.append(value)
    direction = "Rising" if values[-1] > values[-6] else "Falling" if values[-1] < values[-6] else "Flat"
    return {"value": round_value(values[-1], 2), "direction_5_candles": direction}


def mfi(highs, lows, closes, volumes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for MFI.")
    typical_prices = [(high + low + close) / 3 for high, low, close in zip(highs, lows, closes)]
    positive_flow, negative_flow = [], []
    for index in range(1, len(typical_prices)):
        raw_flow = typical_prices[index] * volumes[index]
        if typical_prices[index] > typical_prices[index - 1]:
            positive_flow.append(raw_flow)
            negative_flow.append(0)
        elif typical_prices[index] < typical_prices[index - 1]:
            positive_flow.append(0)
            negative_flow.append(raw_flow)
        else:
            positive_flow.append(0)
            negative_flow.append(0)
    positive_sum = sum(positive_flow[-period:])
    negative_sum = sum(negative_flow[-period:])
    if negative_sum == 0:
        return 100.0
    money_ratio = positive_sum / negative_sum
    return 100 - (100 / (1 + money_ratio))


def candle_pattern(candles):
    current, previous = candles[-1], candles[-2]
    open_price, high_price, low_price, close_price = map(float, [current[1], current[2], current[3], current[4]])
    previous_open, previous_high, previous_low, previous_close = map(float, [previous[1], previous[2], previous[3], previous[4]])
    body = abs(close_price - open_price)
    full_range = max(high_price - low_price, 0.00000001)
    upper_wick = high_price - max(open_price, close_price)
    lower_wick = min(open_price, close_price) - low_price
    if high_price < previous_high and low_price > previous_low:
        return "Inside bar / consolidation"
    if close_price > open_price and previous_close < previous_open and close_price >= previous_open and open_price <= previous_close:
        return "Bullish engulfing"
    if close_price < open_price and previous_close > previous_open and close_price <= previous_open and open_price >= previous_close:
        return "Bearish engulfing"
    if body / full_range < 0.12:
        return "Doji / indecision"
    if lower_wick > body * 2 and upper_wick < body:
        return "Hammer-like bullish rejection"
    if upper_wick > body * 2 and lower_wick < body:
        return "Shooting-star-like bearish rejection"
    return "Bullish candle" if close_price > open_price else "Bearish candle"


def market_structure(closes, highs, lows, ema_20_value, ema_50_value):
    recent_high, recent_low = max(highs[-20:]), min(lows[-20:])
    prior_high, prior_low = max(highs[-40:-20]), min(lows[-40:-20])
    last_close = closes[-1]
    if recent_high > prior_high and recent_low > prior_low and last_close > ema_20_value > ema_50_value:
        return "Bullish: Higher highs and higher lows"
    if recent_high < prior_high and recent_low < prior_low and last_close < ema_20_value < ema_50_value:
        return "Bearish: Lower highs and lower lows"
    return "Range / mixed structure"


def pivot_levels(highs, lows, closes):
    prior_high, prior_low, prior_close = max(highs[-25:-1]), min(lows[-25:-1]), closes[-2]
    pivot = (prior_high + prior_low + prior_close) / 3
    return {
        "pivot": round_value(pivot),
        "support_1": round_value((2 * pivot) - prior_high),
        "support_2": round_value(pivot - (prior_high - prior_low)),
        "resistance_1": round_value((2 * pivot) - prior_low),
        "resistance_2": round_value(pivot + (prior_high - prior_low)),
    }


def fibonacci_levels(highs, lows):
    swing_high, swing_low = max(highs[-50:]), min(lows[-50:])
    price_range = swing_high - swing_low
    return {
        "swing_high": round_value(swing_high),
        "swing_low": round_value(swing_low),
        "level_23_6": round_value(swing_high - price_range * 0.236),
        "level_38_2": round_value(swing_high - price_range * 0.382),
        "level_50_0": round_value(swing_high - price_range * 0.5),
        "level_61_8": round_value(swing_high - price_range * 0.618),
        "level_78_6": round_value(swing_high - price_range * 0.786),
    }


def find_pivot_highs(highs, left_right=3):
    pivots = []
    for index in range(left_right, len(highs) - left_right):
        current = highs[index]
        if current > max(highs[index - left_right:index]) and current >= max(highs[index + 1:index + left_right + 1]):
            pivots.append(index)
    return pivots


def find_pivot_lows(lows, left_right=3):
    pivots = []
    for index in range(left_right, len(lows) - left_right):
        current = lows[index]
        if current < min(lows[index - left_right:index]) and current <= min(lows[index + 1:index + left_right + 1]):
            pivots.append(index)
    return pivots


def calculate_multi_factor_confidence(adx_value, rsi_value, macd_state, volume_ratio, current_price, break_level, protected_level):
    """Combines trend strength (ADX), momentum (RSI distance from neutral), MACD state,
    volume, and how close price currently is to the breakout level into one 15-55 HOLD
    confidence score, so it reflects the whole technical picture rather than any single
    indicator, and genuinely moves as market conditions change."""
    trend_score = min(100, float(adx_value or 0) * 2)
    momentum_score = min(100, abs(float(rsi_value or 50) - 50) * 2)
    normalized_macd = str(macd_state or "").lower()
    if "bullish" in normalized_macd or "bearish" in normalized_macd:
        macd_score = 70 if "strengthening" in normalized_macd else 40
    else:
        macd_score = 15
    volume_score = min(100, float(volume_ratio or 0) * 60)
    range_size = abs(break_level - protected_level) or 1
    distance_to_break = abs(break_level - current_price)
    proximity_score = max(0, 100 - (distance_to_break / range_size) * 100)
    combined = (
        trend_score * 0.25
        + momentum_score * 0.20
        + macd_score * 0.20
        + volume_score * 0.15
        + proximity_score * 0.20
    )
    return max(15, min(55, round(combined)))


def calculate_swing_failure_structure(candles, atr_value, swing_left_right=3, volume_ratio=0, rsi_value=50, macd_state="", trend_1h="", trend_4h=""):
    if len(candles) < 60:
        raise ValueError("Need at least 60 candles for 15m swing structure analysis.")
    opens = [float(candle[1]) for candle in candles]
    highs = [float(candle[2]) for candle in candles]
    lows = [float(candle[3]) for candle in candles]
    closes = [float(candle[4]) for candle in candles]
    volumes = [float(candle[5]) for candle in candles]
    pivot_highs = find_pivot_highs(highs, swing_left_right)
    pivot_lows = find_pivot_lows(lows, swing_left_right)
    current_price = closes[-1]
    atr_buffer = max(float(atr_value) * 0.15, 0.01)
    retest_tolerance = max(float(atr_value) * 0.25, 0.01)
    normalized_macd = str(macd_state or "").lower()
    normalized_trend_1h = str(trend_1h or "").lower()
    normalized_trend_4h = str(trend_4h or "").lower()
    bullish_momentum_ok = float(rsi_value) >= 50 and "bullish" in normalized_macd
    bearish_momentum_ok = float(rsi_value) <= 50 and "bearish" in normalized_macd
    bullish_1h_ok = "bullish" in normalized_trend_1h or "mixed" in normalized_trend_1h
    bearish_1h_ok = "bearish" in normalized_trend_1h or "mixed" in normalized_trend_1h
    bullish_4h_blocked = "strong bearish" in normalized_trend_4h
    bearish_4h_blocked = "strong bullish" in normalized_trend_4h
    average_break_volume = average(volumes[-21:-1])
    calculated_volume_ratio = volumes[-1] / average_break_volume if average_break_volume else 0
    effective_volume_ratio = max(float(volume_ratio or 0), calculated_volume_ratio)
    volume_ok = effective_volume_ratio >= 0.40

    def rounded(value):
        return round_value(value) if value is not None else None

    def build_filter_result(direction, signal, status, prior_high, prior_low, protected_level, break_level, retest_level, invalidation_level, conclusion, reason, quality, passed_filters, waiting_filters, failed_filters, break_event, confirmation_close=None, hold_confidence=None):
        return {
            "timeframe": "15m",
            "current_price": rounded(current_price),
            "atr_14": rounded(atr_value),
            "atr_buffer": rounded(atr_buffer),
            "prior_swing_high": rounded(prior_high),
            "prior_swing_low": rounded(prior_low),
            "failed_high": None,
            "failed_low": None,
            "break_event": break_event,
            "protected_break_level": rounded(protected_level),
            "break_level": rounded(break_level),
            "break_level_text": f"Body close above ${break_level:,.2f}" if direction == "BULLISH" else f"Body close below ${break_level:,.2f}",
            "break_status": status,
            "retest_level": rounded(retest_level),
            "invalidation_level": rounded(invalidation_level),
            "confirmation_close": rounded(confirmation_close),
            "signal": signal,
            "direction": direction,
            "quality": quality,
            "final_conclusion": conclusion,
            "reason": reason,
            "confirmation_rule": "Final signal needs: 0.15 ATR body-close break, volume >= 0.40x, a second direction close, 1h alignment, no strong 4h conflict, retest, and a confirmation candle. Wick alone never counts.",
            "filter_checklist": {
                "passed": passed_filters,
                "waiting": waiting_filters,
                "failed": failed_filters,
                "volume_ratio": rounded(effective_volume_ratio),
                "volume_required": 1.20,
                "rsi_15m": rounded(rsi_value),
                "macd_15m": macd_state,
                "trend_1h": trend_1h,
                "trend_4h": trend_4h,
                "hold_confidence": hold_confidence,
            },
        }

    if not pivot_highs or not pivot_lows:
        return build_filter_result("NEUTRAL", "NO TRADE", "STRUCTURE TRACKING", None, None, None, current_price, None, None, "HOLD — waiting for confirmed 15m swing pivots.", "No confirmed local swing high and low are available yet.", "LOW", [], ["Confirmed local swing high/low"], [], "No confirmed swing structure yet")

    active_high_index = pivot_highs[-1]
    active_low_index = pivot_lows[-1]
    active_high = highs[active_high_index]
    active_low = lows[active_low_index]
    bullish_break_level = active_high + atr_buffer
    bearish_break_level = active_low - atr_buffer
    bullish_break_index = None
    bearish_break_index = None
    for index in range(active_high_index + 1, len(candles)):
        if closes[index] > bullish_break_level:
            bullish_break_index = index
    for index in range(active_low_index + 1, len(candles)):
        if closes[index] < bearish_break_level:
            bearish_break_index = index

    if bullish_break_index is None and bearish_break_index is None:
        midpoint = (active_high + active_low) / 2
        signal = "BUY WATCH" if current_price >= midpoint else "SELL WATCH"
        direction = "BULLISH" if signal == "BUY WATCH" else "BEARISH"
        break_level = bullish_break_level if direction == "BULLISH" else bearish_break_level
        protected_level = active_high if direction == "BULLISH" else active_low
        try:
            adx_value_for_confidence = adx(highs, lows, closes).get("adx_14", 0)
        except ValueError:
            adx_value_for_confidence = 0
        hold_confidence = calculate_multi_factor_confidence(adx_value_for_confidence, rsi_value, macd_state, effective_volume_ratio, current_price, break_level, protected_level)
        return build_filter_result(direction, signal, "INSIDE STRUCTURE", active_high, active_low, protected_level, break_level, protected_level, active_low if direction == "BULLISH" else active_high, f"HOLD — price is inside the active 15m swing range. No final trade; wait for a confirmed break and retest.", "No current swing level has a body-close break beyond the 0.15 ATR buffer.", "LOW", [], ["0.15 ATR body-close break", "Break volume >= 0.40x", "Second 15m direction close", "Retest confirmation"], [], "No confirmed break yet", hold_confidence=hold_confidence)

    newest_is_bullish = bullish_break_index is not None and (bearish_break_index is None or bullish_break_index > bearish_break_index)
    if newest_is_bullish:
        break_index = bullish_break_index
        direction, watch_signal, final_signal = "BULLISH", "BUY WATCH", "BUY"
        protected_level, break_level, invalidation_level = active_high, bullish_break_level, active_low
        second_close_ok = any(closes[index] > active_high for index in range(break_index + 1, len(candles)))
        retest_seen = final_confirmation = failed_break = False
        confirmation_close_price = None
        for index in range(break_index + 1, len(candles)):
            if closes[index] < active_high - retest_tolerance:
                failed_break = True
            if lows[index] <= active_high + retest_tolerance:
                retest_seen = True
            if retest_seen and closes[index] > opens[index] and closes[index] > active_high:
                final_confirmation = True
                confirmation_close_price = closes[index]
        momentum_ok, trend_1h_ok, trend_4h_ok = bullish_momentum_ok, bullish_1h_ok, not bullish_4h_blocked
    else:
        break_index = bearish_break_index
        direction, watch_signal, final_signal = "BEARISH", "SELL WATCH", "SELL"
        protected_level, break_level, invalidation_level = active_low, bearish_break_level, active_high
        second_close_ok = any(closes[index] < active_low for index in range(break_index + 1, len(candles)))
        retest_seen = final_confirmation = failed_break = False
        confirmation_close_price = None
        for index in range(break_index + 1, len(candles)):
            if closes[index] > active_low + retest_tolerance:
                failed_break = True
            if highs[index] >= active_low - retest_tolerance:
                retest_seen = True
            if retest_seen and closes[index] < opens[index] and closes[index] < active_low:
                final_confirmation = True
                confirmation_close_price = closes[index]
        momentum_ok, trend_1h_ok, trend_4h_ok = bearish_momentum_ok, bearish_1h_ok, not bearish_4h_blocked

    passed, waiting, failed = ["0.15 ATR body-close break"], [], []
    if volume_ok:
        passed.append(f"Break volume x{effective_volume_ratio:.2f} >= 0.40x")
    else:
        failed.append(f"Break volume x{effective_volume_ratio:.2f} below 0.40x")
    if second_close_ok:
        passed.append("Second 15m candle close confirmed")
    else:
        waiting.append("Second 15m direction close")
    if trend_1h_ok:
        passed.append("1h trend aligned")
    else:
        failed.append(f"1h trend not aligned: {trend_1h or 'unknown'}")
    if trend_4h_ok:
        passed.append("No strong opposite 4h trend")
    else:
        failed.append(f"Strong opposite 4h trend: {trend_4h}")
    if momentum_ok:
        passed.append("15m RSI + MACD aligned")
    else:
        failed.append("15m RSI + MACD not aligned")
    if retest_seen:
        passed.append("Retest detected")
    else:
        waiting.append("Retest pending")
    if final_confirmation:
        passed.append("Retest confirmation candle")
    else:
        waiting.append("Retest confirmation candle")

    if failed_break:
        return build_filter_result(direction, watch_signal, "BREAK FAILED / BACK INSIDE", active_high, active_low, protected_level, break_level, protected_level, invalidation_level, f"{watch_signal} — break moved back inside the prior swing range. Do not enter; wait for a fresh break and retest.", "Price body-close accepted back inside the old swing structure.", "LOW", passed, waiting, failed, "Break failed; price returned inside")
    supporting_checks = [volume_ok, second_close_ok, trend_1h_ok, trend_4h_ok, momentum_ok]
    supporting_passed = sum(1 for check in supporting_checks if check)
    retest_path_ok = retest_seen and final_confirmation and supporting_passed >= 3
    # Alternative: a strong breakout that continues (second directional close) without
    # ever pulling back to retest can still confirm, if almost all supporting filters
    # align — requiring a retest was blocking genuine breakout-and-run moves.
    breakout_continuation_ok = second_close_ok and supporting_passed >= 4
    mandatory_filters_ok = retest_path_ok or breakout_continuation_ok
    if mandatory_filters_ok:
        quality_label = "HIGH" if supporting_passed == len(supporting_checks) else "MEDIUM"
        supporting_summary = f"{supporting_passed}/{len(supporting_checks)} supporting filters aligned (volume, second close, 1h trend, 4h trend, momentum)"
        path_summary = "retest and confirmation candle are present" if retest_path_ok else "breakout is continuing without a pullback yet"
        return build_filter_result(direction, final_signal, f"{final_signal} CONFIRMED — {quality_label} QUALITY", active_high, active_low, protected_level, break_level, protected_level, invalidation_level, f"{final_signal} — confirmed 15m break, {path_summary}, with {supporting_summary}. Run Gemini AI Analysis now; proceed only if Gemini agrees.", f"Core price-action confirmed ({path_summary}); {supporting_summary}.", quality_label, passed, waiting, failed, "Bullish break + support retest hold" if direction == "BULLISH" else "Bearish break + resistance retest rejection", confirmation_close_price)
    status = f"{direction} BREAK / FILTERS PENDING" if not failed else f"{direction} BREAK / FILTER FAILED"
    return build_filter_result(direction, watch_signal, status, active_high, active_low, protected_level, break_level, protected_level, invalidation_level, f"HOLD — a structure break exists, but final {final_signal} is blocked until every fakeout filter passes. Review failed/pending filters below.", "Break is not yet high quality enough for a final signal.", "MEDIUM" if len(failed) <= 1 else "LOW", passed, waiting, failed, "Bullish break awaiting filters" if direction == "BULLISH" else "Bearish break awaiting filters")


def calculate_market_indicators(candles, interval):
    if len(candles) < 200:
        raise ValueError("Need 200 candles for full market analysis.")
    highs = [float(candle[2]) for candle in candles]
    lows = [float(candle[3]) for candle in candles]
    closes = [float(candle[4]) for candle in candles]
    volumes = [float(candle[5]) for candle in candles]
    quote_volumes = [float(candle[7]) for candle in candles]
    trade_counts = [int(candle[8]) for candle in candles]
    taker_buy_volumes = [float(candle[9]) for candle in candles]
    last_close = closes[-1]
    ema_20_value, ema_50_value, ema_200_value = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    atr_value = atr(highs, lows, closes)
    average_volume_20 = average(volumes[-20:-1])
    current_volume = volumes[-1]
    volume_ratio = current_volume / average_volume_20 if average_volume_20 else 0
    total_volume_20 = sum(volumes[-20:])
    taker_buy_total_20 = sum(taker_buy_volumes[-20:])
    taker_buy_ratio = (taker_buy_total_20 / total_volume_20) * 100 if total_volume_20 else 50
    support, resistance = min(lows[-20:]), max(highs[-20:])
    prior_resistance, prior_support = max(highs[-21:-1]), min(lows[-21:-1])
    breakout = "Bullish breakout" if last_close > prior_resistance and volume_ratio >= 1.2 else "Bearish breakdown" if last_close < prior_support and volume_ratio >= 1.2 else "No confirmed breakout"
    trend = "Strong bullish" if last_close > ema_20_value > ema_50_value > ema_200_value else "Bullish" if last_close > ema_20_value > ema_50_value else "Strong bearish" if last_close < ema_20_value < ema_50_value < ema_200_value else "Bearish" if last_close < ema_20_value < ema_50_value else "Mixed"
    momentum_percent = percentage_change(closes[-13], last_close)
    return {
        "timeframe": interval,
        "price": round_value(last_close),
        "trend": trend,
        "ema": {"ema_20": round_value(ema_20_value), "ema_50": round_value(ema_50_value), "ema_200": round_value(ema_200_value)},
        "sma": {"sma_20": round_value(sma(closes, 20)), "sma_50": round_value(sma(closes, 50))},
        "rsi_14": round_value(rsi(closes, 14)),
        "macd": macd(closes),
        "adx": adx(highs, lows, closes),
        "atr_14": round_value(atr_value),
        "atr_percent": round_value((atr_value / last_close) * 100),
        "bollinger_bands": bollinger_bands(closes),
        "volume": {"current": round_value(current_volume, 4), "average_20": round_value(average_volume_20, 4), "volume_ratio": round_value(volume_ratio), "quote_volume_current": round_value(quote_volumes[-1], 2), "trade_count_current": trade_counts[-1], "taker_buy_ratio_20_percent": round_value(taker_buy_ratio)},
        "obv": obv(closes, volumes),
        "mfi_14": round_value(mfi(highs, lows, closes, volumes)),
        "momentum_percent": round_value(momentum_percent),
        "support_resistance": {"support_20": round_value(support), "resistance_20": round_value(resistance)},
        "pivots": pivot_levels(highs, lows, closes),
        "fibonacci": fibonacci_levels(highs, lows),
        "candle_pattern": candle_pattern(candles),
        "market_structure": market_structure(closes, highs, lows, ema_20_value, ema_50_value),
        "breakout_status": breakout,
        "swing_failure_structure": None,
    }


def timeframe_signal_from_indicators(indicators):
    trend = str(indicators.get("trend", "")).lower()
    macd_state = str(indicators.get("macd", {}).get("state", "")).lower()
    rsi_value = float(indicators.get("rsi_14", 50))
    momentum = float(indicators.get("momentum_percent", 0))
    volume_ratio = float((indicators.get("volume") or {}).get("volume_ratio", 0) or 0)
    price = float(indicators.get("price", 0) or 0)
    support = float((indicators.get("support_resistance") or {}).get("support_20", 0) or 0)
    resistance = float((indicators.get("support_resistance") or {}).get("resistance_20", 0) or 0)
    bullish_score = 0
    bearish_score = 0
    if "bull" in trend:
        bullish_score += 2
    elif "bear" in trend:
        bearish_score += 2
    if "bull" in macd_state:
        bullish_score += 1
    elif "bear" in macd_state:
        bearish_score += 1
    if rsi_value >= 52:
        bullish_score += 1
    elif rsi_value <= 48:
        bearish_score += 1
    if momentum > 0:
        bullish_score += 1
    elif momentum < 0:
        bearish_score += 1
    # Volume confirmation: above-average volume adds weight to whichever side the other
    # indicators already lean toward, since real conviction behind a move needs volume.
    if volume_ratio >= 1.2:
        if bullish_score > bearish_score:
            bullish_score += 1
        elif bearish_score > bullish_score:
            bearish_score += 1
    # Support/resistance breakout proximity: price sitting close to resistance suggests
    # a possible bullish breakout attempt forming; close to support suggests a possible
    # bearish breakdown attempt forming.
    range_size = (resistance - support) or 1
    if price and resistance and support:
        if abs(resistance - price) / range_size <= 0.15:
            bullish_score += 1
        elif abs(price - support) / range_size <= 0.15:
            bearish_score += 1
    if bullish_score >= 3 and bullish_score > bearish_score:
        return "BUY"
    if bearish_score >= 3 and bearish_score > bullish_score:
        return "SELL"
    return "HOLD"


def trend_score(indicators):
    trend = str(indicators.get("trend", "")).lower()
    return 2 if "strong bullish" in trend else 1 if trend == "bullish" else -2 if "strong bearish" in trend else -1 if trend == "bearish" else 0


def macd_score(indicators):
    state = str(indicators.get("macd", {}).get("state", "")).lower()
    return 2 if "bullish" in state and "strengthening" in state else 1 if "bullish" in state else -2 if "bearish" in state and "strengthening" in state else -1 if "bearish" in state else 0


def momentum_score(indicators):
    rsi_value = float(indicators.get("rsi_14", 50))
    momentum = float(indicators.get("momentum_percent", 0))
    if rsi_value >= 58 and momentum > 0:
        return 2
    if rsi_value >= 50 and momentum >= 0:
        return 1
    if rsi_value <= 42 and momentum < 0:
        return -2
    if rsi_value <= 50 and momentum <= 0:
        return -1
    return 0


def breakout_score(indicators):
    breakout = str(indicators.get("breakout_status", "")).lower()
    return 2 if "bullish breakout" in breakout else -2 if "bearish breakdown" in breakout else 0


def volume_score(indicators):
    volume_ratio = float(indicators.get("volume", {}).get("volume_ratio", 0))
    taker_buy_ratio = float(indicators.get("volume", {}).get("taker_buy_ratio_20_percent", 50))
    return 1 if volume_ratio >= 1.2 and taker_buy_ratio >= 52 else -1 if volume_ratio >= 1.2 and taker_buy_ratio <= 48 else 0


def calculate_score_breakdown(market_data):
    timeframes = market_data["timeframes"]
    weighted = {"15m": 0.25, "1h": 0.35, "4h": 0.40}
    components = {"trend": trend_score, "macd": macd_score, "momentum": momentum_score, "breakout": breakout_score, "volume": volume_score}
    result, total_score, max_possible = {}, 0.0, 0.0
    for name, scorer in components.items():
        weighted_score = sum(scorer(timeframes[timeframe]) * weight for timeframe, weight in weighted.items())
        component_max = 2 if name != "volume" else 1
        result[name] = {"score": round_value(weighted_score, 2), "minimum": -component_max, "maximum": component_max}
        total_score += weighted_score
        max_possible += component_max
    alignment_percent = ((total_score + max_possible) / (2 * max_possible)) * 100
    bias = "Bullish" if total_score >= 2 else "Bearish" if total_score <= -2 else "Neutral / mixed"
    return {**result, "total_score": round_value(total_score, 2), "score_range": {"minimum": -9, "maximum": 9}, "technical_alignment_percent": round_value(alignment_percent), "bias": bias}


def calculate_timeframe_agreement(market_data):
    timeframe_signals = {timeframe: timeframe_signal_from_indicators(indicators) for timeframe, indicators in market_data["timeframes"].items()}
    values = list(timeframe_signals.values())
    buy_count, sell_count, hold_count = values.count("BUY"), values.count("SELL"), values.count("HOLD")
    percent = round_value((max(buy_count, sell_count, hold_count) / len(values)) * 100)
    direction = "Fully bullish" if buy_count == 3 else "Fully bearish" if sell_count == 3 else "Mostly bullish" if buy_count >= 2 else "Mostly bearish" if sell_count >= 2 else "Mixed"
    return {"percent": percent, "direction": direction, "bullish_votes": buy_count, "bearish_votes": sell_count, "hold_votes": hold_count, "signals": timeframe_signals}


def calculate_market_regime(market_data):
    analyses = list(market_data["timeframes"].values())
    average_adx = average([float(item.get("adx", {}).get("adx_14", 0)) for item in analyses])
    average_atr_percent = average([float(item.get("atr_percent", 0)) for item in analyses])
    average_bb_width = average([float(item.get("bollinger_bands", {}).get("width_percent", 0)) for item in analyses])
    trends = [str(item.get("trend", "")).lower() for item in analyses]
    bullish_count = sum("bull" in trend for trend in trends)
    bearish_count = sum("bear" in trend for trend in trends)
    if average_atr_percent >= 2.2 or average_bb_width >= 8:
        label, detail = "High Volatility", "Price swings are elevated; use wider invalidation and reduce trade frequency."
    elif average_adx >= 25 and (bullish_count >= 2 or bearish_count >= 2):
        label, detail = "Trending", "Directional trend conditions are present across multiple timeframes."
    elif average_adx < 18 and average_atr_percent < 0.8:
        label, detail = "Low Volatility", "Compressed movement; wait for expansion or a confirmed breakout."
    else:
        label, detail = "Ranging", "Mixed or moderate trend conditions; key support and resistance matter most."
    return {"label": label, "detail": detail, "average_adx": round_value(average_adx), "average_atr_percent": round_value(average_atr_percent), "average_bollinger_width_percent": round_value(average_bb_width)}


def calculate_key_level_distance(market_data):
    result = {}
    for timeframe, analysis in market_data["timeframes"].items():
        price = float(analysis.get("price", 0))
        support = float(analysis.get("support_resistance", {}).get("support_20", 0))
        resistance = float(analysis.get("support_resistance", {}).get("resistance_20", 0))
        support_distance = ((price - support) / price) * 100 if price and support else None
        resistance_distance = ((resistance - price) / price) * 100 if price and resistance else None
        result[timeframe] = {"price": round_value(price), "support": round_value(support), "resistance": round_value(resistance), "support_distance_percent": round_value(support_distance) if support_distance is not None else None, "resistance_distance_percent": round_value(resistance_distance) if resistance_distance is not None else None}
    return result


def compute_engine_candidate_levels(sfs, current_price):
    """Deterministic candidate Entry/Stop/Target1/Target2 from the swing-failure-structure
    result, per the ATR-based formula: Entry = confirmation candle close (fallback: current
    price); Stop = invalidation level -/+ 0.25*ATR; Target1/2 = Entry +/- 1R/2R."""
    direction = sfs.get("direction")
    invalidation = sfs.get("invalidation_level")
    atr_value = float(sfs.get("atr_14") or 0)
    if direction not in ("BULLISH", "BEARISH") or invalidation is None or atr_value <= 0:
        return None
    entry = float(sfs.get("confirmation_close") or current_price or 0)
    if entry <= 0:
        return None
    if direction == "BULLISH":
        stop = invalidation - (0.25 * atr_value)
        r = entry - stop
        if r <= 0:
            return None
        target_1, target_2 = entry + r, entry + (2 * r)
    else:
        stop = invalidation + (0.25 * atr_value)
        r = stop - entry
        if r <= 0:
            return None
        target_1, target_2 = entry - r, entry - (2 * r)
    return {
        "entry_price": round_value(entry),
        "stop_loss_price": round_value(stop),
        "target_1_price": round_value(target_1),
        "target_2_price": round_value(target_2),
    }


def calculate_macro_trend_signal(candles):
    """Looks at a longer window (up to ~48h of 15m candles) for a sustained directional
    move — the kind of slow, lower-volume multi-day drift the short-term swing-structure
    filters are designed to ignore (since they require a sharp, high-volume break). This
    is a separate, independent check so a genuine multi-day trend can still be surfaced
    even when no single 15m candle ever satisfies the structure-break requirements."""
    if len(candles) < 40:
        return {"signal": "HOLD", "percent_change": 0, "consistency": 0, "reason": "Not enough candle history for a macro trend read."}
    closes = [float(candle[4]) for candle in candles]
    opens = [float(candle[1]) for candle in candles]
    window = min(192, len(closes) - 1)
    start_price = closes[-window - 1]
    end_price = closes[-1]
    percent_change = ((end_price - start_price) / start_price) * 100 if start_price else 0
    recent_opens, recent_closes = opens[-window:], closes[-window:]
    up_count = sum(1 for o, c in zip(recent_opens, recent_closes) if c > o)
    down_count = len(recent_closes) - up_count
    consistency = (max(up_count, down_count) / len(recent_closes)) * 100 if recent_closes else 0
    hours = round(window * 15 / 60)
    if percent_change >= 1.5 and consistency >= 55:
        return {"signal": "BUY", "percent_change": round_value(percent_change), "consistency": round_value(consistency), "reason": f"Sustained {round_value(percent_change)}% rise over the last ~{hours}h, with {round_value(consistency)}% of candles bullish."}
    if percent_change <= -1.5 and consistency >= 55:
        return {"signal": "SELL", "percent_change": round_value(percent_change), "consistency": round_value(consistency), "reason": f"Sustained {round_value(abs(percent_change))}% decline over the last ~{hours}h, with {round_value(consistency)}% of candles bearish."}
    return {"signal": "HOLD", "percent_change": round_value(percent_change), "consistency": round_value(consistency), "reason": "No sustained directional macro move detected."}


def compute_macro_trade_levels(direction, current_price, atr_value):
    """Risk-based candidate Entry/Stop/Target1/2 for a macro-trend signal — since there's
    no structure-break confirmation candle to anchor to, entry is simply the current
    price, and stop/targets use an ATR-based (or 0.5% minimum) risk distance at 1R/2R."""
    current_price, atr_value = float(current_price or 0), float(atr_value or 0)
    if current_price <= 0:
        return None
    risk_distance = max(atr_value * 1.5, current_price * 0.005)
    if direction == "BUY":
        stop, target_1, target_2 = current_price - risk_distance, current_price + risk_distance, current_price + (2 * risk_distance)
    else:
        stop, target_1, target_2 = current_price + risk_distance, current_price - risk_distance, current_price - (2 * risk_distance)
    return {"entry_price": round_value(current_price), "stop_loss_price": round_value(stop), "target_1_price": round_value(target_1), "target_2_price": round_value(target_2)}


def technical_main_signal(market_data):
    timeframes = market_data["timeframes"]
    analysis_15m, analysis_1h, analysis_4h = timeframes["15m"], timeframes["1h"], timeframes["4h"]
    # Informational per-timeframe badges only (used by the multi-timeframe intelligence
    # panels) — the actual Engine decision below comes from the swing-failure-structure.
    signal_15m = timeframe_signal_from_indicators(analysis_15m)
    signal_1h = timeframe_signal_from_indicators(analysis_1h)
    signal_4h = timeframe_signal_from_indicators(analysis_4h)

    sfs = analysis_15m.get("swing_failure_structure") or {}
    raw_signal = str(sfs.get("signal", "NO TRADE")).upper()
    current_price = float(sfs.get("current_price") or analysis_15m.get("price") or 0)
    direction = sfs.get("direction", "NEUTRAL")

    # Legacy/internal labels normalize to the final user-facing set: BUY, SELL, HOLD.
    # Only a fully-confirmed swing-failure-structure break (all mandatory filters passed)
    # produces BUY/SELL; BUY WATCH / SELL WATCH / NO TRADE / failed or pending states all
    # normalize to HOLD, keeping the detailed reason so the user knows why.
    final_signal = raw_signal if raw_signal in ("BUY", "SELL") else "HOLD"

    checklist = sfs.get("filter_checklist", {})
    passed_filters = checklist.get("passed", [])
    waiting_filters = checklist.get("waiting", [])
    failed_filters = checklist.get("failed", [])
    total_checks = len(passed_filters) + len(waiting_filters) + len(failed_filters)
    base_confidence = round((len(passed_filters) / total_checks) * 100) if total_checks else 50

    if final_signal in ("BUY", "SELL"):
        confidence = max(65, base_confidence)
    elif passed_filters:
        # A break was attempted (some structural filters passed) but not fully confirmed.
        confidence = min(58, base_confidence)
    else:
        # No breakout has even been attempted yet (price is inside its range), so the
        # structural-break checklist is always empty here and would always read 0% —
        # that's not a market reading, just an artifact of nothing having happened yet.
        # Use the multi-factor confidence (trend, RSI momentum, MACD, volume, and how
        # close price is to the breakout level) computed alongside the structure, so it
        # reflects the whole technical picture and genuinely moves with the market.
        multi_factor_confidence = checklist.get("hold_confidence")
        if multi_factor_confidence is not None:
            confidence = int(multi_factor_confidence)
        else:
            adx_value = float((analysis_15m.get("adx") or {}).get("adx_14", 0) or 0)
            confidence = max(15, min(55, round(15 + adx_value * 1.2)))

    risk = "MEDIUM" if final_signal in ("BUY", "SELL") or sfs.get("quality") == "MEDIUM" else "HIGH"
    market_bias = (
        "Bullish technical bias" if direction == "BULLISH"
        else "Bearish technical bias" if direction == "BEARISH"
        else "Neutral / mixed technical bias"
    )
    setup_status = sfs.get("break_status") or "Mixed technical setup — wait"
    reason = sfs.get("final_conclusion") or sfs.get("reason") or "Technical fallback: waiting for a clearer confirmed structure."

    # Macro-trend fallback: if the strict short-term structure-break filters never
    # trigger (e.g. a slow, lower-volume multi-day drift with no single sharp 15m
    # break), a sustained longer-window move can still surface a signal here.
    signal_source = "structure"
    macro_trend = analysis_15m.get("macro_trend") or {}
    if final_signal == "HOLD" and macro_trend.get("signal") in ("BUY", "SELL"):
        final_signal = macro_trend["signal"]
        direction = "BULLISH" if final_signal == "BUY" else "BEARISH"
        signal_source = "macro"
        confidence = max(45, min(65, round(45 + abs(float(macro_trend.get("percent_change", 0))) * 4)))
        risk = "MEDIUM"
        market_bias = "Bullish technical bias" if direction == "BULLISH" else "Bearish technical bias"
        setup_status = f"MACRO TREND {final_signal} — sustained move over recent hours"
        reason = macro_trend.get("reason", reason)

    levels = None
    if final_signal in ("BUY", "SELL"):
        if signal_source == "macro":
            levels = compute_macro_trade_levels(final_signal, current_price, float(sfs.get("atr_14") or analysis_15m.get("atr_14") or 0))
        else:
            levels = compute_engine_candidate_levels(sfs, current_price)
    if levels:
        buy_ok = final_signal == "BUY" and levels["stop_loss_price"] < levels["entry_price"] < levels["target_1_price"] < levels["target_2_price"]
        sell_ok = final_signal == "SELL" and levels["target_2_price"] < levels["target_1_price"] < levels["entry_price"] < levels["stop_loss_price"]
        if not (buy_ok or sell_ok):
            levels = None
            final_signal = "HOLD"
            reason = "Candidate levels failed validation ordering, so no confirmed setup was accepted."
            setup_status = "Mixed technical setup — wait"
            risk = "HIGH"

    if levels:
        entry_idea = f"Educational candidate entry: ${levels['entry_price']:,.2f}"
        stop_loss_idea = f"Educational candidate invalidation: ${levels['stop_loss_price']:,.2f}"
        target_1, target_2 = f"${levels['target_1_price']:,.2f}", f"${levels['target_2_price']:,.2f}"
        confirmation_needed = "No extra confirmation required by the current engine rules."
        entry_price, stop_loss_price = levels["entry_price"], levels["stop_loss_price"]
        target_1_price, target_2_price = levels["target_1_price"], levels["target_2_price"]
    else:
        entry_idea = "No educational entry idea while technical signals are mixed."
        stop_loss_idea = "No trade is preferred until a clearer setup appears."
        target_1, target_2 = "--", "--"
        entry_price = stop_loss_price = target_1_price = target_2_price = 0
        pending = waiting_filters + failed_filters
        confirmation_needed = "; ".join(pending) if pending else "Wait for 15m, 1h and 4h trend/momentum alignment."

    def timeframe_data(analysis, signal_value):
        return {"signal": signal_value, "summary": f"{analysis['trend']} trend; RSI {analysis['rsi_14']}; {analysis['macd']['state']}.", "key_level": f"${analysis['support_resistance']['support_20']:,.2f} / ${analysis['support_resistance']['resistance_20']:,.2f}"}

    return {
        "signal": final_signal,
        "confidence": confidence,
        "reason": reason,
        "risk": risk,
        "market_bias": market_bias,
        "setup_status": setup_status,
        "confirmation_needed": confirmation_needed,
        "entry_idea": entry_idea,
        "stop_loss_idea": stop_loss_idea,
        "target_1": target_1,
        "target_2": target_2,
        "entry_price": entry_price,
        "stop_loss_price": stop_loss_price,
        "target_1_price": target_1_price,
        "target_2_price": target_2_price,
        # Engine candidate levels are shown in the card only — never plotted on the chart.
        "overlay_allowed": False,
        "provider": "ENGINE",
        "manual_run_only": False,
        "swing_failure_structure": sfs,
        "timeframes": {"15m": timeframe_data(analysis_15m, signal_15m), "1h": timeframe_data(analysis_1h, signal_1h), "4h": timeframe_data(analysis_4h, signal_4h)},
    }


def build_setup_quality(market_data, technical_result):
    timeframes = market_data.get("timeframes", {})
    m15, m1h, m4h = timeframes.get("15m", {}), timeframes.get("1h", {}), timeframes.get("4h", {})
    agreement = calculate_timeframe_agreement(market_data)
    regime = calculate_market_regime(market_data)
    levels = calculate_key_level_distance(market_data)
    signal = str(technical_result.get("signal", "NO TRADE")).upper()
    direction = "BUY" if "BUY" in signal else "SELL" if "SELL" in signal else "NEUTRAL"
    items, flags = [], []

    def add(key, label, state, reason):
        items.append({"key": key, "label": label, "state": state, "reason": reason})

    agreement_percent = float(agreement.get("percent", 0))
    if direction != "NEUTRAL" and agreement_percent >= 67:
        add("trend_alignment", "Multi-timeframe trend alignment", "PASS", f"{agreement.get('direction', 'Aligned')} alignment across 15m, 1h and 4h ({agreement_percent:.0f}%).")
    elif agreement_percent >= 67:
        add("trend_alignment", "Multi-timeframe trend alignment", "WAIT", f"Timeframes agree on HOLD rather than a directional setup ({agreement_percent:.0f}%).")
    else:
        add("trend_alignment", "Multi-timeframe trend alignment", "FAIL", f"Timeframes are mixed ({agreement_percent:.0f}% agreement).")
        flags.append("Mixed timeframe direction")
    regime_label = str(regime.get("label", "Ranging"))
    average_adx = float(regime.get("average_adx", 0))
    if regime_label == "Trending":
        add("market_regime", "Market regime suitability", "PASS", f"Trending regime with average ADX {average_adx:.1f} supports directional setups.")
    elif regime_label == "High Volatility":
        add("market_regime", "Market regime suitability", "WAIT", "High volatility can create opportunity, but needs reduced size and wider invalidation.")
        flags.append("High volatility")
    else:
        add("market_regime", "Market regime suitability", "WAIT", f"{regime_label} conditions need extra confirmation before a directional practice trade.")
    rsi_values = [float(m15.get("rsi_14", 50)), float(m1h.get("rsi_14", 50)), float(m4h.get("rsi_14", 50))]
    momentum_values = [float(m15.get("momentum_percent", 0)), float(m1h.get("momentum_percent", 0)), float(m4h.get("momentum_percent", 0))]
    momentum_ok = (direction == "BUY" and sum(50 <= value <= 72 for value in rsi_values) >= 2 and sum(value >= 0 for value in momentum_values) >= 2) or (direction == "SELL" and sum(28 <= value <= 50 for value in rsi_values) >= 2 and sum(value <= 0 for value in momentum_values) >= 2)
    add("momentum", "RSI and momentum confirmation", "PASS" if momentum_ok else "WAIT", "At least two timeframes support the live direction without an extreme RSI reading." if momentum_ok else "RSI or momentum does not yet confirm the live direction on enough timeframes.")
    macd_states = [str(item.get("macd", {}).get("state", "")).lower() for item in [m15, m1h, m4h]]
    macd_count = sum("bullish" in state for state in macd_states) if direction == "BUY" else sum("bearish" in state for state in macd_states) if direction == "SELL" else 0
    if macd_count >= 2:
        add("macd", "MACD confirmation", "PASS", f"MACD agrees with the directional setup on {macd_count} of 3 timeframes.")
    elif macd_count == 1:
        add("macd", "MACD confirmation", "WAIT", "MACD confirmation is present on only one timeframe.")
    else:
        state = "FAIL" if direction != "NEUTRAL" else "WAIT"
        add("macd", "MACD confirmation", state, "MACD does not currently support a consistent directional setup.")
        if direction != "NEUTRAL":
            flags.append("MACD disagreement")
    volume_15m = float(m15.get("volume", {}).get("volume_ratio", 0))
    volume_1h = float(m1h.get("volume", {}).get("volume_ratio", 0))
    taker_buy_ratio = float(m15.get("volume", {}).get("taker_buy_ratio_20_percent", 50))
    volume_ok = (volume_15m >= 1.0 or volume_1h >= 1.0) and ((direction == "BUY" and taker_buy_ratio >= 50) or (direction == "SELL" and taker_buy_ratio <= 50))
    add("volume", "Volume confirmation", "PASS" if volume_ok else "WAIT", f"Volume status: 15m x{volume_15m:.2f}, 1h x{volume_1h:.2f}.")
    breakout = str(m15.get("breakout_status", "No confirmed breakout"))
    structure = str(m1h.get("market_structure", "Range / mixed structure"))
    structure_ok = (direction == "BUY" and ("bullish breakout" in breakout.lower() or "bullish" in structure.lower())) or (direction == "SELL" and ("bearish breakdown" in breakout.lower() or "bearish" in structure.lower()))
    add("structure", "Breakout or market structure", "PASS" if structure_ok else "WAIT", f"15m: {breakout}. 1h: {structure}.")
    level_15m = levels.get("15m", {})
    support_distance = float(level_15m.get("support_distance_percent") or 0)
    resistance_distance = float(level_15m.get("resistance_distance_percent") or 0)
    level_ok = resistance_distance >= 0.35 if direction == "BUY" else support_distance >= 0.35 if direction == "SELL" else False
    level_reason = f"Nearest 15m resistance is {resistance_distance:.2f}% above price." if direction == "BUY" else f"Nearest 15m support is {support_distance:.2f}% below price." if direction == "SELL" else "No directional setup is active for a level-distance assessment."
    add("key_levels", "Support/resistance proximity", "PASS" if level_ok else "WAIT" if direction != "NEUTRAL" else "FAIL", level_reason)
    if direction != "NEUTRAL" and not level_ok:
        flags.append("Limited room to key level")
    risk_reward_ok = direction != "NEUTRAL" and level_ok and float(m15.get("atr_percent", 0)) > 0
    add("risk_reward", "Risk/reward feasibility", "PASS" if risk_reward_ok else "WAIT", "A measurable invalidation and enough target room are available." if risk_reward_ok else "Wait for a clearer trigger, invalidation, and target distance before any practice trade.")
    add("ai_alignment", "Gemini AI vs live technical alignment", "WAIT", "Browser checks this against the most recent Gemini result. Run Gemini AI Analysis for a fresh comparison.")
    passed = sum(item["state"] == "PASS" for item in items)
    waiting = sum(item["state"] == "WAIT" for item in items)
    failed = sum(item["state"] == "FAIL" for item in items)
    if direction == "NEUTRAL" or failed >= 2:
        grade, execution_state, decision_reason = "D", "AVOID", "Live conditions are mixed or have major checklist failures. Avoid forcing a practice entry."
    elif passed >= 7 and failed == 0:
        grade, execution_state, decision_reason = "A", "READY", "Most technical conditions are aligned. Still wait for the stated trigger and define invalidation."
    elif passed >= 5 and failed <= 1:
        grade, execution_state, decision_reason = "B", "WAIT FOR TRIGGER", "The setup is developing, but a trigger or additional confirmation is still needed."
    else:
        grade, execution_state, decision_reason = "C", "WAIT / LOW QUALITY", "Checklist quality is incomplete. Wait for better alignment rather than forcing a trade."
    return {"grade": grade, "execution_state": execution_state, "direction": direction, "score": {"passed": passed, "waiting": waiting, "failed": failed, "total": len(items)}, "decision_reason": decision_reason, "risk_flags": flags, "items": items}


def build_market_data():
    ticker = get_btc_ticker()
    candles_15m = get_btc_klines(interval="15m", limit=250)
    analysis_15m = calculate_market_indicators(candles_15m, "15m")
    analysis_1h = calculate_market_indicators(get_btc_klines(interval="1h", limit=250), "1h")
    analysis_4h = calculate_market_indicators(get_btc_klines(interval="4h", limit=250), "4h")
    analysis_15m["swing_failure_structure"] = calculate_swing_failure_structure(
        candles_15m,
        analysis_15m["atr_14"],
        volume_ratio=analysis_15m["volume"]["volume_ratio"],
        rsi_value=analysis_15m["rsi_14"],
        macd_state=analysis_15m["macd"]["state"],
        trend_1h=analysis_1h["trend"],
        trend_4h=analysis_4h["trend"],
    )
    analysis_15m["macro_trend"] = calculate_macro_trend_signal(candles_15m)
    return {"symbol": "BTCUSDT", "current_price_usdt": round_value(ticker["lastPrice"]), "price_change_24h_percent": round_value(ticker["priceChangePercent"]), "high_24h_usdt": round_value(ticker["highPrice"]), "low_24h_usdt": round_value(ticker["lowPrice"]), "quote_volume_24h_usdt": round_value(ticker["quoteVolume"]), "timeframes": {"15m": analysis_15m, "1h": analysis_1h, "4h": analysis_4h}}


def get_technical_market_data(force_refresh=False):
    now = time.time()
    cache_age = now - technical_cache["updated_at"]
    if not force_refresh and technical_cache["data"] and cache_age < TECHNICAL_CACHE_SECONDS:
        return technical_cache["data"], True, cache_age, None
    try:
        market_data = build_market_data()
        technical_cache["data"], technical_cache["updated_at"] = market_data, now
        return market_data, False, 0.0, None
    except (requests.exceptions.RequestException, ValueError) as error:
        if technical_cache["data"]:
            cached_age = now - technical_cache["updated_at"]
            return technical_cache["data"], True, cached_age, str(error)
        raise HTTPException(status_code=502, detail="Live technical market data is temporarily unavailable.") from error


def build_data_health(cached, cache_age, refresh_error=None):
    if refresh_error:
        status = "DELAYED" if cache_age <= TECHNICAL_DELAYED_SECONDS else "ERROR"
        message = "Live refresh failed. Showing the most recent saved technical data."
    elif cached:
        status, message = "CACHED", "Recent technical data is being served from cache."
    else:
        status, message = "LIVE", "Fresh Binance market data was received successfully."
    return {"status": status, "message": message, "cached": cached, "cache_age_seconds": round_value(max(cache_age, 0), 1), "refresh_error": refresh_error, "technical_cache_seconds": TECHNICAL_CACHE_SECONDS}


def build_technical_response(market_data, cached=False, cache_age=0.0, refresh_error=None):
    result = technical_main_signal(market_data)
    result.update({"market_data": market_data, "source": "Binance live technical analysis", "analysis_mode": "technical_fallback", "cached": cached, "updated_at": int(time.time()), "data_health": build_data_health(cached, cache_age, refresh_error), "score_breakdown": calculate_score_breakdown(market_data), "market_regime": calculate_market_regime(market_data), "timeframe_agreement": calculate_timeframe_agreement(market_data), "key_level_distance": calculate_key_level_distance(market_data)})
    result["setup_quality"] = build_setup_quality(market_data, result)
    result["disclaimer"] = "Educational market analysis only. Not financial advice or an automated trading instruction."
    return result


def build_rrg_data(interval):
    settings = {"1h": {"limit": 220, "lookback": 60, "tail": 4}, "1d": {"limit": 220, "lookback": 30, "tail": 4}}
    if interval not in settings:
        raise ValueError("Unsupported RRG interval.")
    config = settings[interval]
    benchmark_symbol, plotted_symbols = "ETHUSDT", ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    candle_sets = {symbol: get_klines(symbol, interval, config["limit"]) for symbol in plotted_symbols}
    close_sets = {symbol: [float(candle[4]) for candle in candle_sets[symbol]] for symbol in plotted_symbols}
    timestamps = [int(candle[0]) for candle in candle_sets[benchmark_symbol]]
    benchmark, lookback, tail, trails = close_sets[benchmark_symbol], config["lookback"], config["tail"], []
    for symbol in plotted_symbols:
        if symbol == benchmark_symbol:
            points = [{"x": 100.0, "y": 100.0, "timestamp": timestamps[index]} for index in range(max(0, len(timestamps) - tail), len(timestamps))]
            trails.append({"symbol": benchmark_symbol, "points": points, "direction": "Flat"})
            continue
        ratios = [(asset / base) * 100 for asset, base in zip(close_sets[symbol], benchmark)]
        ratio_sma = [average(ratios[index - lookback + 1:index + 1]) if index >= lookback - 1 else None for index in range(len(ratios))]
        ratio_index = [(ratios[index] / ratio_sma[index]) * 100 if ratio_sma[index] else None for index in range(len(ratios))]
        momentum_sma = [average([value for value in ratio_index[index - 9:index + 1] if value is not None]) if index >= lookback + 8 and ratio_index[index] is not None else None for index in range(len(ratio_index))]
        momentum_index = [(ratio_index[index] / momentum_sma[index]) * 100 if momentum_sma[index] else None for index in range(len(ratio_index))]
        valid_points = [{"x": round_value(ratio_index[index], 2), "y": round_value(momentum_index[index], 2), "timestamp": timestamps[index]} for index in range(len(ratio_index)) if ratio_index[index] is not None and momentum_index[index] is not None]
        direction = "Flat"
        if len(valid_points) >= 2:
            dx, dy = valid_points[-1]["x"] - valid_points[-2]["x"], valid_points[-1]["y"] - valid_points[-2]["y"]
            direction = "Flat" if abs(dx) < 0.03 and abs(dy) < 0.03 else "North-East" if dx >= 0 and dy >= 0 else "South-East" if dx >= 0 else "North-West" if dy >= 0 else "South-West"
        trails.append({"symbol": symbol, "points": valid_points[-tail:], "direction": direction})
    return {"benchmark": benchmark_symbol, "interval": interval, "tail_points": tail, "trails": trails, "source": "Binance market data", "updated_at": int(time.time()), "disclaimer": "BTC and SOL are compared with ETH as benchmark in this RRG-style normalized relative-strength visualization. It is not official JdK RRG and is not financial advice."}


def strip_html(text):
    text = str(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    replacements = {"&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">"}
    for old, new in replacements.items():
        text = text.replace(old, new)
    return " ".join(text.split())


# ================= NEWS (publishers' RSS feeds, no AI) =================
# Headlines, a short summary, the story's picture and a link to the
# original article, straight from each publisher's own RSS feed. English
# feeds are crypto sites; Hindi feeds are business sections filtered to
# crypto stories. Cached for a few minutes; a feed that fails is skipped.
import concurrent.futures
import hashlib
import html as html_lib
import threading
import xml.etree.ElementTree as element_tree
from email.utils import parsedate_to_datetime

NEWS_CACHE_SECONDS = 180
NEWS_FEED_TIMEOUT_SECONDS = 10
NEWS_IMAGE_TIMEOUT_SECONDS = 6
NEWS_MAX_AGE_SECONDS = 7 * 24 * 3600
NEWS_LIMIT = 80
NEWS_SOURCES = {
    "en": [
        {"name": "CoinDesk", "site": "coindesk.com", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
        {"name": "Cointelegraph", "site": "cointelegraph.com", "url": "https://cointelegraph.com/rss"},
        {"name": "Decrypt", "site": "decrypt.co", "url": "https://decrypt.co/feed"},
        {"name": "Bitcoin Magazine", "site": "bitcoinmagazine.com", "url": "https://bitcoinmagazine.com/.rss/full/"},
        {"name": "CryptoSlate", "site": "cryptoslate.com", "url": "https://cryptoslate.com/feed/"},
        {"name": "The Block", "site": "theblock.co", "url": "https://www.theblock.co/rss.xml"},
        {"name": "U.Today", "site": "u.today", "url": "https://u.today/rss"},
        {"name": "CryptoPotato", "site": "cryptopotato.com", "url": "https://cryptopotato.com/feed/"},
    ],
    "hi": [
        {"name": "Economic Times Hindi", "site": "hindi.economictimes.com", "url": "https://hindi.economictimes.com/rssfeeds/1286551815.cms"},
        {"name": "Moneycontrol Hindi", "site": "hindi.moneycontrol.com", "url": "https://hindi.moneycontrol.com/rss/latestnews.xml"},
        {"name": "Live Hindustan", "site": "livehindustan.com", "url": "https://www.livehindustan.com/rss/business"},
        {"name": "News18 Hindi", "site": "hindi.news18.com", "url": "https://hindi.news18.com/rss/khabar/business/business.xml"},
        {"name": "Zee Business Hindi", "site": "zeebiz.com", "url": "https://www.zeebiz.com/hindi/rss"},
        {"name": "Amar Ujala", "site": "amarujala.com", "url": "https://www.amarujala.com/rss/business.xml"},
        {"name": "Dainik Bhaskar", "site": "bhaskar.com", "url": "https://www.bhaskar.com/rss-v1--category-1051.xml"},
    ],
}
# A story counts as crypto news when it mentions one of these.
NEWS_CRYPTO_WORDS = {
    "en": ("bitcoin", "btc", "crypto", "ethereum", "ether", "solana", "xrp", "stablecoin", "blockchain", "defi", "token", "altcoin", "etf", "binance", "coinbase", "web3", "nft", "memecoin", "dogecoin", "tether", "usdt", "mining"),
    "hi": ("क्रिप्टो", "बिटकॉइन", "बिटकॉईन", "बिटक्वाइन", "इथेरियम", "ईथर", "ब्लॉकचेन", "ब्लॉक चेन", "डिजिटल करेंसी", "डिजिटल मुद्रा", "डिजिटल रुपया", "वर्चुअल करेंसी", "वर्चुअल डिजिटल", "स्टेबलकॉइन", "टोकन", "वेब3", "crypto", "bitcoin", "ethereum", "blockchain", "cbdc", "web3", "vda"),
}
NEWS_COIN_TERMS = {
    "BTC": ("bitcoin", "btc", "बिटकॉइन", "बिटकॉईन", "बिटक्वाइन"),
    "ETH": ("ethereum", "ether", "eth", "इथेरियम", "ईथर"),
    "SOL": ("solana", "sol"),
    "XRP": ("xrp", "ripple"),
    "BNB": ("bnb",),
    "DOGE": ("dogecoin", "doge"),
    "ADA": ("cardano", "ada"),
    "TON": ("toncoin",),
    "TRX": ("tron", "trx"),
    "AVAX": ("avalanche", "avax"),
    "LINK": ("chainlink",),
    "DOT": ("polkadot",),
    "SUI": ("sui",),
    "LTC": ("litecoin", "ltc"),
    "SHIB": ("shiba inu", "shib"),
    "PEPE": ("pepe",),
    "USDT": ("tether", "usdt"),
}
_NEWS_COIN_RES = {coin: re.compile(r"(?<![\w])(" + "|".join(re.escape(t) for t in terms) + r")(?![\w])", re.I) for coin, terms in NEWS_COIN_TERMS.items()}
NEWS_NS = {
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "atom": "http://www.w3.org/2005/Atom",
}
NEWS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; CryptoDockNews/1.0; +https://crypto.marketdock.in)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
}
news_cache = {}
news_image_cache = {}
news_locks = {"en": threading.Lock(), "hi": threading.Lock()}
_IMG_SRC_RE = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.I)
_OG_IMAGE_RE = re.compile(r"<meta[^>]+(?:property|name)=[\"'](?:og:image|twitter:image)(?::src)?[\"'][^>]*>", re.I)
_CONTENT_ATTR_RE = re.compile(r"content=[\"']([^\"']+)[\"']", re.I)


def _news_text(node, path):
    found = node.find(path, NEWS_NS)
    return (found.text or "").strip() if found is not None and found.text else ""


def _news_clean_url(url):
    url = html_lib.unescape(str(url or "").strip())
    return url if url.startswith(("https://", "http://")) else ""


def _news_time(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _news_item_image(item, raw_html):
    """The story's picture from the feed itself: media:content / media:thumbnail,
    an image enclosure, or the first <img> in the article body."""
    for media in item.findall("media:content", NEWS_NS) + item.findall("media:group/media:content", NEWS_NS):
        url = _news_clean_url(media.get("url"))
        kind = (media.get("medium") or media.get("type") or "").lower()
        if url and ("image" in kind or re.search(r"\.(jpe?g|png|webp|gif)(\?|$)", url, re.I) or not kind):
            return url
    for thumb in item.findall("media:thumbnail", NEWS_NS) + item.findall("media:group/media:thumbnail", NEWS_NS):
        url = _news_clean_url(thumb.get("url"))
        if url:
            return url
    for enclosure in item.findall("enclosure") + item.findall("atom:link[@rel='enclosure']", NEWS_NS):
        url = _news_clean_url(enclosure.get("url") or enclosure.get("href"))
        if url and "image" in (enclosure.get("type") or "image").lower():
            return url
    for chunk in raw_html:
        match = _IMG_SRC_RE.search(chunk or "")
        if match:
            url = _news_clean_url(match.group(1))
            if url:
                return url
    return ""


def _news_page_image(url):
    """og:image from the article page, for feeds that carry no picture."""
    if url in news_image_cache:
        return news_image_cache[url]
    image = ""
    try:
        response = requests.get(url, timeout=NEWS_IMAGE_TIMEOUT_SECONDS, headers={"User-Agent": NEWS_HEADERS["User-Agent"]}, stream=True)
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_content(16_384):
            chunks.append(chunk)
            size += len(chunk)
            if size >= 200_000:
                break
        response.close()
        head = b"".join(chunks).decode(response.encoding or "utf-8", errors="ignore")
        for tag in _OG_IMAGE_RE.findall(head):
            content = _CONTENT_ATTR_RE.search(tag)
            if content and _news_clean_url(content.group(1)):
                image = _news_clean_url(content.group(1))
                break
    except Exception:  # best effort: a story without a picture is fine
        image = ""
    if len(news_image_cache) > 2000:
        news_image_cache.clear()
    news_image_cache[url] = image
    return image


def _news_coins(text):
    return [coin for coin, pattern in _NEWS_COIN_RES.items() if pattern.search(text)]


def _fetch_news_feed(source, lang, now):
    response = requests.get(source["url"], timeout=NEWS_FEED_TIMEOUT_SECONDS, headers=NEWS_HEADERS)
    response.raise_for_status()
    root = element_tree.fromstring(response.content)
    nodes = root.findall(".//item") or root.findall(".//atom:entry", NEWS_NS)
    words = NEWS_CRYPTO_WORDS[lang]
    items = []
    for node in nodes[:60]:
        is_atom = node.tag.endswith("entry")
        if is_atom:
            title = _news_text(node, "atom:title")
            link = node.find("atom:link[@rel='alternate']", NEWS_NS) or node.find("atom:link", NEWS_NS)
            url = _news_clean_url(link.get("href") if link is not None else "")
            body = _news_text(node, "atom:content")
            summary_raw = _news_text(node, "atom:summary") or body
            published = _news_time(_news_text(node, "atom:published") or _news_text(node, "atom:updated"))
        else:
            title = _news_text(node, "title")
            url = _news_clean_url(_news_text(node, "link") or _news_text(node, "guid"))
            body = _news_text(node, "content:encoded")
            summary_raw = _news_text(node, "description") or body
            published = _news_time(_news_text(node, "pubDate") or _news_text(node, "dc:date"))
        title = strip_html(html_lib.unescape(title))
        summary = strip_html(html_lib.unescape(summary_raw))
        if not title or not url:
            continue
        if published and now - published > NEWS_MAX_AGE_SECONDS:
            continue
        text = f"{title} {summary}"
        lowered = text.lower()
        # Crypto sites: everything is crypto. Hindi business feeds: keep
        # only the crypto stories.
        if lang == "hi" and not any(word in lowered for word in words):
            continue
        if len(summary) > 280:
            summary = summary[:277].rsplit(" ", 1)[0] + "…"
        items.append({
            "id": hashlib.sha1(url.encode("utf-8")).hexdigest()[:16],
            "title": title[:240],
            "summary": summary,
            "url": url[:1000],
            "source": source["name"],
            "site": source["site"],
            "image": _news_item_image(node, (body, summary_raw)),
            "published": published,
            "coins": _news_coins(text),
        })
    return items


def build_news(lang):
    now = int(time.time())
    sources = NEWS_SOURCES[lang]
    collected, ok = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_news_feed, source, lang, now): source for source in sources}
        for future in concurrent.futures.as_completed(futures):
            try:
                collected.extend(future.result())
                ok += 1
            except Exception as error:  # one broken feed must not hide the others
                print(f"News feed unavailable ({futures[future]['name']}): {error}")
    seen_urls, seen_titles, items = set(), set(), []
    for item in sorted(collected, key=lambda x: x["published"] or 0, reverse=True):
        url_key = item["url"].split("?")[0].rstrip("/").lower()
        title_key = re.sub(r"\W+", " ", item["title"].lower()).strip()
        if url_key in seen_urls or title_key in seen_titles:
            continue
        seen_urls.add(url_key)
        seen_titles.add(title_key)
        items.append(item)
        if len(items) >= NEWS_LIMIT:
            break
    # Stories whose feed has no picture: take the article's own og:image.
    missing = [item for item in items[:40] if not item["image"]]
    if missing:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for item, image in zip(missing, pool.map(lambda it: _news_page_image(it["url"]), missing)):
                item["image"] = image
    return {"lang": lang, "items": items, "updated_at": now, "sources_ok": ok, "sources_total": len(sources)}


@app.get("/api/news")
def news(lang: str = "en"):
    """Latest crypto news (no AI): title, summary, picture, source and link."""
    lang = "hi" if str(lang).lower().startswith("hi") else "en"
    cached = news_cache.get(lang)
    now = time.time()
    if cached and now - cached["at"] < NEWS_CACHE_SECONDS:
        return cached["data"]
    with news_locks[lang]:
        cached = news_cache.get(lang)
        if cached and time.time() - cached["at"] < NEWS_CACHE_SECONDS:
            return cached["data"]
        data = build_news(lang)
        if not data["items"] and cached:
            # Every feed failed this time: keep showing the last good list.
            return {**cached["data"], "stale": True}
        news_cache[lang] = {"data": data, "at": time.time()}
        return data


# ================= ALL COINS (MARKETS) =================
# Every coin Binance trades against USDT on spot, with 24h stats, plus the
# USDT→INR rate so the app can show both $ and ₹. Shared caches keep this to
# one Binance call per few seconds no matter how many people have it open.
MARKETS_CACHE_SECONDS = 3
SYMBOLS_CACHE_SECONDS = 3600
USDT_INR_CACHE_SECONDS = 300
# Stablecoins and fiat pairs aren't coins anyone trades for price moves, and
# leveraged tokens (BTCUP/BTCDOWN...) are delisted products — keep them out.
EXCLUDED_BASES = {"USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PAX", "USDS", "AEUR", "EUR", "GBP", "AUD", "TRY", "BRL", "EURI", "XUSD", "USD1", "BFUSD"}
LEVERAGED_SUFFIXES = ("UP", "DOWN", "BULL", "BEAR")

markets_cache = {"data": None, "updated_at": 0}
symbols_cache = {"data": None, "updated_at": 0}
usdt_inr_cache = {"rate": None, "source": None, "updated_at": 0}


def get_usdt_symbols():
    now = time.time()
    if symbols_cache["data"] and now - symbols_cache["updated_at"] < SYMBOLS_CACHE_SECONDS:
        return symbols_cache["data"]
    response = requests.get(f"{BINANCE_BASE_URL}/api/v3/exchangeInfo", params={"permissions": "SPOT"}, timeout=20)
    response.raise_for_status()
    symbols = {}
    for item in response.json().get("symbols", []):
        base = item.get("baseAsset", "")
        if item.get("quoteAsset") != "USDT" or item.get("status") != "TRADING":
            continue
        if base in EXCLUDED_BASES or (len(base) > 4 and base.endswith(LEVERAGED_SUFFIXES)):
            continue
        symbols[item["symbol"]] = base
    symbols_cache["data"], symbols_cache["updated_at"] = symbols, now
    return symbols


def get_usdt_inr_rate():
    """USDT price in rupees, refreshed every few minutes; last good value on failure."""
    now = time.time()
    if usdt_inr_cache["rate"] and now - usdt_inr_cache["updated_at"] < USDT_INR_CACHE_SECONDS:
        return usdt_inr_cache["rate"], usdt_inr_cache["source"]
    sources = [
        ("CoinGecko", "https://api.coingecko.com/api/v3/simple/price", {"ids": "tether", "vs_currencies": "inr"}, lambda d: d["tether"]["inr"]),
        ("ExchangeRate-API", "https://open.er-api.com/v6/latest/USD", None, lambda d: d["rates"]["INR"]),
    ]
    for name, url, params, pick in sources:
        try:
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            rate = float(pick(response.json()))
            if rate > 0:
                usdt_inr_cache.update(rate=rate, source=name, updated_at=now)
                return rate, name
        except (requests.exceptions.RequestException, KeyError, TypeError, ValueError):
            continue
    return usdt_inr_cache["rate"], usdt_inr_cache["source"]


def build_markets():
    symbols = get_usdt_symbols()
    response = requests.get(f"{BINANCE_BASE_URL}/api/v3/ticker/24hr", params={"type": "MINI"}, timeout=20)
    response.raise_for_status()
    coins = []
    for ticker in response.json():
        base = symbols.get(ticker.get("symbol"))
        if not base:
            continue
        try:
            price = float(ticker["lastPrice"])
            open_price = float(ticker["openPrice"])
            quote_volume = float(ticker["quoteVolume"])
        except (KeyError, TypeError, ValueError):
            continue
        if price <= 0:
            continue
        coins.append({
            "symbol": ticker["symbol"],
            "base": base,
            "price": price,
            "change_percent": round((price - open_price) / open_price * 100, 2) if open_price else 0.0,
            "high": float(ticker.get("highPrice") or 0),
            "low": float(ticker.get("lowPrice") or 0),
            "volume_usdt": quote_volume,
        })
    coins.sort(key=lambda coin: coin["volume_usdt"], reverse=True)
    rate, rate_source = get_usdt_inr_rate()
    return {"coins": coins, "count": len(coins), "usdt_inr": rate, "usdt_inr_source": rate_source, "source": "Binance", "updated_at": int(time.time())}


@app.get("/api/markets")
def markets():
    now = time.time()
    cached = markets_cache["data"]
    if cached and now - markets_cache["updated_at"] < MARKETS_CACHE_SECONDS:
        return {**cached, "cached": True}
    try:
        result = build_markets()
        markets_cache["data"], markets_cache["updated_at"] = result, now
        return {**result, "cached": False}
    except (requests.exceptions.RequestException, ValueError) as error:
        if cached:
            return {**cached, "cached": True, "warning": "Live market feed is temporarily unavailable. Showing last saved prices."}
        raise HTTPException(status_code=502, detail=f"Could not load coin prices from Binance: {str(error)}") from error


COIN_CANDLE_INTERVALS = {"15m", "1h", "4h", "1d", "1w"}
COIN_CANDLES_CACHE_SECONDS = 15
coin_candles_cache = {}


@app.get("/api/coin/candles")
def coin_candles(symbol: str = "BTCUSDT", interval: str = "1h", limit: int = 300):
    """Candles for any coin on the all-coins list (Coin Detail chart)."""
    symbol = (symbol or "").strip().upper()
    if interval not in COIN_CANDLE_INTERVALS:
        raise HTTPException(status_code=400, detail="Unsupported candle interval.")
    safe_limit = max(20, min(int(limit), 1000))
    cache_key = f"{symbol}:{interval}:{safe_limit}"
    now = time.time()
    cached = coin_candles_cache.get(cache_key)
    if cached and now - cached["updated_at"] < COIN_CANDLES_CACHE_SECONDS:
        return cached["data"]
    try:
        if symbol not in get_usdt_symbols():
            raise HTTPException(status_code=404, detail="Unknown coin.")
        raw = get_klines(symbol, interval, safe_limit)
    except requests.exceptions.RequestException as error:
        if cached:
            return cached["data"]
        raise HTTPException(status_code=502, detail=f"Could not load candles from Binance: {str(error)}") from error
    candles = [{"time": int(int(c[0]) / 1000), "open": float(c[1]), "high": float(c[2]), "low": float(c[3]), "close": float(c[4]), "volume": float(c[5])} for c in raw]
    data = {"symbol": symbol, "interval": interval, "candles": candles, "source": "Binance", "updated_at": int(now)}
    # Bounded: one entry per coin/interval someone actually opened.
    if len(coin_candles_cache) > 500:
        coin_candles_cache.clear()
    coin_candles_cache[cache_key] = {"data": data, "updated_at": now}
    return data


COIN_DEPTH_CACHE_SECONDS = 2
coin_depth_cache = {}


@app.get("/api/coin/depth")
def coin_depth(symbol: str = "BTCUSDT"):
    """Top 5 bids and asks from Binance's order book (coin sheet's Market Depth)."""
    symbol = (symbol or "").strip().upper()
    now = time.time()
    cached = coin_depth_cache.get(symbol)
    if cached and now - cached["updated_at"] < COIN_DEPTH_CACHE_SECONDS:
        return cached["data"]
    try:
        if symbol not in get_usdt_symbols():
            raise HTTPException(status_code=404, detail="Unknown coin.")
        response = requests.get(f"{BINANCE_BASE_URL}/api/v3/depth", params={"symbol": symbol, "limit": 5}, timeout=10)
        response.raise_for_status()
        book = response.json()
    except requests.exceptions.RequestException as error:
        if cached:
            return cached["data"]
        raise HTTPException(status_code=502, detail=f"Could not load the order book: {str(error)}") from error
    side = lambda rows: [{"price": float(p), "qty": float(q)} for p, q in rows[:5]]
    data = {"symbol": symbol, "bids": side(book.get("bids", [])), "asks": side(book.get("asks", [])), "updated_at": int(now)}
    if len(coin_depth_cache) > 500:
        coin_depth_cache.clear()
    coin_depth_cache[symbol] = {"data": data, "updated_at": now}
    return data


COIN_STATS_CACHE_SECONDS = 3
COIN_PERF_CACHE_SECONDS = 300
coin_stats_cache = {}
coin_perf_cache = {}


def _coin_performance(symbol):
    """7-day and 30-day change and high/low from daily candles (cached 5 min)."""
    now = time.time()
    cached = coin_perf_cache.get(symbol)
    if cached and now - cached["updated_at"] < COIN_PERF_CACHE_SECONDS:
        return cached["data"]
    response = requests.get(f"{BINANCE_BASE_URL}/api/v3/klines", params={"symbol": symbol, "interval": "1d", "limit": 31}, timeout=10)
    response.raise_for_status()
    candles = [{"open": float(c[1]), "high": float(c[2]), "low": float(c[3]), "close": float(c[4])} for c in response.json()]
    data = {}
    for days in (7, 30):
        window = candles[-days:]
        if len(candles) > days:
            # Change from the close `days` days ago to the latest close.
            base_close = candles[-days - 1]["close"]
        else:
            base_close = window[0]["open"] if window else 0
        last = window[-1]["close"] if window else 0
        data[f"d{days}"] = {
            "change_percent": round((last - base_close) / base_close * 100, 2) if base_close else None,
            "high": max((c["high"] for c in window), default=None),
            "low": min((c["low"] for c in window), default=None),
            "days": len(window),
        }
    if len(coin_perf_cache) > 500:
        coin_perf_cache.clear()
    coin_perf_cache[symbol] = {"data": data, "updated_at": now}
    return data


@app.get("/api/coin/stats")
def coin_stats(symbol: str = "BTCUSDT"):
    """Full 24h statistics for one coin plus 7D / 30D performance (Scanner's coin stats sheet)."""
    symbol = (symbol or "").strip().upper()
    now = time.time()
    cached = coin_stats_cache.get(symbol)
    if cached and now - cached["updated_at"] < COIN_STATS_CACHE_SECONDS:
        return cached["data"]
    try:
        if symbol not in get_usdt_symbols():
            raise HTTPException(status_code=404, detail="Unknown coin.")
        response = requests.get(f"{BINANCE_BASE_URL}/api/v3/ticker/24hr", params={"symbol": symbol}, timeout=10)
        response.raise_for_status()
        t = response.json()
        num = lambda key: float(t.get(key) or 0)
        data = {
            "symbol": symbol,
            "price": num("lastPrice"),
            "open": num("openPrice"),
            "high": num("highPrice"),
            "low": num("lowPrice"),
            "change": num("priceChange"),
            "change_percent": num("priceChangePercent"),
            "avg_price": num("weightedAvgPrice"),
            "volume_base": num("volume"),
            "volume_usdt": num("quoteVolume"),
            "trades": int(t.get("count") or 0),
            "bid": num("bidPrice"),
            "ask": num("askPrice"),
            "updated_at": int(now),
        }
    except requests.exceptions.RequestException as error:
        if cached:
            return cached["data"]
        raise HTTPException(status_code=502, detail=f"Could not load coin stats: {str(error)}") from error
    try:
        data["performance"] = _coin_performance(symbol)
    except (requests.exceptions.RequestException, ValueError, KeyError, IndexError, TypeError):
        data["performance"] = (coin_perf_cache.get(symbol) or {}).get("data")
    if len(coin_stats_cache) > 500:
        coin_stats_cache.clear()
    coin_stats_cache[symbol] = {"data": data, "updated_at": now}
    return data


# ================= TRIAL & SUBSCRIPTION (RAZORPAY) =================
# Same model as MarketDock: every email gets one 7-day trial (kept for good —
# logout, account deletion or signing up again never resets it), then a paid
# plan. CryptoDock keeps its own records, so its trial and plans are separate
# from MarketDock's, but it charges through the same Razorpay account.
import hmac

from pydantic import BaseModel

APP_ID = "cryptodock"
TRIAL_SECONDS = 7 * 86400
USER_DB_FILE = os.getenv("CRYPTODOCK_USER_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_subscriptions.json")
PLAN_CATALOG = {
    "Monthly Plan": {"amount": 99, "days": 30},
    "Half-Yearly Plan": {"amount": 299, "days": 180},
    "Annual Plan": {"amount": 499, "days": 365},
}


def _load_env():
    """Fill missing env vars from .env files. MarketDock's .env is read last so
    CryptoDock picks up the same Razorpay keys without copying them."""
    here = os.path.dirname(os.path.abspath(__file__))
    for path in [os.path.join(here, ".env"), "/var/www/CryptoDock/.env", "/opt/marketdock/.env"]:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, value = line.split("=", 1)
                        key, value = key.strip(), value.strip().strip("\"'")
                        if key and not os.environ.get(key):
                            os.environ[key] = value
        except OSError:
            pass


def _load_users():
    if os.path.exists(USER_DB_FILE):
        try:
            with open(USER_DB_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}
    return {}


def _save_users(users):
    tmp = USER_DB_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)
    os.replace(tmp, USER_DB_FILE)


def _norm_email(email):
    return (email or "").strip().lower()


class TrialSyncRequest(BaseModel):
    email: str
    user_id: str = ""


@app.post("/api/user/sync-trial")
def sync_user_trial(req: TrialSyncRequest):
    email = _norm_email(req.email)
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    users = _load_users()
    user = users.get(email)
    if not user or not user.get("created_at"):
        user = user or {"is_paid": False}
        user.setdefault("email", email)
        user.setdefault("user_id", req.user_id)
        user["created_at"] = user.get("trial_start_ts") or int(time.time())
        users[email] = user
        _save_users(users)
    return subscription_status(email)


@app.get("/api/subscription/status")
def subscription_status(email: str = ""):
    email = _norm_email(email)
    if not email:
        return {"is_paid": False, "trial_active": False, "trial_expired": False}
    now = int(time.time())
    user = _load_users().get(email, {})
    valid_until_ts = user.get("valid_until_ts")
    is_paid = bool(user.get("is_paid") and valid_until_ts and now < valid_until_ts)
    # No record yet: the trial clock starts at the first sign-in (sync-trial).
    trial_start_ts = user.get("created_at") or now
    trial_end_ts = trial_start_ts + TRIAL_SECONDS
    trial_expired = now >= trial_end_ts
    return {
        "email": email,
        "is_paid": is_paid,
        "plan": user.get("plan"),
        "valid_until_ts": valid_until_ts,
        "plan_expired": bool(user.get("is_paid") and valid_until_ts and now >= valid_until_ts),
        "trial_start_ts": trial_start_ts,
        "trial_end_ts": trial_end_ts,
        "trial_days_remaining": max(0, math.ceil((trial_end_ts - now) / 86400)),
        "trial_expired": trial_expired,
        "trial_active": not is_paid and not trial_expired,
    }


class PaymentOrderRequest(BaseModel):
    plan_name: str = "Annual Plan"
    email: str = ""


class PaymentVerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str
    email: str = ""


def _razorpay_keys():
    _load_env()
    key_id, key_secret = os.environ.get("RAZORPAY_KEY_ID"), os.environ.get("RAZORPAY_KEY_SECRET")
    if not key_id or not key_secret:
        raise HTTPException(status_code=500, detail="Payments are not set up on the server yet.")
    return key_id, key_secret


@app.get("/api/payment/config")
def payment_config():
    _load_env()
    return {"key_id": os.environ.get("RAZORPAY_KEY_ID", ""), "plans": PLAN_CATALOG}


@app.post("/api/payment/create-order")
def create_payment_order(req: PaymentOrderRequest):
    key_id, key_secret = _razorpay_keys()
    plan = PLAN_CATALOG.get(req.plan_name)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    email = _norm_email(req.email)
    if not email:
        raise HTTPException(status_code=400, detail="Please sign in before buying a plan.")
    try:
        r = requests.post(
            "https://api.razorpay.com/v1/orders",
            auth=(key_id, key_secret),
            json={
                "amount": plan["amount"] * 100,
                "currency": "INR",
                "receipt": f"cd_{int(time.time())}_{plan['amount']}",
                # "app" keeps a CryptoDock payment from unlocking MarketDock
                # (same Razorpay account) and the other way round.
                "notes": {"app": APP_ID, "email": email, "plan": req.plan_name},
            },
            timeout=10,
        )
    except requests.exceptions.RequestException as error:
        raise HTTPException(status_code=502, detail="Could not reach Razorpay. Please try again.") from error
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Razorpay could not create the order.")
    order = r.json()
    return {"order_id": order.get("id"), "amount": plan["amount"] * 100, "currency": "INR", "key_id": key_id, "plan_name": req.plan_name}


@app.post("/api/payment/verify")
def verify_payment(req: PaymentVerifyRequest):
    key_id, key_secret = _razorpay_keys()
    expected = hmac.new(key_secret.encode(), f"{req.razorpay_order_id}|{req.razorpay_payment_id}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, req.razorpay_signature or ""):
        raise HTTPException(status_code=400, detail="Invalid payment signature")
    # Plan, amount and email come from Razorpay's own records, not the browser.
    try:
        order = requests.get(f"https://api.razorpay.com/v1/orders/{req.razorpay_order_id}", auth=(key_id, key_secret), timeout=10).json()
        payment = requests.get(f"https://api.razorpay.com/v1/payments/{req.razorpay_payment_id}", auth=(key_id, key_secret), timeout=10).json()
    except (requests.exceptions.RequestException, ValueError) as error:
        raise HTTPException(status_code=502, detail="Could not confirm the payment with Razorpay") from error
    notes = order.get("notes") if isinstance(order.get("notes"), dict) else {}
    plan_name = notes.get("plan")
    plan = PLAN_CATALOG.get(plan_name)
    expected_paise = plan["amount"] * 100 if plan else None
    if (
        notes.get("app") != APP_ID
        or not plan
        or order.get("amount") != expected_paise
        or payment.get("order_id") != req.razorpay_order_id
        or payment.get("amount") != expected_paise
        or payment.get("status") not in ("captured", "authorized")
    ):
        raise HTTPException(status_code=400, detail="Payment does not match the plan")
    email = _norm_email(notes.get("email"))
    if not email:
        raise HTTPException(status_code=400, detail="Payment has no account email")

    users = _load_users()
    now = int(time.time())
    user = users.setdefault(email, {"email": email, "created_at": now})
    seen = user.setdefault("payment_ids", [])
    if req.razorpay_payment_id not in seen:
        # Renewing early adds to the time already paid for.
        current_until = user.get("valid_until_ts") or 0
        start = current_until if user.get("is_paid") and current_until > now else now
        user.update(is_paid=True, plan=plan_name, amount=plan["amount"], paid_at=now, payment_id=req.razorpay_payment_id, valid_until_ts=start + plan["days"] * 86400)
        seen.append(req.razorpay_payment_id)
        _save_users(users)
    return {"verified": True, "plan": plan_name, "valid_until_ts": user["valid_until_ts"]}


@app.get("/api/health")
def health():
    return {"status": "ok", "message": "CryptoDock backend running", "market_data_source": "Binance"}


@app.get("/api/btc/price")
def btc_price(force_refresh: bool = False):
    now = time.time()
    cache_age = now - price_cache["updated_at"]
    if not force_refresh and price_cache["data"] and cache_age < 15:
        return {**price_cache["data"], "cached": True, "cache_age_seconds": round(cache_age, 1)}
    try:
        ticker = get_btc_ticker()
        current_price = float(ticker["lastPrice"])
        previous_daily_close, daily_change_percent = get_btc_daily_change(current_price)
        result = {"bitcoin": {"usd": current_price, "usd_24h_change": daily_change_percent, "price_change_24h_usd": float(ticker["priceChange"]), "open_price_24h_usd": float(ticker["openPrice"]), "previous_daily_close": previous_daily_close}, "source": "Binance", "daily_change_basis": "Previous completed UTC daily candle close", "cached": False, "updated_at": int(now)}
        price_cache["data"], price_cache["updated_at"] = result, now
        return result
    except (requests.exceptions.RequestException, ValueError) as error:
        if price_cache["data"]:
            return {**price_cache["data"], "cached": True, "warning": "Live market feed is temporarily unavailable. Showing last saved price."}
        raise HTTPException(status_code=502, detail=f"Failed to fetch BTC price from Binance: {str(error)}") from error


@app.get("/api/btc/chart")
def btc_chart(days: int = 7, interval: str = "1h"):
    now = time.time()
    allowed_intervals = {"15m", "1h", "1d", "1w"}
    if interval not in allowed_intervals:
        raise HTTPException(status_code=400, detail="Unsupported chart interval.")
    safe_days = max(1, min(days, 3650))
    cache_key = f"{interval}:{safe_days}"
    candles_needed = {"15m": min(max(safe_days * 96, 48), 1000), "1h": min(max(safe_days * 24, 24), 1000), "1d": min(max(safe_days, 7), 1000), "1w": min(max(math.ceil(safe_days / 7), 8), 1000)}[interval]
    cached_chart = chart_cache["data"].get(cache_key)
    if cached_chart and now - cached_chart["updated_at"] < 60:
        return {**cached_chart, "cached": True}
    try:
        candles = get_btc_klines(interval=interval, limit=candles_needed)
        result = {"prices": [[int(candle[0]), float(candle[4])] for candle in candles], "interval": interval, "days": safe_days, "source": "Binance", "cached": False, "updated_at": int(now)}
        chart_cache["data"][cache_key], chart_cache["updated_at"] = result, now
        return result
    except requests.exceptions.RequestException as error:
        if cached_chart:
            return {**cached_chart, "cached": True, "warning": "Live chart feed is temporarily unavailable. Showing last saved chart."}
        raise HTTPException(status_code=502, detail=f"Failed to fetch BTC chart from Binance: {str(error)}") from error


@app.get("/api/btc/candles")
def btc_candles(interval: str = "15m", limit: int = 200):
    allowed_intervals = {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}
    if interval not in allowed_intervals:
        raise HTTPException(status_code=400, detail="Unsupported candle interval.")
    safe_limit = max(20, min(limit, 1000))
    try:
        raw_candles = get_btc_klines(interval=interval, limit=safe_limit)
        candles = [{"time": int(int(candle[0]) / 1000), "open": float(candle[1]), "high": float(candle[2]), "low": float(candle[3]), "close": float(candle[4]), "volume": float(candle[5])} for candle in raw_candles]
        return {"symbol": "BTCUSDT", "interval": interval, "candles": candles, "source": "Binance", "updated_at": int(time.time())}
    except requests.exceptions.RequestException as error:
        raise HTTPException(status_code=502, detail=f"Could not load Binance candles: {str(error)}") from error


@app.get("/api/technical-signal")
def technical_signal(force_refresh: bool = False):
    market_data, cached, cache_age, refresh_error = get_technical_market_data(force_refresh)
    return build_technical_response(market_data, cached=cached, cache_age=cache_age, refresh_error=refresh_error)


@app.get("/api/rrg")
def rrg(interval: str = "1d"):
    now = time.time()
    if interval not in {"1h", "1d"}:
        raise HTTPException(status_code=400, detail="RRG interval must be 1h or 1d.")
    cached_data = rrg_cache["data"].get(interval)
    cache_ttl = 300 if interval == "1h" else 900
    if cached_data and now - cached_data["updated_at"] < cache_ttl:
        return {**cached_data, "cached": True}
    try:
        result = build_rrg_data(interval)
        rrg_cache["data"][interval], rrg_cache["updated_at"] = result, result["updated_at"]
        return result
    except requests.exceptions.RequestException as error:
        if cached_data:
            return {**cached_data, "cached": True, "warning": "RRG feed unavailable. Showing cached data."}
        raise HTTPException(status_code=502, detail=f"Failed to build RRG data: {str(error)}") from error


@app.post("/api/account/delete")
def delete_account(authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing account session.")
    access_token = authorization.split(" ", 1)[1].strip()

    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        raise HTTPException(
            status_code=503,
            detail="Account deletion is not configured on the server yet.",
        )

    try:
        user_response = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {access_token}",
            },
            timeout=10,
        )
        user_response.raise_for_status()
        user_id = user_response.json().get("id")
        if not user_id:
            raise HTTPException(status_code=401, detail="Could not verify account session.")
    except HTTPException:
        raise
    except Exception as error:
        print(f"Supabase user lookup error: {error}")
        raise HTTPException(status_code=401, detail="Could not verify account session.") from error

    try:
        delete_response = requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            timeout=10,
        )
        if delete_response.status_code not in (200, 204):
            raise HTTPException(status_code=502, detail="Account deletion failed. Please try again.")
    except HTTPException:
        raise
    except Exception as error:
        print(f"Supabase account delete error: {error}")
        raise HTTPException(status_code=502, detail="Account deletion failed. Please try again.") from error

    return {"deleted": True}


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")


@app.get("/favicon.ico")
def favicon_ico():
    return FileResponse("frontend/favicon.ico")


@app.get("/privacy")
def privacy_page():
    return FileResponse("frontend/legal/privacy.html", media_type="text/html")


@app.get("/terms")
def terms_page():
    return FileResponse("frontend/legal/terms.html", media_type="text/html")


@app.get("/robots.txt")
def robots_txt():
    content = "User-agent: *\nAllow: /\n\nSitemap: https://marketdock.in/sitemap.xml\n"
    return Response(content=content, media_type="text/plain")


@app.get("/sitemap.xml")
def sitemap_xml():
    content = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n"
        "  <url>\n"
        "    <loc>https://marketdock.in/</loc>\n"
        "    <changefreq>hourly</changefreq>\n"
        "    <priority>1.0</priority>\n"
        "  </url>\n"
        "</urlset>\n"
    )
    return Response(content=content, media_type="application/xml")
