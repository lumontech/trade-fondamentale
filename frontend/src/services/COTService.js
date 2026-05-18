// COT (Commitment of Traders) — CFTC, pubblicato ogni venerdì alle 15:30 ET
// Dataset Legacy Futures Only: https://publicreporting.cftc.gov/resource/6dca-aqww.json
// CORS aperto, no key richiesta.
const CFTC_BASE = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'

// Mapping app symbol → CFTC contract_market_name (Legacy futures)
export const COT_CONTRACTS = {
  EURUSD: 'EURO FX',
  GBPUSD: 'BRITISH POUND STERLING',
  USDJPY: 'JAPANESE YEN',
  GBPJPY: null,                             // cross, non disponibile diretto
  XAUUSD: 'GOLD',
  USOIL:  'CRUDE OIL, LIGHT SWEET-WTI',
  US500:  'E-MINI S&P 500',
  NAS100: 'NASDAQ-100 STOCK INDEX (MINI)',
  DXY:    'USD INDEX - ICE FUTURES U.S.',
  BTCUSD: null,                             // BTC è in dataset Disaggregated, non Legacy
}

async function _fetchRows(contractName, limit = 2) {
  const where = `contract_market_name = '${contractName.replace(/'/g, "''")}'`
  const url = `${CFTC_BASE}?$where=${encodeURIComponent(where)}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`)
  return res.json()
}

/**
 * Fetcha il COT più recente per uno strumento.
 * Returns: { date, ncLong, ncShort, netNc, ncPctLong, change, sentiment }
 */
export async function fetchCOT(symbol) {
  const contract = COT_CONTRACTS[symbol]
  if (!contract) return null

  const rows = await _fetchRows(contract, 2)
  if (!rows.length) return null

  const cur  = rows[0]
  const prev = rows[1]

  const ncLong  = parseInt(cur.noncomm_positions_long_all, 10)  || 0
  const ncShort = parseInt(cur.noncomm_positions_short_all, 10) || 0
  const cLong   = parseInt(cur.comm_positions_long_all, 10)     || 0
  const cShort  = parseInt(cur.comm_positions_short_all, 10)    || 0

  const netNc   = ncLong - ncShort
  const totalNc = ncLong + ncShort
  const ncPctLong = totalNc > 0 ? ncLong / totalNc : 0.5

  // Variazione settimanale dei non-commercials net
  let change = null, changePct = null
  if (prev) {
    const prevNetNc = (parseInt(prev.noncomm_positions_long_all, 10) || 0) -
                      (parseInt(prev.noncomm_positions_short_all, 10) || 0)
    change = netNc - prevNetNc
    if (prevNetNc !== 0) changePct = (change / Math.abs(prevNetNc)) * 100
  }

  // Sentiment label
  let sentiment = 'NEUTRO'
  if (ncPctLong > 0.65) sentiment = 'MOLTO LONG'
  else if (ncPctLong > 0.55) sentiment = 'LONG'
  else if (ncPctLong < 0.35) sentiment = 'MOLTO SHORT'
  else if (ncPctLong < 0.45) sentiment = 'SHORT'

  return {
    date:       cur.report_date_as_yyyy_mm_dd?.slice(0, 10),
    contract,
    ncLong, ncShort, cLong, cShort,
    netNc,
    ncPctLong,
    change,
    changePct,
    sentiment,
  }
}

/**
 * Fetcha COT per tutti i simboli supportati. Restituisce { symbol: cotData }.
 */
export async function fetchAllCOT() {
  const symbols = Object.keys(COT_CONTRACTS).filter(s => COT_CONTRACTS[s])
  const result = {}
  await Promise.all(symbols.map(async s => {
    try { result[s] = await fetchCOT(s) }
    catch (err) { console.warn(`[COT] ${s}:`, err.message) }
  }))
  return result
}
