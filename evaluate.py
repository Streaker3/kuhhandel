"""Stärke einer trainierten KI messen.

    .venv/bin/python evaluate.py                          # best.pt gegen Heuristik-Bots
    .venv/bin/python evaluate.py --vs checkpoints/snap_00100.pt   # gegen eine ältere Version
"""
from __future__ import annotations

import argparse
import random
from collections import defaultdict

from kuhhandel.bots import HeuristicBot
from kuhhandel.engine import Game
from kuhhandel.model import NNBot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ai", default="checkpoints/best.pt")
    ap.add_argument("--vs", default=None, help="Checkpoint der Gegner (Standard: Heuristik)")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--greedy", action="store_true")
    args = ap.parse_args()

    ai = NNBot(args.ai, greedy=args.greedy)
    opp = NNBot(args.vs) if args.vs else HeuristicBot()
    res = defaultdict(lambda: [0, 0])
    rng = random.Random(1)
    for i in range(args.games):
        n = (3, 4, 5)[i % 3]
        seat = rng.randrange(n)
        g = Game(n, seed=rng.randrange(1 << 30))
        while g.phase != "over":
            bot = ai if g.to_act == seat else opp
            g.step(bot.act(g))
        res[n][0] += g.winner() == seat
        res[n][1] += 1
    total = sum(w for w, _ in res.values()) / sum(c for _, c in res.values())
    print(f"KI-Siegquote: {total:.1%}")
    for n, (w, c) in sorted(res.items()):
        print(f"  {n} Spieler: {w / c:.1%}  (Zufall wäre {1 / n:.1%}, {c} Partien)")


if __name__ == "__main__":
    main()
