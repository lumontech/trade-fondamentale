"""Inizializza il repo Git locale e lo pusha su GitHub.

PREREQUISITI:
  1. Hai già creato il repo PRIVATO vuoto su https://github.com/new
     (nome: trade-fondamentale, niente README/gitignore/license)
  2. Git è installato (se non lo hai: https://git-scm.com/download/win)

UTILIZZO:
  py scripts\\git_init_push.py https://github.com/TUO-USERNAME/trade-fondamentale.git

Lo script:
  1. Verifica che siamo nella project root (cerca package.json)
  2. Inizializza git se non già fatto
  3. Crea .gitignore robusto (esclude .env, node_modules, dist, data/*.db, ecc.)
  4. Aggiunge tutti i file (rispettando .gitignore)
  5. Crea il primo commit
  6. Aggiunge l'origin se non già presente
  7. Push verso main

Idempotente: se git è già inizializzato, lavora sull'esistente.
"""
import os, sys, io, subprocess
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

if len(sys.argv) < 2:
    print("Usage: py scripts\\git_init_push.py <github-repo-url>")
    print("Esempio: py scripts\\git_init_push.py https://github.com/TUO-USERNAME/trade-fondamentale.git")
    sys.exit(1)

REPO_URL = sys.argv[1].strip()
ROOT = Path(__file__).resolve().parent.parent

# Verifica project root
if not (ROOT / "package.json").exists() and not (ROOT / "frontend").exists():
    print(f"ERROR: non sembra la project root: {ROOT}", file=sys.stderr)
    sys.exit(1)

os.chdir(ROOT)
print(f"[git] working in {ROOT}")

def run(cmd, check=True, capture=False):
    print(f"[$] {cmd}")
    r = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    if capture: print(r.stdout)
    if check and r.returncode != 0:
        if not capture: print(f"[ERROR] command failed (exit {r.returncode})", file=sys.stderr)
        else: print(f"[ERROR] {r.stderr}", file=sys.stderr)
        sys.exit(r.returncode)
    return r

# ── .gitignore robusto ───────────────────────────────────────────
GITIGNORE = """# Dependencies
node_modules/
*/node_modules/
**/node_modules/

# Build output
dist/
*/dist/
**/dist/
build/
.next/

# Environment & secrets (NEVER commit)
.env
.env.local
.env.*.local
*.pem
*.key
secrets/

# Database files (binary, can be huge)
*.db
*.db-journal
*.db-shm
*.db-wal
server/data/*.db
data/*.db
*.sqlite
*.sqlite3

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# OS
.DS_Store
Thumbs.db
desktop.ini

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Python (per gli scripts/)
__pycache__/
*.pyc
*.pyo
.venv/
venv/

# Test coverage
coverage/
.nyc_output/

# Temp
tmp/
temp/
*.tmp
*.bak
"""

gitignore_path = ROOT / ".gitignore"
if not gitignore_path.exists():
    gitignore_path.write_text(GITIGNORE, encoding="utf-8")
    print("[ok] .gitignore creato")
else:
    # Append solo le righe mancanti più importanti
    current = gitignore_path.read_text(encoding="utf-8", errors="replace")
    missing = []
    for must_have in (".env", "node_modules/", "dist/", "*.db"):
        if must_have not in current:
            missing.append(must_have)
    if missing:
        with gitignore_path.open("a", encoding="utf-8") as f:
            f.write("\n# Added by git_init_push.py\n")
            for m in missing:
                f.write(m + "\n")
        print(f"[ok] aggiunte {len(missing)} entry mancanti a .gitignore esistente")
    else:
        print("[ok] .gitignore esistente OK, niente da aggiungere")

# ── Init repo se serve ───────────────────────────────────────────
if not (ROOT / ".git").exists():
    run("git init")
    print("[ok] git repo inizializzato")
else:
    print("[ok] git repo già inizializzato")

# ── Imposta branch main ──────────────────────────────────────────
run("git symbolic-ref HEAD refs/heads/main", check=False)
run('git config user.name "Stefano Gagliotti"',  check=False)
run('git config user.email "stefano@lumontec.it"', check=False)

# ── Verifica che .env non sia stato già committato accidentalmente ─
r = subprocess.run("git ls-files | findstr /R \"^\\.env$\"", shell=True, capture_output=True, text=True)
if r.stdout.strip():
    print("[warn] .env trovato già tracciato — lo rimuovo dal tracking (resta sul disco)")
    run("git rm --cached .env")

# ── Add + commit ─────────────────────────────────────────────────
run("git add .")
# Verifica se ci sono cambiamenti
r = subprocess.run("git diff --cached --quiet", shell=True)
if r.returncode != 0:
    run('git commit -m "Initial commit: Impact Trading Platform (frontend + server + scripts)"')
    print("[ok] commit creato")
else:
    print("[ok] niente di nuovo da committare")

# ── Remote ───────────────────────────────────────────────────────
r = subprocess.run("git remote get-url origin", shell=True, capture_output=True, text=True)
if r.returncode != 0:
    run(f"git remote add origin {REPO_URL}")
    print(f"[ok] remote 'origin' aggiunto: {REPO_URL}")
else:
    current_url = r.stdout.strip()
    if current_url != REPO_URL:
        print(f"[warn] remote 'origin' diverso ({current_url}) — aggiorno a {REPO_URL}")
        run(f"git remote set-url origin {REPO_URL}")
    else:
        print(f"[ok] remote 'origin' già OK")

# ── Push ─────────────────────────────────────────────────────────
print("[push] git push -u origin main (potrebbe chiedere credenziali GitHub)")
run("git push -u origin main")

print("\n[DONE] Backup completato. Codice salvo su:")
print(f"  {REPO_URL.replace('.git', '')}")
print("\nDa ora in poi, ogni `git push` aggiorna il backup.")
