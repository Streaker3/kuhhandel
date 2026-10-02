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

  // init + actions: Startzustand und alle Züge – daraus lässt sich jede Stelle der Partie exakt nachspielen (Replay)
  const fresh = (init = null) => ({ init, actions: [], points: [], decisions: [], deals: [], trades: [],
    stats: { bids: 0, bluffs: 0, busts: 0, free: 0 }, skipped: false });
  const ensure = (d) => { d.trades = d.trades || []; d.stats = d.stats || { bids: 0, bluffs: 0, busts: 0, free: 0 }; return d; };

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
    ensure(data);
    if (action[0] === "bid") {
      data.stats.bids++;
      if (action[1] > g.cashValue(ME)) data.stats.bluffs++;
    }
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
    ensure(data);
    const evs = g.events.slice(evStart);
    // eigene Kuhhändel: beide Gebote (aus der Aufdeck-Szene) und Ausgang
    for (const ev of evs) {
      if (ev.kind === "reveal_bids" && (ev.challenger === ME || ev.target === ME)) data.pendingTrade = ev;
      if (ev.kind === "trade_result" && data.pendingTrade && (ev.challenger === ME || ev.target === ME)) {
        const rb = data.pendingTrade;
        data.pendingTrade = null;
        const iC = ev.challenger === ME, other = iC ? ev.target : ev.challenger;
        const vo = KH.notesValue(rb.offer), vc = rb.counter ? KH.notesValue(rb.counter) : null;
        const won = ev.winner === ME;
        let net;   // Geldfluss für mich (+ erhalten, − bezahlt)
        if (rb.accepted) net = iC ? -vo : vo;
        else if (vo === vc) net = 0;
        else net = won ? -Math.abs(vo - vc) : Math.abs(vo - vc);
        data.trades.push({
          key: KH.ANIMALS[ev.animal][0], animal: N()[ev.animal], a: ev.animal, k: ev.k, other: g.names[other],
          mine: iC ? vo : vc, theirs: iC ? vc : vo, myCnt: (iC ? rb.offer : rb.counter || []).reduce((x, y) => x + y, 0),
          theirCnt: (iC ? rb.counter || [] : rb.offer).reduce((x, y) => x + y, 0),
          accepted: !!rb.accepted, tie: !!ev.tie, won, net, iC,
        });
      }
      if (ev.kind === "bust" && ev.player === ME && !skip) data.stats.busts++;
      if (ev.kind === "free" && ev.player === ME && !skip) data.stats.free++;
    }
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
      // Untergrenze 1 %: solange die Partie läuft, ist niemand rechnerisch chancenlos
      const raw = Array.from({ length: g.n }, (_, p) => Math.max(0.01, Math.min(1, nn.forward(KH.observe(g, p), mask).value)));
      const tot = raw.reduce((a, b) => a + b, 0);
      all = raw.map((r) => r / tot);
    }
    all = all.map((x) => Math.round(x * 1000) / 1000);
    let label = marks.filter((e) => e.kind !== "phase" && e.kind !== "over").map(textOf).filter(Boolean).slice(0, 2).join(" ");
    if (skip) label = `⏭ (KI spielte für dich) ${label}`;
    data.points.push({ v: all[ME], all, label, p2: g.phase !== "auction", act: data.actions ? data.actions.length : undefined, ev: g.events.length });
    if (skip) data.skipped = true;
  }

  // ------------------------------------------------------------------ Schlüsselmomente & Replay
  const canReplay = (data) => !!(data.init && data.actions && data.points.length && data.points.every((p) => p.act !== undefined));
  const restart = (data) => KH.Game.fromJSON(JSON.parse(JSON.stringify(data.init)));

  /** Spielstand (Tiere, Geld, Punkte) an jedem Messpunkt – durch Nachspielen der Züge. */
  function snapshots(data) {
    const g = restart(data);
    let a = 0;
    return data.points.map((pt) => {
      while (a < pt.act) g.step(data.actions[a++]);
      return { animals: g.animals.map((x) => x.slice()), scores: g.scores(), cash: Array.from({ length: g.n }, (_, p) => g.cashValue(p)) };
    });
  }

  /** Was ist zwischen zwei Messpunkten passiert – in Klartext. */
  function describe(g, evs, before, after) {
    const nm = (p) => (p === ME ? "Du" : g.names[p]);
    const anim = (a) => N()[a];
    const main = evs.find((e) => e.kind === "trade_result") || evs.find((e) => ["sold", "bought", "free"].includes(e.kind))
      || evs.find((e) => e.kind === "bust") || evs.find((e) => e.kind === "donkey");
    let title = "", detail = "", key = null;
    if (main && main.kind === "trade_result") {
      const rb = evs.find((e) => e.kind === "reveal_bids");
      key = KH.ANIMALS[main.animal][0];
      title = `${nm(main.challenger)} ⚔ ${nm(main.target)} um ${main.k}× ${anim(main.animal)}`;
      if (rb && rb.accepted) detail = `${nm(main.target)} nimmt ${KH.notesValue(rb.offer)} an – ${nm(main.winner)} ${main.winner === ME ? "bekommst" : "bekommt"} die Karten.`;
      else if (rb) {
        const vo = KH.notesValue(rb.offer), vc = KH.notesValue(rb.counter);
        detail = `${nm(main.challenger)} ${vo} gegen ${nm(main.target)} ${vc} – ${vo === vc ? "Gleichstand, " : ""}${nm(main.winner)} ${main.winner === ME ? "gewinnst" : "gewinnt"}`
          + (vo === vc ? "." : ` und ${main.winner === ME ? "zahlst" : "zahlt"} ${Math.abs(vo - vc)}.`);
      }
    } else if (main && (main.kind === "sold" || main.kind === "bought" || main.kind === "free")) {
      key = KH.ANIMALS[main.card][0];
      const how = main.kind === "bought" ? "kauft per Vorkaufsrecht" : main.kind === "free" ? "bekommt kostenlos" : "ersteigert";
      title = `${nm(main.player)} ${main.player === ME ? how.replace("kauft", "kaufst").replace("bekommt", "bekommst").replace("ersteigert", "ersteigerst") : how} ${anim(main.card)}`;
      if (main.kind !== "free") {
        detail = `für ${main.amount}`;
      }
    } else if (main && main.kind === "bust") {
      title = `${nm(main.player)} ${main.player === ME ? "fliegst" : "fliegt"} auf`;
      detail = "Das Geld wird offengelegt, die Karte neu versteigert.";
    } else if (main && main.kind === "donkey") {
      title = "Esel-Bonus"; detail = `Alle bekommen ${main.amount}.`;
    }
    // Folgen: neue Quartette
    const conseq = [];
    for (let p = 0; p < g.n; p++) for (let a = 0; a < KH.NUM_ANIMALS; a++) {
      if (after.animals[p][a] === 4 && before.animals[p][a] !== 4) {
        const q = after.animals[p].filter((c) => c === 4).length;
        conseq.push(`${nm(p)} schließt das ${anim(a)}-Quartett – ${q} Quartett${q === 1 ? "" : "e"}, ${after.scores[p]} Punkte`);
      }
    }
    return { title, detail, key, conseq };
  }

  /** Schlüsselmomente für mich: dort, wo meine Siegchance am stärksten und dauerhaft gesprungen ist. */
  function moments(data, g) {
    const pts = data.points;
    if (pts.length < 4) return [];
    const v = (i) => pts[Math.max(0, Math.min(pts.length - 2, i))].v;
    const cand = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const raw = pts[i].v - pts[i - 1].v;
      const smooth = (v(i) + v(i + 1)) / 2 - (v(i - 1) + v(i - 2)) / 2;   // hält die Änderung an?
      if (Math.abs(raw) >= 0.06 && Math.sign(smooth) === Math.sign(raw) && Math.abs(smooth) >= 0.6 * Math.abs(raw)) cand.push({ i, d: raw });
    }
    cand.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const picked = [];
    for (const c of cand) if (picked.length < 4 && picked.every((q) => Math.abs(q.i - c.i) > 1)) picked.push(c);
    picked.sort((a, b) => a.i - b.i);
    const replay = canReplay(data);
    const snaps = replay ? snapshots(data) : null;
    return picked.map((c) => {
      const p0 = pts[c.i - 1], p1 = pts[c.i];
      const evs = g.events.slice(p0.ev ?? 0, p1.ev ?? 0);
      const desc = snaps ? describe(g, evs, snaps[c.i - 1], snaps[c.i]) : { title: p1.label, detail: "", key: null, conseq: [] };
      if (!desc.title) desc.title = p1.label;
      return { i: c.i, d: c.d, ...desc, before: p0.all || null, after: p1.all || null, replay, skip: (p1.label || "").startsWith("⏭") };
    });
  }

  /** Ansichten für das Replay eines Moments: Stand davor und nach jedem Zug bis zum Moment. */
  function replay(data, i) {
    if (!canReplay(data) || i < 1 || i >= data.points.length) return { error: "Kein Replay" };
    const g = restart(data);
    const a0 = data.points[i - 1].act, a1 = data.points[i].act;
    for (let a = 0; a < a0; a++) g.step(data.actions[a]);
    const viewOf = (from) => ({ ...KH.playerView(g, ME, from), bot_turn: false });
    const start = viewOf(g.events.length);
    const steps = [];
    for (let a = a0; a < a1; a++) {
      const from = g.events.length;
      g.step(data.actions[a]);
      steps.push(viewOf(from));
    }
    return { start, steps };
  }

  /** Üblicher Netto-Preis je Karte im Kuhhandel (was der Gewinner im Schnitt zahlt). */
  function tradePrice(a, n) {
    const T = root.TRADE_MARKET || {};
    return T[`${a}-${n}`] || T[`${a}-x`] || null;
  }

  /** Auswertung für das Statistik-Fenster: nur das Auffälligste, getrennt nach Versteigerung und Kuhhandel. */
  function summary(data, g) {
    ensure(data);
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
    const picked = [];
    for (const t of turns) if (picked.length < 3 && picked.every((q) => Math.abs(q.i - t.i) > 2)) picked.push(t);

    const dec = data.decisions;
    const share = (c) => {
      const s = dec.filter((d) => !c || d.cat === c);
      return s.length ? { agree: s.filter((d) => d.agree).length, n: s.length } : null;
    };
    const notableOf = (cat, k) => {
      const seen = new Set();
      return dec.filter((d) => d.cat === cat && d.sev >= 0.6 && d.text).sort((a, b) => b.sev - a.sev)
        .filter((d) => (seen.has(d.ctx) ? false : seen.add(d.ctx))).slice(0, k);
    };

    // ---- Versteigerung
    const all = data.deals.map((d) => ({ ...d, diff: d.price - d.market }));
    const buys = all.filter((d) => d.type === "buy"), sells = all.filter((d) => d.type === "sell");
    const ratio = (xs) => (xs.length ? xs.reduce((s, d) => s + d.price / d.market, 0) / xs.length : null);
    const auction = {
      bought: buys.length, vorkauf: buys.filter((d) => d.vorkauf).length, sold: sells.length, free: data.stats.free,
      spent: buys.reduce((s, d) => s + d.price, 0), earned: sells.reduce((s, d) => s + d.price, 0),
      buyRatio: ratio(buys), sellRatio: ratio(sells),
      bids: data.stats.bids, bluffs: data.stats.bluffs, busts: data.stats.busts,
      deals: all.filter((d) => Math.abs(d.diff) >= Math.max(20, 0.25 * d.market))
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 6),
      notable: notableOf("auction", 2), agree: share("auction"),
    };

    // ---- Kuhhandel: Highlights = bester, schlechtester und knappster Handel
    const tr = data.trades.map((t) => {
      const ref = (tradePrice(t.a, g.n) || 100) * t.k;
      // Bewertung aus meiner Sicht: gewonnen -> wie günstig; verloren -> wie viel bekommen
      const score = t.won ? (ref + t.net) / ref : (t.net - ref) / ref;
      return { ...t, ref: Math.round(ref), score };
    });
    // alle auffällig guten/schlechten Händel plus die knappen, höchstens 6
    const kindOf = (t) => {
      const close = !t.accepted && !t.tie && t.theirs !== null && t.mine !== null
        && Math.abs(t.mine - t.theirs) <= Math.max(30, 0.1 * Math.max(t.mine, t.theirs));
      if (t.score >= 0.3) return t.won ? "bargain" : "sold";
      if (t.score <= -0.3) return t.won ? "ripoff" : "cheap";
      if (close) return t.won ? "closewin" : "closeloss";
      return null;
    };
    const hl = tr.map((t) => ({ t, kind: kindOf(t) })).filter((h) => h.kind)
      .sort((a, b) => Math.abs(b.t.score) - Math.abs(a.t.score)).slice(0, 6);
    const trade = {
      n: tr.length, won: tr.filter((t) => t.won).length,
      paid: tr.filter((t) => t.net < 0).reduce((s, t) => s - t.net, 0),
      received: tr.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0),
      challenged: tr.filter((t) => t.iC).length,
      highlights: hl.map(({ t, kind }) => ({ ...t, kind })),
      notable: notableOf("trade", 2), agree: share("trade"),
    };

    const p2At = pts.findIndex((p) => p.p2);
    return {
      points: pts.map((p) => p.v), labels: pts.map((p) => p.label), p2At,
      turns: picked.sort((a, b) => a.i - b.i), moments: moments(data, g),
      auction, trade, agree: share(),
      skipped: data.skipped, n: g.n, won: g.winner() === ME, names: g.names.slice(),
      others: pts.length && pts.every((p) => p.all) ? g.names.map((_, q) => pts.map((p) => p.all[q])) : null,
    };
  }

  root.Coach = { fresh, before, after, summary, replay, marketPrice };
})(typeof self !== "undefined" ? self : this);
