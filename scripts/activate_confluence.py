"""Attiva Confluence Tracker su profilo P1 Main FPMarkets EU."""
import os, sys, io, json, time
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

PROFILE_ID = 1
NEW_STRATEGY_ID = 'confluenceTracker'

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd, hide=False):
    if not hide: print(f"[ssh] $ {cmd[:200]}")
    _, stdout, _ = c.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace').rstrip()
    if out and not hide: print(out)
    return out

print("=== STEP 1: upload strategies.js ===")
sftp = c.open_sftp()
sftp.put(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src\strategies.js",
         '/root/impact-trading-server/src/strategies.js')
sftp.close()
print("strategies.js uploaded.")

print("\n=== STEP 2: read current sim_config swing_strategies ===")
current = run(f"sqlite3 /root/impact-trading-server/data/impact.db \"SELECT swing_strategies FROM sim_config WHERE id = {PROFILE_ID};\"")
arr = json.loads(current)
print(f"current swing_strategies ({len(arr)}): {arr}")

if NEW_STRATEGY_ID in arr:
    print(f"{NEW_STRATEGY_ID} already in list - skipping update")
else:
    arr.append(NEW_STRATEGY_ID)
    new_json = json.dumps(arr)
    escaped = new_json.replace("'", "''")
    sql = f"UPDATE sim_config SET swing_strategies = '{escaped}' WHERE id = {PROFILE_ID};"
    run(f"sqlite3 /root/impact-trading-server/data/impact.db \"{sql}\"")
    print(f"\nUpdated swing_strategies for profile {PROFILE_ID}: now {len(arr)} strategies")

print("\n=== STEP 3: restart pm2 ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

print("\n=== STEP 4: wait + verify new accounts ===")
time.sleep(12)
out = run(f"sqlite3 /root/impact-trading-server/data/impact.db \"SELECT COUNT(*), GROUP_CONCAT(DISTINCT symbol) FROM sim_accounts WHERE profile_id = {PROFILE_ID} AND strategy_id = '{NEW_STRATEGY_ID}';\"")
print(f"Accounts confluenceTracker: {out}")

print("\n=== STEP 5: health + tick ===")
run("curl -s http://localhost:3000/api/health")
run("pm2 logs impact-trading-server --lines 25 --nostream 2>&1 | grep -E 'avviato|init|confluence|account|error' | tail -10")

c.close()
print("\n=== DONE ===")
