/* Kuhhandel – Gegner im Browser: trainiertes Netz (Leicht/Schwer), Mischung (Mittel) und einfache Bots.
 * Das Netz rechnet exakt wie kuhhandel/model.py (3 Schichten à 512 mit ReLU, dann Policy- und Value-Kopf).
 */
(function (root) {
  "use strict";
  const KH = root.KH || (typeof require !== "undefined" ? require("./kuhhandel.js") : null);
  const { DENOMS, VALUES, bidCap, composePayment, notesValue } = KH;

  // ====================================================================== Netz
  class PolicyNet {
    constructor(buffer, layers) {
      const f = new Float32Array(buffer);
      let o = 0;
      this.w = {};
      for (const [name, shape] of Object.entries(layers)) {
        const size = shape.reduce((a, b) => a * b, 1);
        this.w[name] = { data: f.subarray(o, o + size), shape };
        o += size;
      }
    }
    _linear(name, x, relu) {
      const W = this.w[`${name}.weight`], b = this.w[`${name}.bias`].data;
      const [out, inn] = W.shape, d = W.data;
      const y = new Float32Array(out);
      for (let i = 0; i < out; i++) {
        let s = b[i];
        const row = i * inn;
        for (let j = 0; j < inn; j++) s += d[row + j] * x[j];
        y[i] = relu && s < 0 ? 0 : s;
      }
      return y;
    }
    /** Liefert Logits (nicht erlaubte Aktionen = -1e9) und die geschätzte Siegwahrscheinlichkeit. */
    forward(obs, mask) {
      let h = this._linear("body.0", obs, true);
      h = this._linear("body.2", h, true);
      h = this._linear("body.4", h, true);
      const logits = this._linear("pi", h, false);
      for (let i = 0; i < logits.length; i++) if (!mask[i]) logits[i] = -1e9;
      return { logits, value: this._linear("v", h, false)[0] };
    }
  }

  function sample(logits) {
    let max = -Infinity;
    for (const l of logits) if (l > max) max = l;
    let total = 0;
    const p = Array.from(logits, (l) => { const e = Math.exp(l - max); total += e; return e; });
    let r = Math.random() * total;
    for (let i = 0; i < p.length; i++) { r -= p[i]; if (r <= 0) return i; }
    return p.length - 1;
  }

  class NNBot {
    constructor(net) { this.net = net; }
    act(g) {
      const { logits } = this.net.forward(KH.observe(g), KH.legalMask(g));
      return KH.decodeAction(g, sample(logits));
    }
  }

  // ====================================================================== Einfache Bots (wie HeuristicBot)
  const TOTAL_QUARTET_VALUE = VALUES.reduce((a, b) => a + b, 0);
  const MONEY_PER_PLAYER = 940;
  const AVG_NOTE_GUESS = 60;
  const uniform = (a, b) => a + Math.random() * (b - a);
  const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const choice = (xs) => xs[Math.floor(Math.random() * xs.length)];

  class HeuristicBot {
    constructor(aggression = 1.0, bluff = 0.08) { this.aggression = aggression; this.bluff = bluff; }
    cardValue(g, p, animal, k = 1) {
      const own = g.animals[p][animal];
      let factor = { 0: 0.8, 1: 1.0, 2: 1.35, 3: 1.8 }[own] ?? 0;
      if (own + k >= 4) factor *= 1.3;
      let maxOther = 0;
      for (let q = 0; q < g.n; q++) if (q !== p) maxOther = Math.max(maxOther, g.animals[q][animal]);
      if (maxOther >= 3 && own + k < 4) factor *= 0.7;
      const ratio = (g.n * MONEY_PER_PLAYER) / TOTAL_QUARTET_VALUE;
      return (VALUES[animal] / 4) * k * factor * ratio * this.aggression;
    }
    leaderPenalty(g, p, q) { const sc = g.scores(); return sc[q] > sc[p] ? 1.15 : 1.0; }
    act(g) {
      const p = g.toAct, kinds = g.legalKinds();
      if (g.phase === "auction") {
        const au = g.auction;
        if (au.stage === "bidding") return this._bid(g, p);
        const val = this.cardValue(g, p, au.card);
        if (kinds.includes("buy") && val >= au.amount && g.cashValue(p) - au.amount > 20) return ["buy"];
        return ["take"];
      }
      const t = g.trade;
      if (t === null) return this._challenge(g, p);
      if (t.stage === "offer") {
        const val = this.cardValue(g, p, t.animal, t.k) * this.leaderPenalty(g, p, t.target);
        return ["offer", this._stack(g, p, val * uniform(0.55, 0.9))];
      }
      const guess = t.offer.reduce((a, b) => a + b, 0) * AVG_NOTE_GUESS;
      const keep = this.cardValue(g, p, t.animal, t.k);
      const lossIfLose = this.cardValue(g, t.challenger, t.animal, t.k) * 0.3;
      if (keep + lossIfLose < guess * 0.9 || g.cashValue(p) < 10) return ["accept"];
      return ["counter", this._stack(g, p, Math.min(keep, guess * uniform(1.0, 1.5)))];
    }
    _bid(g, p) {
      const au = g.auction;
      const val = this.cardValue(g, p, au.card) * uniform(0.85, 1.15);
      const cash = g.cashValue(p);
      let limit = Math.min(val, cash);
      if (Math.random() < this.bluff) limit = Math.min(val * 1.2, bidCap(cash));
      const need = au.amount + 10;
      if (need > limit) return ["pass"];
      const step = need > 0.7 * limit ? 10 : choice([10, 10, 20, 50]);
      const amount = Math.min(Math.floor(Math.floor(limit) / 10) * 10, au.amount + step);
      return ["bid", Math.max(need, amount)];
    }
    _challenge(g, p) {
      let best = null, bestS = -1e9;
      for (const [q, a] of g.tradeOptions(p)) {
        const k = g.animals[p][a] >= 2 && g.animals[q][a] >= 2 ? 2 : 1;
        const s = this.cardValue(g, p, a, k) * this.leaderPenalty(g, p, q) + uniform(0, 20);
        if (s > bestS) { best = [q, a]; bestS = s; }
      }
      return ["challenge", ...best];
    }
    _stack(g, p, target) {
      const notes = g.cash[p].slice();
      target = Math.max(0, Math.min(Math.floor(Math.trunc(target) / 10) * 10, notesValue(notes)));
      let pay = (composePayment(notes, target) || DENOMS.map(() => 0)).slice();
      if (notesValue(pay) > target * 1.4 + 50) pay = (composePayment(notes, Math.max(0, Math.floor(target / 2))) || DENOMS.map(() => 0)).slice();
      pay[0] = randint(0, notes[0]);
      return KH.atLeastOneCard(pay, notes);
    }
  }

  /** Mittel: bei jedem Zug entscheidet mit Wahrscheinlichkeit pAi die KI, sonst ein einfacher Bot. */
  class MixedBot {
    constructor(net, pAi = 0.55) { this.ai = new NNBot(net); this.heur = new HeuristicBot(); this.pAi = pAi; }
    act(g) { return (Math.random() < this.pAi ? this.ai : this.heur).act(g); }
  }

  // ====================================================================== Laden
  const cache = {};
  /** Lädt ein Netz aus web/models (im Browser per fetch). */
  async function loadNet(name, base = "") {
    if (cache[name]) return cache[name];
    const meta = await (await fetch(`${base}models/models.json`)).json();
    const buf = await (await fetch(`${base}${meta.models[name].file}`)).arrayBuffer();
    cache[name] = new PolicyNet(buf, meta.layers);
    return cache[name];
  }
  /** Gegner je Schwierigkeit: leicht = früher Trainingsstand, mittel = Mischung, schwer = beste KI. */
  async function makeBot(opponents, level) {
    if (opponents !== "ai") return new HeuristicBot();
    if (level === "leicht") return new NNBot(await loadNet("leicht"));
    if (level === "mittel") return new MixedBot(await loadNet("schwer"), 0.55);
    return new NNBot(await loadNet("schwer"));
  }

  const AI = { PolicyNet, NNBot, HeuristicBot, MixedBot, loadNet, makeBot, sample };
  if (typeof module !== "undefined" && module.exports) module.exports = AI;
  else root.AI = AI;
})(typeof self !== "undefined" ? self : this);
