import { useState, useEffect } from 'react'
import { useAppStore } from '../store/store'
import { initWatchlistPrices, initTwelveDataWS, loadCandles } from '../services/DataHub'
import { loadMarketContext, loadNews }            from '../services/FundamentalHub'
import { getTDRateLimitStatus, resetTDRateLimit } from '../services/TwelveDataService'
import { clearHistoricalCache }                   from '../services/HistoricalLoader'
import { getApifyUserInfo, clearApifyCache }      from '../services/ApifyService'
import { useToast }                               from './ui/Toast'

const SOURCES = [
  {
    id: 'anthropic',
    name: 'Claude API (Anthropic)',
    desc: 'Decisioni operative AI con tutto il contesto',
    fields: [
      { id: 'anthropic', label: 'API Key (sk-ant-...)', type: 'password' },
    ],
    freeUrl: 'https://console.anthropic.com/settings/keys',
    note: 'A pagamento. ~$0.02-0.05 per analisi con Opus 4.7. Bottone "🧠 Chiedi a Claude" attivo nello scoring.',
    instruments: ['Decisione operativa AI', 'Reasoning strutturato', 'Risk assessment'],
    color: '#cc785c',
    icon: '🧠',
  },
  {
    id: 'binance',
    name: 'Binance',
    desc: 'Prezzi crypto in tempo reale (WebSocket)',
    fields: [],
    freeUrl: null,
    note: 'Gratuito, nessuna chiave richiesta',
    instruments: ['BTCUSD'],
    color: '#f5c842',
    icon: '₿',
  },
  {
    id: 'twelvedata',
    name: 'Twelve Data',
    desc: 'Forex, oro, ETF (800 chiamate/giorno × N key)',
    fields: [
      { id: 'twelvedata',  label: 'API Key (primaria)',         type: 'password' },
      { id: 'twelvedata2', label: 'API Key #2 (backup, opzionale)', type: 'password' },
    ],
    freeUrl: 'https://twelvedata.com/register',
    note: 'Free tier: 800 calls/giorno + 7 calls/62s per key. Con 2 key le quote raddoppiano (rotazione automatica). Nota: TD ToS sconsiglia account multipli — uso a tuo rischio.',
    instruments: ['XAUUSD','EURUSD','GBPUSD','USDJPY','GBPJPY','SPY','QQQ','USO','UUP'],
    color: '#2196F3',
    icon: '◆',
  },
  {
    id: 'ctrader',
    name: 'cTrader Open API',
    desc: 'Dati broker reali — forex, DXY, indici',
    fields: [
      { id: 'ctrader_clientId',     label: 'Client ID',     type: 'text' },
      { id: 'ctrader_clientSecret', label: 'Client Secret', type: 'password' },
      { id: 'ctrader_accessToken',  label: 'Access Token',  type: 'password' },
      { id: 'ctrader_accountId',    label: 'Account ID (ctidTraderAccount)', type: 'text' },
    ],
    freeUrl: 'https://openapi.ctrader.com',
    note: 'Connessione diretta al broker tramite OAuth2 + WebSocket',
    instruments: ['Forex completo', 'DXY reale', 'Indici', 'Commodity'],
    color: '#FF9800',
    icon: '⚡',
  },
  {
    id: 'coingecko',
    name: 'CoinGecko',
    desc: 'Crypto market data + dominanza + sentiment',
    fields: [
      { id: 'coingecko', label: 'API Key (Demo plan)', type: 'password' },
    ],
    freeUrl: 'https://www.coingecko.com/en/api/pricing',
    note: '10.000 chiamate/mese sul piano Demo gratuito',
    instruments: ['BTC dominance', 'Total market cap', '15.000+ crypto'],
    color: '#8BC34A',
    icon: '🦎',
  },
  {
    id: 'forexfactory',
    name: 'Forex Factory',
    desc: 'Calendario economico (via corsproxy.io)',
    fields: [],
    freeUrl: null,
    note: 'Gratuito, nessuna chiave richiesta',
    instruments: ['Calendario macro USD/EUR/GBP/JPY ecc.'],
    color: '#9C27B0',
    icon: '📅',
  },
  {
    id: 'telegram',
    name: 'Telegram — Bot API',
    desc: 'Leggi messaggi da canali/gruppi trading dove il bot è membro',
    fields: [
      { id: 'telegram_token', label: 'Bot Token (da @BotFather)', type: 'password' },
    ],
    freeUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    note: 'Crea bot su @BotFather (gratis). Aggiungi il bot come admin al canale/gruppo. Il bot leggerà i messaggi futuri (non lo storico).',
    instruments: ['News trading channels', 'Signal groups', 'Macro feeds'],
    color: '#229ED9',
    icon: '📱',
  },
  {
    id: 'finnhub',
    name: 'Finnhub — News',
    desc: 'News real-time forex, crypto, macro',
    fields: [
      { id: 'finnhub', label: 'API Key', type: 'password' },
    ],
    freeUrl: 'https://finnhub.io/dashboard',
    note: '60 chiamate/min gratuite. Notizie continue da Reuters, FT, Bloomberg.',
    instruments: ['News forex', 'News crypto', 'News macro/general'],
    color: '#0f9d58',
    icon: '📰',
  },
  {
    id: 'fred',
    name: 'FRED — Federal Reserve',
    desc: 'Yields US, VIX, DXY ufficiali (Fed di St. Louis)',
    fields: [
      { id: 'fred', label: 'API Key', type: 'password' },
    ],
    freeUrl: 'https://fredaccount.stlouisfed.org/apikey',
    note: '120 chiamate/min gratuite. Registrazione di 30 secondi.',
    instruments: ['US10Y', 'US2Y', '10Y-2Y spread', 'VIX', 'DXY'],
    color: '#26A69A',
    icon: '🏦',
  },
  {
    id: 'alphaVantage',
    name: 'Alpha Vantage',
    desc: 'Dati storici di backup',
    fields: [
      { id: 'alphaVantage', label: 'API Key', type: 'password' },
    ],
    freeUrl: 'https://www.alphavantage.co/support/#api-key',
    note: '25 chiamate/giorno gratuite — opzionale',
    instruments: ['Backup forex & azioni'],
    color: '#607D8B',
    icon: '◌',
  },
  {
    id: 'apify',
    name: 'Apify',
    desc: 'Web scraping pay-per-result (Twitter, Reddit, TradingView, Forex Factory)',
    fields: [
      { id: 'apify', label: 'API Token (apify_api_...)', type: 'password' },
    ],
    freeUrl: 'https://console.apify.com/account/integrations',
    note: 'Pay-per-run + free tier $5/mese platform credits. Scraping di siti senza API: Twitter sentiment, Forex Factory dettagliato, TradingView ideas, Reddit r/Forex.',
    instruments: ['Twitter sentiment', 'Reddit posts', 'TradingView ideas', 'Forex Factory full', 'Web generic'],
    color: '#97D700',
    icon: '🤖',
  },
]

