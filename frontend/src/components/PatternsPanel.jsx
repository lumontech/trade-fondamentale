import { useMemo, useState } from 'react'
import { useAppStore } from '../store/store'
import { detectAllPatterns } from '../services/PatternsEngine'
import { formatPrice } from '../utils/format'
import PatternIllustration from './PatternIllustration'

const BIAS_STYLE = {
  bullish: { bg: '#00e09618', border: '#00e09660', text: '#00e096', icon: '▲', label: 'BULLISH' },
  bearish: { bg: '#ff335518', border: '#ff335560', text: '#ff3355', icon: '▼', label: 'BEARISH' },
  neutral: { bg: '#f5c84218', border: '#f5c84260', text: '#f5c842', icon: '■', label: 'NEUTRAL' },
}

const RELIABILITY_DOT = {
  high:   { color: '#00e096', label: 'Alta' },
  medium: { color: '#f5c842', label: 'Media' },
  low:    { color: '#8892a4', label: 'Bassa' },
}

const TYPE_LABEL = {
  candlestick: 'CANDLESTICK',
  chart:       'CHART',
  harmonic:    'ARMONICO',
}

const TYPE_ICON = {
  candlestick: '🕯',
  chart:       '📐',
  harmonic:    '◊',
}

const FILTERS = ['ALL', 'candlestick', 'chart', 'harmonic']

