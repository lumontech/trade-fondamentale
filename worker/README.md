# Impact Trading Worker

Cloudflare Worker che gira la simulazione paper trading 24/7. Sostituisce il `LiveSimulator.js` del frontend (browser-only) con un servizio always-on che continua a girare anche se chiudi Chrome.

## Architettura

- **Cron trigger** ogni minuto → polling candele live + processing strategie
- **D1** (SQLite serverless) per persistenza stato
- **REST API** consumata dal frontend per leggere/controllare la simulazione
- **Cache candele** condivisa per ridurre chiamate API

## Stack

| Layer | Tool | Costo |
|---|---|---|
| Runtime | Cloudflare Workers (Free 100k req/giorno, poi $5/mo) | $0-5/mo |
| Database | Cloudflare D1 (Free 5GB) | $0 |
| Cron | CF Cron Triggers (incluso) | $0 |
| Secrets | CF Secrets (incluso) | $0 |

## Deploy (5 step)

### 1. Installa wrangler

```bash
cd worker
npm install
```

### 2. Login a Cloudflare

```bash
npx wrangler login
```

(apre browser per OAuth con il tuo account `Lumon.info@gmail.com`)

### 3. Crea il database D1

```bash
npx wrangler d1 create impact_trading
```

Output mostrerà qualcosa tipo:
```
✅ Successfully created DB 'impact_trading'
[[d1_databases]]
binding = "DB"
database_name = "impact_trading"
database_id = "abc123-def456-..."
```

**Copia il `database_id`** e sostituisci `REPLACE_AFTER_D1_CREATE` in `wrangler.toml`.

### 4. Inizializza schema D1

```bash
npm run db:init
```

(esegue le migrations su `impact_trading` remoto)

### 5. Set secrets TwelveData

```bash
npx wrangler secret put TWELVEDATA_API_KEY
# incolla la chiave quando chiede
npx wrangler secret put TWELVEDATA_API_KEY_2
# (opzionale, seconda key per rotazione)
```

### 6. Deploy

```bash
npm run deploy
```

Output: `Deployed to https://impact-trading-worker.your-subdomain.workers.dev`

### 7. Configura il frontend

```bash
cd ../frontend
cp .env.example .env.local
# edita .env.local mettendo VITE_WORKER_URL=https://impact-trading-worker.your-subdomain.workers.dev
npm run dev
```

Apri il pannello **💰 Simulazione** → vedrai badge "**Worker LIVE · 24/7**" in header.

## Test rapido

```bash
# Health check
curl https://impact-trading-worker.YOUR.workers.dev/api/health
# → {"ok":true,"ts":1234567890123}

# Avvia simulazione con defaults
curl -X POST https://impact-trading-worker.YOUR.workers.dev/api/start \
  -H "Content-Type: application/json" \
  -d '{}'

# Triggera tick manuale (per debug, non aspettare 1 min)
curl -X POST https://impact-trading-worker.YOUR.workers.dev/api/tick

# Leggi stato
curl https://impact-trading-worker.YOUR.workers.dev/api/state | jq
```

## Logging

```bash
npm run tail
```

streams real-time logs inclusi i tick del cron.

## Endpoints

| Method | Path | Cosa fa |
|---|---|---|
| GET  | `/api/health` | Ping |
| GET  | `/api/strategies` | Lista strategie disponibili |
| GET  | `/api/state` | Stato config + tutti gli account |
| GET  | `/api/accounts/:key` | Detail singolo account + trade + equity |
| POST | `/api/start` | Avvia con config nel body (vuoto = defaults) |
| POST | `/api/stop` | Pausa (preserva stato) |
| POST | `/api/resume` | Riprende |
| POST | `/api/reset` | Wipe completo |
| POST | `/api/tick` | Forza un tick (debug) |

## Configurazione default `/api/start`

```json
{
  "pairs": ["XAUUSD","BTCUSD","EURUSD","GBPUSD","USDJPY","GBPJPY","EURGBP","EURJPY"],
  "swing_strategies": ["emaCross","rsiReversion","rsiBB","donchian","smcSweep","wyckoffSpring","macdTrend","insideBar"],
  "scalp_strategies": ["ema921","vwap","bbReversal","liqSweep","threeBarRev"],
  "swing_tf": "4h",
  "scalp_tf": "15m",
  "starting_balance": 1000,
  "risk_pct": 1,
  "compounding": true,
  "broker_id": "fpmarkets_raw"
}
```

## Limiti attuali

- Pattern detection (candlestick/chart/harmonic) NON portati ancora — solo strategie indicator-based
- Detector SMC/Wyckoff sono versioni semplificate
- Cache candele TTL 50s (ottimo per polling 60s, ma se cambi cron a >5min serve aumentare TTL)
- Daily reset rate limit TwelveData gestito server-side ma non visibile in UI ancora

## Troubleshooting

**Tick fa errori "TwelveData API key mancante"**
→ Set secrets via `wrangler secret put`

**D1 query lente**
→ Le query d'analisi su grossi dataset (>10k trades) possono saturare il limite 50ms del Worker. Ottimizzazioni necessarie a >100 strategie attive.

**Cron non scatta**
→ Cron trigger ha latenza fino a ~60s. Verifica `wrangler tail` per vedere i log scheduled().
