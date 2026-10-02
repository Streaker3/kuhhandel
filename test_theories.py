"""Strategie-Ideen testen: eine KI-Variante mit einer festen Zusatzregel spielt gegen normale KIs.

Gleiche Kartenverteilungen für alle Varianten (gepaarter Vergleich), Spieler 4.
    .venv/bin/python test_theories.py --games 4000
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import random

from kuhhandel.engine import Game


def make_variant(name, base):
    """Normale KI plus eine Regel. Die Regel greift nur in bestimmten Lagen, sonst entscheidet die KI."""

    def act(g):
        p = g.to_act
        au = g.auction
        if g.phase == "auction" and au is not None:
            card = au["card"]
            mine = g.animals[p][card]
            others3 = any(g.animals[q][card] == 3 for q in range(g.n) if q != p)
            cash = g.cash_value(p)
            want = (name == "komplettieren" and mine == 3) or (name == "blocken" and others3) \
                or (name == "beides" and (mine == 3 or others3))
            if au["stage"] == "bidding" and want:
                nxt = au["amount"] + 10
                if nxt <= cash * 0.6:          # weiterbieten bis 60 % des eigenen Bargelds
                    return ("bid", nxt)
            if au["stage"] == "choice" and au["auctioneer"] == p:
                h = au["high"]
                block = g.animals[h][card] == 3
                if cash >= au["amount"] and ((name in ("komplettieren", "beides") and mine == 3)
                                             or (name in ("blocken", "beides") and block)):
                    return ("buy",)
                if name == "vorkauf" and cash >= au["amount"] and au["amount"] <= cash * 0.5 and mine >= 1:
                    return ("buy",)
        return base.act(g)

    return act


def work(args):
    ckpt, variant, idxs = args
    import torch
    torch.set_num_threads(1)
    from kuhhandel.model import NNBot
    base = NNBot(ckpt, seed=1)
    other = NNBot(ckpt, seed=2)
    me = make_variant(variant, base)
    wins = 0
    for i in idxs:
        rng = random.Random(9000 + i)
        n = 4
        seat = rng.randrange(n)
        g = Game(n, seed=rng.randrange(1 << 30))
        while g.phase != "over":
            g.step(me(g) if g.to_act == seat else other.act(g))
        wins += g.winner() == seat
    return wins, len(idxs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="checkpoints/best.pt")
    ap.add_argument("--games", type=int, default=4000)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    mp.set_start_method("spawn")
    for v in ["normal", "komplettieren", "blocken", "beides", "vorkauf"]:
        chunks = [(args.ckpt, v, list(range(k, args.games, args.workers))) for k in range(args.workers)]
        with mp.Pool(args.workers) as pool:
            res = pool.map(work, chunks)
        w = sum(a for a, _ in res)
        n = sum(b for _, b in res)
        r = w / n
        se = (r * (1 - r) / n) ** 0.5
        print(f"{v:14s}: {100 * r:5.1f} % Siege  (±{196 * se:.1f})", flush=True)


if __name__ == "__main__":
    main()
