import { useEffect, useState, useRef } from 'react'
import { useAppStore } from '../store/store'
import { logout, getCurrentUser } from './AuthGuard'

function Dot({ status, size = 'w-2 h-2' }) {
  const colors = {
    connected:    'bg-green',
    disconnected: 'bg-text-muted',
    error:        'bg-red',
  }
  return <span className={`inline-block ${size} rounded-full ${colors[status] || 'bg-text-muted'}`} />
}

// Menu raggruppati: 4 aree invece di 11 bottoni
const NAV_GROUPS = [
  {
    id: 'analysis',
    label: 'Analisi',
    icon: '🔬',
    items: [
      { id: 'patterns',  label: 'Pattern Recognition', icon: '🎯', desc: 'Candlestick, Chart, Armonici' },
      { id: 'backtest',  label: 'Backtest Swing',      icon: '📊', desc: 'Walk-forward su candele storiche' },
      { id: 'scalping',  label: 'Scalping Lab',        icon: '⚡', desc: '12 strategie scalp · multi-pair' },
      { id: 'optimizer', label: 'Optimizer',           icon: '🎛', desc: 'Grid search parametri' },
    ],
  },
  {
    id: 'market',
    label: 'Mercato',
    icon: '📈',
    items: [
      { id: 'heatmap',     label: 'Heatmap & Volumi', icon: '🔥', desc: 'Currency strength, POC, liquidity' },
      { id: 'correlation', label: 'Correlazioni',     icon: '🔗', desc: 'Matrice cross-asset Pearson' },
      { id: 'cot',         label: 'COT Report',       icon: '🏛', desc: 'Posizionamento istituzionale' },
    ],
  },
  {
    id: 'info',
    label: 'Info',
    icon: '📰',
    items: [
      { id: 'calendar', label: 'Calendario Eventi', icon: '📅', desc: 'Forex Factory + regole macro' },
      { id: 'news',     label: 'News Real-time',    icon: '📰', desc: 'Finnhub forex/crypto/general' },
      { id: 'apify',    label: 'Apify Scraper',     icon: '🤖', desc: 'Twitter, Reddit, TradingView ideas' },
    ],
  },
]

// Bottoni sempre visibili (primary actions)
const PINNED_BUTTONS = [
  { id: 'claude',        label: 'Claude',     icon: '🧠', highlight: true },
  { id: 'claude-review', label: 'Review & Lessons', icon: '🧪' },
  { id: 'simulation',    label: 'Simulazione',icon: '💰' },
  { id: 'multichart',    label: 'Multi Chart',icon: '📊' },
  { id: 'tradelog',      label: 'Storia',     icon: '📋' },
]

