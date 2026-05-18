// Carica e mantiene aggiornato il contesto fondamentale globale:
// - eventi calendario Forex Factory
// - market context (BTC dominance, Fear & Greed)
import { fetchFFCalendar }                 from './ForexFactoryService'
import { fetchCGGlobal, fetchFearGreed }   from './CoinGeckoService'
import { fetchMacroBundle }                from './FREDService'
import { fetchAllCOT }                     from './COTService'
import { fetchAllNews }                    from './NewsService'
import { useAppStore }                     from '../store/store'

const REFRESH_EVENTS_MS  = 30 * 60 * 1000   // 30 min
const REFRESH_MARKET_MS  = 10 * 60 * 1000   // 10 min
const REFRESH_COT_MS     = 6 * 60 * 60 * 1000 // 6h (COT è weekly)
const REFRESH_NEWS_MS    = 5 * 60 * 1000    // 5 min

let eventsTimer = null
let marketTimer = null
let cotTimer    = null
let newsTimer   = null

export async function loadEvents() {
  try {
    const events = await fetchFFCalendar()
    useAppStore.getState().setEvents(events)
  } catch (err) {
    console.warn('[FundamentalHub] events:', err.message)
  }
}

export async function loadCOT() {
  try {
    const cot = await fetchAllCOT()
    useAppStore.getState().setCOT(cot)
  } catch (err) {
    console.warn('[FundamentalHub] COT:', err.message)
  }
}

export async function loadNews() {
  const store = useAppStore.getState()
  const key = store.apiKeys.finnhub
  if (!key) return
  try {
    const news = await fetchAllNews(key, ['general', 'forex', 'crypto'])
    store.setNews(news)
  } catch (err) {
    console.warn('[FundamentalHub] news:', err.message)
  }
}

export async function loadMarketContext() {
  const store    = useAppStore.getState()
  const cgKey    = store.apiKeys.coingecko
  const fredKey  = store.apiKeys.fred

  // Fear & Greed (no key)
  const fg = await fetchFearGreed()

  // CoinGecko global
  let cgData = {}
  try { cgData = await fetchCGGlobal(cgKey || null) }
  catch (err) { console.warn('[FundamentalHub] coingecko:', err.message) }

  // FRED macro bundle (yields, VIX, DXY)
  let macro = {}
  if (fredKey) {
    try { macro = await fetchMacroBundle(fredKey) }
    catch (err) { console.warn('[FundamentalHub] FRED:', err.message) }
  }

  store.setMarketContext({
    btcDominance:   cgData.btcDominance ?? null,
    totalMarketCap: cgData.totalMarketCap ?? null,
    change24h:      cgData.change24h ?? null,
    fearGreed:      fg,
    us10y:          macro.us10y ?? null,
    us2y:           macro.us2y ?? null,
    spread10y2y:    macro.spread10y2y ?? null,
    vix:            macro.vix ?? null,
    dxy:            macro.dxy ?? null,
  })
}

export function initFundamentalHub() {
  loadEvents()
  loadMarketContext()
  loadCOT()
  loadNews()

  if (eventsTimer) clearInterval(eventsTimer)
  if (marketTimer) clearInterval(marketTimer)
  if (cotTimer)    clearInterval(cotTimer)
  if (newsTimer)   clearInterval(newsTimer)
  eventsTimer = setInterval(loadEvents,        REFRESH_EVENTS_MS)
  marketTimer = setInterval(loadMarketContext, REFRESH_MARKET_MS)
  cotTimer    = setInterval(loadCOT,           REFRESH_COT_MS)
  newsTimer   = setInterval(loadNews,          REFRESH_NEWS_MS)
}

export function disconnectFundamentalHub() {
  if (eventsTimer) clearInterval(eventsTimer)
  if (marketTimer) clearInterval(marketTimer)
  if (cotTimer)    clearInterval(cotTimer)
  if (newsTimer)   clearInterval(newsTimer)
  eventsTimer = null
  marketTimer = null
  cotTimer    = null
  newsTimer   = null
}
