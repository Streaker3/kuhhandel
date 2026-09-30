"""Heuristische Gegner: Gegner für die Oberfläche und Maßstab für die RL-KI."""
from __future__ import annotations

import random

from .engine import DENOMS, VALUES, Game, bid_cap, compose_payment, notes_value

TOTAL_QUARTET_VALUE = sum(VALUES)
MONEY_PER_PLAYER = 940  # 90 Start + 850 Esel-Boni
AVG_NOTE_GUESS = 60  # grobe Schätzung eines unbekannten Scheins im Kuhhandel


class RandomBot:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def act(self, g: Game):
        p = g.to_act
        kinds = g.legal_kinds()
        k = self.rng.choice(kinds)
        if k == "bid":
            lo = g.auction["amount"] + 10
            hi = bid_cap(g.cash_value(p))
            return ("bid", self.rng.randrange(lo, max(lo, min(hi, lo + 200)) + 1, 10))
        if k == "challenge":
            return ("challenge", *self.rng.choice(g.trade_options(p)))
        if k in ("offer", "counter"):
            return (k, tuple(self.rng.randint(0, c) for c in g.cash[p]))
        return (k,)


class HeuristicBot:
    def __init__(self, seed=None, aggression=1.0, bluff=0.08):
        self.rng = random.Random(seed)
        self.aggression = aggression
        self.bluff = bluff

    # -------------------------------------------------------------- bewertung
    def card_value(self, g: Game, p: int, animal: int, k: int = 1) -> float:
        """Wie viel ist mir `k` weitere Karten dieser Tierart wert (in Geld)."""
        own = g.animals[p][animal]
        others = sum(g.animals[q][animal] for q in range(g.n) if q != p)
        in_deck = 4 - own - others
        factor = {0: 0.8, 1: 1.0, 2: 1.35, 3: 1.8}.get(own, 0.0)
        if own + k >= 4:
            factor *= 1.3
        # Wenn ein Gegner schon viel hat, wird es teuer, das Quartett zu holen
        max_other = max((g.animals[q][animal] for q in range(g.n) if q != p), default=0)
        if max_other >= 3 and own + k < 4:
            factor *= 0.7
        if in_deck > 0 and g.phase == "auction":
            factor *= 1.0
        ratio = g.n * MONEY_PER_PLAYER / TOTAL_QUARTET_VALUE
        return VALUES[animal] / 4 * k * factor * ratio * self.aggression

    def _leader_penalty(self, g: Game, p: int, q: int) -> float:
        """Karten, die ein führender Gegner braucht, sind mir etwas mehr wert."""
        sc = g.scores()
        mine = sc[p]
        return 1.15 if sc[q] > mine else 1.0

    # ------------------------------------------------------------------ act
    def act(self, g: Game):
        p = g.to_act
        kinds = g.legal_kinds()
        if g.phase == "auction":
            au = g.auction
            if au["stage"] == "bidding":
                return self._bid(g, p)
            val = self.card_value(g, p, au["card"])
            if "buy" in kinds and val >= au["amount"] and g.cash_value(p) - au["amount"] > 20:
                return ("buy",)
            return ("take",)
        t = g.trade
        if t is None:
            return self._choose_challenge(g, p)
        if t["stage"] == "offer":
            val = self.card_value(g, p, t["animal"], t["k"])
            val *= self._leader_penalty(g, p, t["target"])
            target = val * self.rng.uniform(0.55, 0.9)
            return ("offer", self._stack(g, p, target))
        # antworten
        cnt = sum(t["offer"])
        guess = cnt * AVG_NOTE_GUESS
        keep_val = self.card_value(g, p, t["animal"], t["k"])
        loss_if_lose = self.card_value(g, t["challenger"], t["animal"], t["k"]) * 0.3
        if keep_val + loss_if_lose < guess * 0.9 or g.cash_value(p) < 10:
            return ("accept",)
        target = min(keep_val, guess * self.rng.uniform(1.0, 1.5))
        return ("counter", self._stack(g, p, target))

    def _bid(self, g: Game, p: int):
        au = g.auction
        card = au["card"]
        val = self.card_value(g, p, card) * self.rng.uniform(0.85, 1.15)
        cash = g.cash_value(p)
        limit = min(val, cash)
        if self.rng.random() < self.bluff:
            limit = min(val * 1.2, bid_cap(cash))
        need = au["amount"] + 10
        if need > limit:
            return ("pass",)
        step = 10 if need > 0.7 * limit else self.rng.choice([10, 10, 20, 50])
        amount = min(int(limit) // 10 * 10, au["amount"] + step)
        return ("bid", max(need, amount))

    def _choose_challenge(self, g: Game, p: int):
        best, best_s = None, -1e9
        for q, a in g.trade_options(p):
            k = 2 if g.animals[p][a] >= 2 and g.animals[q][a] >= 2 else 1
            s = self.card_value(g, p, a, k) * self._leader_penalty(g, p, q)
            s += self.rng.uniform(0, 20)
            if s > best_s:
                best, best_s = (q, a), s
        return ("challenge", *best)

    def _stack(self, g: Game, p: int, target: float):
        """Stapel mit ungefähr `target` Wert, mit 0er-Scheinen als Bluff-Polster."""
        notes = list(g.cash[p])
        target = max(0, min(int(target) // 10 * 10, notes_value(notes)))
        pay = compose_payment(notes, target) or (0,) * len(DENOMS)
        pay = list(pay)
        if notes_value(pay) > target * 1.4 + 50:
            # lieber etwas weniger bieten als stark überzahlen
            lower = compose_payment(notes, max(0, target // 2)) or (0,) * len(DENOMS)
            pay = list(lower)
        pay[0] = self.rng.randint(0, notes[0])
        return tuple(pay)


def play_game(bots, seed=None, n=None):
    g = Game(n or len(bots), seed=seed)
    while g.phase != "over":
        g.step(bots[g.to_act].act(g))
    return g
