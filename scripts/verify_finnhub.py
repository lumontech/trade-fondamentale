"""Quick verification: trigger a candle load through the server logs and verify Finnhub is being used."""
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

print("=== pm2 logs (last 50 lines) — look for Finnhub/TD/Yahoo activity ===")
run("pm2 logs impact-trading-server --lines 50 --nostream 2>&1 | grep -E 'Finnhub|finnhub|\\[data\\]|cron|tick' | tail -30")

print()
print("=== Run a quick Node test to verify Finnhub fetcher works ===")
# Inline test as user 'root' via node -e
script = """
import('./src/finnhubDataSource.js').then(async m => {
  const key = process.env.FINNHUB_API_KEY;
  console.log('key present:', !!key);
  try {
    const out = await m.finnhubFetchCandles('EURUSD', '1h', key, 5);
    console.log('EURUSD 1h candles:', out.length, 'first:', JSON.stringify(out[0]));
  } catch (e) { console.error('FAIL:', e.message); }
  try {
    const out = await m.finnhubFetchCandles('XAUUSD', '1h', key, 5);
    console.log('XAUUSD 1h candles:', out.length, 'first:', JSON.stringify(out[0]));
  } catch (e) { console.error('FAIL:', e.message); }
}).catch(e => console.error('IMPORT FAIL:', e.message));
"""
run(f"cd /root/impact-trading-server && node --input-type=module -e \"$(cat <<'EOF'\n{script}\nEOF\n)\" 2>&1")

c.close()
