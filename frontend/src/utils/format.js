// Price formatting by instrument type
const PRICE_CONFIG = {
  BTCUSD:  { decimals: 2, prefix: '$' },
  XAUUSD:  { decimals: 2, prefix: '$' },
  EURUSD:  { decimals: 5, prefix: '' },
  GBPUSD:  { decimals: 5, prefix: '' },
  USDJPY:  { decimals: 3, prefix: '' },
  GBPJPY:  { decimals: 3, prefix: '' },
  US500:   { decimals: 2, prefix: '$' },  // SPY ETF proxy
  NAS100:  { decimals: 2, prefix: '$' },  // QQQ ETF proxy
  USOIL:   { decimals: 2, prefix: '$' },  // USO ETF proxy
  DXY:     { decimals: 2, prefix: '$' },  // UUP ETF proxy
}

export function formatPrice(symbol, price) {
  if (price == null || isNaN(price)) return '—'
  const cfg = PRICE_CONFIG[symbol] || { decimals: 4, prefix: '' }
  return cfg.prefix + Number(price).toFixed(cfg.decimals)
}

export function formatPct(pct) {
  if (pct == null || isNaN(pct)) return '—'
  const sign = pct >= 0 ? '+' : ''
  return sign + pct.toFixed(2) + '%'
}

export function formatChange(symbol, change) {
  if (change == null || isNaN(change)) return '—'
  const cfg = PRICE_CONFIG[symbol] || { decimals: 4, prefix: '' }
  const sign = change >= 0 ? '+' : ''
  return sign + Number(change).toFixed(cfg.decimals)
}

export function formatVolume(vol) {
  if (vol == null || isNaN(vol)) return '—'
  if (vol >= 1e9) return (vol / 1e9).toFixed(2) + 'B'
  if (vol >= 1e6) return (vol / 1e6).toFixed(2) + 'M'
  if (vol >= 1e3) return (vol / 1e3).toFixed(2) + 'K'
  return vol.toFixed(2)
}

export function nowUTC() {
  return new Date().toUTCString().slice(17, 25)
}

// Pip size per simbolo (1 pip = quanto in price units)
const PIP_SIZE = {
  EURUSD: 0.0001, GBPUSD: 0.0001, EURGBP: 0.0001,
  USDJPY: 0.01,   GBPJPY: 0.01,   EURJPY: 0.01,
  XAUUSD: 0.10,   XAGUSD: 0.01,
  USOIL:  0.01,
  BTCUSD: 1.0, ETHUSD: 0.10,
  BTCUSDC: 1.0, ETHUSDC: 0.10, SOLUSDC: 0.01,
  XRPUSDC: 0.0001, BNBUSDC: 0.10, HYPEUSDC: 0.001,
  US500: 0.1, NAS100: 0.1, DXY: 0.01,
}

/**
 * Converte una distanza prezzo in pips per il simbolo dato.
 * @param {string} symbol
 * @param {number} priceDistance  es. (currentPrice - entry)
 * @returns {number} pips (può essere negativo)
 */
export function priceToPips(symbol, priceDistance) {
  if (priceDistance == null || isNaN(priceDistance)) return null
  const pipSize = PIP_SIZE[symbol] || 0.0001
  return priceDistance / pipSize
}

export function formatPips(symbol, priceDistance) {
  const pips = priceToPips(symbol, priceDistance)
  if (pips == null) return '—'
  const abs = Math.abs(pips)
  const sign = pips > 0 ? '+' : pips < 0 ? '-' : ''
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k pip`
  if (abs >= 100) return `${sign}${abs.toFixed(0)} pip`
  return `${sign}${abs.toFixed(1)} pip`
}
