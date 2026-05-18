import { useEffect, useState } from 'react'
import { useAppStore } from '../store/store'
import { formatPrice } from '../utils/format'
import { getAllDecisions } from '../services/TradeLog'

const INSTRUMENTS = [
  { symbol: 'BTCUSD',  label: 'BTC/USD',  group: 'CRYPTO' },
  { symbol: 'XAUUSD',  label: 'XAU/USD',  group: 'COMMODITIES' },
  { symbol: 'USOIL',   label: 'OIL (USO)', group: 'COMMODITIES' },
  { symbol: 'EURUSD',  label: 'EUR/USD',  group: 'FOREX' },
  { symbol: 'GBPUSD',  label: 'GBP/USD',  group: 'FOREX' },
  { symbol: 'USDJPY',  label: 'USD/JPY',  group: 'FOREX' },
  { symbol: 'GBPJPY',  label: 'GBP/JPY',  group: 'FOREX' },
  // Indici rimossi: US500, NAS100, DXY — disponibili solo su TradingView
  // con account loggato (popup nag). Restano accessibili via Multi-Chart se serve.
]

const GROUPS = ['CRYPTO', 'COMMODITIES', 'FOREX']

const GROUP_ICON = {
  CRYPTO:      '₿',
  COMMODITIES: '⚒',
  FOREX:       '€',
}

export default function Watchlist() {
  const instruments      = useAppStore(s => s.instruments)
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const setActive        = useAppStore(s => s.setActiveInstrument)
  const apiKeys          = useAppStore(s => s.apiKeys)
  const hasTD            = !!apiKeys.twelvedata

  // Decisioni aperte per simbolo (refresh ogni 15s)
  const [openDecisions, setOpenDecisions] = useState({})
  useEffect(() => {
    const refresh = () => {
      const open = getAllDecisions().filter(d => d.status === 'open')
      const map = {}
      for (const d of open) map[d.symbol] = (map[d.symbol] || 0) + 1
      setOpenDecisions(map)
    }
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {GROUPS.map(group => {
        const items = INSTRUMENTS.filter(i => i.group === group)
        return (
          <div key={group}>
            <div className="flex items-center gap-2 px-3 py-1.5 text-xxs font-mono text-text-muted tracking-widest bg-bg-primary/40 sticky top-0 z-10 border-b border-bg-border/40">
              <span>{GROUP_ICON[group]}</span>
              <span>{group}</span>
            </div>
            {items.map(({ symbol, label }) => {
              const data    = instruments[symbol]
              const price   = data?.price
              const pct     = data?.pct ?? 0
              const isActive = symbol === activeInstrument
              const needsKey = symbol !== 'BTCUSD' && !hasTD
              const openCount = openDecisions[symbol] || 0

              const dirColor = pct > 0 ? 'text-green' : pct < 0 ? 'text-red' : 'text-text-secondary'
              const dirArrow = pct > 0.001 ? '▲' : pct < -0.001 ? '▼' : '·'

              return (
                <button
                  key={symbol}
                  onClick={() => setActive(symbol)}
                  className={`group w-full text-left px-3 py-2.5 border-b border-bg-border/20 transition-all duration-150
                    ${isActive
                      ? 'bg-gold/10 border-l-[3px] border-l-gold'
                      : 'hover:bg-bg-hover border-l-[3px] border-l-transparent'}`}
                  title={needsKey ? 'Richiede API key Twelve Data' : `${label} (${symbol})`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`font-mono text-xs font-semibold truncate ${isActive ? 'text-gold' : 'text-text-primary'}`}>
                        {label}
                      </span>
                      {openCount > 0 && (
                        <span className="text-xxs font-mono px-1 py-0 rounded-sm bg-gold/20 text-gold border border-gold/30 shrink-0"
                              title={`${openCount} decisione aperta nel diario`}>
                          {openCount}
                        </span>
                      )}
                    </div>
                    {needsKey ? (
                      <span className="text-xxs font-mono text-text-muted shrink-0">🔑</span>
                    ) : price ? (
                      <span className={`font-mono text-xs tabular-nums font-semibold shrink-0 ${dirColor}`}>
                        {formatPrice(symbol, price)}
                      </span>
                    ) : (
                      <span className="skeleton w-12 h-3 shrink-0" />
                    )}
                  </div>
                  {!needsKey && price && (
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xxs font-mono text-text-muted">{symbol}</span>
                      <span className={`text-xxs font-mono tabular-nums ${dirColor} opacity-80`}>
                        {dirArrow} {Math.abs(pct).toFixed(2)}%
                      </span>
                    </div>
                  )}
                  {!needsKey && !price && (
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-xxs font-mono text-text-muted">{symbol}</span>
                      <span className="skeleton w-10 h-2.5" />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
