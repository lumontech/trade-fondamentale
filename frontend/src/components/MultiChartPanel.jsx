// MultiChartPanel — 3 chart live side-by-side suddivisi per source:
//   1) Binance     → BTCUSD (kline WS realtime)
//   2) TwelveData  → EURUSD (REST + WS price tick)
//   3) Hyperliquid → HYPEUSDC (WS native channel candle)
//
// Ogni chart è un mini-pannello con header + lightweight-charts (200px height).
// Source selector inline per cambiare simbolo/timeframe.
import { useEffect, useRef, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'
import { loadCandles, subscribeRealtime } from '../services/DataHub'
import { useAppStore } from '../store/store'
import { TradingViewAdvancedChart, TradingViewMiniChart } from './TradingViewWidget'

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D']

const SLOTS = [
  {
    id: 'binance',
    title: 'Binance',
    subtitle: 'Crypto Spot',
    options: ['BTCUSD', 'ETHUSD', 'BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'BNBUSDC'],
    defaultSymbol: 'BTCUSD',
    color: '#f0b90b',
  },
  {
    id: 'twelvedata',
    title: 'TwelveData',
    subtitle: 'Forex & XAU',
    options: ['EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY', 'XAUUSD'],
    defaultSymbol: 'EURUSD',
    color: '#3b82f6',
  },
  {
    id: 'hyperliquid',
    title: 'Hyperliquid',
    subtitle: 'DEX Perp',
    options: ['HYPEUSDC', 'BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'BNBUSDC'],
    defaultSymbol: 'HYPEUSDC',
    color: '#00e096',
  },
]

// Fix #5.8: shift candle time da UTC a local timezone del browser
// così lightweight-charts mostra l'asse X in ora locale (CEST per Italia).
const TZ_OFFSET_SEC = -new Date().getTimezoneOffset() * 60
const toLocalTime = (c) => ({ ...c, time: c.time + TZ_OFFSET_SEC })

function MiniChart({ slot }) {
  const containerRef = useRef(null)
  const chartRef     = useRef(null)
  const seriesRef    = useRef(null)
  const unsubRef     = useRef(null)
  const [symbol, setSymbol] = useState(slot.defaultSymbol)
  const [tf, setTf]         = useState('15m')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)
  // Sub al store per refresh live
  const candles = useAppStore(s => s.instruments[symbol]?.candles ?? [])
  const price   = useAppStore(s => s.instruments[symbol]?.price)
  const pct     = useAppStore(s => s.instruments[symbol]?.pct ?? 0)

  // Init chart
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#999',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#222' },
        horzLines: { color: '#222' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#333' },
      timeScale: { borderColor: '#333', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: 280,
    })
    const series = chart.addCandlestickSeries({
      upColor: '#00e096', downColor: '#ff3355',
      borderVisible: false,
      wickUpColor: '#00e096', wickDownColor: '#ff3355',
    })
    chartRef.current = chart
    seriesRef.current = series
    // Resize observer
    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [])

  // Load candles + subscribe live al cambio symbol/tf
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadCandles(symbol, tf).then(res => {
      if (cancelled) return
      if (res.error) {
        setError(res.error)
        setLoading(false)
        return
      }
      if (seriesRef.current && res.candles?.length) {
        seriesRef.current.setData(res.candles.map(c => toLocalTime({
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
        })))
        if (chartRef.current) chartRef.current.timeScale().fitContent()
      }
      setLoading(false)
    }).catch(err => {
      if (!cancelled) {
        setError(err.message)
        setLoading(false)
      }
    })
    // Subscribe realtime per push updates
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    unsubRef.current = subscribeRealtime(symbol, tf)
    return () => {
      cancelled = true
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    }
  }, [symbol, tf])

  // Aggiorna ultima candela live al cambio store
  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    const last = candles[candles.length - 1]
    seriesRef.current.update(toLocalTime({
      time: last.time, open: last.open, high: last.high, low: last.low, close: last.close,
    }))
  }, [candles])

  const fmtPrice = (p) => p == null ? '—' : (p < 1 ? p.toFixed(5) : p < 100 ? p.toFixed(3) : p.toFixed(2))
  const pctColor = pct >= 0 ? '#00e096' : '#ff3355'

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border flex flex-col overflow-hidden">
      {/* Header slot */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border">
        <div className="flex items-center gap-2">
          <span style={{ color: slot.color }} className="text-base">●</span>
          <div>
            <div className="font-mono font-semibold text-sm" style={{ color: slot.color }}>{slot.title}</div>
            <div className="text-xxs text-text-muted">{slot.subtitle}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono font-bold tabular-nums text-base">{fmtPrice(price)}</div>
          <div className="font-mono text-xxs tabular-nums" style={{ color: pctColor }}>
            {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Selector symbol + tf */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-bg-border bg-bg-primary/40">
        <select
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          className="bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-xs font-mono"
        >
          {slot.options.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex gap-1">
          {TIMEFRAMES.map(t => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2 py-0.5 text-xxs rounded font-mono ${
                tf === t ? 'bg-gold/20 text-gold border border-gold/40' : 'bg-bg-primary text-text-muted hover:text-text-primary'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative flex-1 min-h-[280px]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted z-10 bg-bg-secondary/60">
            Caricamento…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red z-10 bg-bg-secondary/60 px-4 text-center">
            Errore: {error}
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  )
}

// Asset "macro" che mostriamo via TradingView (feed broker reali, no API key richiesta).
// Indici USA (US500/NAS100/DXY → TVC:SPX/NDQ/DXY) rimossi: TradingView mostra un popup
// "disponibile solo su TradingView" che richiede account loggato per visualizzare le candele.
// Restano i feed OANDA (forex/oro) e TVC:USOIL che non hanno la limitazione.
const TV_MACRO_SLOTS = [
  { symbol: 'XAUUSD', label: 'Gold',        interval: '1h' },
  { symbol: 'USOIL',  label: 'WTI Oil',     interval: '1h' },
  { symbol: 'EURUSD', label: 'EUR/USD',     interval: '1h' },
]

export default function MultiChartPanel() {
  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-4 bg-bg-primary">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-mono font-semibold text-gold">Multi-Chart Live</h1>
        <p className="text-xs text-text-muted font-mono">WebSocket nativo + TradingView ufficiali</p>
      </div>

      {/* ── Sezione 1: 3 chart con feed nativo (Binance + TD + Hyperliquid) ── */}
      <div>
        <h2 className="text-xs font-mono uppercase tracking-wider text-text-secondary mb-2">
          Live WebSocket Nativo
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {SLOTS.map(slot => <MiniChart key={slot.id} slot={slot} />)}
        </div>
      </div>

      {/* ── Sezione 2: 6 chart TradingView per asset macro ── */}
      <div>
        <h2 className="text-xs font-mono uppercase tracking-wider text-text-secondary mb-2">
          Macro & Indici via TradingView (feed broker live)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {TV_MACRO_SLOTS.map(s => (
            <div
              key={s.symbol}
              className="bg-bg-secondary border border-bg-border rounded-md overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-bg-border bg-bg-primary/40">
                <span className="font-mono text-xs text-gold">{s.symbol}</span>
                <span className="font-mono text-xxs text-text-muted">{s.label}</span>
              </div>
              <div style={{ height: 280 }}>
                <TradingViewAdvancedChart
                  symbol={s.symbol}
                  interval={s.interval}
                  theme="dark"
                  studies={['STD;EMA']}
                  hideSideToolbar
                  hideTopToolbar
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer info */}
      <div className="text-xxs text-text-muted font-mono flex flex-wrap gap-x-6 gap-y-1 mt-auto">
        <span>● Binance: <code className="text-text-primary">wss://stream.binance.com</code> kline stream</span>
        <span>● TwelveData: WS price + REST candles refresh 90s</span>
        <span>● Hyperliquid: <code className="text-text-primary">wss://api.hyperliquid.xyz/ws</code> channel candle</span>
        <span>● TradingView: widget embed ufficiale, feed broker aggregati live</span>
      </div>
    </div>
  )
}
