/* Kuhhandel – Rückblick nach der Partie.
 * Die KI „Schwer“ schaut bei jeder eigenen Entscheidung mit (nur mit dem Wissen des Spielers) und merkt sich,
 * was sie getan hätte. Nebenbei: Siegchance-Verlauf aus Sicht der KI und Preise im Vergleich zum Marktpreis.
 * Während des Spiels wird nichts angezeigt.
 */
(function (root) {
  "use strict";
  const KH = root.KH;
  const ME = 0;
  const N = () => KH.NAMES;

  const fresh = () => ({ points: [], decisions: [], deals: [], skipped: false });

  let netP = null;
  const net = () => (netP = netP || root.AI.loadNet("schwer"));

  function softmax(logits) {
    let m = -Infinity;
    for (const l of logits) if (l > m) m = l;
    const e = Array.from(logits, (l) => Math.exp(l - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }
  const pct = (p) => `${Math.round(p * 100)} %`;
  const r10 = (x) => Math.round(x / 10) * 10;
  const nameOf = (g, p) => (p === ME ? "dich" : g.names[p]);
  const cardNo = (g) => 40 - g.deck.length;

  /** Üblicher Preis für ein Tier zu diesem Zeitpunkt (aus market.js), sonst null. */
  function marketPrice(card, n, left) {
    const M = root.MARKET || {};
    const b = Math.floor(left / 5);
    const hit = M[`${card}-${n}-${b}`] || M[`${card}-x-${b}`] || M[`${card}-${n}-x`];
    return hit ? hit[0] : null;
  }

  /** Vor einer eigenen Aktion: was hätte die KI getan? */
  async function before(data, g, action) {
    const nn = await net();
    const mask = KH.legalMask(g);
    const { logits } = nn.forward(KH.observe(g, ME), mask);
    const prob = softmax(logits);
    const opts = [];
    for (let i = 0; i < prob.length; i++) if (mask[i] && prob[i] > 1e-4) opts.push({ a: KH.decodeAction(g, i), p: prob[i] });
    const kind = action[0];
    const au = g.auction, t = g.trade;
    const rec = { cat: "", agree: true, sev: 0, text: "", ctx: "" };

    if (kind === "bid" || kind === "pass") {
      const animal = N()[au.card];
      rec.cat = "auction";
      rec.ctx = `Karte ${cardNo(g)} · ${animal}`;
      const pPass = opts.filter((o) => o.a[0] === "pass").reduce((s, o) => s + o.p, 0);
      const bids = opts.filter((o) => o.a[0] === "bid");
      const pBid = 1 - pPass;
      const aiBid = pBid > 0 ? r10(bids.reduce((s, o) => s + o.p * o.a[1], 0) / pBid) : 0;
      if (kind === "bid") {
        rec.agree = pBid >= 0.5;
        if (pPass >= 0.75) {
          rec.sev = pPass;
          rec.text = `Du hast ${action[1]} für ${animal} geboten – die KI wäre hier ausgestiegen (zu ${pct(pPass)}).`;
        }
      } else {
        rec.agree = pPass >= 0.5;
        if (pBid >= 0.75) {
          rec.sev = pBid;
          rec.text = `Du hast bei ${animal} gepasst (Höchstgebot ${au.amount}) – die KI hätte weitergeboten, etwa ${aiBid}.`;
        }
      }
    } else if (kind === "take" || kind === "buy") {
      const animal = N()[au.card];
      rec.cat = "auction";
      rec.ctx = `Karte ${cardNo(g)} · ${animal}`;
      const pBuy = opts.filter((o) => o.a[0] === "buy").reduce((s, o) => s + o.p, 0);
      rec.agree = kind === "buy" ? pBuy >= 0.5 : pBuy < 0.5;
      if (kind === "buy" && pBuy < 0.25) {
        rec.sev = 1 - pBuy;
        rec.text = `Du hast ${animal} per Vorkaufsrecht für ${au.amount} selbst gekauft – die KI hätte das Geld genommen.`;
      } else if (kind === "take" && pBuy > 0.75) {
        rec.sev = pBuy;
        rec.text = `Du hast ${au.amount} für ${animal} genommen – die KI hätte die Karte per Vorkaufsrecht behalten.`;
      }
    } else if (kind === "challenge") {
      rec.cat = "trade";
      const [, q, a] = action;
      rec.ctx = `Kuhhandel · ${N()[a]}`;
      const mineP = opts.filter((o) => o.a[0] === "challenge" && o.a[1] === q && o.a[2] === a).reduce((s, o) => s + o.p, 0);
      const top = opts.filter((o) => o.a[0] === "challenge").sort((x, y) => y.p - x.p)[0];
      rec.agree = top && top.a[1] === q && top.a[2] === a;
      if (top && !rec.agree && mineP < 0.1 && top.p >= 0.5) {
        rec.sev = top.p - mineP;
        rec.text = `Du hast ${g.names[q]} um ${N()[a]} herausgefordert – die KI hätte ${g.names[top.a[1]]} um ${N()[top.a[2]]} herausgefordert.`;
      }
    } else if (kind === "offer" || kind === "counter" || kind === "accept") {
      rec.cat = "trade";
      const animal = N()[t.animal];
      const other = kind === "offer" ? t.target : t.challenger;
      rec.ctx = `Kuhhandel · ${t.k}× ${animal} mit ${g.names[other]}`;
      const stacks = opts.filter((o) => o.a[0] === "offer" || o.a[0] === "counter");
      const pStack = stacks.reduce((s, o) => s + o.p, 0);
      const aiVal = pStack > 0 ? r10(stacks.reduce((s, o) => s + o.p * KH.notesValue(o.a[1]), 0) / pStack) : 0;
      const pAcc = opts.filter((o) => o.a[0] === "accept").reduce((s, o) => s + o.p, 0);
      if (kind === "accept") {
        rec.agree = pAcc >= 0.5;
        if (pAcc < 0.2) {
          rec.sev = 1 - pAcc;
          rec.text = `Du hast ${g.names[other]}s Gebot (${t.offer.reduce((a, b) => a + b, 0)} Karten) für ${animal} angenommen – die KI hätte ein Gegengebot gemacht, etwa ${aiVal}.`;
        }
      } else {
        const h = KH.notesValue(action[1]);
        const diff = h - aiVal;
        rec.agree = Math.abs(diff) < Math.max(100, 0.35 * aiVal) && (kind === "offer" || pAcc < 0.5);
        if (kind === "counter" && pAcc > 0.8) {
          rec.sev = pAcc;
          rec.text = `Du hast bei ${animal} ein Gegengebot (${h}) gemacht – die KI hätte ${g.names[other]}s Gebot angenommen.`;
        } else if (Math.abs(diff) >= 150) {
          rec.sev = Math.min(1, Math.abs(diff) / (aiVal + 150));
          const was = kind === "offer" ? "Verdecktes Gebot" : "Gegengebot";
          rec.text = `${was} für ${t.k}× ${animal}: du ${h}, die KI hätte etwa ${aiVal} gelegt.`;
        }
      }
    }
    if (rec.cat) data.decisions.push(rec);
  }

  /** Nach jedem Schritt (eigener oder Gegner): Siegchance und Preise festhalten. */
  async function after(data, g, auBefore, evStart, { skip = false } = {}) {
    const evs = g.events.slice(evStart);
    const textOf = (ev) => (ev.priv && ev.priv[ME] ? ev.priv[ME] : ev.pub);
    if (!skip) {
      for (const ev of evs) {
        if (!auBefore || (ev.kind !== "sold" && ev.kind !== "bought")) continue;
        const mp = marketPrice(ev.card, g.n, g.deck.length);
        if (mp === null) continue;
        const animal = N()[ev.card];
        // eigener Kauf (ersteigert oder per Vorkaufsrecht) oder eigener Verkauf als Versteigerer
        const key = KH.ANIMALS[ev.card][0];
        if (ev.player === ME) data.deals.push({ type: "buy", animal, key, price: ev.amount, market: mp, vorkauf: ev.kind === "bought" });
        else if (ev.kind === "sold" && auBefore.auctioneer === ME)
          data.deals.push({ type: "sell", animal, key, price: ev.amount, market: mp, who: g.names[ev.player] });
      }
    }
    const marks = evs.filter((e) => ["sold", "bought", "free", "bust", "trade_result", "donkey", "phase", "over"].includes(e.kind));
    if (!marks.length && data.points.length) return;
    // Siegchance aller Spieler – jede aus Sicht des jeweiligen Spielers, dann auf 100 % zusammen normiert
    let all;
    if (g.phase === "over") all = Array.from({ length: g.n }, (_, p) => (g.winner() === p ? 1 : 0));
    else {
      const nn = await net();
      const mask = new Uint8Array(KH.N_ACTIONS).fill(1);
      const raw = Array.from({ length: g.n }, (_, p) => Math.max(0.002, Math.min(1, nn.forward(KH.observe(g, p), mask).value)));
      const tot = raw.reduce((a, b) => a + b, 0);
      all = raw.map((r) => r / tot);
    }
    all = all.map((x) => Math.round(x * 1000) / 1000);
    let label = marks.filter((e) => e.kind !== "phase" && e.kind !== "over").map(textOf).filter(Boolean).slice(0, 2).join(" ");
    if (skip) label = `⏭ (KI spielte für dich) ${label}`;
    data.points.push({ v: all[ME], all, label, p2: g.phase !== "auction" });
    if (skip) data.skipped = true;
  }

  /** Auswertung für das Statistik-Fenster: nur das Auffälligste. */
  function summary(data, g) {
    const pts = data.points;
    const turns = [];
    // Wendepunkt = Änderung, die anhält: Schnitt der 2 Punkte danach gegen die 2 davor (glättet Rauschen der Einschätzung).
    // Der letzte Punkt (Spielende: 0 oder 1) zählt nicht mit.
    const v = (i) => pts[Math.max(0, Math.min(pts.length - 2, i))].v;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = (v(i) + v(i + 1)) / 2 - (v(i - 1) + v(i - 2)) / 2;
      if (Math.abs(d) >= 0.08 && pts[i].label) turns.push({ i, d, label: pts[i].label });
    }
    turns.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    // nicht zweimal dieselbe Stelle (benachbarte Punkte)
    const picked = [];
    for (const t of turns) if (picked.length < 3 && picked.every((q) => Math.abs(q.i - t.i) > 2)) picked.push(t);
    const deals = data.deals
      .map((d) => ({ ...d, diff: d.price - d.market }))
      .filter((d) => Math.abs(d.diff) >= Math.max(20, 0.3 * d.market))
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 3);
    const dec = data.decisions;
    const share = (c) => {
      const s = dec.filter((d) => !c || d.cat === c);
      return s.length ? { agree: s.filter((d) => d.agree).length, n: s.length } : null;
    };
    // je Karte/Kuhhandel nur der deutlichste Hinweis
    const seen = new Set();
    const notable = dec.filter((d) => d.sev >= 0.6 && d.text).sort((a, b) => b.sev - a.sev)
      .filter((d) => (seen.has(d.ctx) ? false : seen.add(d.ctx))).slice(0, 3);
    const p2At = pts.findIndex((p) => p.p2);
    return {
      points: pts.map((p) => p.v), labels: pts.map((p) => p.label), p2At,
      turns: picked.sort((a, b) => a.i - b.i),
      deals, notable, agree: { all: share(), auction: share("auction"), trade: share("trade") },
      skipped: data.skipped, n: g.n, won: g.winner() === ME, names: g.names.slice(),
      others: pts.length && pts.every((p) => p.all) ? g.names.map((_, q) => pts.map((p) => p.all[q])) : null,
    };
  }

  root.Coach = { fresh, before, after, summary, marketPrice };
})(typeof self !== "undefined" ? self : this);
