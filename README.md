# Kuhhandel KI

Engine, Oberfläche und (bald) trainierbare KI für eine Hausregel-Variante von „Kuhhandel“.

## Einrichtung (einmalig)

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python torch numpy
```

## Spielen

Doppelklick auf **`Kuhhandel starten.command`** im Projektordner: Der Server startet, der Browser öffnet sich.
Das Terminal-Fenster offen lassen, solange du spielst; schließen beendet den Server.

Oder im Terminal:

```bash
.venv/bin/python server.py
```

Der Spielstand wird nach jedem Zug in `saves/spielstand.pkl` gespeichert und beim nächsten Start automatisch fortgesetzt.
Dann http://localhost:8765 öffnen. `?fast` in der URL lässt die Bots ohne Pause spielen (zum Testen).

- Gegner: trainierte KI in drei Stufen oder einfache Bots. Siegquote gegen die einfachen Bots (4 Spieler, Zufall 25 %):
  Leicht = früher Trainingsstand (~37 %), Mittel = beste KI entscheidet 55 % der Züge, sonst ein einfacher Bot (~56 %),
  Schwer = beste KI (~82 %).
- ⚙️-Menü: Tempo, Spielverlauf, Regeln, Ton an/aus, Versteigerung überspringen, KI-Training live, neues Spiel.
- Es steuert immer nur ein Browser-Tab das Spiel; ein anderer Tab kann mit „Hier weiterspielen“ übernehmen.
- Zum Testen parallel: `.venv/bin/python server.py 8766` (eigener Spielstand).

## KI trainieren

```bash
.venv/bin/python train.py --hours 8          # neues Training, stoppt nach 8 Stunden
.venv/bin/python train.py --resume --hours 8 # weitertrainieren
.venv/bin/python evaluate.py                 # Siegquote gegen die Heuristik-Bots
```

- Checkpoints landen in `checkpoints/`. `best.pt` ist die bisher stärkste Version gegen die Heuristik, und die Oberfläche nimmt sie automatisch als Gegner.
- Der Verlauf steht in `runs/log.csv`. Die Spalte `eval_winrate` ist die Siegquote gegen die Heuristik-Bots. Zum Vergleich: Bei 3 bis 5 Spielern läge Zufall bei etwa 26 %.
- Das Verfahren ist PPO mit Self-Play. Belohnung gibt es nur für den Sieg (+1). Gegner sind die aktuelle Version, ältere Versionen (die Liga) und die Heuristik-Bots.

## Tests

```bash
python3 -m unittest -v tests.test_engine
```

## Struktur

- `kuhhandel/engine.py` – Regel-Engine (Zustandsmaschine, Aktionen als Tupel)
- `kuhhandel/view.py` – Spielansicht pro Spieler (nur erlaubte Informationen)
- `kuhhandel/bots.py` – Zufalls- und Heuristik-Bots
- `kuhhandel/encode.py` – Beobachtungsvektor, Aktionsraum (103 Aktionen) und Maske der erlaubten Aktionen
- `kuhhandel/model.py` – Policy-/Value-Netz und `NNBot`
- `train.py` / `evaluate.py` – Training und Auswertung
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
- Wer mit wem um welches Tier handelt, sehen alle (wie am echten Tisch); die Gebote sehen nur die Beteiligten. Die KI bekommt dieselben Informationen.
- Im Training kostet jedes Auffliegen beim Bluffen einen kleinen Malus (`--bust-penalty`, Standard 0.05, aktuell mit 0.03 trainiert). Die Spielregeln selbst bleiben unverändert.
