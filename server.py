"""Lokaler Spielserver: python3 server.py  ->  http://localhost:8765"""
from __future__ import annotations

import json
import mimetypes
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from kuhhandel.bots import HeuristicBot
from kuhhandel.engine import Game, IllegalAction
from kuhhandel.view import player_view

WEB = Path(__file__).parent / "web"
BOT_NAMES = ["Berta", "Konrad", "Hilde", "Gustav"]
HUMAN = 0

lock = threading.Lock()
state = {"game": None, "bots": {}}


def new_game(players: int, name: str, seed=None):
    names = [name or "Du"] + BOT_NAMES[: players - 1]
    g = Game(players, seed=seed, names=names)
    state["game"] = g
    state["bots"] = {p: HeuristicBot(seed=None) for p in range(1, players)}


def parse_action(a):
    kind = a["kind"]
    if kind == "bid":
        return ("bid", int(a["amount"]))
    if kind == "challenge":
        return ("challenge", int(a["target"]), int(a["animal"]))
    if kind in ("offer", "counter"):
        return (kind, tuple(int(x) for x in a["notes"]))
    return (kind,)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _view(self, since=0):
        g = state["game"]
        if g is None:
            return {"phase": "none"}
        v = player_view(g, HUMAN, since)
        v["bot_turn"] = g.to_act is not None and g.to_act != HUMAN
        return v

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/state":
            q = self.path.split("since=")
            since = int(q[1]) if len(q) > 1 else 0
            with lock:
                return self._json(self._view(since))
        if path == "/":
            path = "/index.html"
        f = (WEB / path.lstrip("/")).resolve()
        if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
            self.send_response(404)
            self.end_headers()
            return
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()
        since = int(body.get("since", 0))
        with lock:
            try:
                if path == "/api/new":
                    new_game(int(body.get("players", 4)), body.get("name", "Du"))
                    return self._json(self._view(0))
                g = state["game"]
                if g is None:
                    return self._json({"error": "Kein Spiel"}, 400)
                if path == "/api/act":
                    if g.to_act != HUMAN:
                        return self._json({"error": "Du bist nicht dran"}, 400)
                    g.step(parse_action(body["action"]))
                    return self._json(self._view(since))
                if path == "/api/bot_step":
                    if g.to_act is not None and g.to_act != HUMAN:
                        g.step(state["bots"][g.to_act].act(g))
                    return self._json(self._view(since))
            except IllegalAction as e:
                return self._json({"error": str(e)}, 400)
        self._json({"error": "unbekannt"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Kuhhandel läuft auf http://localhost:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
