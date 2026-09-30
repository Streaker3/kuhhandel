"""Erzeugt Referenz-Partien aus der Python-Engine für den Vergleich mit der JavaScript-Version.

    .venv/bin/python tests/parity/make_traces.py [anzahl_partien]   ->  tests/parity/traces.json
Danach:  node tests/parity/check.js
"""
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from kuhhandel.bots import HeuristicBot  # noqa: E402
from kuhhandel.encode import decode_action, legal_mask, observe  # noqa: E402
from kuhhandel.engine import NUM_ANIMALS, Game  # noqa: E402
from kuhhandel.view import player_view  # noqa: E402


def digest(g):
    """Momentaufnahme als echte Kopie (sonst sähe man später nur noch den Endstand)."""
    return json.loads(json.dumps(_digest(g)))


def _digest(g):
    au = g.auction
    t = g.trade
    return {
        "phase": g.phase, "to_act": g.to_act, "turn": g.turn, "cash": g.cash, "animals": g.animals, "bank": g.bank,
        "known": g.known, "revealed": g.revealed_cash, "deck": len(g.deck), "donkeys": g.donkeys_drawn,
        "trades": g.trades_done, "scores": g.scores(), "ranking": g.ranking(),
        "auction": None if au is None else {
            "card": au["card"], "auctioneer": au["auctioneer"], "high": au["high"], "amount": au["amount"],
            "stage": au["stage"], "excluded": sorted(au["excluded"]), "passed": sorted(au["passed"]),
            "bidders": au["bidders"], "last": {str(k): v for k, v in au["last"].items()}},
        "trade": None if t is None else {k: (list(v) if isinstance(v, tuple) else v) for k, v in t.items()},
    }


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    rng = random.Random(12345)
    traces = []
    for gi in range(games):
        n = rng.choice([2, 3, 4, 5])
        names = ["Du"] + ["Berta", "Konrad", "Hilde", "Gustav"][: n - 1] if gi % 2 == 0 else None
        seed = rng.randrange(1 << 30)
        deck = [a for a in range(NUM_ANIMALS) for _ in range(4)]
        random.Random(seed).shuffle(deck)               # genau wie Game(seed=...)
        g = Game(n, seed=seed, names=names)
        heur = HeuristicBot(seed=seed)
        steps = []
        for _ in range(900):
            if g.phase == "over":
                break
            r = rng.random()
            if r < 0.45:
                act = heur.act(g)                       # realistisches Spiel
            elif r < 0.9:
                m = legal_mask(g)                       # Aktionsraum der KI (inkl. Stapel-Bildung)
                idx = int(rng.choice(np.flatnonzero(m)))
                act = decode_action(g, idx)
            else:                                       # beliebige Scheine / Gebote
                kinds = g.legal_kinds()
                k = rng.choice(kinds)
                p = g.to_act
                if k == "bid":
                    lo = g.auction["amount"] + 10
                    act = ("bid", rng.randrange(lo, lo + 300, 10))
                elif k in ("offer", "counter"):
                    act = (k, tuple(rng.randint(0, c) for c in g.cash[p]))
                elif k == "challenge":
                    act = ("challenge", *rng.choice(g.trade_options(p)))
                else:
                    act = (k,)
            try:
                g.step(act)
                ok = True
            except Exception as e:                      # ungültige Gebote gehören auch zum Test
                ok = type(e).__name__
            me = g.to_act
            steps.append({
                "action": [list(x) if isinstance(x, tuple) else x for x in act], "ok": ok, "state": digest(g),
                "events": len(g.events),
                "obs": None if me is None else [float(x) for x in observe(g)],
                "obs0": [float(x) for x in observe(g, 0)],
                "mask": None if me is None else np.flatnonzero(legal_mask(g)).tolist(),
                "view": json.loads(json.dumps(player_view(g, len(steps) % g.n, max(0, len(g.events) - 12)))),
            })
        traces.append({"n": n, "names": names, "deck": deck, "steps": steps,
                       "event_log": [{**{k: (list(v) if isinstance(v, tuple) else v) for k, v in ev.items()},
                                      "priv": {str(k): v for k, v in ev["priv"].items()}} for ev in g.events],
                       })
    out = Path(__file__).with_name("traces.json")
    out.write_text(json.dumps(traces))
    print(f"{games} Partien, {sum(len(t['steps']) for t in traces)} Züge -> {out}")


if __name__ == "__main__":
    main()
