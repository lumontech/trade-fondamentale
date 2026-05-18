// TradingViewWidget — componente riusabile per embed widget TradingView ufficiali.
//
// Tre varianti esposte:
//   <TradingViewAdvancedChart symbol interval theme studies />   → Advanced Real-Time Chart
//   <TradingViewMiniChart     symbol theme />                     → Mini Symbol Overview compatto
//   <TradingViewTickerTape    symbols theme />                    → Ticker Tape scrolling
//
// Tutti i widget sono LIVE, gratuiti, multi-asset (forex/crypto/indici/azioni/commodity).
// Embed via <script async> dentro container fresco a ogni cambio prop.
//
// Note:
//  - I widget creano un iframe interno; cleanup safe rimuovendo il container child.
//  - StrictMode in dev fa doppio mount: usiamo ref idempotente che svuota e ricarica.
//  - Tema dark coerente con la palette Bloomberg del progetto.
import { useEffect, useRef, memo } from 'react'
import { toTVSymbol, toTVInterval, TV_TICKER_TAPE_SYMBOLS } from '../services/TradingViewSymbols'

// Carica uno script TradingView in un container, accettando un oggetto di config.
// Restituisce una funzione di cleanup che svuota il container.
function mountWidget(container, scriptSrc, config) {
  if (!container) return () => {}
  // Reset completo (evita doppio iframe in StrictMode/HMR)
  container.innerHTML = `
    <div class="tradingview-widget-container__widget" style="height:100%;width:100%;"></div>
    <div class="tradingview-widget-copyright" style="font-size:10px;color:#5a6478;text-align:right;padding:2px 6px;">
      <a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank" style="color:#5a6478;">
        Track all markets on TradingView
      </a>
    </div>
  `
  const script = document.createElement('script')
  script.src = scriptSrc
  script.type = 'text/javascript'
  script.async = true
  script.innerHTML = JSON.stringify(config)
  container.appendChild(script)
  return () => {
    if (container) container.innerHTML = ''
  }
}

// ── Advanced Real-Time Chart ──────────────────────────────────
// Chart "principale" full-featured: indicatori, drawing tools, multi-TF.
// Props:
//   symbol    — ticker interno (BTCUSD, XAUUSD, ...). Sarà mappato a TV.
//   interval  — timeframe interno ('15m','1h',...). Default '1h'.
//   theme     — 'dark' | 'light'. Default 'dark'.
//   studies   — array di indicatori built-in (es ['STD;EMA','STD;RSI']).
//   hideTopToolbar / hideSideToolbar — boolean per layout compatto.
//   allowSymbolChange — se true mostra search bar simboli (default false: locked).
function _AdvancedChart({
  symbol,
  interval = '1h',
  theme = 'dark',
  studies = ['STD;EMA', 'STD;Volume'],
  hideTopToolbar = false,
  hideSideToolbar = false,
  allowSymbolChange = false,
  height = '100%',
}) {
  const containerRef = useRef(null)

  useEffect(() => {
    const tvSymbol = toTVSymbol(symbol)
    const tvInterval = toTVInterval(interval)
    const config = {
      autosize: true,
      symbol: tvSymbol,
      interval: tvInterval,
      timezone: 'Europe/Rome',
      theme,
      style: '1',              // candles
      locale: 'it',
      enable_publishing: false,
      withdateranges: true,
      hide_side_toolbar: hideSideToolbar,
      hide_top_toolbar: hideTopToolbar,
      allow_symbol_change: allowSymbolChange,
      studies,
      backgroundColor: '#04060a',
      gridColor: 'rgba(30, 37, 53, 0.4)',
      support_host: 'https://www.tradingview.com',
    }
    const cleanup = mountWidget(
      containerRef.current,
      'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
      config,
    )
    return cleanup
  }, [symbol, interval, theme, hideTopToolbar, hideSideToolbar, allowSymbolChange, JSON.stringify(studies)])

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ height, width: '100%' }}
    />
  )
}
export const TradingViewAdvancedChart = memo(_AdvancedChart)

// ── Mini Symbol Overview ──────────────────────────────────────
// Sparkline + prezzo + variazione. Ideale per slot compatti / dashboard.
function _MiniChart({
  symbol,
  theme = 'dark',
  dateRange = '12M',
  height = 220,
  width = '100%',
}) {
  const containerRef = useRef(null)

  useEffect(() => {
    const config = {
      symbol: toTVSymbol(symbol),
      width: '100%',
      height: '100%',
      locale: 'it',
      dateRange,
      colorTheme: theme,
      isTransparent: true,
      autosize: true,
      largeChartUrl: '',
      chartOnly: false,
      noTimeScale: false,
      backgroundColor: '#04060a',
    }
    return mountWidget(
      containerRef.current,
      'https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js',
      config,
    )
  }, [symbol, theme, dateRange])

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ height, width }}
    />
  )
}
export const TradingViewMiniChart = memo(_MiniChart)

// ── Ticker Tape ───────────────────────────────────────────────
// Scrolling marquee con prezzi live multi-asset. Da mettere sotto il Header.
function _TickerTape({
  symbols = TV_TICKER_TAPE_SYMBOLS,
  theme = 'dark',
  displayMode = 'adaptive', // 'regular' | 'compact' | 'adaptive'
}) {
  const containerRef = useRef(null)

  useEffect(() => {
    const config = {
      symbols,
      colorTheme: theme,
      isTransparent: true,
      showSymbolLogo: true,
      displayMode,
      locale: 'it',
    }
    return mountWidget(
      containerRef.current,
      'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js',
      config,
    )
  }, [JSON.stringify(symbols), theme, displayMode])

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ width: '100%' }}
    />
  )
}
export const TradingViewTickerTape = memo(_TickerTape)

// ── Symbol Overview con chart ─────────────────────────────────
// Variante "media": symbol overview ricco con chart fluido (no candles).
// Utile per market overview multi-asset.
function _SymbolOverview({
  symbols, // [['BTC/USDT', 'BINANCE:BTCUSDT|1M'], ...]
  theme = 'dark',
  height = 400,
}) {
  const containerRef = useRef(null)
  useEffect(() => {
    const config = {
      symbols,
      chartOnly: false,
      width: '100%',
      height: '100%',
      locale: 'it',
      colorTheme: theme,
      autosize: true,
      showVolume: true,
      hideDateRanges: false,
      hideMarketStatus: false,
      hideSymbolLogo: false,
      scalePosition: 'right',
      scaleMode: 'Normal',
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: '10',
      noTimeScale: false,
      valuesTracking: '1',
      changeMode: 'price-and-percent',
      chartType: 'area',
      lineColor: 'rgba(245, 200, 66, 1)',
      bottomColor: 'rgba(245, 200, 66, 0.05)',
      topColor: 'rgba(245, 200, 66, 0.3)',
      backgroundColor: '#04060a',
      gridLineColor: 'rgba(30, 37, 53, 0.4)',
    }
    return mountWidget(
      containerRef.current,
      'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js',
      config,
    )
  }, [JSON.stringify(symbols), theme])
  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ height, width: '100%' }}
    />
  )
}
export const TradingViewSymbolOverview = memo(_SymbolOverview)
