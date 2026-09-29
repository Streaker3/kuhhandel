"""Regel-Engine für die Kuhhandel-Hausregel-Variante.

Die Engine ist eine Zustandsmaschine: Zu jedem Zeitpunkt muss genau ein Spieler
(`to_act`) eine Entscheidung treffen. Aktionen sind Tupel:

    ("bid", betrag) | ("pass",)                 Versteigerung, Bietrunde
    ("take",) | ("buy",)                        Versteigerer: Geld nehmen / Vorkaufsrecht
    ("challenge", gegner, tierart)              Kuhhandel: Herausforderung
    ("offer", scheine)                          Kuhhandel: verdecktes Gebot des Herausforderers
    ("accept",) | ("counter", scheine)          Kuhhandel: Antwort des Herausgeforderten

`scheine` ist ein 6-Tupel mit der Anzahl je Stückelung (DENOMS).
"""
from __future__ import annotations

import random

ANIMALS = [
    ("pferd", "Pferd", 1000),
    ("kuh", "Kuh", 800),
    ("schwein", "Schwein", 650),
    ("esel", "Esel", 500),
    ("ziege", "Ziege", 350),
    ("schaf", "Schaf", 250),
    ("hund", "Hund", 160),
    ("katze", "Katze", 90),
    ("gans", "Gans", 40),
    ("hahn", "Hahn", 10),
]
NUM_ANIMALS = len(ANIMALS)
ESEL = 3
VALUES = [a[2] for a in ANIMALS]
NAMES = [a[1] for a in ANIMALS]

DENOMS = (0, 10, 50, 100, 200, 500)
BANK_TOTAL = (10, 20, 10, 5, 5, 5)
START_NOTES = (2, 4, 1, 0, 0, 0)
DONKEY_BONUS_DENOM = (2, 3, 4, 5)  # 1.–4. Esel: 50, 100, 200, 500

MAX_TRADES = 400  # Sicherheitsnetz gegen endlose Kuhhandel-Zyklen


def notes_value(notes) -> int:
    return sum(c * d for c, d in zip(notes, DENOMS))


def bid_cap(cash: int) -> int:
    return (cash * 2 + 100) // 10 * 10


def compose_payment(notes, amount: int):
    """Scheine für eine Zahlung von mindestens `amount` ohne Wechselgeld.

    Minimale Überzahlung; bei Gleichstand möglichst viele Scheine (0er werden nie
    zum Bezahlen verwendet). Gibt None zurück, wenn das Bargeld nicht reicht.
    """
    if amount <= 0:
        return (0,) * len(DENOMS)
    if notes_value(notes) < amount:
        return None
    total_units = notes_value(notes) // 10
    # dp[s] = (anzahl_scheine, zusammensetzung) für erreichbare Summe s (in 10ern)
    dp = {0: (0, (0,) * len(DENOMS))}
    for i in range(1, len(DENOMS)):
        unit = DENOMS[i] // 10
        for _ in range(notes[i]):
            new = dict(dp)
            for s, (cnt, comp) in dp.items():
                t = s + unit
                if t > total_units:
                    continue
                cand = (cnt + 1, comp[:i] + (comp[i] + 1,) + comp[i + 1:])
                if t not in new or new[t][0] < cand[0]:
                    new[t] = cand
            dp = new
    target = amount // 10 + (1 if amount % 10 else 0)
    best = min(s for s in dp if s >= target)
    return dp[best][1]


class IllegalAction(Exception):
    pass


