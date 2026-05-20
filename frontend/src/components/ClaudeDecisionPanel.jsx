import { useState, useMemo, useEffect, useRef } from 'react'
import { useAppStore } from '../store/store'
import { buildContextPack, summarizeContextPack } from '../services/ContextPack'
import { askClaude, askClaudeScalping, askClaudeSelfConsistent, CLAUDE_MODELS, STYLE_PROFILES } from '../services/ClaudeService'
import { captureMTFCharts, TF_PRESETS } from '../services/MTFChartCapture'
import { loadCandles, loadMultiTFCandles, SCALPING_TIMEFRAMES } from '../services/DataHub'
import { logDecision }                         from '../services/TradeLog'
import { getLessons }                          from '../services/ClaudeReviewLab'
import { getClaudeTrackRecord }                from '../services/OutcomeTracker'
import { scanAllAssets, summarizeScanForClaude } from '../services/MultiAssetScanner'
import { addScheduledAnalysis, getScheduledAnalyses, deleteScheduledAnalysis,
         retryScheduledAnalysis, suggestSchedulesFromEvents } from '../services/ScheduledAnalyses'
import { fetchSocialSentiment, summarizeSocialForClaude } from '../services/SocialSentiment'
import { useToast }                            from './ui/Toast'

const DIR_STYLE = {
  LONG:  { bg: '#00e09618', border: '#00e09660', text: '#00e096', icon: '▲' },
  SHORT: { bg: '#ff335518', border: '#ff335560', text: '#ff3355', icon: '▼' },
  FLAT:  { bg: '#f5c84218', border: '#f5c84260', text: '#f5c842', icon: '■' },
  NO_GO: { bg: '#f5c84218', border: '#f5c84260', text: '#f5c842', icon: '■' },   // scalping equivalente di FLAT
}

const SIDEBAR_TABS = [
  { id: 'scan',     icon: '🔍', label: 'Scan' },
  { id: 'schedule', icon: '⏰', label: 'Schedule' },
  { id: 'track',    icon: '📊', label: 'Track' },
  { id: 'payload',  icon: '📄', label: 'JSON' },
]