export default function PatternsPanel() {
  const setPanel         = useAppStore(s => s.setActivePanel)
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])
  const [filter, setFilter] = useState('ALL')

  const patterns = useMemo(() => detectAllPatterns(candles), [candles])
  const filtered = useMemo(() =>
    filter === 'ALL' ? patterns : patterns.filter(p => p.type === filter)
  , [patterns, filter])

  const fmt = (v) => formatPrice(activeInstrument, v)

  // Stats per categoria
  const stats = useMemo(() => ({
    candlestick: patterns.filter(p => p.type === 'candlestick').length,
    chart:       patterns.filter(p => p.type === 'chart').length,
    harmonic:    patterns.filter(p => p.type === 'harmonic').length,
    bullish:     patterns.filter(p => p.bias === 'bullish').length,
    bearish:     patterns.filter(p => p.bias === 'bearish').length,
  }), [patterns])

  const dominantBias = stats.bullish > stats.bearish ? 'bullish'
                     : stats.bearish > stats.bullish ? 'bearish' : 'neutral'
  const dominantStyle = BIAS_STYLE[dominantBias]

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            🎯 PATTERN RECOGNITION — {activeInstrument} · {activeTimeframe}
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            Candlestick + Chart classici + Pattern Armonici (Gartley, Bat, Cypher, Butterfly, Crab)
          </p>
        </div>
        <button onClick={() => setPanel('chart')}
                className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border">
          ✕ Chiudi
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Riepilogo */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-5">
          <div className="bg-bg-secondary rounded-xl border-2 px-4 py-3"
               style={{ borderColor: dominantStyle.border }}>
            <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Bias dominante</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-mono font-bold" style={{ color: dominantStyle.text }}>{dominantStyle.icon}</span>
              <span className="font-mono text-base font-bold" style={{ color: dominantStyle.text }}>{dominantStyle.label}</span>
            </div>
          </div>
          <Stat label="Pattern totali" value={patterns.length} />
          <Stat label="Bullish" value={stats.bullish} color="#00e096" />
          <Stat label="Bearish" value={stats.bearish} color="#ff3355" />
          <Stat label="Armonici" value={stats.harmonic} color="#f5c842" />
        </div>

        {/* Filtri */}
        <div className="flex items-center gap-2 mb-4">
          <span className="font-mono text-xs text-text-muted uppercase">Filtra:</span>
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-md font-mono text-xs border transition-all ${
                filter === f
                  ? 'bg-gold/20 text-gold border-gold/50'
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'}`}>
              {f === 'ALL' ? `Tutti (${patterns.length})`
                : `${TYPE_ICON[f]} ${TYPE_LABEL[f]} (${stats[f]})`}
            </button>
          ))}
        </div>

        {/* Lista pattern */}
        {patterns.length === 0 ? (
          <div className="text-center py-20">
            <span className="font-mono text-base text-text-muted">
              {candles.length < 30 ? '⏳ Caricamento candele...' : 'Nessun pattern detectato in questo timeframe.'}
            </span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 font-mono text-sm text-text-muted">
            Nessun pattern di questo tipo.
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((p, i) => (
              <PatternCard key={i} pattern={p} fmt={fmt} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PatternCard({ pattern: p, fmt }) {
  const style = BIAS_STYLE[p.bias] || BIAS_STYLE.neutral
  const reliability = RELIABILITY_DOT[p.reliability] || RELIABILITY_DOT.medium
  const date = p.time ? new Date(p.time * 1000).toLocaleString('it-IT', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  }) : '—'

  return (
    <div className="bg-bg-secondary rounded-xl border-l-4 border-y border-r border-bg-border px-5 py-4 hover:border-gold/30 transition-colors"
         style={{ borderLeftColor: style.text }}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-2xl leading-none">{TYPE_ICON[p.type]}</span>
          {/* Pattern illustration thumbnail */}
          <div className="w-24 h-14 shrink-0">
            <PatternIllustration name={p.name} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-semibold text-text-primary">{p.italian || p.name}</span>
              <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">{TYPE_LABEL[p.type]}</span>
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="flex items-center gap-1.5 font-mono text-xxs" style={{ color: reliability.color }}>
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: reliability.color }} />
                Affidabilità {reliability.label}
              </span>
              <span className="font-mono text-xxs text-text-muted">·</span>
              <span className="font-mono text-xxs text-text-muted">{date}</span>
            </div>
          </div>
        </div>
        <div className="px-3 py-1 rounded-md font-mono text-xs font-bold"
             style={{ backgroundColor: style.bg, color: style.text, border: `1px solid ${style.border}` }}>
          {style.icon} {style.label}
        </div>
      </div>

      {p.description && (
        <p className="font-sans text-sm text-text-secondary leading-relaxed mt-2">{p.description}</p>
      )}

      {/* Chart pattern: livelli */}
      {p.type === 'chart' && (p.neckline || p.target) && (
        <div className="grid grid-cols-3 gap-2 mt-3">
          {p.level && <Mini label="Livello" value={fmt(p.level)} color="#f5c842" />}
          {p.neckline && <Mini label="Neckline" value={fmt(p.neckline)} color={style.text} />}
          {p.target && <Mini label="Target proiettato" value={fmt(p.target)} color={style.text} />}
          {p.confirmed != null && (
            <div className="col-span-3">
              <span className={`font-mono text-xs ${p.confirmed ? 'text-green' : 'text-text-muted'}`}>
                {p.confirmed ? '✓ Conferma su rottura neckline' : '⏳ In attesa di conferma'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Harmonic pattern: PRZ + ratios + setup */}
      {p.type === 'harmonic' && (
        <>
          <div className="grid grid-cols-4 gap-2 mt-3">
            <Mini label="PRZ (Entry)" value={fmt(p.prz)} color="#f5c842" />
            <Mini label="Stop Loss" value={fmt(p.sl)} color="#ff3355" />
            <Mini label="TP 1" value={fmt(p.tp1)} color="#00e096" />
            <Mini label="TP 2" value={fmt(p.tp2)} color="#00b377" />
          </div>
          <div className="mt-3 px-3 py-2 bg-bg-primary rounded-md">
            <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1">Ratios Fibonacci verificati</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 font-mono text-xxs">
              <span>AB/XA: <span className="text-gold">{p.ratios.AB_XA}</span></span>
              <span>BC/AB: <span className="text-gold">{p.ratios.BC_AB}</span></span>
              {p.ratios.CD_BC != null && <span>CD/BC: <span className="text-gold">{p.ratios.CD_BC}</span></span>}
              {p.ratios.AD_XA != null && <span>AD/XA: <span className="text-gold">{p.ratios.AD_XA}</span></span>}
              {p.ratios.AD_XC != null && <span>AD/XC: <span className="text-gold">{p.ratios.AD_XC}</span></span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, color = '#e5e7eb' }) {
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border px-4 py-3">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-2xl font-bold tabular-nums mt-0.5" style={{ color }}>{value}</div>
    </div>
  )
}

function Mini({ label, value, color = '#e5e7eb' }) {
  return (
    <div>
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-sm tabular-nums font-semibold mt-0.5" style={{ color }}>{value}</div>
    </div>
  )
}