class Game:
    def __init__(self, num_players: int = 4, seed: int | None = None, names=None):
        if not 2 <= num_players <= 5:
            raise ValueError("2-5 Spieler")
        self.n = num_players
        self.rng = random.Random(seed)
        self.names = list(names) if names else [f"Spieler {i + 1}" for i in range(num_players)]
        self.bank = list(BANK_TOTAL)
        self.cash = []
        for _ in range(num_players):
            self.cash.append(list(START_NOTES))
            for i, c in enumerate(START_NOTES):
                self.bank[i] -= c
        self.animals = [[0] * NUM_ANIMALS for _ in range(num_players)]
        self.deck = [a for a in range(NUM_ANIMALS) for _ in range(4)]
        self.rng.shuffle(self.deck)
        self.donkeys_drawn = 0
        self.phase = "auction"
        self.turn = 0  # aktueller Versteigerer / Kuhhandel-Spieler
        self.auction = None
        self.trade = None
        self.trades_done = 0
        self.events = []  # {"pub": text|None, "priv": {spieler: text}, "kind": ..., ...}
        self.revealed_cash = [None] * num_players  # öffentlich bekanntes Bargeld
        self.to_act = None
        self._advance()

    # ------------------------------------------------------------------ helpers
    def cash_value(self, p: int) -> int:
        return notes_value(self.cash[p])

    def _log(self, pub, priv=None, **data):
        self.events.append({"pub": pub, "priv": priv or {}, **data})

    def _transfer_notes(self, src: int, dst: int, notes):
        for i, c in enumerate(notes):
            self.cash[src][i] -= c
            self.cash[dst][i] += c
        # verdeckter/teilweise verdeckter Geldfluss -> Kenntnis veraltet
        self.revealed_cash[src] = None
        self.revealed_cash[dst] = None

    def _pay(self, src: int, dst: int, amount: int):
        notes = compose_payment(self.cash[src], amount)
        assert notes is not None
        self._transfer_notes(src, dst, notes)
        return notes

    def trade_options(self, p: int):
        opts = []
        for a in range(NUM_ANIMALS):
            if 1 <= self.animals[p][a] <= 3:
                for q in range(self.n):
                    if q != p and 1 <= self.animals[q][a] <= 3:
                        opts.append((q, a))
        return opts

    def _any_trade_possible(self):
        for a in range(NUM_ANIMALS):
            holders = [p for p in range(self.n) if 1 <= self.animals[p][a] <= 3]
            if len(holders) >= 2:
                return True
        return False

    # --------------------------------------------------------------- auction
    def _start_auction(self, card, excluded=frozenset(), redo=False):
        a = self.turn
        order = [(a + i) % self.n for i in range(1, self.n)]
        bidders = [p for p in order if p not in excluded]
        self.auction = {
            "card": card,
            "auctioneer": a,
            "excluded": set(excluded),
            "bidders": bidders,
            "high": None,
            "amount": 0,
            "passed": set(),
            "stage": "bidding",
            "last": {},  # spieler -> letztes öffentliches Verhalten (Betrag oder "pass")
            "last_actor": None,
        }
        if not redo:
            self._log(f"{self.names[a]} versteigert: {NAMES[card]}", kind="reveal", card=card, auctioneer=a)

    def _auction_min_bid(self):
        return self.auction["amount"] + 10

    def _auction_candidates(self):
        au = self.auction
        return [p for p in au["bidders"] if p != au["high"] and p not in au["passed"]]

    def _auction_next_bidder(self):
        au = self.auction
        order = au["bidders"]
        last = au["last_actor"]
        start = order.index(last) + 1 if last in order else 0
        for i in range(len(order)):
            p = order[(start + i) % len(order)]
            if p != au["high"] and p not in au["passed"]:
                return p
        return None

    def _finish_card(self, winner: int):
        card = self.auction["card"]
        self.animals[winner][card] += 1
        self.auction = None
        self.turn = (self.turn + 1) % self.n

    # ---------------------------------------------------------------- advance
    def _advance(self):
        """Führt automatische Schritte aus, bis ein Spieler entscheiden muss."""
        while True:
            if self.phase == "auction":
                if self.auction is None:
                    if not self.deck:
                        self.phase = "trade"
                        self._log("Alle Karten versteigert – der Kuhhandel beginnt!", kind="phase")
                        continue
                    card = self.deck.pop()
                    if card == ESEL:
                        idx = DONKEY_BONUS_DENOM[self.donkeys_drawn]
                        self.donkeys_drawn += 1
                        for p in range(self.n):
                            if self.bank[idx] > 0:
                                self.bank[idx] -= 1
                                self.cash[p][idx] += 1
                                if self.revealed_cash[p] is not None:
                                    self.revealed_cash[p] = list(self.cash[p])
                        self._log(f"{self.donkeys_drawn}. Esel! Jeder bekommt {DENOMS[idx]} von der Bank.",
                                  kind="donkey", amount=DENOMS[idx])
                    self._start_auction(card)
                    continue
                au = self.auction
                if au["stage"] == "bidding":
                    if not au["bidders"] or not self._auction_candidates():
                        if au["high"] is None:
                            a = au["auctioneer"]
                            self._log(f"Niemand bietet – {self.names[a]} bekommt {NAMES[au['card']]} kostenlos.",
                                      kind="free", player=a, card=au["card"])
                            self._finish_card(a)
                            continue
                        au["stage"] = "choice"
                        self.to_act = au["auctioneer"]
                        return
                    p = self._auction_next_bidder()
                    if bid_cap(self.cash_value(p)) < self._auction_min_bid():
                        # kann nicht mehr bieten -> automatisch passen
                        self._apply_pass(p)
                        continue
                    self.to_act = p
                    return
                self.to_act = au["auctioneer"]
                return

            if self.phase == "trade":
                if self.trade is not None:
                    t = self.trade
                    self.to_act = t["challenger"] if t["stage"] == "offer" else t["target"]
                    return
                if not self._any_trade_possible() or self.trades_done >= MAX_TRADES:
                    self._end_game()
                    return
                for _ in range(self.n):
                    if self.trade_options(self.turn):
                        self.to_act = self.turn
                        return
                    self.turn = (self.turn + 1) % self.n
                self._end_game()
                return

            self.to_act = None
            return

    def _end_game(self):
        self.phase = "over"
        self.to_act = None
        sc = self.scores()
        best = max(range(self.n), key=lambda p: (sc[p], self.cash_value(p)))
        self._log(f"Spielende! {self.names[best]} gewinnt mit {sc[best]} Punkten.", kind="over")

    # ------------------------------------------------------------------ public
    def scores(self):
        res = []
        for p in range(self.n):
            full = [VALUES[a] for a in range(NUM_ANIMALS) if self.animals[p][a] == 4]
            res.append(sum(full) * len(full))
        return res

    def ranking(self):
        sc = self.scores()
        return sorted(range(self.n), key=lambda p: (-sc[p], -self.cash_value(p)))

    def winner(self):
        return self.ranking()[0] if self.phase == "over" else None

    def legal_kinds(self):
        """Welche Aktionsarten gerade möglich sind (für UI/Bots)."""
        if self.phase == "over":
            return []
        if self.phase == "auction":
            au = self.auction
            if au["stage"] == "bidding":
                return ["bid", "pass"]
            kinds = ["take"]
            if self.cash_value(au["auctioneer"]) >= au["amount"]:
                kinds.append("buy")
            return kinds
        t = self.trade
        if t is None:
            return ["challenge"]
        return ["offer"] if t["stage"] == "offer" else ["accept", "counter"]

    def step(self, action):
        if self.phase == "over":
            raise IllegalAction("Spiel ist vorbei")
        kind = action[0]
        if kind not in self.legal_kinds():
            raise IllegalAction(f"{kind} ist jetzt nicht erlaubt")
        getattr(self, "_do_" + kind)(*action[1:])
        self._advance()

    # ---------------------------------------------------------- auction actions
    def _apply_pass(self, p):
        au = self.auction
        au["passed"].add(p)
        au["last"][p] = "pass"
        au["last_actor"] = p
        self._log(f"{self.names[p]} passt.", kind="pass", player=p)

    def _do_pass(self):
        self._apply_pass(self.to_act)

    def _do_bid(self, amount):
        p = self.to_act
        au = self.auction
        amount = int(amount)
        if amount % 10 or amount < self._auction_min_bid():
            raise IllegalAction(f"Gebot muss Vielfaches von 10 und ≥ {self._auction_min_bid()} sein")
        if amount > bid_cap(self.cash_value(p)):
            raise IllegalAction(f"Gebot über dem Limit ({bid_cap(self.cash_value(p))})")
        au["high"] = p
        au["amount"] = amount
        au["passed"] = set()
        au["last"][p] = amount
        au["last_actor"] = p
        self._log(f"{self.names[p]} bietet {amount}.", kind="bid", player=p, amount=amount)

    def _do_take(self):
        au = self.auction
        a, h, amt = au["auctioneer"], au["high"], au["amount"]
        if self.cash_value(h) >= amt:
            notes = self._pay(h, a, amt)
            paid = notes_value(notes)
            extra = f" (ohne Wechselgeld: {paid})" if paid != amt else ""
            self._log(f"{self.names[a]} nimmt das Geld: {self.names[h]} zahlt {amt}{extra} für {NAMES[au['card']]}.",
                      kind="sold", player=h, card=au["card"], amount=paid)
            self._finish_card(h)
            return
        # Zahlungsunfähig: Geld offenlegen, Ausschluss (akkumulierend), Wiederholung
        self.revealed_cash[h] = list(self.cash[h])
        self._log(
            f"{self.names[h]} kann {amt} nicht zahlen! Bargeld offengelegt: {self.cash_value(h)}. "
            f"Versteigerung wird ohne {self.names[h]} wiederholt.",
            kind="bust", player=h, notes=list(self.cash[h]))
        excluded = au["excluded"] | {h}
        self._start_auction(au["card"], excluded, redo=True)

    def _do_buy(self):
        au = self.auction
        a, h, amt = au["auctioneer"], au["high"], au["amount"]
        notes = self._pay(a, h, amt)
        paid = notes_value(notes)
        extra = f" (ohne Wechselgeld: {paid})" if paid != amt else ""
        self._log(f"{self.names[a]} nutzt das Vorkaufsrecht und zahlt {self.names[h]} {amt}{extra}.",
                  kind="bought", player=a, card=au["card"], amount=paid)
        self._finish_card(a)

    # ------------------------------------------------------------ trade actions
    def _check_notes(self, p, notes):
        notes = tuple(int(x) for x in notes)
        if len(notes) != len(DENOMS) or any(c < 0 or c > h for c, h in zip(notes, self.cash[p])):
            raise IllegalAction("Ungültige Scheine")
        return notes

    def _do_challenge(self, target, animal):
        p = self.to_act
        target, animal = int(target), int(animal)
        if (target, animal) not in self.trade_options(p):
            raise IllegalAction("Diese Herausforderung ist nicht möglich")
        k = 2 if self.animals[p][animal] >= 2 and self.animals[target][animal] >= 2 else 1
        self.trade = {"challenger": p, "target": target, "animal": animal, "k": k,
                      "stage": "offer", "offer": None, "counter": None}
        msg = f"{self.names[p]} fordert {self.names[target]} heraus: {k}× {NAMES[animal]}."
        self._log(None, {p: msg, target: msg}, kind="challenge")

    def _do_offer(self, notes):
        p = self.to_act
        t = self.trade
        notes = self._check_notes(p, notes)
        for i, c in enumerate(notes):
            self.cash[p][i] -= c
        t["offer"] = notes
        t["stage"] = "respond"
        cnt = sum(notes)
        self._log(None, {
            p: f"Du legst verdeckt {cnt} Scheine ({notes_value(notes)}).",
            t["target"]: f"{self.names[p]} legt verdeckt {cnt} Scheine hin.",
        }, kind="offer", count=cnt)

    def _give_cards(self, winner, loser):
        t = self.trade
        self.animals[loser][t["animal"]] -= t["k"]
        self.animals[winner][t["animal"]] += t["k"]

    def _close_trade(self, winner, loser, priv_msgs):
        t = self.trade
        self._give_cards(winner, loser)
        pub = (f"Kuhhandel: {self.names[winner]} bekommt {t['k']}× {NAMES[t['animal']]} "
               f"von {self.names[loser]}.")
        self._log(pub, priv_msgs, kind="trade_result", winner=winner, loser=loser,
                  animal=t["animal"], k=t["k"])
        self.revealed_cash[t["challenger"]] = None
        self.revealed_cash[t["target"]] = None
        self.trade = None
        self.trades_done += 1
        self.turn = (t["challenger"] + 1) % self.n

    def _do_accept(self):
        t = self.trade
        c, g = t["challenger"], t["target"]
        for i, x in enumerate(t["offer"]):
            self.cash[g][i] += x
        v = notes_value(t["offer"])
        base = f"{self.names[g]} nimmt an. {self.names[c]} bekommt {t['k']}× {NAMES[t['animal']]}"
        self._close_trade(c, g, {c: f"{base} und zahlt {v}.", g: f"{base}; du erhältst {v}."})

    def _do_counter(self, notes):
        t = self.trade
        c, g = t["challenger"], t["target"]
        notes = self._check_notes(g, notes)
        for i, x in enumerate(notes):
            self.cash[g][i] -= x
        t["counter"] = notes
        vo, vc = notes_value(t["offer"]), notes_value(notes)
        if vo == vc:
            # Gleichstand: Herausforderer gewinnt, jeder nimmt seinen Stapel zurück
            for i in range(len(DENOMS)):
                self.cash[c][i] += t["offer"][i]
                self.cash[g][i] += notes[i]
            winner, loser = c, g
            detail = f"Gleichstand ({vo}) – {self.names[c]} gewinnt, kein Geldfluss."
        else:
            # Stapel werden getauscht -> Gewinner zahlt netto die Differenz
            for i in range(len(DENOMS)):
                self.cash[c][i] += notes[i]
                self.cash[g][i] += t["offer"][i]
            winner, loser = (c, g) if vo > vc else (g, c)
            detail = (f"Gebote: {self.names[c]} {vo}, {self.names[g]} {vc}. "
                      f"{self.names[winner]} gewinnt und zahlt die Differenz {abs(vo - vc)}.")
        self._close_trade(winner, loser, {c: detail, g: detail})

    # ------------------------------------------------------------ observation
    def event_text(self, ev, viewer):
        if viewer in ev["priv"]:
            return ev["priv"][viewer]
        return ev["pub"]

    def visible_events(self, viewer, start=0):
        out = []
        for i in range(start, len(self.events)):
            txt = self.event_text(self.events[i], viewer)
            if txt is not None:
                out.append({"i": i, "text": txt, "kind": self.events[i].get("kind")})
        return out
