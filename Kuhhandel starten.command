#!/bin/zsh
# Doppelklick startet das Spiel: Server im Hintergrund dieses Fensters, danach öffnet sich der Browser.
# Fenster schließen (oder Ctrl+C) beendet den Server. Der Spielstand bleibt im Browser gespeichert.
cd "$(dirname "$0")"

URL="http://localhost:8765"
if curl -s -o /dev/null "$URL/index.html"; then
  echo "Kuhhandel läuft bereits – öffne den Browser."
  open "$URL"
  exit 0
fi

# Das Spiel läuft im Browser; der Server liefert nur die Dateien aus (normales python3 genügt)
python3 server.py 8765 &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT INT TERM

# warten, bis der Server antwortet
for i in {1..40}; do
  curl -s -o /dev/null "$URL/index.html" && break
  sleep 0.25
done
open "$URL"
echo ""
echo "Kuhhandel läuft auf $URL – dieses Fenster offen lassen, solange du spielst."
wait $SERVER