function StatusBadge({ status, hasKey }) {
  let label = 'NON CONFIGURATO'
  let bg    = '#1e2535'
  let fg    = '#8892a4'

  if (status === 'connected') { label = 'CONNESSO';      bg = '#00e09618'; fg = '#00e096' }
  else if (status === 'error') { label = 'ERRORE';       bg = '#ff335518'; fg = '#ff3355' }
  else if (hasKey)             { label = 'CHIAVE OK';    bg = '#f5c84218'; fg = '#f5c842' }

  return (
    <div
      className="font-mono text-xs font-medium px-3 py-1 rounded-md"
      style={{ backgroundColor: bg, color: fg }}
    >
      {label}
    </div>
  )
}

export default function ApiHub() {
  const apiKeys     = useAppStore(s => s.apiKeys)
  const connections = useAppStore(s => s.connections)
  const setApiKey   = useAppStore(s => s.setApiKey)
  const setPanel    = useAppStore(s => s.setActivePanel)

  const [drafts, setDrafts] = useState({})
  const [saved,  setSaved]  = useState({})
  const toast = useToast()

  const handleSave = async (source) => {
    let didSave = false
    for (const f of source.fields) {
      const draft = drafts[f.id]
      if (draft != null && draft !== apiKeys[f.id]) {
        setApiKey(f.id, draft.trim())
        didSave = true
      }
    }
    if (!didSave) return

    setSaved(s => ({ ...s, [source.id]: true }))
    setTimeout(() => setSaved(s => ({ ...s, [source.id]: false })), 2500)
    toast.success(`${source.name} configurato`, { title: '🔑 Chiavi salvate' })

    if (source.id === 'twelvedata') {
      await initWatchlistPrices()
      initTwelveDataWS()
    }
    if (source.id === 'coingecko' || source.id === 'fred') {
      loadMarketContext()
    }
    if (source.id === 'finnhub') {
      loadNews()
    }
    if (source.id === 'apify') {
      // Test connection
      try {
        const info = await getApifyUserInfo(drafts.apify || apiKeys.apify)
        toast.success(`Connesso come ${info.username || info.id}. Plan: ${info.plan?.id || 'free'}`,
                      { title: '🤖 Apify OK' })
      } catch (err) {
        toast.error(`Token non valido: ${err.message}`, { title: '⚠ Apify' })
      }
    }
  }

  const sourceHasKey = (s) => s.fields.length === 0 ||
    s.fields.every(f => (apiKeys[f.id] || '').trim().length > 0)

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-bg-primary">

      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">⚙ API HUB</h2>
          <p className="font-mono text-sm text-text-secondary mt-1">
            Configura le fonti dati. Tutte le chiavi restano salvate solo nel tuo browser.
          </p>
        </div>
        <button
          onClick={() => setPanel('chart')}
          className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border"
        >
          ✕ Chiudi
        </button>
      </div>

      {/* Diagnostica TD rate limit */}
      <TDDiagnostics activeInstrument={useAppStore.getState().activeInstrument}
                     activeTimeframe={useAppStore.getState().activeTimeframe}
                     toast={toast} />

      {/* Cards grid */}
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-7xl mx-auto w-full">
        {SOURCES.map(source => {
          const status  = connections[source.id]
          const hasKey  = sourceHasKey(source)
          const noFields = source.fields.length === 0
          const justSaved = saved[source.id]

          return (
            <div
              key={source.id}
              className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden flex flex-col"
              style={{ borderLeftWidth: '4px', borderLeftColor: source.color }}
            >
              {/* Source header */}
              <div className="px-5 py-4 border-b border-bg-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl" style={{ color: source.color }}>{source.icon}</span>
                    <div>
                      <div className="font-mono text-base font-semibold" style={{ color: source.color }}>
                        {source.name}
                      </div>
                      <div className="font-mono text-xs text-text-secondary">{source.desc}</div>
                    </div>
                  </div>
                  <StatusBadge status={status} hasKey={hasKey} />
                </div>

                {/* Instruments tags */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {source.instruments.map(sym => (
                    <span key={sym} className="px-2 py-0.5 bg-bg-hover rounded text-xs font-mono text-text-secondary">
                      {sym}
                    </span>
                  ))}
                </div>
              </div>

              {/* Source body */}
              <div className="px-5 py-4 flex-1 flex flex-col gap-3">
                <p className="font-mono text-xs text-text-muted">{source.note}</p>

                {noFields ? (
                  <div className="flex items-center gap-2 mt-1 px-3 py-2 bg-green/10 rounded-md">
                    <span className="w-2 h-2 rounded-full bg-green inline-block" />
                    <span className="font-mono text-sm text-green">Attivo automaticamente</span>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2.5">
                      {source.fields.map(f => {
                        const current = apiKeys[f.id] || ''
                        const draft   = drafts[f.id] ?? current
                        return (
                          <div key={f.id}>
                            <label className="block font-mono text-xs text-text-secondary mb-1">
                              {f.label}
                            </label>
                            <input
                              type={f.type}
                              placeholder={current ? '••••••••••••••••' : `Inserisci ${f.label}`}
                              value={draft}
                              onChange={e => setDrafts(d => ({ ...d, [f.id]: e.target.value }))}
                              className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2
                                         font-mono text-sm text-text-primary placeholder-text-muted
                                         outline-none focus:border-gold/50 transition-colors"
                            />
                          </div>
                        )
                      })}
                    </div>

                    <div className="flex gap-2 mt-1">
                      <button
                        onClick={() => handleSave(source)}
                        className="flex-1 px-4 py-2 rounded-md font-mono text-sm font-medium transition-all"
                        style={{
                          backgroundColor: justSaved ? '#00e09618' : source.color + '20',
                          color:           justSaved ? '#00e096'   : source.color,
                          border:          `1px solid ${justSaved ? '#00e09660' : source.color + '40'}`,
                        }}
                      >
                        {justSaved ? '✓ SALVATO' : 'SALVA CHIAVI'}
                      </button>
                      {source.freeUrl && (
                        <a
                          href={source.freeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="px-4 py-2 rounded-md font-mono text-sm text-text-secondary
                                     hover:text-text-primary border border-bg-border hover:bg-bg-hover transition-all"
                        >
                          OTTIENI →
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer info */}
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="bg-bg-secondary border border-bg-border rounded-xl p-5">
          <div className="font-mono text-sm font-medium text-gold mb-3">ℹ COME FUNZIONA</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="font-mono text-xs font-semibold text-text-primary mb-1">SUBITO ATTIVI</div>
              <p className="font-mono text-xs text-text-secondary leading-relaxed">
                Binance e Forex Factory funzionano senza chiave: BTC e calendario macro disponibili immediatamente.
              </p>
            </div>
            <div>
              <div className="font-mono text-xs font-semibold text-text-primary mb-1">CON CHIAVE GRATUITA</div>
              <p className="font-mono text-xs text-text-secondary leading-relaxed">
                Twelve Data e CoinGecko offrono piani Demo gratuiti. Una registrazione di 1 minuto e copi la chiave qui.
              </p>
            </div>
            <div>
              <div className="font-mono text-xs font-semibold text-text-primary mb-1">CON BROKER REALE</div>
              <p className="font-mono text-xs text-text-secondary leading-relaxed">
                cTrader Open API si collega al tuo conto reale o demo: prezzi del broker, no proxy ETF.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── TD Diagnostics ──────────────────────────────────────────────────
function TDDiagnostics({ activeInstrument, activeTimeframe, toast }) {
  const apiKeys = useAppStore(s => s.apiKeys)
  const [status, setStatus] = useState(() => getTDRateLimitStatus())
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setStatus(getTDRateLimitStatus()), 2000)
    return () => clearInterval(id)
  }, [])

  if (!apiKeys.twelvedata && !apiKeys.twelvedata2) return null

  const totalAvailable = status.totalAvailable || 0
  const totalMax       = status.totalMax || 0
  const allExhausted   = totalAvailable === 0
  const low            = totalAvailable <= 2 && !allExhausted
  const color          = allExhausted ? '#ff3355' : low ? '#f5c842' : '#00e096'
  const hasMultiKeys   = (status.keys?.length || 0) > 1

  const handleReset = () => {
    resetTDRateLimit()
    setStatus(getTDRateLimitStatus())
    toast.success('Rate limiter TD resettato (tutte le key).', { title: '⚡ Reset' })
  }

  const handleClearAndReload = async () => {
    setReloading(true)
    resetTDRateLimit()
    clearHistoricalCache()
    try {
      const r = await loadCandles(activeInstrument, activeTimeframe)
      if (r?.error) throw new Error(r.error)
      toast.success(`Candele ${activeInstrument} ${activeTimeframe} ricaricate`, { title: '✓ Reload' })
    } catch (err) {
      toast.error(`Errore ricarica: ${err.message}`, { title: '⚠ Reload fallito' })
    } finally {
      setReloading(false)
      setStatus(getTDRateLimitStatus())
    }
  }

  return (
    <div className="px-6 py-3 border-b border-bg-border bg-bg-primary/30">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="font-mono text-xxs uppercase tracking-widest text-text-muted">Twelve Data</div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
              <span className="font-mono text-xs font-semibold" style={{ color }}>
                {totalAvailable}/{totalMax} crediti totali
              </span>
              {hasMultiKeys && (
                <span className="font-mono text-xxs text-text-muted">
                  ({status.keys.length} key in rotazione)
                </span>
              )}
            </div>
            {status.queueLength > 0 && (
              <span className="font-mono text-xxs text-text-muted">
                Coda: {status.queueLength}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleReset}
                    className="px-3 py-1 rounded-md font-mono text-xxs bg-gold/10 text-gold border border-gold/30 hover:bg-gold/20">
              ↻ Reset
            </button>
            <button onClick={handleClearAndReload} disabled={reloading}
                    className="px-3 py-1 rounded-md font-mono text-xxs bg-red/10 text-red border border-red/30 hover:bg-red/20 disabled:opacity-50">
              {reloading ? '⏳' : '🔥 Clear cache + reload'}
            </button>
          </div>
        </div>

        {/* Per-key breakdown */}
        {(status.keys || []).length > 0 && (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
            {status.keys.map((k, i) => {
              const c = k.creditsAvailable === 0 ? '#ff3355' : k.creditsAvailable <= 2 ? '#f5c842' : '#00e096'
              return (
                <div key={k.keyHash} className="flex items-center justify-between px-2.5 py-1 bg-bg-secondary/50 rounded-md font-mono text-xxs">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: c }} />
                    <span className="text-text-secondary">Key #{i + 1}</span>
                    <span className="text-text-muted">·{k.keyHash}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span style={{ color: c }} className="tabular-nums font-semibold">
                      {k.creditsAvailable}/{k.maxPerWindow}
                    </span>
                    {k.dailyExhausted && (
                      <span className="text-red">⚠ daily exhausted</span>
                    )}
                    {k.windowResetIn > 0 && k.creditsAvailable === 0 && !k.dailyExhausted && (
                      <span className="text-text-muted">{Math.ceil(k.windowResetIn / 1000)}s</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {allExhausted && (
          <div className="mt-2 font-mono text-xxs text-red">
            ⚠ Tutte le key sono saturate (minuto e/o quota giornaliera). Aggiungi una key di backup oppure aspetta il reset.
          </div>
        )}
      </div>
    </div>
  )
}
