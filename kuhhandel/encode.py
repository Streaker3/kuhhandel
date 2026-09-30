"""Übersetzung Spiel <-> neuronales Netz.

Beobachtung: fester Float-Vektor aus Sicht des Spielers am Zug; Sitze sind relativ
(0 = ich, 1 = nächster Spieler, ...), auf 5 Sitze aufgefüllt. Enthält nur, was dieser
Spieler wissen darf.

Aktionen: ein flacher diskreter Raum (N_ACTIONS) mit Maske der gerade erlaubten Aktionen.
"""
from __future__ import annotations

import numpy as np

from .engine import (DENOMS, NUM_ANIMALS, VALUES, Game, bid_cap, compose_payment,
                     notes_value, stack_size)

MAX_SEATS = 5

# ------------------------------------------------------------------ Aktionen
BID_DELTAS = (0, 10, 20, 30, 40, 50, 70, 90, 120, 150, 200, 250, 300, 400, 500, 700, 1000)
STACK_FRACS = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
ZERO_MODES = 3  # 0er-Scheine dazulegen: keine / Hälfte / alle

A_PASS = 0
A_BID = 1
A_TAKE = A_BID + len(BID_DELTAS)
A_BUY = A_TAKE + 1
A_CHAL = A_BUY + 1
A_STACK = A_CHAL + (MAX_SEATS - 1) * NUM_ANIMALS
A_ACCEPT = A_STACK + len(STACK_FRACS) * ZERO_MODES
N_ACTIONS = A_ACCEPT + 1


def build_stack(notes, frac: float, zero_mode: int):
    cash = notes_value(notes)
    target = int(round(frac * cash / 10)) * 10
    pay = list(compose_payment(notes, target) or (0,) * len(DENOMS))
    z = notes[0]
    pay[0] = 0 if zero_mode == 0 else (z + 1) // 2 if zero_mode == 1 else z
    return tuple(pay)


def legal_mask(g: Game) -> np.ndarray:
    m = np.zeros(N_ACTIONS, dtype=bool)
    p = g.to_act
    if p is None:
        return m
    kinds = g.legal_kinds()
    if "pass" in kinds:
        m[A_PASS] = True
        lo = g.auction["amount"] + 10
        cap = bid_cap(g.cash_value(p))
        for i, d in enumerate(BID_DELTAS):
            if lo + d <= cap:
                m[A_BID + i] = True
    if "take" in kinds:
        m[A_TAKE] = True
    if "buy" in kinds:
        m[A_BUY] = True
    if "challenge" in kinds:
        for q, a in g.trade_options(p):
            r = (q - p) % g.n
            m[A_CHAL + (r - 1) * NUM_ANIMALS + a] = True
    if "offer" in kinds or "counter" in kinds:
        m[A_STACK:A_ACCEPT] = True
    if "accept" in kinds:
        m[A_ACCEPT] = True
    return m


def decode_action(g: Game, idx: int):
    p = g.to_act
    if idx == A_PASS:
        return ("pass",)
    if A_BID <= idx < A_TAKE:
        return ("bid", g.auction["amount"] + 10 + BID_DELTAS[idx - A_BID])
    if idx == A_TAKE:
        return ("take",)
    if idx == A_BUY:
        return ("buy",)
    if A_CHAL <= idx < A_STACK:
        r, a = divmod(idx - A_CHAL, NUM_ANIMALS)
        return ("challenge", (p + r + 1) % g.n, a)
    if A_STACK <= idx < A_ACCEPT:
        f, z = divmod(idx - A_STACK, ZERO_MODES)
        kind = "offer" if g.trade["stage"] == "offer" else "counter"
        return (kind, build_stack(g.cash[p], STACK_FRACS[f], z))
    if idx == A_ACCEPT:
        return ("accept",)
    raise ValueError(idx)


# --------------------------------------------------------------- Beobachtung
PHASES = ("bidding", "choice", "challenge", "offer", "respond")
M = 1000.0  # Geld-Skalierung


def _phase_index(g: Game) -> int:
    if g.phase == "auction":
        return 0 if g.auction["stage"] == "bidding" else 1
    t = g.trade
    if t is None:
        return 2
    return 3 if t["stage"] == "offer" else 4


def _score(animals) -> int:
    full = [VALUES[a] for a in range(NUM_ANIMALS) if animals[a] == 4]
    return sum(full) * len(full)


SEAT_FEATS = NUM_ANIMALS + 13


