import os
import json
from datetime import datetime, timedelta
from typing import List, Optional

import requests
import yfinance as yf
import pandas as pd
import pandas_ta as pta
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import anthropic
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Trade Fondamentale", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_api_key = os.getenv("ANTHROPIC_API_KEY", "")
if not _api_key or _api_key == "inserisci_qui_la_tua_chiave":
    print("=" * 60)
    print("⚠️  ANTHROPIC_API_KEY mancante o non configurata!")
    print("   Apri il file .env e inserisci la tua chiave API.")
    print("   L'AI non funzionerà finché non è configurata.")
    print("=" * 60)
client = anthropic.Anthropic(api_key=_api_key or None)

def _extract_text(msg) -> str:
    """Estrai il testo dalla risposta, saltando i thinking blocks."""
    return next((b.text for b in msg.content if b.type == "text"), "")

# In-memory watchlist (persists per session)
_watchlist: List[str] = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "US500"]
_news_cache: Optional[dict] = None
_news_cache_time: Optional[datetime] = None
CACHE_MINUTES = 10

# Cache condivisa notizie → usata da analisi tecnica per contesto macro
_last_analyzed_news: List[dict] = []
_last_calendar_events: List[dict] = []

# ─── PREZZI LIVE (Yahoo Finance) ──────────────────────────────────────────────

# Mapping simbolo interno → ticker Yahoo Finance
SYMBOL_MAP: dict = {
    "XAUUSD": "GC=F",      # Gold Futures
    "XAGUSD": "SI=F",      # Silver Futures
    "USOIL":  "CL=F",      # WTI Crude Oil
    "UKOIL":  "BZ=F",      # Brent Crude Oil
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "USDJPY": "USDJPY=X",
    "GBPJPY": "GBPJPY=X",
    "AUDUSD": "AUDUSD=X",
    "USDCAD": "USDCAD=X",
    "EURJPY": "EURJPY=X",
    "NZDUSD": "NZDUSD=X",
    "USDCHF": "USDCHF=X",
    "EURGBP": "EURGBP=X",
    "BTCUSD": "BTC-USD",
    "ETHUSD": "ETH-USD",
    "US500":  "^GSPC",
    "NASDAQ": "^IXIC",
    "DAX":    "^GDAXI",
}

# Prezzi di fallback (usati se Yahoo Finance non risponde)
MOCK_PRICES: dict = {
    "XAUUSD": 2340.50, "XAGUSD": 27.80,  "USOIL": 78.50,   "UKOIL": 82.30,
    "EURUSD": 1.08520, "GBPUSD": 1.26850, "USDJPY": 149.480, "GBPJPY": 189.850,
    "AUDUSD": 0.65220, "USDCAD": 1.36480, "EURJPY": 162.180, "NZDUSD": 0.59820,
    "USDCHF": 0.90820, "EURGBP": 0.85600, "BTCUSD": 64520.0, "ETHUSD": 3420.0,
    "US500":  5205.0,  "NASDAQ": 18240.0, "DAX":    17950.0,
}

_price_cache: dict = {}
_price_cache_time: Optional[datetime] = None
PRICE_CACHE_SECONDS = 60

_ind_cache: dict = {}
_ind_cache_time: dict = {}
IND_CACHE_MINUTES = 15
_df_cache: dict = {}  # raw OHLCV DataFrame per symbol, same 15min TTL as _ind_cache


def _fmt_price(p: float) -> float:
    """Arrotonda il prezzo in base alla grandezza del valore."""
    if p < 10:    return round(p, 5)
    if p < 100:   return round(p, 3)
    return round(p, 2)

def _ndec(p: float) -> int:
    """Numero di decimali per arrotondamento SL/TP."""
    if p < 10:  return 5
    if p < 100: return 3
    return 2

def _dynamic_briefing_fallback(prices: dict, calendar: list, wl: list) -> dict:
    """Briefing live basato su prezzi Yahoo Finance — usato quando Claude non è disponibile."""
    # ── Calcola sentiment aggregato dai movimenti di prezzo ───────
    sentinel = ["XAUUSD", "US500", "EURUSD", "BTCUSD"]
    moves = [prices.get(s, {}).get("change_pct", 0.0) for s in sentinel if prices.get(s)]
    avg_move = sum(moves) / len(moves) if moves else 0.0
    gold_move = prices.get("XAUUSD", {}).get("change_pct", 0.0)
    spx_move  = prices.get("US500",  {}).get("change_pct", 0.0)

    if spx_move < -0.5 or gold_move > 0.5:
        sentiment, s_icon = "RISK_OFF", "📉"
        s_spiega = f"Equity in calo ({spx_move:+.2f}%), oro in rialzo ({gold_move:+.2f}%) — fuga verso safe-haven"
    elif spx_move > 0.5 and gold_move < 0:
        sentiment, s_icon = "RISK_ON", "📈"
        s_spiega = f"Equity positivo ({spx_move:+.2f}%), dollaro forte — risk-on dominante"
    else:
        sentiment, s_icon = "NEUTRO", "⚖️"
        s_spiega = f"Movimenti contenuti (S&P {spx_move:+.2f}%, Gold {gold_move:+.2f}%) — mercato indeciso"

    # ── Genera setup operativi con SL/TP sul prezzo live ──────────
    setups = []
    for sym in wl[:6]:
        pd = prices.get(sym, {})
        price = pd.get("price", 0.0)
        chg   = pd.get("change_pct", 0.0)
        src   = pd.get("source", "mock")
        if price <= 0:
            continue

        direction = "LONG" if chg >= 0 else "SHORT"
        # ATR approssimativo: 1% per indici, 1.5% per commodity, 0.5% per forex
        if price > 500:   atr_pct = 0.010   # indici e gold
        elif price > 10:  atr_pct = 0.015   # oil, silver
        else:             atr_pct = 0.005   # forex

        atr = price * atr_pct
        nd  = _ndec(price)

        if direction == "LONG":
            entry = round(price, nd)
            sl    = round(price - atr * 1.5, nd)
            tp1   = round(price + atr * 2.0, nd)
            tp2   = round(price + atr * 3.5, nd)
        else:
            entry = round(price, nd)
            sl    = round(price + atr * 1.5, nd)
            tp1   = round(price - atr * 2.0, nd)
            tp2   = round(price - atr * 3.5, nd)

        wr  = 62 if abs(chg) > 0.5 else 55
        mot = (f"{'Momentum rialzista' if chg >= 0 else 'Pressione ribassista'}: "
               f"{chg:+.2f}% oggi ({'live' if src=='live' else 'ref'})")
        setups.append({
            "strumento": sym, "direzione": direction,
            "motivazione": mot,
            "confluenze": ["prezzo_live", "momentum_giornaliero"],
            "winrate": wr, "priorita": "ALTA" if abs(chg) > 0.5 else "MEDIA",
            "entry": str(entry), "sl": str(sl), "tp": str(tp1),
        })

    # ── Rischio giornata da calendario ────────────────────────────
    high_ev = [e for e in calendar if e.get("impact") == "HIGH"]
    rischio  = "ALTO" if len(high_ev) >= 2 else "MEDIO" if high_ev else "BASSO"
    orari    = [f"{e['time']} — {e['currency']} {e['event']}" for e in high_ev[:3]]

    xau_p = prices.get("XAUUSD", {})
    spx_p = prices.get("US500",  {})
    eur_p = prices.get("EURUSD", {})

    cosa_mon = [
        f"XAUUSD: {xau_p.get('price','—')} ({xau_p.get('change_pct',0):+.2f}%)",
        f"US500:  {spx_p.get('price','—')} ({spx_p.get('change_pct',0):+.2f}%)",
        f"EURUSD: {eur_p.get('price','—')} ({eur_p.get('change_pct',0):+.2f}%)",
    ] + ([f"Eventi HIGH: {', '.join(e['event'] for e in high_ev[:2])}"] if high_ev else [])

    sintesi = (
        f"⚡ Dati live (AI offline — ricarica crediti Anthropic). "
        f"{s_spiega}. "
        f"{'Attenzione a ' + str(len(high_ev)) + ' eventi HIGH impact.' if high_ev else 'Nessun evento critico in agenda.'}"
    )

    return {
        "sentiment_mercato": sentiment, "sentiment_icon": s_icon,
        "sentiment_spiegazione": s_spiega, "sintesi": sintesi,
        "top_setup": setups[:3],
        "cosa_monitorare": cosa_mon,
        "rischio_giornata": rischio, "orari_caldi": orari,
    }


def get_live_prices(symbols: List[str]) -> dict:
    """Recupera prezzi live da Yahoo Finance con cache 60s. Fallback su MOCK_PRICES."""
    global _price_cache, _price_cache_time
    now = datetime.now()
    # Ritorna dalla cache se fresca
    if _price_cache and _price_cache_time and (now - _price_cache_time).seconds < PRICE_CACHE_SECONDS:
        upper = [s.upper() for s in symbols]
        cached = {s: _price_cache[s] for s in upper if s in _price_cache}
        if len(cached) == len(upper):
            return cached

    upper_syms = [s.upper() for s in symbols]
    yf_map = {s: SYMBOL_MAP.get(s, s + "=X") for s in upper_syms}
    yf_tickers_str = " ".join(set(yf_map.values()))

    new_prices: dict = {}
    try:
        tickers = yf.Tickers(yf_tickers_str)
        for sym, yf_sym in yf_map.items():
            try:
                fi = tickers.tickers[yf_sym].fast_info
                price = fi.last_price
                prev = getattr(fi, "previous_close", None) or price
                if not price:
                    raise ValueError("price null")
                change = price - prev
                change_pct = (change / prev * 100) if prev else 0.0
                new_prices[sym] = {
                    "price": _fmt_price(price),
                    "change": _fmt_price(change),
                    "change_pct": round(change_pct, 2),
                    "source": "live",
                }
            except Exception as e:
                print(f"[Prices] {sym}: {e}")
                new_prices[sym] = {
                    "price": MOCK_PRICES.get(sym, 1.0),
                    "change": 0.0, "change_pct": 0.0, "source": "mock",
                }
    except Exception as e:
        print(f"[Prices batch] {e}")
        for sym in upper_syms:
            new_prices[sym] = {
                "price": MOCK_PRICES.get(sym, 1.0),
                "change": 0.0, "change_pct": 0.0, "source": "mock",
            }

    _price_cache.update(new_prices)
    _price_cache_time = now
    return new_prices

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.google.com/",
}


