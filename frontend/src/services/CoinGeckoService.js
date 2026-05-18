// CoinGecko global market data — Demo plan: 10k call/mese
const CG_BASE = 'https://api.coingecko.com/api/v3'

async function _cgGet(path, apiKey) {
  const url = `${CG_BASE}${path}`
  const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`CG HTTP ${res.status}`)
  return res.json()
}

// Returns: { btcDominance, totalMarketCap, change24h }
export async function fetchCGGlobal(apiKey) {
  const data = await _cgGet('/global', apiKey)
  const d = data.data
  return {
    btcDominance:    d.market_cap_percentage?.btc ?? null,
    ethDominance:    d.market_cap_percentage?.eth ?? null,
    totalMarketCap:  d.total_market_cap?.usd ?? null,
    change24h:       d.market_cap_change_percentage_24h_usd ?? null,
    activeCoins:     d.active_cryptocurrencies ?? null,
  }
}

// Fear & Greed Index — usa backend proxy del VPS che cache 30 min
// (sostituisce la chiamata diretta a alternative.me per consistenza e resilienza).
export async function fetchFearGreed() {
  try {
    const res = await fetch('/api/macro/fng', { credentials: 'include' })
    if (!res.ok) return null
    const data = await res.json()
    if (data.error || data.value == null) return null
    return {
      value:  data.value,
      label:  data.classification,
      ts:     Math.floor(data.timestamp / 1000),
    }
  } catch { return null }
}
