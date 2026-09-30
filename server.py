"""Lokaler Server: python3 server.py  ->  http://localhost:8765

Das Spiel selbst läuft komplett im Browser (web/js/). Dieser Server liefert nur die Dateien aus
und stellt für die Seite „KI-Training live“ (web/training.html) den Trainingsverlauf bereit.
Online genügt deshalb ein reines Datei-Hosting wie GitHub Pages.
"""
from __future__ import annotations

import csv
import json
import mimetypes
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
WEB = ROOT / "web"


def training_data():
    """Trainingsverlauf aus runs/log.csv für die Statistik-Seite."""
    log = ROOT / "runs" / "log.csv"
    if not log.exists():
        return {"rows": [], "running": False}
    with open(log, newline="") as f:
        rows = list(csv.DictReader(f))
    age = time.time() - log.stat().st_mtime
    return {"rows": rows, "running": age < 180, "updated_s": round(age)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body: bytes, ctype: str, cache: str = "no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/training":
            return self._send(200, json.dumps(training_data()).encode(), "application/json")
        if path == "/":
            path = "/index.html"
        f = (WEB / path.lstrip("/")).resolve()
        if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
            return self._send(404, b"", "text/plain", "no-store")  # fehlende Dateien nicht merken
        self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Kuhhandel läuft auf http://localhost:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