def get_real_indicators(symbol: str) -> dict:
    """Scarica OHLCV da yfinance e calcola indicatori tecnici reali con cache 15 min."""
    global _ind_cache, _ind_cache_time
    sym = symbol.upper()
    now = datetime.now()
    # Ritorna dalla cache se fresca
    if sym in _ind_cache and sym in _ind_cache_time:
        elapsed = (now - _ind_cache_time[sym]).total_seconds() / 60
        if elapsed < IND_CACHE_MINUTES:
            return _ind_cache[sym]

    try:
        yf_sym = SYMBOL_MAP.get(sym, sym + "=X")
        df = yf.download(yf_sym, period="1y", interval="1d", auto_adjust=True, progress=False)
        if df is None or df.empty:
            return {}
        # Flatten MultiIndex columns if present
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df.dropna()
        if len(df) < 30:
            return {}

        _df_cache[sym] = df  # store for backtest

        close = df["Close"]
        high  = df["High"]
        low   = df["Low"]
        price = float(close.iloc[-1])

        # Helper
        def _sv(s, d=0.0):
            return float(s.iloc[-1]) if s is not None and not pd.isna(s.iloc[-1]) else d

        # RSI
        rsi_s  = pta.rsi(close, length=14)
        rsi    = _sv(rsi_s, 50.0)

        # EMAs
        ema20  = _sv(pta.ema(close, length=20), price)
        ema50  = _sv(pta.ema(close, length=50), price)
        ema200 = _sv(pta.ema(close, length=200), price)

        # ATR
        atr_s  = pta.atr(high, low, close, length=14)
        atr    = _sv(atr_s, price * 0.01)

        # MACD
        macd_df = pta.macd(close)
        hist_col  = next((c for c in (macd_df.columns if macd_df is not None else []) if c.startswith("MACDh_")), None)
        macd_col  = next((c for c in (macd_df.columns if macd_df is not None else []) if c.startswith("MACD_")),  None)
        hist      = _sv(macd_df[hist_col],  0.0) if hist_col else 0.0
        prev_hist = float(macd_df[hist_col].iloc[-2]) if hist_col and len(macd_df) >= 2 and not pd.isna(macd_df[hist_col].iloc[-2]) else 0.0
        if hist > 0 and hist > prev_hist:
            macd_signal = "RIALZISTA"
        elif hist < 0 and hist < prev_hist:
            macd_signal = "RIBASSISTA"
        else:
            macd_signal = "NEUTRO"
        if hist > prev_hist:
            macd_ist = "CRESCENTE"
        elif hist < prev_hist:
            macd_ist = "DECRESCENTE"
        else:
            macd_ist = "NEUTRO"

        # Bollinger Bands
        bb_df  = pta.bbands(close, length=20)
        bbu_col = next((c for c in (bb_df.columns if bb_df is not None else []) if c.startswith("BBU_")), None)
        bbl_col = next((c for c in (bb_df.columns if bb_df is not None else []) if c.startswith("BBL_")), None)
        bbm_col = next((c for c in (bb_df.columns if bb_df is not None else []) if c.startswith("BBM_")), None)
        bb_upper = _sv(bb_df[bbu_col], price * 1.02) if bbu_col else price * 1.02
        bb_lower = _sv(bb_df[bbl_col], price * 0.98) if bbl_col else price * 0.98
        bb_mid   = _sv(bb_df[bbm_col], price)        if bbm_col else price

        # Trend
        if price > ema20 > ema50 > ema200:
            trend = "RIALZISTA"
        elif price < ema20 < ema50 < ema200:
            trend = "RIBASSISTA"
        else:
            trend = "LATERALE"

        forza_trend = min(10, max(1, int(abs(price - ema200) / max(atr, 0.0001) * 2) + 3))

        # RSI signal
        prev_rsi = float(rsi_s.iloc[-2]) if rsi_s is not None and len(rsi_s) >= 2 and not pd.isna(rsi_s.iloc[-2]) else rsi
        if rsi > 70:
            rsi_segnale = "IPERCOMPRATO"
        elif rsi < 30:
            rsi_segnale = "IPERVENDUTO"
        elif rsi > 55 and rsi > prev_rsi:
            rsi_segnale = "LONG"
        elif rsi < 45 and rsi < prev_rsi:
            rsi_segnale = "SHORT"
        else:
            rsi_segnale = "NEUTRO"

        # Posizione vs medie
        if price > ema50 and price > ema200:
            pos_vs_medie = "SOPRA ENTRAMBE"
        elif price < ema50 and price < ema200:
            pos_vs_medie = "SOTTO ENTRAMBE"
        else:
            pos_vs_medie = "TRA LE MEDIE"

        # Support / Resistance
        recent = df.tail(60)
        highs_above = sorted(recent["High"][recent["High"] > price * 1.001].nlargest(8).tolist())[:3]
        lows_below  = sorted(recent["Low"][recent["Low"]  < price * 0.999].nsmallest(8).tolist(), reverse=True)[:3]
        if len(highs_above) < 3:
            highs_above = [round(price + atr * (i + 1), _ndec(price)) for i in range(3)]
        if len(lows_below) < 3:
            lows_below  = [round(price - atr * (i + 1), _ndec(price)) for i in range(3)]
        resistenze = [round(float(v), _ndec(price)) for v in highs_above[:3]]
        supporti   = [round(float(v), _ndec(price)) for v in lows_below[:3]]

        # Divergences
        tail14 = df.tail(14)
        rsi_tail = rsi_s.iloc[-14:] if rsi_s is not None and len(rsi_s) >= 14 else None
        bullish_div = False
        bearish_div = False
        if rsi_tail is not None and len(tail14) >= 8:
            last_close  = float(tail14["Close"].iloc[-1])
            ago7_close  = float(tail14["Close"].iloc[-8])
            last_rsi_v  = float(rsi_tail.iloc[-1])
            ago7_rsi_v  = float(rsi_tail.iloc[-8]) if len(rsi_tail) >= 8 else last_rsi_v
            bullish_div = (last_close < ago7_close) and (last_rsi_v > ago7_rsi_v)
            bearish_div = (last_close > ago7_close) and (last_rsi_v < ago7_rsi_v)

        # ── Improvement 2: ADX Market Regime Filter ────────────────
        adx_df = pta.adx(high, low, close, length=14)
        adx_val = 20.0
        if adx_df is not None:
            adx_col = next((c for c in adx_df.columns if c.startswith("ADX_")), None)
            if adx_col:
                adx_val = _sv(adx_df[adx_col], 20.0)
        adx_val = round(adx_val, 1)
        if adx_val > 25:
            regime = "TRENDING"
        elif adx_val < 20:
            regime = "RANGING"
        else:
            regime = "TRANSITIONAL"

        # ── Improvement 4: Volume Confirmation ─────────────────────
        vol_series = df["Volume"]
        vol_avg20 = float(vol_series.tail(21).iloc[:-1].mean())
        vol_latest = float(vol_series.iloc[-1])
        vol_ratio = round(vol_latest / vol_avg20, 2) if vol_avg20 > 0 else 1.0
        if vol_ratio >= 1.3:
            vol_confirmation = "ALTA"
        elif vol_ratio >= 0.7:
            vol_confirmation = "NORMALE"
        else:
            vol_confirmation = "BASSA"

        # ── Improvement 1: Multi-Timeframe Analysis ─────────────────
        tf_h4_trend = "N/D"
        tf_weekly_trend = "N/D"
        tf_mtf_alignment = "N/D"
        try:
            # H4 trend via 1h data resampled
            df_h1 = yf.download(yf_sym, period="60d", interval="1h", auto_adjust=True, progress=False)
            if df_h1 is not None and not df_h1.empty:
                if isinstance(df_h1.columns, pd.MultiIndex):
                    df_h1.columns = df_h1.columns.get_level_values(0)
                df_h1 = df_h1.dropna()
                df_h4 = df_h1.resample("4h").agg({
                    "Open": "first", "High": "max", "Low": "min",
                    "Close": "last", "Volume": "sum"
                }).dropna()
                if len(df_h4) >= 50:
                    h4_close = df_h4["Close"]
                    ema20_h4 = float(pta.ema(h4_close, length=20).iloc[-1])
                    ema50_h4 = float(pta.ema(h4_close, length=50).iloc[-1])
                    h4_price = float(h4_close.iloc[-1])
                    if h4_price > ema20_h4 > ema50_h4:
                        tf_h4_trend = "RIALZISTA"
                    elif h4_price < ema20_h4 < ema50_h4:
                        tf_h4_trend = "RIBASSISTA"
                    else:
                        tf_h4_trend = "LATERALE"
            # Weekly trend
            df_weekly = df.resample("W").agg({
                "Open": "first", "High": "max", "Low": "min",
                "Close": "last", "Volume": "sum"
            }).dropna()
            if len(df_weekly) >= 10:
                w_close = df_weekly["Close"]
                ema10_w = float(pta.ema(w_close, length=10).iloc[-1])
                w_price = float(w_close.iloc[-1])
                tf_weekly_trend = "RIALZISTA" if w_price > ema10_w else "RIBASSISTA"
            # MTF alignment
            if tf_h4_trend != "N/D" and tf_weekly_trend != "N/D":
                if trend == "RIALZISTA" and tf_h4_trend == "RIALZISTA" and tf_weekly_trend == "RIALZISTA":
                    tf_mtf_alignment = "ALLINEATO_LONG"
                elif trend == "RIBASSISTA" and tf_h4_trend == "RIBASSISTA" and tf_weekly_trend == "RIBASSISTA":
                    tf_mtf_alignment = "ALLINEATO_SHORT"
                else:
                    tf_mtf_alignment = "MISTO"
        except Exception as e_mtf:
            print(f"[MTF] {sym}: {e_mtf}")
            tf_h4_trend = "N/D"
            tf_weekly_trend = "N/D"
            tf_mtf_alignment = "N/D"

        result = {
            "price": round(price, _ndec(price)),
            "atr": round(atr, _ndec(price)),
            "rsi_14": round(rsi, 1),
            "rsi_segnale": rsi_segnale,
            "ema20": round(ema20, _ndec(price)),
            "ema50": round(ema50, _ndec(price)),
            "ema200": round(ema200, _ndec(price)),
            "ma50": round(ema50, _ndec(price)),
            "ma200": round(ema200, _ndec(price)),
            "trend_principale": trend,
            "forza_trend": forza_trend,
            "posizione_vs_medie": pos_vs_medie,
            "macd_signal": macd_signal,
            "macd_istogramma": macd_ist,
            "bb_upper": round(bb_upper, _ndec(price)),
            "bb_lower": round(bb_lower, _ndec(price)),
            "bb_mid": round(bb_mid, _ndec(price)),
            "supporti": supporti,
            "resistenze": resistenze,
            "bullish_div": bullish_div,
            "bearish_div": bearish_div,
            "adx": adx_val,
            "regime": regime,
            "vol_ratio": vol_ratio,
            "vol_confirmation": vol_confirmation,
            "tf_h4_trend": tf_h4_trend,
            "tf_weekly_trend": tf_weekly_trend,
            "tf_mtf_alignment": tf_mtf_alignment,
        }
        _ind_cache[sym]      = result
        _ind_cache_time[sym] = now
        return result

    except Exception as e:
        print(f"[Indicators] {sym}: {e}")
        return {}


