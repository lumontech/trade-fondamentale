// MacroRules — knowledge base in italiano delle regole macro fondamentali
// Mappa gli eventi del calendario Forex Factory alle interpretazioni di mercato.
// Ogni regola spiega cosa significa il dato e come tipicamente reagiscono gli asset.

/**
 * Regole macro principali. Ogni regola ha:
 * - patterns: array di stringhe per match nel title dell'evento (case insensitive)
 * - title: nome italiano breve
 * - timing: descrizione frequenza
 * - description: spiegazione cosa misura
 * - rule_higher_than_forecast: { explanation, asset_impact: { CURR/ASSET: 'up'/'down' } }
 * - rule_lower_than_forecast: idem opposto
 * - rule_rate_hike / rule_rate_cut: per decisioni tassi
 */
export const MACRO_RULES = [
  {
    id: 'nfp',
    patterns: ['non-farm employment change', 'non-farm payroll', 'nfp'],
    title: 'NFP — Non-Farm Payrolls (USA)',
    timing: 'Primo venerdì del mese, 14:30 IT',
    description:
      'Cambio dell\'occupazione non agricola USA. Indicatore chiave della salute del mercato del lavoro americano. Influenza profondamente le aspettative sui tassi Fed.',
    rule_higher_than_forecast: {
      explanation: 'Dato sopra le attese → economia USA forte → Fed può alzare/mantenere tassi alti → USD si rafforza',
      asset_impact: { USD: 'up', XAUUSD: 'down', EURUSD: 'down', GBPUSD: 'down', US500: 'mixed', BTCUSD: 'down' },
    },
    rule_lower_than_forecast: {
      explanation: 'Dato sotto le attese → economia rallenta → mercato si aspetta tagli Fed → USD si indebolisce',
      asset_impact: { USD: 'down', XAUUSD: 'up', EURUSD: 'up', GBPUSD: 'up', US500: 'up', BTCUSD: 'up' },
    },
  },
  {
    id: 'unemployment',
    patterns: ['unemployment rate'],
    title: 'Tasso di disoccupazione',
    timing: 'Mensile, di solito con NFP',
    description:
      'Percentuale di forza lavoro disoccupata. Più bassa = mercato del lavoro forte. Importante per Fed/ECB/BoE nelle decisioni sui tassi.',
    rule_higher_than_forecast: {
      explanation: 'Disoccupazione SOPRA le attese → economia debole → currency si indebolisce',
      asset_impact: { 'currency-quote': 'down', XAUUSD: 'up' },
    },
    rule_lower_than_forecast: {
      explanation: 'Disoccupazione SOTTO le attese → mercato del lavoro forte → currency si rafforza',
      asset_impact: { 'currency-quote': 'up', XAUUSD: 'down' },
    },
  },
  {
    id: 'cpi',
    patterns: ['cpi', 'consumer price index', 'inflation rate'],
    title: 'CPI — Inflazione',
    timing: 'Mensile, ~giorno 13-15 del mese, 14:30 IT (USA)',
    description:
      'Indice prezzi al consumo. Misura l\'inflazione percepita dai consumatori. Dato chiave per le banche centrali.',
    rule_higher_than_forecast: {
      explanation: 'Inflazione SOPRA le attese → banca centrale resta hawkish (tassi alti più a lungo) → currency si rafforza',
      asset_impact: { 'currency-quote': 'up', XAUUSD: 'mixed', US500: 'down', BTCUSD: 'down' },
    },
    rule_lower_than_forecast: {
      explanation: 'Inflazione SOTTO le attese → banca centrale può tagliare prima → currency si indebolisce, asset rischio salgono',
      asset_impact: { 'currency-quote': 'down', XAUUSD: 'up', US500: 'up', BTCUSD: 'up' },
    },
  },
  {
    id: 'core-cpi',
    patterns: ['core cpi', 'core inflation'],
    title: 'Core CPI (esclude cibo ed energia)',
    timing: 'Stesso giorno del CPI',
    description:
      'Inflazione "core", esclude voci volatili. Le banche centrali ci prestano più attenzione del CPI headline.',
    rule_higher_than_forecast: {
      explanation: 'Core CPI sopra forecast = inflazione persistente → Fed resta restrittiva',
      asset_impact: { USD: 'up', XAUUSD: 'down', US500: 'down' },
    },
    rule_lower_than_forecast: {
      explanation: 'Core CPI sotto forecast = pressione disinflazionistica → Fed può tagliare',
      asset_impact: { USD: 'down', XAUUSD: 'up', US500: 'up' },
    },
  },
  {
    id: 'fed-rate',
    patterns: ['federal funds rate', 'fomc statement', 'fed funds rate'],
    title: 'Decisione tassi Fed (FOMC)',
    timing: '8 volte l\'anno, mercoledì 20:00 IT, conferenza 20:30 IT',
    description:
      'La decisione più impattante per i mercati globali. Tassi Fed influenzano TUTTO: USD, oro, indici, crypto.',
    rule_rate_hike: {
      explanation: 'Tassi alzati → costo del denaro USD aumenta → USD forte, oro debole, indici sotto pressione',
      asset_impact: { USD: 'up', XAUUSD: 'down', US500: 'down', NAS100: 'down', BTCUSD: 'down' },
    },
    rule_rate_cut: {
      explanation: 'Tassi tagliati → liquidità → USD debole, asset rischio in rally, oro favorito',
      asset_impact: { USD: 'down', XAUUSD: 'up', US500: 'up', NAS100: 'up', BTCUSD: 'up' },
    },
    rule_hold_hawkish: {
      explanation: 'Tassi invariati ma tono hawkish (Powell aggressivo) → USD si rafforza comunque',
      asset_impact: { USD: 'up', XAUUSD: 'down', US500: 'down' },
    },
    rule_hold_dovish: {
      explanation: 'Tassi invariati ma tono dovish (apertura a tagli) → USD si indebolisce',
      asset_impact: { USD: 'down', XAUUSD: 'up', US500: 'up', BTCUSD: 'up' },
    },
  },
  {
    id: 'ecb-rate',
    patterns: ['main refinancing rate', 'ecb', 'monetary policy statement (eur)'],
    title: 'Decisione tassi BCE',
    timing: '8 volte l\'anno, giovedì 14:15 IT, conferenza 14:45 IT',
    description:
      'Decisione tassi della Banca Centrale Europea. Impatta direttamente l\'EUR e quindi tutte le coppie EUR.',
    rule_rate_hike: {
      explanation: 'BCE alza tassi → EUR si rafforza vs USD/GBP/JPY',
      asset_impact: { EUR: 'up', EURUSD: 'up', EURJPY: 'up' },
    },
    rule_rate_cut: {
      explanation: 'BCE taglia tassi → EUR si indebolisce',
      asset_impact: { EUR: 'down', EURUSD: 'down' },
    },
  },
  {
    id: 'boe-rate',
    patterns: ['boe', 'bank of england', 'official bank rate', 'mpc'],
    title: 'Decisione tassi BoE',
    timing: '8 volte l\'anno, giovedì 13:00 IT',
    description: 'Bank of England — tassi UK.',
    rule_rate_hike: { explanation: 'BoE alza → GBP forte', asset_impact: { GBP: 'up', GBPUSD: 'up', GBPJPY: 'up' } },
    rule_rate_cut: { explanation: 'BoE taglia → GBP debole', asset_impact: { GBP: 'down', GBPUSD: 'down' } },
  },
  {
    id: 'boj-rate',
    patterns: ['boj', 'bank of japan', 'monetary policy statement (jpy)'],
    title: 'Decisione tassi BoJ',
    timing: '8 volte l\'anno',
    description: 'Bank of Japan — storicamente ultra-dovish, ogni cambio di rotta è enorme.',
    rule_rate_hike: { explanation: 'BoJ alza tassi (raro) → JPY rally violento', asset_impact: { JPY: 'up', USDJPY: 'down', GBPJPY: 'down' } },
    rule_rate_cut: { explanation: 'BoJ accomodante → JPY debole', asset_impact: { JPY: 'down', USDJPY: 'up' } },
  },
  {
    id: 'gdp',
    patterns: ['gdp', 'gross domestic product', 'advance gdp', 'final gdp'],
    title: 'PIL — Prodotto Interno Lordo',
    timing: 'Trimestrale, 14:30 IT (USA)',
    description: 'Crescita economica trimestrale annualizzata.',
    rule_higher_than_forecast: {
      explanation: 'PIL sopra le attese → economia robusta → currency si rafforza',
      asset_impact: { 'currency-base': 'up' },
    },
    rule_lower_than_forecast: {
      explanation: 'PIL sotto le attese → economia rallenta → currency si indebolisce',
      asset_impact: { 'currency-base': 'down' },
    },
  },
  {
    id: 'retail-sales',
    patterns: ['retail sales', 'core retail sales'],
    title: 'Vendite al dettaglio',
    timing: 'Mensile, 14:30 IT (USA)',
    description: 'Spesa dei consumatori — driver principale dell\'economia USA (70% del PIL).',
    rule_higher_than_forecast: {
      explanation: 'Consumatori spendono di più → economia in salute → currency forte, indici positivi',
      asset_impact: { USD: 'up', US500: 'up', XAUUSD: 'down' },
    },
    rule_lower_than_forecast: {
      explanation: 'Spesa debole → segnale recessione → currency debole',
      asset_impact: { USD: 'down', US500: 'down', XAUUSD: 'up' },
    },
  },
  {
    id: 'pmi',
    patterns: ['pmi', 'ism manufacturing', 'ism services', 'manufacturing pmi', 'services pmi'],
    title: 'PMI — Purchasing Managers Index',
    timing: 'Mensile, ~16:00 IT (USA), 09:30-10:00 IT (Europa)',
    description:
      'Indice di sentiment dei direttori acquisti. Sopra 50 = espansione, sotto 50 = contrazione.',
    rule_higher_than_forecast: {
      explanation: 'PMI sopra forecast (specialmente sopra 50) → economia in espansione → currency forte',
      asset_impact: { 'currency-base': 'up', US500: 'up' },
    },
    rule_lower_than_forecast: {
      explanation: 'PMI sotto forecast (specialmente sotto 50) → contrazione → currency debole',
      asset_impact: { 'currency-base': 'down', XAUUSD: 'up' },
    },
  },
  {
    id: 'jobless-claims',
    patterns: ['unemployment claims', 'initial jobless claims', 'jobless claims'],
    title: 'Richieste sussidi disoccupazione USA',
    timing: 'Settimanale, ogni giovedì 14:30 IT',
    description: 'Numero di nuove richieste settimanali. Indicatore high-frequency del mercato del lavoro.',
    rule_higher_than_forecast: {
      explanation: 'Più richieste sopra forecast → mercato lavoro debole → USD si indebolisce',
      asset_impact: { USD: 'down', XAUUSD: 'up', US500: 'mixed' },
    },
    rule_lower_than_forecast: {
      explanation: 'Meno richieste sotto forecast → mercato lavoro robusto → USD si rafforza',
      asset_impact: { USD: 'up', XAUUSD: 'down' },
    },
  },
  {
    id: 'jolts',
    patterns: ['jolts', 'job openings'],
    title: 'JOLTS — Posti di lavoro vacanti',
    timing: 'Mensile, ~16:00 IT',
    description: 'Job Openings and Labor Turnover Survey. Più job openings = mercato del lavoro tirato.',
    rule_higher_than_forecast: {
      explanation: 'Più job openings sopra forecast → mercato tirato → Fed mantiene hawkish → USD up',
      asset_impact: { USD: 'up', XAUUSD: 'down' },
    },
    rule_lower_than_forecast: {
      explanation: 'Meno job openings → mercato del lavoro si raffredda → USD down',
      asset_impact: { USD: 'down', XAUUSD: 'up' },
    },
  },
  {
    id: 'ppi',
    patterns: ['ppi', 'producer price index'],
    title: 'PPI — Inflazione produttori',
    timing: 'Mensile, 14:30 IT (USA)',
    description: 'Misura l\'inflazione dal lato della produzione. Anticipa il CPI.',
    rule_higher_than_forecast: {
      explanation: 'PPI sopra forecast → inflazione si trasferirà al CPI → Fed hawkish → USD forte',
      asset_impact: { USD: 'up' },
    },
    rule_lower_than_forecast: {
      explanation: 'PPI sotto forecast → pressioni inflazionistiche calanti',
      asset_impact: { USD: 'down', XAUUSD: 'up' },
    },
  },
  {
    id: 'consumer-confidence',
    patterns: ['consumer confidence', 'cb consumer confidence', 'uom consumer sentiment', 'consumer sentiment'],
    title: 'Fiducia dei consumatori',
    timing: 'Mensile',
    description: 'Sondaggio sulla fiducia dei consumatori. Anticipa retail sales e GDP.',
    rule_higher_than_forecast: { explanation: 'Fiducia sopra forecast → spesa in arrivo → currency forte', asset_impact: { 'currency-base': 'up' } },
    rule_lower_than_forecast: { explanation: 'Fiducia sotto forecast → consumatori prudenti → currency debole', asset_impact: { 'currency-base': 'down' } },
  },
  {
    id: 'speaks',
    patterns: ['speaks', 'press conference', 'testifies'],
    title: 'Discorso governatore banca centrale',
    timing: 'Variabile',
    description: 'Discorsi/conferenze stampa di governatori (Powell, Lagarde, Bailey, Ueda). Possono muovere violentemente i mercati anche senza nuovi dati.',
    rule_hawkish: { explanation: 'Tono hawkish (preoccupazione inflazione, tassi alti più a lungo) → currency forte', asset_impact: { 'currency-base': 'up', XAUUSD: 'down' } },
    rule_dovish: { explanation: 'Tono dovish (preoccupazione crescita, apertura a tagli) → currency debole', asset_impact: { 'currency-base': 'down', XAUUSD: 'up' } },
  },
]

