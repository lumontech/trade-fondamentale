"""
Deploy cTrader FIX client code to VPS + set FIX env vars in .env.
Does NOT auto-start the FIX session — user must POST /api/fix/start manually.

Env vars:
  VPS_PASSWORD      - root SSH password
  FIX_HOST          - cTrader FIX host (e.g. live-uk-eqx-01.p.c-trader.com)
  FIX_PORT          - 5211 SSL
  FIX_USERNAME      - account number (e.g. 2055134)
  FIX_PASSWORD      - FIX session password (NOT logged)
  FIX_SENDER        - SenderCompID (e.g. live.fpmarkets.2055134)
  FIX_TARGET        - TargetCompID (default cServer)
  FIX_SUBID         - SenderSubID (default QUOTE)
"""
import os, sys, io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

REQUIRED = ['VPS_PASSWORD', 'FIX_HOST', 'FIX_USERNAME', 'FIX_PASSWORD', 'FIX_SENDER']
missing = [k for k in REQUIRED if not os.environ.get(k)]
if missing:
    print(f"ERROR: missing env vars: {missing}", file=sys.stderr)
    sys.exit(1)

HOST = "81.17.100.112"
USER = "root"
LOCAL_SERVER = Path(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src")
REMOTE_SERVER_SRC = "/root/impact-trading-server/src"
REMOTE_ENV        = "/root/impact-trading-server/.env"
PM2_APP = "impact-trading-server"

fix_env = {
    'CTRADER_FIX_HOST':     os.environ['FIX_HOST'],
    'CTRADER_FIX_PORT':     os.environ.get('FIX_PORT', '5211'),
    'CTRADER_FIX_USERNAME': os.environ['FIX_USERNAME'],
    'CTRADER_FIX_PASSWORD': os.environ['FIX_PASSWORD'],
    'CTRADER_FIX_SENDER':   os.environ['FIX_SENDER'],
    'CTRADER_FIX_TARGET':   os.environ.get('FIX_TARGET', 'cServer'),
    'CTRADER_FIX_SUBID':    os.environ.get('FIX_SUBID',  'QUOTE'),
    'CTRADER_FIX_SSL':      os.environ.get('FIX_SSL',    '1'),
}

print(f"[deploy] Connecting to {USER}@{HOST}...")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=os.environ['VPS_PASSWORD'], timeout=15,
          look_for_keys=False, allow_agent=False)
print("[deploy] Connected")

def run(cmd, hide=False):
    if not hide: print(f"[ssh] $ {cmd}")
    _, stdout, stderr = c.exec_command(cmd)
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    if out and not hide: print(f"[ssh] {out}")
    if err and not hide: print(f"[ssh] err: {err}")
    return out, err

# 1) Upload new src files
sftp = c.open_sftp()
new_files = ['ctraderFixClient.js', 'data.js', 'index.js', 'finnhubDataSource.js', 'yahooDataSource.js']
for fname in new_files:
    local = LOCAL_SERVER / fname
    if not local.exists():
        print(f"[deploy] skip missing {fname}")
        continue
    remote = f"{REMOTE_SERVER_SRC}/{fname}"
    print(f"[sftp] {fname} -> {remote}")
    sftp.put(str(local), remote)
sftp.close()

# 2) Update .env (each key idempotent — hide values from log)
print("[deploy] Setting CTRADER_FIX_* env vars (values not logged)")
for key, val in fix_env.items():
    safe_val = val.replace("'", "'\\''")   # shell-escape single quotes
    script = (
        f"f={REMOTE_ENV}; touch $f; chmod 600 $f; "
        f"grep -q '^{key}=' $f && "
        f"sed -i \"s|^{key}=.*|{key}='{safe_val}'|\" $f || "
        f"echo \"{key}='{safe_val}'\" >> $f"
    )
    run(script, hide=True)

# Verify keys are present (no values)
print("[deploy] Verifying env keys present:")
run(f"grep -E '^(CTRADER_FIX_|FINNHUB_)' {REMOTE_ENV} | sed 's/=.*/=***/'")

# 3) Restart pm2 (FIX will NOT auto-init; user must POST /api/fix/start)
run(f"pm2 restart {PM2_APP} --update-env")
run("sleep 2 && curl -s http://localhost:3000/api/health")
run("curl -s http://localhost:3000/api/fix/status")

c.close()
print("[deploy] DONE")
print()
print("=== Next step: trigger FIX session manually ===")
print("  curl -X POST http://localhost:3000/api/fix/start")
print("  curl http://localhost:3000/api/fix/status")
