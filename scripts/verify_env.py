import os, sys, io
import paramiko
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd):
    _, stdout, _ = c.exec_command(cmd)
    out = stdout.read().decode(errors="replace")
    if out: print(out.rstrip())

print("=== .env keys (names only, values masked) ===")
run("grep -E '^[A-Z_]+=' /root/impact-trading-server/.env | sed 's/=.*/=***/'")

print()
print("=== Test Finnhub from within server cwd with --env-file ===")
# Newer Node (>=20) supports --env-file=.env
run("cd /root/impact-trading-server && node --env-file=.env --input-type=module -e \""
    "import('./src/finnhubDataSource.js').then(async m => { "
    "const out = await m.finnhubFetchCandles('EURUSD','1h',process.env.FINNHUB_API_KEY,3); "
    "console.log('EURUSD 1h:', out.length, 'first:', JSON.stringify(out[0])); "
    "}).catch(e=>console.error('ERR:', e.message));\" 2>&1")

print()
print("=== Check via the running pm2 process: pm2 env ===")
run("pm2 env 0 2>&1 | grep -E '^(FINNHUB|TWELVE)' | sed 's/=.*/=***SET***/'")

c.close()