// Mapping currency → asset di base/quote per regole "currency-base" / "currency-quote"
const SYMBOL_BASE_QUOTE = {
  EURUSD: { base: 'EUR', quote: 'USD' },
  GBPUSD: { base: 'GBP', quote: 'USD' },
  USDJPY: { base: 'USD', quote: 'JPY' },
  GBPJPY: { base: 'GBP', quote: 'JPY' },
  EURJPY: { base: 'EUR', quote: 'JPY' },
  XAUUSD: { base: 'XAU', quote: 'USD' },
  USOIL:  { base: 'OIL', quote: 'USD' },
  US500:  { base: 'US500', quote: 'USD' },
  NAS100: { base: 'NAS100', quote: 'USD' },
  DXY:    { base: 'USD', quote: null },
  BTCUSD: { base: 'BTC', quote: 'USD' },
}

/**
 * Trova la regola macro che matcha un evento del calendario.
 * @param {Object} event - { title, currency, impact, ... }
 * @returns {Object|null} regola con interpretation
 */
export function findRuleForEvent(event) {
  if (!event?.title) return null
  const t = event.title.toLowerCase()
  for (const rule of MACRO_RULES) {
    for (const p of rule.patterns) {
      if (t.includes(p.toLowerCase())) return rule
    }
  }
  return null
}

