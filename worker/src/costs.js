// Trading costs portati dal frontend (TradingCosts.js)
const BROKERS = {
  fpmarkets_raw: {
    commissionPerLotPerSide: 3.5,
    spreads: {
      XAUUSD: 0.20, BTCUSD: 30, ETHUSD: 2.5,
      EURUSD: 0.00001, GBPUSD: 0.00002, USDJPY: 0.002, GBPJPY: 0.005,
      EURGBP: 0.00003, EURJPY: 0.004,
      US500: 0.4, NAS100: 0.7, USOIL: 0.03, DXY: 0.01,
    },
    slippageAtrPct: 0.02,
  },
  fpmarkets_standard: {
    commissionPerLotPerSide: 0,
    spreads: {
      XAUUSD: 0.40, BTCUSD: 50, ETHUSD: 4.5,
      EURUSD: 0.00010, GBPUSD: 0.00012, USDJPY: 0.012, GBPJPY: 0.020,
      EURGBP: 0.00015, EURJPY: 0.018,
      US500: 0.6, NAS100: 1.0, USOIL: 0.05, DXY: 0.02,
    },
    slippageAtrPct: 0.025,
  },
  zero_costs: { commissionPerLotPerSide: 0, spreads: {}, slippageAtrPct: 0 },
}

export function getCostInR(symbol, atr, slDist, brokerId = 'fpmarkets_raw') {
  if (!atr || !slDist) return 0
  const broker = BROKERS[brokerId] || BROKERS.fpmarkets_raw
  const spread = broker.spreads[symbol] ?? 0
  const slippage = (broker.slippageAtrPct || 0) * atr
  const priceCost = spread + slippage * 2
  const commissionRT = broker.commissionPerLotPerSide * 2
  const lotSize = symbol === 'XAUUSD' ? 100
                : symbol === 'BTCUSD' ? 1
                : symbol === 'USOIL'  ? 1000
                : 100000
  const commissionInPrice = commissionRT / lotSize
  const totalPriceCost = priceCost + commissionInPrice
  return totalPriceCost / slDist
}
