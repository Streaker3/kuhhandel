// Vergleicht die JavaScript-Engine Zug für Zug mit den Referenz-Partien aus Python.
//   node tests/parity/check.js
const fs = require("fs");
const path = require("path");
const KH = require("../../web/js/kuhhandel.js");

const traces = JSON.parse(fs.readFileSync(path.join(__dirname, "traces.json"), "utf8"));

function digest(g) {
  const au = g.auction, t = g.trade;
  return {
    phase: g.phase, to_act: g.toAct, turn: g.turn, cash: g.cash, animals: g.animals, bank: g.bank,
    known: g.known, revealed: g.revealedCash, deck: g.deck.length, donkeys: g.donkeysDrawn,
    trades: g.tradesDone, scores: g.scores(), ranking: g.ranking(),
    auction: au === null ? null : { card: au.card, auctioneer: au.auctioneer, high: au.high, amount: au.amount,
      stage: au.stage, excluded: [...au.excluded].sort((a, b) => a - b), passed: [...au.passed].sort((a, b) => a - b),
      bidders: au.bidders, last: au.last },
    trade: t === null ? null : { challenger: t.challenger, target: t.target, animal: t.animal, k: t.k, stage: t.stage,
      offer: t.offer, counter: t.counter, cash_before: t.cashBefore },
  };
}
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v));

let steps = 0, fails = 0;
function fail(ti, si, what, a, b) {
  fails++;
  if (fails <= 8) console.log(`ABWEICHUNG Partie ${ti}, Zug ${si}: ${what}\n  Python: ${String(a).slice(0, 400)}\n  JS:     ${String(b).slice(0, 400)}`);
}
traces.forEach((tr, ti) => {
  const g = new KH.Game(tr.n, { names: tr.names || undefined, deck: tr.deck });
  tr.steps.forEach((st, si) => {
    steps++;
    let ok = true;
    try { g.step(st.action); } catch (e) { ok = e instanceof KH.IllegalAction ? "IllegalAction" : `JS-Fehler: ${e.message}`; }
    if (ok !== st.ok) fail(ti, si, `Aktion ${JSON.stringify(st.action)} gültig?`, st.ok, ok);
    const d = canon(digest(g)), e = canon(st.state);
    if (d !== e) fail(ti, si, "Spielstand", e, d);
    if (g.events.length !== st.events) fail(ti, si, "Anzahl Meldungen", st.events, g.events.length);
    const me = g.toAct;
    const mask = me === null ? null : [...KH.legalMask(g)].flatMap((v, i) => (v ? [i] : []));
    if (JSON.stringify(mask) !== JSON.stringify(st.mask)) fail(ti, si, "erlaubte Aktionen", st.mask, mask);
    const check = (py, js, label) => {
      if (py === null) { if (js !== null) fail(ti, si, label, py, js); return; }
      if (py.length !== js.length) return fail(ti, si, `${label} Länge`, py.length, js.length);
      for (let i = 0; i < py.length; i++) if (Math.abs(py[i] - js[i]) > 1e-6) return fail(ti, si, `${label}[${i}]`, py[i], js[i]);
    };
    check(st.obs, me === null ? null : [...KH.observe(g)], "Beobachtung");
    check(st.obs0, [...KH.observe(g, 0)], "Beobachtung Spieler 0");
    const v = canon(KH.playerView(g, si % g.n, Math.max(0, g.events.length - 12)));
    if (v !== canon(st.view)) fail(ti, si, "Spielansicht", canon(st.view), v);
  });
  // komplette Meldungen am Ende (Texte, private Texte, Zusatzdaten)
  const evJS = canon(g.events.map((ev) => ({ ...ev, priv: Object.fromEntries(Object.entries(ev.priv).map(([k, v]) => [String(k), v])) })));
  if (evJS !== canon(tr.event_log)) fail(ti, "Ende", "Meldungen", canon(tr.event_log).slice(0, 300), evJS.slice(0, 300));
});
console.log(`${traces.length} Partien, ${steps} Züge verglichen: ${fails ? fails + " Abweichungen" : "alles identisch ✓"}`);
process.exit(fails ? 1 : 0);
