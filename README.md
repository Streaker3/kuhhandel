# Kuhhandel KI

Ein Browser-Kartenspiel nach einer Hausregel-Variante von „Kuhhandel“, mit KI-Gegnern, die per
Reinforcement Learning (PPO, Self-Play) trainiert wurden.

> Inoffizielles Fan-Projekt – nicht verbunden mit Ravensburger. „Kuhhandel“ ist ein Spiel von Ravensburger.

## Spielen

**Online:** https://streaker3.github.io/kuhhandel/

**Lokal:** Doppelklick auf `Kuhhandel starten.command` oder

```bash
python3 server.py        # -> http://localhost:8765
```

Das Spiel läuft komplett im Browser: Regel-Engine, KI-Netze und Spielstand. Der Spielstand wird im Browser gespeichert,
sodass man nach dem Neuladen weiterspielen kann.

- Gegner: trainierte KI in drei Stufen oder einfache Bots. Siegquote gegen die einfachen Bots (4 Spieler, Zufall 25 %):
  Leicht = früher Trainingsstand (~37 %), Mittel = beste KI entscheidet 55 % der Züge, sonst ein einfacher Bot (~56 %),
  Schwer = beste KI (~82 %).
- ⚙️-Menü: Tempo, Spielverlauf, Regeln, Ton an/aus, Versteigerung überspringen, neues Spiel.

## Aufbau

| Teil | Python (Training) | JavaScript (Spiel im Browser) |
|---|---|---|
| Regel-Engine | `kuhhandel/engine.py` | `web/js/kuhhandel.js` |
| KI-Beobachtung, Aktionen | `kuhhandel/encode.py` | `web/js/kuhhandel.js` |
| Spielansicht | `kuhhandel/view.py` | `web/js/kuhhandel.js` |
| Netz, einfache Bots | `kuhhandel/model.py`, `bots.py` | `web/js/ai.js` |
| Spielleiter, Speichern | – | `web/js/local.js` |
| Oberfläche | – | `web/index.html`, `app.js`, `style.css` |

Beide Engines müssen sich exakt gleich verhalten, weil die KI in Python trainiert und im Browser gespielt wird.

## Tests

```bash
python3 -m unittest -v tests.test_engine                 # Regeltests
.venv/bin/python tests/parity/make_traces.py 300         # Referenz-Partien aus Python
node tests/parity/check.js                               # JS-Engine Zug für Zug gegen Python
.venv/bin/python export_web_models.py && node tests/parity/check_nn.js   # Netz im Browser gegen PyTorch
```

## KI trainieren

Einmalig: `uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python torch numpy`

```bash
.venv/bin/python train.py --hours 8          # neues Training
.venv/bin/python train.py --resume --hours 8 # weitertrainieren
.venv/bin/python evaluate.py                 # Siegquote gegen die einfachen Bots
.venv/bin/python export_web_models.py        # neue Netze fürs Spiel (web/models/) exportieren
```

- Checkpoints in `checkpoints/`, Verlauf in `runs/log.csv`, live unter http://localhost:8765/training.html
- PPO mit Self-Play, Belohnung +1 nur für den Sieg; Gegner sind die aktuelle Version, ältere Versionen (Liga) und
  einfache Bots. Jedes Auffliegen beim Bluffen kostet im Training einen kleinen Malus (`--bust-penalty`); die
  Spielregeln bleiben dabei unverändert.

## Hausregeln (Abweichungen/Festlegungen)

- **Versteigerung:** Gebote in 10er-Schritten; Passen gilt nur, bis jemand höher bietet. Bluffen bis
  `2 × Bargeld + 100`. Der Versteigerer nimmt das Geld oder kauft selbst (Vorkaufsrecht). Wer nicht zahlen kann,
  zeigt sein Geld und ist für diese Karte ausgeschlossen (Ausschlüsse sammeln sich). Esel-Bonus 50/100/200/500.
- **Bezahlen ohne Wechselgeld:** minimale Überzahlung, dabei möglichst viele Scheine.
- **Kuhhandel:** Herausforderer legt verdeckt Geldkarten; der Gegner nimmt an oder macht ein verdecktes Gegengebot.
  Beim Gegengebot werden die Stapel getauscht (Gewinner zahlt netto die Differenz); Gleichstand gewinnt der
  Herausforderer ohne Geldfluss. Wer mit wem um welches Tier handelt und wie viele Karten in den Stapeln liegen,
  sehen alle – die Werte nur die Beteiligten. Herausfordern ist Pflicht, solange möglich.
- **Wertung:** Summe der vollständigen Quartette × Anzahl der Quartette; Gleichstand entscheidet das Bargeld.
- Nach 400 Kuhhandeln endet das Spiel zur Sicherheit (theoretisch mögliche Zyklen).

## Bilder

Eigene, KI-generierte Bilder. Die Prompts stehen in `bild_prompts/`, siehe `BILD_PROMPTS.md`.
Web-Versionen erzeugen: `.venv/bin/python convert_assets.py`.
