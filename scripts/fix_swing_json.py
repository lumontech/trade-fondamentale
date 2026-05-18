"""Ricostruisce swing_strategies JSON corretto via file temp."""
import os, sys, io, json, time
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

# La lista corretta che vogliamo
strategies = [
    "emaCross","rsiReversion","rsiBB","donchian","smcSweep","wyckoffSpring",
    "macdTrend","insideBar","failedBkMajor","mssChoCH","tripleBarTrap",
    "confluenceTracker"
]
json_str = json.dumps(strategies)
print(f"Target JSON: {json_str}")

# Scrivi uno script SQL su VPS via SFTP
sql_content = f"UPDATE sim_config SET swing_strategies = '{json_str}' WHERE id = 1;\n"
sftp = c.open_sftp()
with sftp.open('/tmp/fix_swing.sql', 'w') as f:
    f.write(sql_content)
sftp.close()
print("SQL script uploaded to /tmp/fix_swing.sql")

def run(cmd):
    print(f"[ssh] $ {cmd}")
    _, so, _ = c.exec_command(cmd)
    out = so.read().decode('utf-8', errors='replace').rstrip()
    if out: print(out)
    return out

run("cat /tmp/fix_swing.sql")
run("sqlite3 /root/impact-trading-server/data/impact.db < /tmp/fix_swing.sql")
print()
out = run("sqlite3 /root/impact-trading-server/data/impact.db 'SELECT swing_strategies FROM sim_config WHERE id = 1;'")
# Verifica parsabile
try:
    parsed = json.loads(out)
    print(f"OK: parsed {len(parsed)} strategies, includes confluenceTracker: {'confluenceTracker' in parsed}")
except Exception as e:
    print(f"FAIL parse: {e}")

print("\n=== Restart pm2 ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

print("\n=== Wait 12s, count new accounts ===")
time.sleep(12)
out = run("sqlite3 /root/impact-trading-server/data/impact.db \"SELECT COUNT(*), GROUP_CONCAT(DISTINCT symbol) FROM sim_accounts WHERE profile_id = 1 AND strategy_id = 'confluenceTracker';\"")
print(f"confluenceTracker accounts: {out}")

print("\n=== pm2 logs ===")
run("pm2 logs impact-trading-server --lines 30 --nostream 2>&1 | grep -E 'avviato|init|confluence|account|error|SyntaxError' | tail -15")

c.close()
print("\n=== DONE ===")