def compute_signal_score(sym: str, ind: dict, setup: dict) -> dict:
    """
    Calcola un punteggio probabilistico composito 0-100 per un setup algoritmico.
    Basato su 8 fattori pesati + bonus/penalità.
    """
    direction = setup.get("direzione", "LONG")
    strategy  = setup.get("strategia", "")
    rr        = float(setup.get("risk_reward", 0))
    is_long   = direction == "LONG"

    trend    = ind.get("trend_principale", "LATERALE")
    rsi      = ind.get("rsi_14", 50.0)
    macd     = ind.get("macd_signal", "NEUTRO")
    vol_conf = ind.get("vol_confirmation", "NORMALE")
    regime   = ind.get("regime", "TRANSITIONAL")
    mtf      = ind.get("tf_mtf_alignment", "MISTO")
    adx      = ind.get("adx", 20.0)
    price    = ind.get("price", 1.0)
    bb_upper = ind.get("bb_upper", price * 1.02)
    bb_lower = ind.get("bb_lower", price * 0.98)
    bull_div = ind.get("bullish_div", False)
    bear_div = ind.get("bearish_div", False)
    cal_warn = setup.get("calendar_warning", False)

    score = 0
    factors = []

    # 1. MTF alignment (25 pts)
    if mtf == "ALLINEATO_LONG" and is_long:
        score += 25; factors.append("MTF allineato LONG +25")
    elif mtf == "ALLINEATO_SHORT" and not is_long:
        score += 25; factors.append("MTF allineato SHORT +25")
    elif mtf == "MISTO":
        score += 12; factors.append("MTF misto +12")
    else:
        score += 0; factors.append("MTF contro +0")

    # 2. ADX regime match (15 pts)
    trend_strats = ("EMA Pullback", "Trend Continuation")
    mean_rev_strats = ("BB Mean Reversion", "RSI", "EMA50")
    is_trend_strat = any(s in strategy for s in trend_strats)
    is_mr_strat    = any(s in strategy for s in mean_rev_strats)
    if regime == "TRENDING" and is_trend_strat:
        score += 15; factors.append("Regime TRENDING + trend strat +15")
    elif regime == "RANGING" and is_mr_strat:
        score += 15; factors.append("Regime RANGING + mean rev strat +15")
    elif regime == "TRANSITIONAL":
        score += 8;  factors.append("Regime TRANSITIONAL +8")
    elif regime == "TRENDING" and is_mr_strat:
        score += 4;  factors.append("Regime TRENDING + mean rev (suboptimal) +4")
    else:
        score += 3;  factors.append("Regime mismatch +3")

    # 3. RSI zone (15 pts)
    if is_long:
        if 35 <= rsi <= 52:
            score += 15; factors.append(f"RSI {rsi:.0f} zona pullback ottimale +15")
        elif 52 < rsi <= 65:
            score += 8;  factors.append(f"RSI {rsi:.0f} momentum +8")
        elif rsi < 35:
            score += 12; factors.append(f"RSI {rsi:.0f} oversold +12")
        else:
            score += 2;  factors.append(f"RSI {rsi:.0f} sfavorevole +2")
    else:
        if 48 <= rsi <= 65:
            score += 15; factors.append(f"RSI {rsi:.0f} zona pullback ottimale +15")
        elif 35 <= rsi < 48:
            score += 8;  factors.append(f"RSI {rsi:.0f} momentum short +8")
        elif rsi > 65:
            score += 12; factors.append(f"RSI {rsi:.0f} overbought +12")
        else:
            score += 2;  factors.append(f"RSI {rsi:.0f} sfavorevole +2")

    # 4. MACD confirmation (10 pts)
    if (is_long and macd == "RIALZISTA") or (not is_long and macd == "RIBASSISTA"):
        score += 10; factors.append("MACD conferma direzione +10")
    elif macd == "NEUTRO":
        score += 5;  factors.append("MACD neutro +5")
    else:
        score += 0;  factors.append("MACD contro +0")

    # 5. Volume confirmation (10 pts)
    if vol_conf == "ALTA":
        score += 10; factors.append("Volume ALTA +10")
    elif vol_conf == "NORMALE":
        score += 7;  factors.append("Volume NORMALE +7")
    else:
        score += 0;  factors.append("Volume BASSA +0")

    # 6. R:R quality (10 pts)
    if rr >= 2.0:
        score += 10; factors.append(f"R:R {rr} eccellente +10")
    elif rr >= 1.5:
        score += 8;  factors.append(f"R:R {rr} buono +8")
    elif rr >= 1.0:
        score += 5;  factors.append(f"R:R {rr} accettabile +5")
    else:
        score += 0;  factors.append(f"R:R {rr} insufficiente +0")

    # 7. BB position (10 pts)
    pct_from_upper = (price - bb_upper) / bb_upper if bb_upper else 0
    pct_from_lower = (bb_lower - price) / bb_lower if bb_lower else 0
    if not is_long and pct_from_upper >= -0.02:
        score += 10; factors.append("Prezzo vicino BB upper +10")
    elif is_long and pct_from_lower >= -0.02:
        score += 10; factors.append("Prezzo vicino BB lower +10")
    else:
        score += 4;  factors.append("BB posizione neutra +4")

    # 8. Trend alignment D1 (5 pts)
    if (is_long and trend == "RIALZISTA") or (not is_long and trend == "RIBASSISTA"):
        score += 5; factors.append("Trend D1 allineato +5")
    elif trend == "LATERALE":
        score += 2; factors.append("Trend D1 laterale +2")

    # Bonus: divergenza RSI (+5)
    if (is_long and bull_div) or (not is_long and bear_div):
        score += 5; factors.append("Divergenza RSI bonus +5")

    # Penalità calendario (-10)
    if cal_warn:
        score -= 10; factors.append("Evento HIGH calendario -10")

    score = max(0, min(100, score))

    if score >= 75:
        classification = "HIGH"
    elif score >= 60:
        classification = "MEDIUM"
    else:
        classification = "LOW"

    return {
        "score": score,
        "classification": classification,
        "factors": factors
    }


def backtest_strategy(sym: str, strategy_name: str, direction: str,
                      atr_mult_sl: float = 1.5, atr_mult_tp: float = 2.0,
                      max_bars: int = 15) -> dict:
    """
    Backtest storico su OHLCV reale (1 anno).
    Conta quante volte il TP1 è stato raggiunto prima dello SL.
    Restituisce win_rate reale, numero segnali, vincite, perdite.
    """
    df = _df_cache.get(sym.upper())
    if df is None or len(df) < 60:
        return {"win_rate": None, "total": 0, "wins": 0, "losses": 0}

    close = df["Close"]
    high  = df["High"]
    low   = df["Low"]

    # Indicatori rolling su tutto lo storico
    rsi_s  = pta.rsi(close, length=14)
    ema20_s = pta.ema(close, length=20)
    ema50_s = pta.ema(close, length=50)
    ema200_s = pta.ema(close, length=200)
    atr_s  = pta.atr(high, low, close, length=14)
    macd_df = pta.macd(close)
    hist_col = next((c for c in (macd_df.columns if macd_df is not None else []) if c.startswith("MACDh_")), None)

    wins = 0
    losses = 0
    is_long = direction == "LONG"

    for i in range(50, len(df) - max_bars):
        def sv(s):
            if s is None: return None
            v = s.iloc[i]
            return float(v) if not pd.isna(v) else None

        p    = sv(close)
        rsi  = sv(rsi_s)  or 50.0
        e20  = sv(ema20_s) or p
        e50  = sv(ema50_s) or p
        e200 = sv(ema200_s) or p
        atr  = sv(atr_s)  or (p * 0.01 if p else 0.01)

        if not p or not atr:
            continue

        # Trend
        if p > e20 > e50 > e200:   trend = "RIALZISTA"
        elif p < e20 < e50 < e200: trend = "RIBASSISTA"
        else:                       trend = "LATERALE"

        # MACD hist
        hist_now  = float(macd_df[hist_col].iloc[i])   if hist_col and not pd.isna(macd_df[hist_col].iloc[i])   else 0.0
        hist_prev = float(macd_df[hist_col].iloc[i-1]) if hist_col and not pd.isna(macd_df[hist_col].iloc[i-1]) else 0.0
        if hist_now > 0 and hist_now > hist_prev:   macd = "RIALZISTA"
        elif hist_now < 0 and hist_now < hist_prev: macd = "RIBASSISTA"
        else:                                        macd = "NEUTRO"

        # BB — simplified: use 2% threshold to avoid per-bar rolling bbands overhead
        bb_u = p * 1.02
        bb_l = p * 0.98

        # Signal check per strategia
        signal = False
        if "EMA Pullback LONG" in strategy_name:
            signal = trend == "RIALZISTA" and p > e200 and 35 <= rsi <= 62 and abs(p - e20) / atr < 1.5
        elif "EMA Pullback SHORT" in strategy_name:
            signal = trend == "RIBASSISTA" and p < e200 and 43 <= rsi <= 65 and abs(p - e20) / atr < 1.5
        elif "RSI Bullish" in strategy_name:
            signal = rsi < 45
        elif "RSI Bearish" in strategy_name:
            signal = rsi > 55
        elif "BB Mean Reversion LONG" in strategy_name:
            signal = p <= bb_l * 1.018 and rsi < 40
        elif "BB Mean Reversion SHORT" in strategy_name:
            signal = p >= bb_u * 0.982 and rsi > 60
        elif "Trend Continuation LONG" in strategy_name:
            signal = trend == "RIALZISTA" and macd in ("RIALZISTA","NEUTRO") and p > e20 and 48 < rsi < 70
        elif "Trend Continuation SHORT" in strategy_name:
            signal = trend == "RIBASSISTA" and macd in ("RIBASSISTA","NEUTRO") and p < e20 and 30 < rsi < 52
        elif "EMA50 Key Level" in strategy_name:
            signal = abs(p - e50) / atr < 0.5 and 38 <= rsi <= 62

        if not signal:
            continue

        # SL / TP
        if is_long:
            sl_price = p - atr * atr_mult_sl
            tp_price = p + atr * atr_mult_tp
        else:
            sl_price = p + atr * atr_mult_sl
            tp_price = p - atr * atr_mult_tp

        # Forward bars outcome
        won = lost = False
        for j in range(i + 1, min(i + 1 + max_bars, len(df))):
            h = float(high.iloc[j])
            l = float(low.iloc[j])
            if is_long:
                if h >= tp_price:  won  = True; break
                if l <= sl_price:  lost = True; break
            else:
                if l <= tp_price:  won  = True; break
                if h >= sl_price:  lost = True; break

        if won:    wins    += 1
        elif lost: losses  += 1

    total = wins + losses
    wr = round(wins / total * 100, 1) if total > 0 else None
    return {"win_rate": wr, "total": total, "wins": wins, "losses": losses}


