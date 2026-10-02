"""Strategie der KI analysieren: viele Partien spielen lassen, jede Entscheidung protokollieren, auswerten.

    .venv/bin/python analyze_ai.py                       # „Schwer“ gegen sich selbst, 4 Spieler
    .venv/bin/python analyze_ai.py --games 3000 --players 3 4 5 --out runs/analyse.json
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import random
from collections import defaultdict

from kuhhandel.engine import DENOMS, NAMES, NUM_ANIMALS, VALUES, Game, notes_value


def play(args):
    ckpt, idxs, players = args
    import torch
    torch.set_num_threads(1)
    from kuhhandel.model import NNBot
    bot = NNBot(ckpt)
    out = {"auctions": [], "choices": [], "bids": [], "trades": [], "games": []}
    for i in idxs:
        rng = random.Random(7000 + i)
        n = players[i % len(players)]
        g = Game(n, seed=rng.randrange(1 << 30))
        busts = defaultdict(int)
        seen = 0
        while g.phase != "over":
            p = g.to_act
            au, t = g.auction, g.trade
            before = [list(a) for a in g.animals]
            cash_before = [g.cash_value(q) for q in range(n)]
            scores = g.scores()
            action = bot.act(g)
            kind = action[0]
            # --- Entscheidungen vor dem Ausführen merken
            if kind == "bid":
                out["bids"].append({"n": n, "card": au["card"], "amount": action[1], "cash": cash_before[p],
                                    "own": before[p][au["card"]]})
            if kind in ("take", "buy"):
                h = au["high"]
                out["choices"].append({
                    "n": n, "card": au["card"], "amount": au["amount"], "buy": kind == "buy",
                    "can_buy": cash_before[p] >= au["amount"], "cash": cash_before[p],
                    "own": before[p][au["card"]], "bidder_own": before[h][au["card"]],
                    "bidder_can_pay": cash_before[h] >= au["amount"],
                    "left": len(g.deck),
                })
            if kind == "offer":
                notes = action[1]
                out["trades"].append({
                    "n": n, "animal": t["animal"], "k": t["k"], "c": p, "g": t["target"],
                    "offer": notes_value(notes), "offer_cnt": sum(notes), "offer_zeros": notes[0],
                    "c_cash": cash_before[p], "g_cash": cash_before[t["target"]],
                    "c_own": before[p][t["animal"]], "g_own": before[t["target"]][t["animal"]],
                    "target_is_leader": scores[t["target"]] == max(scores) and max(scores) > 0,
                })
            if kind in ("accept", "counter"):
                tr = out["trades"][-1]
                tr["response"] = kind
                tr["counter"] = notes_value(action[1]) if kind == "counter" else None
            g.step(action)
            # --- Ergebnisse aus den neuen Ereignissen
            for ev in g.events[seen:]:
                k = ev["kind"]
                if k == "bust":
                    busts[ev["player"]] += 1
                if k in ("sold", "bought", "free"):
                    w, c = ev["player"], ev["card"]
                    others = [before[q][c] for q in range(n) if q != w]
                    out["auctions"].append({
                        "n": n, "card": c, "how": k, "price": ev.get("amount", 0), "winner_own": before[w][c],
                        "max_other": max(others), "left": len(g.deck), "winner_cash": cash_before[w],
                    })
                if k == "trade_result" and out["trades"]:
                    out["trades"][-1]["winner_is_c"] = ev["winner"] == ev["challenger"]
            seen = len(g.events)
        sc = g.scores()
        w = g.winner()
        out["games"].append({
            "n": n, "win_score": sc[w], "win_quartets": sum(1 for c in g.animals[w] if c == 4),
            "win_cash": g.cash_value(w), "scores": sc, "busts": sum(busts.values()), "trades": g.trades_done,
            "win_animals": [a for a in range(NUM_ANIMALS) if g.animals[w][a] == 4],
        })
    return out


def pct(a, b):
    return f"{100 * a / b:.0f} %" if b else "–"


def report(d):
    A, C, B, T, G = d["auctions"], d["choices"], d["bids"], d["trades"], d["games"]
    res = {}
    print(f"\n{len(G)} Partien, {len(A)} versteigerte Karten, {len(T)} Kuhhändel\n")

    # 1) Vorkaufsrecht
    can = [c for c in C if c["can_buy"]]
    print("== Vorkaufsrecht ==")
    print(f"Versteigerer-Entscheidungen: {len(C)}, davon hätte er kaufen können: {len(can)} ({pct(len(can), len(C))})")
    print(f"Genutzt, wenn möglich: {pct(sum(c['buy'] for c in can), len(can))}")
    res["buy"] = {"all": [sum(c["buy"] for c in can), len(can)]}
    print("…nach eigenem Bestand des Versteigerers (vorher):")
    res["buy_by_own"] = {}
    for o in range(4):
        s = [c for c in can if c["own"] == o]
        res["buy_by_own"][o] = [sum(c["buy"] for c in s), len(s)]
        print(f"  hat {o}: {pct(sum(c['buy'] for c in s), len(s))}  (n={len(s)})")
    print("…wenn der Bieter schon 3 hat (Quartett verhindern):")
    s = [c for c in can if c["bidder_own"] == 3]
    print(f"  {pct(sum(c['buy'] for c in s), len(s))}  (n={len(s)})")
    res["buy_block"] = [sum(c["buy"] for c in s), len(s)]
    print("…wenn der Bieter nicht zahlen kann (Bluff):")
    s = [c for c in C if not c["bidder_can_pay"]]
    print(f"  Geld genommen (Bluff aufgedeckt): {pct(sum(not c['buy'] for c in s), len(s))}  (n={len(s)})")

    # 2) Preise je Tier und eigenem Bestand
    print("\n== Bezahlter Preis in % des Quartettwerts (nur verkaufte/gekaufte Karten) ==")
    paid = [a for a in A if a["how"] != "free"]
    res["price_by_own"] = {}
    for o in range(4):
        s = [a for a in paid if a["winner_own"] == o]
        r = sum(a["price"] / VALUES[a["card"]] for a in s) / len(s) if s else 0
        res["price_by_own"][o] = [r, len(s)]
        label = {0: "1. Karte", 1: "2. Karte", 2: "3. Karte", 3: "4. Karte (macht Quartett)"}[o]
        print(f"  {label:28s}: {100 * r:5.1f} % des Quartettwerts  (n={len(s)})")
    print("…ohne Konkurrenz vs. wenn ein anderer schon 3 hat:")
    res["price_contest"] = {}
    for lab, cond in [("niemand sonst hat ≥2", lambda a: a["max_other"] <= 1),
                      ("ein anderer hat 2", lambda a: a["max_other"] == 2),
                      ("ein anderer hat 3", lambda a: a["max_other"] == 3)]:
        s = [a for a in paid if cond(a)]
        r = sum(a["price"] / VALUES[a["card"]] for a in s) / len(s) if s else 0
        res["price_contest"][lab] = [r, len(s)]
        print(f"  {lab:22s}: {100 * r:5.1f} %  (n={len(s)})")
    print("\nDurchschnittspreis je Tier (Quartettwert in Klammern):")
    res["price_by_animal"] = {}
    for c in range(NUM_ANIMALS):
        s = [a for a in paid if a["card"] == c]
        if s:
            m = sum(a["price"] for a in s) / len(s)
            res["price_by_animal"][NAMES[c]] = [m, VALUES[c], len(s)]
            print(f"  {NAMES[c]:8s} ({VALUES[c]:4d}): Ø {m:6.0f}   = {100 * m / VALUES[c]:4.0f} %")

    # 3) Wer bekommt die 4. Karte?
    print("\n== Wenn jemand schon 3 hat und die 4. Karte versteigert wird ==")
    s = [a for a in A if a["winner_own"] == 3 or a["max_other"] == 3]
    got = sum(a["winner_own"] == 3 for a in s)
    print(f"  Der 3er-Besitzer bekommt sie: {pct(got, len(s))}  (n={len(s)})")
    res["fourth"] = [got, len(s)]

    # 4) Bluffen
    bl = [b for b in B if b["amount"] > b["cash"]]
    print("\n== Bieten ==")
    print(f"  Gebote über dem eigenen Bargeld (Bluff): {pct(len(bl), len(B))} von {len(B)} Geboten")
    print(f"  Aufgeflogen pro Partie: {sum(g['busts'] for g in G) / len(G):.2f}")
    res["bluff"] = [len(bl), len(B)]

    # 5) Kuhhandel
    print("\n== Kuhhandel ==")
    done = [t for t in T if "response" in t]
    acc = [t for t in done if t["response"] == "accept"]
    print(f"  Angenommen: {pct(len(acc), len(done))}, Gegengebot: {pct(len(done) - len(acc), len(done))}")
    print(f"  Herausforderer gewinnt: {pct(sum(t.get('winner_is_c', False) for t in done), len(done))}")
    ratios = sorted(t["offer"] / (VALUES[t["animal"]] * t["k"] / 4) for t in done)
    r = ratios[len(ratios) // 2]
    print(f"  Gebot im Median: {100 * r:.0f} % des Werts der umkämpften Karten (Quartettwert × k/4)")
    print("  Gebote und Gegengebote je Tier (Ø Wert bei 1 Karte):")
    res["offer_by_animal"] = {}
    for a in range(NUM_ANIMALS):
        s1 = [t for t in done if t["animal"] == a and t["k"] == 1]
        if s1:
            o = sum(t["offer"] for t in s1) / len(s1)
            cs = [t["counter"] for t in s1 if t["counter"] is not None]
            cm = sum(cs) / len(cs) if cs else 0
            res["offer_by_animal"][NAMES[a]] = [o, cm, VALUES[a], len(s1)]
            print(f"    {NAMES[a]:8s} (¼ Quartett = {VALUES[a] // 4:3d}): Gebot Ø {o:5.0f}, Gegengebot Ø {cm:5.0f}  (n={len(s1)})")
    z = [t for t in done if t["offer_cnt"] and t["offer_zeros"] / t["offer_cnt"] >= 0.5]
    print(f"  Gebote, die zur Hälfte oder mehr aus 0er-Karten bestehen: {pct(len(z), len(done))}")
    empty = [t for t in done if t["offer"] == 0]
    print(f"  Gebote mit Wert 0 (reiner Bluff): {pct(len(empty), len(done))}")
    lead = [t for t in done if t["target_is_leader"]]
    print(f"  Herausgeforderter ist der Führende: {pct(len(lead), len(done))}")
    res["trade"] = {"accept": [len(acc), len(done)], "offer_ratio": r,
                    "zero_heavy": [len(z), len(done)], "empty": [len(empty), len(done)]}
    print("  Annahmequote je Anzahl verdeckter Karten:")
    res["accept_by_cnt"] = {}
    for lo, hi in [(0, 1), (2, 3), (4, 6), (7, 10), (11, 99)]:
        s = [t for t in done if lo <= t["offer_cnt"] <= hi]
        res["accept_by_cnt"][f"{lo}-{hi}"] = [sum(t["response"] == "accept" for t in s), len(s)]
        print(f"    {lo:2d}–{hi:2d} Karten: angenommen {pct(sum(t['response'] == 'accept' for t in s), len(s))}  (n={len(s)})")

    # 6) Spielende
    print("\n== Sieger ==")
    for n in sorted({g["n"] for g in G}):
        s = [g for g in G if g["n"] == n]
        print(f"  {n} Spieler: Ø {sum(g['win_score'] for g in s) / len(s):.0f} Punkte, "
              f"Ø {sum(g['win_quartets'] for g in s) / len(s):.1f} Quartette, Ø {sum(g['win_cash'] for g in s) / len(s):.0f} Restgeld")
    res["games"] = len(G)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="checkpoints/best.pt")
    ap.add_argument("--games", type=int, default=2000)
    ap.add_argument("--players", type=int, nargs="+", default=[4])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--out", default="runs/analyse.json")
    args = ap.parse_args()
    mp.set_start_method("spawn")
    chunks = [(args.ckpt, list(range(k, args.games, args.workers)), args.players) for k in range(args.workers)]
    with mp.Pool(args.workers) as pool:
        parts = pool.map(play, chunks)
    data = {k: [x for part in parts for x in part[k]] for k in parts[0]}
    res = report(data)
    with open(args.out, "w") as f:
        json.dump({"summary": res, "raw": data}, f)


if __name__ == "__main__":
    main()
