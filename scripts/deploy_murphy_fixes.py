"""Deploy Murphy fixes: strategies.js + sim.js + sim_config update + initAccounts."""
import os, sys, io, json, time
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd, hide=False):
    if not hide: print(f"[ssh] $ {cmd[:150]}")
    _, so, _ = c.exec_command(cmd)
    out = so.read().decode('utf-8', errors='replace').rstrip()
    if out and not hide: print(out)
    return out

print("=== STEP 1: upload strategies.js + sim.js ===")
sftp = c.open_sftp()
sftp.put(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src\strategies.js",
         '/root/impact-trading-server/src/strategies.js')
sftp.put(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src\sim.js",
         '/root/impact-trading-server/src/sim.js')
sftp.close()
print("Uploaded.")

print("\n=== STEP 2: aggiungo rsiDivergence a swing_strategies P1 ===")
current = run('sqlite3 /root/impact-trading-server/data/impact.db "SELECT swing_strategies FROM sim_config WHERE id = 1;"')
arr = json.loads(current)
print(f"Current ({len(arr)}): {arr}")
if 'rsiDivergence' not in arr:
    arr.append('rsiDivergence')
    sql_content = f"UPDATE sim_config SET swing_strategies = '{json.dumps(arr)}' WHERE id = 1;\n"
    sftp2 = c.open_sftp()
    with sftp2.open('/tmp/add_rsidiv.sql', 'w') as f:
        f.write(sql_content)
    sftp2.close()
    run("sqlite3 /root/impact-trading-server/data/impact.db < /tmp/add_rsidiv.sql")
    print(f"Updated: now {len(arr)} swing strategies (added rsiDivergence)")
else:
    print("rsiDivergence already present")

print("\n=== STEP 3: restart pm2 ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

print("\n=== STEP 4: initAccounts P1 (creates new accounts for rsiDivergence) ===")
# We need an authenticated call. Use login first to get cookie then POST.
# Easier: use the API_TOKEN bypass if present in .env, else just rely on browser session.
# Per ora: skip auto-init, l'utente o un browser session lo chiamerà
time.sleep(8)
run("curl -s http://localhost:3000/api/health")
print()
run("pm2 logs impact-trading-server --lines 25 --nostream 2>&1 | grep -E 'avviato|ATR|trailing|RISK' | tail -10")

c.close()
print("\n=== DONE - now call POST /api/profiles/1/start from browser to init accounts ===")
