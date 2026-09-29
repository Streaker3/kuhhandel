# Bild-Prompts für die Oberfläche

Speichere die Bilder unter diesen Dateinamen. Die Oberfläche erkennt sie automatisch,
bis dahin zeigt sie gezeichnete Platzhalter.

| Datei | Format |
|---|---|
| `web/assets/cards/<tier>.png` (pferd, kuh, schwein, esel, ziege, schaf, hund, katze, gans, hahn) | Hochformat 2:3, z. B. 800×1200 |
| `web/assets/card_back.png` | Hochformat 2:3 |
| `web/assets/table.png` | Querformat 16:9, z. B. 2560×1440 |

Damit alle Karten zusammenpassen: denselben **Stil-Block** in jeden Tier-Prompt setzen und,
falls dein Tool das kann, denselben Seed bzw. eine Stil-Referenz (erste gelungene Karte) verwenden.

## Stil-Block (in jeden Tier-Prompt einfügen)

> Playful vintage board-game card illustration, hand-drawn by a professional children's-book
> illustrator, ink outlines with warm watercolor and gouache textures, slightly exaggerated
> friendly cartoon proportions, expressive face, cream-colored aged paper background with subtle
> grain, decorative thin ornamental border in warm brown and gold, rounded card corners,
> the animal's German name in a hand-lettered playful serif at the bottom banner,
> the value number in the top-left and (rotated) bottom-right corner in a hand-painted
> style, portrait orientation 2:3, centered composition, no photorealism, no 3D render,
> no modern flat vector look, high detail, print quality.

## Tierkarten

Jeweils: `[Stil-Block] + Motiv`

- **pferd.png** – Motiv: *A proud chestnut horse with a flowing mane, standing tall with one hoof raised, a tiny red rosette ribbon on its bridle. Banner text: "Pferd", corner value: "1000". Background accent color: soft wheat yellow.*
- **kuh.png** – Motiv: *A cheerful black-and-white dairy cow with a big brass bell around its neck, chewing a daisy, one ear flopped. Banner text: "Kuh", corner value: "800". Accent: pale meadow green.*
- **schwein.png** – Motiv: *A plump pink pig with a curly tail sitting happily in a small puddle of mud, a tiny flower behind its ear. Banner text: "Schwein", corner value: "650". Accent: blush pink.*
- **esel.png** – Motiv: *A charming grey donkey with big fluffy ears and a mischievous grin, carrying a small sack of gold coins on its back. Banner text: "Esel", corner value: "500". Accent: lavender grey.*
- **ziege.png** – Motiv: *A white goat with curved horns and a little beard, standing on a rock, nibbling on a straw hat. Banner text: "Ziege", corner value: "350". Accent: warm sand.*
- **schaf.png** – Motiv: *A round, extra-fluffy white sheep with a black face and legs, looking sleepy and content. Banner text: "Schaf", corner value: "250". Accent: pale sky blue.*
- **hund.png** – Motiv: *A loyal brown-and-white farm dog (border collie type) sitting upright with tongue out and wagging tail. Banner text: "Hund", corner value: "160". Accent: light caramel.*
- **katze.png** – Motiv: *A sly orange tabby cat curled on a hay bale, one eye open, tail swishing. Banner text: "Katze", corner value: "90". Accent: soft lilac.*
- **gans.png** – Motiv: *A white farm goose waddling with its neck stretched forward, honking comically, orange beak and feet. Banner text: "Gans", corner value: "40". Accent: pale teal.*
- **hahn.png** – Motiv: *A colorful rooster with a red comb and iridescent tail feathers, crowing proudly on a wooden fence post. Banner text: "Hahn", corner value: "10". Accent: sunrise orange.*

> Tipp: Wenn das Bild-Tool Text schlecht rendert, lass Banner und Zahlen weg
> („no text, no numbers“). Dann blendet die Oberfläche Namen und Wert selbst ein
> (dafür in `style.css` bei `.card.has-img` die zwei `display: none` entfernen).

## Kartenrückseite – card_back.png

> Back side of a vintage farm-themed board-game card, symmetrical ornamental design, deep barn-red
> background with a fine cream diamond lattice pattern, a central medallion with a cute
> hand-drawn cow head wearing a small auctioneer's hat, surrounded by a wreath of wheat ears,
> thin gold and cream double border, rounded corners, watercolor and ink texture, portrait 2:3,
> no text, print quality.

## Spieltisch – table.png

> Top-down view of a large rectangular card table surface covered in rich green billiard felt
> (pool table cloth) with subtle fabric texture and soft vignette lighting from above, framed by a
> thick polished dark walnut wooden rim with warm highlights, no pockets, no balls, no cards,
> empty center, photorealistic material textures, 16:9, 2560x1440.

## Optional: Geldscheine (für später)

> Set of six playful vintage farm-themed banknotes in the style of classic board-game money, each
> in a different pastel color (white 0, yellow 10, pink 50, green 100, blue 200, orange 500),
> ornamental guilloche borders, the value printed large in each corner, a small hand-drawn farm
> motif in the center (egg, wheat, carrot, cheese wheel, apple, golden trophy), flat front view,
> isolated on transparent background, no real currency symbols.