def ai_audit_setups(setups: list, news: list, calendar: list) -> dict:
    """
    Claude riceve i setup algoritmici già calcolati e li audita fondamentalmente.
    NON genera numeri. Restituisce CONFERMA/DIVERGE + 1 frase per ogni setup.
    """
    if not setups:
        return {}

    setups_text = "\n".join(
        f"- {s['simbolo']} {s['direzione']} ({s['strategia']}) | "
        f"Score: {s.get('score',0)}% | WR storico: {s.get('win_rate_storico','N/D')}% | "
        f"Entry: {s['entry']} SL: {s['sl']} TP1: {s['tp1']} R:R: {s['risk_reward']}"
        for s in setups
    )
    news_text = "\n".join(f"- {n.get('titolo_it', n.get('title',''))}" for n in news[:4])
    cal_text  = "\n".join(
        f"- {e['time']} {e['currency']} {e['event']} ({e['impact']})"
        for e in calendar[:5] if e.get('impact') in ('HIGH','MEDIUM')
    )

    prompt = f"""SETUP ALGORITMICI DA AUDITARE:
{setups_text}

NOTIZIE MACRO OGGI:
{news_text}

EVENTI CALENDARIO:
{cal_text}

Per ogni setup sopra, rispondi SOLO con questo JSON array:
[
  {{
    "simbolo": "<simbolo>",
    "direzione": "LONG"|"SHORT",
    "verdetto": "CONFERMA"|"DIVERGE"|"NEUTRO",
    "motivazione": "<1 frase max 15 parole sul contesto fondamentale>"
  }}
]

REGOLE FERREE:
- Non inventare mai numeri di prezzo
- verdetto CONFERMA: macro supporta la direzione algoritmica
- verdetto DIVERGE: macro contraddice la direzione algoritmica
- verdetto NEUTRO: nessun segnale macro rilevante
- Rispondi SOLO con l'array JSON, zero testo aggiuntivo"""

    try:
        with client.messages.stream(
            model="claude-opus-4-7",
            max_tokens=800,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": "Sei un auditor fondamentale. Ricevi setup algoritmici già calcolati e aggiungi SOLO il contesto macro. Non inventare mai numeri. Rispondi sempre con JSON array valido.",
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            msg = stream.get_final_message()
        verdicts = _parse_json_response(_extract_text(msg))
        if not isinstance(verdicts, list):
            verdicts = []
        # Index by (simbolo, direzione)
        return {(v["simbolo"], v["direzione"]): v for v in verdicts if "simbolo" in v}
    except Exception as e:
        print(f"[AI audit] {e}")
        return {}


def scan_strategies(symbol: str, ind: dict) -> list:
    """Scansiona 4 strategie con WR >= 64% e restituisce setup ordinati per winrate."""
    if not ind or not ind.get("price"):
        return []
    sym   = symbol.upper()
    price = ind["price"]
    atr   = ind.get("atr", price * 0.01) or price * 0.01
    rsi   = ind.get("rsi_14", 50.0)
    ema20 = ind.get("ema20", price)
    ema50 = ind.get("ema50", price)
    ema200= ind.get("ema200", price)
    trend = ind.get("trend_principale", "LATERALE")
    macd  = ind.get("macd_signal", "NEUTRO")
    bb_u  = ind.get("bb_upper", price * 1.02)
    bb_l  = ind.get("bb_lower", price * 0.98)
    bb_m  = ind.get("bb_mid",   price)
    nd    = _ndec(price)
    f     = lambda v: round(float(v), nd)
    setups = []

    # Improvement 2: ADX regime filter
    regime = ind.get("regime", "TRANSITIONAL")

    # Improvement 4: volume confirmation
    vol_confirmation = ind.get("vol_confirmation", "NORMALE")

    # Improvement 3: calendar conflict helper
    CURRENCY_MAP = {
        "XAUUSD": "USD", "EURUSD": "EUR", "GBPUSD": "GBP", "USDJPY": "JPY",
        "BTCUSD": "USD", "US500": "USD", "GBPJPY": "GBP", "AUDUSD": "AUD",
        "USDCAD": "CAD", "EURJPY": "EUR", "NZDUSD": "NZD", "USDCHF": "CHF",
    }
    sym_currency = CURRENCY_MAP.get(sym, "USD")
    high_cal_events = [
        e for e in _last_calendar_events
        if e.get("impact") == "HIGH" and e.get("currency", "") == sym_currency
    ]

    def _calendar_fields(base_wr: int):
        """Return calendar warning fields and adjusted WR."""
        if high_cal_events:
            return {
                "calendar_warning": True,
                "calendar_events": high_cal_events,
            }, max(0, base_wr - 5)
        return {"calendar_warning": False, "calendar_events": []}, base_wr

    # Improvement 5: swing SL helper
    supporti   = ind.get("supporti", [])
    resistenze = ind.get("resistenze", [])

    def _swing_sl_long():
        """Nearest support below price minus ATR buffer.
        Cap: se il supporto è > 2×ATR, usa ATR-based SL (evita R:R negativi)."""
        below = [s for s in supporti if s < price]
        if below:
            nearest = max(below)
            sl = nearest - atr * 0.15
            if (price - sl) <= atr * 2.0:   # supporto vicino → usalo
                return f(sl)
        return f(price - atr * 1.5)         # fallback ATR-based

    def _swing_sl_short():
        """Nearest resistance above price plus ATR buffer.
        Cap: se la resistenza è > 2×ATR, usa ATR-based SL."""
        above = [r for r in resistenze if r > price]
        if above:
            nearest = min(above)
            sl = nearest + atr * 0.15
            if (sl - price) <= atr * 2.0:   # resistenza vicina → usala
                return f(sl)
        return f(price + atr * 1.5)         # fallback ATR-based

    def _rr(entry_p, sl_p, tp_p):
        """Risk/reward ratio."""
        risk   = abs(entry_p - sl_p)
        reward = abs(tp_p - entry_p)
        return round(reward / max(risk, 0.0001), 1)

    # MTF alignment for badge
    tf_mtf = ind.get("tf_mtf_alignment", "")

    # ── Strategy 1: EMA Trend Pullback (base WR 68%/66%) ──────────
    # Improvement 2: skip in RANGING regime
    # RSI zone ampliata (35-57 LONG / 43-65 SHORT) — zona pullback realistica
    # Prossimità EMA20: entro 1.5×ATR invece di 1.0×ATR
    if regime != "RANGING":
        if trend == "RIALZISTA" and price > ema200 and 35 <= rsi <= 62 and abs(price - ema20) / atr < 1.5:
            # Improvement 4: skip if BASSA volume
            if vol_confirmation != "BASSA":
                base_wr = 68
                sl_val = _swing_sl_long()
                tp1_val = f(price + atr * 2.0)
                cal_fields, wr = _calendar_fields(base_wr)
                setup = {"strategia": "EMA Pullback LONG", "simbolo": sym, "direzione": "LONG", "timeframe": "D1",
                    "descrizione": f"Trend rialzista confermato, RSI {rsi:.0f} in zona pullback (35-57), prezzo vicino EMA20 ({f(ema20)})",
                    "entry": f(price), "sl": sl_val,
                    "tp1": tp1_val, "tp2": f(price + atr * 3.5),
                    "risk_reward": _rr(price, float(sl_val), price + atr * 2.0),
                    "winrate": wr, "confluenze": ["EMA trend allineate", "RSI pullback", "struttura di mercato"],
                    "priorita": "ALTA" if rsi < 48 else "MEDIA",
                    "tf_mtf_alignment": tf_mtf}
                setup.update(cal_fields)
                setups.append(setup)
        if trend == "RIBASSISTA" and price < ema200 and 43 <= rsi <= 65 and abs(price - ema20) / atr < 1.5:
            if vol_confirmation != "BASSA":
                base_wr = 66
                sl_val = _swing_sl_short()
                tp1_val = f(price - atr * 2.0)
                cal_fields, wr = _calendar_fields(base_wr)
                setup = {"strategia": "EMA Pullback SHORT", "simbolo": sym, "direzione": "SHORT", "timeframe": "D1",
                    "descrizione": f"Trend ribassista confermato, RSI {rsi:.0f} in zona pullback (43-65), prezzo vicino EMA20 ({f(ema20)})",
                    "entry": f(price), "sl": sl_val,
                    "tp1": tp1_val, "tp2": f(price - atr * 3.5),
                    "risk_reward": _rr(price, float(sl_val), price - atr * 2.0),
                    "winrate": wr, "confluenze": ["EMA trend allineate", "RSI pullback", "struttura di mercato"],
                    "priorita": "ALTA" if rsi > 52 else "MEDIA",
                    "tf_mtf_alignment": tf_mtf}
                setup.update(cal_fields)
                setups.append(setup)

    # ── Strategy 2: RSI Divergence (base WR 72%/70%) ──────────────
    # Improvement 2: in TRENDING regime downgrade WR by 3%
    div_wr_penalty = 3 if regime == "TRENDING" else 0

    if ind.get("bullish_div") and rsi < 45:
        base_wr = 72 - div_wr_penalty
        sl_val = _swing_sl_long()
        tp1_val = f(price + atr * 2.5)
        cal_fields, wr = _calendar_fields(base_wr)
        setup = {"strategia": "RSI Bullish Divergence", "simbolo": sym, "direzione": "LONG", "timeframe": "D1",
            "descrizione": f"Divergenza rialzista: prezzo fa lower low ma RSI {rsi:.0f} fa higher low — segnale di inversione ad alta probabilità",
            "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price + atr * 4.2),
            "risk_reward": _rr(price, float(sl_val), price + atr * 2.5),
            "winrate": wr, "confluenze": ["RSI divergence", "momentum shift", "exhaustion"],
            "priorita": "ALTA",
            "tf_mtf_alignment": tf_mtf}
        setup.update(cal_fields)
        setups.append(setup)

    if ind.get("bearish_div") and rsi > 55:
        base_wr = 70 - div_wr_penalty
        sl_val = _swing_sl_short()
        tp1_val = f(price - atr * 2.5)
        cal_fields, wr = _calendar_fields(base_wr)
        setup = {"strategia": "RSI Bearish Divergence", "simbolo": sym, "direzione": "SHORT", "timeframe": "D1",
            "descrizione": f"Divergenza ribassista: prezzo fa higher high ma RSI {rsi:.0f} fa lower high — segnale di inversione ad alta probabilità",
            "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price - atr * 4.2),
            "risk_reward": _rr(price, float(sl_val), price - atr * 2.5),
            "winrate": wr, "confluenze": ["RSI divergence", "momentum exhaustion", "overbought"],
            "priorita": "ALTA",
            "tf_mtf_alignment": tf_mtf}
        setup.update(cal_fields)
        setups.append(setup)

    # ── Strategy 3: BB Mean Reversion (base WR 65%) ───────────────
    # Skip in TRENDING regime — ECCEZIONE: vol_conf=ALTA sblocca anche in TRENDING (mean rev forte)
    # Soglie banda allargate a ±2% (era ±0.8%) — zona standard di approccio alle bande
    # RSI: LONG <40 (era <38), SHORT >60 (era >62)
    bb_regime_ok_long  = (regime != "TRENDING") or (vol_confirmation == "ALTA")
    bb_regime_ok_short = (regime != "TRENDING") or (vol_confirmation == "ALTA")

    if bb_regime_ok_long and price <= bb_l * 1.018 and rsi < 40 and trend in ("RIALZISTA", "LATERALE"):
        base_wr = 65
        if vol_confirmation == "ALTA":
            base_wr += 3
        sl_val = _swing_sl_long()
        tp1_val = f(bb_m)
        cal_fields, wr = _calendar_fields(base_wr)
        setup = {"strategia": "BB Mean Reversion LONG", "simbolo": sym, "direzione": "LONG", "timeframe": "D1",
            "descrizione": f"Prezzo sulla BB inferiore ({f(bb_l)}), RSI {rsi:.0f} oversold — mean reversion verso BB media ({f(bb_m)})",
            "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(bb_u * 0.98),
            "risk_reward": _rr(price, float(sl_val), bb_m),
            "winrate": wr, "confluenze": ["BB lower band", "RSI oversold", "mean reversion"],
            "priorita": "MEDIA",
            "tf_mtf_alignment": tf_mtf}
        setup.update(cal_fields)
        setups.append(setup)

    if bb_regime_ok_short and price >= bb_u * 0.982 and rsi > 60 and trend in ("RIBASSISTA", "LATERALE"):
        base_wr = 65
        if vol_confirmation == "ALTA":
            base_wr += 3
        sl_val = _swing_sl_short()
        tp1_val = f(bb_m)
        cal_fields, wr = _calendar_fields(base_wr)
        setup = {"strategia": "BB Mean Reversion SHORT", "simbolo": sym, "direzione": "SHORT", "timeframe": "D1",
            "descrizione": f"Prezzo sulla BB superiore ({f(bb_u)}), RSI {rsi:.0f} overbought — mean reversion verso BB media ({f(bb_m)})",
            "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(bb_l * 1.02),
            "risk_reward": _rr(price, float(sl_val), bb_m),
            "winrate": wr, "confluenze": ["BB upper band", "RSI overbought", "mean reversion"],
            "priorita": "MEDIA",
            "tf_mtf_alignment": tf_mtf}
        setup.update(cal_fields)
        setups.append(setup)

    # ── Strategy 4: EMA+MACD Trend Continuation (base WR 64%) ────
    # Skip in RANGING regime
    # RSI range allargato: 48-70 LONG / 30-52 SHORT (era 50-65 / 35-50)
    # MACD: accetta anche NEUTRO con istogramma CRESCENTE → WR -3%
    macd_hist = ind.get("macd_istogramma", "NEUTRO")
    if regime != "RANGING":
        # MACD: accetta RIALZISTA (base WR) o NEUTRO (penalità -3%); RIBASSISTA blocca LONG
        # Accetta RIBASSISTA o NEUTRO per SHORT; RIALZISTA blocca SHORT
        macd_bull = macd in ("RIALZISTA", "NEUTRO")
        macd_bear = macd in ("RIBASSISTA", "NEUTRO")
        macd_bull_penalty = 3 if macd == "NEUTRO" else 0
        macd_bear_penalty = 3 if macd == "NEUTRO" else 0

        if trend == "RIALZISTA" and macd_bull and price > ema20 and 48 < rsi < 70:
            if vol_confirmation != "BASSA":
                base_wr = 64 - macd_bull_penalty
                sl_val = _swing_sl_long()
                tp1_val = f(price + atr * 1.5)
                cal_fields, wr = _calendar_fields(base_wr)
                macd_label = "MACD bullish" if macd == "RIALZISTA" else "MACD hist. crescente"
                setup = {"strategia": "Trend Continuation LONG", "simbolo": sym, "direzione": "LONG", "timeframe": "D1",
                    "descrizione": f"Trend+MACD bullish allineati, RSI {rsi:.0f} in zona momentum — continuazione tendenza rialzista",
                    "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price + atr * 2.8),
                    "risk_reward": _rr(price, float(sl_val), price + atr * 1.5),
                    "winrate": wr, "confluenze": ["EMA20 supporto", macd_label, "RSI momentum"],
                    "priorita": "MEDIA",
                    "tf_mtf_alignment": tf_mtf}
                setup.update(cal_fields)
                setups.append(setup)

        if trend == "RIBASSISTA" and macd_bear and price < ema20 and 30 < rsi < 52:
            if vol_confirmation != "BASSA":
                base_wr = 64 - macd_bear_penalty
                sl_val = _swing_sl_short()
                tp1_val = f(price - atr * 1.5)
                cal_fields, wr = _calendar_fields(base_wr)
                macd_label2 = "MACD bearish" if macd == "RIBASSISTA" else "MACD hist. decrescente"
                setup = {"strategia": "Trend Continuation SHORT", "simbolo": sym, "direzione": "SHORT", "timeframe": "D1",
                    "descrizione": f"Trend+MACD bearish allineati, RSI {rsi:.0f} in zona momentum — continuazione tendenza ribassista",
                    "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price - atr * 2.8),
                    "risk_reward": _rr(price, float(sl_val), price - atr * 1.5),
                    "winrate": wr, "confluenze": ["EMA20 resistenza", macd_label2, "RSI momentum"],
                    "priorita": "MEDIA",
                    "tf_mtf_alignment": tf_mtf}
                setup.update(cal_fields)
                setups.append(setup)

    # ── Strategy 5: EMA50 Key Level Bounce (WR 62%) ───────────────
    # Ideale per regimi RANGING e TRANSITIONAL — prezzo a contatto con EMA50
    # RSI neutro (38-62), volume almeno NORMALE, nessuna divergenza richiesta
    ema50_dist = abs(price - ema50) / atr if atr else 99
    # Deadband 0.15×ATR: evita whipsawing quando price ≈ ema50
    ema50_above = price > ema50 + atr * 0.15
    ema50_below = price < ema50 - atr * 0.15
    if ema50_dist < 0.5 and 38 <= rsi <= 62 and vol_confirmation != "BASSA":
        if ema50_above and macd != "RIBASSISTA" and trend != "RIBASSISTA":
            base_wr = 62
            sl_val  = f(ema50 - atr * 1.2)
            tp1_val = f(price + atr * 1.8)
            cal_fields, wr = _calendar_fields(base_wr)
            setup = {"strategia": "EMA50 Key Level LONG", "simbolo": sym, "direzione": "LONG", "timeframe": "D1",
                "descrizione": f"Prezzo a contatto con EMA50 ({f(ema50)}) — livello chiave di supporto/resistenza con RSI {rsi:.0f} neutro",
                "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price + atr * 3.0),
                "risk_reward": _rr(price, float(sl_val), price + atr * 1.8),
                "winrate": wr, "confluenze": ["EMA50 supporto chiave", f"RSI {rsi:.0f} neutro", f"ADX {ind.get('adx',0):.1f} ({regime})"],
                "priorita": "MEDIA",
                "tf_mtf_alignment": tf_mtf}
            setup.update(cal_fields)
            setups.append(setup)
        elif ema50_below and macd != "RIALZISTA" and trend != "RIALZISTA":
            base_wr = 62
            sl_val  = f(ema50 + atr * 1.2)
            tp1_val = f(price - atr * 1.8)
            cal_fields, wr = _calendar_fields(base_wr)
            setup = {"strategia": "EMA50 Key Level SHORT", "simbolo": sym, "direzione": "SHORT", "timeframe": "D1",
                "descrizione": f"Prezzo sotto EMA50 ({f(ema50)}) — resistenza chiave con RSI {rsi:.0f} neutro, pressione ribassista",
                "entry": f(price), "sl": sl_val, "tp1": tp1_val, "tp2": f(price - atr * 3.0),
                "risk_reward": _rr(price, float(sl_val), price - atr * 1.8),
                "winrate": wr, "confluenze": ["EMA50 resistenza chiave", f"RSI {rsi:.0f} neutro", f"ADX {ind.get('adx',0):.1f} ({regime})"],
                "priorita": "MEDIA",
                "tf_mtf_alignment": tf_mtf}
            setup.update(cal_fields)
            setups.append(setup)

    # Filtra setup con R:R < 1.0 — non accettabili come trade
    setups = [s for s in setups if s.get("risk_reward", 0) >= 1.0]
    return sorted(setups, key=lambda x: (-x["winrate"], 0 if x["priorita"] == "ALTA" else 1))


# ─── SYSTEM PROMPTS (separati per prompt caching) ─────────────────────────────

_NEWS_SYSTEM = """Sei un esperto analista di trading forex, commodity e indici. \
Analizza ogni notizia finanziaria e restituisci UN array JSON valido.

Per ogni notizia fornita restituisci un oggetto con questi campi esatti:
{
  "id": <numero intero>,
  "titolo_it": "<titolo tradotto in italiano>",
  "sommario_it": "<sommario 2-3 frasi in italiano con contesto e impatto>",
  "strumenti_impattati": ["XAUUSD","EURUSD",...],
  "segnale": "LONG"|"SHORT"|"NEUTRO",
  "segnale_per_strumento": {"XAUUSD":"LONG/SHORT/NEUTRO"},
  "winrate": <45-90>,
  "confidenza": "ALTA"|"MEDIA"|"BASSA",
  "razionale": "<2 frasi italiane sul perché long/short>",
  "sentiment": "RISK_ON"|"RISK_OFF"|"NEUTRO",
  "impatto_atteso": "IMMEDIATO"|"BREVE_TERMINE"|"MEDIO_TERMINE",
  "categoria": "BANCA_CENTRALE"|"OCCUPAZIONE"|"INFLAZIONE"|"GEOPOLITICA"|"COMMODITY"|"EQUITY"|"GENERALE",
  "confluenza_fondamentale": <0-100>,
  "confluenza_tecnica": <0-100>,
  "confluenza_sentiment": <0-100>,
  "confluenza_stagionalita": <0-100>
}

Rispondi SOLO con l'array JSON. Zero testo aggiuntivo, zero markdown."""

_BRIEFING_SYSTEM = """Sei un analista macro senior. Scrivi un briefing mattutino professionale in italiano.

IMPORTANTE: I setup operativi ti vengono forniti già calcolati dall'algoritmo — NON modificare entry, SL, TP.
Il tuo compito è SOLO:
1. Interpretare il contesto macro/fondamentale
2. Spiegare perché il mercato si muove così oggi
3. Identificare i rischi principali

Rispondi SOLO con questo JSON (nessun testo fuori dal JSON):
{
  "sentiment_mercato": "RISK_ON"|"RISK_OFF"|"NEUTRO",
  "sentiment_icon": "📈"|"📉"|"⚖️",
  "sentiment_spiegazione": "<1 frase max>",
  "sintesi": "<2 frasi sul contesto macro di oggi>",
  "top_setup": [
    {
      "strumento": "<simbolo>",
      "direzione": "LONG"|"SHORT",
      "motivazione": "<1 frase fondamentale — NON ripetere i numeri>",
      "confluenze": ["fondamentale","tecnico","sentiment"],
      "winrate": <usa esattamente il winrate fornito dall'algoritmo>,
      "priorita": "ALTA"|"MEDIA",
      "entry": "<copia esatta dall'algoritmo>",
      "sl": "<copia esatta dall'algoritmo>",
      "tp": "<copia esatta dall'algoritmo>"
    }
  ],
  "cosa_monitorare": ["<item1>","<item2>","<item3>"],
  "rischio_giornata": "ALTO"|"MEDIO"|"BASSO",
  "orari_caldi": ["HH:MM - <descrizione>"]
}"""

_CALENDAR_SYSTEM = """Sei un esperto di analisi fondamentale forex. \
Analizza gli eventi del calendario economico e restituisci UN array JSON.

Per ogni evento restituisci:
{
  "id": <n>,
  "analisi_it": "<analisi breve in italiano>",
  "strumenti_chiave": ["EURUSD",...],
  "scenario_sopra": {"segnale": "LONG"|"SHORT", "strumento": "<s>", "winrate": <n>},
  "scenario_sotto": {"segnale": "LONG"|"SHORT", "strumento": "<s>", "winrate": <n>},
  "storico_winrate": <n>,
  "volatilita_attesa": "ALTA"|"MEDIA"|"BASSA",
  "cosa_aspettarsi": "<frase breve>",
  "categoria": "BANCA_CENTRALE"|"OCCUPAZIONE"|"INFLAZIONE"|"PMI"|"ALTRO"
}

Rispondi SOLO con array JSON. Zero testo aggiuntivo."""

_TECHNICAL_SYSTEM = """Sei un analista completo che integra analisi tecnica E fondamentale/macro. \
Quando ricevi notizie rilevanti, eventi calendario o sentiment macro, li usi ATTIVAMENTE per:
1. Confermare o contraddire il segnale tecnico puro
2. Determinare il bias direzionale finale con maggiore accuratezza
3. Identificare confluenze o divergenze tecnico-fondamentali

REGOLA CRITICA: entry_price, stop_loss, tp1, tp2 DEVONO essere calcolati a partire dal prezzo_attuale \
fornito nel messaggio utente. Non usare mai livelli storici. \
Esempio: se prezzo_attuale=4800, stop_loss deve essere vicino a 4800 (es. 4740-4760), non 2310.

Rispondi SOLO con questo JSON (zero testo fuori):
{
  "simbolo": "<simbolo>",
  "prezzo_attuale": <prezzo>,
  "trend_principale": "RIALZISTA"|"RIBASSISTA"|"LATERALE",
  "forza_trend": <1-10>,
  "rsi_14": <20-80>,
  "rsi_segnale": "IPERCOMPRATO"|"IPERVENDUTO"|"NEUTRO"|"LONG"|"SHORT",
  "ma50": <prezzo>,
  "ma200": <prezzo>,
  "posizione_vs_medie": "SOPRA ENTRAMBE"|"SOTTO ENTRAMBE"|"TRA LE MEDIE"|"SOPRA MA50"|"SOTTO MA50",
  "macd_signal": "RIALZISTA"|"RIBASSISTA"|"NEUTRO",
  "macd_istogramma": "CRESCENTE"|"DECRESCENTE"|"NEUTRO",
  "supporti": [<s1>,<s2>,<s3>],
  "resistenze": [<r1>,<r2>,<r3>],
  "pattern": "<pattern riconosciuto o Nessuno>",
  "segnale_fondamentale": "LONG"|"SHORT"|"NEUTRO",
  "confluenza_tecnico_fondamentale": "CONFERMATA"|"DIVERGENTE"|"ASSENTE",
  "setup_operativo": {
    "direzione": "LONG"|"SHORT",
    "zona_entrata": "<descrizione zona vicina al prezzo attuale>",
    "entry_price": <prezzo vicino a prezzo_attuale>,
    "stop_loss": <prezzo a max 2-3% dal prezzo_attuale>,
    "tp1": <primo target realistico>,
    "tp2": <secondo target>,
    "risk_reward": <numero>,
    "timeframe": "H1"|"H4"|"D1"
  },
  "bias_giornaliero": "LONG"|"SHORT"|"NEUTRO",
  "confluenze": ["<confluenza1>","<confluenza2>"],
  "note": "<2 frasi di analisi qualitativa IN ITALIANO che integrano tecnica e fondamentale>",
  "winrate_setup": <50-80>
}"""


# ─── SCRAPERS ─────────────────────────────────────────────────────────────────

def scrape_marketwatch() -> List[dict]:
    try:
        resp = requests.get("https://www.marketwatch.com/latest-news", headers=HEADERS, timeout=12)
        soup = BeautifulSoup(resp.text, "lxml")
        articles = []
        for el in soup.select("div.article__content, div.element--article")[:12]:
            title_el = el.select_one("h3 a, h2 a, .article__headline a")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            href = title_el.get("href", "")
            if href and not href.startswith("http"):
                href = "https://www.marketwatch.com" + href
            desc_el = el.select_one(".article__summary, p")
            desc = desc_el.get_text(strip=True)[:300] if desc_el else ""
            articles.append({"title": title, "url": href, "summary": desc, "source": "MarketWatch"})
        return articles
    except Exception as e:
        print(f"[MarketWatch] {e}")
        return []

def scrape_seekingalpha() -> List[dict]:
    try:
        resp = requests.get("https://seekingalpha.com/market-news", headers=HEADERS, timeout=12)
        soup = BeautifulSoup(resp.text, "lxml")
        articles = []
        for el in soup.select("article, [data-test-id='post-list-item']")[:10]:
            title_el = el.select_one("h3 a, h2 a, [data-test-id='post-list-item-title']")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            href = title_el.get("href", "")
            if href and not href.startswith("http"):
                href = "https://seekingalpha.com" + href
            articles.append({"title": title, "url": href, "summary": "", "source": "SeekingAlpha"})
        return articles
    except Exception as e:
        print(f"[SeekingAlpha] {e}")
        return []

def scrape_investing_com() -> List[dict]:
    try:
        urls = [
            "https://www.investing.com/news/forex-news",
            "https://www.investing.com/news/commodities-news",
        ]
        articles = []
        for url in urls:
            resp = requests.get(url, headers=HEADERS, timeout=12)
            soup = BeautifulSoup(resp.text, "lxml")
            for el in soup.select("article.js-article-item, div.mediumTitle1, [data-test='article-item']")[:8]:
                title_el = el.select_one("a.title, a[class*='title'], h2 a, h3 a")
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                if not title or len(title) < 10:
                    continue
                href = title_el.get("href", "")
                if href and not href.startswith("http"):
                    href = "https://www.investing.com" + href
                desc_el = el.select_one("p, .articleDetails, [class*='description']")
                desc = desc_el.get_text(strip=True)[:300] if desc_el else ""
                articles.append({"title": title, "url": href, "summary": desc, "source": "Investing.com"})
            if len(articles) >= 6:
                break
        return articles[:10]
    except Exception as e:
        print(f"[Investing.com] {e}")
        return []

def scrape_forexfactory_calendar() -> List[dict]:
    try:
        resp = requests.get("https://www.forexfactory.com/calendar", headers=HEADERS, timeout=12)
        soup = BeautifulSoup(resp.text, "lxml")
        events = []
        for row in soup.select("tr.calendar_row, tr.flexitem")[:20]:
            event_el = row.select_one(".calendar__event, td.event")
            if not event_el:
                continue
            time_el = row.select_one(".calendar__time, td.time")
            currency_el = row.select_one(".calendar__currency, td.currency")
            impact_el = row.select_one(".calendar__impact, td.impact")
            forecast_el = row.select_one(".calendar__forecast, td.forecast")
            previous_el = row.select_one(".calendar__previous, td.previous")

            impact_classes = " ".join(impact_el.get("class", [])) if impact_el else ""
            if "high" in impact_classes or "red" in impact_classes:
                impact = "HIGH"
            elif "medium" in impact_classes or "orange" in impact_classes:
                impact = "MEDIUM"
            else:
                impact = "LOW"

            now = datetime.now()
            time_str = time_el.get_text(strip=True) if time_el else ""
            events.append({
                "time": time_str,
                "currency": currency_el.get_text(strip=True) if currency_el else "",
                "event": event_el.get_text(strip=True),
                "impact": impact,
                "forecast": forecast_el.get_text(strip=True) if forecast_el else "",
                "previous": previous_el.get_text(strip=True) if previous_el else "",
                "source": "ForexFactory",
                "timestamp": now.isoformat(),
            })
        return events
    except Exception as e:
        print(f"[ForexFactory] {e}")
        return []

# ─── MOCK DATA (fallback) ──────────────────────────────────────────────────────

def mock_news() -> List[dict]:
    return [
        {"title": "Fed Chair Powell signals cautious approach to rate cuts amid persistent inflation", "summary": "Federal Reserve Chairman Jerome Powell indicated a patient stance on rate reductions, stressing sustained progress on inflation before any policy easing.", "source": "MarketWatch", "url": "https://www.marketwatch.com"},
        {"title": "Gold surges above $2,350 as Dollar weakens on mixed jobs data", "summary": "Gold prices climbed sharply as the US dollar fell following a disappointing ADP employment report, raising questions about the labor market strength.", "source": "SeekingAlpha", "url": "https://seekingalpha.com"},
        {"title": "ECB expected to cut rates in June despite persistent services inflation", "summary": "ECB officials signaled their first rate cut could come as early as June even as services sector inflation remains elevated in the eurozone.", "source": "Investing.com", "url": "https://investing.com"},
        {"title": "US NFP beats expectations: 275K jobs added vs 200K forecast", "summary": "The US economy added more jobs than expected, though the unemployment rate ticked slightly higher and wage growth moderated.", "source": "MarketWatch", "url": "https://www.marketwatch.com"},
        {"title": "Bank of Japan hints at another rate hike as CPI stays above target", "summary": "BoJ Governor Kazuo Ueda suggested additional rate increases could be on the horizon if inflation continues to meet the 2% target sustainably.", "source": "SeekingAlpha", "url": "https://seekingalpha.com"},
        {"title": "Oil prices retreat as OPEC+ considers extending production cuts into Q3", "summary": "Crude oil pulled back from recent highs as traders digested signals from OPEC+ members about potentially extending current production limits.", "source": "Investing.com", "url": "https://investing.com"},
        {"title": "S&P 500 hits record high driven by tech earnings beat", "summary": "Major US indices surged to new all-time highs after several large-cap technology companies posted quarterly earnings well above analyst expectations.", "source": "MarketWatch", "url": "https://www.marketwatch.com"},
        {"title": "UK CPI falls to 3.2%, below expectations, boosting BOE cut bets", "summary": "British inflation surprised to the downside, falling faster than expected and increasing market pricing for a Bank of England rate cut in summer.", "source": "SeekingAlpha", "url": "https://seekingalpha.com"},
    ]

def mock_calendar() -> List[dict]:
    now = datetime.now()
    return [
        {"time": (now + timedelta(hours=1, minutes=30)).strftime("%H:%M"), "currency": "USD", "event": "Non-Farm Payrolls", "impact": "HIGH", "forecast": "190K", "previous": "275K", "source": "ForexFactory", "timestamp": (now + timedelta(hours=1, minutes=30)).isoformat()},
        {"time": (now + timedelta(hours=1, minutes=32)).strftime("%H:%M"), "currency": "USD", "event": "Unemployment Rate", "impact": "HIGH", "forecast": "3.9%", "previous": "3.7%", "source": "ForexFactory", "timestamp": (now + timedelta(hours=1, minutes=32)).isoformat()},
        {"time": (now + timedelta(minutes=45)).strftime("%H:%M"), "currency": "USD", "event": "FOMC Member Speech (Williams)", "impact": "MEDIUM", "forecast": "", "previous": "", "source": "ForexFactory", "timestamp": (now + timedelta(minutes=45)).isoformat()},
        {"time": (now + timedelta(hours=5, minutes=45)).strftime("%H:%M"), "currency": "EUR", "event": "CPI Flash Estimate (YoY)", "impact": "HIGH", "forecast": "2.4%", "previous": "2.6%", "source": "ForexFactory", "timestamp": (now + timedelta(hours=5, minutes=45)).isoformat()},
        {"time": (now + timedelta(hours=7)).strftime("%H:%M"), "currency": "GBP", "event": "BOE Interest Rate Decision", "impact": "HIGH", "forecast": "5.25%", "previous": "5.25%", "source": "ForexFactory", "timestamp": (now + timedelta(hours=7)).isoformat()},
        {"time": (now - timedelta(hours=2)).strftime("%H:%M"), "currency": "JPY", "event": "BOJ Meeting Minutes", "impact": "MEDIUM", "forecast": "", "previous": "", "source": "ForexFactory", "timestamp": (now - timedelta(hours=2)).isoformat()},
        {"time": (now + timedelta(hours=3, minutes=15)).strftime("%H:%M"), "currency": "USD", "event": "ISM Manufacturing PMI", "impact": "MEDIUM", "forecast": "50.4", "previous": "50.3", "source": "ForexFactory", "timestamp": (now + timedelta(hours=3, minutes=15)).isoformat()},
        {"time": (now + timedelta(hours=9, minutes=30)).strftime("%H:%M"), "currency": "CAD", "event": "Employment Change", "impact": "HIGH", "forecast": "18.5K", "previous": "-2.2K", "source": "ForexFactory", "timestamp": (now + timedelta(hours=9, minutes=30)).isoformat()},
    ]

# ─── AI ANALYSIS ──────────────────────────────────────────────────────────────

def _parse_json_response(raw: str) -> any:
    """Pulisce e parsa la risposta JSON da Claude."""
    raw = raw.strip()
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def ai_analyze_news(news_items: List[dict]) -> List[dict]:
    if not news_items:
        return []

    n = min(len(news_items), 8)
    news_text = "\n\n".join(
        f"[{i+1}] SOURCE: {item['source']}\nTITLE: {item['title']}\nSUMMARY: {item.get('summary','')}"
        for i, item in enumerate(news_items[:n])
    )

    try:
        with client.messages.stream(
            model="claude-opus-4-7",
            max_tokens=6000,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _NEWS_SYSTEM,
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": f"Analizza queste {n} notizie (id da 1 a {n}):\n\n{news_text}"}],
        ) as stream:
            msg = stream.get_final_message()
        analyses = _parse_json_response(_extract_text(msg))
        result = []
        for i, news in enumerate(news_items[:n]):
            ana = next((a for a in analyses if a.get("id") == i + 1), {})
            result.append({**news, **ana, "id": i + 1})
        return result
    except Exception as e:
        print(f"[AI news] {e}")
        return [
            {**item, "id": i+1, "titolo_it": item["title"], "sommario_it": item.get("summary",""),
             "strumenti_impattati": [], "segnale": "NEUTRO", "winrate": 50, "confidenza": "BASSA",
             "razionale": "Analisi AI non disponibile.", "sentiment": "NEUTRO",
             "impatto_atteso": "BREVE_TERMINE", "categoria": "GENERALE",
             "confluenza_fondamentale": 50, "confluenza_tecnica": 50,
             "confluenza_sentiment": 50, "confluenza_stagionalita": 50}
            for i, item in enumerate(news_items[:n])
        ]


def ai_generate_briefing(news: List[dict], calendar: List[dict], wl: List[str], prices: dict = None, scanner_setups: list = None) -> dict:
    news_text = "\n".join(f"- {n.get('titolo_it', n.get('title',''))}" for n in news[:5])
    cal_text  = "\n".join(
        f"- {e['time']} {e['currency']} {e['event']} ({e['impact']}) | Prev:{e.get('previous','')} Fore:{e.get('forecast','')}"
        for e in calendar[:6]
    )

    # Prezzi live: fondamentali per SL/TP realistici
    prices_lines = ""
    if prices:
        live = [(sym, p) for sym, p in prices.items() if p.get("source") == "live"]
        mock = [(sym, p) for sym, p in prices.items() if p.get("source") != "live"]
        if live:
            prices_lines += "\nPREZZI LIVE ORA:\n" + "\n".join(
                f"  {sym}: {p['price']}  ({'+' if p['change_pct']>=0 else ''}{p['change_pct']}%  vs ieri)"
                for sym, p in live
            )
        if mock:
            prices_lines += "\nPREZZI DI RIFERIMENTO (mercato chiuso):\n" + "\n".join(
                f"  {sym}: {p['price']}" for sym, p in mock
            )

    # Improvement 6: tech snapshot per ogni simbolo watchlist
    tech_snapshot_lines = ""
    try:
        snap_parts = []
        for sym in wl:
            try:
                ind = get_real_indicators(sym)
                if ind and ind.get("price"):
                    snap_parts.append(
                        f"  {sym}: {ind['price']} | RSI {ind['rsi_14']} ({ind['rsi_segnale']}) "
                        f"| Trend {ind['trend_principale']} | Regime {ind.get('regime','?')} "
                        f"| ADX {ind.get('adx','?')} | MTF {ind.get('tf_mtf_alignment','?')} "
                        f"| Vol {ind.get('vol_confirmation','?')}"
                    )
            except Exception:
                pass
        if snap_parts:
            tech_snapshot_lines = "\n\nSNAPSHOT TECNICO LIVE:\n" + "\n".join(snap_parts)
    except Exception:
        pass

    # Improvement 6: setup algoritmici section
    scanner_section = ""
    if scanner_setups:
        lines = []
        for s in scanner_setups[:8]:
            lines.append(
                f"  {s.get('simbolo','?')} | {s.get('strategia','?')} | {s.get('direzione','?')} "
                f"| WR {s.get('winrate','?')}% | Entry {s.get('entry','?')} "
                f"| SL {s.get('sl','?')} | TP1 {s.get('tp1','?')}"
            )
        scanner_section = "\n\nSETUP ALGORITMICI (scanner tecnico):\n" + "\n".join(lines)

    setups_block = ""
    if scanner_setups:
        setups_block = "\n\nSETUP ALGORITMICI (usa questi numeri ESATTI nel JSON top_setup):\n"
        for s in scanner_setups[:4]:
            setups_block += (
                f"  {s['simbolo']} {s['direzione']} | {s['strategia']} | "
                f"Score: {s.get('score',0)}% | WR: {s.get('winrate','?')}% | "
                f"Entry: {s['entry']} | SL: {s['sl']} | TP: {s['tp1']}\n"
            )

    user_content = f"""WATCHLIST: {', '.join(wl)}
{prices_lines}{tech_snapshot_lines}{scanner_section}{setups_block}

NOTIZIE PRINCIPALI:
{news_text}

EVENTI OGGI:
{cal_text}

IMPORTANTE: Copia i numeri ESATTI dall'algoritmo (entry, SL, TP). Il tuo ruolo è solo spiegare il contesto macro. Genera il briefing mattutino completo."""

    try:
        with client.messages.stream(
            model="claude-opus-4-7",
            max_tokens=3000,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _BRIEFING_SYSTEM,
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": user_content}],
        ) as stream:
            msg = stream.get_final_message()
        return _parse_json_response(_extract_text(msg))
    except Exception as e:
        print(f"[AI briefing] {e}")
        # Fallback dinamico con prezzi live — mai valori hardcoded
        return _dynamic_briefing_fallback(prices or {}, calendar, wl)


def ai_technical_analysis(symbol: str) -> dict:
    sym_upper = symbol.upper()
    price_data = get_live_prices([sym_upper]).get(sym_upper, {})
    price = price_data.get("price", MOCK_PRICES.get(sym_upper, 1.0))
    is_live = price_data.get("source") == "live"
    chg_pct = price_data.get("change_pct", 0.0)
    price_note = "prezzo live" if is_live else "prezzo di riferimento"

    # ── Indicatori tecnici reali da OHLCV ─────────────────────────
    real_ind = get_real_indicators(sym_upper)
    if real_ind:
        ind_block = (
            f"\n\nINDICATORI TECNICI REALI (da OHLCV Yahoo Finance):\n"
            f"  RSI(14): {real_ind['rsi_14']}  → {real_ind['rsi_segnale']}\n"
            f"  EMA20: {real_ind['ema20']}  EMA50: {real_ind['ema50']}  EMA200: {real_ind['ema200']}\n"
            f"  ATR(14): {real_ind['atr']}  (usa questo per calibrare SL/TP)\n"
            f"  MACD: {real_ind['macd_signal']} | Istogramma: {real_ind['macd_istogramma']}\n"
            f"  BB Upper: {real_ind['bb_upper']}  Mid: {real_ind['bb_mid']}  Lower: {real_ind['bb_lower']}\n"
            f"  Trend: {real_ind['trend_principale']} (forza {real_ind['forza_trend']}/10) | {real_ind['posizione_vs_medie']}\n"
            f"  Supporti: {real_ind['supporti']}\n"
            f"  Resistenze: {real_ind['resistenze']}\n"
            + (f"  ⚠️ DIVERGENZA RSI RIALZISTA RILEVATA\n" if real_ind.get("bullish_div") else "")
            + (f"  ⚠️ DIVERGENZA RSI RIBASSISTA RILEVATA\n" if real_ind.get("bearish_div") else "")
            + f"\n  SL max LONG: {_fmt_price(real_ind['price'] - real_ind['atr'] * 1.5)}"
            + f"  SL max SHORT: {_fmt_price(real_ind['price'] + real_ind['atr'] * 1.5)}"
        )
    else:
        ind_block = "\n\n(Indicatori OHLCV non disponibili per questo simbolo)"

    # ── Contesto macro da cache notizie ──────────────────────────
    relevant_news = [
        n for n in _last_analyzed_news
        if sym_upper in (n.get("strumenti_impattati") or [])
    ][:4]
    # Fallback: notizie macro generali (Fed, BCE, CPI, NFP…)
    if not relevant_news:
        MACRO_KEYS = {"FED","BCE","BOE","BOJ","CPI","NFP","GDP","INFLAZIONE","GEOPOLITICA"}
        relevant_news = [
            n for n in _last_analyzed_news
            if any(k in n.get("titolo_it","").upper() or
                   k == n.get("categoria","") for k in MACRO_KEYS)
        ][:3]

    # Filtra eventi calendario per valuta legata al simbolo
    CURRENCY_MAP = {
        "XAUUSD":"USD","XAGUSD":"USD","EURUSD":"EUR","GBPUSD":"GBP",
        "USDJPY":"JPY","GBPJPY":"GBP","AUDUSD":"AUD","USDCAD":"CAD",
        "EURJPY":"EUR","NZDUSD":"NZD","USDCHF":"CHF","BTCUSD":"USD",
        "US500":"USD","NASDAQ":"USD","DAX":"EUR","USOIL":"USD",
    }
    related_ccy = CURRENCY_MAP.get(sym_upper, "USD")
    upcoming_events = [
        e for e in _last_calendar_events
        if e.get("currency","") in (related_ccy, "USD") and e.get("impact") in ("HIGH","MEDIUM")
    ][:4]

    # ── Blocco contesto macro ─────────────────────────────────────
    macro_block = ""
    if relevant_news:
        macro_block += "\n\nNOTIZIE MACRO RILEVANTI:\n" + "\n".join(
            f"  [{n.get('segnale','?')}] {n.get('titolo_it', n.get('title',''))}"
            f" | Sentiment: {n.get('sentiment','')} | WinRate: {n.get('winrate','')}%"
            for n in relevant_news
        )
    if upcoming_events:
        macro_block += "\n\nEVENTI CALENDARIO IMMINENTI:\n" + "\n".join(
            f"  {e['time']} {e['currency']} - {e['event']} ({e['impact']})"
            f" | Prev:{e.get('previous','')} Fore:{e.get('forecast','')}"
            for e in upcoming_events
        )
    if not macro_block:
        macro_block = "\n\n(Nessun dato macro recente in cache — analisi solo tecnica)"

    user_content = (
        f"Genera analisi tecnica integrata per {sym_upper}.\n"
        f"Prezzo attuale: {price} ({price_note})\n"
        f"Variazione giornaliera: {chg_pct:+.2f}%"
        f"{ind_block}"
        f"{macro_block}\n\n"
        f"CRITICO: entry_price, stop_loss, tp1, tp2 DEVONO essere calcolati "
        f"partendo dal prezzo ATTUALE {price}. Non usare livelli storici."
    )

    try:
        with client.messages.stream(
            model="claude-opus-4-7",
            max_tokens=2500,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _TECHNICAL_SYSTEM,
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": user_content}],
        ) as stream:
            msg = stream.get_final_message()
        result = _parse_json_response(_extract_text(msg))
        # Override Claude's guesses with real indicator values
        if real_ind:
            result.update({k: real_ind[k] for k in [
                "rsi_14", "rsi_segnale", "ma50", "ma200", "posizione_vs_medie",
                "macd_signal", "macd_istogramma", "trend_principale", "forza_trend",
                "supporti", "resistenze"
            ] if k in real_ind})
        return result
    except Exception as e:
        print(f"[AI technical] {e}")
        real_ind = get_real_indicators(sym_upper)
        if real_ind:
            nd = _ndec(price)
            atr = real_ind.get("atr", price * 0.01)
            return {**real_ind, "simbolo": sym_upper, "prezzo_attuale": price,
                    "pattern": "Nessuno", "bias_giornaliero": real_ind.get("trend_principale", "LATERALE"),
                    "confluenze": ["EMA", "RSI", "MACD"], "note": "Analisi dati reali (AI offline).",
                    "winrate_setup": 60,
                    "setup_operativo": {
                        "direzione": "LONG" if real_ind.get("trend_principale") == "RIALZISTA" else "SHORT",
                        "zona_entrata": f"Area {_fmt_price(price)}",
                        "entry_price": _fmt_price(price),
                        "stop_loss": _fmt_price(price - atr * 1.5) if real_ind.get("trend_principale") == "RIALZISTA" else _fmt_price(price + atr * 1.5),
                        "tp1": _fmt_price(price + atr * 2) if real_ind.get("trend_principale") == "RIALZISTA" else _fmt_price(price - atr * 2),
                        "tp2": _fmt_price(price + atr * 3.5) if real_ind.get("trend_principale") == "RIALZISTA" else _fmt_price(price - atr * 3.5),
                        "risk_reward": 1.5, "timeframe": "D1"
                    }}
        return {"simbolo": sym_upper, "prezzo_attuale": price, "trend_principale": "LATERALE",
                "forza_trend": 5, "note": "Analisi non disponibile.", "winrate_setup": 50}


def ai_analyze_calendar(events: List[dict]) -> List[dict]:
    if not events:
        return []

    n = min(len(events), 8)
    ev_text = "\n".join(
        f"[{i+1}] {e['time']} {e['currency']} - {e['event']} | {e['impact']} | "
        f"Prev:{e.get('previous','')} Fore:{e.get('forecast','')}"
        for i, e in enumerate(events[:n])
    )

    try:
        with client.messages.stream(
            model="claude-opus-4-7",
            max_tokens=4000,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _CALENDAR_SYSTEM,
                "cache_control": {"type": "ephemeral"}
            }],
            messages=[{"role": "user", "content": f"Analizza questi {n} eventi (id 1-{n}):\n\n{ev_text}"}],
        ) as stream:
            msg = stream.get_final_message()
        analyses = _parse_json_response(_extract_text(msg))
        result = []
        for i, ev in enumerate(events[:n]):
            ana = next((a for a in analyses if a.get("id") == i + 1), {})
            result.append({**ev, **ana, "id": i + 1})
        return result
    except Exception as e:
        print(f"[AI calendar] {e}")
        return [{**ev, "id": i+1} for i, ev in enumerate(events[:n])]


