import { useMemo } from 'react'
import { useAppStore } from '../store/store'
import { calculateSignal, calcPivots, findLevels } from '../utils/indicators'
import { formatPrice } from '../utils/format'

function SignalBar({ bars }) {
  return (
    <div className="flex gap-0.5">
      {[1,2,3,4,5].map(i => (
        <div key={i} className={`h-3 w-4 rounded-sm ${i <= bars ? 'opacity-100' : 'opacity-15'} ${
          bars >= 4 ? 'bg-green' : bars === 3 ? 'bg-gold' : 'bg-red'
        }`} />
      ))}
    </div>
  )
}

function Row({ label, value, color, sub }) {
  return (
    <div className="indicator-row">
      <span className="indicator-label">{label}</span>
      <div className="text-right">
        <span className="indicator-value" style={color ? { color } : {}}>
          {value}
        </span>
        {sub && <div className="text-xxs font-mono text-text-muted">{sub}</div>}
      </div>
    </div>
  )
}

export default function TechnicalPanel() {
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])
  const price            = useAppStore(s => s.instruments[activeInstrument]?.price)

  const analysis = useMemo(() => {
    if (candles.length < 50) return null
    return calculateSignal(candles)
  }, [candles])

  const pivots = useMemo(() => calcPivots(candles), [candles])
  const levels = useMemo(() => findLevels(candles), [candles])

  const fmt = (v) => formatPrice(activeInstrument, v)
  const last = price ?? candles[candles.length - 1]?.close

  if (!analysis) {
    return (
      <div className="flex flex-col h-full">
        <div className="panel-header">ANALISI TECNICA</div>
        <div className="flex-1 flex items-center justify-center">
          <span className="font-mono text-xxs text-text-muted">
            {candles.length === 0 ? 'Caricamento dati…' : 'Dati insufficienti'}
          </span>
        </div>
      </div>
    )
  }

  const { ema, rsi, macd, bb } = analysis
  const trend = last && ema.v200
    ? (last > ema.v200 ? '▲ BULLISH' : '▼ BEARISH')
    : '—'
  const trendColor = last && ema.v200
    ? (last > ema.v200 ? '#00e096' : '#ff3355') : undefined

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="panel-header">ANALISI TECNICA — {activeInstrument}</div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">

        {/* Overall Signal */}
        <div className="bg-bg-secondary rounded p-2.5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-xxs text-text-secondary">SEGNALE COMPLESSIVO</span>
            <span
              className="font-mono text-xs font-bold tracking-wider"
              style={{ color: analysis.color }}
            >
              {analysis.label}
            </span>
          </div>
          <SignalBar bars={analysis.bars} />
        </div>

        {/* Trend */}
        <div>
          <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">TREND</div>
          <Row label="Trend EMA200" value={trend} color={trendColor} />
          <Row
            label="EMA 20/50"
            value={ema.v20 && ema.v50 ? (ema.v20 > ema.v50 ? '▲ BULLISH' : '▼ BEARISH') : '—'}
            color={ema.v20 && ema.v50 ? (ema.v20 > ema.v50 ? '#00e096' : '#ff3355') : undefined}
          />
          {ema.v20  && <Row label="EMA 20"  value={fmt(ema.v20)}  />}
          {ema.v50  && <Row label="EMA 50"  value={fmt(ema.v50)}  />}
          {ema.v200 && <Row label="EMA 200" value={fmt(ema.v200)} />}
        </div>

        {/* Oscillators */}
        {(rsi || macd) && (
          <div>
            <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">OSCILLATORI</div>
            {rsi && (
              <Row label="RSI (14)" value={rsi.value} sub={rsi.signal} color={rsi.color} />
            )}
            {macd && (
              <>
                <Row
                  label="MACD"
                  value={macd.trend}
                  sub={macd.momentum}
                  color={macd.color}
                />
                <Row label="Histogram" value={macd.histogram?.toFixed(4)} color={macd.color} />
              </>
            )}
          </div>
        )}

        {/* Bollinger Bands */}
        {bb && (
          <div>
            <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">BANDE DI BOLLINGER</div>
            <Row label="Upper"     value={fmt(bb.upper)}  />
            <Row label="Middle"    value={fmt(bb.middle)} />
            <Row label="Lower"     value={fmt(bb.lower)}  />
            <Row label="Posizione" value={bb.signal}      color={bb.color} />
            <Row label="Ampiezza"  value={bb.bandwidth?.toFixed(2) + '%'} />
          </div>
        )}

        {/* Support / Resistance */}
        {(levels.resistances.length > 0 || levels.supports.length > 0) && (
          <div>
            <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">
              SUPPORTI / RESISTENZE
            </div>
            {levels.resistances.slice().reverse().map((r, i) => (
              <Row key={`r${i}`} label={`R${levels.resistances.length - i}`} value={fmt(r)} color="#ff3355" />
            ))}
            {last && (
              <div className="indicator-row">
                <span className="indicator-label text-gold">── PREZZO ──</span>
                <span className="indicator-value text-gold">{fmt(last)}</span>
              </div>
            )}
            {levels.supports.map((s, i) => (
              <Row key={`s${i}`} label={`S${i + 1}`} value={fmt(s)} color="#00e096" />
            ))}
          </div>
        )}

        {/* Pivot Points */}
        {pivots && (
          <div>
            <div className="text-xxs font-mono text-text-muted tracking-wider mb-1">PIVOT POINTS</div>
            <Row label="R2" value={fmt(pivots.R2)} color="#ff335580" />
            <Row label="R1" value={fmt(pivots.R1)} color="#ff3355cc" />
            <Row label="P"  value={fmt(pivots.P)}  color="#f5c842" />
            <Row label="S1" value={fmt(pivots.S1)} color="#00e096cc" />
            <Row label="S2" value={fmt(pivots.S2)} color="#00e09680" />
          </div>
        )}

      </div>
    </div>
  )
}
