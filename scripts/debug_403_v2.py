import os, sys, io
import paramiko
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd):
    _, stdout, _ = c.exec_command(cmd)
    print(stdout.read().decode(errors="replace").rstrip())

print("=== full Caddyfile ===")
run("cat /etc/caddy/Caddyfile 2>/dev/null || find / -name Caddyfile 2>/dev/null | head -1 | xargs cat")
print()
print("=== ALLOWED_ORIGINS exact value ===")
run("grep ALLOWED_ORIGINS /root/impact-trading-server/.env")
print()
print("=== test from VPS WITH origin header matching ALLOWED_ORIGINS ===")
run("curl -s -X POST -H 'Origin: https://impact-81-17-100-112.nip.io' -w '\\n--- HTTP %{http_code} ---\\n' http://localhost:3000/api/fix/start")
print()
print("=== test through Caddy (https), with origin ===")
run("curl -s -X POST -k -H 'Origin: https://impact-81-17-100-112.nip.io' -w '\\n--- HTTP %{http_code} ---\\n' https://impact-81-17-100-112.nip.io/api/fix/start 2>&1 | head -20")

c.close()
