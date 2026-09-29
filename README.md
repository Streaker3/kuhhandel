# Kuhhandel KI

Engine, Oberfläche und (bald) trainierbare KI für eine Hausregel-Variante von „Kuhhandel“.

## Spielen

```bash
python3 server.py
```
Dann http://localhost:8765 öffnen. `?fast` in der URL lässt die Bots ohne Pause spielen (zum Testen).

## Tests

```bash
python3 -m unittest -v tests.test_engine
```

## Struktur

- `kuhhandel/engine.py` – Regel-Engine (Zustandsmaschine, Aktionen als Tupel)
- `kuhhandel/view.py` – Spielansicht pro Spieler (nur erlaubte Informationen)
- `kuhhandel/bots.py` – Zufalls- und Heuristik-Bots
- `server.py` – lokaler HTTP-Server (nur Standardbibliothek)
- `web/` – Oberfläche; eigene Bilder unter `web/assets/` (siehe `BILD_PROMPTS.md`)

## Festgelegte Regeldetails (zusätzlich zur Spezifikation)

- Bezahlt wird mit echten Scheinen **ohne Wechselgeld**. Die Engine überzahlt so wenig wie möglich und gibt dabei möglichst viele Scheine ab (keine 0er).
- Das Bluff-Limit bezieht sich nur auf das Bargeld: `Bargeld × 2 + 100`. Wer es nicht mehr überbieten kann, passt automatisch.
- Bei Zahlungsunfähigkeit wird das Bargeld öffentlich und bleibt bekannt, bis verdecktes Geld fließt. Die Ausschlüsse sammeln sich an; sind alle Bieter ausgeschlossen, bekommt der Versteigerer die Karte kostenlos.
- Die Kuhhandel-Phase beginnt beim Spieler nach dem letzten Versteigerer. Herausfordern ist Pflicht, sobald es möglich ist.
- Kuhhandel: Der Gegner sieht nur die Anzahl der Scheine. Bei einem Gegengebot werden die Stapel getauscht, also zahlt der Gewinner netto die Differenz. Bei Gleichstand gewinnt der Herausforderer und jeder nimmt seinen Stapel zurück.
- Unbeteiligte erfahren nur, wie sich der Tierbestand geändert hat. Das Geld der Gegner ist nur als grober Stapel zu sehen.
- Gleichstand in der Wertung: Das Bargeld entscheidet.
- Nach 400 Kuhhandeln endet das Spiel zur Sicherheit, da Zyklen theoretisch möglich sind.
