#!/bin/zsh
# Doppelklick startet das Spiel: Server im Hintergrund dieses Fensters, danach öffnet sich der Browser.
# Fenster schließen (oder Ctrl+C) beendet den Server. Der Spielstand bleibt gespeichert.
cd "$(dirname "$0")"

URL="http://localhost:8765"
if curl -s -o /dev/null "$URL/api/info"; then
  echo "Kuhhandel läuft bereits – öffne den Browser."
  open "$URL"
  exit 0
fi

if [ ! -x .venv/bin/python ]; then
  echo "Python-Umgebung fehlt. Einmalig einrichten mit:"
  echo "  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python torch numpy"
  read -k 1 "?Taste drücken zum Schließen …"
  exit 1
fi

.venv/bin/python server.py 8765 &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT INT TERM

# warten, bis der Server antwortet (KI laden dauert ein paar Sekunden)
for i in {1..40}; do
  curl -s -o /dev/null "$URL/api/info" && break
  sleep 0.25
done
open "$URL"
echo ""
echo "Kuhhandel läuft auf $URL – dieses Fenster offen lassen, solange du spielst."
wait $SERVER
