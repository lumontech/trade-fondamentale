import { useMemo, useState } from 'react'
import { useAppStore } from '../store/store'
import { calculateSignal } from '../utils/indicators'
import { calculateRecommendation } from '../services/ScoringEngine'
import { getBacktestStats } from '../services/BacktestEngine'
import { calculateCorrelationMatrix, crossAssetConfirmation } from '../services/CorrelationEngine'
import { extractTags, quickSentiment } from '../services/NewsService'
import { calculateMTFConfluence } from '../services/MTFConfluence'
import { analyzeSMC } from '../services/SMCEngine'
import { detectVolatilityRegime } from '../services/VolatilityRegime'
import { detectAllPatterns } from '../services/PatternsEngine'
import { logDecision } from '../services/TradeLog'
import { useToast } from './ui/Toast'

const DIRECTION_STYLE = {
  LONG:  { bg: '#00e09618', border: '#00e09660', text: '#00e096', icon: '▲', label: 'LONG' },
  SHORT: { bg: '#ff335518', border: '#ff335560', text: '#ff3355', icon: '▼', label: 'SHORT' },
  FLAT:  { bg: '#f5c84218', border: '#f5c84260', text: '#f5c842', icon: '■', label: 'FLAT' },
}

export default function ScoringPanel() {
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])
  const instruments      = useAppStore(s => s.instruments)
  const events           = useAppStore(s => s.events)
  const marketContext    = useAppStore(s => s.marketContext)
  const cotAll           = useAppStore(s => s.cot)
  const news             = useAppStore(s => s.news)
  const livePrice        = useAppStore(s => s.instruments[activeInstrument]?.price)
  const [savedId, setSavedId] = useState(null)
  const toast            = useToast()

  const recommendation = useMemo(() => {
    if (candles.length < 50) return null
    const technicalSignal = calculateSignal(candles)
    const backtestStats   = getBacktestStats(activeInstrument, activeTimeframe, candles)
    // Cross-asset confirmation: prima la direzione probabile (basata su tecnico),
    // poi controllo se gli asset correlati confermano
    const probableDir = technicalSignal?.label?.includes('COMPRA') ? 'LONG'
                      : technicalSignal?.label?.includes('VENDI') ? 'SHORT'
                      : null
    let crossAsset = null
    if (probableDir) {
      const { matrix } = calculateCorrelationMatrix(instruments, 100)
      crossAsset = crossAssetConfirmation(activeInstrument, probableDir, instruments, matrix)
    }
    // Arricchisci news con tags e sentiment per il scoring
    const enrichedNews = news.map(n => ({
      ...n,
      tags: n.tags || extractTags(n.headline + ' ' + (n.summary || '')),
      sentiment: n.sentiment != null ? n.sentiment : quickSentiment(n.headline + ' ' + (n.summary || '')),
    }))
    const mtf = calculateMTFConfluence(instruments[activeInstrument])
    const smc = analyzeSMC(candles)
    const regime = detectVolatilityRegime(candles)
    const patterns = detectAllPatterns(candles)
    return calculateRecommendation({
      symbol: activeInstrument,
      technicalSignal,
      events,
      marketContext,
      backtestStats,
      crossAsset,
      cot: cotAll[activeInstrument] || null,
      news: enrichedNews,
      mtf,
      smc,
      regime,
      patterns,
      now: new Date(),
    })
  }, [activeInstrument, activeTimeframe, candles, instruments, events, marketContext, cotAll, news])

  if (!recommendation) {
    return (
      <div className="flex flex-col h-full">
        <div className="panel-header">DECISIONE OPERATIVA</div>
        <div className="flex-1 flex items-center justify-center">
          <span className="font-mono text-xxs text-text-muted">
            {candles.length === 0 ? 'Caricamento dati…' : 'Dati insufficienti'}
          </span>
        </div>
      </div>
    )
  }

  const { direction, confidence, combined, techScore, fundScore, histScore, crossScore, histInfo, crossAsset, blockers, reasons } = recommendation
  const style = DIRECTION_STYLE[direction]
  const price = livePrice ?? candles[candles.length - 1]?.close

  const handleSave = () => {
    if (!price || direction === 'FLAT') return
    const id = logDecision({
      symbol:    activeInstrument,
      timeframe: activeTimeframe,
      direction,
      confidence,
      combined,
      techScore, fundScore, histScore, crossScore,
      price,
      reasons,
      blockers,
      context: {
        events: events.slice(0, 5).map(e => ({ title: e.title, currency: e.currency, date: e.date, impact: e.impact })),
        marketContext,
      },
    })
    setSavedId(id)
    setTimeout(() => setSavedId(null), 3000)
    toast.success(
      `${direction} su ${activeInstrument} (confidenza ${confidence}%) registrato. Verrà chiuso automaticamente al raggiungimento di SL/TP.`,
      { title: '💾 Decisione salvata nel diario' }
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="panel-header">DECISIONE OPERATIVA — {activeInstrument}</div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

        {/* Decisione principale */}
        <div className="rounded-lg p-4 border-2"
             style={{ backgroundColor: style.bg, borderColor: style.border }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">
                Raccomandazione
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-2xl font-mono font-bold" style={{ color: style.text }}>
                  {style.icon}
                </span>
                <span className="font-mono text-2xl font-bold tracking-wider"
                      style={{ color: style.text }}>
                  {style.label}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">
                Confidenza
              </div>
              <div className="font-mono text-3xl font-bold tabular-nums" style={{ color: style.text }}>
                {confidence}%
              </div>
            </div>
          </div>

          {/* Confidence bar */}
          <div className="h-2 bg-bg-primary rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
                 style={{
                   width: `${confidence}%`,
                   backgroundColor: style.text,
                 }} />
          </div>

          {blockers.length === 0 && (
            <div className="flex items-center justify-between mt-3 font-mono text-xxs text-text-muted">
              <span>Score combinato: <span className="text-text-primary tabular-nums">{combined}</span></span>
              <span>
                T <span className="text-text-primary tabular-nums">{techScore}</span> ·
                F <span className="text-text-primary tabular-nums ml-1">{fundScore}</span> ·
                S <span className="text-text-primary tabular-nums ml-1">{histScore}</span> ·
                X <span className="text-text-primary tabular-nums ml-1">{crossScore}</span>
              </span>
            </div>
          )}

          {/* Save decision button */}
          {direction !== 'FLAT' && blockers.length === 0 && (
            <button
              onClick={handleSave}
              className="w-full mt-3 px-3 py-2 rounded-md font-mono text-xs font-medium border transition-all"
              style={{
                backgroundColor: savedId ? '#00e09618' : style.bg,
                borderColor:     savedId ? '#00e09660' : style.border,
                color:           savedId ? '#00e096'   : style.text,
              }}
            >
              {savedId ? '✓ DECISIONE REGISTRATA NEL DIARIO' : '💾 SALVA DECISIONE'}
            </button>
          )}
        </div>

        {/* Blockers */}
        {blockers.length > 0 && (
          <div className="bg-red/10 border border-red/30 rounded-lg p-3">
            <div className="font-mono text-xxs uppercase tracking-wider text-red mb-2 font-semibold">
              ⚠ Motivi per stare fermi
            </div>
            <div className="space-y-1.5">
              {blockers.map((b, i) => (
                <div key={i}>
                  <div className="font-mono text-xs text-text-primary">{b.label}</div>
                  <div className="font-mono text-xxs text-text-muted">{b.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Score breakdown */}
        <div>
          <div className="font-mono text-xxs uppercase tracking-wider text-text-muted mb-2">
            COMPONENTI DEL VERDETTO
          </div>

          <ScoreRow label="Analisi Tecnica" weight="45%" score={techScore} />
          <ScoreRow label="Analisi Fondamentale" weight="30%" score={fundScore} />
          <ScoreRow label="Storico (Backtest)" weight="15%" score={histScore}
                    sub={histInfo ? `${(histInfo.winRate*100).toFixed(0)}% win • ${histInfo.sample} trade` : 'campione insufficiente'} />
          <ScoreRow label="Cross-Asset" weight="10%" score={crossScore}
                    sub={crossAsset ? `${crossAsset.confirms}/${crossAsset.total} asset confermano` : 'no correlazioni forti'} />
        </div>

        {/* Reasons */}
        {reasons.length > 0 && (
          <div>
            <div className="font-mono text-xxs uppercase tracking-wider text-text-muted mb-2">
              FATTORI VALUTATI
            </div>
            <div className="space-y-1.5">
              {reasons.map((r, i) => (
                <ReasonItem key={i} reason={r} />
              ))}
            </div>
          </div>
        )}

        {recommendation.nextEvent && (
          <div className="bg-bg-secondary rounded-lg p-3 border border-bg-border">
            <div className="font-mono text-xxs uppercase tracking-wider text-text-muted mb-1">
              PROSSIMO EVENTO RILEVANTE
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-sm text-text-primary">
                  {recommendation.nextEvent.title}
                </div>
                <div className="font-mono text-xxs text-text-muted">
                  {recommendation.nextEvent.currency} · {recommendation.nextEvent.impact}
                </div>
              </div>
              <div className="font-mono text-xs text-gold tabular-nums">
                {recommendation.nextEvent.date.toLocaleString('it-IT', {
                  weekday: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ScoreRow({ label, weight, score, sub }) {
  const positive = score > 0
  const color = score > 25 ? '#00e096' : score < -25 ? '#ff3355' : '#f5c842'
  const pct = Math.min(100, Math.abs(score))

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="font-mono text-xs text-text-primary">{label}</span>
          <span className="font-mono text-xxs text-text-muted ml-2">peso {weight}</span>
          {sub && <div className="font-mono text-xxs text-text-muted mt-0.5">{sub}</div>}
        </div>
        <span className="font-mono text-xs tabular-nums font-semibold" style={{ color }}>
          {score > 0 ? '+' : ''}{score}
        </span>
      </div>
      <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden flex">
        {!positive && score < 0 && (
          <div className="h-full ml-auto rounded-l-full" style={{ width: `${pct/2}%`, backgroundColor: color }} />
        )}
        {positive && (
          <div className="h-full ml-1/2 rounded-r-full" style={{ width: `${pct/2}%`, marginLeft: '50%', backgroundColor: color }} />
        )}
      </div>
    </div>
  )
}

function ReasonItem({ reason }) {
  const score = reason.score ?? 0
  const color = score > 5 ? '#00e096' : score < -5 ? '#ff3355' : '#8892a4'
  const icon  = score > 5 ? '▲' : score < -5 ? '▼' : '·'
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 bg-bg-secondary rounded">
      <span className="font-mono text-sm font-bold mt-0.5" style={{ color }}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-text-primary">{reason.label}</div>
        {reason.detail && <div className="font-mono text-xxs text-text-muted">{reason.detail}</div>}
      </div>
      {Math.abs(score) > 0.5 && (
        <span className="font-mono text-xxs tabular-nums shrink-0" style={{ color }}>
          {score > 0 ? '+' : ''}{Math.round(score)}
        </span>
      )}
    </div>
  )
}
