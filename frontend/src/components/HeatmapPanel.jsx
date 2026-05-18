import { useMemo, useEffect, useState, useRef } from 'react'
import { useAppStore } from '../store/store'
import { calculateCurrencyStrength } from '../services/CurrencyStrength'
import { calculateVolumeProfile } from '../services/VolumeProfile'
import { calculateLiquidityHeatmap } from '../services/LiquidityHeatmap'
import { loadCandles, loadMultiTFCandles } from '../services/DataHub'
import { calculateRSI, calculateATR } from '../utils/indicators'
import { formatPrice } from '../utils/format'

// Lista asset da caricare al mount del pannello per popolare currency strength
// e multi-asset overview. Senza questo, il pannello vede solo l'asset attivo
// e currency strength è inutile (1 pair = solo BTCUSD invertito).
const HEATMAP_UNIVERSE = [
  'BTCUSD', 'XAUUSD',
  'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY',
  'US500', 'NAS100', 'USOIL', 'DXY',
]

export default function HeatmapPanel() {
  const setPanel         = useAppStore(s => s.setActivePanel)
  const instruments      = useAppStore(s => s.instruments)
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])

  const strength = useMemo(() => calculateCurrencyStrength(instruments, 24), [instruments])
  const vp       = useMemo(() => calculateVolumeProfile(candles, 100, 30), [candles])
  const liq      = useMemo(() => calculateLiquidityHeatmap(candles, 100), [candles])

  // Auto-load di tutti gli asset nell'universo all'apertura del pannello.
  // Senza questo, currency strength è cieco e multi-asset overview vuoto.
  // Usa ref per non spammare reload se l'utente apre/chiude più volte.
  const autoLoadedRef = useRef(false)
  const [loadingUniverse, setLoadingUniverse] = useState(false)
  useEffect(() => {
    if (autoLoadedRef.current) return
    autoLoadedRef.current = true
    setLoadingUniverse(true)
    const tasks = HEATMAP_UNIVERSE.map(async sym => {
      const inst = useAppStore.getState().instruments[sym]
      const hasData = (inst?.candles?.length || 0) >= 30
      if (hasData) return
      try {
        await loadCandles(sym, '1h')
        loadMultiTFCandles(sym).catch(() => {})  // background, no await
      } catch (e) {
        console.warn(`[HeatmapPanel] load ${sym}:`, e.message)
      }
    })
    Promise.allSettled(tasks).finally(() => setLoadingUniverse(false))
  }, [])

  // Multi-asset overview: per ogni asset disponibile, calcola % 24h + RSI + ATR%
  const multiAssetRows = useMemo(() => {
    const rows = []
    for (const sym of HEATMAP_UNIVERSE) {
      const inst = instruments[sym]
      const cdl  = inst?.candles
      if (!cdl || cdl.length < 30) {
        rows.push({ symbol: sym, missing: true })
        continue
      }
      const slice = cdl.slice(-100)
      const last  = slice[slice.length - 1]
      const ref24 = slice[Math.max(0, slice.length - 24)]
      const pct24 = ref24?.close ? ((last.close - ref24.close) / ref24.close) * 100 : null

      // RSI(14) — calculateRSI ritorna {value, signal, color}
      let rsi = null
      try {
        const r = calculateRSI(slice, 14)
        if (r && typeof r.value === 'number') rsi = r.value
      } catch {}

      // ATR(14) come % del prezzo — calculateATR ritorna numero singolo
      let atrPct = null
      try {
        const v = calculateATR(slice, 14)
        if (typeof v === 'number' && last?.close) atrPct = (v / last.close) * 100
      } catch {}

      // Regime semplice: ATR% > 1.5 = volatile, < 0.4 = squeeze, altrimenti normal
      let regime = '—'
      if (atrPct != null) {
        regime = atrPct > 1.5 ? 'volatile' : atrPct < 0.4 ? 'squeeze' : 'normal'
      }

      rows.push({
        symbol: sym, missing: false,
        price: last.close, pct24, rsi, atrPct, regime,
      })
    }
    return rows
  }, [instruments])

  // Live update indicator — pulsa ad ogni cambio store
  const [updateCount, setUpdateCount] = useState(0)
  const [lastUpdate, setLastUpdate]   = useState(new Date())
  const [pulse, setPulse]             = useState(false)
  const lastInstRef = useRef(instruments)

  useEffect(() => {
    if (lastInstRef.current !== instruments) {
      lastInstRef.current = instruments
      setUpdateCount(c => c + 1)
      setLastUpdate(new Date())
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 400)
      return () => clearTimeout(t)
    }
  }, [instruments])

  // Tick live count ogni 30s anche senza nuovo store update (heartbeat UI)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const secondsAgo = Math.floor((Date.now() - lastUpdate.getTime()) / 1000)
  const isStale = secondsAgo > 30

  const fmt = (v) => v != null ? formatPrice(activeInstrument, v) : '—'

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            🔥 HEATMAP &amp; VOLUMI
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            Currency Strength · Volume Profile · Liquidity Zones · {activeInstrument} {activeTimeframe}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* LIVE indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border"
               style={{
                 backgroundColor: isStale ? '#ff335518' : '#00e09618',
                 borderColor:     isStale ? '#ff335560' : '#00e09660',
               }}>
            <span className={`inline-block w-2 h-2 rounded-full ${pulse ? 'animate-ping' : ''}`}
                  style={{ backgroundColor: isStale ? '#ff3355' : '#00e096',
                           boxShadow: !isStale ? '0 0 8px #00e096cc' : 'none' }} />
            <span className="font-mono text-xs font-semibold tabular-nums"
                  style={{ color: isStale ? '#ff3355' : '#00e096' }}>
              {isStale ? `STALE • ${secondsAgo}s fa` : `LIVE • ${updateCount} update`}
            </span>
            <span className="font-mono text-xxs text-text-muted">
              ultimo: {lastUpdate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* ── Multi-Asset Overview Heatmap ────────────────────── */}
        <Section title="🌡 MULTI-ASSET OVERVIEW"
                 subtitle={`Performance 24h · RSI · ATR · Regime · ${HEATMAP_UNIVERSE.length} asset${loadingUniverse ? ' · caricamento in corso...' : ''}`}>
          <MultiAssetOverview rows={multiAssetRows} />
        </Section>

        {/* ── Currency Strength Heatmap ──────────────────────── */}
        <Section title="💪 CURRENCY STRENGTH (24 candele)" subtitle="Forza relativa di ogni valuta calcolata dal movimento di tutte le coppie disponibili">
          {strength.sorted.length === 0 ? (
            <Empty msg="Servono almeno 2 strumenti con candele caricate." />
          ) : (
            <>
              {/* Stats top: forte/debole */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                {strength.strongest && (
                  <div className="bg-green/10 border-2 border-green/40 rounded-xl px-4 py-3">
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Più forte</div>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <span className="font-mono text-2xl font-bold text-green">▲ {strength.strongest}</span>
                      <span className="font-mono text-sm text-green tabular-nums">+{strength.currencies[strength.strongest].strength}%</span>
                    </div>
                  </div>
                )}
                {strength.weakest && (
                  <div className="bg-red/10 border-2 border-red/40 rounded-xl px-4 py-3">
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Più debole</div>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <span className="font-mono text-2xl font-bold text-red">▼ {strength.weakest}</span>
                      <span className="font-mono text-sm text-red tabular-nums">{strength.currencies[strength.weakest].strength}%</span>
                    </div>
                  </div>
                )}
                <div className="bg-bg-secondary border border-bg-border rounded-xl px-4 py-3">
                  <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Trade idea</div>
                  {strength.strongest && strength.weakest ? (
                    <div className="font-mono text-base font-semibold text-gold mt-1">
                      LONG {strength.strongest}/{strength.weakest}
                    </div>
                  ) : (
                    <div className="font-mono text-sm text-text-muted mt-1">—</div>
                  )}
                </div>
              </div>

              {/* Bar chart strength per valuta */}
              <div className="bg-bg-secondary rounded-xl border border-bg-border p-4 space-y-2">
                {strength.sorted.map(c => {
                  const isPos = c.strength > 0
                  const widthPct = Math.min(100, Math.abs(c.strength) * 20)
                  return (
                    <div key={c.currency} className="flex items-center gap-3">
                      <span className="font-mono text-sm font-bold text-gold w-12 shrink-0">{c.currency}</span>
                      <div className="flex-1 flex items-center justify-center relative h-6 bg-bg-primary rounded-md overflow-hidden">
                        <div className="absolute top-0 bottom-0 w-px bg-bg-border left-1/2" />
                        {isPos ? (
                          <div className="absolute top-0 bottom-0 left-1/2 rounded-r"
                               style={{ width: `${widthPct/2}%`, backgroundColor: '#00e09660' }} />
                        ) : (
                          <div className="absolute top-0 bottom-0 right-1/2 rounded-l"
                               style={{ width: `${widthPct/2}%`, backgroundColor: '#ff335560' }} />
                        )}
                        <span className="relative font-mono text-xs tabular-nums font-semibold"
                              style={{ color: isPos ? '#00e096' : '#ff3355' }}>
                          {isPos ? '+' : ''}{c.strength.toFixed(2)}%
                        </span>
                      </div>
                      <span className="font-mono text-xxs text-text-muted w-16 text-right">{c.count} pair</span>
                    </div>
                  )
                })}
              </div>

              {/* Performance table */}
              <div className="bg-bg-secondary rounded-xl border border-bg-border mt-4 overflow-hidden">
                <div className="px-4 py-2 border-b border-bg-border font-mono text-xs uppercase tracking-wider text-text-muted">
                  Performance per coppia (24 candele)
                </div>
                <table className="w-full font-mono text-sm">
                  <tbody>
                    {strength.performance.map(p => {
                      const isPos = p.pct > 0
                      return (
                        <tr key={p.symbol} className="border-b border-bg-border/40 last:border-0 hover:bg-bg-hover">
                          <td className="px-4 py-2 font-semibold text-gold">{p.symbol}</td>
                          <td className="px-4 py-2 text-right tabular-nums" style={{ color: isPos ? '#00e096' : '#ff3355' }}>
                            {isPos ? '+' : ''}{p.pct.toFixed(2)}%
                          </td>
                          <td className="px-4 py-2 w-1/2">
                            <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden flex">
                              {!isPos && p.pct < 0 && (
                                <div className="h-full ml-auto rounded-l-full"
                                     style={{ width: `${Math.min(100, Math.abs(p.pct) * 20)/2}%`, backgroundColor: '#ff335580' }} />
                              )}
                              {isPos && (
                                <div className="h-full rounded-r-full"
                                     style={{ width: `${Math.min(100, p.pct * 20)/2}%`, marginLeft: '50%', backgroundColor: '#00e09680' }} />
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>

        {/* ── Volume Profile ──────────────────────────────────── */}
        <Section title={`📊 VOLUME PROFILE — ${activeInstrument}`}
                 subtitle="Distribuzione volume per livello di prezzo. POC = livello più tradato (magnete). Value Area = 70% volume (zona equilibrio).">
          {!vp ? (
            <Empty msg="Servono almeno 20 candele con volume." />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

              {/* Chart bar orizzontale */}
              <div className="lg:col-span-2 bg-bg-secondary rounded-xl border border-bg-border p-4">
                <div className="font-mono text-xs uppercase tracking-wider text-text-muted mb-2">
                  Distribuzione volume (max → min in alto)
                </div>
                <div className="space-y-0.5">
                  {[...vp.profile].sort((a, b) => b.price - a.price).map((b, i) => {
                    const maxVol = Math.max(...vp.profile.map(p => p.volume))
                    const widthPct = (b.volume / maxVol) * 100
                    const isPOC = Math.abs(b.price - vp.poc) < vp.binSize
                    const inVA = b.inValueArea
                    return (
                      <div key={i} className="flex items-center gap-2 group">
                        <span className="font-mono text-xxs text-text-muted tabular-nums w-20 text-right shrink-0">
                          {fmt(b.price)}
                        </span>
                        <div className="flex-1 relative h-3 bg-bg-primary rounded-sm overflow-hidden">
                          <div className="absolute top-0 bottom-0 left-0 rounded-sm transition-all"
                               style={{
                                 width: `${widthPct}%`,
                                 backgroundColor: isPOC ? '#f5c842' : inVA ? '#00e09660' : '#3a425880',
                               }} />
                          {isPOC && (
                            <span className="absolute right-1 top-0 bottom-0 flex items-center font-mono text-xxs font-bold text-bg-primary">POC</span>
                          )}
                        </div>
                        <span className="font-mono text-xxs text-text-muted tabular-nums w-12 shrink-0">
                          {b.pct.toFixed(1)}%
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Stats Volume Profile */}
              <div className="space-y-3">
                <div className="bg-gold/10 border-2 border-gold/40 rounded-xl px-4 py-3">
                  <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">POC — Point of Control</div>
                  <div className="font-mono text-2xl font-bold tabular-nums text-gold mt-1">{fmt(vp.poc)}</div>
                  <div className="font-mono text-xxs text-text-secondary">Livello più tradato — magnete del prezzo</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-bg-secondary border border-green/30 rounded-md px-3 py-2">
                    <div className="font-mono text-xxs text-text-muted">VAH</div>
                    <div className="font-mono text-base font-semibold tabular-nums text-green">{fmt(vp.vah)}</div>
                  </div>
                  <div className="bg-bg-secondary border border-red/30 rounded-md px-3 py-2">
                    <div className="font-mono text-xxs text-text-muted">VAL</div>
                    <div className="font-mono text-base font-semibold tabular-nums text-red">{fmt(vp.val)}</div>
                  </div>
                </div>
                <div className="bg-bg-secondary border border-bg-border rounded-xl p-3">
                  <div className="font-mono text-xs text-gold uppercase tracking-wider mb-2">High Volume Nodes (HVN)</div>
                  {vp.hvn.map((n, i) => (
                    <div key={i} className="flex justify-between font-mono text-xs mb-1">
                      <span className="text-text-primary tabular-nums">{fmt(n.price)}</span>
                      <span className="text-gold tabular-nums">{n.pct}%</span>
                    </div>
                  ))}
                </div>
                <div className="bg-bg-secondary border border-bg-border rounded-xl p-3">
                  <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">Low Volume Nodes (LVN)</div>
                  {vp.lvn.map((n, i) => (
                    <div key={i} className="flex justify-between font-mono text-xs mb-1">
                      <span className="text-text-secondary tabular-nums">{fmt(n.price)}</span>
                      <span className="text-text-muted tabular-nums">{n.pct}%</span>
                    </div>
                  ))}
                  <div className="font-mono text-xxs text-text-muted mt-1 italic">
                    LVN = zone "veloci": prezzo le attraversa rapidamente
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* ── Liquidity Heatmap ───────────────────────────────── */}
        <Section title={`💧 LIQUIDITY ZONES — ${activeInstrument}`}
                 subtitle="Equal highs/lows = stop dei retail. Le banche/fondi tendono a 'colpirli' prima di invertire.">
          {!liq ? (
            <Empty msg="Servono almeno 30 candele." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* BSL — Buy Side Liquidity */}
              <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
                <div className="px-4 py-2 border-b border-bg-border bg-green/5 flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold text-green">▲ BSL — Sopra il prezzo</span>
                  <span className="font-mono text-xxs text-text-muted">Stop dei SHORT</span>
                </div>
                {liq.bsl_above.length === 0 ? (
                  <div className="p-4 text-center font-mono text-xs text-text-muted">
                    Nessun equal-high recente sopra il prezzo
                  </div>
                ) : (
                  <table className="w-full font-mono text-sm">
                    <thead>
                      <tr className="text-text-muted">
                        <th className="text-left  px-3 py-1 text-xxs">Livello</th>
                        <th className="text-right px-3 py-1 text-xxs">Distanza</th>
                        <th className="text-right px-3 py-1 text-xxs">Touches</th>
                        <th className="text-right px-3 py-1 text-xxs">Età (bar)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liq.bsl_above.map((z, i) => (
                        <tr key={i} className={`border-t border-bg-border/40 ${liq.target_up === z ? 'bg-gold/10' : ''}`}>
                          <td className="px-3 py-1.5 tabular-nums text-text-primary font-semibold">{fmt(z.price)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-secondary">+{z.distance_pct}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-green">{z.touches}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">{z.age_bars}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {liq.target_up && (
                  <div className="px-4 py-2 bg-gold/5 border-t border-gold/20">
                    <span className="font-mono text-xxs text-gold uppercase tracking-wider">⚡ Target più probabile: </span>
                    <span className="font-mono text-sm font-semibold text-gold tabular-nums">{fmt(liq.target_up.price)}</span>
                  </div>
                )}
              </div>

              {/* SSL — Sell Side Liquidity */}
              <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
                <div className="px-4 py-2 border-b border-bg-border bg-red/5 flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold text-red">▼ SSL — Sotto il prezzo</span>
                  <span className="font-mono text-xxs text-text-muted">Stop dei LONG</span>
                </div>
                {liq.ssl_below.length === 0 ? (
                  <div className="p-4 text-center font-mono text-xs text-text-muted">
                    Nessun equal-low recente sotto il prezzo
                  </div>
                ) : (
                  <table className="w-full font-mono text-sm">
                    <thead>
                      <tr className="text-text-muted">
                        <th className="text-left  px-3 py-1 text-xxs">Livello</th>
                        <th className="text-right px-3 py-1 text-xxs">Distanza</th>
                        <th className="text-right px-3 py-1 text-xxs">Touches</th>
                        <th className="text-right px-3 py-1 text-xxs">Età (bar)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liq.ssl_below.map((z, i) => (
                        <tr key={i} className={`border-t border-bg-border/40 ${liq.target_down === z ? 'bg-gold/10' : ''}`}>
                          <td className="px-3 py-1.5 tabular-nums text-text-primary font-semibold">{fmt(z.price)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-secondary">{z.distance_pct}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-red">{z.touches}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">{z.age_bars}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {liq.target_down && (
                  <div className="px-4 py-2 bg-gold/5 border-t border-gold/20">
                    <span className="font-mono text-xxs text-gold uppercase tracking-wider">⚡ Target più probabile: </span>
                    <span className="font-mono text-sm font-semibold text-gold tabular-nums">{fmt(liq.target_down.price)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </Section>

      </div>
    </div>
  )
}

function Section({ title, subtitle, children }) {
  return (
    <div>
      <div className="mb-3">
        <div className="font-mono text-base font-semibold text-gold tracking-wider">{title}</div>
        {subtitle && <div className="font-mono text-xs text-text-muted mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }) {
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border p-8 text-center">
      <span className="font-mono text-sm text-text-muted">{msg}</span>
    </div>
  )
}

// ─── Multi-Asset Overview — heatmap colorata su tutti gli asset ────
function MultiAssetOverview({ rows }) {
  const setPanel        = useAppStore(s => s.setActivePanel)
  const setInstrument   = useAppStore(s => s.setActiveInstrument)
  const available = rows.filter(r => !r.missing)
  if (available.length === 0) {
    return <Empty msg="Caricamento candele degli asset in corso... Ricontrolla tra qualche secondo." />
  }

  // Helper colori: rosso → grigio → verde in base a pct24
  const pctColor = (p) => {
    if (p == null) return '#5a6478'
    if (p >= 2)  return '#00e096'
    if (p >= 0.5) return '#00e09680'
    if (p >= -0.5) return '#8892a4'
    if (p >= -2) return '#ff335580'
    return '#ff3355'
  }
  const rsiColor = (r) => {
    if (r == null) return '#5a6478'
    if (r >= 70) return '#ff3355'   // overbought
    if (r >= 55) return '#00e09680'
    if (r >= 45) return '#8892a4'
    if (r >= 30) return '#f5c842'
    return '#00e096'                // oversold = opportunity long
  }
  const regimeColor = (rg) => rg === 'volatile' ? '#ff9933'
                            : rg === 'squeeze' ? '#f5c842'
                            : rg === 'normal'  ? '#00e096' : '#5a6478'

  const handleClick = (sym) => { setInstrument(sym); setPanel('chart') }

  // Ordina per |pct24| decrescente (movers prima)
  const sorted = [...rows].sort((a, b) => {
    if (a.missing && !b.missing) return 1
    if (b.missing && !a.missing) return -1
    return Math.abs(b.pct24 ?? 0) - Math.abs(a.pct24 ?? 0)
  })

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-b border-bg-border bg-bg-primary/50">
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted">Asset</div>
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted text-right">Prezzo</div>
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted text-right">% 24h</div>
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted text-right">RSI(14)</div>
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted text-right">ATR %</div>
        <div className="col-span-2 font-mono text-xxs uppercase tracking-wider text-text-muted text-right">Regime</div>
      </div>
      <div>
        {sorted.map(r => (
          <div key={r.symbol}
               onClick={() => !r.missing && handleClick(r.symbol)}
               className={`grid grid-cols-12 gap-2 px-3 py-2 border-b border-bg-border/40 last:border-0 transition-colors ${
                 r.missing ? 'opacity-50' : 'cursor-pointer hover:bg-bg-primary/50'
               }`}>
            <div className="col-span-2 font-mono text-sm font-semibold text-text-primary">{r.symbol}</div>
            {r.missing ? (
              <div className="col-span-10 font-mono text-xxs text-text-muted italic">candele non caricate (skip)</div>
            ) : (
              <>
                <div className="col-span-2 font-mono text-sm tabular-nums text-text-primary text-right">
                  {r.price != null ? r.price.toFixed(r.price > 100 ? 2 : 5) : '—'}
                </div>
                <div className="col-span-2 font-mono text-sm tabular-nums font-bold text-right"
                     style={{ color: pctColor(r.pct24) }}>
                  {r.pct24 != null ? (r.pct24 >= 0 ? '+' : '') + r.pct24.toFixed(2) + '%' : '—'}
                </div>
                <div className="col-span-2 font-mono text-sm tabular-nums text-right"
                     style={{ color: rsiColor(r.rsi) }}>
                  {r.rsi != null ? r.rsi.toFixed(1) : '—'}
                </div>
                <div className="col-span-2 font-mono text-sm tabular-nums text-right text-text-secondary">
                  {r.atrPct != null ? r.atrPct.toFixed(2) + '%' : '—'}
                </div>
                <div className="col-span-2 text-right">
                  <span className="font-mono text-xxs px-1.5 py-0.5 rounded uppercase tracking-wider"
                        style={{ color: regimeColor(r.regime), backgroundColor: regimeColor(r.regime) + '22' }}>
                    {r.regime}
                  </span>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-bg-border bg-bg-primary/30 font-mono text-xxs text-text-muted">
        Clicca su un asset per aprirlo nel chart. Ordine: movers prima (|% 24h| decrescente).
        RSI: <span className="text-red">≥70 OB</span> · <span className="text-gold">30-45 caution</span> · <span className="text-green">≤30 OS</span>.
        Regime: <span className="text-orange-400">volatile</span> ATR&gt;1.5% · <span className="text-gold">squeeze</span> ATR&lt;0.4%.
      </div>
    </div>
  )
}
