import { useMemo, useState } from 'react'
import { useAppStore } from '../store/store'
import { calculateSignal, findLevels } from '../utils/indicators'
import { calculateDynamicSetup } from '../services/PositionSizer'
import { getBacktestStats } from '../services/BacktestEngine'
import { calculateCorrelationMatrix } from '../services/CorrelationEngine'
import { formatPrice } from '../utils/format'

function Row({ label, value, color, large, sub }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-bg-border/40 last:border-0">
      <div>
        <span className="font-mono text-xxs text-text-secondary">{label}</span>
        {sub && <div className="font-mono text-xxs text-text-muted">{sub}</div>}
      </div>
      <span className={`font-mono tabular-nums font-medium ${large ? 'text-sm' : 'text-xs'}`}
            style={color ? { color } : { color: '#e8eaf0' }}>
        {value}
      </span>
    </div>
  )
}

function RRBar({ rr }) {
  const pct = Math.min((rr / 4) * 100, 100)
  return (
    <div className="h-1.5 bg-bg-border rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all"
           style={{ width: `${pct}%`,
                    backgroundColor: rr >= 2 ? '#00e096' : rr >= 1.5 ? '#f5c842' : '#ff3355' }} />
    </div>
  )
}

export default function SetupPanel() {
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])
  const price            = useAppStore(s => s.instruments[activeInstrument]?.price)
  const instruments      = useAppStore(s => s.instruments)
  const [capital, setCapital] = useState(10000)
  const [riskPct, setRiskPct] = useState(1)

  const analysis = useMemo(() => {
    if (candles.length < 50) return null
    return calculateSignal(candles)
  }, [candles])

  const levels = useMemo(() => findLevels(candles), [candles])

  const setup = useMemo(() => {
    if (!analysis) return null
    const backtestStats = getBacktestStats(activeInstrument, activeTimeframe, candles)
    const stats = backtestStats?.byLabel?.[analysis.label]
    const { matrix } = calculateCorrelationMatrix(instruments, 100)

    return calculateDynamicSetup({
      symbol: activeInstrument,
      candles,
      technicalSignal: analysis,
      supportLevels: levels.supports,
      resistanceLevels: levels.resistances,
      price,
      capital,
      riskPct,
      backtestStats: stats || null,
      correlationMatrix: matrix,
    })
  }, [activeInstrument, activeTimeframe, candles, instruments, price, analysis, levels, capital, riskPct])

  const fmt = (v) => formatPrice(activeInstrument, v)

  if (!setup) {
    return (
      <div className="flex flex-col h-full">
        <div className="panel-header">SETUP OPERATIVO</div>
        <div className="flex-1 flex items-center justify-center">
          <span className="font-mono text-xxs text-text-muted">
            {candles.length === 0 ? 'Caricamento…' : 'Dati insufficienti'}
          </span>
        </div>
      </div>
    )
  }

  const isLong = setup.direction === 'LONG'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="panel-header">SETUP OPERATIVO</div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">

        {/* Direction badge */}
        <div className="flex items-center justify-center py-2 rounded font-mono text-sm font-bold tracking-widest"
             style={{
               backgroundColor: isLong ? '#00e09618' : '#ff335518',
               color:           isLong ? '#00e096'   : '#ff3355',
               border:          `1px solid ${isLong ? '#00e09640' : '#ff335540'}`,
             }}>
          {isLong ? '▲ LONG' : '▼ SHORT'} — {activeInstrument}
        </div>

        {/* Entry / SL / TP */}
        <div>
          <Row label="ENTRY" value={fmt(setup.entry)} color="#f5c842" large />
          <Row label={`STOP LOSS (${setup.pctSL.toFixed(2)}%)`} value={fmt(setup.sl)} color="#ff3355"
               sub={`Distanza: ${setup.risk.toFixed(5)} (1.5×ATR)`} />
          <Row label={`TP 1 (+${Math.abs(setup.pctTP1).toFixed(2)}%)`} value={fmt(setup.tp1)} color="#00e096" />
          <Row label={`TP 2 (+${Math.abs(setup.pctTP2).toFixed(2)}%)`} value={fmt(setup.tp2)} color="#00b377" />
        </div>

        {/* Risk/Reward */}
        <div>
          <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">RISK / REWARD</div>
          <div className="flex gap-2 mb-1.5">
            <div className="flex-1 bg-bg-secondary rounded p-2 text-center">
              <div className="font-mono text-xs font-bold text-green">1:{setup.rr1.toFixed(1)}</div>
              <div className="font-mono text-xxs text-text-muted">TP1</div>
            </div>
            <div className="flex-1 bg-bg-secondary rounded p-2 text-center">
              <div className="font-mono text-xs font-bold text-green/70">1:{setup.rr2.toFixed(1)}</div>
              <div className="font-mono text-xxs text-text-muted">TP2</div>
            </div>
          </div>
          <RRBar rr={setup.rr1} />
        </div>

        {/* Position Sizing Dinamico */}
        <div>
          <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">SIZING DINAMICO</div>

          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-xxs text-text-secondary w-16">Capitale $</span>
            <input type="number" value={capital} onChange={e => setCapital(Number(e.target.value))}
                   className="flex-1 bg-bg-secondary border border-bg-border rounded px-2 py-0.5 font-mono text-xs text-text-primary outline-none focus:border-gold/50" />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-xxs text-text-secondary w-16">Rischio %</span>
            <div className="flex gap-1">
              {[0.5, 1, 2].map(r => (
                <button key={r} onClick={() => setRiskPct(r)}
                        className={`px-2 py-0.5 rounded font-mono text-xxs transition-all
                          ${riskPct === r
                            ? 'bg-gold/20 text-gold border border-gold/40'
                            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-bg-border'}`}>
                  {r}%
                </button>
              ))}
            </div>
          </div>

          <Row label="Risk % effettivo"
               value={`${setup.sizing.effective_risk_pct.toFixed(2)}%`}
               color={setup.sizing.effective_risk_pct < setup.sizing.base_risk_pct ? '#f5c842' : '#00e096'}
               sub={setup.sizing.effective_risk_pct < setup.sizing.base_risk_pct ? 'Ridotto da Kelly/correlazione' : 'Pieno (no aggiustamenti)'} />

          {setup.sizing.kelly_fraction != null && (
            <Row label="Kelly fraction (1/4)"
                 value={`${(setup.sizing.kelly_fraction * 100).toFixed(2)}%`}
                 color={setup.sizing.kelly_fraction > 0 ? '#00e096' : '#ff3355'}
                 sub={setup.sizing.kelly_fraction > 0 ? 'Edge positivo storico' : 'Edge negativo: ridotto al minimo'} />
          )}

          {setup.sizing.correlation_adj < 1 && (
            <Row label="Correlation adj"
                 value={`×${setup.sizing.correlation_adj.toFixed(2)}`}
                 color="#f5c842"
                 sub="Hai trade aperti su asset correlati" />
          )}

          <Row label="Rischio ($)" value={`$${setup.sizing.risk_amount.toFixed(0)}`} color="#ff3355" />
          <Row label="Unità / Lotti"
               value={setup.sizing.units < 1
                 ? setup.sizing.units.toFixed(4) + ' u'
                 : setup.sizing.units.toFixed(2) + ' u'} />
        </div>

        {/* Stats */}
        <div>
          <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">QUALITÀ SETUP</div>
          {setup.backtest_winrate != null ? (
            <Row label="Win rate storico"
                 value={`${(setup.backtest_winrate * 100).toFixed(0)}%`}
                 color={setup.backtest_winrate >= 0.55 ? '#00e096' :
                        setup.backtest_winrate < 0.45  ? '#ff3355' : '#f5c842'}
                 sub="Da backtest reale su candele storiche" />
          ) : (
            <Row label="Win rate storico" value="—" sub="Campione insufficiente" />
          )}
          <Row label="ATR(14)" value={setup.atr.toFixed(5)} sub="Volatilità misurata" />
          <Row label="Forza segnale" value={`${Math.round(analysis.strength * 100)}%`} color={analysis.color} />
          <Row label="Score tecnico" value={analysis.score.toFixed(1)} />
        </div>

      </div>
    </div>
  )
}
