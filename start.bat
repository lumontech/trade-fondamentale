@echo off
echo Trade Fondamentale - Avvio server...
cd /d "%~dp0"

if not exist ".env" (
    echo ANTHROPIC_API_KEY=inserisci_qui_la_tua_chiave > .env
    echo File .env creato. Inserisci la tua ANTHROPIC_API_KEY nel file .env prima di continuare.
    pause
    exit
)

pip install -r requirements.txt -q
python app.py
pause
