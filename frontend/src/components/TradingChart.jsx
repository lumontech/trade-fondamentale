import { useEffect, useRef, useCallback, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'
import { useAppStore } from '../store/store'
import { calculateEMA } from '../utils/indicators'
import { loadCandles, subscribeRealtime, loadMultiTFCandles } from '../services/DataHub'
import { getBinanceStreamHealth } from '../services/BinanceService'
import { useAppStore as _store } from '../store/store'
import { detectAllPatterns } from '../services/PatternsEngine'
import { calculateVolumeProfile } from '../services/VolumeProfile'
import { calculateFibonacci, calculateIchimoku } from '../services/IndicatorsExtended'
import { detectTrendlines } from '../services/TrendlinesEngine'
import { formatPrice, formatPips } from '../utils/format'
import { TD_ETF_LABEL } from '../services/TwelveDataService'
import { TradingViewAdvancedChart } from './TradingViewWidget'

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D']

// Chart engine: 'native' = lightweight-charts custom, 'tradingview' = widget TV.
// Persistito in localStorage così la scelta sopravvive ai reload.
// Default: TradingView (zero API quotas, dati live per tutti gli asset).
const CHART_ENGINE_KEY = 'itp_chart_engine'
const loadChartEngine = () => {
  try { return localStorage.getItem(CHART_ENGINE_KEY) || 'tradingview' }
  catch { return 'tradingview' }
}

export default function TradingChart() {
  const [engine, setEngine] = useState(loadChartEngine())
  const switchEngine = (e) => {
    setEngine(e)
    try { localStorage.setItem(CHART_ENGINE_KEY, e) } catch {}
  }

  const containerRef = useRef(null)
  const chartRef     = useRef(null)
  const seriesRef    = useRef({})
  const lastSymbolRef = useRef(null)
  const lastTfRef     = useRef(null)

  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const setTimeframe     = useAppStore(s => s.setActiveTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])
  const price            = useAppStore(s => s.instruments[activeInstrument]?.price)
  const pct              = useAppStore(s => s.instruments[activeInstrument]?.pct ?? 0)
  const apiKeys          = useAppStore(s => s.apiKeys)
  // Fix #5.9: position attiva per overlay entry/SL/TP sul chart
  const activePosition   = useAppStore(s => s.activePosition)
  const setActivePosition = useAppStore(s => s.setActivePosition)
  // Asset che hanno fonte dati alternativa senza chiave (Binance crypto, Hyperliquid HYPE,
  // Yahoo Finance fallback per forex/XAU/oil). Per loro non blocchiamo il caricamento
  // anche senza Twelve Data key — il DataHub usa il fallback in automatico.
  const YAHOO_FALLBACK = new Set([
    'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY', 'USOIL', 'DXY',
  ])
  const noKeyFallback    = activeInstrument === 'BTCUSD'
                        || YAHOO_FALLBACK.has(activeInstrument)
                        || activeInstrument.endsWith('USDC')   // Hyperliquid + Binance USDC perps
  const needsKey         = !noKeyFallback && !apiKeys.twelvedata

  // ── Create chart on mount ─────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background:  { type: 'solid', color: '#04060a' },
        textColor:   '#8892a4',
        fontSize:    11,
        fontFamily:  'IBM Plex Mono, monospace',
      },
      grid: {
        vertLines: { color: '#1e253566', style: 1 },
        horzLines: { color: '#1e253566', style: 1 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#8892a488', style: 1, labelBackgroundColor: '#161b27' },
        horzLine: { color: '#8892a488', style: 1, labelBackgroundColor: '#161b27' },
      },
      rightPriceScale: {
        borderColor: '#1e2535',
        textColor:   '#8892a4',
        scaleMargins: { top: 0.05, bottom: 0.2 },
      },
      timeScale: {
        borderColor:    '#1e2535',
        textColor:      '#8892a4',
        timeVisible:    true,
        secondsVisible: false,
        barSpacing:     6,
        // I timestamp sono già shiftati nel render → uso getUTC* per leggerli come local
        // tickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
        tickMarkFormatter: (time, tickMarkType) => {
          const d = new Date(time * 1000)
          const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic']
          if (tickMarkType === 0) return String(d.getUTCFullYear())
          if (tickMarkType === 1) return months[d.getUTCMonth()]
          if (tickMarkType === 2) return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]}`
          const hh = String(d.getUTCHours()).padStart(2, '0')
          const mm = String(d.getUTCMinutes()).padStart(2, '0')
          return `${hh}:${mm}`
        },
      },
      // Tooltip crosshair: i timestamp sono già shiftati nel render, usa getUTC* per leggerli come local
      localization: {
        timeFormatter: (time) => {
          const d = new Date(time * 1000)
          const day   = String(d.getUTCDate()).padStart(2, '0')
          const month = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'][d.getUTCMonth()]
          const year  = String(d.getUTCFullYear()).slice(-2)
          const hh    = String(d.getUTCHours()).padStart(2, '0')
          const mm    = String(d.getUTCMinutes()).padStart(2, '0')
          return `${day} ${month} ${year}, ${hh}:${mm}`
        },
      },
      handleScroll:   true,
      handleScale:    true,
    })

    // Candlestick series
    const candles = chart.addCandlestickSeries({
      upColor:        '#00e096',
      downColor:      '#ff3355',
      borderUpColor:  '#00e096',
      borderDownColor:'#ff3355',
      wickUpColor:    '#00e096',
      wickDownColor:  '#ff3355',
    })

    // Volume (overlaid at bottom)
    const volume = chart.addHistogramSeries({
      priceFormat:  { type: 'volume' },
      priceScaleId: 'vol',
      scaleMargins: { top: 0.82, bottom: 0 },
      color: '#1e2535',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    // EMA lines
    const ema20  = chart.addLineSeries({ color: '#2196F3', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false })
    const ema50  = chart.addLineSeries({ color: '#FF9800', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false })
    const ema200 = chart.addLineSeries({ color: '#9C27B0', lineWidth: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false })

    seriesRef.current = { candles, volume, ema20, ema50, ema200, trendlineSeries: [] }
    chartRef.current  = chart

    // Resize
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      chart.resize(width, height)
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current  = null
      seriesRef.current = {}
    }
  }, [])

  // ── Load new candles when instrument or timeframe changes ─────
  useEffect(() => {
    if (needsKey) return
    // Pulisci subito le vecchie candele per evitare mix con quelle del nuovo TF
    _store.getState().setCandles(activeInstrument, [])
    loadCandles(activeInstrument, activeTimeframe)
    // Carica anche le altre TF per la confluenza (background, rate-limited)
    loadMultiTFCandles(activeInstrument)

    // Refresh quando l'utente torna alla tab (dopo background)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !needsKey) {
        loadCandles(activeInstrument, activeTimeframe)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [activeInstrument, activeTimeframe, needsKey, apiKeys.twelvedata])

  // ── Subscribe to real-time updates ───────────────────────────
  useEffect(() => {
    if (needsKey) return
    subscribeRealtime(activeInstrument, activeTimeframe)

    // Fallback periodico: se il WS dovesse silenziarsi, ricarica le candele via REST.
    // Per Binance ~ogni 60s; il watchdog interno del WS gestirà il reconnect indipendentemente.
    const fallback = setInterval(() => {
      const health = (activeInstrument === 'BTCUSD' || activeInstrument === 'ETHUSD')
        ? getBinanceStreamHealth(activeInstrument, activeTimeframe) : null
      if (health && (health.silentForMs == null || health.silentForMs > 60_000)) {
        // WS muto da >60s → REST refresh
        loadCandles(activeInstrument, activeTimeframe)
      }
    }, 60_000)

    return () => clearInterval(fallback)
  }, [activeInstrument, activeTimeframe, needsKey])

  // ── Live stream health monitor (solo Binance per ora) ────────
  const [streamHealth, setStreamHealth] = useState(null)
  useEffect(() => {
    if (activeInstrument !== 'BTCUSD' && activeInstrument !== 'ETHUSD') {
      setStreamHealth(null)
      return
    }
    const tick = () => setStreamHealth(getBinanceStreamHealth(activeInstrument, activeTimeframe))
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [activeInstrument, activeTimeframe])

  // ── Render candles + overlays ─────────────────────────────────
  useEffect(() => {
    const { candles: cs, volume: vol, ema20, ema50, ema200 } = seriesRef.current
    if (!cs) return

    // Clear chart immediately when switching to an instrument with no data yet
    if (!candles.length) {
      cs.setData([])
      vol?.setData([])
      ema20?.setData([])
      ema50?.setData([])
      ema200?.setData([])
      lastSymbolRef.current = activeInstrument
      lastTfRef.current     = activeTimeframe
      return
    }

    // Lightweight-charts visualizza in UTC. Shifto i timestamp di -getTimezoneOffset() (in secondi)
    // così, interpretati come UTC dalla libreria, appaiono come local time.
    // Es: 11:00 UTC + 7200s = 13:00 visualizzato (corretto in Italia/CEST).
    const tzShift = -new Date().getTimezoneOffset() * 60
    // Safety net: ordina per time + dedup (lightweight-charts crasha se non ascending)
    const seenTime = new Set()
    const cleaned = []
    const sorted = [...candles].sort((a, b) => a.time - b.time)
    for (const c of sorted) {
      if (!seenTime.has(c.time)) {
        seenTime.add(c.time)
        cleaned.push(c)
      }
    }
    const localized = cleaned.map(c => ({ ...c, time: c.time + tzShift }))
    const ema20Data  = calculateEMA(candles, 20).map(p => ({ ...p, time: p.time + tzShift }))
    const ema50Data  = calculateEMA(candles, 50).map(p => ({ ...p, time: p.time + tzShift }))
    const ema200Data = calculateEMA(candles, 200).map(p => ({ ...p, time: p.time + tzShift }))

    cs.setData(localized)

    vol?.setData(localized.map(c => ({
      time:  c.time,
      value: c.volume,
      color: c.close >= c.open ? '#00e09622' : '#ff335522',
    })))

    ema20?.setData(ema20Data)
    ema50?.setData(ema50Data)
    ema200?.setData(ema200Data)

    // ── Volume Profile + Fibonacci: priceLines sul chart ────────
    try {
      // Pulisci priceLines vecchie
      if (cs._extraLines) cs._extraLines.forEach(l => cs.removePriceLine(l))
      cs._extraLines = []

      // Volume Profile: POC, VAH, VAL
      const vp = calculateVolumeProfile(candles, 100, 30)
      if (vp) {
        cs._extraLines.push(cs.createPriceLine({
          price: vp.poc, color: '#f5c842', lineWidth: 2, lineStyle: 2,
          axisLabelVisible: true, title: 'POC',
        }))
        cs._extraLines.push(cs.createPriceLine({
          price: vp.vah, color: '#00e09680', lineWidth: 1, lineStyle: 3,
          axisLabelVisible: true, title: 'VAH',
        }))
        cs._extraLines.push(cs.createPriceLine({
          price: vp.val, color: '#ff335580', lineWidth: 1, lineStyle: 3,
          axisLabelVisible: true, title: 'VAL',
        }))
      }

      // Fibonacci Retracement (livelli chiave: 38.2%, 50%, 61.8%)
      const fib = calculateFibonacci(candles, 120)
      if (fib) {
        const keyLevels = fib.retracement.filter(l => [0.382, 0.5, 0.618, 0.786].includes(l.ratio))
        for (const lvl of keyLevels) {
          const isGolden = lvl.ratio === 0.618
          cs._extraLines.push(cs.createPriceLine({
            price: lvl.price,
            color: isGolden ? '#cc785cdd' : '#cc785c80',
            lineWidth: isGolden ? 2 : 1,
            lineStyle: 1,
            axisLabelVisible: true,
            title: `Fib ${(lvl.ratio * 100).toFixed(1)}%`,
          }))
        }
      }

      // Fix #5.9 + #5.11: overlay posizione attiva (entry/SL/TP) — guard numeric values
      if (activePosition && activePosition.symbol === activeInstrument) {
        const dirSign = activePosition.direction === 'long' ? '▲' : '▼'
        const eN = Number(activePosition.entry)
        const sN = Number(activePosition.sl)
        const tN = Number(activePosition.tp)
        if (Number.isFinite(eN)) {
          cs._extraLines.push(cs.createPriceLine({
            price: eN,
            color: activePosition.direction === 'long' ? '#00e096' : '#ff3355',
            lineWidth: 2, lineStyle: 0,
            axisLabelVisible: true,
            title: `${dirSign} ENTRY`,
          }))
        }
        if (Number.isFinite(sN)) {
          cs._extraLines.push(cs.createPriceLine({
            price: sN,
            color: '#ff3355', lineWidth: 2, lineStyle: 2,
            axisLabelVisible: true, title: 'SL',
          }))
        }
        if (Number.isFinite(tN)) {
          cs._extraLines.push(cs.createPriceLine({
            price: tN,
            color: '#00e096', lineWidth: 2, lineStyle: 2,
            axisLabelVisible: true, title: 'TP',
          }))
        }
      }
    } catch (err) { /* skip on transient errors */ }

    // ── Trendlines automatiche ─────────────────────────────────
    try {
      // Rimuovi trendline series precedenti
      if (seriesRef.current.trendlineSeries?.length) {
        seriesRef.current.trendlineSeries.forEach(s => chartRef.current?.removeSeries(s))
        seriesRef.current.trendlineSeries = []
      }
      const trendlines = detectTrendlines(candles, 100, 3)
      for (const tl of trendlines.slice(0, 4)) {  // max 4 trendline visibili
        const lineSeries = chartRef.current.addLineSeries({
          color: tl.type === 'resistance' ? '#ff335580' : '#00e09680',
          lineWidth: tl.strength === 'major' ? 2 : 1,
          lineStyle: tl.broken ? 3 : 0,   // dashed se rotta
          crosshairMarkerVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        lineSeries.setData([
          { time: tl.from_time + tzShift, value: tl.from_price },
          { time: tl.to_time + tzShift,   value: tl.to_price },
        ])
        seriesRef.current.trendlineSeries.push(lineSeries)
      }
    } catch (err) { /* skip */ }

    // ── Pattern markers sul chart (ultime ~30 candele) ─────────
    try {
      const patterns = detectAllPatterns(candles).slice(0, 12)
      const markers = patterns
        .filter(p => p.time != null)
        .map(p => {
          const isBull = p.bias === 'bullish'
          const color = isBull ? '#00e096' : p.bias === 'bearish' ? '#ff3355' : '#f5c842'
          const shape = p.type === 'harmonic' ? 'circle' : 'arrowUp'
          // Prefisso icona per tipo pattern
          const icon = p.type === 'harmonic' ? '◊' : p.type === 'chart' ? '◆' : ''
          return {
            time: p.time + tzShift,
            position: isBull ? 'belowBar' : 'aboveBar',
            color,
            shape: isBull ? (p.type === 'harmonic' ? 'circle' : 'arrowUp') : (p.type === 'harmonic' ? 'circle' : 'arrowDown'),
            text: `${icon} ${(p.italian || p.name).split(' ')[0]}`,
            size: 1,
          }
        })
        .sort((a, b) => a.time - b.time)
      cs.setMarkers(markers)
    } catch (err) { /* setMarkers fallisce silently se ci sono problemi temporanei di order */ }

    // fitContent SOLO al cambio strumento o timeframe (non ad ogni tick)
    const symbolChanged = lastSymbolRef.current !== activeInstrument
    const tfChanged     = lastTfRef.current     !== activeTimeframe
    if (symbolChanged || tfChanged) {
      chartRef.current?.timeScale().fitContent()
      lastSymbolRef.current = activeInstrument
      lastTfRef.current     = activeTimeframe
    }
  }, [candles, activeInstrument, activeTimeframe])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-bg-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-gold">{activeInstrument}</span>
          {TD_ETF_LABEL[activeInstrument] && (
            <span className="font-mono text-xxs text-text-muted">{TD_ETF_LABEL[activeInstrument]}</span>
          )}
          {price && (
            <>
              <span className={`font-mono text-sm tabular-nums ${pct >= 0 ? 'text-green' : 'text-red'}`}>
                {formatPrice(activeInstrument, price)}
              </span>
              <span className={`font-mono text-xxs tabular-nums ${pct >= 0 ? 'text-green/70' : 'text-red/70'}`}>
                {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
              </span>
            </>
          )}
          {streamHealth && <LiveBadge health={streamHealth} />}
        </div>
        <div className="flex items-center gap-1">
          {/* EMA legend - solo in modalità native */}
          {engine === 'native' && (
            <div className="flex items-center gap-2 mr-3">
              {[['EMA20','#2196F3'],['EMA50','#FF9800'],['EMA200','#9C27B0']].map(([l,c]) => (
                <span key={l} className="flex items-center gap-1">
                  <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: c }} />
                  <span className="font-mono text-xxs" style={{ color: c }}>{l}</span>
                </span>
              ))}
            </div>
          )}
          {/* Engine toggle: Native (lightweight-charts) vs TradingView widget */}
          <div className="flex items-center bg-bg-primary/60 border border-bg-border rounded mr-2 overflow-hidden">
            <button
              onClick={() => switchEngine('native')}
              className={`px-2 py-0.5 font-mono text-xxs transition-colors ${
                engine === 'native' ? 'bg-gold text-bg-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
              title="Chart nativo lightweight-charts con i nostri indicatori"
            >
              NATIVE
            </button>
            <button
              onClick={() => switchEngine('tradingview')}
              className={`px-2 py-0.5 font-mono text-xxs transition-colors ${
                engine === 'tradingview' ? 'bg-gold text-bg-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
              title="Widget TradingView ufficiale (multi-asset, drawing tools)"
            >
              TV
            </button>
          </div>
          {/* Timeframe buttons */}
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`btn-tf ${tf === activeTimeframe ? 'active' : ''}`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Fix #5.9: Position overlay banner */}
      {activePosition && activePosition.symbol === activeInstrument && (
        <PositionOverlay
          pos={activePosition}
          currentPrice={price}
          onClose={() => setActivePosition(null)}
        />
      )}

      {/* Chart area */}
      <div className="relative flex-1">
        {engine === 'tradingview' ? (
          // TradingView widget: dati live indipendenti dalle nostre API.
          // Non blocca per Twelve Data key (il widget ha feed proprio).
          <TradingViewAdvancedChart
            symbol={activeInstrument}
            interval={activeTimeframe}
            theme="dark"
            studies={['STD;EMA', 'STD;Volume', 'STD;RSI']}
          />
        ) : (
          <>
            {needsKey && (
              <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-bg-primary/90">
                <div className="text-center">
                  <div className="text-gold font-mono text-xl mb-2">⚠</div>
                  <p className="font-mono text-sm text-text-primary mb-1">API Key richiesta</p>
                  <p className="font-mono text-xxs text-text-secondary mb-3">
                    {activeInstrument} richiede Twelve Data (gratuito)
                  </p>
                  <p className="font-mono text-xxs text-text-muted mb-2">
                    Clicca <span className="text-gold">⚙ API HUB</span> in alto a destra
                  </p>
                  <p className="font-mono text-xxs text-text-muted">
                    Oppure passa a <button onClick={() => switchEngine('tradingview')} className="text-gold underline">vista TradingView</button> (no key)
                  </p>
                </div>
              </div>
            )}
            <div ref={containerRef} className="w-full h-full" />
          </>
        )}
      </div>
    </div>
  )
}

// ── Position overlay: mostra entry/SL/TP/reason/distanza in pips ──
function PositionOverlay({ pos, currentPrice, onClose }) {
  // Fix #5.11: guard pos null/parziale
  if (!pos) return null
  const dirColor = pos.direction === 'long' ? '#00e096' : '#ff3355'
  const fmt = (n) => {
    const v = Number(n)
    if (n == null || !Number.isFinite(v)) return '—'
    return v.toFixed(v < 10 ? 5 : v < 100 ? 4 : 2)
  }
  const entry = Number(pos.entry)
  const sl    = Number(pos.sl)
  const tp    = Number(pos.tp)

  // Distanze in pips dal prezzo corrente (solo se valori validi)
  const distFromEntry = (currentPrice != null && Number.isFinite(entry)) ? currentPrice - entry : null
  const distToSL = (currentPrice != null && Number.isFinite(sl))
    ? (pos.direction === 'long' ? currentPrice - sl : sl - currentPrice)
    : null
  const distToTP = (currentPrice != null && Number.isFinite(tp))
    ? (pos.direction === 'long' ? tp - currentPrice : currentPrice - tp)
    : null

  return (
    <div className="px-3 py-2 border-b border-bg-border flex items-center gap-3 flex-wrap text-xs font-mono"
         style={{ backgroundColor: `${dirColor}15`, borderTop: `2px solid ${dirColor}` }}>
      <div className="flex items-center gap-2">
        <strong style={{ color: dirColor }} className="text-sm">
          {pos.direction === 'long' ? '▲ LONG' : '▼ SHORT'}
        </strong>
        <span className="text-text-muted">{pos.symbol || '—'} · {pos.timeframe || '—'}</span>
      </div>
      <div className="bg-bg-primary/60 rounded px-2 py-0.5">
        <span className="text-text-muted text-xxs">Strategia: </span>
        <span className="text-gold">{pos.strategyName || pos.strategyId || '—'}</span>
      </div>
      <div className="bg-bg-primary/60 rounded px-2 py-0.5">
        <span className="text-text-muted text-xxs">Setup: </span>
        <span>{pos.reason || '—'}</span>
      </div>
      <div className="flex items-center gap-3 ml-auto">
        <div>
          <span className="text-text-muted text-xxs">Entry </span>
          <strong style={{ color: dirColor }}>{fmt(entry)}</strong>
          {distFromEntry != null && (
            <span className="text-text-muted text-xxs ml-1">
              ({formatPips(pos.symbol, distFromEntry)})
            </span>
          )}
        </div>
        <div>
          <span className="text-red/80 text-xxs">SL </span>
          <strong className="text-red">{fmt(sl)}</strong>
          {distToSL != null && (
            <span className="text-text-muted text-xxs ml-1">
              ({formatPips(pos.symbol, Math.abs(distToSL))} dist)
            </span>
          )}
        </div>
        <div>
          <span className="text-green/80 text-xxs">TP </span>
          <strong className="text-green">{fmt(tp)}</strong>
          {distToTP != null && (
            <span className="text-text-muted text-xxs ml-1">
              ({formatPips(pos.symbol, Math.abs(distToTP))} dist)
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="ml-2 px-2 py-0.5 text-xxs rounded bg-bg-primary hover:bg-red/20 border border-bg-border text-text-muted hover:text-red transition"
          title="Rimuovi overlay posizione"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// ── Indicatore "LIVE" / stato stream WebSocket ──────────────────────
function LiveBadge({ health }) {
  if (!health) return null
  const silent = health.silentForMs ?? Infinity
  const reconnecting = health.reconnectAttempts > 0 && !health.connected
  let label, color, pulse
  if (reconnecting) {
    label = `RECONN ${health.reconnectAttempts}`
    color = '#ff7a8d'
    pulse = false
  } else if (!health.connected) {
    label = 'OFFLINE'
    color = '#ff3355'
    pulse = false
  } else if (silent < 30_000) {
    label = 'LIVE'
    color = '#00e096'
    pulse = true
  } else if (silent < 90_000) {
    label = `IDLE ${Math.floor(silent/1000)}s`
    color = '#f5c842'
    pulse = false
  } else {
    label = `STALE ${Math.floor(silent/1000)}s`
    color = '#ff7a8d'
    pulse = false
  }
  return (
    <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded font-mono text-xxs"
          style={{ backgroundColor: `${color}18`, color, border: `1px solid ${color}40` }}
          title={health.connected
            ? `WebSocket connesso · ultimo tick ${silent === Infinity ? 'mai' : Math.floor(silent/1000) + 's fa'}`
            : `WebSocket disconnesso · reconnect attempt ${health.reconnectAttempts}`}>
      <span className={`w-1.5 h-1.5 rounded-full inline-block ${pulse ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
