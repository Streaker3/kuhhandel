# Bild-Prompts

Für jedes Bild gibt es in `bild_prompts/` eine JSON-Datei. Den kompletten Inhalt einer Datei
fügst du als Prompt in dein Bild-Tool ein. Der `style`-Block ist in allen Karten-Dateien identisch.

## So geht's

1. **Mit `tier_esel.json` anfangen.** Nochmal generieren, bis dir der Stil gefällt.
2. **Diese Karte als Referenzbild für alle weiteren Karten mitgeben.** Dazu schreibst du vor den
   JSON-Text: *„Use the attached card as the style reference: match its line work, shading, frame,
   number font and paper texture exactly.“*
3. **Die Bilder unter diesen Namen speichern.** Die Oberfläche übernimmt sie automatisch:

| Prompt-Datei | Speichern als |
|---|---|
| `tier_<tier>.json` | `web/assets/cards/<tier>.png` |
| `geld_<wert>.json` | `web/assets/money/<wert>.png` |
| `rueckseite.json` | `web/assets/card_back.png` |
| `rueckseite_geld.json` | `web/assets/money_back.png` |
| `tisch.json` | `web/assets/tisch.png` |
| `avatar_<name>.json` | `web/assets/avatars/avatar_<name>.png` |

## Stil

- **Artwork** wie im zweiten Foto: Tuschezeichnung im Cartoon-Stil mit Humor, cremeweißer Hintergrund.
- **Hintergründe** angelehnt an das erste Foto: Jede Karte bekommt ein eigenes kleines Motiv,
  zum Beispiel Goldmünzen und Glitzern beim Goldesel, Zaun und Wiese beim Pferd, eine Pfütze bei der Gans.
- **Tierkarten:** Die Zahl steht nur oben links, einen Namen gibt es nicht.
- **Geldkarten:** Die Zahl steht oben links und gedreht unten rechts.

## Falls die Zahlen verunglücken

Im JSON-Text `"number"` durch `"number": "none – leave the top-left corner empty"` ersetzen.
Die Zahlen setze ich dann in der Oberfläche selbst ein. Sag mir Bescheid, falls du das brauchst.

## Profilbilder

Für die Profilbilder gibt es `avatar_berta`, `avatar_konrad`, `avatar_hilde`, `avatar_gustav` und `avatar_du` (das bist du).
Gib die 0er-Geldkarte als Stilvorlage mit. Danach die Web-Versionen erzeugen:

```bash
.venv/bin/python convert_assets.py
```
