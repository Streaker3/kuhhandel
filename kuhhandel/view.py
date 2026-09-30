"""Spielzustand aus Sicht eines Spielers (nur erlaubte Informationen)."""
from __future__ import annotations

from .engine import ANIMALS, DENOMS, Game, bid_cap, notes_value


def money_stack_size(notes) -> int:
    """Grobe Stapelhöhe (1-5) für Gegner – nicht exakt abzählbar."""
    c = sum(notes)
    return 0 if c == 0 else 1 if c <= 3 else 2 if c <= 6 else 3 if c <= 10 else 4 if c <= 16 else 5


def player_view(g: Game, me: int, event_start: int = 0) -> dict:
    players = []
    for p in range(g.n):
        d = {
            "name": g.names[p],
            "animals": list(g.animals[p]),
            "quartets": sum(1 for c in g.animals[p] if c == 4),
            "stack": money_stack_size(g.cash[p]),
        }
        if p == me:
            d["notes"] = list(g.cash[p])
            d["cash"] = g.cash_value(p)
        if g.revealed_cash[p] is not None:
            d["revealed"] = notes_value(g.revealed_cash[p])
        players.append(d)

    view = {
        "phase": g.phase,
        "n": g.n,
        "me": me,
        "turn": g.turn,
        "to_act": g.to_act,
        "deck_left": len(g.deck),
        "donkeys": g.donkeys_drawn,
        "players": players,
        "legal": g.legal_kinds() if g.to_act == me else [],
        "animals": [{"key": k, "name": n, "value": v} for k, n, v in ANIMALS],
        "denoms": list(DENOMS),
        "events": g.visible_events(me, event_start),
        "event_count": len(g.events),
        "cap": bid_cap(g.cash_value(me)),
    }
    au = g.auction
    if au is not None:
        view["auction"] = {
            "card": au["card"],
            "auctioneer": au["auctioneer"],
            "high": au["high"],
            "amount": au["amount"],
            "stage": au["stage"],
            "excluded": sorted(au["excluded"]),
            "last": {str(k): v for k, v in au["last"].items()},
            "min_bid": au["amount"] + 10,
        }
    t = g.trade
    if t is not None:
        # Wer mit wem um welches Tier handelt, sieht jeder; Gebote nur die Beteiligten
        tv = {k: t[k] for k in ("challenger", "target", "animal", "k", "stage")}
        tv["involved"] = me in (t["challenger"], t["target"])
        if t["offer"] is not None and tv["involved"]:
            tv["offer_count"] = sum(t["offer"])
            if me == t["challenger"]:
                tv["my_offer"] = notes_value(t["offer"])
        view["trade"] = tv
    if g.phase == "trade" and g.to_act == me and t is None:
        view["options"] = [{"target": q, "animal": a} for q, a in g.trade_options(me)]
    if g.phase == "over":
        view["scores"] = g.scores()
        view["ranking"] = g.ranking()
        view["cash_all"] = [g.cash_value(p) for p in range(g.n)]
    return view