export default function ClaudeDecisionPanel() {
  const setPanel         = useAppStore(s => s.setActivePanel)
  const apiKeys          = useAppStore(s => s.apiKeys)
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const instruments      = useAppStore(s => s.instruments)
  const events           = useAppStore(s => s.events)
  const marketContext    = useAppStore(s => s.marketContext)
  const cotAll           = useAppStore(s => s.cot)
  const news             = useAppStore(s => s.news)

  const [model, setModel]       = useState('claude-opus-4-7')
  const [styleProfile, setStyleProfile] = useState('moderate')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)
  const [savedId, setSavedId]   = useState(null)
  const [includeTrackRecord, setIncludeTrackRecord] = useState(true)
  const [includeScan, setIncludeScan] = useState(true)
  const [includeSocial, setIncludeSocial] = useState(false)
  // Vision: cattura 3 chart MTF + indicator panel e li manda a Claude come allegato
  // Default ON: l'utente lo vuole. Costo +~$0.10 per call (vision tokens).
  const [includeVision, setIncludeVision] = useState(true)
  // Self-consistency: 3 call parallele a Claude con temperature diverse, merge mediano.
  // Riduce varianza decisionale del 30-40% (Wang et al. 2022).
  // Costo: 3× del normale (~$1.50/call). Default OFF.
  const [includeSelfConsistency, setIncludeSelfConsistency] = useState(false)
  const [visionImages, setVisionImages] = useState([])    // anteprima per UI
  const [capturing, setCapturing] = useState(false)
  const [scheduledTick, setScheduledTick] = useState(0)
  const [sidebarTab, setSidebarTab] = useState('scan')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reloadingData, setReloadingData] = useState(false)
  const toast = useToast()

  const handleReloadData = async () => {
    setReloadingData(true)
    setError(null)
    try {
      const [res] = await Promise.all([
        loadCandles(activeInstrument, activeTimeframe),
        loadMultiTFCandles(activeInstrument),
      ])
      if (res?.error) {
        toast.error(`Reload fallito: ${res.error}`, { title: '⚠ Dati non disponibili' })
      } else {
        toast.success(`Candele ${activeInstrument} ricaricate (${res?.candles?.length || 0} bar)`,
                      { title: '✓ Reload OK' })
      }
    } catch (err) {
      toast.error(err.message, { title: '⚠ Reload errore' })
    } finally {
      setReloadingData(false)
    }
  }

  // ── Auto-load candele al mount del pannello / cambio simbolo ──────
  // Il pannello Claude sostituisce il main layout, quindi TradingChart non è montato
  // e non triggera loadCandles. Carichiamo qui se mancano dati per il simbolo attivo.
  const autoLoadedRef = useRef(new Set())
  useEffect(() => {
    const inst   = instruments[activeInstrument]
    const hasMain = (inst?.candles?.length || 0) >= 30
    const hasAllMTF = ['15m', '1h', '4h', '1D'].every(tf => (inst?.mtf?.[tf]?.length || 0) >= 30)
    const key = `${activeInstrument}|${activeTimeframe}`
    console.log(`[ClaudePanel] auto-load check ${key}: main=${inst?.candles?.length || 0} mtf=${['15m','1h','4h','1D'].map(t => inst?.mtf?.[t]?.length || 0).join('/')} alreadyTried=${autoLoadedRef.current.has(key)}`)
    if (hasMain && hasAllMTF) return
    if (autoLoadedRef.current.has(key)) return
    autoLoadedRef.current.add(key)
    ;(async () => {
      setReloadingData(true)
      console.log(`[ClaudePanel] auto-loading ${activeInstrument} ${activeTimeframe} ...`)
      try {
        const [mainRes, _mtfRes] = await Promise.all([
          loadCandles(activeInstrument, activeTimeframe),
          loadMultiTFCandles(activeInstrument),
        ])
        console.log(`[ClaudePanel] loadCandles result:`, mainRes)
        if (mainRes?.error) {
          toast.error(`Caricamento ${activeInstrument} fallito: ${mainRes.error}`,
                      { title: '⚠ Dati non disponibili', duration: 8000 })
        } else {
          const n = mainRes?.candles?.length || 0
          toast.success(`${activeInstrument} ${activeTimeframe}: ${n} candele caricate`,
                        { title: '✓ Dati pronti', duration: 3000 })
        }
      } catch (err) {
        console.error(`[ClaudePanel] auto-load error:`, err)
        toast.error(err.message, { title: '⚠ Errore auto-load' })
      } finally { setReloadingData(false) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInstrument, activeTimeframe])

  const contextPack = useMemo(() =>
    buildContextPack({
      symbol: activeInstrument,
      timeframe: activeTimeframe,
      instruments,
      events,
      marketContext,
      cot: cotAll[activeInstrument] || null,
      news,
      now: new Date(),
    }),
    [activeInstrument, activeTimeframe, instruments, events, marketContext, cotAll, news]
  )

  const summary = useMemo(() => contextPack ? summarizeContextPack(contextPack) : null, [contextPack])
  const trackRecord = useMemo(() => getClaudeTrackRecord({ limit: 20 }), [savedId, loading])

  const scanResults = useMemo(() => {
    if (!includeScan) return null
    return scanAllAssets({ instruments, events, marketContext, cot: cotAll, news, timeframe: activeTimeframe })
  }, [instruments, events, marketContext, cotAll, news, activeTimeframe, includeScan])

  const eventSuggestions = useMemo(() =>
    suggestSchedulesFromEvents(events, activeInstrument, new Date()),
    [events, activeInstrument]
  )

  const scheduled = useMemo(() => getScheduledAnalyses(), [scheduledTick])
  const refreshScheduled = () => setScheduledTick(t => t + 1)

  // Counters per badge nelle tab della sidebar
  const tabCounts = {
    scan:     scanResults ? scanResults.length : 0,
    schedule: eventSuggestions.length + scheduled.filter(s => s.status === 'pending').length,
    track:    trackRecord ? trackRecord.summary.total : 0,
    payload:  null,
  }

  /**
   * Handler unificato per Intraday e Scalping mode.
   * @param {'intraday'|'scalping'} mode
   */
  const handleAskMode = async (mode) => {
    if (!apiKeys.anthropic) { setError('Inserisci API key Anthropic in API Hub'); return }
    if (!contextPack)       { setError('Dati insufficienti per costruire il contesto'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    setSavedId(null)
    try {
      const tr = includeTrackRecord ? trackRecord : null
      let enrichedCtx = includeScan && scanResults
        ? { ...contextPack, multi_asset_scan: summarizeScanForClaude(scanResults, activeInstrument) }
        : contextPack
      // Tag della modalità dentro il contextPack — serve poi nel TradeLog auto-log
      enrichedCtx = { ...enrichedCtx, analysis_mode: mode }

      // Social sentiment via Apify (opzionale, costo ~€0.02-0.05)
      if (includeSocial && apiKeys.apify) {
        try {
          const sentiment = await fetchSocialSentiment(activeInstrument, apiKeys.apify)
          if (sentiment) {
            enrichedCtx = { ...enrichedCtx, social_sentiment: summarizeSocialForClaude(sentiment) }
          }
        } catch (err) {
          console.warn('[Apify social] errore:', err.message)
          toast.warning?.(`Social sentiment skip: ${err.message}`)
        }
      }

      // Vision: cattura immagini MTF — TF list dipende dalla modalità
      const tfs = mode === 'scalping' ? TF_PRESETS.scalping : TF_PRESETS.intraday
      let images = null
      if (includeVision) {
        try {
          setCapturing(true)
          // Per scalping serve forzare il caricamento dei TF brevi (1m/5m)
          // che il default loadMultiTFCandles NON include. Aspetto sincronicamente
          // così quando arriva captureMTFCharts le candele 1m/5m sono nello store.
          if (mode === 'scalping') {
            try {
              const inst = useAppStore.getState().instruments[activeInstrument]
              const missing = SCALPING_TIMEFRAMES.filter(tf => (inst?.mtf?.[tf]?.length || 0) < 30)
              if (missing.length > 0) {
                toast.info?.(`Carico TF scalping mancanti: ${missing.join(', ')}`)
                await loadMultiTFCandles(activeInstrument, SCALPING_TIMEFRAMES)
              }
            } catch (e) {
              console.warn('[Scalp] preload TF brevi failed:', e.message)
            }
          }
          images = await captureMTFCharts({
            symbol: activeInstrument,
            instruments: useAppStore.getState().instruments,    // ri-leggi state aggiornato
            contextPack: enrichedCtx,
            tfs,
            headerLabel: mode === 'scalping' ? 'Scalping MTF Analysis' : 'Multi-Timeframe Analysis Trader Pro',
          })
          setVisionImages(images)
          toast.info?.(`[${mode}] catturate ${images.length} immagini (context + ${images.filter(i => i.tf !== 'context').map(i => i.tf).join('+')})`)
        } catch (err) {
          console.warn('[Vision capture] errore:', err.message)
          toast.warning?.(`Vision skip: ${err.message}`)
          images = null
        } finally {
          setCapturing(false)
        }
      } else {
        setVisionImages([])
      }

      // Branch sull'API call corretta
      // Self-consistency disponibile solo per intraday (scalp è già veloce)
      const useSelfConsistency = includeSelfConsistency && mode === 'intraday'
      if (useSelfConsistency) toast.info?.('🎯 Self-consistency attiva: 3 call parallele in corso (~$1.50)...')
      const out = mode === 'scalping'
        ? await askClaudeScalping(enrichedCtx, apiKeys.anthropic, model, tr, images)
        : useSelfConsistency
          ? await askClaudeSelfConsistent(enrichedCtx, apiKeys.anthropic, model, tr, styleProfile, images)
          : await askClaude(enrichedCtx, apiKeys.anthropic, model, tr, styleProfile, images)

      setResult(out)

      // Auto-log silenzioso. Tag mode così il Review Lab li distingue.
      try {
        const d = out.decision
        // NO_GO della modalità scalping → mappato a FLAT per consistency con UI
        const dirForLog = d.direction === 'NO_GO' ? 'FLAT' : d.direction
        logDecision({
          symbol:      activeInstrument,
          timeframe:   activeTimeframe,
          direction:   dirForLog,
          confidence:  d.confidence,
          combined:    null,
          techScore:   null, fundScore: null, histScore: null, crossScore: null,
          price:       d.entry ?? enrichedCtx?.technical?.price ?? null,
          suggestedSL: d.stopLoss,
          suggestedTP: d.takeProfit1,
          reasons: [
            { type: 'claude', label: `Claude ${mode === 'scalping' ? '⚡ Scalp' : '🧠 Intraday'} (auto-log)`, detail: d.reasoning },
            ...(d.keyFactors || []).map(k => ({ type: 'claude-factor', label: k })),
          ],
          blockers: (d.risks || []).map(r => ({ label: r })),
          context:  enrichedCtx,
        })
      } catch (logErr) {
        console.warn('[ClaudePanel] auto-log skipped:', logErr.message)
      }

      const dirLabel = out.decision.direction === 'NO_GO' ? 'NO-GO' : out.decision.direction
      toast.success(
        `${dirLabel} con confidenza ${out.decision.confidence}%`,
        { title: mode === 'scalping' ? '⚡ Decisione Scalp ricevuta' : '🧠 Decisione Intraday ricevuta' }
      )
    } catch (err) {
      setError(err.message)
      toast.error(err.message, { title: 'Errore Claude API', duration: 6000 })
    } finally {
      setLoading(false)
    }
  }

  // Shortcut: il bottone Intraday usa lo stesso flow esistente
  const handleAsk = () => handleAskMode('intraday')
  const handleAskScalp = () => handleAskMode('scalping')

  const handleAddSchedule = (suggestion) => {
    addScheduledAnalysis({
      symbol:    activeInstrument,
      timeframe: activeTimeframe,
      scheduledAt: suggestion.suggestedTime,
      reason:    suggestion.reason,
      styleProfile,
    })
    refreshScheduled()
    toast.success(`Analisi programmata per ${new Date(suggestion.suggestedTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`,
                  { title: '⏰ Schedule aggiunto' })
  }
  const handleDeleteSchedule = (id) => {
    deleteScheduledAnalysis(id)
    refreshScheduled()
  }
  const handleRetrySchedule = (id) => {
    retryScheduledAnalysis(id)
    refreshScheduled()
    toast.success('Schedulazione rimessa in coda — verrà eseguita entro 30s', { title: '↻ Riprova' })
  }

  const handleSaveDecision = () => {
    if (!result?.decision) return
    const d = result.decision
    if (d.direction === 'FLAT' || d.direction === 'NO_GO') return
    const id = logDecision({
      symbol:     activeInstrument,
      timeframe:  activeTimeframe,
      direction:  d.direction,
      confidence: d.confidence,
      combined:   null,
      techScore:  null, fundScore: null, histScore: null, crossScore: null,
      price:      d.entry,
      suggestedSL: d.stopLoss,
      suggestedTP: d.takeProfit1,
      reasons:    [
        { type: 'claude', label: 'Claude (LLM)', detail: d.reasoning },
        ...(d.keyFactors || []).map(k => ({ type: 'claude-factor', label: k })),
      ],
      blockers: (d.risks || []).map(r => ({ label: r })),
      context: contextPack,
    })
    setSavedId(id)
    setTimeout(() => setSavedId(null), 3000)
    toast.success(
      `Decisione di Claude (${d.direction} ${activeInstrument}) salvata. Auto-chiusura su SL/TP attiva.`,
      { title: '💾 Salvato nel diario' }
    )
  }

  const decision = result?.decision
  const dirStyle = decision ? DIR_STYLE[decision.direction] : null

  if (!apiKeys.anthropic) {
    return (
      <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
        <PanelHeader onClose={() => setPanel('chart')} symbol={activeInstrument} timeframe={activeTimeframe} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="text-4xl mb-3">🔑</div>
            <h3 className="font-mono text-lg text-gold mb-2">API key Anthropic richiesta</h3>
            <p className="font-mono text-sm text-text-secondary mb-4">
              Inserisci la tua chiave in <button onClick={() => setPanel('apihub')} className="text-gold hover:underline">API Hub</button>.
              Le decisioni Claude usano ~3-5k token (~$0.02-0.05 per analisi con Opus).
            </p>
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer"
               className="inline-block px-4 py-2 rounded-md font-mono text-sm bg-gold/20 text-gold border border-gold/40 hover:bg-gold/30">
              Ottieni chiave →
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
      <PanelHeader onClose={() => setPanel('chart')} symbol={activeInstrument} timeframe={activeTimeframe} />

      {/* Action bar compatta */}
      <div className="border-b border-bg-border bg-bg-secondary/50 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Model + style */}
          <select value={model} onChange={e => setModel(e.target.value)}
                  className="bg-bg-primary border border-bg-border rounded-md px-2.5 py-1.5 font-mono text-xs text-text-primary">
            {CLAUDE_MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>

          <div className="flex gap-0.5 bg-bg-primary border border-bg-border rounded-md p-0.5">
            {Object.entries(STYLE_PROFILES).map(([key, p]) => (
              <button key={key}
                      onClick={() => setStyleProfile(key)}
                      title={p.description}
                      className={`px-2.5 py-1 rounded font-mono text-xxs transition-all ${
                        styleProfile === key
                          ? 'bg-gold/20 text-gold'
                          : 'text-text-secondary hover:text-text-primary'}`}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-bg-border" />

          {/* Toggle inline */}
          <label className="flex items-center gap-1.5 font-mono text-xxs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={includeTrackRecord}
                   onChange={e => setIncludeTrackRecord(e.target.checked)}
                   disabled={!trackRecord} className="cursor-pointer" />
            <span>Track record</span>
            {trackRecord && <span className="text-text-muted">({trackRecord.summary.total})</span>}
          </label>
          <label className="flex items-center gap-1.5 font-mono text-xxs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={includeScan}
                   onChange={e => setIncludeScan(e.target.checked)} className="cursor-pointer" />
            <span>Multi-asset scan</span>
            {scanResults && <span className="text-text-muted">({scanResults.length})</span>}
          </label>
          <label className="flex items-center gap-1.5 font-mono text-xxs text-text-secondary cursor-pointer"
                 title="Cattura chart 4h+1h+15m + pannello indicatori e li manda a Claude come immagini (+$0.10 per call). Murphy MTF top-down.">
            <input type="checkbox" checked={includeVision}
                   onChange={e => setIncludeVision(e.target.checked)} className="cursor-pointer" />
            <span>🔍 Visual MTF</span>
            <span className="text-gold/80">(+$0.10)</span>
          </label>
          <label className={`flex items-center gap-1.5 font-mono text-xxs cursor-pointer ${
            apiKeys.apify ? 'text-text-secondary' : 'text-text-muted opacity-60'
          }`} title={apiKeys.apify ? 'Twitter + Reddit sentiment via Apify (~€0.02-0.05)' : 'Configura Apify in API Hub per attivare'}>
            <input type="checkbox" checked={includeSocial}
                   onChange={e => setIncludeSocial(e.target.checked)}
                   disabled={!apiKeys.apify}
                   className="cursor-pointer" />
            <span>🤖 Social sentiment</span>
            {apiKeys.apify && includeSocial && <span className="text-gold">(~€0.04)</span>}
          </label>

          <label className="flex items-center gap-1.5 font-mono text-xxs text-text-secondary cursor-pointer"
                 title="Self-consistency: 3 call parallele a Claude con temperature diverse (0.3/0.5/0.7), merge mediano della decisione. Riduce variance del 30-40%. SOLO per Intraday (scalp è già veloce). Costo: 3× normale.">
            <input type="checkbox" checked={includeSelfConsistency}
                   onChange={e => setIncludeSelfConsistency(e.target.checked)}
                   className="cursor-pointer" />
            <span>🎯 Self-consistency</span>
            {includeSelfConsistency && <span className="text-gold">(3× cost)</span>}
          </label>

          <div className="flex-1" />

          {/* Riepilogo essenziale a destra */}
          {summary && (
            <div className="hidden md:flex items-center gap-3 font-mono text-xxs text-text-muted">
              <span><span className="text-text-secondary">Segnale:</span> {summary.signal}</span>
              <span><span className="text-text-secondary">Eventi 24h:</span> {summary.upcoming}</span>
              <span><span className="text-text-secondary">Overlap:</span> <span className={summary.overlap === 'YES' ? 'text-green' : ''}>{summary.overlap}</span></span>
            </div>
          )}

          {/* Link al Review Lab (self-learning) */}
          <button onClick={() => setPanel('claude-review')}
                  title="Apri Review Lab: rivedi decisioni passate, estrai lezioni, abilita self-learning"
                  className="px-3 py-1.5 rounded-md font-mono text-xs bg-purple-500/15 text-purple-300 border border-purple-500/40 hover:bg-purple-500/25 transition-all">
            🧪 Review Lab
            {(() => {
              const ls = getLessons()
              return ls?.lessons?.length ? (
                <span className="ml-1.5 px-1 rounded bg-purple-500/30 text-purple-200 text-xxs">
                  {ls.lessons.length}
                </span>
              ) : null
            })()}
          </button>

          {/* Bottoni primari: due modalità di analisi separate */}
          <div className="flex gap-1.5">
            <button onClick={handleAsk} disabled={loading || !contextPack}
                    title="Analisi intraday/swing: 1D + 4h + 1h + 15m, checklist 18-step, hold 1-6h+, R:R 2:1+"
                    className="px-3 py-1.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {capturing ? '📸 ...' : loading ? '⏳ ...' : '🧠 Intraday'}
            </button>
            <button onClick={handleAskScalp} disabled={loading || !contextPack}
                    title="Analisi scalping: 1h + 15m + 1m, checklist 10-step, hold 5-30min, R:R 1.5:1"
                    className="px-3 py-1.5 rounded-md font-mono text-sm font-semibold bg-orange-500/20 text-orange-300 border border-orange-500/50 hover:bg-orange-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {capturing ? '📸 ...' : loading ? '⏳ ...' : '⚡ Scalp'}
            </button>
          </div>
        </div>
      </div>

      {/* Main area: 2 colonne */}
      <div className="flex-1 flex overflow-hidden">

        {/* Colonna principale: decisione */}
        <div className="flex-1 overflow-y-auto p-5 min-w-0">
          {error && (
            <div className="bg-red/10 border border-red/30 rounded-xl p-4 mb-4">
              <div className="font-mono text-sm text-red font-semibold">⚠ Errore</div>
              <div className="font-mono text-xs text-text-secondary mt-1">{error}</div>
            </div>
          )}

          {!contextPack && !loading && !error && (
            <NoDataBanner
              symbol={activeInstrument}
              timeframe={activeTimeframe}
              instruments={instruments}
              onReload={handleReloadData}
              loading={reloadingData}
            />
          )}

          {!decision && !loading && !error && contextPack && (
            <EmptyState onAsk={handleAsk} onAskScalp={handleAskScalp} disabled={!contextPack} />
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <div className="text-4xl animate-pulse">🧠</div>
              <div className="font-mono text-sm text-text-secondary">
                Claude sta analizzando il contesto multi-prospettiva...
              </div>
              <div className="font-mono text-xxs text-text-muted">
                Tecnico · Fondamentale · Sentiment · Contrarian · Storico
              </div>
            </div>
          )}

          {decision && dirStyle && (
            <div className="space-y-4">
              {/* Vision thumbnails: cosa ha visto Claude */}
              {visionImages.length > 0 && (
                <div className="rounded-xl bg-bg-secondary border border-bg-border p-3">
                  <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">
                    🔍 Visual MTF — immagini inviate a Claude ({visionImages.length})
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {visionImages.map((img, idx) => (
                      <div key={idx} className="relative group cursor-pointer">
                        <img src={`data:image/png;base64,${img.base64}`}
                             alt={img.tf}
                             className="w-full object-contain rounded border border-bg-border hover:border-gold transition-colors bg-bg-primary"
                             style={{ maxHeight: '500px' }}
                             onClick={() => {
                               const w = window.open('', '_blank')
                               w.document.write(`<html><body style="margin:0;background:#04060a"><img src="data:image/png;base64,${img.base64}" style="width:100%"/></body></html>`)
                             }}
                          />
                        <div className="absolute top-2 left-2 px-2 py-1 rounded bg-bg-primary/90 font-mono text-xs text-gold font-semibold border border-gold/30">
                          {img.tf === 'context' ? 'CTX' : img.tf}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="font-mono text-xxs text-text-muted mt-2">
                    Click su un'immagine per aprirla a piena dimensione. Token vision ~{Math.round(visionImages.length * 3000)}.
                  </div>
                </div>
              )}

              {/* Self-consistency banner (solo se attivo + merge avvenuto) */}
              {decision.self_consistency_score != null && (
                <SelfConsistencyBanner decision={decision} />
              )}

              {/* COSA FARE ORA — semaforo plain-Italian, in cima a tutto */}
              <ActionCard decision={decision} symbol={activeInstrument} />

              {/* Decisione principale */}
              <div className="rounded-xl p-5 border-2"
                   style={{ backgroundColor: dirStyle.bg, borderColor: dirStyle.border }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Verdetto Claude</div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-3xl font-mono font-bold" style={{ color: dirStyle.text }}>{dirStyle.icon}</span>
                      <span className="font-mono text-3xl font-bold tracking-wider" style={{ color: dirStyle.text }}>
                        {decision.direction}
                      </span>
                      <span className="font-mono text-xs text-text-muted">{decision.timeHorizon}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Confidenza</div>
                    <div className="font-mono text-4xl font-bold tabular-nums" style={{ color: dirStyle.text }}>
                      {decision.confidence}%
                    </div>
                  </div>
                </div>

                <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden mb-3">
                  <div className="h-full rounded-full transition-all duration-500"
                       style={{ width: `${decision.confidence}%`, backgroundColor: dirStyle.text }} />
                </div>

                {decision.direction !== 'FLAT' && decision.direction !== 'NO_GO' && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                    <Box label="Entry"     value={decision.entry} color={dirStyle.text} />
                    <Box label="Stop Loss" value={decision.stopLoss} color="#ff3355" />
                    <Box label="TP1"       value={decision.takeProfit1} color="#00e096" />
                    <Box label="TP2"       value={decision.takeProfit2} color="#00e096" />
                  </div>
                )}

                {decision.riskReward && (
                  <div className="font-mono text-xs text-text-secondary mb-2">
                    R:R atteso <span className="text-text-primary font-semibold">1:{decision.riskReward.toFixed(2)}</span>
                  </div>
                )}

                {decision.reasoning && (
                  <p className="font-mono text-sm text-text-primary leading-relaxed mt-2">
                    {decision.reasoning}
                  </p>
                )}
              </div>

              {/* Save button + meta */}
              <div className="flex items-center justify-between gap-4">
                {decision.direction !== 'FLAT' && decision.direction !== 'NO_GO' && (
                  <button onClick={handleSaveDecision}
                          className="flex-1 px-4 py-2 rounded-md font-mono text-sm font-medium border transition-all"
                          style={{
                            backgroundColor: savedId ? '#00e09618' : dirStyle.bg,
                            borderColor:     savedId ? '#00e09660' : dirStyle.border,
                            color:           savedId ? '#00e096'   : dirStyle.text,
                          }}>
                    {savedId ? '✓ Salvata nel diario' : '💾 Salva nel diario'}
                  </button>
                )}
                {result.usage && (
                  <span className="font-mono text-xxs text-text-muted shrink-0">
                    {result.usage.input_tokens}in / {result.usage.output_tokens}out · {result.model}
                  </span>
                )}
              </div>

              {/* Mode badge (Intraday vs Scalping) */}
              {decision.mode === 'scalping' && (
                <ScalpModeBanner decision={decision} />
              )}

              {/* MTF Screening — solo intraday (scalping non ha questo schema) */}
              {decision.mtf_screening && (
                <MTFScreeningView mtf={decision.mtf_screening} />
              )}

              {/* Checklist 18-step (intraday) OR 10-step (scalping) */}
              {decision.checklist?.length > 0 && (
                <ChecklistView checklist={decision.checklist} score={decision.checklist_score} />
              )}
              {decision.scalp_checklist?.length > 0 && (
                <ChecklistView checklist={decision.scalp_checklist} score={decision.scalping_score} title="⚡ Scalp Checklist — 10 step" />
              )}

              {/* Suggested alternative asset */}
              {decision.suggestedAlternativeAsset && (
                <div className="bg-bg-secondary border-2 rounded-xl p-4"
                     style={{ borderColor: decision.suggestedAlternativeAsset.direction === 'LONG' ? '#00e09660' : '#ff335560' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xxs uppercase tracking-wider text-gold">⚡ Alternativa migliore</span>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-2xl font-bold"
                          style={{ color: decision.suggestedAlternativeAsset.direction === 'LONG' ? '#00e096' : '#ff3355' }}>
                      {decision.suggestedAlternativeAsset.direction === 'LONG' ? '▲' : '▼'} {decision.suggestedAlternativeAsset.symbol}
                    </span>
                  </div>
                  <p className="font-mono text-sm text-text-primary mt-1.5">{decision.suggestedAlternativeAsset.reason}</p>
                </div>
              )}

              {/* Key factors & risks side by side */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {decision.keyFactors?.length > 0 && (
                  <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
                    <div className="font-mono text-xs text-green font-semibold mb-2 uppercase tracking-wider">
                      ✓ Fattori chiave
                    </div>
                    <ul className="space-y-1">
                      {decision.keyFactors.map((f, i) => (
                        <li key={i} className="font-mono text-xs text-text-primary flex gap-2 leading-relaxed">
                          <span className="text-green/60 shrink-0">▸</span>
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {decision.risks?.length > 0 && (
                  <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
                    <div className="font-mono text-xs text-red font-semibold mb-2 uppercase tracking-wider">
                      ⚠ Rischi
                    </div>
                    <ul className="space-y-1">
                      {decision.risks.map((r, i) => (
                        <li key={i} className="font-mono text-xs text-text-primary flex gap-2 leading-relaxed">
                          <span className="text-red/60 shrink-0">▸</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar collassabile */}
        {sidebarOpen ? (
          <aside className="w-[340px] shrink-0 border-l border-bg-border bg-bg-secondary/30 flex flex-col overflow-hidden">
            {/* Tab bar */}
            <div className="flex items-center border-b border-bg-border bg-bg-secondary/50 shrink-0">
              {SIDEBAR_TABS.map(t => {
                const active = sidebarTab === t.id
                const count = tabCounts[t.id]
                return (
                  <button key={t.id}
                          onClick={() => setSidebarTab(t.id)}
                          className={`flex-1 px-2 py-2 font-mono text-xxs flex items-center justify-center gap-1 border-b-2 transition-all ${
                            active ? 'border-gold text-gold bg-bg-primary/30' : 'border-transparent text-text-secondary hover:text-text-primary'
                          }`}>
                    <span className="text-sm leading-none">{t.icon}</span>
                    <span className="hidden xl:inline">{t.label}</span>
                    {count != null && count > 0 && (
                      <span className={`tabular-nums ${active ? 'text-gold' : 'text-text-muted'}`}>{count}</span>
                    )}
                  </button>
                )
              })}
              <button onClick={() => setSidebarOpen(false)}
                      title="Nascondi sidebar"
                      className="px-2 py-2 font-mono text-xxs text-text-muted hover:text-text-primary border-b-2 border-transparent">
                ›
              </button>
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-3">
              {sidebarTab === 'scan' && (
                <ScanTab scanResults={scanResults} activeInstrument={activeInstrument} includeScan={includeScan} />
              )}
              {sidebarTab === 'schedule' && (
                <ScheduleTab eventSuggestions={eventSuggestions}
                             scheduled={scheduled}
                             onAdd={handleAddSchedule}
                             onDelete={handleDeleteSchedule}
                             onRetry={handleRetrySchedule} />
              )}
              {sidebarTab === 'track' && (
                <TrackTab trackRecord={trackRecord} />
              )}
              {sidebarTab === 'payload' && (
                <PayloadTab contextPack={contextPack} trackRecord={trackRecord} includeTrackRecord={includeTrackRecord} />
              )}
            </div>
          </aside>
        ) : (
          <button onClick={() => setSidebarOpen(true)}
                  title="Mostra strumenti (scan, schedule, track record)"
                  className="w-8 shrink-0 border-l border-bg-border bg-bg-secondary/30 flex flex-col items-center justify-center gap-2 font-mono text-xs text-text-muted hover:text-text-primary hover:bg-bg-hover transition-all">
            <span>‹</span>
            <span style={{ writingMode: 'vertical-rl' }} className="text-xxs uppercase tracking-widest">Strumenti</span>
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Header del pannello ────────────────────────────────────────────
function PanelHeader({ onClose, symbol, timeframe }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
      <div>
        <h2 className="font-mono text-lg font-semibold text-gold tracking-wider">
          🧠 DECISIONE CLAUDE — {symbol} · {timeframe}
        </h2>
        <p className="font-mono text-xxs text-text-muted mt-0.5">
          🧠 Intraday (1D/4h/1h/15m, hold 1-6h+) · ⚡ Scalp (1h/15m/1m, hold 5-30min)
        </p>
      </div>
      <button onClick={onClose}
              className="font-mono text-xs text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
        ✕ Chiudi
      </button>
    </div>
  )
}

// ─── No-data banner: shown when contextPack is null ─────────────────
function NoDataBanner({ symbol, timeframe, instruments, onReload, loading }) {
  const inst   = instruments?.[symbol]
  const nCdl   = inst?.candles?.length || 0
  const nMTF1D = inst?.mtf?.['1D']?.length || 0
  const nMTF4h = inst?.mtf?.['4h']?.length || 0
  const nMTF1h = inst?.mtf?.['1h']?.length || 0
  const nMTF15 = inst?.mtf?.['15m']?.length || 0
  const borderCls = loading ? 'border-gold/40 bg-gold/10' : 'border-red/30 bg-red/10'
  const titleCls  = loading ? 'text-gold' : 'text-red'
  return (
    <div className={`border-2 rounded-xl p-5 mb-4 ${borderCls}`}>
      <div className="flex items-start gap-3">
        <div className="text-3xl">{loading ? '⏳' : '⚠'}</div>
        <div className="flex-1">
          <h3 className={`font-mono text-base font-semibold mb-1 ${titleCls}`}>
            {loading
              ? `Caricamento candele ${symbol} (${timeframe}) in corso...`
              : `Nessun dato disponibile per ${symbol} (${timeframe})`}
          </h3>
          <p className="font-mono text-xs text-text-secondary mb-3 leading-relaxed">
            {loading
              ? `Sto fetchando le candele dal data hub (TwelveData → Yahoo fallback) e tutte le MTF (15m/1h/4h/1D). Di solito 2-5 secondi.`
              : <>Il context pack non può essere costruito: <span className="text-red font-semibold">instruments[{symbol}].candles</span> è vuoto. Possibili cause: TwelveData quota esaurita (free tier 800 call/giorno), Yahoo proxy backend lento, oppure il chart non è ancora stato montato.</>}
          </p>
          <div className="grid grid-cols-5 gap-2 mb-3 font-mono text-xxs">
            <div className="bg-bg-primary rounded p-2 text-center">
              <div className="text-text-muted uppercase">Main</div>
              <div className={nCdl ? 'text-green font-bold' : 'text-red font-bold'}>{nCdl}</div>
            </div>
            <div className="bg-bg-primary rounded p-2 text-center">
              <div className="text-text-muted uppercase">1D</div>
              <div className={nMTF1D ? 'text-green font-bold' : 'text-red font-bold'}>{nMTF1D}</div>
            </div>
            <div className="bg-bg-primary rounded p-2 text-center">
              <div className="text-text-muted uppercase">4h</div>
              <div className={nMTF4h ? 'text-green font-bold' : 'text-red font-bold'}>{nMTF4h}</div>
            </div>
            <div className="bg-bg-primary rounded p-2 text-center">
              <div className="text-text-muted uppercase">1h</div>
              <div className={nMTF1h ? 'text-green font-bold' : 'text-red font-bold'}>{nMTF1h}</div>
            </div>
            <div className="bg-bg-primary rounded p-2 text-center">
              <div className="text-text-muted uppercase">15m</div>
              <div className={nMTF15 ? 'text-green font-bold' : 'text-red font-bold'}>{nMTF15}</div>
            </div>
          </div>
          <button onClick={onReload} disabled={loading}
                  className="px-4 py-2 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50">
            {loading ? '⏳ Caricamento candele...' : `↻ Ricarica candele ${symbol}`}
          </button>
          <p className="font-mono text-xxs text-text-muted mt-2">
            Se il reload non risolve, apri la console (F12) e guarda gli errori <code>[DataHub] loadCandles {symbol}</code>.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Empty state ────────────────────────────────────────────────────
function EmptyState({ onAsk, onAskScalp, disabled }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto pt-8">
      <div className="text-5xl mb-4">🧠</div>
      <h3 className="font-mono text-lg text-gold mb-2">Pronto per l'analisi</h3>
      <p className="font-mono text-sm text-text-secondary mb-6 leading-relaxed">
        Scegli la modalità di analisi. <span className="text-gold">Intraday</span> per swing/day trading
        (hold 1-6h+, R:R 2:1, checklist 18-step). <span className="text-orange-300">Scalp</span> per
        micro-timing entry (hold 5-30 min, R:R 1.5:1, checklist 10-step).
      </p>
      <div className="grid grid-cols-2 gap-3 w-full mb-6 font-mono text-xxs">
        <div className="bg-bg-secondary rounded-lg p-3 border border-gold/30">
          <div className="text-gold mb-1.5 font-semibold">🧠 INTRADAY</div>
          <div className="text-text-muted leading-relaxed">
            TF: 1D · 4h · 1h · 15m<br/>
            Murphy top-down<br/>
            Hold 1-6h+ · R:R ≥ 2:1
          </div>
        </div>
        <div className="bg-bg-secondary rounded-lg p-3 border border-orange-500/30">
          <div className="text-orange-300 mb-1.5 font-semibold">⚡ SCALP</div>
          <div className="text-text-muted leading-relaxed">
            TF: 1h · 15m · 1m<br/>
            Kill zone + trigger micro<br/>
            Hold 5-30min · R:R ≥ 1.5:1
          </div>
        </div>
      </div>
      <div className="flex gap-3">
        <button onClick={onAsk} disabled={disabled}
                className="px-5 py-3 rounded-md font-mono text-base font-semibold bg-gold/20 text-gold border-2 border-gold/50 hover:bg-gold/30 disabled:opacity-50">
          🧠 Intraday
        </button>
        <button onClick={onAskScalp} disabled={disabled}
                className="px-5 py-3 rounded-md font-mono text-base font-semibold bg-orange-500/20 text-orange-300 border-2 border-orange-500/50 hover:bg-orange-500/30 disabled:opacity-50">
          ⚡ Scalp
        </button>
      </div>
    </div>
  )
}

// ─── Sidebar tabs ───────────────────────────────────────────────────
function ScanTab({ scanResults, activeInstrument, includeScan }) {
  if (!includeScan) {
    return <EmptyTab icon="🔍" message="Scan disabilitato. Attiva 'Multi-asset scan' nella barra in alto per vedere le opportunità su altri asset." />
  }
  if (!scanResults || scanResults.length === 0) {
    return <EmptyTab icon="🔍" message="Nessun asset disponibile per la scansione." />
  }
  return (
    <div className="space-y-2">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">
        Top opportunità multi-asset
      </div>
      {scanResults.slice(0, 8).map((r, i) => {
        const dirColor = r.direction === 'LONG' ? '#00e096' : r.direction === 'SHORT' ? '#ff3355' : '#8892a4'
        const qualityColor = r.oppScore >= 60 ? '#00e096' : r.oppScore >= 40 ? '#f5c842' : '#8892a4'
        const isCurrent = r.symbol === activeInstrument
        return (
          <div key={r.symbol} className={`rounded-md p-2 border ${isCurrent ? 'border-gold/40 bg-gold/5' : 'border-bg-border bg-bg-primary'}`}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xxs text-text-muted tabular-nums">#{i + 1}</span>
                <span className="font-mono text-sm font-semibold text-gold truncate">{r.symbol}</span>
                {isCurrent && <span className="font-mono text-xxs text-text-muted">(attivo)</span>}
              </div>
              <span className="font-mono text-xs font-bold tabular-nums" style={{ color: qualityColor }}>{r.oppScore}</span>
            </div>
            <div className="flex items-center justify-between font-mono text-xxs">
              <span style={{ color: dirColor }} className="font-semibold">{r.direction}</span>
              <span className="text-text-secondary">{r.confidence}% · MTF {r.mtfAligned}</span>
              <span className="text-text-muted">{r.regime || '—'}</span>
            </div>
          </div>
        )
      })}
      <div className="font-mono text-xxs text-text-muted mt-3 pt-2 border-t border-bg-border/50">
        Claude vede questa scansione e può suggerire un asset alternativo migliore.
      </div>
    </div>
  )
}

function ScheduleTab({ eventSuggestions, scheduled, onAdd, onDelete, onRetry }) {
  const pending = scheduled.filter(s => s.status === 'pending')
  const recent  = scheduled.slice(-5).reverse()

  if (eventSuggestions.length === 0 && scheduled.length === 0) {
    return <EmptyTab icon="⏰" message="Nessun evento alto impatto in arrivo. Le analisi automatiche post-evento appariranno qui." />
  }

  return (
    <div className="space-y-4">
      {eventSuggestions.length > 0 && (
        <div>
          <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">
            Eventi in arrivo · pianifica analisi auto
          </div>
          <div className="space-y-1.5">
            {eventSuggestions.map((s, i) => (
              <div key={i} className="bg-bg-primary rounded-md p-2 border border-bg-border">
                <div className="font-mono text-xs text-text-primary truncate">{s.eventTitle}</div>
                <div className="font-mono text-xxs text-text-muted mt-0.5">
                  {s.currency} · {new Date(s.eventTime).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  {' → analisi '}{new Date(s.suggestedTime).toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                </div>
                <button onClick={() => onAdd(s)}
                        className="w-full mt-2 px-2 py-1 rounded font-mono text-xxs bg-gold/20 text-gold border border-gold/40 hover:bg-gold/30">
                  + Programma
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {scheduled.length > 0 && (
        <div>
          <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">
            Programmate ({pending.length} attive)
          </div>
          <div className="space-y-1.5">
            {recent.map(s => {
              const statusColor = s.status === 'pending' ? '#f5c842'
                                : s.status === 'running' ? '#2196F3'
                                : s.status === 'completed' ? '#00e096' : '#ff3355'
              return (
                <div key={s.id} className="bg-bg-primary rounded-md p-2 border border-bg-border">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ backgroundColor: statusColor }} />
                        <span className="font-mono text-xs font-semibold text-text-primary truncate">
                          {s.symbol} {s.timeframe}
                        </span>
                        <span className="font-mono text-xxs uppercase tracking-wider shrink-0" style={{ color: statusColor }}>
                          {s.status}
                        </span>
                      </div>
                      <div className="font-mono text-xxs text-text-muted mt-0.5">
                        {new Date(s.scheduledAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                      {s.result && (
                        <div className="font-mono text-xxs mt-1">
                          <span className="font-semibold" style={{
                            color: s.result.direction === 'LONG' ? '#00e096' : s.result.direction === 'SHORT' ? '#ff3355' : '#f5c842'
                          }}>
                            → {s.result.direction} {s.result.confidence}%
                          </span>
                        </div>
                      )}
                      {s.error && <div className="font-mono text-xxs text-red mt-1">⚠ {s.error}</div>}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      {s.status === 'failed' && onRetry && (
                        <button onClick={() => onRetry(s.id)}
                                title="Riprova: ricarica candele e rilancia"
                                className="font-mono text-xxs text-gold/80 hover:text-gold">
                          ↻
                        </button>
                      )}
                      <button onClick={() => onDelete(s.id)}
                              className="font-mono text-xxs text-red/60 hover:text-red">
                        🗑
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function TrackTab({ trackRecord }) {
  if (!trackRecord || trackRecord.summary.total === 0) {
    return <EmptyTab icon="📊" message="Nessuna decisione di Claude ancora salvata. Salva una decisione per iniziare il track record." />
  }
  const s = trackRecord.summary
  return (
    <div className="space-y-3">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">
        Self-improvement · ultime {s.total} decisioni
      </div>

      {/* KPI principale */}
      <div className="bg-bg-primary rounded-lg p-3 border border-bg-border text-center">
        <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Win Rate</div>
        <div className="font-mono text-3xl font-bold tabular-nums"
             style={{ color: s.win_rate >= 55 ? '#00e096' : s.win_rate < 45 ? '#ff3355' : '#f5c842' }}>
          {s.win_rate}%
        </div>
        <div className="font-mono text-xxs text-text-muted">{s.total} trade chiusi</div>
      </div>

      {/* Mini grid */}
      <div className="grid grid-cols-2 gap-2">
        <Mini label="R medio" value={s.avg_r.toFixed(2)}
              color={s.avg_r >= 0 ? '#00e096' : '#ff3355'} />
        <Mini label="Long WR" value={s.long_wr != null ? s.long_wr + '%' : '—'} />
        <Mini label="Short WR" value={s.short_wr != null ? s.short_wr + '%' : '—'} />
        <Mini label="Aperti" value={s.open || 0} />
      </div>

      <div className="font-mono text-xxs text-text-muted leading-relaxed pt-2 border-t border-bg-border/50">
        Claude vede queste statistiche e impara dai propri errori per migliorare le decisioni successive.
      </div>
    </div>
  )
}

function PayloadTab({ contextPack, trackRecord, includeTrackRecord }) {
  const payload = { context_pack: contextPack, your_recent_track_record: includeTrackRecord ? trackRecord : null }
  return (
    <div>
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">
        Payload JSON inviato a Claude
      </div>
      <pre className="font-mono text-xxs text-text-muted bg-bg-primary p-2 rounded border border-bg-border overflow-x-auto whitespace-pre-wrap break-all"
           style={{ fontSize: '10px', lineHeight: '1.4' }}>
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  )
}

function EmptyTab({ icon, message }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-2">
      <div className="text-3xl mb-2 opacity-50">{icon}</div>
      <div className="font-mono text-xxs text-text-muted leading-relaxed">{message}</div>
    </div>
  )
}

// ─── Self-Consistency Banner — mostra agreement tra 3 call parallele ─
function SelfConsistencyBanner({ decision }) {
  const score = decision.self_consistency_score ?? 0
  const note  = decision.self_consistency_note || ''
  const dirs  = decision.self_consistency_directions || []
  const confs = decision.self_consistency_confidences || []
  const color = score >= 100 ? '#00e096' : score >= 67 ? '#82aaff' : score >= 50 ? '#f5c842' : '#ff3355'
  const label = score >= 100 ? 'UNANIME' : score >= 67 ? 'CONCORDANTE' : score >= 50 ? 'PARZIALE' : 'DISCORDANTE'
  return (
    <div className="rounded-xl border-2 p-3" style={{ backgroundColor: color + '15', borderColor: color + '60' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">🎯 Self-consistency</span>
          <span className="font-mono text-xs font-bold" style={{ color }}>{label}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold tabular-nums" style={{ color }}>{score}%</span>
          <span className="font-mono text-xxs text-text-muted">agreement</span>
        </div>
      </div>
      {dirs.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {dirs.map((d, i) => (
            <div key={i} className="bg-bg-primary rounded p-1.5 text-center">
              <div className="font-mono text-xxs text-text-muted">T={[0.3,0.5,0.7][i]}</div>
              <div className="font-mono text-xs font-bold" style={{
                color: d === 'LONG' ? '#00e096' : d === 'SHORT' ? '#ff3355' : '#f5c842'
              }}>{d}</div>
              <div className="font-mono text-xxs text-text-secondary">{confs[i]}%</div>
            </div>
          ))}
        </div>
      )}
      {note && <div className="font-mono text-xxs text-text-muted mt-2 italic">{note}</div>}
    </div>
  )
}

// ─── Action Card: "COSA FARE ORA" semaforo plain-Italian ────────────
// Traduce automaticamente la decisione Claude in linguaggio semplice e
// azionabile. Derivato dai campi esistenti, no extra prompt cost.
function ActionCard({ decision, symbol }) {
  const d = decision
  const dir = d.direction
  const conf = d.confidence
  const tHor = d.timeHorizon

  // Determina stato semaforo + messaggio
  let state, title, mainMsg, subMsg, steps, icon
  const fmtPrice = (v) => v == null ? '—' : (v > 100 ? v.toFixed(2) : v.toFixed(4))

  const isScalp = d.mode === 'scalping'

  if (dir === 'FLAT' || dir === 'NO_GO' || tHor === 'wait') {
    state = 'wait'
    icon = '🟡'
    title = isScalp
      ? (dir === 'NO_GO' ? 'NO-GO — niente scalping ora' : 'ASPETTA — setup scalping non pronto')
      : 'ASPETTA — non operare ora'
    mainMsg = d.reasoning || 'Il setup non è abbastanza forte per entrare ora.'
    // Cerca info sul "cosa aspettare" nel reasoning / risks / keyFactors
    const planText = (d.keyFactors?.find(f => /attendere|aspettare|pullback|ritest|target/i.test(f))
                    || d.risks?.find(r => /attendere|aspettare|pullback/i.test(r)))
    if (planText) subMsg = planText
    else if (isScalp) subMsg = 'Ricontrolla tra pochi minuti o aspetta una kill zone più attiva.'
    else              subMsg = 'Ricontrolla tra 1-4 ore o quando il prezzo si muove significativamente.'
    steps = isScalp
      ? [
        `Non scalpare ${symbol} ora`,
        'Aspetta un trigger 1m fresco (pin bar / engulfing / breakout retest)',
        'Verifica che la kill zone (London o NY) sia attiva',
        'Rilancia ⚡ Scalp se vedi setup migliorare',
      ]
      : [
        `Non aprire posizioni su ${symbol} ora`,
        'Imposta un alert sulla piattaforma se vuoi essere avvisato',
        'Rilancia "Chiedi a Claude" se il mercato si muove molto',
      ]
  } else if (conf >= 60) {
    state = 'enter'
    icon = '🟢'
    const action = dir === 'LONG' ? 'COMPRA (LONG)' : 'VENDI (SHORT)'
    title = isScalp
      ? `GO ${action} su ${symbol} — SCALP`
      : `ENTRA — ${action} su ${symbol}`
    mainMsg = d.reasoning || `Setup di qualità — confidence ${conf}%.`
    if (isScalp) {
      const hold = d.expected_hold_minutes != null ? `${d.expected_hold_minutes}min hold previsto` : 'hold breve'
      subMsg = `⚡ Scalping · ${hold} · session ${d.session || '—'}`
    } else {
      subMsg = `Orizzonte: ${tHor === 'intraday' ? 'intraday (poche ore)' : tHor === 'swing' ? 'swing (giorni)' : tHor}`
    }
    const rr = d.riskReward ? `R:R ${d.riskReward.toFixed(1)}:1` : ''
    steps = isScalp
      ? [
        `Entry: ${fmtPrice(d.entry)} (limit o market dopo trigger 1m)`,
        `Stop Loss STRETTO: ${fmtPrice(d.stopLoss)} (5-15 punti tipico)`,
        `TP1: ${fmtPrice(d.takeProfit1)} — chiudi 50% qui`,
        d.takeProfit2 ? `TP2: ${fmtPrice(d.takeProfit2)} — chiudi resto con trail` : null,
        `Rischio max: 1% del conto · ${rr}`,
        `Plan: trail a BE dopo +1R, exit pieno se candela 1m chiude contro`,
      ].filter(Boolean)
      : [
        `Entry: ${fmtPrice(d.entry)} (o limite a questo prezzo)`,
        `Stop Loss: ${fmtPrice(d.stopLoss)} — esci se il prezzo arriva qui`,
        `Take Profit 1: ${fmtPrice(d.takeProfit1)} (chiudi metà posizione)`,
        d.takeProfit2 ? `Take Profit 2: ${fmtPrice(d.takeProfit2)} (chiudi resto)` : null,
        `Rischio max: 2% del conto · ${rr}`,
      ].filter(Boolean)
  } else {
    state = 'evaluate'
    icon = '🟠'
    const action = dir === 'LONG' ? 'COMPRA' : 'VENDI'
    title = `VALUTA — ${action} solo se hai convinzione personale`
    mainMsg = d.reasoning || `Setup tiepido (confidence ${conf}%). Claude vede la direzione ma non con forza.`
    subMsg = 'Decisione tua: o aspetti che migliori, o entri con size dimezzata.'
    steps = [
      `Se entri: dimezza la size (1% rischio invece del 2%)`,
      `Entry: ${fmtPrice(d.entry)}, SL: ${fmtPrice(d.stopLoss)}, TP1: ${fmtPrice(d.takeProfit1)}`,
      `Se non entri: aspetta il prossimo segnale (confidence > 60%)`,
    ]
  }

  const palette = {
    wait:     { bg: '#f5c84210', border: '#f5c842', text: '#f5c842', accent: '#f5c842' },
    enter:    { bg: '#00e09618', border: '#00e096', text: '#00e096', accent: '#00e096' },
    evaluate: { bg: '#ff993310', border: '#ff9933', text: '#ff9933', accent: '#ff9933' },
  }[state]

  return (
    <div className="rounded-xl border-2 p-5 shadow-lg"
         style={{ backgroundColor: palette.bg, borderColor: palette.border }}>
      <div className="flex items-start gap-4">
        <div className="text-5xl shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xxs uppercase tracking-wider text-text-muted mb-1">
            Cosa fare ora
          </div>
          <h2 className="font-mono text-xl font-bold mb-2" style={{ color: palette.text }}>
            {title}
          </h2>
          <p className="font-mono text-sm text-text-primary leading-relaxed mb-3">
            {mainMsg}
          </p>
          {subMsg && (
            <p className="font-mono text-xs text-text-secondary italic mb-3">
              {subMsg}
            </p>
          )}
          <div className="bg-bg-primary/60 rounded-lg p-3 border border-bg-border/50">
            <div className="font-mono text-xxs uppercase tracking-wider mb-2"
                 style={{ color: palette.accent }}>
              Piano operativo
            </div>
            <ol className="space-y-1.5">
              {steps.map((s, i) => (
                <li key={i} className="font-mono text-xs text-text-primary flex gap-2 leading-relaxed">
                  <span className="font-bold shrink-0" style={{ color: palette.accent }}>{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Scalp Mode Banner (info aggiuntive per modalità scalping) ─────
function ScalpModeBanner({ decision }) {
  const sessionColors = {
    London: '#00e096', NY_AM: '#00e096', NY_PM: '#82aaff',
    Asia: '#f5c842', Overlap: '#00e096', Dead: '#ff3355',
  }
  const sessionColor = sessionColors[decision.session] || '#8892a4'
  const fields = [
    { label: 'MODE', value: '⚡ Scalping', color: '#ff9933' },
    { label: 'Session', value: decision.session || '—', color: sessionColor },
    { label: 'Hold', value: decision.expected_hold_minutes != null ? `${decision.expected_hold_minutes}min` : '—', color: '#82aaff' },
    { label: 'Score', value: `${decision.scalping_score ?? '—'}/100`, color: (decision.scalping_score ?? 0) >= 80 ? '#00e096' : (decision.scalping_score ?? 0) >= 60 ? '#f5c842' : '#ff3355' },
  ]
  return (
    <div className="bg-orange-500/5 border-2 border-orange-500/30 rounded-xl p-4">
      <div className="grid grid-cols-4 gap-2 mb-3">
        {fields.map((f, i) => (
          <div key={i} className="text-center">
            <div className="font-mono text-xxs uppercase tracking-wider text-text-muted">{f.label}</div>
            <div className="font-mono text-sm font-bold tabular-nums" style={{ color: f.color }}>{f.value}</div>
          </div>
        ))}
      </div>
      {decision.why_now && (
        <div className="bg-bg-primary/50 rounded p-2 mb-2 border-l-2 border-orange-400">
          <div className="font-mono text-xxs uppercase text-orange-300 mb-0.5">⚡ Why now (trigger 1m)</div>
          <div className="font-mono text-xs text-text-primary">{decision.why_now}</div>
        </div>
      )}
      {decision.invalidation && (
        <div className="bg-bg-primary/50 rounded p-2 border-l-2 border-red/60">
          <div className="font-mono text-xxs uppercase text-red mb-0.5">⚠ Invalidation</div>
          <div className="font-mono text-xs text-text-primary">{decision.invalidation}</div>
        </div>
      )}
    </div>
  )
}

// ─── MTF Screening View ─────────────────────────────────────────────
function MTFScreeningView({ mtf }) {
  const tfs = [
    { id: '1D',  data: mtf.tf_1D,  label: '1D · Daily' },
    { id: '4h',  data: mtf.tf_4h,  label: '4h · Swing' },
    { id: '1h',  data: mtf.tf_1h,  label: '1h · Setup' },
    { id: '15m', data: mtf.tf_15m, label: '15m · Trigger' },
  ]
  const align = Number(mtf.alignment_score ?? 0)
  const alignColor = align >= 75 ? '#00e096' : align >= 50 ? '#f5c842' : '#ff3355'
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-xs text-gold font-semibold uppercase tracking-wider">
          🔍 MTF Screening — Murphy top-down
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xxs text-text-muted uppercase">Alignment</span>
          <span className="font-mono text-2xl font-bold tabular-nums" style={{ color: alignColor }}>{align}</span>
          <span className="font-mono text-xxs text-text-muted">/100</span>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-2">
        {tfs.map(tf => {
          const d = tf.data || {}
          const s = d.status || 'skip'
          const dotColor = s === 'pass' ? '#00e096' : s === 'fail' ? '#ff3355' : s === 'warn' ? '#f5c842' : '#5a6478'
          return (
            <div key={tf.id} className="bg-bg-primary rounded-md border border-bg-border p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-xxs uppercase tracking-wider text-text-secondary">{tf.label}</span>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
              </div>
              <div className="space-y-0.5">
                {Object.entries(d).filter(([k]) => k !== 'status').map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-1 font-mono text-xxs">
                    <span className="text-text-muted truncate">{k}</span>
                    <span className="text-text-primary truncate text-right">{String(v).slice(0, 24)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {mtf.summary && (
        <div className="font-mono text-xxs text-text-secondary italic pt-2 border-t border-bg-border/50">
          {mtf.summary}
        </div>
      )}
    </div>
  )
}

// ─── Trader Pro Checklist View 18-step ──────────────────────────────
const STATUS_STYLE = {
  pass: { icon: '✓', color: '#00e096', bg: '#00e09618' },
  fail: { icon: '✗', color: '#ff3355', bg: '#ff335518' },
  warn: { icon: '⚠', color: '#f5c842', bg: '#f5c84218' },
  skip: { icon: '–', color: '#5a6478', bg: '#5a647818' },
}
// Ordine fasi supportato (intraday + scalping). Se la fase non è nell'array
// finisce ordinata in coda usando l'ordine d'apparizione.
const PHASE_ORDER = [
  'MTF Screening', 'Context Macro', 'Setup Quality', 'Execution', 'Risk & Psy',  // intraday
  'Context', 'Direction', 'Exit',                                                  // scalping
]
function ChecklistView({ checklist, score, title }) {
  // Group preservando ordine dichiarato + raccogliendo ogni fase incontrata
  const phasesSeen = []
  for (const c of checklist) {
    if (c.phase && !phasesSeen.includes(c.phase)) phasesSeen.push(c.phase)
  }
  const orderedPhases = [
    ...PHASE_ORDER.filter(p => phasesSeen.includes(p)),
    ...phasesSeen.filter(p => !PHASE_ORDER.includes(p)),
  ]
  const grouped = orderedPhases.map(phase => ({
    phase,
    items: checklist.filter(c => c.phase === phase),
  })).filter(g => g.items.length > 0)
  const passCount = checklist.filter(c => c.status === 'pass').length
  const failCount = checklist.filter(c => c.status === 'fail').length
  const warnCount = checklist.filter(c => c.status === 'warn').length
  const skipCount = checklist.filter(c => c.status === 'skip').length
  const scoreVal = Number(score ?? Math.round((passCount / checklist.length) * 100))
  const scoreColor = scoreVal >= 80 ? '#00e096' : scoreVal >= 60 ? '#f5c842' : '#ff3355'
  const titleText = title || `📋 Trader Pro Checklist — ${checklist.length} step`
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-mono text-xs text-gold font-semibold uppercase tracking-wider">
            {titleText}
          </div>
          <div className="flex gap-3 mt-1 font-mono text-xxs">
            <span className="text-green">✓ {passCount}</span>
            <span className="text-red">✗ {failCount}</span>
            <span className="text-gold">⚠ {warnCount}</span>
            <span className="text-text-muted">– {skipCount}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Score</div>
          <div className="font-mono text-3xl font-bold tabular-nums" style={{ color: scoreColor }}>{scoreVal}</div>
        </div>
      </div>
      <div className="space-y-3">
        {grouped.map(g => (
          <div key={g.phase}>
            <div className="font-mono text-xxs text-text-secondary uppercase tracking-wider mb-1.5 border-b border-bg-border/50 pb-1">
              FASE — {g.phase}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {g.items.map(item => {
                const st = STATUS_STYLE[item.status] || STATUS_STYLE.skip
                return (
                  <div key={item.step} className="flex items-start gap-2 rounded-md p-2"
                       style={{ backgroundColor: st.bg }}>
                    <span className="font-mono text-sm font-bold shrink-0 w-5 text-center" style={{ color: st.color }}>{st.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-text-primary font-semibold leading-tight">
                        {item.step}. {item.label}
                      </div>
                      {item.note && (
                        <div className="font-mono text-xxs text-text-muted leading-tight mt-0.5">{item.note}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Box({ label, value, color }) {
  return (
    <div className="bg-bg-primary rounded-lg px-2.5 py-1.5">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-sm tabular-nums font-semibold" style={{ color }}>
        {value != null ? value : '—'}
      </div>
    </div>
  )
}

function Mini({ label, value, color = '#e5e7eb' }) {
  return (
    <div className="bg-bg-primary rounded-md p-2 border border-bg-border">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-base tabular-nums font-semibold" style={{ color }}>{value}</div>
    </div>
  )
}
