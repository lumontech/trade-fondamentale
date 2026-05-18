// SocialSentiment — aggrega tweet + Reddit post per asset attivo,
// estrae bias bullish/bearish con keyword-based scoring (gratis, lato client).
// Non usa LLM per questo: il sentiment scoring è deterministico e veloce.
import { scrapeTwitter, scrapeRedditFinance } from './ApifyService'

// ── Keyword classifier ─────────────────────────────────────────────
const BULL_KW = [
  'long', 'buy', 'breakout', 'bullish', 'pump', 'moon', 'rally', 'support', 'bounce',
  'oversold', 'accumulation', 'rip', 'send it', 'green', 'up only', 'higher', 'rip',
  'targets', 'tp hit', 'mooning', 'going up', 'all time high', 'ath', 'rip',
]
const BEAR_KW = [
  'short', 'sell', 'breakdown', 'bearish', 'dump', 'crash', 'reject', 'resistance',
  'overbought', 'distribution', 'puts', 'red', 'lower', 'lower high', 'lower low',
  'capitulation', 'liquidation', 'rug', 'rekt', 'going down', 'death cross',
]

function scoreText(text = '') {
  const lower = text.toLowerCase()
  let bull = 0, bear = 0
  for (const k of BULL_KW) if (lower.includes(k)) bull++
  for (const k of BEAR_KW) if (lower.includes(k)) bear++
  if (bull + bear === 0) return { score: 0, bias: 'neutral' }
  const score = (bull - bear) / (bull + bear)   // -1..1
  const bias = score > 0.2 ? 'bullish' : score < -0.2 ? 'bearish' : 'neutral'
  return { score, bias, bullKw: bull, bearKw: bear }
}

// ── Symbol → query mapping ─────────────────────────────────────────
const SYMBOL_QUERIES = {
  XAUUSD: { twitter: '$XAU OR XAUUSD OR gold price',  reddit: 'XAUUSD OR gold',
            handles: ['ForexLive', 'goldpriceforecast', 'KitcoMetals'],
            subreddits: ['Forex', 'Gold'] },
  BTCUSD: { twitter: '$BTC OR Bitcoin price',          reddit: 'BTC OR Bitcoin',
            handles: ['BTC_Archive', 'WhalePanda', 'PeterLBrandt'],
            subreddits: ['CryptoCurrency', 'Bitcoin'] },
  EURUSD: { twitter: '$EURUSD OR EURUSD',              reddit: 'EURUSD',
            handles: ['ForexLive', 'KathyLienFX'],
            subreddits: ['Forex'] },
  GBPUSD: { twitter: '$GBPUSD OR cable',               reddit: 'GBPUSD',
            handles: ['ForexLive'],
            subreddits: ['Forex'] },
  USDJPY: { twitter: '$USDJPY OR yen',                 reddit: 'USDJPY',
            handles: ['ForexLive'],
            subreddits: ['Forex'] },
  US500:  { twitter: '$SPX OR S&P 500',                reddit: 'SPX OR SP500',
            handles: ['zerohedge', 'GuruFocus'],
            subreddits: ['stocks', 'wallstreetbets'] },
  NAS100: { twitter: '$NDX OR Nasdaq',                  reddit: 'NDX',
            handles: ['zerohedge'],
            subreddits: ['stocks', 'wallstreetbets'] },
}

/**
 * Recupera + analizza sentiment social per un simbolo.
 * @returns {Object} { twitter: {...}, reddit: {...}, overall: {...} } o null
 */
export async function fetchSocialSentiment(symbol, apifyToken, opts = {}) {
  const cfg = SYMBOL_QUERIES[symbol]
  if (!cfg || !apifyToken) return null

  const { tweetLimit = 30, redditLimit = 30 } = opts

  // Lancia in parallelo
  const [twResult, rdResult] = await Promise.allSettled([
    scrapeTwitter(apifyToken, { query: cfg.twitter, handles: cfg.handles, limit: tweetLimit }),
    scrapeRedditFinance(apifyToken, { query: cfg.reddit, subreddits: cfg.subreddits, limit: redditLimit }),
  ])

  const twitter = twResult.status === 'fulfilled' ? processTweets(twResult.value.tweets) : null
  const reddit  = rdResult.status === 'fulfilled' ? processReddit(rdResult.value.posts)  : null

  const errors = []
  if (twResult.status === 'rejected') errors.push(`Twitter: ${twResult.reason?.message}`)
  if (rdResult.status === 'rejected') errors.push(`Reddit: ${rdResult.reason?.message}`)

  // Aggregato
  let overall = null
  if (twitter && reddit) {
    const totalBull = twitter.bullCount + reddit.bullCount
    const totalBear = twitter.bearCount + reddit.bearCount
    const total = totalBull + totalBear
    const score = total > 0 ? (totalBull - totalBear) / total : 0
    overall = {
      bias:  score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral',
      score: Math.round(score * 100) / 100,
      bullCount: totalBull,
      bearCount: totalBear,
      sampleSize: (twitter.sampleSize || 0) + (reddit.sampleSize || 0),
    }
  }

  return { symbol, twitter, reddit, overall, errors: errors.length ? errors : null }
}

