// ApifyService — integrazione con Apify per scraping di siti senza API pubblica.
// Pay-per-result tipico: $0.001-0.30 per item. Free tier $5/mo platform credits.
//
// Endpoint sync usato: /acts/{actor}/run-sync-get-dataset-items
// → blocca fino a fine run, ritorna dataset items direttamente. CORS-enabled.
const BASE = 'https://api.apify.com/v2'

// ── Cache leggera per ridurre re-scrape ────────────────────────────
const CACHE_PREFIX = 'itp_apify_cache_'
const CACHE_TTL_MS = 30 * 60 * 1000   // 30 min default

function cacheKey(actor, input) {
  let h = 0
  const s = actor + JSON.stringify(input || {})
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return CACHE_PREFIX + Math.abs(h).toString(36)
}

function loadCache(actor, input, ttl = CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem(cacheKey(actor, input))
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (Date.now() - obj.savedAt > ttl) return null
    return obj.data
  } catch { return null }
}

function saveCache(actor, input, data) {
  try {
    localStorage.setItem(cacheKey(actor, input), JSON.stringify({
      savedAt: Date.now(), data,
    }))
  } catch {}
}

export function clearApifyCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k))
  } catch {}
}

// ── Core: esegui un actor in modo sincrono ─────────────────────────
/**
 * Run actor sincrono e restituisci dataset items.
 * @param {string} actor - es. 'apify/web-scraper' o 'jakubfojtik/twitter-scraper'
 * @param {Object} input - input JSON dell'actor (specifico per ogni actor)
 * @param {string} token - Apify API token
 * @param {Object} opts - { timeout, memoryMbytes, useCache, ttlMs }
 * @returns {Promise<Array>} dataset items
 */
export async function runActorSync(actor, input, token, opts = {}) {
  if (!token) throw new Error('Apify token mancante')
  const { timeout = 120, memoryMbytes = 1024, useCache = true, ttlMs = CACHE_TTL_MS } = opts

  if (useCache) {
    const cached = loadCache(actor, input, ttlMs)
    if (cached) return { items: cached, fromCache: true }
  }

  const actorPath = actor.replace('/', '~')   // Apify URL format
  const url = `${BASE}/acts/${actorPath}/run-sync-get-dataset-items` +
              `?token=${encodeURIComponent(token)}` +
              `&timeout=${timeout}` +
              `&memory=${memoryMbytes}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!res.ok) {
    let msg = `Apify error ${res.status}`
    try {
      const err = await res.json()
      msg = err.error?.message || msg
    } catch {}
    throw new Error(msg)
  }

  const items = await res.json()
  if (useCache) saveCache(actor, input, items)
  return { items, fromCache: false }
}

// ── User info / status ─────────────────────────────────────────────
export async function getApifyUserInfo(token) {
  if (!token) throw new Error('Token mancante')
  const res = await fetch(`${BASE}/users/me?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Apify user info ${res.status}`)
  const data = await res.json()
  return data.data    // { id, username, plan, usageCycle, ... }
}

// ── Actor specifici comuni per trading ─────────────────────────────
// I loro input schema sono volutamente minimali; espandibili in seguito.

/**
 * Scraper Twitter/X — recupera tweet recenti per query/handle.
 * Actor: apidojo/tweet-scraper (Tweet Scraper V2). $0.15 per 1000 tweet.
 * Verificato attivo al 2026-05.
 */
export async function scrapeTwitter(token, { query, handles = [], limit = 30 } = {}) {
  const input = {
    searchTerms:    query ? [query] : [],
    twitterHandles: handles,
    maxItems:       limit,
    tweetLanguage:  'en',
    includeSearchTerms: false,
  }
  const { items, fromCache } = await runActorSync('apidojo/tweet-scraper', input, token, { ttlMs: 15 * 60 * 1000 })
  return {
    fromCache,
    tweets: items.map(t => ({
      id:        t.id,
      author:    t.author?.userName || t.author,
      text:      t.text || t.fullText,
      createdAt: t.createdAt,
      likes:     t.likeCount || t.favorite_count || 0,
      retweets:  t.retweetCount || t.retweet_count || 0,
      url:       t.url || t.twitterUrl,
    })),
  }
}

/**
 * Forex Factory calendar scraper — eventi del giorno con dettaglio.
 * Actor: bleffoo/economics-calendar-scraper (no input richiesto, prende automaticamente eventi oggi).
 * Verificato attivo al 2026-05.
 */
export async function scrapeForexFactoryCalendar(token, _opts = {}) {
  const input = { note: 'fetch from frontend' }
  const { items, fromCache } = await runActorSync('bleffoo/economics-calendar-scraper', input, token, { ttlMs: 60 * 60 * 1000 })
  return {
    fromCache,
    events: items.map(e => ({
      title:    e.title || e.event || e.name,
      currency: e.currency || e.country,
      impact:   e.impact || e.importance,
      time:     e.time || e.dateTime || e.date,
      actual:   e.actual,
      forecast: e.forecast,
      previous: e.previous,
    })),
  }
}

/**
 * TradingView News scraper — news pubblicate su TradingView per asset.
 * Actor: mscraper/tradingview-news-scraper (NOTA: Apify NON ha più un actor "ideas").
 * Verificato attivo al 2026-05.
 */
export async function scrapeTradingViewNews(token, { symbol = 'XAUUSD', limit = 20 } = {}) {
  const input = {
    startUrls: [{ url: `https://www.tradingview.com/symbols/${symbol}/news/` }],
    maxItems:  limit,
  }
  const { items, fromCache } = await runActorSync('mscraper/tradingview-news-scraper', input, token, { ttlMs: 60 * 60 * 1000 })
  return {
    fromCache,
    news: items.map(n => ({
      title:     n.title || n.headline,
      provider:  n.provider || n.source,
      published: n.publishedAt || n.date,
      url:       n.url || n.link,
      summary:   (n.description || n.summary || '').slice(0, 280),
      sentiment: n.sentiment,
    })),
  }
}

