import { create } from 'zustand'

const baseInstrument = (source) => ({
  price: null, open: null, change: 0, pct: 0, candles: [], source,
  mtf: {}, // { '15m': [...], '1h': [...], '4h': [...], '1D': [...] }
})

const DEFAULT_INSTRUMENTS = {
  BTCUSD:  baseInstrument('binance'),
  XAUUSD:  baseInstrument('twelvedata'),
  EURUSD:  baseInstrument('twelvedata'),
  GBPUSD:  baseInstrument('twelvedata'),
  USDJPY:  baseInstrument('twelvedata'),
  GBPJPY:  baseInstrument('twelvedata'),
  EURGBP:  baseInstrument('twelvedata'),
  EURJPY:  baseInstrument('twelvedata'),
  US500:   baseInstrument('twelvedata'),
  NAS100:  baseInstrument('twelvedata'),
  USOIL:   baseInstrument('twelvedata'),
  DXY:     baseInstrument('twelvedata'),
  // Hyperliquid USDC perp (Fix #5.7) - pricing via Binance USDC + Hyperliquid native HYPE
  BTCUSDC:  baseInstrument('binance'),
  ETHUSDC:  baseInstrument('binance'),
  SOLUSDC:  baseInstrument('binance'),
  XRPUSDC:  baseInstrument('binance'),
  BNBUSDC:  baseInstrument('binance'),
  HYPEUSDC: baseInstrument('hyperliquid'),
}

const loadKeys = () => {
  try {
    return JSON.parse(localStorage.getItem('itp_api_keys') || '{}')
  } catch { return {} }
}

const saveKeys = (keys) => {
  localStorage.setItem('itp_api_keys', JSON.stringify(keys))
}

export const useAppStore = create((set, get) => ({
  // Active state
  activeInstrument: 'BTCUSD',
  activeTimeframe: '1h',
  activePanel: 'chart',        // 'chart' | 'apihub' | 'calendar'

  // Market data
  instruments: DEFAULT_INSTRUMENTS,

  // Connection status per source
  connections: {
    binance:    'disconnected',
    twelvedata: 'disconnected',
    coingecko:  'disconnected',
    frankfurter:'disconnected',
    hyperliquid:'disconnected',
  },

  // API keys (persisted in localStorage)
  apiKeys: loadKeys(),

  // Fundamental data
  events: [],                  // Forex Factory calendar events
  news: [],                    // News headlines (Finnhub)
  cot: {},                     // COT report per simbolo
  marketContext: {             // Macro context refreshed periodically
    btcDominance:   null,
    totalMarketCap: null,
    change24h:      null,
    fearGreed:      null,      // { value, label }
    // FRED macro
    us10y:          null,      // { value, change, ... }
    us2y:           null,
    spread10y2y:    null,      // 10Y-2Y, < 0 = inverted (recession signal)
    vix:            null,
    dxy:            null,      // USD trade-weighted index
    updatedAt:      null,
  },

  // ── Actions ──────────────────────────────────────

  setActiveInstrument: (symbol) => set({ activeInstrument: symbol }),

  setActiveTimeframe: (tf) => {
    set({ activeTimeframe: tf })
  },

  setActivePanel: (panel) => set({ activePanel: panel }),

  // Fix #5.9: position attiva per visualizzare entry/SL/TP sul TradingChart
  // Settata da SimulationPanel quando l'utente clicca "Vedi grafico" su una posizione aperta.
  // null = niente overlay sul chart.
  activePosition: null,
  setActivePosition: (pos) => set({ activePosition: pos }),

  updatePrice: (symbol, price, open) => set((state) => {
    const prev = state.instruments[symbol]
    const base = open ?? prev?.open ?? price
    const change = price - base
    const pct = base ? (change / base) * 100 : 0
    return {
      instruments: {
        ...state.instruments,
        [symbol]: { ...prev, price, open: base, change, pct },
      },
    }
  }),

  setCandles: (symbol, candles) => set((state) => ({
    instruments: {
      ...state.instruments,
      [symbol]: { ...state.instruments[symbol], candles },
    },
  })),

  setMTFCandles: (symbol, tf, candles) => set((state) => {
    const inst = state.instruments[symbol]
    if (!inst) return state
    return {
      instruments: {
        ...state.instruments,
        [symbol]: { ...inst, mtf: { ...(inst.mtf || {}), [tf]: candles } },
      },
    }
  }),

  appendCandle: (symbol, candle) => set((state) => {
    const existing = state.instruments[symbol]?.candles ?? []
    const last = existing[existing.length - 1]
    let updated
    if (last && last.time === candle.time) {
      // Stessa bar in corso: replace
      updated = [...existing.slice(0, -1), candle]
    } else if (last && candle.time < last.time) {
      // Candela vecchia arrivata in ritardo o di un TF differente: ignora
      return state
    } else {
      updated = [...existing, candle]
    }
    return {
      instruments: {
        ...state.instruments,
        [symbol]: { ...state.instruments[symbol], candles: updated },
      },
    }
  }),

  setConnection: (source, status) => set((state) => ({
    connections: { ...state.connections, [source]: status },
  })),

  setApiKey: (service, key) => {
    const keys = { ...get().apiKeys, [service]: key }
    saveKeys(keys)             // cache locale (fallback offline + immediate update UI)
    set({ apiKeys: keys })
    // Sync server-side: la key segue l'utente, non il device. Fire-and-forget.
    // Se il server non risponde, la key resta in localStorage (no UX block).
    fetch('/api/user/api-keys', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, key }),
    }).catch(err => console.warn('[apiKeys] server sync failed:', err.message))
    // Sincronizza il keyManager TD se è cambiata una delle 2 key
    if (service === 'twelvedata' || service === 'twelvedata2') {
      // Lazy import per evitare circular
      import('../services/DataHub').then(m => m.syncTDKeys?.()).catch(() => {})
    }
  },

  // Carica le API key dal server dopo il login (o al mount se sessione attiva).
  // Merge col localStorage: chiavi server-side hanno priorità.
  // Idempotente: chiamabile più volte senza side-effects.
  syncApiKeysFromServer: async () => {
    try {
      const r = await fetch('/api/user/api-keys', { credentials: 'include' })
      if (!r.ok) {
        if (r.status === 401) return { ok: false, reason: 'unauthorized' }
        return { ok: false, reason: `HTTP ${r.status}` }
      }
      const data = await r.json()
      const serverKeys = data?.keys || {}
      // Merge: locale come fallback, server come fonte autoritativa
      const merged = { ...get().apiKeys, ...serverKeys }
      saveKeys(merged)
      set({ apiKeys: merged })
      // Re-sync TD key manager se applicabile
      if (serverKeys.twelvedata || serverKeys.twelvedata2) {
        import('../services/DataHub').then(m => m.syncTDKeys?.()).catch(() => {})
      }
      return { ok: true, count: Object.keys(serverKeys).length }
    } catch (err) {
      console.warn('[apiKeys] sync error:', err.message)
      return { ok: false, reason: err.message }
    }
  },

  setEvents: (events) => set({ events }),

  setNews: (news) => set({ news }),

  setCOT: (cot) => set({ cot }),

  setMarketContext: (ctx) => set((state) => ({
    marketContext: { ...state.marketContext, ...ctx, updatedAt: Date.now() },
  })),

  getActiveCandles: () => {
    const { instruments, activeInstrument } = get()
    return instruments[activeInstrument]?.candles ?? []
  },
}))