def observe(g: Game, me: int | None = None) -> np.ndarray:
    me = g.to_act if me is None else me
    f = []
    ph = [0.0] * len(PHASES)
    ph[_phase_index(g)] = 1.0
    f += ph
    npl = [0.0] * 4
    npl[g.n - 2] = 1.0
    f += npl

    mine = g.cash[me]
    cash = g.cash_value(me)
    f += [c / 10.0 for c in mine]
    f += [cash / M, bid_cap(cash) / M]

    au = g.auction
    t = g.trade
    held = [sum(g.animals[p][a] for p in range(g.n)) for a in range(NUM_ANIMALS)]
    total_cash = sum(g.cash_value(p) for p in range(g.n))
    if t is not None and t["offer"] is not None:
        total_cash += notes_value(t["offer"])  # Stapel liegt auf dem Tisch

    # ---- Sitze (relativ)
    for r in range(MAX_SEATS):
        if r >= g.n:
            f += [0.0] * SEAT_FEATS
            continue
        p = (me + r) % g.n
        an = g.animals[p]
        f += [c / 4.0 for c in an]
        known = g.known_cash(me, p)
        last = au["last"].get(p) if au else None
        f += [
            1.0,
            sum(1 for c in an if c == 4) / 4.0,
            _score(an) / 10000.0,
            min(sum(g.cash[p]), 30) / 30.0 if p == me else stack_size(g.cash[p]) / 5.0,
            (known / M) if known is not None else 0.0,
            1.0 if known is not None else 0.0,
            1.0 if au and au["auctioneer"] == p else 0.0,
            1.0 if au and au["high"] == p else 0.0,
            1.0 if au and p in au["excluded"] else 0.0,
            1.0 if au and p in au["passed"] else 0.0,
            (last / M) if isinstance(last, int) else 0.0,
            1.0 if g.to_act == p else 0.0,
            1.0 if g.turn == p else 0.0,
        ]

    # ---- Stapel / Fortschritt
    in_deck = [4 - held[a] - (1 if au and au["card"] == a else 0) for a in range(NUM_ANIMALS)]
    f += [c / 4.0 for c in in_deck]
    f += [len(g.deck) / 40.0, g.donkeys_drawn / 4.0, total_cash / 4700.0,
          (4700 - total_cash) / 4700.0, g.trades_done / 50.0]

    # ---- Versteigerung
    card = [0.0] * NUM_ANIMALS
    if au:
        card[au["card"]] = 1.0
    f += card
    f += [au["amount"] / M if au else 0.0, (au["amount"] + 10) / M if au else 0.0,
          1.0 if au and au["high"] is None else 0.0,
          (VALUES[au["card"]] / M) if au else 0.0,
          (g.animals[me][au["card"]] / 4.0) if au else 0.0]

    # ---- Kuhhandel (nur für Beteiligte sichtbar)
    ta = [0.0] * NUM_ANIMALS
    tf = [0.0] * 6
    opp = [0.0] * MAX_SEATS
    if t is not None and me in (t["challenger"], t["target"]):
        ta[t["animal"]] = 1.0
        other = t["target"] if me == t["challenger"] else t["challenger"]
        opp[(other - me) % g.n] = 1.0
        tf = [
            1.0 if me == t["challenger"] else 0.0,
            1.0 if me == t["target"] else 0.0,
            t["k"] / 2.0,
            (sum(t["offer"]) / 10.0) if t["offer"] is not None else 0.0,
            (notes_value(t["offer"]) / M) if t["offer"] is not None and me == t["challenger"] else 0.0,
            VALUES[t["animal"]] / M,
        ]
    f += ta + tf + opp

    # ---- Öffentlicher Kuhhandel (für alle sichtbar: wer mit wem um welches Tier; keine Gebote)
    pub = [0.0] * (1 + 2 * MAX_SEATS + NUM_ANIMALS + 1 + 2)
    if t is not None:
        pub[0] = 1.0
        pub[1 + (t["challenger"] - me) % g.n] = 1.0
        pub[1 + MAX_SEATS + (t["target"] - me) % g.n] = 1.0
        pub[1 + 2 * MAX_SEATS + t["animal"]] = 1.0
        pub[1 + 2 * MAX_SEATS + NUM_ANIMALS] = t["k"] / 2.0
        pub[-2] = 1.0 if t["stage"] == "offer" else 0.0
        pub[-1] = 1.0 if t["stage"] == "respond" else 0.0
    f += pub
    return np.asarray(f, dtype=np.float32)


OBS_SIZE = None


def obs_size() -> int:
    global OBS_SIZE
    if OBS_SIZE is None:
        OBS_SIZE = observe(Game(4, seed=0)).shape[0]
    return OBS_SIZE
