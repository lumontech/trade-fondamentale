// Market hours filter — blocca apertura trade quando il mercato e' chiuso.
//
// Convenzione: tutti i timestamp in INPUT sono in secondi UTC.
//
// FOREX / XAU (oro):
//   Apertura: domenica 22:00 UTC (= apertura Sydney lunedi 9:00 AEDT in inverno EU)
//   Chiusura: venerdi 22:00 UTC (= chiusura New York 17:00 ET)
//   Sabato e parte domenica: CLOSED
//
// CRYPTO (BTC, ETH):
//   24/7 — sempre aperto
//
// INDICI USA (US500, NAS100, US30):
//   Lun-Ven, ~13:30-20:00 UTC (orari NYSE 9:30-16:00 ET)
//   Pre-market e after-hours non considerati per ora
//
// Riferimento: https://www.investopedia.com/articles/forex/05/markethours.asp

const FOREX_PAIRS = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'EURJPY', 'GBPJPY',
  'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'XAUUSD', 'XAGUSD',  // metalli preziosi seguono orari forex
  'USOIL', 'DXY',      // WTI crude e dollar index seguono orari forex (chiusi sab+dom UTC)
])

const CRYPTO_PAIRS = new Set([
  'BTCUSD', 'ETHUSD', 'BTCUSDT', 'ETHUSDT', 'SOLUSD', 'XRPUSD',
  // Hyperliquid USDC perpetual + native HYPE
  'BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'BNBUSDC', 'HYPEUSDC',
  'BNBUSD', 'HYPEUSD', 'USDT-USDC',
])

const INDEX_PAIRS = new Set([
  'US500', 'NAS100', 'US30', 'SPX500', 'NDX100', 'DJI30',
])

/**
 * @param {string} symbol  pair name (es. 'EURUSD', 'BTCUSD', 'XAUUSD')
 * @param {number} timestampSec  unix seconds (UTC)
 * @returns {{ open: boolean, reason?: string }}
 */
export function isMarketOpen(symbol, timestampSec) {
  // Crypto: sempre aperto
  if (CRYPTO_PAIRS.has(symbol)) return { open: true }

  const d = new Date(timestampSec * 1000)
  const day = d.getUTCDay()      // 0=Dom 1=Lun ... 5=Ven 6=Sab
  const hour = d.getUTCHours()

  // Forex / XAU: chiuso da Ven 22:00 UTC a Dom 22:00 UTC
  if (FOREX_PAIRS.has(symbol)) {
    // Sabato: tutto il giorno chiuso
    if (day === 6) return { open: false, reason: 'Forex closed Saturday' }
    // Venerdi dopo le 22:00 UTC: chiuso
    if (day === 5 && hour >= 22) return { open: false, reason: 'Forex closed Fri >=22:00 UTC' }
    // Domenica prima delle 22:00 UTC: chiuso
    if (day === 0 && hour < 22) return { open: false, reason: 'Forex closed Sun <22:00 UTC' }
    return { open: true }
  }

  // Indici USA: Lun-Ven 13:30-20:00 UTC (semplificato)
  if (INDEX_PAIRS.has(symbol)) {
    if (day === 0 || day === 6) return { open: false, reason: 'Index closed weekend' }
    // Lun-Ven: orari NYSE
    if (hour < 13 || hour >= 20) return { open: false, reason: 'Index closed outside RTH' }
    if (hour === 13 && d.getUTCMinutes() < 30) return { open: false, reason: 'Index pre-market' }
    return { open: true }
  }

  // Asset sconosciuto: assumiamo aperto (fail-open) — non bloccare strategie nuove
  return { open: true }
}

/**
 * Filtro inverso comodo per uso nelle strategie: ritorna true se BLOCCATO.
 */
export function isMarketClosed(symbol, timestampSec) {
  const r = isMarketOpen(symbol, timestampSec)
  return !r.open
}