function processTweets(tweets = []) {
  if (tweets.length === 0) return null
  let bull = 0, bear = 0, neutral = 0, totalScore = 0, weightedScore = 0, totalWeight = 0
  const topTweets = []
  for (const t of tweets) {
    const s = scoreText(t.text)
    if (s.bias === 'bullish')      bull++
    else if (s.bias === 'bearish') bear++
    else                            neutral++
    totalScore += s.score
    // Peso per engagement (likes + retweets)
    const w = Math.log10((t.likes || 0) + (t.retweets || 0) * 2 + 1)
    weightedScore += s.score * w
    totalWeight   += w
    topTweets.push({ ...t, sentimentScore: s.score, bias: s.bias })
  }
  topTweets.sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
  const avgScore = tweets.length > 0 ? totalScore / tweets.length : 0
  const wAvg = totalWeight > 0 ? weightedScore / totalWeight : avgScore
  return {
    sampleSize:     tweets.length,
    bullCount:      bull,
    bearCount:      bear,
    neutralCount:   neutral,
    avgScore:       Math.round(avgScore * 100) / 100,
    weightedScore:  Math.round(wAvg * 100) / 100,
    bias:           wAvg > 0.15 ? 'bullish' : wAvg < -0.15 ? 'bearish' : 'neutral',
    topTweets:      topTweets.slice(0, 5),
  }
}

function processReddit(posts = []) {
  if (posts.length === 0) return null
  let bull = 0, bear = 0, neutral = 0, totalScore = 0, weightedScore = 0, totalWeight = 0
  const topPosts = []
  for (const p of posts) {
    const text = `${p.title} ${p.body || ''}`
    const s = scoreText(text)
    if (s.bias === 'bullish')      bull++
    else if (s.bias === 'bearish') bear++
    else                            neutral++
    totalScore += s.score
    const w = Math.log10((p.score || 0) + (p.comments || 0) + 1)
    weightedScore += s.score * w
    totalWeight   += w
    topPosts.push({ ...p, sentimentScore: s.score, bias: s.bias })
  }
  topPosts.sort((a, b) => (b.score || 0) - (a.score || 0))
  const avgScore = posts.length > 0 ? totalScore / posts.length : 0
  const wAvg = totalWeight > 0 ? weightedScore / totalWeight : avgScore
  return {
    sampleSize:    posts.length,
    bullCount:     bull,
    bearCount:     bear,
    neutralCount:  neutral,
    avgScore:      Math.round(avgScore * 100) / 100,
    weightedScore: Math.round(wAvg * 100) / 100,
    bias:          wAvg > 0.15 ? 'bullish' : wAvg < -0.15 ? 'bearish' : 'neutral',
    topPosts:      topPosts.slice(0, 5),
  }
}

/**
 * Sintesi compatta per ContextPack (token-efficient).
 */
export function summarizeSocialForClaude(sentiment) {
  if (!sentiment) return null
  const out = { symbol: sentiment.symbol }
  if (sentiment.overall) {
    out.overall_bias = sentiment.overall.bias
    out.overall_score = sentiment.overall.score
    out.sample_size = sentiment.overall.sampleSize
  }
  if (sentiment.twitter) {
    out.twitter = {
      bias:    sentiment.twitter.bias,
      score:   sentiment.twitter.weightedScore,
      sample:  sentiment.twitter.sampleSize,
      bull:    sentiment.twitter.bullCount,
      bear:    sentiment.twitter.bearCount,
    }
  }
  if (sentiment.reddit) {
    out.reddit = {
      bias:   sentiment.reddit.bias,
      score:  sentiment.reddit.weightedScore,
      sample: sentiment.reddit.sampleSize,
      bull:   sentiment.reddit.bullCount,
      bear:   sentiment.reddit.bearCount,
    }
  }
  return out
}
