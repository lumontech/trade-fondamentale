// Mappa simboli interni -> ticker TradingView "EXCHANGE:SYMBOL".
//
// Logica:
//  - Forex/oro: OANDA (feed live broker reale, default su TradingView).
//  - Indici: TVC (TradingView Continuous) per i CFD-index live.
//  - Petrolio: TVC:USOIL.
//  - Crypto: BINANCE per le coppie USDT, BYBIT come fallback.
//  - HYPE: HYPERLIQUID nativo.
//
// Riferimento prefissi: https://www.tradingview.com/support/solutions/43000510245/
export const TV_SYMBOL = {
  // Forex maggiori + cross
  EURUSD: 'OANDA:EURUSD',
  GBPUSD: 'OANDA:GBPUSD',
  USDJPY: 'OANDA:USDJPY',
  GBPJPY: 'OANDA:GBPJPY',
  EURGBP: 'OANDA:EURGBP',
  EURJPY: 'OANDA:EURJPY',

  // Metalli / commodity / FX index
  XAUUSD: 'OANDA:XAUUSD',
  USOIL:  'TVC:USOIL',
  DXY:    'TVC:DXY',

  // Indici azionari
  US500:  'TVC:SPX',     // S&P 500 cash index
  NAS100: 'TVC:NDQ',     // NASDAQ 100

  // Crypto spot - Binance ha il book più liquido, default ovunque
  BTCUSD:   'BINANCE:BTCUSDT',
  BTCUSDC:  'BINANCE:BTCUSDC',
  ETHUSDC:  'BINANCE:ETHUSDC',
  SOLUSDC:  'BINANCE:SOLUSDC',
  XRPUSDC:  'BINANCE:XRPUSDC',
  BNBUSDC:  'BINANCE:BNBUSDC',

  // Hyperliquid native
  HYPEUSDC: 'HYPERLIQUID:HYPEUSDC',
}

// Risolve un simbolo interno (es "BTCUSD") al ticker TradingView completo.
// Se non c'è mapping, ritorna il simbolo passato (lascia decidere a TV).
export function toTVSymbol(symbol) {
  if (!symbol) return null
  return TV_SYMBOL[symbol] || symbol
}

// Mappa il timeframe interno (es '15m') all'intervallo TradingView.
// TradingView usa minuti come stringa: '1','5','15','60','240','D','W','M'.
export const TV_INTERVAL = {
  '1m':  '1',
  '5m':  '5',
  '15m': '15',
  '30m': '30',
  '1h':  '60',
  '4h':  '240',
  '1D':  'D',
  '1W':  'W',
  '1M':  'M',
}

export function toTVInterval(tf) {
  return TV_INTERVAL[tf] || '60'
}

// Lista simboli "macro" da mostrare nel Ticker Tape sotto header.
// Ordine: FX maggiori -> metalli -> petrolio -> crypto.
// Indici (TVC:SPX, TVC:NDQ, TVC:DXY) rimossi: richiedono account TradingView per la quotazione completa.
export const TV_TICKER_TAPE_SYMBOLS = [
  { proName: 'OANDA:EURUSD',      title: 'EUR/USD' },
  { proName: 'OANDA:GBPUSD',      title: 'GBP/USD' },
  { proName: 'OANDA:USDJPY',      title: 'USD/JPY' },
  { proName: 'OANDA:GBPJPY',      title: 'GBP/JPY' },
  { proName: 'OANDA:XAUUSD',      title: 'Gold' },
  { proName: 'TVC:USOIL',         title: 'WTI Oil' },
  { proName: 'BINANCE:BTCUSDT',   title: 'Bitcoin' },
  { proName: 'BINANCE:ETHUSDT',   title: 'Ethereum' },
]
