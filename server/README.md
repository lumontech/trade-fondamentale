# Impact Trading Server

Backend Node.js della simulazione paper trading 24/7. Gira su VPS Contabo (o qualsiasi Linux server).

## Stack

- **Hono** — HTTP framework leggero
- **better-sqlite3** — database file-based, zero setup
- **node-cron** — scheduler in-process per il tick ogni minuto
- **PM2** — process manager con auto-restart e log rotation
- **Caddy** — reverse proxy + HTTPS auto Let's Encrypt

## Struttura

```
server/
├── src/
│   ├── index.js        # entry: HTTP + cron
│   ├── sim.js          # simulator engine
│   ├── strategies.js   # 13 strategie (8 swing + 5 scalp)
│   ├── costs.js        # FP Markets pricing
│   ├── data.js         # Binance + TwelveData fetchers + cache
│   └── db.js           # SQLite adapter (D1-compatible)
├── migrations/
│   └── 0001_init.sql   # schema
├── deploy/
│   ├── bootstrap.sh    # setup VPS fresh
│   └── Caddyfile       # reverse proxy
├── ecosystem.config.cjs # PM2 config
└── data/               # SQLite db file (creato runtime)
```

## Deploy locale (test)

```bash
cd server
npm install
cp .env.example .env
# edita .env: aggiungi TWELVEDATA_API_KEY
npm run db:init
npm run start
```

Il server parte su `http://localhost:3000`. Test:
```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/start -H 'Content-Type: application/json' -d '{}'
curl http://localhost:3000/api/state | jq
```

## Deploy su VPS Contabo (Ubuntu 22.04)

### 1. Acquista VPS Contabo S
- ~€4.50/mese (1 anno commitment)
- Ubuntu 22.04
- Annota IP pubblico + password root

### 2. Bootstrap fresh server (come root)
```bash
ssh root@VPS_IP
# Carica bootstrap.sh:
curl -fsSL https://raw.githubusercontent.com/.../bootstrap.sh | bash
# OPPURE manualmente:
scp deploy/bootstrap.sh root@VPS_IP:/tmp/
ssh root@VPS_IP "bash /tmp/bootstrap.sh"
```

### 3. Deploy codice (come utente impact)
```bash
ssh impact@VPS_IP
cd ~/impact-trading-server
# Copia i file (rsync dal locale o git clone)
# Esempio rsync dal locale (esegui dal tuo computer):
#   rsync -avz --exclude node_modules --exclude data ./server/ impact@VPS_IP:~/impact-trading-server/

cp .env.example .env
nano .env   # aggiungi TWELVEDATA_API_KEY etc

npm ci --production
node src/db.js --init
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs   # verifica che parta
```

### 4. (Opzionale) Reverse proxy con dominio
```bash
sudo nano /etc/caddy/Caddyfile
# Sostituisci YOUR_DOMAIN con il tuo dominio (es. impact.duckdns.org)
sudo systemctl reload caddy
```

DuckDNS gratis: https://www.duckdns.org/ → punta il subdomain all'IP del VPS.

### 5. Update frontend
```bash
cd frontend
echo 'VITE_WORKER_URL=https://impact.tuodominio.com' >> .env.local
# Oppure http://VPS_IP:3000 se non hai dominio
npm run build
npm run dev
```

Apri **💰 Simulazione** → vedi badge "Worker LIVE · 24/7".

## API Endpoints

Identici al Worker Cloudflare:

| Method | Path | Cosa fa |
|---|---|---|
| GET  | `/api/health` | Ping |
| GET  | `/api/strategies` | Lista strategie |
| GET  | `/api/state` | Stato config + accounts |
| GET  | `/api/accounts/:key` | Detail singolo |
| POST | `/api/start` | Avvia (config nel body) |
| POST | `/api/stop` | Pausa |
| POST | `/api/resume` | Riprende |
| POST | `/api/reset` | Wipe completo |
| POST | `/api/tick` | Forza tick (debug) |

## Comandi PM2 utili

```bash
pm2 status              # stato process
pm2 logs                # log live
pm2 restart impact-trading-server
pm2 stop impact-trading-server
pm2 monit               # dashboard cli
pm2 save                # persisti config (sopravvive reboot)
```

## Costi totali stimati

| Voce | Costo |
|---|---|
| Contabo VPS S | €4.50/mese |
| Dominio (opzionale, Namecheap .com) | €10/anno |
| DuckDNS (alternativa gratis) | €0 |
| TwelveData API | €0 free tier |
| **Totale annuo** | **~€54-64** |
