"""Erzeugt die verkleinerten WebP-Bilder für das Spiel aus deinen Originalen (PNG oder JPEG).

    .venv/bin/python convert_assets.py

Originale: web/assets/cards/, web/assets/money/, web/assets/avatars/, web/assets/rueckseite*.*, web/assets/tisch.*
Ergebnis:  web/assets/web/*.webp (diese lädt das Spiel)

Ein Suffix "_neu" wird ignoriert (tier_ziege_neu.jpeg ersetzt tier_ziege.png);
gibt es mehrere Dateien für dasselbe Bild, gewinnt die neueste.
"""
from pathlib import Path

from PIL import Image

SRC = Path(__file__).parent / "web" / "assets"
OUT = SRC / "web"
EXT = {".png", ".jpg", ".jpeg"}


def newest(files):
    """Pro Zielname (ohne '_neu') die zuletzt geänderte Datei."""
    best = {}
    for f in files:
        if f.suffix.lower() not in EXT:
            continue
        stem = f.stem.removesuffix("_neu")
        if stem not in best or f.stat().st_mtime > best[stem].stat().st_mtime:
            best[stem] = f
    return sorted(best.items())


def main():
    OUT.mkdir(exist_ok=True)
    cards = [*(SRC / "cards").iterdir(), *(SRC / "money").iterdir(), *SRC.glob("rueckseite*")]
    for stem, f in newest(cards):
        Image.open(f).convert("RGBA").resize((480, 720), Image.LANCZOS).save(OUT / f"{stem}.webp", "WEBP", quality=86)
        print("✓", f.name, "->", f"{stem}.webp")
    if (SRC / "avatars").exists():
        for stem, f in newest((SRC / "avatars").iterdir()):
            Image.open(f).convert("RGB").resize((320, 320), Image.LANCZOS).save(OUT / f"{stem}.webp", "WEBP", quality=88)
            print("✓", f.name, "->", f"{stem}.webp")
    for stem, f in newest(SRC.glob("tisch*")):
        Image.open(f).convert("RGB").save(OUT / f"{stem}.webp", "WEBP", quality=85)
        print("✓", f.name, "->", f"{stem}.webp")


if __name__ == "__main__":
    main()
