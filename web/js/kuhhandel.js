/* Kuhhandel – Regel-Engine, KI-Beobachtung und Spielansicht (JavaScript-Version).
 *
 * Exakte Übertragung von kuhhandel/engine.py, encode.py und view.py. Ein automatischer
 * Vergleichstest (tests/parity) spielt tausende Züge in beiden Versionen und prüft, dass
 * Spielstand, Meldungen, erlaubte Aktionen und KI-Beobachtung identisch sind.
 *
 * Aktionen sind Arrays: ["bid", betrag] | ["pass"] | ["take"] | ["buy"] |
 * ["challenge", gegner, tierart] | ["offer", scheine] | ["accept"] | ["counter", scheine]
 */
(function (root) {
  "use strict";

  const ANIMALS = [
    ["pferd", "Pferd", 1000], ["kuh", "Kuh", 800], ["schwein", "Schwein", 650], ["esel", "Esel", 500],
    ["ziege", "Ziege", 350], ["schaf", "Schaf", 250], ["hund", "Hund", 160], ["katze", "Katze", 90],
    ["gans", "Gans", 40], ["hahn", "Hahn", 10],
  ];
  const NUM_ANIMALS = ANIMALS.length;
  const ESEL = 3;
  const VALUES = ANIMALS.map((a) => a[2]);
  const NAMES = ANIMALS.map((a) => a[1]);
  const DENOMS = [0, 10, 50, 100, 200, 500];
  const BANK_TOTAL = [10, 20, 10, 5, 5, 5];
  const START_NOTES = [2, 4, 1, 0, 0, 0];
  const DONKEY_BONUS_DENOM = [2, 3, 4, 5];
  const MAX_TRADES = 400;

  const mod = (a, n) => ((a % n) + n) % n;               // wie Pythons %
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  const notesValue = (notes) => notes.reduce((s, c, i) => s + c * DENOMS[i], 0);
  function stackSize(notes) {
    const c = sum(notes);
    return c === 0 ? 0 : c <= 3 ? 1 : c <= 6 ? 2 : c <= 10 ? 3 : c <= 16 ? 4 : 5;
  }
  const bidCap = (cash) => Math.floor((cash * 2 + 100) / 10) * 10;

  /** Wie Pythons round(): bei genau .5 zur geraden Zahl. */
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  /** Scheine für eine Zahlung von mindestens `amount` ohne Wechselgeld (wie compose_payment).
   *  fewest: bei Gleichstand möglichst wenige, also große Scheine (Bezahlen in der Versteigerung). */
  function composePayment(notes, amount, fewest = false) {
    if (amount <= 0) return DENOMS.map(() => 0);
    if (notesValue(notes) < amount) return null;
    const totalUnits = Math.floor(notesValue(notes) / 10);
    let dp = new Map([[0, [0, DENOMS.map(() => 0)]]]);
    for (let i = 1; i < DENOMS.length; i++) {
      const unit = DENOMS[i] / 10;
      for (let k = 0; k < notes[i]; k++) {
        const next = new Map(dp);
        for (const [s, [cnt, comp]] of dp) {
          const t = s + unit;
          if (t > totalUnits) continue;
          const cand = [cnt + 1, comp.slice()];
          cand[1][i] += 1;
          if (!next.has(t) || (fewest ? next.get(t)[0] > cand[0] : next.get(t)[0] < cand[0])) next.set(t, cand);
        }
        dp = next;
      }
    }
    const target = Math.floor(amount / 10) + (amount % 10 ? 1 : 0);
    let best = Infinity;
    for (const s of dp.keys()) if (s >= target && s < best) best = s;
    return dp.get(best)[1];
  }

  class IllegalAction extends Error {}

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  class Game {
    /** opts: { names, deck } – deck (Reihenfolge wie Python nach dem Mischen) nur für Tests. */
    constructor(numPlayers = 4, opts = {}) {
      if (numPlayers < 2 || numPlayers > 5) throw new Error("2-5 Spieler");
      this.n = numPlayers;
      this.names = opts.names ? opts.names.slice() : Array.from({ length: numPlayers }, (_, i) => `Spieler ${i + 1}`);
      this.bank = BANK_TOTAL.slice();
      this.cash = [];
      for (let p = 0; p < numPlayers; p++) {
        this.cash.push(START_NOTES.slice());
        START_NOTES.forEach((c, i) => { this.bank[i] -= c; });
      }
      this.animals = Array.from({ length: numPlayers }, () => new Array(NUM_ANIMALS).fill(0));
      if (opts.deck) this.deck = opts.deck.slice();
      else {
        this.deck = [];
        for (let a = 0; a < NUM_ANIMALS; a++) for (let k = 0; k < 4; k++) this.deck.push(a);
        shuffle(this.deck, opts.rand || Math.random);
      }
      this.donkeysDrawn = 0;
      this.phase = "auction";
      this.turn = 0;
      this.auction = null;
      this.trade = null;
      this.tradesDone = 0;
      this.events = [];
      this.revealedCash = new Array(numPlayers).fill(null);
      this.known = Array.from({ length: numPlayers }, () => new Array(numPlayers).fill(notesValue(START_NOTES)));
      this.toAct = null;
      this._advance();
    }

    // ------------------------------------------------------------ Speichern
    toJSON() {
      const au = this.auction && { ...this.auction, excluded: [...this.auction.excluded], passed: [...this.auction.passed] };
      const o = {};
      for (const k of Object.keys(this)) o[k] = this[k];
      o.auction = au;
      return o;
    }
    static fromJSON(o) {
      const g = Object.create(Game.prototype);
      Object.assign(g, JSON.parse(JSON.stringify(o)));
      if (g.auction) { g.auction.excluded = new Set(g.auction.excluded); g.auction.passed = new Set(g.auction.passed); }
      return g;
    }

    // ------------------------------------------------------------ Hilfen
    cashValue(p) { return notesValue(this.cash[p]); }
    _du(p) { return this.names[p] === "Du"; }
    _sv(p, third, second) { return this._du(p) ? `Du ${second}` : `${this.names[p]} ${third}`; }
    _acc(p) { return this._du(p) ? "dich" : this.names[p]; }
    _dat(p) { return this._du(p) ? "dir" : this.names[p]; }
    _log(pub, priv, data = {}) { this.events.push({ pub, priv: priv || {}, ...data }); }

    _transferNotes(src, dst, notes) {
      notes.forEach((c, i) => { this.cash[src][i] -= c; this.cash[dst][i] += c; });
      const v = notesValue(notes);
      for (const row of this.known) {
        if (row[src] !== null) row[src] -= v;
        if (row[dst] !== null) row[dst] += v;
      }
      this.revealedCash[src] = null;
      this.revealedCash[dst] = null;
    }
    knownCash(viewer, p) { return viewer === p ? this.cashValue(p) : this.known[viewer][p]; }
    _pay(src, dst, amount) {
      const notes = composePayment(this.cash[src], amount, true);   // große Scheine zuerst
      this._transferNotes(src, dst, notes);
      return notes;
    }
    tradeOptions(p) {
      const opts = [];
      for (let a = 0; a < NUM_ANIMALS; a++) {
        if (this.animals[p][a] >= 1 && this.animals[p][a] <= 3) {
          for (let q = 0; q < this.n; q++) {
            if (q !== p && this.animals[q][a] >= 1 && this.animals[q][a] <= 3) opts.push([q, a]);
          }
        }
      }
      return opts;
    }
    _anyTradePossible() {
      for (let a = 0; a < NUM_ANIMALS; a++) {
        let holders = 0;
        for (let p = 0; p < this.n; p++) if (this.animals[p][a] >= 1 && this.animals[p][a] <= 3) holders++;
        if (holders >= 2) return true;
      }
      return false;
    }

    // ------------------------------------------------------------ Versteigerung
    _startAuction(card, excluded = new Set(), redo = false) {
      const a = this.turn;
      const order = [];
      for (let i = 1; i < this.n; i++) order.push((a + i) % this.n);
      this.auction = {
        card, auctioneer: a, excluded: new Set(excluded), bidders: order.filter((p) => !excluded.has(p)),
        high: null, amount: 0, passed: new Set(), stage: "bidding", last: {}, lastActor: null,
      };
      if (!redo) this._log(`${this._sv(a, "versteigert", "versteigerst")}: ${NAMES[card]}`, null, { kind: "reveal", card, auctioneer: a });
    }
    _minBid() { return this.auction.amount + 10; }
    _candidates() {
      const au = this.auction;
      return au.bidders.filter((p) => p !== au.high && !au.passed.has(p));
    }
    _nextBidder() {
      const au = this.auction, order = au.bidders;
      const start = order.includes(au.lastActor) ? order.indexOf(au.lastActor) + 1 : 0;
      for (let i = 0; i < order.length; i++) {
        const p = order[(start + i) % order.length];
        if (p !== au.high && !au.passed.has(p)) return p;
      }
      return null;
    }
    _finishCard(winner) {
      this.animals[winner][this.auction.card] += 1;
      this.auction = null;
      this.turn = (this.turn + 1) % this.n;
    }

    // ------------------------------------------------------------ Ablauf
    _advance() {
      for (;;) {
        if (this.phase === "auction") {
          if (this.auction === null) {
            if (!this.deck.length) {
              this.phase = "trade";
              this._log("Alle Karten versteigert – der Kuhhandel beginnt!", null, { kind: "phase" });
              continue;
            }
            const card = this.deck.pop();
            if (card === ESEL) {
              const idx = DONKEY_BONUS_DENOM[this.donkeysDrawn];
              this.donkeysDrawn += 1;
              for (let p = 0; p < this.n; p++) {
                if (this.bank[idx] > 0) {
                  this.bank[idx] -= 1;
                  this.cash[p][idx] += 1;
                  for (const row of this.known) if (row[p] !== null) row[p] += DENOMS[idx];
                  if (this.revealedCash[p] !== null) this.revealedCash[p] = this.cash[p].slice();
                }
              }
              this._log(`${this.donkeysDrawn}. Esel! Jeder bekommt ${DENOMS[idx]} von der Bank.`, null, { kind: "donkey", amount: DENOMS[idx] });
            }
            this._startAuction(card);
            continue;
          }
          const au = this.auction;
          if (au.stage === "bidding") {
            if (!au.bidders.length || !this._candidates().length) {
              if (au.high === null) {
                const a = au.auctioneer;
                this._log(`Niemand bietet – ${this._sv(a, "bekommt", "bekommst")} ${NAMES[au.card]} kostenlos.`, null, { kind: "free", player: a, card: au.card });
                this._finishCard(a);
                continue;
              }
              au.stage = "choice";
              this.toAct = au.auctioneer;
              return;
            }
            const p = this._nextBidder();
            if (bidCap(this.cashValue(p)) < this._minBid()) { this._applyPass(p); continue; }
            this.toAct = p;
            return;
          }
          this.toAct = au.auctioneer;
          return;
        }
        if (this.phase === "trade") {
          if (this.trade !== null) {
            this.toAct = this.trade.stage === "offer" ? this.trade.challenger : this.trade.target;
            return;
          }
          if (!this._anyTradePossible() || this.tradesDone >= MAX_TRADES) { this._endGame(); return; }
          for (let i = 0; i < this.n; i++) {
            if (this.tradeOptions(this.turn).length) { this.toAct = this.turn; return; }
            this.turn = (this.turn + 1) % this.n;
          }
          this._endGame();
          return;
        }
        this.toAct = null;
        return;
      }
    }
    _endGame() {
      this.phase = "over";
      this.toAct = null;
      const sc = this.scores();
      let best = 0;
      for (let p = 1; p < this.n; p++) {
        if (sc[p] > sc[best] || (sc[p] === sc[best] && this.cashValue(p) > this.cashValue(best))) best = p;
      }
      this._log(`Spielende! ${this._sv(best, "gewinnt", "gewinnst")} mit ${sc[best]} Punkten.`, null, { kind: "over" });
    }

    // ------------------------------------------------------------ öffentlich
    scores() {
      return this.animals.map((an) => {
        const full = VALUES.filter((_, a) => an[a] === 4);
        return sum(full) * full.length;
      });
    }
    ranking() {
      const sc = this.scores();
      return [...Array(this.n).keys()].sort((a, b) => (sc[b] - sc[a]) || (this.cashValue(b) - this.cashValue(a)));
    }
    winner() { return this.phase === "over" ? this.ranking()[0] : null; }
    legalKinds() {
      if (this.phase === "over") return [];
      if (this.phase === "auction") {
        const au = this.auction;
        if (au.stage === "bidding") return ["bid", "pass"];
        const k = ["take"];
        if (this.cashValue(au.auctioneer) >= au.amount) k.push("buy");
        return k;
      }
      if (this.trade === null) return ["challenge"];
      return this.trade.stage === "offer" ? ["offer"] : ["accept", "counter"];
    }
    step(action) {
      if (this.phase === "over") throw new IllegalAction("Spiel ist vorbei");
      const [kind, ...args] = action;
      if (!this.legalKinds().includes(kind)) throw new IllegalAction(`${kind} ist jetzt nicht erlaubt`);
      ({
        pass: () => this._applyPass(this.toAct),
        bid: () => this._doBid(...args),
        take: () => this._doTake(),
        buy: () => this._doBuy(),
        challenge: () => this._doChallenge(...args),
        offer: () => this._doOffer(...args),
        accept: () => this._doAccept(),
        counter: () => this._doCounter(...args),
      })[kind]();
      this._advance();
    }

    // ------------------------------------------------------------ Versteigerungs-Aktionen
    _applyPass(p) {
      const au = this.auction;
      au.passed.add(p);
      au.last[p] = "pass";
      au.lastActor = p;
      this._log(`${this.names[p]} passt.`, null, { kind: "pass", player: p });
    }
    _doBid(amount) {
      const p = this.toAct, au = this.auction;
      amount = Math.trunc(Number(amount));
      if (amount % 10 || amount < this._minBid()) throw new IllegalAction(`Gebot muss Vielfaches von 10 und ≥ ${this._minBid()} sein`);
      if (amount > bidCap(this.cashValue(p))) throw new IllegalAction(`Gebot über dem Limit (${bidCap(this.cashValue(p))})`);
      au.high = p;
      au.amount = amount;
      au.passed = new Set();
      au.last[p] = amount;
      au.lastActor = p;
      this._log(`${this._sv(p, "bietet", "bietest")} ${amount}.`, null, { kind: "bid", player: p, amount });
    }
    _doTake() {
      const au = this.auction, a = au.auctioneer, h = au.high, amt = au.amount;
      if (this.cashValue(h) >= amt) {
        const paid = notesValue(this._pay(h, a, amt));
        const extra = paid !== amt ? ` (ohne Wechselgeld: ${paid})` : "";
        this._log(`${this._sv(a, "nimmt", "nimmst")} das Geld: ${this._sv(h, "zahlt", "zahlst")} ${amt}${extra} für ${NAMES[au.card]}.`, null,
          { kind: "sold", player: h, card: au.card, amount: paid });
        this._finishCard(h);
        return;
      }
      this.revealedCash[h] = this.cash[h].slice();
      for (const row of this.known) row[h] = this.cashValue(h);
      this._log(`${this._sv(h, "kann", "kannst")} ${amt} nicht zahlen! Bargeld offengelegt: ${this.cashValue(h)}. `
        + `Versteigerung wird ohne ${this._acc(h)} wiederholt.`, null, { kind: "bust", player: h, notes: this.cash[h].slice() });
      const excluded = new Set(au.excluded); excluded.add(h);
      this._startAuction(au.card, excluded, true);
    }
    _doBuy() {
      const au = this.auction, a = au.auctioneer, h = au.high, amt = au.amount;
      const paid = notesValue(this._pay(a, h, amt));
      const extra = paid !== amt ? ` (ohne Wechselgeld: ${paid})` : "";
      this._log(`${this._sv(a, "nutzt", "nutzt")} das Vorkaufsrecht und ${this._du(a) ? "zahlst" : "zahlt"} ${this._dat(h)} ${amt}${extra}.`, null,
        { kind: "bought", player: a, card: au.card, amount: paid });
      this._finishCard(a);
    }

    // ------------------------------------------------------------ Kuhhandel-Aktionen
    _checkNotes(p, notes) {
      notes = notes.map((x) => Math.trunc(Number(x)));
      if (notes.length !== DENOMS.length || notes.some((c, i) => c < 0 || c > this.cash[p][i])) throw new IllegalAction("Ungültige Scheine");
      if (sum(notes) === 0 && sum(this.cash[p]) > 0) throw new IllegalAction("Mindestens eine Karte legen – zur Not einen 0er");
      return notes;
    }
    _doChallenge(target, animal) {
      const p = this.toAct;
      target = Math.trunc(target); animal = Math.trunc(animal);
      if (!this.tradeOptions(p).some(([q, a]) => q === target && a === animal)) throw new IllegalAction("Diese Herausforderung ist nicht möglich");
      const k = this.animals[p][animal] >= 2 && this.animals[target][animal] >= 2 ? 2 : 1;
      this.trade = { challenger: p, target, animal, k, stage: "offer", offer: null, counter: null,
        cashBefore: [this.cashValue(p), this.cashValue(target)] };
      this._log(`${this._sv(p, "fordert", "forderst")} ${this._acc(target)} heraus: ${k}× ${NAMES[animal]}.`, {},
        { kind: "challenge", challenger: p, target, animal, k });
    }
    _doOffer(notes) {
      const p = this.toAct, t = this.trade;
      notes = this._checkNotes(p, notes);
      notes.forEach((c, i) => { this.cash[p][i] -= c; });
      t.offer = notes;
      t.stage = "respond";
      const cnt = sum(notes), word = cnt === 1 ? "Schein" : "Scheine";
      this._log(`${this._sv(p, "legt", "legst")} verdeckt ${cnt} ${word} hin.`,
        { [p]: `Du legst verdeckt ${cnt} ${word} (${notesValue(notes)}).` }, { kind: "offer", count: cnt, player: p });
    }
    _giveCards(winner, loser) {
      const t = this.trade;
      this.animals[loser][t.animal] -= t.k;
      this.animals[winner][t.animal] += t.k;
    }
    _closeTrade(winner, loser, privMsgs, accepted = false, tie = false) {
      const t = this.trade;
      this._giveCards(winner, loser);
      const pub = `Kuhhandel: ${this._sv(winner, "bekommt", "bekommst")} ${t.k}× ${NAMES[t.animal]} von ${this._dat(loser)}.`;
      this._log(pub, privMsgs, { kind: "trade_result", winner, loser, animal: t.animal, k: t.k, challenger: t.challenger,
        target: t.target, accepted, tie, offer_count: sum(t.offer), counter_count: t.counter !== null ? sum(t.counter) : 0 });
      const c = t.challenger, g = t.target;
      this.revealedCash[c] = null;
      this.revealedCash[g] = null;
      const dc = this.cashValue(c) - t.cashBefore[0], dg = this.cashValue(g) - t.cashBefore[1];
      for (let v = 0; v < this.n; v++) {
        if (v === c) { if (this.known[v][g] !== null) this.known[v][g] += dg; }
        else if (v === g) { if (this.known[v][c] !== null) this.known[v][c] += dc; }
        else { this.known[v][c] = null; this.known[v][g] = null; }
      }
      this.trade = null;
      this.tradesDone += 1;
      this.turn = (t.challenger + 1) % this.n;
    }
    _doAccept() {
      const t = this.trade, c = t.challenger, g = t.target;
      t.offer.forEach((x, i) => { this.cash[g][i] += x; });
      const v = notesValue(t.offer);
      this._log(null, { [g]: "" }, { kind: "reveal_bids", accepted: true, challenger: c, target: g, offer: t.offer.slice(), counter: null });
      const base = `${this._sv(g, "nimmt", "nimmst")} an. ${this._sv(c, "bekommt", "bekommst")} ${t.k}× ${NAMES[t.animal]}`;
      this._closeTrade(c, g, { [c]: `${base} und zahlt ${v}.`, [g]: `${base}; du erhältst ${v}.` }, true);
    }
    _doCounter(notes) {
      const t = this.trade, c = t.challenger, g = t.target;
      notes = this._checkNotes(g, notes);
      notes.forEach((x, i) => { this.cash[g][i] -= x; });
      t.counter = notes;
      const vo = notesValue(t.offer), vc = notesValue(notes);
      this._log(null, { [c]: "", [g]: "" }, { kind: "reveal_bids", accepted: false, challenger: c, target: g, offer: t.offer.slice(), counter: notes.slice() });
      let winner, loser, detail;
      if (vo === vc) {
        for (let i = 0; i < DENOMS.length; i++) { this.cash[c][i] += t.offer[i]; this.cash[g][i] += notes[i]; }
        winner = c; loser = g;
        detail = `Gleichstand (${vo}) – ${this._sv(c, "gewinnt", "gewinnst")}, kein Geldfluss.`;
      } else {
        for (let i = 0; i < DENOMS.length; i++) { this.cash[c][i] += notes[i]; this.cash[g][i] += t.offer[i]; }
        [winner, loser] = vo > vc ? [c, g] : [g, c];
        detail = `Gebote: ${this.names[c]} ${vo}, ${this.names[g]} ${vc}. `
          + `${this._sv(winner, "gewinnt", "gewinnst")} und ${this._du(winner) ? "zahlst" : "zahlt"} die Differenz ${Math.abs(vo - vc)}.`;
      }
      this._closeTrade(winner, loser, { [c]: detail, [g]: detail }, false, vo === vc);
    }

    // ------------------------------------------------------------ Meldungen
    eventText(ev, viewer) { return Object.prototype.hasOwnProperty.call(ev.priv, viewer) ? ev.priv[viewer] : ev.pub; }
    visibleEvents(viewer, start = 0) {
      const out = [];
      for (let i = start; i < this.events.length; i++) {
        const txt = this.eventText(this.events[i], viewer);
        if (txt === null || txt === undefined) continue;
        const { pub, priv, notes, ...rest } = this.events[i];
        out.push({ ...rest, i, text: txt });
      }
      return out;
    }
  }

  // ====================================================================== KI-Beobachtung
  const MAX_SEATS = 5;
  const BID_DELTAS = [0, 10, 20, 30, 40, 50, 70, 90, 120, 150, 200, 250, 300, 400, 500, 700, 1000];
  const STACK_FRACS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const ZERO_MODES = 3;
  const A_PASS = 0, A_BID = 1, A_TAKE = A_BID + BID_DELTAS.length, A_BUY = A_TAKE + 1, A_CHAL = A_BUY + 1;
  const A_STACK = A_CHAL + (MAX_SEATS - 1) * NUM_ANIMALS, A_ACCEPT = A_STACK + STACK_FRACS.length * ZERO_MODES;
  const N_ACTIONS = A_ACCEPT + 1;
  const M = 1000.0;

  /** Im Kuhhandel liegt immer mindestens eine Karte – zur Not ein 0er (sonst der kleinste Schein). */
  function atLeastOneCard(pay, notes) {
    pay = pay.slice();
    if (sum(pay) === 0 && sum(notes) > 0) pay[notes.findIndex((c) => c > 0)] = 1;
    return pay;
  }

  function buildStack(notes, frac, zeroMode) {
    const cash = notesValue(notes);
    const target = pyRound(frac * cash / 10) * 10;
    const pay = (composePayment(notes, target) || DENOMS.map(() => 0)).slice();
    const z = notes[0];
    pay[0] = zeroMode === 0 ? 0 : zeroMode === 1 ? Math.floor((z + 1) / 2) : z;
    return atLeastOneCard(pay, notes);
  }

  function legalMask(g) {
    const m = new Uint8Array(N_ACTIONS);
    const p = g.toAct;
    if (p === null) return m;
    const kinds = g.legalKinds();
    if (kinds.includes("pass")) {
      m[A_PASS] = 1;
      const lo = g.auction.amount + 10, cap = bidCap(g.cashValue(p));
      BID_DELTAS.forEach((d, i) => { if (lo + d <= cap) m[A_BID + i] = 1; });
    }
    if (kinds.includes("take")) m[A_TAKE] = 1;
    if (kinds.includes("buy")) m[A_BUY] = 1;
    if (kinds.includes("challenge")) {
      for (const [q, a] of g.tradeOptions(p)) m[A_CHAL + (mod(q - p, g.n) - 1) * NUM_ANIMALS + a] = 1;
    }
    if (kinds.includes("offer") || kinds.includes("counter")) for (let i = A_STACK; i < A_ACCEPT; i++) m[i] = 1;
    if (kinds.includes("accept")) m[A_ACCEPT] = 1;
    return m;
  }

  function decodeAction(g, idx) {
    const p = g.toAct;
    if (idx === A_PASS) return ["pass"];
    if (idx >= A_BID && idx < A_TAKE) return ["bid", g.auction.amount + 10 + BID_DELTAS[idx - A_BID]];
    if (idx === A_TAKE) return ["take"];
    if (idx === A_BUY) return ["buy"];
    if (idx >= A_CHAL && idx < A_STACK) {
      const r = Math.floor((idx - A_CHAL) / NUM_ANIMALS), a = (idx - A_CHAL) % NUM_ANIMALS;
      return ["challenge", (p + r + 1) % g.n, a];
    }
    if (idx >= A_STACK && idx < A_ACCEPT) {
      const f = Math.floor((idx - A_STACK) / ZERO_MODES), z = (idx - A_STACK) % ZERO_MODES;
      return [g.trade.stage === "offer" ? "offer" : "counter", buildStack(g.cash[p], STACK_FRACS[f], z)];
    }
    if (idx === A_ACCEPT) return ["accept"];
    throw new Error(`Unbekannte Aktion ${idx}`);
  }

  function phaseIndex(g) {
    if (g.phase === "auction") return g.auction.stage === "bidding" ? 0 : 1;
    if (g.trade === null) return 2;
    return g.trade.stage === "offer" ? 3 : 4;
  }
  function scoreOf(an) {
    const full = VALUES.filter((_, a) => an[a] === 4);
    return sum(full) * full.length;
  }
  const SEAT_FEATS = NUM_ANIMALS + 13;

  function observe(g, me = g.toAct) {
    const f = [];
    const ph = [0, 0, 0, 0, 0]; ph[phaseIndex(g)] = 1; f.push(...ph);
    const npl = [0, 0, 0, 0]; npl[g.n - 2] = 1; f.push(...npl);
    const cash = g.cashValue(me);
    f.push(...g.cash[me].map((c) => c / 10), cash / M, bidCap(cash) / M);
    const au = g.auction, t = g.trade;
    const held = [];
    for (let a = 0; a < NUM_ANIMALS; a++) { let s = 0; for (let p = 0; p < g.n; p++) s += g.animals[p][a]; held.push(s); }
    let totalCash = 0;
    for (let p = 0; p < g.n; p++) totalCash += g.cashValue(p);
    if (t !== null && t.offer !== null) totalCash += notesValue(t.offer);
    for (let r = 0; r < MAX_SEATS; r++) {
      if (r >= g.n) { for (let i = 0; i < SEAT_FEATS; i++) f.push(0); continue; }
      const p = (me + r) % g.n, an = g.animals[p];
      f.push(...an.map((c) => c / 4));
      const known = g.knownCash(me, p);
      const last = au ? au.last[p] : undefined;
      f.push(
        1,
        an.filter((c) => c === 4).length / 4,
        scoreOf(an) / 10000,
        p === me ? Math.min(sum(g.cash[p]), 30) / 30 : stackSize(g.cash[p]) / 5,
        known !== null ? known / M : 0,
        known !== null ? 1 : 0,
        au && au.auctioneer === p ? 1 : 0,
        au && au.high === p ? 1 : 0,
        au && au.excluded.has(p) ? 1 : 0,
        au && au.passed.has(p) ? 1 : 0,
        typeof last === "number" ? last / M : 0,
        g.toAct === p ? 1 : 0,
        g.turn === p ? 1 : 0,
      );
    }
    for (let a = 0; a < NUM_ANIMALS; a++) f.push((4 - held[a] - (au && au.card === a ? 1 : 0)) / 4);
    f.push(g.deck.length / 40, g.donkeysDrawn / 4, totalCash / 4700, (4700 - totalCash) / 4700, g.tradesDone / 50);
    const card = new Array(NUM_ANIMALS).fill(0); if (au) card[au.card] = 1; f.push(...card);
    f.push(au ? au.amount / M : 0, au ? (au.amount + 10) / M : 0, au && au.high === null ? 1 : 0,
      au ? VALUES[au.card] / M : 0, au ? g.animals[me][au.card] / 4 : 0);
    const ta = new Array(NUM_ANIMALS).fill(0);
    let tf = [0, 0, 0, 0, 0, 0];
    const opp = new Array(MAX_SEATS).fill(0);
    if (t !== null && (me === t.challenger || me === t.target)) {
      ta[t.animal] = 1;
      const other = me === t.challenger ? t.target : t.challenger;
      opp[mod(other - me, g.n)] = 1;
      tf = [me === t.challenger ? 1 : 0, me === t.target ? 1 : 0, t.k / 2,
        t.offer !== null ? sum(t.offer) / 10 : 0,
        t.offer !== null && me === t.challenger ? notesValue(t.offer) / M : 0,
        VALUES[t.animal] / M];
    }
    f.push(...ta, ...tf, ...opp);
    const pub = new Array(1 + 2 * MAX_SEATS + NUM_ANIMALS + 1 + 2).fill(0);
    if (t !== null) {
      pub[0] = 1;
      pub[1 + mod(t.challenger - me, g.n)] = 1;
      pub[1 + MAX_SEATS + mod(t.target - me, g.n)] = 1;
      pub[1 + 2 * MAX_SEATS + t.animal] = 1;
      pub[1 + 2 * MAX_SEATS + NUM_ANIMALS] = t.k / 2;
      pub[pub.length - 2] = t.stage === "offer" ? 1 : 0;
      pub[pub.length - 1] = t.stage === "respond" ? 1 : 0;
    }
    f.push(...pub);
    // Anzahl der Karten im verdeckten Stapel sieht jeder am Tisch (Wert nicht)
    f.push(t !== null && t.offer !== null ? sum(t.offer) / 10 : 0);
    return Float32Array.from(f);
  }

  // ====================================================================== Spielansicht
  function playerView(g, me, eventStart = 0) {
    const players = [];
    for (let p = 0; p < g.n; p++) {
      const d = { name: g.names[p], animals: g.animals[p].slice(), quartets: g.animals[p].filter((c) => c === 4).length, stack: stackSize(g.cash[p]) };
      if (p === me) { d.notes = g.cash[p].slice(); d.cash = g.cashValue(p); }
      if (g.revealedCash[p] !== null) d.revealed = notesValue(g.revealedCash[p]);
      players.push(d);
    }
    const view = {
      phase: g.phase, n: g.n, me, turn: g.turn, to_act: g.toAct, deck_left: g.deck.length, donkeys: g.donkeysDrawn,
      players, legal: g.toAct === me ? g.legalKinds() : [],
      animals: ANIMALS.map(([key, name, value]) => ({ key, name, value })),
      denoms: DENOMS.slice(), events: g.visibleEvents(me, eventStart), event_count: g.events.length,
      cap: bidCap(g.cashValue(me)),
    };
    const au = g.auction;
    if (au !== null) {
      const last = {};
      for (const k of Object.keys(au.last)) last[String(k)] = au.last[k];
      view.auction = { card: au.card, auctioneer: au.auctioneer, high: au.high, amount: au.amount, stage: au.stage,
        excluded: [...au.excluded].sort((a, b) => a - b), last, min_bid: au.amount + 10 };
    }
    const t = g.trade;
    if (t !== null) {
      const tv = { challenger: t.challenger, target: t.target, animal: t.animal, k: t.k, stage: t.stage,
        involved: me === t.challenger || me === t.target };
      if (t.offer !== null) {
        tv.offer_count = sum(t.offer);
        if (me === t.challenger) tv.my_offer = notesValue(t.offer);
      }
      view.trade = tv;
    }
    if (g.phase === "trade" && g.toAct === me && t === null) view.options = g.tradeOptions(me).map(([q, a]) => ({ target: q, animal: a }));
    if (g.phase === "over") {
      view.scores = g.scores();
      view.ranking = g.ranking();
      view.cash_all = [...Array(g.n).keys()].map((p) => g.cashValue(p));
    }
    return view;
  }

  const KH = {
    ANIMALS, NUM_ANIMALS, VALUES, NAMES, DENOMS, ESEL, MAX_SEATS, N_ACTIONS,
    notesValue, stackSize, bidCap, composePayment, pyRound, Game, IllegalAction,
    legalMask, decodeAction, observe, playerView, buildStack, atLeastOneCard,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = KH;
  else root.KH = KH;
})(typeof self !== "undefined" ? self : this);