function DropdownMenu({ group, activePanel, onSelect }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef          = useRef(null)
  const menuRef         = useRef(null)
  const isActive = group.items.some(it => it.id === activePanel)

  // Calcola posizione fixed dal bounding rect del bottone (evita clipping da parent overflow)
  const updatePos = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const menuWidth = 256  // w-64
    const left = Math.min(r.left, window.innerWidth - menuWidth - 8)
    setPos({ top: r.bottom + 4, left: Math.max(8, left) })
  }

  useEffect(() => {
    if (!open) return
    updatePos()
    const handler = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', handler)
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className={`btn-toolbar ${isActive ? 'active' : ''} ${open ? 'active' : ''}`}
        title={group.label}
      >
        <span className="text-base leading-none">{group.icon}</span>
        <span className="hidden lg:inline">{group.label}</span>
        <span className="font-mono text-xxs text-text-muted ml-0.5">▾</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          className="fixed w-64 bg-bg-secondary border border-bg-border rounded-lg shadow-2xl z-[100] overflow-hidden"
          style={{ top: pos.top, left: pos.left }}
        >
          {group.items.map(it => (
            <button
              key={it.id}
              onClick={() => { onSelect(it.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2.5 hover:bg-bg-hover transition-colors flex items-start gap-3 border-b border-bg-border/40 last:border-0 ${
                activePanel === it.id ? 'bg-gold/10' : ''
              }`}
            >
              <span className="text-lg leading-none mt-0.5">{it.icon}</span>
              <div className="flex-1 min-w-0">
                <div className={`font-mono text-sm ${activePanel === it.id ? 'text-gold' : 'text-text-primary'}`}>{it.label}</div>
                <div className="font-mono text-xxs text-text-muted">{it.desc}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export default function Header() {
  const connections  = useAppStore(s => s.connections)
  const setPanel     = useAppStore(s => s.setActivePanel)
  const activePanel  = useAppStore(s => s.activePanel)
  const [time, setTime] = useState('')

  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'short' })
        .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'CET'
      setTime(`${time} ${tzName}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const sources = [
    { id: 'binance',     label: 'BINANCE' },
    { id: 'twelvedata',  label: '12DATA' },
    { id: 'coingecko',   label: 'GECKO' },
  ]
  const connectedCount = sources.filter(s => connections[s.id] === 'connected').length

  const handleSelect = (id) => setPanel(activePanel === id ? 'chart' : id)

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-bg-secondary border-b border-bg-border shrink-0">
      {/* Brand + Home */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => setPanel('chart')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          title="Torna al chart"
        >
          <span className="text-gold text-lg leading-none">◈</span>
          <span className="font-mono font-bold text-sm tracking-widest text-gold">IMPACT</span>
        </button>
        <span className="text-text-muted font-mono text-xxs tracking-widest hidden xl:inline">
          TRADING PLATFORM
        </span>
      </div>

      {/* Centro: nav primary + groups */}
      <nav className="flex items-center gap-1 flex-1 justify-center min-w-0 overflow-x-auto">
        {/* Pinned (Claude + Diario) */}
        {PINNED_BUTTONS.map(btn => {
          const active = activePanel === btn.id
          return (
            <button
              key={btn.id}
              onClick={() => handleSelect(btn.id)}
              className={`btn-toolbar ${active ? 'active' : ''} ${btn.highlight && !active ? 'text-gold' : ''}`}
              title={btn.label}
            >
              <span className="text-base leading-none">{btn.icon}</span>
              <span className="hidden md:inline">{btn.label}</span>
            </button>
          )
        })}

        {/* Separator */}
        <div className="w-px h-5 bg-bg-border mx-1" />

        {/* Dropdown groups */}
        {NAV_GROUPS.map(group => (
          <DropdownMenu key={group.id} group={group} activePanel={activePanel} onSelect={handleSelect} />
        ))}
      </nav>

      {/* Right: connessioni + API hub + ora */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Stato connessioni compatto (solo icona + count) */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-bg-primary rounded-md border border-bg-border"
             title={sources.map(s => `${s.label}: ${connections[s.id] || 'off'}`).join(' · ')}>
          <Dot status={connectedCount === sources.length ? 'connected' : connectedCount > 0 ? 'error' : 'disconnected'} size="w-1.5 h-1.5" />
          <span className="font-mono text-xxs text-text-secondary tabular-nums">
            {connectedCount}/{sources.length} live
          </span>
        </div>

        <button
          onClick={() => setPanel(activePanel === 'apihub' ? 'chart' : 'apihub')}
          className={`btn-toolbar ${activePanel === 'apihub' ? 'active' : ''}`}
          title="Configurazione API Keys"
        >
          <span className="text-base leading-none">⚙</span>
          <span className="hidden lg:inline">API</span>
        </button>

        <div className="font-mono text-xs text-text-secondary tabular-nums px-2.5 py-1 bg-bg-primary rounded-md border border-bg-border tabular-nums hidden sm:block">
          {time}
        </div>

        {/* User menu / logout */}
        <UserMenu />
      </div>
    </header>
  )
}

function UserMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const user = getCurrentUser()
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  if (!user) return null
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
              className="btn-toolbar"
              title={`Logged as ${user}`}>
        <span className="text-base leading-none">👤</span>
        <span className="hidden lg:inline">{user}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-bg-secondary border border-bg-border rounded-md shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-bg-border/40">
            <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Loggato come</div>
            <div className="font-mono text-sm text-gold">{user}</div>
          </div>
          <button onClick={() => { logout() }}
                  className="w-full text-left px-3 py-2 hover:bg-bg-hover font-mono text-sm text-red transition-colors">
            🚪 Logout
          </button>
        </div>
      )}
    </div>
  )
}
