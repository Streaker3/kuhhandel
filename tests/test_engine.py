import unittest

from kuhhandel.bots import HeuristicBot, RandomBot, play_game
from kuhhandel.engine import (BANK_TOTAL, DENOMS, ESEL, Game, IllegalAction, bid_cap,
                              compose_payment, notes_value)


def total_money(g):
    return sum(g.cash_value(p) for p in range(g.n)) + notes_value(g.bank)


def fresh_auction(g, card=0):
    """Setzt eine kontrollierte Versteigerung von `card` auf (Versteigerer = g.turn)."""
    g.deck = [1, 1] + [card]
    g.auction = None
    g._advance()


class TestMoney(unittest.TestCase):
    def test_total_4700(self):
        self.assertEqual(notes_value(BANK_TOTAL), 4700)

    def test_no_change_example(self):
        # 280 in kleinen Scheinen + ein 500er, Zahlung 300 -> der 500er muss her
        notes = (0, 3, 1, 0, 1, 1)  # 30 + 50 + 200 + 500
        pay = compose_payment(notes, 300)
        self.assertEqual(notes_value(pay), 500)
        self.assertEqual(pay[5], 1)

    def test_exact_prefers_many_notes(self):
        pay = compose_payment((0, 10, 2, 1, 0, 0), 100)
        self.assertEqual(notes_value(pay), 100)
        self.assertEqual(pay[1], 10)

    def test_cannot_pay(self):
        self.assertIsNone(compose_payment((2, 4, 1, 0, 0, 0), 100))

    def test_cap(self):
        self.assertEqual(bid_cap(90), 280)
        self.assertEqual(bid_cap(95), 290)


class TestAuction(unittest.TestCase):
    def setUp(self):
        self.g = Game(4, seed=1)
        fresh_auction(self.g, card=0)

    def test_order_and_reentry(self):
        g = self.g
        self.assertEqual(g.auction["auctioneer"], 0)
        self.assertEqual(g.to_act, 1)
        g.step(("pass",))            # 1 passt
        g.step(("bid", 20))          # 2
        g.step(("pass",))            # 3
        self.assertEqual(g.to_act, 1)  # 1 bekommt wieder eine Chance
        g.step(("bid", 30))
        self.assertEqual(g.to_act, 2)  # nach neuem Gebot darf 2 wieder
        g.step(("pass",))            # 2 passt
        g.step(("pass",))            # 3 passt
        self.assertEqual(g.auction["stage"], "choice")
        self.assertEqual(g.to_act, 0)
        g.step(("take",))
        self.assertEqual(g.animals[1][0], 1)
        self.assertEqual(g.cash_value(0), 90 + 30)

    def test_min_increment(self):
        g = self.g
        g.step(("bid", 20))
        with self.assertRaises(IllegalAction):
            g.step(("bid", 25))
        with self.assertRaises(IllegalAction):
            g.step(("bid", 20))
        with self.assertRaises(IllegalAction):
            g.step(("bid", 290))  # über Deckel 280

    def test_nobody_bids(self):
        g = self.g
        for _ in range(3):
            g.step(("pass",))
        self.assertEqual(g.animals[0][0], 1)
        self.assertEqual(g.turn, 1)

    def test_buy(self):
        g = self.g
        g.step(("bid", 50)); g.step(("pass",)); g.step(("pass",))
        self.assertIn("buy", g.legal_kinds())
        g.step(("buy",))
        self.assertEqual(g.animals[0][0], 1)
        self.assertEqual(g.cash_value(1), 140)
        self.assertEqual(g.cash_value(0), 40)

    def test_buy_not_affordable(self):
        g = self.g
        g.step(("bid", 200)); g.step(("pass",)); g.step(("pass",))
        self.assertEqual(g.legal_kinds(), ["take"])

    def test_insolvency_accumulates(self):
        g = self.g
        g.step(("bid", 200)); g.step(("pass",)); g.step(("pass",))
        g.step(("take",))  # 1 kann nicht zahlen
        self.assertEqual(g.auction["excluded"], {1})
        self.assertEqual(g.revealed_cash[1], [2, 4, 1, 0, 0, 0])
        self.assertEqual(g.to_act, 2)
        g.step(("bid", 150)); g.step(("pass",))
        g.step(("take",))  # 2 kann nicht zahlen
        self.assertEqual(g.auction["excluded"], {1, 2})
        self.assertEqual(g.auction["bidders"], [3])
        g.step(("bid", 10))  # einziger Mitbieter, schon Höchstbietender -> Ende
        self.assertEqual(g.auction["stage"], "choice")
        g.step(("take",))
        self.assertEqual(g.animals[3][0], 1)

    def test_all_excluded_free(self):
        g = Game(2, seed=3)
        fresh_auction(g, card=0)
        g.step(("bid", 200))
        g.step(("take",))
        self.assertEqual(g.animals[0][0], 1)

    def test_donkey_bonus(self):
        g = Game(5, seed=2)
        g.deck = [1, ESEL]
        g.auction = None
        g._advance()
        self.assertTrue(all(g.cash_value(p) == 140 for p in range(5)))

    def test_cap_autopass(self):
        g = self.g
        g.cash[2] = [0, 0, 0, 0, 0, 0]  # Deckel 100
        g.step(("bid", 100))
        self.assertEqual(g.to_act, 3)   # 2 wurde automatisch übersprungen
        self.assertIn(2, g.auction["passed"])