/**
 * Restituisce l'impatto previsto dell'evento sull'asset corrente.
 * Direction: 'higher' (dato > forecast), 'lower' (dato < forecast), 'hike', 'cut', 'hawkish', 'dovish'
 */
export function getExpectedImpact(rule, direction, symbol) {
  if (!rule) return null
  const ruleKey =
    direction === 'higher' ? 'rule_higher_than_forecast' :
    direction === 'lower'  ? 'rule_lower_than_forecast' :
    direction === 'hike'   ? 'rule_rate_hike' :
    direction === 'cut'    ? 'rule_rate_cut' :
    direction === 'hawkish' ? (rule.rule_hawkish ? 'rule_hawkish' : 'rule_hold_hawkish') :
    direction === 'dovish'  ? (rule.rule_dovish  ? 'rule_dovish'  : 'rule_hold_dovish')  :
    null
  if (!ruleKey || !rule[ruleKey]) return null
  const impact = rule[ruleKey].asset_impact || {}
  const sb = SYMBOL_BASE_QUOTE[symbol]

  // Risolvi alias 'currency-base' e 'currency-quote'
  const resolved = {}
  for (const [k, v] of Object.entries(impact)) {
    if (k === 'currency-base' && sb?.base) resolved[sb.base] = v
    else if (k === 'currency-quote' && sb?.quote) resolved[sb.quote] = v
    else resolved[k] = v
  }

  // Quale impatto specifico per il symbol corrente?
  let specific = null
  if (resolved[symbol] != null) specific = resolved[symbol]
  else if (sb?.base && resolved[sb.base] != null) specific = resolved[sb.base]
  else if (sb?.quote && resolved[sb.quote] != null) specific = resolved[sb.quote]

  return {
    explanation: rule[ruleKey].explanation,
    all_assets:  resolved,
    on_symbol:   specific,
  }
}

/**
 * Sintesi di tutte le regole rilevanti per un set di eventi imminenti.
 * Usata per il ContextPack di Claude.
 */
export function getApplicableRules(events, symbol, now = new Date()) {
  const HOUR = 3600 * 1000
  const upcoming = events
    .filter(e => e.date > now && e.date - now < 24 * HOUR && (e.impact === 'High' || e.impact === 'Medium'))
    .slice(0, 5)

  const rules = []
  for (const e of upcoming) {
    const rule = findRuleForEvent(e)
    if (!rule) continue
    rules.push({
      event:      e.title,
      currency:   e.currency,
      hours:      Math.round((e.date - now) / HOUR * 10) / 10,
      rule_id:    rule.id,
      rule_title: rule.title,
      forecast:   e.forecast || null,
      previous:   e.previous || null,
      impact_if_higher: getExpectedImpact(rule, 'higher', symbol),
      impact_if_lower:  getExpectedImpact(rule, 'lower',  symbol),
    })
  }
  return rules
}