// Alias per backward-compat con codice che importava il vecchio nome
export const scrapeTradingViewIdeas = scrapeTradingViewNews

/**
 * Reddit scraper — post da subreddit finanziari.
 * Actor: trudax/reddit-scraper-lite (~$0.40 per 1000 post)
 */
export async function scrapeRedditFinance(token, { subreddits = ['Forex', 'wallstreetbets', 'CryptoCurrency'], query, limit = 50 } = {}) {
  const input = {
    searches:    query ? [query] : [],
    startUrls:   subreddits.map(s => ({ url: `https://www.reddit.com/r/${s}/hot/` })),
    maxItems:    limit,
    skipUserPosts: true,
  }
  const { items, fromCache } = await runActorSync('trudax/reddit-scraper-lite', input, token, { ttlMs: 30 * 60 * 1000 })
  return {
    fromCache,
    posts: items.map(p => ({
      id:        p.id,
      title:     p.title,
      subreddit: p.subreddit?.replace(/^r\//, ''),
      author:    p.username,
      score:     p.upVotes || p.score,
      comments:  p.numberOfComments,
      created:   p.createdAt,
      url:       p.url,
      body:      (p.body || '').slice(0, 500),
    })),
  }
}

/**
 * Generic web scraper — fallback per qualsiasi URL.
 * Actor: apify/web-scraper.
 */
export async function scrapeWebPage(token, { url, pageFunction } = {}) {
  const input = {
    startUrls: [{ url }],
    pageFunction: pageFunction || `async ({ page }) => { return { url: page.url(), title: await page.title(), text: await page.evaluate(() => document.body.innerText.slice(0, 5000)) } }`,
    maxRequestsPerCrawl: 1,
  }
  const { items, fromCache } = await runActorSync('apify/web-scraper', input, token, { ttlMs: 60 * 60 * 1000 })
  return { fromCache, results: items }
}

// ── Lista actor disponibili (per UI selector) ──────────────────────
// IDs verificati attivi sull'Apify Store al 2026-05.
export const APIFY_ACTORS = [
  {
    id:    'twitter',
    name:  'Twitter / X',
    icon:  '𝕏',
    desc:  'Tweet Scraper V2 (apidojo). $0.15 per 1000 tweet. Cerca per query o handle.',
    fn:    scrapeTwitter,
    defaultInput: { query: '$BTC OR $XAU', handles: ['ForexLive', 'zerohedge'], limit: 30 },
  },
  {
    id:    'forexfactory',
    name:  'Economic Calendar',
    icon:  '📅',
    desc:  'Eventi macro Forex Factory di oggi (bleffoo). Auto: scarica today, no input richiesto.',
    fn:    scrapeForexFactoryCalendar,
    defaultInput: {},
  },
  {
    id:    'tradingview',
    name:  'TradingView News',
    icon:  '📊',
    desc:  'News TradingView per simbolo (mscraper). NOTA: Apify non ha più "ideas" pubbliche.',
    fn:    scrapeTradingViewNews,
    defaultInput: { symbol: 'XAUUSD', limit: 20 },
  },
  {
    id:    'reddit',
    name:  'Reddit Finance',
    icon:  '👽',
    desc:  'Post da r/Forex, r/wallstreetbets, r/CryptoCurrency (trudax). $3.40 / 1000 post.',
    fn:    scrapeRedditFinance,
    defaultInput: { subreddits: ['Forex', 'CryptoCurrency'], limit: 50 },
  },
  {
    id:    'web',
    name:  'Web Generic Scraper',
    icon:  '🌐',
    desc:  'Estrai testo da qualsiasi URL (apify/web-scraper). Fallback news site. ~$0.001/pagina.',
    fn:    scrapeWebPage,
    defaultInput: { url: 'https://www.example.com' },
  },
]
