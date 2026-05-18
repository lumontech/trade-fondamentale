import { useState, useMemo } from 'react'
import { useAppStore } from '../store/store'
import { extractTags, quickSentiment } from '../services/NewsService'

const CAT_COLOR = {
  general: '#8892a4',
  forex:   '#2196F3',
  crypto:  '#f5c842',
  merger:  '#9C27B0',
}

const CAT_FILTERS = ['ALL', 'forex', 'general', 'crypto']
const TAG_FILTERS = ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'XAU', 'OIL', 'BTC', 'SPX']

export default function NewsPanel() {
  const news     = useAppStore(s => s.news)
  const setPanel = useAppStore(s => s.setActivePanel)
  const apiKeys  = useAppStore(s => s.apiKeys)

  const [catFilter, setCatFilter] = useState('ALL')
  const [tagFilter, setTagFilter] = useState('ALL')
  const [search,    setSearch]    = useState('')

  const enriched = useMemo(() =>
    news.map(n => ({
      ...n,
      tags: extractTags(n.headline + ' ' + n.summary),
      sentiment: quickSentiment(n.headline + ' ' + n.summary),
    })), [news]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return enriched.filter(n =>
      (catFilter === 'ALL' || n.category === catFilter) &&
      (tagFilter === 'ALL' || n.tags.includes(tagFilter)) &&
      (q === '' || n.headline.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q))
    )
  }, [enriched, catFilter, tagFilter, search])

  const fmtTime = (d) => {
    const now = new Date()
    const diff = (now - d) / 1000
    if (diff < 60) return `${Math.floor(diff)}s fa`
    if (diff < 3600) return `${Math.floor(diff/60)}m fa`
    if (diff < 86400) return `${Math.floor(diff/3600)}h fa`
    return d.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  if (!apiKeys.finnhub) {
    return (
      <div className="h-full flex flex-col bg-bg-primary">
        <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">📰 NEWS REAL-TIME</h2>
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="text-4xl mb-3">🔑</div>
            <h3 className="font-mono text-lg text-gold mb-2">Inserisci API key Finnhub</h3>
            <p className="font-mono text-sm text-text-secondary mb-4">
              Le news richiedono una chiave gratuita di Finnhub.io (60 req/min).
              Vai nell'<button onClick={() => setPanel('apihub')} className="text-gold hover:underline">API Hub</button> per inserirla.
            </p>
            <a href="https://finnhub.io/dashboard" target="_blank" rel="noreferrer"
               className="inline-block px-4 py-2 rounded-md font-mono text-sm bg-gold/20 text-gold border border-gold/40 hover:bg-gold/30">
              Ottieni chiave gratuita →
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">📰 NEWS REAL-TIME</h2>
            <p className="font-mono text-sm text-text-secondary mt-0.5">
              Finnhub • {filtered.length}/{news.length} headline • aggiornamento ogni 5 min
            </p>
          </div>
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>

        {/* Filtri */}
        <div className="flex flex-wrap items-center gap-3">
          <FilterRow label="Categoria" options={CAT_FILTERS} active={catFilter} onSelect={setCatFilter} />
          <div className="w-px h-6 bg-bg-border" />
          <FilterRow label="Asset" options={TAG_FILTERS} active={tagFilter} onSelect={setTagFilter} />
          <div className="flex-1" />
          <input
            type="text"
            placeholder="Cerca nel testo..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-bg-primary border border-bg-border rounded-md px-3 py-1
                       font-mono text-sm text-text-primary placeholder-text-muted
                       outline-none focus:border-gold/50 w-64"
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {news.length === 0 ? (
          <div className="text-center py-20">
            <span className="font-mono text-base text-text-muted">⏳ Caricamento news...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <span className="font-mono text-base text-text-muted">Nessuna news con questi filtri.</span>
          </div>
        ) : (
          <div className="space-y-3 max-w-5xl mx-auto">
            {filtered.slice(0, 100).map(n => {
              const sentColor = n.sentiment > 0.2 ? '#00e096' :
                                n.sentiment < -0.2 ? '#ff3355' : '#8892a4'
              return (
                <a key={n.id} href={n.url} target="_blank" rel="noreferrer"
                   className="block bg-bg-secondary rounded-xl border border-bg-border hover:border-gold/30
                              transition-colors overflow-hidden">
                  <div className="px-5 py-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded text-xxs font-mono uppercase tracking-wider"
                            style={{ backgroundColor: CAT_COLOR[n.category] + '20', color: CAT_COLOR[n.category] }}>
                        {n.category}
                      </span>
                      <span className="font-mono text-xxs text-text-muted">{n.source}</span>
                      <span className="font-mono text-xxs text-text-muted ml-auto">{fmtTime(n.date)}</span>
                    </div>
                    <h3 className="font-mono text-base text-text-primary leading-snug mb-2">
                      {n.headline}
                    </h3>
                    {n.summary && (
                      <p className="font-mono text-sm text-text-secondary leading-relaxed line-clamp-2">
                        {n.summary.slice(0, 280)}{n.summary.length > 280 ? '...' : ''}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-3">
                      {n.tags.map(t => (
                        <span key={t} className="px-1.5 py-0.5 rounded bg-bg-hover text-xxs font-mono text-gold">
                          {t}
                        </span>
                      ))}
                      {Math.abs(n.sentiment) > 0.2 && (
                        <span className="ml-auto font-mono text-xxs"
                              style={{ color: sentColor }}>
                          {n.sentiment > 0 ? '▲ bullish' : '▼ bearish'}
                        </span>
                      )}
                    </div>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function FilterRow({ label, options, active, onSelect }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-text-muted uppercase">{label}:</span>
      <div className="flex gap-1">
        {options.map(o => (
          <button key={o}
            onClick={() => onSelect(o)}
            className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-all
              ${active === o
                ? 'bg-gold/20 text-gold border-gold/40'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'}`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}
