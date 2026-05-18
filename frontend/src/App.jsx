import { useEffect, useState } from 'react'
import Header        from './components/Header'
import Watchlist     from './components/Watchlist'
import TradingChart  from './components/TradingChart'
import ApiHub        from './components/ApiHub'
import FundamentalPanel from './components/FundamentalPanel'
import AnalysisRow   from './components/AnalysisRow'
import BacktestPanel from './components/BacktestPanel'
import CorrelationPanel from './components/CorrelationPanel'
import COTPanel      from './components/COTPanel'
import TradeLogPanel from './components/TradeLogPanel'
import NewsPanel    from './components/NewsPanel'
import ClaudeDecisionPanel from './components/ClaudeDecisionPanel'
import ClaudeReviewPanel from './components/ClaudeReviewPanel'
import PatternsPanel from './components/PatternsPanel'
import HeatmapPanel  from './components/HeatmapPanel'
import OptimizationPanel from './components/OptimizationPanel'
import ApifyPanel    from './components/ApifyPanel'
import ScalpingPanel from './components/ScalpingPanel'
import SimulationPanel from './components/SimulationPanel'
import MultiChartPanel from './components/MultiChartPanel'
import ContextBar   from './components/ContextBar'
import { TradingViewTickerTape } from './components/TradingViewWidget'
import { useAppStore } from './store/store'
import { initBinanceTicker, initWatchlistPrices, initTwelveDataWS, syncTDKeys } from './services/DataHub'
import { initFundamentalHub } from './services/FundamentalHub'
import { startOutcomeTracker } from './services/OutcomeTracker'
import { startScheduledAnalysesWatcher } from './services/ScheduledAnalyses'
import { autoResumeLiveSimulation, autoStartLiveSimulationWithDefaults } from './services/LiveSimulator'
import { isWorkerConfigured } from './services/WorkerSim'
import { useEscape } from './components/ui/Toast'

const TICKER_TAPE_KEY = 'itp_show_ticker_tape'
const loadShowTickerTape = () => {
  try { return localStorage.getItem(TICKER_TAPE_KEY) !== '0' }
  catch { return true }
}

