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

print("=== pm2 logs last 80 lines, FIX-related ===")
run("pm2 logs impact-trading-server --lines 80 --nostream 2>&1 | grep -iE 'fix|tls|logon|securit|connect' | tail -30")
print()
print("=== full last 30 lines of pm2 logs ===")
run("pm2 logs impact-trading-server --lines 30 --nostream 2>&1 | tail -25")
print()
print("=== outbound DNS + connectivity check to FIX host ===")
run("getent hosts live-uk-eqx-01.p.c-trader.com && timeout 5 bash -c '</dev/tcp/live-uk-eqx-01.p.c-trader.com/5211 && echo TCP_OPEN || echo TCP_FAIL'")
c.close()
