import { useState } from 'react'
import { useAppStore } from '../store/store'
import { APIFY_ACTORS, clearApifyCache } from '../services/ApifyService'
import { useToast } from './ui/Toast'

export default function ApifyPanel() {
  const apiKeys     = useAppStore(s => s.apiKeys)
  const setPanel    = useAppStore(s => s.setActivePanel)
  const activeInstrument = useAppStore(s => s.activeInstrument)

  const [selectedActor, setSelectedActor] = useState(APIFY_ACTORS[0])
  const [input, setInput]     = useState(JSON.stringify(APIFY_ACTORS[0].defaultInput, null, 2))
  const [running, setRunning] = useState(false)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)
  const toast = useToast()

  const handleSelectActor = (actor) => {
    setSelectedActor(actor)
    // Sostituisci symbol di default con quello attivo se applicabile
    const def = { ...actor.defaultInput }
    if ('symbol' in def && activeInstrument) def.symbol = activeInstrument
    setInput(JSON.stringify(def, null, 2))
    setResult(null)
    setError(null)
  }

  const handleRun = async () => {
    if (!apiKeys.apify) { setError('Configura il token Apify in API Hub'); return }
    let parsedInput
    try { parsedInput = JSON.parse(input) }
    catch (e) { setError('Input JSON non valido: ' + e.message); return }

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const out = await selectedActor.fn(apiKeys.apify, parsedInput)
      setResult(out)
      const itemKey = Object.keys(out).find(k => Array.isArray(out[k])) || 'items'
      const count = out[itemKey]?.length || 0
      toast.success(`${count} risultati ${out.fromCache ? '(cache)' : 'live'}`,
                    { title: `🤖 ${selectedActor.name}` })
    } catch (err) {
      setError(err.message)
      toast.error(err.message, { title: 'Errore Apify', duration: 6000 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-lg font-semibold text-gold tracking-wider">🤖 APIFY · WEB SCRAPER LAB</h2>
          <p className="font-mono text-xs text-text-muted mt-0.5">
            Pay-per-result. Esegui Actor Apify direttamente dal browser. Cache 30-60 min.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { clearApifyCache(); toast.success('Cache Apify svuotata') }}
                  className="font-mono text-xxs text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
            Svuota cache
          </button>
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>
      </div>

      {!apiKeys.apify && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="text-4xl mb-3">🤖</div>
            <h3 className="font-mono text-lg text-gold mb-2">Apify token richiesto</h3>
            <p className="font-mono text-sm text-text-secondary mb-4">
              Configura il token in <button onClick={() => setPanel('apihub')} className="text-gold hover:underline">API Hub</button>.
              Free tier $5/mese di platform credits + pay-per-result a centesimi.
            </p>
            <a href="https://console.apify.com/account/integrations" target="_blank" rel="noreferrer"
               className="inline-block px-4 py-2 rounded-md font-mono text-sm bg-gold/20 text-gold border border-gold/40 hover:bg-gold/30">
              Ottieni token →
            </a>
          </div>
        </div>
      )}

      {apiKeys.apify && (
        <div className="flex-1 flex overflow-hidden">

          {/* Sidebar: actor list */}
          <aside className="w-72 shrink-0 border-r border-bg-border bg-bg-secondary/30 overflow-y-auto p-3">
            <div className="font-mono text-xxs text-text-muted uppercase tracking-widest mb-2">Actor disponibili</div>
            <div className="space-y-1.5">
              {APIFY_ACTORS.map(a => {
                const active = selectedActor.id === a.id
                return (
                  <button key={a.id}
                          onClick={() => handleSelectActor(a)}
                          className={`w-full text-left p-2.5 rounded-md transition-all border ${
                            active
                              ? 'bg-gold/10 border-gold/40 text-gold'
                              : 'bg-bg-primary border-bg-border hover:bg-bg-hover text-text-primary'
                          }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base">{a.icon}</span>
                      <span className="font-mono text-sm font-semibold">{a.name}</span>
                    </div>
                    <div className="font-mono text-xxs text-text-muted leading-relaxed">{a.desc}</div>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* Main: input + results */}
          <main className="flex-1 flex flex-col overflow-hidden">

            {/* Input editor */}
            <div className="border-b border-bg-border p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-xs text-text-muted uppercase tracking-wider">Input JSON</div>
                <button onClick={handleRun} disabled={running}
                        className="px-4 py-1.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50">
                  {running ? '⏳ In corso...' : `▶ Esegui ${selectedActor.icon} ${selectedActor.name}`}
                </button>
              </div>
              <textarea value={input} onChange={e => setInput(e.target.value)}
                        rows={8}
                        spellCheck={false}
                        className="w-full bg-bg-primary border border-bg-border rounded-md p-3 font-mono text-xs text-text-primary outline-none focus:border-gold/50" />
              {error && (
                <div className="mt-2 font-mono text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">
                  ⚠ {error}
                </div>
              )}
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto p-4">
              {!result && !running && (
                <div className="text-center py-16">
                  <div className="text-3xl mb-2 opacity-50">{selectedActor.icon}</div>
                  <div className="font-mono text-sm text-text-muted">
                    Premi <strong>Esegui</strong> per lanciare l'actor.
                  </div>
                  <div className="font-mono text-xxs text-text-muted mt-2">
                    Risultati cached 30-60 min per ridurre costi.
                  </div>
                </div>
              )}

              {running && (
                <div className="text-center py-16">
                  <div className="text-3xl mb-2 animate-pulse">{selectedActor.icon}</div>
                  <div className="font-mono text-sm text-text-secondary">
                    Apify sta girando l'actor... (10-60s tipico)
                  </div>
                </div>
              )}

              {result && <ResultsView result={result} actor={selectedActor} />}
            </div>
          </main>
        </div>
      )}
    </div>
  )
}

// ─── Renderer specifici per actor ────────────────────────────────────
function ResultsView({ result, actor }) {
  if (actor.id === 'twitter')      return <TweetsView tweets={result.tweets} />
  if (actor.id === 'forexfactory') return <FFEventsView events={result.events} />
  if (actor.id === 'tradingview')  return <TVNewsView news={result.news} />
  if (actor.id === 'reddit')       return <RedditView posts={result.posts} />
  return <GenericJSONView data={result} />
}

function TweetsView({ tweets = [] }) {
  if (tweets.length === 0) return <Empty msg="Nessun tweet trovato" />
  return (
    <div className="space-y-2">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-widest">{tweets.length} tweet</div>
      {tweets.map(t => (
        <div key={t.id} className="bg-bg-secondary rounded-md p-3 border border-bg-border">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-xs font-semibold text-gold">@{t.author}</span>
            <span className="font-mono text-xxs text-text-muted">
              ❤ {t.likes} · 🔁 {t.retweets} · {new Date(t.createdAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <p className="font-mono text-xs text-text-primary leading-relaxed">{t.text}</p>
        </div>
      ))}
    </div>
  )
}

function FFEventsView({ events = [] }) {
  if (events.length === 0) return <Empty msg="Nessun evento" />
  const impactColor = (i) => i === 'High' ? '#ff3355' : i === 'Medium' ? '#f5c842' : '#7be0a3'
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-widest">{events.length} eventi</div>
      {events.map((e, i) => (
        <div key={i} className="bg-bg-secondary rounded-md p-2.5 border border-bg-border flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-text-primary truncate">{e.title}</span>
              <span className="font-mono text-xxs px-1.5 py-0.5 rounded" style={{ backgroundColor: `${impactColor(e.impact)}20`, color: impactColor(e.impact) }}>
                {e.currency} · {e.impact}
              </span>
            </div>
            <div className="font-mono text-xxs text-text-muted">{e.time}</div>
          </div>
          <div className="font-mono text-xxs tabular-nums shrink-0 text-text-secondary">
            <span>A: <strong>{e.actual ?? '—'}</strong></span>
            {' · '}
            <span>F: {e.forecast ?? '—'}</span>
            {' · '}
            <span>P: {e.previous ?? '—'}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function TVNewsView({ news = [] }) {
  if (news.length === 0) return <Empty msg="Nessuna news TradingView" />
  return (
    <div className="space-y-2">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-widest">{news.length} news</div>
      {news.map((n, idx) => {
        const sentColor = n.sentiment === 'positive' ? '#00e096' :
                          n.sentiment === 'negative' ? '#ff3355' : '#8892a4'
        return (
          <a key={idx} href={n.url} target="_blank" rel="noreferrer"
             className="block bg-bg-secondary rounded-md p-3 border border-bg-border hover:bg-bg-hover transition-colors">
            <div className="flex items-start justify-between gap-3 mb-1">
              <span className="font-mono text-sm font-semibold text-text-primary">{n.title}</span>
              {n.sentiment && (
                <span className="font-mono text-xxs px-1.5 py-0.5 rounded shrink-0"
                      style={{ backgroundColor: `${sentColor}20`, color: sentColor }}>
                  {n.sentiment}
                </span>
              )}
            </div>
            <div className="font-mono text-xxs text-text-muted mb-1">
              {n.provider || 'TradingView'} · {n.published ? new Date(n.published).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
            </div>
            {n.summary && <p className="font-mono text-xxs text-text-secondary">{n.summary}</p>}
          </a>
        )
      })}
    </div>
  )
}

function RedditView({ posts = [] }) {
  if (posts.length === 0) return <Empty msg="Nessun post Reddit" />
  return (
    <div className="space-y-2">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-widest">{posts.length} post</div>
      {posts.map(p => (
        <div key={p.id} className="bg-bg-secondary rounded-md p-3 border border-bg-border">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xxs px-1.5 py-0.5 rounded bg-gold/10 text-gold">r/{p.subreddit}</span>
            <span className="font-mono text-xs font-semibold text-text-primary flex-1">{p.title}</span>
            <span className="font-mono text-xxs text-text-muted">▲ {p.score} · 💬 {p.comments}</span>
          </div>
          {p.body && <p className="font-mono text-xxs text-text-secondary line-clamp-3">{p.body}</p>}
        </div>
      ))}
    </div>
  )
}

function GenericJSONView({ data }) {
  return (
    <pre className="font-mono text-xxs text-text-muted bg-bg-secondary rounded-md p-3 border border-bg-border overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function Empty({ msg }) {
  return <div className="text-center py-12 font-mono text-xs text-text-muted">{msg}</div>
}