export default function App() {
  const activePanel = useAppStore(s => s.activePanel)
  const setPanel    = useAppStore(s => s.setActivePanel)
  const [showTicker, setShowTicker] = useState(loadShowTickerTape())
  const toggleTicker = () => {
    setShowTicker(v => {
      const next = !v
      try { localStorage.setItem(TICKER_TAPE_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }
  // ESC chiude qualsiasi pannello fullscreen e torna al chart
  useEscape(() => { if (activePanel !== 'chart') setPanel('chart') }, activePanel !== 'chart')

  useEffect(() => {
    // Sincronizza key TD (primary + backup) col keyManager
    syncTDKeys()

    // Start Binance WebSocket for BTC price (always-on, no key needed)
    initBinanceTicker()

    // Fetch initial prices for watchlist
    initWatchlistPrices()

    // Connect Twelve Data WS if key already stored
    initTwelveDataWS()

    // Load fundamental data (Forex Factory + CoinGecko + Fear & Greed)
    initFundamentalHub()

    // Background watcher: chiude automaticamente le decisioni aperte se SL/TP hit
    startOutcomeTracker()

    // Background watcher: esegue analisi programmate quando arrivano i loro orari
    startScheduledAnalysesWatcher()

    // Browser-side LiveSimulator: SOLO se NON c'è Worker server-side configurato.
    // Quando il Worker è configurato (deployment production), la sim gira sul VPS
    // e tutti i device vedono lo stesso stato condiviso. Niente sim browser-side
    // per evitare divergenze tra mobile e desktop.
    if (!isWorkerConfigured()) {
      autoResumeLiveSimulation()
      setTimeout(() => autoStartLiveSimulationWithDefaults(), 5000)
    } else {
      console.log('[App] Worker configurato — sim browser-side disabilitata, dati dal server')
    }
  }, [])

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary overflow-hidden">
      <Header />
      {/* TradingView Ticker Tape — overview mercati live, toggleable */}
      {showTicker && (
        <div className="relative shrink-0 border-b border-bg-border bg-bg-secondary">
          <TradingViewTickerTape theme="dark" displayMode="adaptive" />
          <button
            onClick={toggleTicker}
            className="absolute top-1 right-2 text-text-muted hover:text-text-primary font-mono text-xxs px-1.5 py-0.5 rounded bg-bg-primary/60"
            title="Nascondi ticker tape"
          >
            ×
          </button>
        </div>
      )}
      {!showTicker && (
        <button
          onClick={toggleTicker}
          className="shrink-0 text-text-muted hover:text-text-primary font-mono text-xxs px-3 py-1 border-b border-bg-border bg-bg-secondary text-left"
          title="Mostra ticker tape TradingView"
        >
          ▾ Mostra ticker mercati
        </button>
      )}
      <ContextBar />

      {activePanel === 'apihub' ? (
        /* ── API Hub fullscreen ──────────────────────────────── */
        <div className="flex-1 overflow-hidden">
          <ApiHub />
        </div>
      ) : activePanel === 'calendar' ? (
        /* ── Fundamental analysis fullscreen ───────────────── */
        <div className="flex-1 overflow-hidden">
          <FundamentalPanel />
        </div>
      ) : activePanel === 'backtest' ? (
        /* ── Backtest fullscreen ───────────────────────────── */
        <div className="flex-1 overflow-hidden">
          <BacktestPanel />
        </div>
      ) : activePanel === 'correlation' ? (
        /* ── Correlation matrix fullscreen ──────────────────── */
        <div className="flex-1 overflow-hidden">
          <CorrelationPanel />
        </div>
      ) : activePanel === 'cot' ? (
        /* ── COT fullscreen ─────────────────────────────────── */
        <div className="flex-1 overflow-hidden">
          <COTPanel />
        </div>
      ) : activePanel === 'tradelog' ? (
        /* ── Diario decisioni fullscreen ────────────────────── */
        <div className="flex-1 overflow-hidden">
          <TradeLogPanel />
        </div>
      ) : activePanel === 'news' ? (
        /* ── News fullscreen ────────────────────────────────── */
        <div className="flex-1 overflow-hidden">
          <NewsPanel />
        </div>
      ) : activePanel === 'claude' ? (
        /* ── Claude decision fullscreen ─────────────────────── */
        <div className="flex-1 overflow-hidden">
          <ClaudeDecisionPanel />
        </div>
      ) : activePanel === 'claude-review' ? (
        /* ── Claude Review Lab (self-learning) ──────────────── */
        <div className="flex-1 overflow-hidden">
          <ClaudeReviewPanel />
        </div>
      ) : activePanel === 'patterns' ? (
        /* ── Patterns recognition fullscreen ────────────────── */
        <div className="flex-1 overflow-hidden">
          <PatternsPanel />
        </div>
      ) : activePanel === 'heatmap' ? (
        /* ── Heatmap & Volumi fullscreen ────────────────────── */
        <div className="flex-1 overflow-hidden">
          <HeatmapPanel />
        </div>
      ) : activePanel === 'optimizer' ? (
        /* ── Parameter Optimizer fullscreen ─────────────────── */
        <div className="flex-1 overflow-hidden">
          <OptimizationPanel />
        </div>
      ) : activePanel === 'apify' ? (
        /* ── Apify Scraper Lab fullscreen ───────────────────── */
        <div className="flex-1 overflow-hidden">
          <ApifyPanel />
        </div>
      ) : activePanel === 'scalping' ? (
        /* ── Scalping Lab fullscreen ────────────────────────── */
        <div className="flex-1 overflow-hidden">
          <ScalpingPanel />
        </div>
      ) : activePanel === 'simulation' ? (
        /* ── Simulation Paper Trading fullscreen ────────────── */
        <div className="flex-1 overflow-hidden">
          <SimulationPanel />
        </div>
      ) : activePanel === 'multichart' ? (
        /* ── Multi Chart Live (Binance + TwelveData + Hyperliquid) ──── */
        <div className="flex-1 overflow-hidden">
          <MultiChartPanel />
        </div>
      ) : (
        /* ── Main trading layout ────────────────────────────── */
        <div className="flex flex-1 overflow-hidden">

          {/* Sidebar watchlist */}
          <aside className="w-48 shrink-0 flex flex-col border-r border-bg-border bg-bg-secondary overflow-hidden">
            <Watchlist />
          </aside>

          {/* Center: chart (top) + analysis panels (bottom) */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">

            {/* Live chart — takes ~60% of height */}
            <div className="panel flex-[3] min-h-0 overflow-hidden">
              <TradingChart />
            </div>

            {/* Analysis panels row — takes ~40% (con focus-mode toggle) */}
            <div className="flex-[2] min-h-0 border-t border-bg-border overflow-hidden">
              <AnalysisRow />
            </div>
          </main>

        </div>
      )}
    </div>
  )
}
