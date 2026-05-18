"""Inspect server config relevant to why /api/fix/start returns 403."""
import os, sys, io
import paramiko
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd):
    _, stdout, _ = c.exec_command(cmd)
    out = stdout.read().decode(errors="replace").rstrip()
    if out: print(out)

print("=== ALLOWED_ORIGINS in .env ===")
run("grep ALLOWED_ORIGINS /root/impact-trading-server/.env | sed 's/=.*/=***/' ; grep ALLOWED_ORIGINS /root/impact-trading-server/.env | head -c 200")
print()
print("=== Caddy config (proxy to backend) ===")
run("find /etc/caddy -name '*.conf' -o -name 'Caddyfile' 2>/dev/null | head -5 | xargs -I {} sh -c 'echo \"--- {} ---\"; cat {} | head -50'")
print()
print("=== pm2 logs last 30 lines, filter relevant ===")
run("pm2 logs impact-trading-server --lines 30 --nostream 2>&1 | grep -E 'fix|FIX|403|CORS|origin|started|listening' | tail -20")
print()
print("=== Verify /api/fix/* routes exist in deployed index.js ===")
run("grep -c '/api/fix/' /root/impact-trading-server/src/index.js")
print()
print("=== Check from VPS itself (server-side, no CORS): POST /api/fix/start ===")
run("curl -s -X POST -o /tmp/fix.out -w 'HTTP %{http_code} | body:' http://localhost:3000/api/fix/start; cat /tmp/fix.out | head -c 300")

c.close()
