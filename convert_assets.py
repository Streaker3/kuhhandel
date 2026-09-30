"""Erzeugt die verkleinerten WebP-Bilder für das Spiel aus deinen PNG-Originalen.

    .venv/bin/python convert_assets.py

Originale: web/assets/cards/*.png, web/assets/money/*.png, web/assets/avatars/*.png,
           web/assets/rueckseite*.png, web/assets/tisch.png
Ergebnis:  web/assets/web/*.webp (diese lädt das Spiel)
"""
from pathlib import Path

from PIL import Image

SRC = Path(__file__).parent / "web" / "assets"
OUT = SRC / "web"


def main():
    OUT.mkdir(exist_ok=True)
    cards = sorted((SRC / "cards").glob("*.png")) + sorted((SRC / "money").glob("*.png")) + sorted(SRC.glob("rueckseite*.png"))
    for f in cards:
        Image.open(f).convert("RGBA").resize((480, 720), Image.LANCZOS).save(OUT / f"{f.stem}.webp", "WEBP", quality=86)
        print("✓", f.name)
    for f in sorted((SRC / "avatars").glob("*.png")):
        Image.open(f).convert("RGBA").resize((256, 256), Image.LANCZOS).save(OUT / f"{f.stem}.webp", "WEBP", quality=88)
        print("✓", f.name)
    table = SRC / "tisch.png"
    if table.exists():
        Image.open(table).convert("RGB").save(OUT / "tisch.webp", "WEBP", quality=85)
        print("✓", table.name)


if __name__ == "__main__":
    main()