# ─── API ROUTES ───────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/api/news")
async def get_news(force: bool = False):
    global _news_cache, _news_cache_time
    if not force and _news_cache and _news_cache_time and (datetime.now() - _news_cache_time).seconds < CACHE_MINUTES * 60:
        return _news_cache

    raw = scrape_marketwatch() + scrape_seekingalpha() + scrape_investing_com()
    if len(raw) < 3:
        raw = mock_news()

    analyzed = ai_analyze_news(raw)
    global _last_analyzed_news
    _last_analyzed_news = analyzed          # ← cache per analisi tecnica
    result = {"news": analyzed, "count": len(analyzed), "timestamp": datetime.now().isoformat(), "cached": False}
    _news_cache = result
    _news_cache_time = datetime.now()
    return result

@app.get("/api/calendar")
async def get_calendar():
    global _last_calendar_events
    events = scrape_forexfactory_calendar()
    if len(events) < 3:
        events = mock_calendar()
    analyzed = ai_analyze_calendar(events)
    _last_calendar_events = analyzed        # ← cache per analisi tecnica
    return {"events": analyzed, "count": len(analyzed), "timestamp": datetime.now().isoformat()}

@app.post("/api/briefing")
async def generate_briefing():
    global _last_analyzed_news, _last_calendar_events

    # Notizie reali
    raw_news = scrape_marketwatch()[:3] + scrape_seekingalpha()[:2]
    if len(raw_news) < 3:
        raw_news = mock_news()[:5]
    analyzed_news = ai_analyze_news(raw_news)
    _last_analyzed_news = analyzed_news     # ← aggiorna cache condivisa

    # Calendario reale
    calendar = scrape_forexfactory_calendar()
    if len(calendar) < 3:
        calendar = mock_calendar()
    _last_calendar_events = calendar        # ← aggiorna cache condivisa

    # Prezzi live → Claude genera SL/TP sui livelli attuali
    prices = get_live_prices(_watchlist)

    # Improvement 6: run scanner before briefing for algorithmic context
    all_setups = []
    for sym in _watchlist:
        try:
            ind = get_real_indicators(sym)
            if ind:
                strats = scan_strategies(sym, ind)
                all_setups.extend(strats)
        except Exception as e_scan:
            print(f"[Briefing scan] {sym}: {e_scan}")

    # Arricchisci con score per il briefing
    for s in all_setups:
        ind = get_real_indicators(s["simbolo"])
        if ind:
            sc = compute_signal_score(s["simbolo"], ind, s)
            s["score"] = sc["score"]

    briefing = ai_generate_briefing(analyzed_news, calendar, _watchlist, prices, scanner_setups=all_setups)
    return {"briefing": briefing, "timestamp": datetime.now().isoformat()}

