// News real-time tramite Finnhub.io — free 60 req/min, key richiesta
// https://finnhub.io/dashboard
const FINNHUB_BASE = 'https://finnhub.io/api/v1'

async function _fetch(path, apiKey) {
  if (!apiKey) throw new Error('FINNHUB_KEY_MISSING')
  const sep = path.includes('?') ? '&' : '?'
  const url = `${FINNHUB_BASE}${path}${sep}token=${apiKey}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`)
  return res.json()
}

/**
 * Categories: general | forex | crypto | merger
 * Returns array di { id, headline, summary, url, source, datetime, related, image, category }
 */
export async function fetchNewsByCategory(category, apiKey) {
  const data = await _fetch(`/news?category=${category}`, apiKey)
  return data.map(n => ({
    id:       n.id,
    headline: n.headline,
    summary:  n.summary,
    url:      n.url,
    source:   n.source,
    image:    n.image,
    related:  n.related || '',
    category,
    date:     new Date(n.datetime * 1000),
  }))
}

/**
 * Fetcha news per più categorie e merge in unica lista ordinata per data.
 */
export async function fetchAllNews(apiKey, categories = ['general', 'forex', 'crypto']) {
  const results = await Promise.allSettled(
    categories.map(c => fetchNewsByCategory(c, apiKey))
  )
  const merged = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)

  // Dedupa per id
  const seen = new Set()
  const dedup = merged.filter(n => {
    if (seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })
  return dedup.sort((a, b) => b.date - a.date)
}

// Estrae le valute/asset menzionate nell'headline per filtraggio rapido
const ASSET_PATTERNS = [
  { match: /\b(USD|Dollar|Federal Reserve|Fed|FOMC)\b/i,    tag: 'USD' },
  { match: /\b(EUR|Euro|ECB|Lagarde)\b/i,                   tag: 'EUR' },
  { match: /\b(GBP|Pound|Sterling|BoE|Bank of England)\b/i, tag: 'GBP' },
  { match: /\b(JPY|Yen|BoJ|Bank of Japan)\b/i,              tag: 'JPY' },
  { match: /\b(CHF|Swiss|SNB)\b/i,                          tag: 'CHF' },
  { match: /\b(AUD|Aussie|RBA)\b/i,                         tag: 'AUD' },
  { match: /\b(CAD|Loonie|BoC)\b/i,                         tag: 'CAD' },
  { match: /\b(NZD|Kiwi|RBNZ)\b/i,                          tag: 'NZD' },
  { match: /\b(Gold|XAU)\b/i,                               tag: 'XAU' },
  { match: /\b(Oil|WTI|Brent|Crude)\b/i,                    tag: 'OIL' },
  { match: /\b(BTC|Bitcoin)\b/i,                            tag: 'BTC' },
  { match: /\b(ETH|Ethereum)\b/i,                           tag: 'ETH' },
  { match: /\b(S&P|SPX|S&P 500)\b/i,                        tag: 'SPX' },
  { match: /\b(Nasdaq|NDX)\b/i,                             tag: 'NDX' },
]

export function extractTags(text) {
  if (!text) return []
  const tags = []
  for (const p of ASSET_PATTERNS) {
    if (p.match.test(text) && !tags.includes(p.tag)) tags.push(p.tag)
  }
  return tags
}

// Sentiment basato su keyword (semplice, non perfetto, ma utile)
const POS_WORDS = /\b(rally|surge|jump|gain|rise|boost|bullish|optimism|strong|hawkish|tighten|raise)\b/i
const NEG_WORDS = /\b(plunge|tumble|crash|fall|drop|decline|bearish|fear|weak|dovish|cut|recession|crisis)\b/i

export function quickSentiment(text) {
  if (!text) return 0
  const pos = (text.match(POS_WORDS) || []).length
  const neg = (text.match(NEG_WORDS) || []).length
  if (pos === 0 && neg === 0) return 0
  return (pos - neg) / (pos + neg)   // [-1, +1]
}
