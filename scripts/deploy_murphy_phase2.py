"""Deploy phase 2: MACD Divergence + Double Top/Bottom activation."""
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

print("=== STEP 1: upload strategies.js ===")
sftp = c.open_sftp()
sftp.put(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src\strategies.js",
         '/root/impact-trading-server/src/strategies.js')
sftp.close()
print("Uploaded.")

print("\n=== STEP 2: aggiungo macdDivergence + doubleTopBottom a P1 swing_strategies ===")
current = run('sqlite3 /root/impact-trading-server/data/impact.db "SELECT swing_strategies FROM sim_config WHERE id = 1;"')
arr = json.loads(current)
print(f"Current ({len(arr)}): {arr}")
to_add = ['macdDivergence', 'doubleTopBottom']
added = []
for sid in to_add:
    if sid not in arr:
        arr.append(sid)
        added.append(sid)
if added:
    sql_content = f"UPDATE sim_config SET swing_strategies = '{json.dumps(arr)}' WHERE id = 1;\n"
    sftp2 = c.open_sftp()
    with sftp2.open('/tmp/add_strats.sql', 'w') as f:
        f.write(sql_content)
    sftp2.close()
    run("sqlite3 /root/impact-trading-server/data/impact.db < /tmp/add_strats.sql")
    print(f"\nAdded {added}: now {len(arr)} strategies in swing list")
else:
    print("Already present")

print("\n=== STEP 3: restart pm2 ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

time.sleep(8)
run("curl -s http://localhost:3000/api/health")

print("\n=== DONE - chiama POST /api/profiles/1/start per init accounts ===")
c.close()