@app.get("/api/technical/{symbol}")
async def get_technical(symbol: str):
    result = ai_technical_analysis(symbol.upper())
    return {"analysis": result, "timestamp": datetime.now().isoformat()}

@app.get("/api/prices")
async def get_prices(symbols: Optional[str] = None):
    """Restituisce prezzi live (o mock) per i simboli richiesti."""
    syms = [s.strip().upper() for s in symbols.split(",")] if symbols else _watchlist
    prices = get_live_prices(syms)
    live_count = sum(1 for p in prices.values() if p.get("source") == "live")
    return {
        "prices": prices,
        "live_count": live_count,
        "total": len(prices),
        "timestamp": datetime.now().isoformat(),
    }

@app.get("/api/watchlist")
async def get_watchlist():
    return {"watchlist": _watchlist}

@app.post("/api/watchlist/{symbol}")
async def add_watchlist(symbol: str):
    s = symbol.upper()
    if s not in _watchlist:
        _watchlist.append(s)
    return {"watchlist": _watchlist}

@app.delete("/api/watchlist/{symbol}")
async def del_watchlist(symbol: str):
    s = symbol.upper()
    if s in _watchlist:
        _watchlist.remove(s)
    return {"watchlist": _watchlist}

@app.get("/api/scan")
async def scan_market(force: bool = False, debug: bool = False):
    """
    Scansione algoritmica completa:
    1. Indicatori reali (RSI, EMA, ATR, ADX, BB, MTF, Vol)
    2. Segnali algoritmici (5 strategie)
    3. Score probabilistico composito (0-100)
    4. Win rate storico da backtest su OHLCV reale
    5. Claude come auditor fondamentale (CONFERMA/DIVERGE)
    Solo setup con score >= 55 e R:R >= 1.0 vengono mostrati.
    Usa ?debug=true per vedere tutti i setup pre-filtro con motivo eliminazione.
    """
    all_setups = []
    prices = get_live_prices(_watchlist)

    for sym in _watchlist:
        ind = get_real_indicators(sym)
        if not ind:
            continue
        strats = scan_strategies(sym, ind)
        pd_info = prices.get(sym, {})
        for s in strats:
            s["price_live"]  = pd_info.get("price", 0)
            s["change_pct"]  = pd_info.get("change_pct", 0.0)
            # Probabilistic score
            sc = compute_signal_score(sym, ind, s)
            s["score"]           = sc["score"]
            s["score_class"]     = sc["classification"]
            s["score_factors"]   = sc["factors"]
            # Historical win rate from backtest
            bt = backtest_strategy(sym, s["strategia"], s["direzione"])
            s["win_rate_storico"] = bt["win_rate"]
            s["bt_total"]         = bt["total"]
            s["bt_wins"]          = bt["wins"]
            s["bt_losses"]        = bt["losses"]
            # Use historical WR if available, else keep algorithmic WR
            if bt["win_rate"] is not None and bt["total"] >= 10:
                s["winrate"] = int(bt["win_rate"])
            all_setups.append(s)

    # Debug mode: return pre-filter data with rejection reasons
    if debug:
        for s in all_setups:
            reasons = []
            if s.get("score", 0) < 55:
                reasons.append(f"score={s.get('score',0)} < 55")
            if s.get("bt_total", 0) >= 10 and s.get("win_rate_storico") is not None and s["win_rate_storico"] < 40:
                reasons.append(f"WR storico={s.get('win_rate_storico')}% < 40% (n={s.get('bt_total',0)})")
            s["_rejected"] = bool(reasons)
            s["_reject_reasons"] = reasons
        return {
            "setups": all_setups,
            "count_total": len(all_setups),
            "count_passing": sum(1 for s in all_setups if not s.get("_rejected")),
            "timestamp": datetime.now().isoformat()
        }

    # Filter 1: score >= 55 (calendario -10pts non deve eliminare setup validi)
    all_setups = [s for s in all_setups if s.get("score", 0) >= 55]
    # Filter 2: WR storico < 40% con campione sufficiente → setup non affidabile su questo simbolo
    all_setups = [
        s for s in all_setups
        if not (s.get("bt_total", 0) >= 10 and s.get("win_rate_storico") is not None and s["win_rate_storico"] < 40)
    ]
    all_setups.sort(key=lambda x: (-x.get("score", 0), -x.get("winrate", 0)))

    # Claude fundamental audit (batch, one call for all setups)
    verdicts = {}
    if all_setups and _last_analyzed_news:
        verdicts = ai_audit_setups(all_setups, _last_analyzed_news, _last_calendar_events)

    # Attach verdicts
    for s in all_setups:
        key = (s["simbolo"], s["direzione"])
        v = verdicts.get(key, {})
        s["ai_verdetto"]     = v.get("verdetto", "NEUTRO")
        s["ai_motivazione"]  = v.get("motivazione", "Nessun segnale macro rilevante.")

    return {
        "setups": all_setups,
        "count": len(all_setups),
        "symbols_scanned": len(_watchlist),
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/indicators/{symbol}")
async def get_indicators_debug(symbol: str):
    """Debug endpoint: restituisce indicatori grezzi da get_real_indicators()."""
    ind = get_real_indicators(symbol.upper())
    # Also run scan to show which conditions fail
    strats = scan_strategies(symbol.upper(), ind) if ind else []
    return {"indicators": ind, "setups_found": len(strats), "setups": strats,
            "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
