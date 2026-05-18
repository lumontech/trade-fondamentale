import { useAppStore } from '../store/store'

function MacroChip({ label, data, format = 'pct', tooltip }) {
  if (!data || data.value == null) {
    return (
      <div className="flex items-center gap-1.5 shrink-0" title={tooltip || `${label}: dato non disponibile`}>
        <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">{label}</span>
        <span className="font-mono text-xxs text-text-muted">—</span>
      </div>
    )
  }
  const change = data.changePct ?? 0
  const dir = change > 0.01 ? 'up' : change < -0.01 ? 'down' : 'flat'
  const dirColor = dir === 'up' ? '#00e096' : dir === 'down' ? '#ff3355' : '#8892a4'
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'
  const fmt = (v) => format === 'pct' ? `${v.toFixed(2)}%` : v.toFixed(2)

  const tip = tooltip || `${label}: ${fmt(data.value)}${change ? ` • Δ ${change > 0 ? '+' : ''}${change.toFixed(1)}% vs prev` : ''}`

  return (
    <div className="flex items-center gap-1.5 shrink-0" title={tip}>
      <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">{label}</span>
      <span className="font-mono text-xs tabular-nums text-text-primary font-semibold">
        {fmt(data.value)}
      </span>
      {dir !== 'flat' && (
        <span className="font-mono text-xxs tabular-nums" style={{ color: dirColor }}>
          {arrow}{Math.abs(change).toFixed(1)}%
        </span>
      )}
    </div>
  )
}

export default function MacroBar() {
  const ctx = useAppStore(s => s.marketContext)
  const apiKeys = useAppStore(s => s.apiKeys)
  const fg = ctx.fearGreed

  const fgColor = fg
    ? (fg.value < 25 ? '#ff3355' : fg.value < 45 ? '#ff7a8d' :
       fg.value < 55 ? '#f5c842' : fg.value < 75 ? '#7be0a3' : '#00e096')
    : '#8892a4'

  const hasFREDKey = !!apiKeys.fred
  const hasAnyData = ctx.us10y || fg || ctx.btcDominance != null

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 bg-bg-secondary border-b border-bg-border overflow-x-auto">
      <span className="font-mono text-xxs text-gold uppercase tracking-widest mr-1 shrink-0">
        MACRO
      </span>

      <MacroChip label="US 10Y"  data={ctx.us10y} tooltip="Treasury Yield 10 anni — Yield in salita = USD forte" />
      <span className="text-bg-border shrink-0">·</span>
      <MacroChip label="US 2Y"   data={ctx.us2y} tooltip="Treasury Yield 2 anni — Sensibile alle decisioni Fed" />
      <span className="text-bg-border shrink-0">·</span>
      <MacroChip label="10Y-2Y"  data={ctx.spread10y2y} tooltip="Spread curva yields — Negativo = curva invertita = segnale recessione" />
      <span className="text-bg-border shrink-0">·</span>
      <MacroChip label="VIX"     data={ctx.vix} format="idx" tooltip="Volatility Index S&P 500 — >20 = mercato nervoso, <14 = complacency" />
      <span className="text-bg-border shrink-0">·</span>
      <MacroChip label="DXY*"    data={ctx.dxy} format="idx" tooltip="USD Trade-Weighted Index (FRED, broad index)" />

      {fg && (
        <>
          <span className="text-bg-border shrink-0">·</span>
          <div className="flex items-center gap-1.5 shrink-0" title={`Fear & Greed Index — ${fg.label}: ${fg.value}/100`}>
            <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">F&G</span>
            <span className="font-mono text-xs font-semibold tabular-nums" style={{ color: fgColor }}>
              {fg.value}
            </span>
            <span className="font-mono text-xxs" style={{ color: fgColor }}>{fg.label}</span>
          </div>
        </>
      )}

      {ctx.btcDominance != null && (
        <>
          <span className="text-bg-border shrink-0">·</span>
          <div className="flex items-center gap-1.5 shrink-0" title="BTC Dominance — % del totale market cap crypto">
            <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">BTC.D</span>
            <span className="font-mono text-xs tabular-nums text-text-primary font-semibold">
              {ctx.btcDominance.toFixed(2)}%
            </span>
          </div>
        </>
      )}

      {!hasFREDKey && (
        <span className="font-mono text-xxs text-text-muted ml-auto pr-1 shrink-0">
          ⚙ Aggiungi key FRED in API Hub per yields/VIX
        </span>
      )}
      {hasFREDKey && !hasAnyData && (
        <span className="font-mono text-xxs text-text-muted ml-auto pr-1 shrink-0 animate-[pulse-soft_1.6s_ease-in-out_infinite]">
          Caricamento dati macro…
        </span>
      )}
    </div>
  )
}