class TestTrade(unittest.TestCase):
    def setUp(self):
        g = Game(3, seed=5)
        g.deck = []
        g.auction = None
        g.animals = [[0] * 10 for _ in range(3)]
        g.animals[0][1] = 2
        g.animals[1][1] = 2
        g.animals[2][2] = 4
        g.phase = "auction"
        g.turn = 0
        g._advance()
        self.g = g

    def test_options_and_k(self):
        g = self.g
        self.assertEqual(g.phase, "trade")
        self.assertEqual(g.trade_options(0), [(1, 1)])
        with self.assertRaises(IllegalAction):
            g.step(("challenge", 2, 2))
        g.step(("challenge", 1, 1))
        self.assertEqual(g.trade["k"], 2)

    def test_accept(self):
        g = self.g
        g.step(("challenge", 1, 1))
        g.step(("offer", (1, 2, 0, 0, 0, 0)))
        self.assertEqual(g.to_act, 1)
        g.step(("accept",))
        self.assertEqual(g.animals[0][1], 4)
        self.assertEqual(g.cash_value(0), 70)
        self.assertEqual(g.cash_value(1), 110)
        self.assertEqual(g.phase, "over")
        self.assertEqual(g.scores()[0], 800)

    def test_counter_swap(self):
        g = self.g
        g.step(("challenge", 1, 1))
        g.step(("offer", (0, 2, 0, 0, 0, 0)))  # 20
        g.step(("counter", (0, 0, 1, 0, 0, 0)))  # 50
        self.assertEqual(g.animals[1][1], 4)
        self.assertEqual(g.cash_value(0), 90 + 30)
        self.assertEqual(g.cash_value(1), 90 - 30)

    def test_tie_challenger_wins(self):
        g = self.g
        g.step(("challenge", 1, 1))
        g.step(("offer", (1, 1, 0, 0, 0, 0)))
        g.step(("counter", (0, 1, 0, 0, 0, 0)))
        self.assertEqual(g.animals[0][1], 4)
        self.assertEqual(g.cash[0], [2, 4, 1, 0, 0, 0])

    def test_uninvolved_sees_no_amount(self):
        g = self.g
        g.step(("challenge", 1, 1))
        g.step(("offer", (0, 2, 0, 0, 0, 0)))
        g.step(("counter", (0, 0, 1, 0, 0, 0)))
        texts = [e["text"] for e in g.visible_events(2)]
        joined = " ".join(texts)
        self.assertIn("Kuhhandel", joined)
        self.assertNotIn("20", joined.split("Kuhhandel")[-1])
        self.assertNotIn("Differenz", joined)


class TestFullGames(unittest.TestCase):
    def test_many_games(self):
        for seed in range(60):
            n = 2 + seed % 4
            bots = [HeuristicBot(seed * 10 + i) if (seed + i) % 3 else RandomBot(seed + i) for i in range(n)]
            g = play_game(bots, seed=seed)
            self.assertEqual(g.phase, "over")
            self.assertEqual(total_money(g), 4700)
            self.assertTrue(all(sum(g.animals[p][a] for p in range(n)) == 4 for a in range(10)))


if __name__ == "__main__":
    unittest.main()
