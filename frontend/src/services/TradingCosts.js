// Trading costs - calibrati su dati pubblici FP Markets Raw ECN 2026
//
// FONTI VERIFICATE (May 2026):
// - FP Markets Review Forex.com: EURUSD avg 0.0-0.1 pip, commission $3.5/side
// - Myfxbook FP Markets: BTCUSD total cost ~$19 (= ~$12 spread + $7 commission)
// - FP Markets XAUUSD: 7.19 points spread + $6 commission = $13.19/lot total
// - Forexbrokers.com: Raw ECN, 24/7 multilingual, regulated
//
// IMPORTANTE: "from 0.0 pips" e marketing - average reale e 0.0-0.4 pip su forex maggiori,
// con explosion 5-10x durante news/sessioni illiquide. Modello qui usa AVERAGE realistico.
export const BROKERS = {
  fpmarkets_raw: {
    commissionPerLotPerSide: 3.5,
    spreads: {
      // Forex maggiori: average 0.0-0.1 pip Raw ECN
      EURUSD: 0.00001,    // 0.1 pip
      GBPUSD: 0.00002,    // 0.2 pip avg
      USDJPY: 0.001,      // 0.1 pip in JPY units (1 pip = 0.01)
      GBPJPY: 0.003,      // 0.3 pip cross
      EURGBP: 0.00002,    // 0.2 pip
      EURJPY: 0.002,      // 0.2 pip
      // Commodities (corretti dai dati Myfxbook)
      XAUUSD: 0.072,      // 7.19 points = $0.0719/oz (era 0.20, sovrastimato 2.8x)
      USOIL:  0.025,
      // Crypto CFD (corretto da $19 total cost - $7 commission)
      BTCUSD: 12,         // $12 spread (era $30, sovrastimato 2.5x)
      ETHUSD: 1.5,
      // Indici
      US500:  0.3,        // 0.3 punti
      NAS100: 0.6,
      DXY:    0.005,
    },
    slippageAtrPct: 0.015,   // 1.5% ATR (era 2%, leggermente conservativo)
  },
  fpmarkets_standard: {
    commissionPerLotPerSide: 0,
    spreads: {
      // Standard = Raw spread + ~1 pip markup, no commission
      EURUSD: 0.00010, GBPUSD: 0.00012, USDJPY: 0.010, GBPJPY: 0.018,
      EURGBP: 0.00012, EURJPY: 0.014,
      XAUUSD: 0.30, USOIL: 0.05,
      BTCUSD: 22, ETHUSD: 3,
      US500: 0.5, NAS100: 0.9, DXY: 0.012,
    },
    slippageAtrPct: 0.02,
  },
  binance_futures: {
    // Per futuro multi-broker: BTC su Binance perp invece che FP Markets CFD
    commissionPerLotPerSide: 0,    // commission e in % sul notional, gestita separatamente
    feePctMaker: 0.0002,            // 0.02% maker
    feePctTaker: 0.0004,            // 0.04% taker
    spreads: {
      BTCUSD: 0.5,    // Binance perp orderbook spread very tight
      ETHUSD: 0.05,
    },
    slippageAtrPct: 0.01,
  },
  zero_costs: { commissionPerLotPerSide: 0, spreads: {}, slippageAtrPct: 0 },
}

export function getCostInR(symbol, atr, slDist, brokerId = 'fpmarkets_raw') {
  if (!atr || !slDist) return 0
  const broker = BROKERS[brokerId] || BROKERS.fpmarkets_raw

  const spread = broker.spreads[symbol] ?? 0
  const slippage = (broker.slippageAtrPct || 0) * atr
  const priceCost = spread + slippage * 2

  // Commission: per FP Markets e flat per lot, per Binance e in % sul notional
  let commissionInPrice = 0
  if (broker.feePctTaker) {
    // Modello Binance: % sul notional, equivalente in price = price × fee × 2 sides
    // Approssimazione: stima del prezzo dall'ATR (ATR ~ 0.5-1% del prezzo)
    const estPrice = atr / 0.005   // se ATR e 0.5% del prezzo
    commissionInPrice = estPrice * (broker.feePctTaker + broker.feePctMaker)
  } else {
    const commissionRT = broker.commissionPerLotPerSide * 2
    const lotSize = symbol === 'XAUUSD' ? 100
                  : symbol === 'BTCUSD' ? 1
                  : symbol === 'USOIL'  ? 1000
                  : 100000
    commissionInPrice = commissionRT / lotSize
  }

  const totalPriceCost = priceCost + commissionInPrice
  return totalPriceCost / slDist
}

// Backward-compat exports per frontend
export function getTradeCosts(symbol, entry, atr, slDist, brokerId = 'fpmarkets_raw') {
  const broker = BROKERS[brokerId] || BROKERS.fpmarkets_raw
  const spread     = broker.spreads[symbol] ?? 0
  const slippage   = (broker.slippageAtrPct || 0) * atr
  const priceCost  = spread + slippage * 2
  let commissionInPrice = 0
  if (broker.feePctTaker) {
    const estPrice = atr / 0.005
    commissionInPrice = estPrice * (broker.feePctTaker + broker.feePctMaker)
  } else {
    const commissionRT = broker.commissionPerLotPerSide * 2
    const lotSize = symbol === 'XAUUSD' ? 100 : symbol === 'BTCUSD' ? 1 : symbol === 'USOIL' ? 1000 : 100000
    commissionInPrice = commissionRT / lotSize
  }
  const totalPriceCost = priceCost + commissionInPrice
  return {
    spreadInPrice: spread,
    slippageInPrice: slippage * 2,
    commissionInPrice,
    totalPriceCost,
    totalRCost: slDist > 0 ? totalPriceCost / slDist : 0,
  }
}

export function listBrokers() {
  const labels = {
    fpmarkets_raw:      { label: 'FP Markets · Raw ECN',      description: 'Raw ECN, $3.5/lot/side commission, spread realistici 2026' },
    fpmarkets_standard: { label: 'FP Markets · Standard',     description: 'No commission, spread maggiorato ~1 pip' },
    binance_futures:    { label: 'Binance Futures (perp)',    description: '0.04% taker / 0.02% maker, spread orderbook tight' },
    zero_costs:         { label: 'Zero (test ideale)',        description: 'Senza spread/commission - risultato teorico' },
  }
  return Object.entries(BROKERS).map(([id]) => ({ id, ...(labels[id] || { label: id, description: '' }) }))
}

