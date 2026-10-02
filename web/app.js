"use strict";

const EMOJI = {
  pferd: "🐴", kuh: "🐄", schwein: "🐖", esel: "🫏", ziege: "🐐",
  schaf: "🐑", hund: "🐕", katze: "🐈", gans: "🪿", hahn: "🐓",
};
// Avatar pro Sitz (Ausschnitt einer Tierkarte): Ich, Berta, Konrad, Hilde, Gustav
const AVATAR_ANIMAL = ["hahn", "kuh", "esel", "schwein", "ziege"];
const A = "assets/web/";
const tierImg = (key) => `${A}tier_${key}.webp`;
const geldImg = (d) => `${A}geld_${d}.webp`;
// Touch-Geräte (Handy/Tablet): kein Hover, Tippen statt Überfahren
const TOUCH = matchMedia("(hover: none)").matches;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// Tempo der Gegner: [Label, Pause normal, Pause nach wichtigen Ereignissen]
const SPEEDS = [["🐢 Langsam", 1400, 2800], ["🐇 Normal", 850, 2100], ["⚡ Schnell", 350, 1200]];
const FAST = location.search.includes("fast");
let speed = 1;
try { speed = +(localStorage.getItem("kh-speed") ?? 1) % SPEEDS.length; } catch (e) { /* egal */ }

let V = null;              // aktuelle Ansicht vom Server
let since = 0;             // Anzahl bereits gesehener Ereignisse
let selected = [0, 0, 0, 0, 0, 0]; // für Kuhhandel ausgewählte Geldkarten je Stückelung
let selectMode = null;     // "offer" | "counter" | null
let bidValue = 0;
let bidSnap = null;        // {from, to}: Gebot wurde automatisch auf einen passend zahlbaren Betrag erhöht
let bidKey = "";
// Komfort: nach zweimal Passen beim selben Tier passt man automatisch weiter (nur für dieses Tier)
let passCount = { key: "", n: 0 };
let autoPassKey = "";
let autoPassTimer = null;
// Schlüssel der laufenden Versteigerung; eine Wiederholung nach dem Auffliegen zählt als neue (Aussteigen endet dann)
const animalKeyNow = () => (V.auction ? `${V.auction.card}-${V.deck_left}-${V.auction.excluded.length}` : "");
function myPass() {
  const k = animalKeyNow();
  passCount = passCount.key === k ? { key: k, n: passCount.n + 1 } : { key: k, n: 1 };
  if (passCount.n >= 2) autoPassKey = k;
  act({ kind: "pass" });
}         // ändert sich mit Karte/Wiederholung/Mindestgebot -> Gebotsfeld zurücksetzen
let botTimer = null;
let busy = false;
let bidHistory = [];       // Gebote der laufenden Versteigerung
let lastBubble = {};       // p -> zuletzt angezeigte Sprechblase (für Animation nur bei Änderung)
let lastAmount = null;
let revealHoldUntil = 0;   // nach einem Verkauf: nächste Karte erst nach Flug + kurzer Pause aufdecken
let actionHoldUntil = 0;   // Aktionsfeld erst freigeben, wenn die neue Karte umgedreht ist
let holdTimer = null;
const REVEAL_PAUSE = 500;

// --------------------------------------------------------------- Spielleiter (läuft im Browser, siehe js/local.js)
async function api(path, body) {
  const j = await Local.call(path, { ...(body || {}), since });
  if (j.error) {
    // Ansicht war veraltet -> neu synchronisieren statt hängen zu bleiben
    panelErr = j.error;
    panelErrUntil = Date.now() + 4000;
    resync();
    return null;
  }
  return j;
}
async function resync() {
  clearTimeout(botTimer);
  const v = await Local.call("/api/state", { since });
  if (v && v.phase && v.phase !== "none") { busy = false; accept(v); }
}

function accept(view) {
  if (!view) return;
  const events = view.events.filter((e) => e.i >= since);
  const rv = events.find((e) => e.kind === "reveal_bids");
  if (rv && V && !FAST && events.length < 25) {
    // Erst die Gebote aufdecken, dann Ergebnis, Kartenflüge und nächster Zug
    since = view.event_count;
    clearTimeout(botTimer);
    showReveal(rv, () => applyView(view, events));
    return;
  }
  applyView(view, events);
}

function applyView(view, events) {
  const prev = V;
  const flights = prev && events.length < 25 ? planFlights(prev, events) : [];
  if (events.some((e) => ["sold", "bought", "free"].includes(e.kind)) && events.length < 25) {
    revealHoldUntil = Date.now() + FLY_MS + REVEAL_PAUSE;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(render, FLY_MS + REVEAL_PAUSE + 20);
  }
  V = view;
  for (const ev of events) handleEvent(ev);
  since = Math.max(since, view.event_count);
  render();
  runFlights(flights);
  // Quartett-Moment und Scheinwerfer erst, wenn die Kuhhandel-Animation am Tisch vorbei ist
  const afterTrade = Math.max(0, tradeAnimEnd - Date.now());
  if (prev && events.length < 25) quartetMoments(prev, afterTrade);
  if (V.phase === "trade" && !V.trade && V.to_act !== null && V.to_act !== lastTurnP) {
    const from = lastTurnP, to = V.to_act;
    if (prev && prev.phase === "trade") setTimeout(() => spotlightTurn(from, to), Math.max(700, afterTrade + 200));
    lastTurnP = V.to_act;
  }
  if (focusP !== null && !(V.phase === "trade" && !V.trade && V.to_act === V.me)) unfocusSeat();
  scheduleBot(events);
}

function scheduleBot(events) {
  clearTimeout(botTimer);
  if (!V || !V.bot_turn) return;
  const big = events.some((e) => ["sold", "bought", "free", "bust", "trade_result", "donkey", "phase", "challenge"].includes(e.kind));
  const [, normal, pause] = SPEEDS[speed];
  let delay = FAST ? 15 : big ? pause : normal;
  const trade = events.find((e) => e.kind === "trade_result");
  if (trade && !FAST) {
    delay += [2000, 1000, 0][speed];
    // eigenen Handel etwas länger stehen lassen, damit man das Ergebnis lesen kann
    if (trade.winner === V.me || trade.loser === V.me) delay = Math.max(delay, 3400);
    if (speed !== 2) delay = Math.max(delay, tradeAnimEnd - Date.now() + 300);   // erst nach der Tisch-Animation weiter
  }
  botTimer = setTimeout(async () => accept(await api("/api/bot_step", {})), delay);
}

async function act(action) {
  if (busy) return;
  busy = true;
  selectMode = null;
  selected = [0, 0, 0, 0, 0, 0];
  const v = await api("/api/act", { action });
  busy = false;
  if (v) accept(v); else render();
}

// --------------------------------------------------------------- Bausteine
const nameOf = (p) => (p === V.me ? "Du" : V.players[p].name);
const animalKey = (a) => V.animals[a].key;

// Alle Kartenbilder vorladen, damit neue Karten (z. B. nach dem Überspringen) sofort ein Bild haben
const PRELOAD = [];
["pferd", "kuh", "schwein", "esel", "ziege", "schaf", "hund", "katze", "gans", "hahn"].forEach((k) => PRELOAD.push(`${A}tier_${k}.webp`));
[0, 10, 50, 100, 200, 500].forEach((d) => PRELOAD.push(`${A}geld_${d}.webp`));
PRELOAD.push(`${A}rueckseite.webp`, `${A}rueckseite_geld.webp`);
const PRELOADED = PRELOAD.map((src) => { const i = new Image(); i.src = src; return i; });

// Eigene Profilbilder (assets/web/avatar_<key>.webp), sonst Ausschnitt einer Tierkarte
const AVATAR_KEY = ["du", "berta", "konrad", "hilde", "gustav"];
const avatarOk = {};
AVATAR_KEY.forEach((k) => {
  const img = new Image();
  img.onload = () => { avatarOk[k] = true; if (V) { $("#seats").querySelectorAll(".seat").forEach((s) => { s.dataset.html = ""; }); render(); } };
  img.src = `${A}avatar_${k}.webp?v=2`;
});
const GAVEL = `<svg class="gavel" viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-38 14 13)">
  <rect x="4" y="5" width="18" height="9" rx="2.5" fill="#f5c542" stroke="#3d2614" stroke-width="2.2"/>
  <rect x="3" y="6.5" width="3" height="6" rx="1" fill="#d9a41f" stroke="#3d2614" stroke-width="1.6"/>
  <rect x="20" y="6.5" width="3" height="6" rx="1" fill="#d9a41f" stroke="#3d2614" stroke-width="1.6"/>
  <rect x="11" y="14" width="4" height="15" rx="1.6" fill="#a86f38" stroke="#3d2614" stroke-width="2"/></g>
  <rect x="17" y="25.5" width="13" height="4.5" rx="1.6" fill="#a86f38" stroke="#3d2614" stroke-width="2"/></svg>`;

function avatarHTML(p) {
  const k = AVATAR_KEY[p % AVATAR_KEY.length];
  if (avatarOk[k]) return `<div class="avatar" style="background-image:url(${A}avatar_${k}.webp?v=2);background-size:128%;background-position:50% 28%"></div>`;
  return `<div class="avatar" style="background-image:url(${tierImg(AVATAR_ANIMAL[p % AVATAR_ANIMAL.length])})"></div>`;
}
/** Sichtbarer Tierbestand: Karten, die gerade im Kuhhandel in der Mitte liegen, fehlen im Inventar. */
function shownAnimals(p) {
  const a = [...V.players[p].animals];
  const t = V.trade;
  if (t && (p === t.challenger || p === t.target)) a[t.animal] -= t.k;
  return a;
}
function scoreOf(animals) {
  const full = animals.map((c, a) => (c === 4 ? V.animals[a].value : 0)).filter(Boolean);
  return full.reduce((x, y) => x + y, 0) * full.length;
}
function badgesHTML(p) {
  const au = V.auction;
  if (!au || V.phase !== "auction") return "";
  let s = "";
  if (au.auctioneer === p) s += `<span class="badge auct" title="Versteigerer">${GAVEL}</span>`;
  if (au.high === p) s += `<span class="badge crown" title="Höchstgebot">👑</span>`;
  else if (au.excluded.includes(p)) s += `<span class="badge out" title="Für diese Karte ausgeschlossen">🚫</span>`;
  return s;
}
function bubbleHTML(p) {
  const au = V.auction;
  const last = au ? au.last[String(p)] : undefined;
  const key = last === undefined ? "" : `${au.card}:${last}`;
  const changed = lastBubble[p] !== key;
  lastBubble[p] = key;
  if (last === undefined) return "";
  const pop = changed ? " pop" : "";
  if (last === "pass") return `<div class="bubble pass${pop}">passe</div>`;
  return `<div class="bubble${pop} ${au.high === p ? "high" : "old"}">${last}</div>`;
}

/** Positionen für Gruppen unterschiedlicher Breite; wird bei Platzmangel zusammengeschoben. */
function packPositions(widths, avail, gap) {
  const xs = [];
  let x = 0;
  for (const w of widths) { xs.push(x); x += w + gap; }
  const total = x - gap;
  if (widths.length > 1 && total > avail) {
    const last = xs[xs.length - 1];
    const f = (avail - widths[widths.length - 1]) / last;
    for (let i = 0; i < xs.length; i++) xs[i] *= f;
  }
  return { xs, width: Math.min(total, avail) };
}

const MONEY_FAN = [0, 2, 3, 5, 7, 9]; // grobe Stapelgröße -> gezeigte Rückseiten (nicht exakt)

// Zwei Tisch-Anordnungen: quer (Computer, Tablet) und hochkant (Handy). Alle Maße in Bühnen-Pixeln.
// seats: je Anzahl Gegner [Mitte x, Oberkante y, Breite, Kartenreihen], im Uhrzeigersinn ab dem linken Nachbarn.
const LAYOUT = {
  land: {
    name: "land", w: 1600, h: 900, frame: 70,
    own: { w: 110, h: 165 }, own2: { w: 124, h: 186 }, opp: { w: 84, h: 126 }, oppDX: 10, rowStep: 88,
    wal: { w: 88, h: 132 }, mini: { w: 40, h: 60, dx: 5 }, ts: { w: 64, h: 96, dx: 40 }, offer: { w: 110, h: 165, p2: 84 },
    handW: [480, 500], handDX: 16, handDY: 8, handGap: [14, 22], walW: [460, 470], offerW: 460,
    seatWide: [760, 470], spotMin: [170, 130], popReach: 170, tStep: [30, 26],
    seats: {
      1: [[800, 62, 440, 1]],
      2: [[430, 62, 560, 1], [1170, 62, 560, 1]],
      3: [[215, 120, 250, 2], [800, 62, 340, 1], [1385, 120, 250, 2]],
      4: [[215, 120, 250, 2], [600, 62, 300, 1], [1000, 62, 300, 1], [1385, 120, 250, 2]],
    },
  },
  port: {
    name: "port", w: 480, h: 1040, frame: 16, handLeft: 16,
    own: { w: 72, h: 108 }, own2: { w: 76, h: 114 }, opp: { w: 46, h: 69 }, oppDX: 6, rowStep: 46,
    wal: { w: 56, h: 84 }, mini: { w: 22, h: 33, dx: 3 }, ts: { w: 40, h: 60, dx: 24 }, offer: { w: 64, h: 96, p2: 64 },
    handW: [448, 448], handDX: 11, handDY: 5, handGap: [8, 12], walW: [226, 226], offerW: 440,
    seatWide: [448, 300], spotMin: [100, 76], popReach: 100, tStep: [20, 16],
    seats: {
      1: [[240, 52, 440, 1]],
      2: [[124, 52, 216, 2], [356, 52, 216, 2]],
      3: [[124, 232, 216, 2], [240, 52, 300, 2], [356, 232, 216, 2]],
      4: [[124, 232, 216, 2], [124, 52, 216, 2], [356, 52, 216, 2], [356, 232, 216, 2]],
    },
  },
};
// Handy quer: breite, niedrige Bühne – Gegner oben in einer Reihe, Mitte in der Mitte,
// unten links Geld + Schild, unten Mitte das Bedienfeld, unten rechts die eigenen Tiere.
LAYOUT.phl = {
  name: "phl", w: 1040, h: 480, frame: 14, handLeft: 760,
  own: { w: 72, h: 108 }, own2: { w: 76, h: 114 }, opp: { w: 44, h: 66 }, oppDX: 6, rowStep: 46,
  wal: { w: 56, h: 84 }, mini: { w: 22, h: 33, dx: 3 }, ts: { w: 40, h: 60, dx: 24 }, offer: { w: 64, h: 96, p2: 64 },
  handW: [266, 266], handDX: 11, handDY: 5, handGap: [8, 12], walW: [262, 262], offerW: 254,
  seatWide: [600, 300], spotMin: [100, 76], popReach: 100, tStep: [20, 16],
  seats: {
    1: [[500, 12, 600, 1]],
    2: [[260, 12, 440, 1], [760, 12, 440, 1]],
    3: [[180, 12, 300, 1], [500, 12, 300, 1], [820, 12, 300, 1]],
    4: [[140, 12, 240, 1], [380, 12, 240, 1], [620, 12, 240, 1], [860, 12, 240, 1]],
  },
};
let L = LAYOUT.land;
const isPort = () => L === LAYOUT.port;
const compact = () => L !== LAYOUT.land;   // Handy (hochkant oder quer): größere Bedienelemente

/** Breite einer Tiergruppe: komplette Quartette liegen eng als ein Stapel. */
const groupWidth = (c, w, dx) => (c === 4 ? w + 3 * 3 : w + (c - 1) * dx);
const groupDX = (c, dx) => (c === 4 ? 3 : dx);

// --------------------------------------------------------------- Fokus / Scheinwerfer
let focusP = null;       // Gegner, dessen Auslage gerade aufgefächert ist
let lastTurnP = null;    // wer zuletzt im Kuhhandel am Zug war (für den wandernden Scheinwerfer)
let dimTimer = null;

/** Auslage eines Gegners normal oder breit aufgefächert anordnen (animiert über CSS-Übergänge). */
function applySeatLayout(seat, p, wide) {
  const x = +seat.dataset.x, w = +seat.dataset.w, rows = +seat.dataset.rows;
  const W = wide ? L.seatWide[rows === 1 ? 0 : 1] : w;
  const lay = seatLayout(p, W, rows, wide ? 16 : 8);
  // im Tisch bleiben
  const cx = Math.min(Math.max(x, L.frame + W / 2), L.w - L.frame - W / 2);
  seat.style.left = `${cx}px`;
  seat.style.width = `${W}px`;
  const box = seat.querySelector(".opp-animals");
  if (box) { box.style.width = `${lay.boxW}px`; box.style.height = `${lay.h}px`; }
  seat.querySelectorAll(".ogroup").forEach((g) => {
    const q = lay.pos[+g.dataset.a];
    if (q) { g.style.left = `${q.left}px`; g.style.top = `${q.top}px`; }
  });
}

/** Tisch abdunkeln, nur ein Bereich bleibt im Licht. */
function dimAt(rect, { instant = false, second = null } = {}) {
  const st = $("#stage").getBoundingClientRect();
  const s = st.width / L.w;
  const d = $("#dim");
  const geo = (r) => ({
    cx: (r.left + r.width / 2 - st.left) / s, cy: (r.top + r.height / 2 - st.top) / s,
    rx: Math.max(L.spotMin[0], r.width / s / 2 + L.spotMin[0] / 2), ry: Math.max(L.spotMin[1], r.height / s / 2 + L.spotMin[1] / 2),
  });
  const a = geo(rect), b = second ? geo(second) : a;   // ohne zweiten Kegel liegen beide übereinander
  if (instant) d.style.transition = "opacity .3s";
  d.style.setProperty("--sx", `${a.cx}px`);
  d.style.setProperty("--sy", `${a.cy}px`);
  d.style.setProperty("--rx", `${a.rx}px`);
  d.style.setProperty("--ry", `${a.ry}px`);
  d.style.setProperty("--s2x", `${b.cx}px`);
  d.style.setProperty("--s2y", `${b.cy}px`);
  d.style.setProperty("--r2x", `${b.rx}px`);
  d.style.setProperty("--r2y", `${b.ry}px`);
  if (instant) { void d.offsetWidth; d.style.transition = ""; }
  d.classList.add("on");
}
const undim = () => $("#dim").classList.remove("on");

function focusSeat(p) {
  const seat = document.querySelector(`.seat[data-p="${p}"]`);
  if (!seat) return;
  clearTimeout(dimTimer);
  if (focusP !== null && focusP !== p) unfocusSeat(true);
  focusP = p;
  seat.classList.add("focus");
  $("#stage").classList.add("focusing");
  applySeatLayout(seat, p, true);
  setTimeout(() => { if (focusP === p) dimAt(seat.getBoundingClientRect(), { instant: !$("#dim").classList.contains("on") }); }, 60);
}
function unfocusSeat(keepDim) {
  if (focusP === null) return;
  const seat = document.querySelector(`.seat[data-p="${focusP}"]`);
  focusP = null;
  if (seat) { seat.classList.remove("focus"); applySeatLayout(seat, +seat.dataset.p, false); }
  $("#stage").classList.remove("focusing");
  if (!keepDim) undim();
}

/** Versteigerung: kurz abdunkeln, während die neue Karte aufgedeckt wird (nicht im Tempo „Schnell“). */
let lastAuctioneer = null;
let spotReadyAt = 0;       // warmes Licht hinter dem Versteigerer erst nach dem Scheinwerfer
const SPOT_MOVE = 120 + 650, SPOT_HOLD = 2000, DIM_FADE = 350;
function spotlightCard(flip) {
  const au = V.auction;
  const now = au ? au.auctioneer : null;
  const prevA = lastAuctioneer;
  lastAuctioneer = now;
  const turnOver = () => { flip.classList.remove("wait"); flip.classList.add("in"); Snd.play("flip"); };
  if (FAST || speed === 2 || focusP !== null || now === null) { turnOver(); return; }
  // Ablauf: Kegel wandert zum neuen Versteigerer -> Karte dreht sich -> Scheinwerfer blendet aus -> warmes Licht erscheint
  const moves = prevA !== null && prevA !== now;
  const flipAt = moves ? SPOT_MOVE + 60 : 250;
  setTimeout(turnOver, flipAt);
  actionHoldUntil = Date.now() + flipAt + 700;
  spotReadyAt = Date.now() + SPOT_HOLD + DIM_FADE;
  document.querySelectorAll(".seat.spot, #me-plate.spot").forEach((e) => e.classList.remove("spot"));  // altes Licht aus
  setTimeout(render, flipAt + 720);
  setTimeout(render, SPOT_HOLD + DIM_FADE + 20);
  const elOf = (p) => (p === V.me ? $("#me-plate") : document.querySelector(`.seat[data-p="${p}"]`));
  const card = () => $("#pile-area").getBoundingClientRect();
  clearTimeout(dimTimer);
  setTimeout(() => {
    const from = prevA !== null && prevA !== now ? elOf(prevA) : null;
    const to = elOf(now);
    if (!to) return;
    $("#dim").classList.add("soft");
    // erst beim vorherigen Versteigerer, dann wandert der Kegel zum neuen; die Karte ist durchgehend im Licht
    dimAt((from || to).getBoundingClientRect(), { instant: true, second: card() });
    if (from) setTimeout(() => dimAt(to.getBoundingClientRect(), { second: card() }), 120);
    dimTimer = setTimeout(() => { undim(); setTimeout(() => $("#dim").classList.remove("soft"), 400); }, SPOT_HOLD);
  }, 20);
}

/** Im Kuhhandel: Tisch kurz abdunkeln und den Scheinwerfer zum nächsten Spieler wandern lassen. */
function spotlightTurn(from, to) {
  if (FAST || focusP !== null) return;
  const elOf = (p) => (p === V.me ? $("#me-plate") : document.querySelector(`.seat[data-p="${p}"]`));
  const a = from !== null ? elOf(from) : null, b = elOf(to);
  if (!b) return;
  clearTimeout(dimTimer);
  if (a) dimAt(a.getBoundingClientRect(), { instant: true });
  setTimeout(() => dimAt(b.getBoundingClientRect()), a ? 120 : 0);
  dimTimer = setTimeout(() => { if (focusP === null) undim(); }, 1500);
}

// --------------------------------------------------------------- Render
function render() {
  if (!V || V.phase === "none") return;
  renderSeats();
  renderCenter();
  renderMePlate();
  renderWallet();
  renderOfferPile();
  renderHand();
  renderActions();
  placePlate();
  if (Date.now() < panelErrUntil) $("#actions").insertAdjacentHTML("afterbegin", `<div class="perr">⚠️ ${panelErr}</div>`);
  renderTopButtons();
  if (V.phase === "over") showResults();
}

/** Positionen der Tiergruppen eines Gegners bei gegebener Breite/Reihenzahl. */
function seatLayout(p, width, rows, gap = 8) {
  const groups = [];
  shownAnimals(p).forEach((c, a) => { if (c) groups.push([a, c]); });
  const DX = L.oppDX;
  const perRow = Math.max(1, Math.ceil(groups.length / rows));
  const usedRows = Math.max(1, Math.ceil(groups.length / perRow));
  const pos = {};
  let boxW = 0;
  for (let r = 0; r < usedRows; r++) {
    const rowGroups = groups.slice(r * perRow, (r + 1) * perRow);
    const widths = rowGroups.map(([, c]) => groupWidth(c, L.opp.w, DX));
    const { xs, width: rw } = packPositions(widths, width, gap);
    boxW = Math.max(boxW, rw);
    rowGroups.forEach(([a], gi) => { pos[a] = { left: xs[gi], top: r * L.rowStep, width: widths[gi], z: r * 20 + gi + 1 }; });
  }
  return { groups, pos, boxW, h: L.opp.h + (usedRows - 1) * L.rowStep + 8 };
}

function seatHTML(p, width, rows) {
  const P = V.players[p];
  const revealed = P.revealed !== undefined ? ` · <span title="nach Zahlungsunfähigkeit offengelegt">💰${P.revealed}</span>` : "";
  // Geld: kleiner Fächer aus Rückseiten, Anzahl nur grob
  const k = MONEY_FAN[P.stack], M = L.mini;
  let money = "";
  for (let i = 0; i < k; i++) {
    money += `<div class="card mback" style="width:${M.w}px;height:${M.h}px;left:${i * M.dx}px;bottom:0;transform:rotate(${(i - (k - 1) / 2) * 4}deg)"></div>`;
  }
  const moneyBox = `<div class="mini-money" style="width:${k ? M.w + M.dx * (k - 1) : M.w}px" title="Geld (nur grob sichtbar)">${money || '<span class="broke">pleite</span>'}</div>`;
  // Tiere: pro Art ein Stapel, bei seitlichen Gegnern auf zwei Reihen verteilt
  const pickable = new Set((V.options || []).filter((o) => o.target === p).map((o) => o.animal));
  const { groups, pos, boxW, h } = seatLayout(p, width, rows);
  const DX = L.oppDX;
  let animals = "";
  groups.forEach(([a, c]) => {
    const dx = groupDX(c, DX);
    const q = pos[a];
    let cards = "";
    for (let i = 0; i < c; i++) cards += `<div class="card opp" style="left:${i * dx}px;bottom:${c === 4 ? i : i * 3}px;background-image:url(${tierImg(animalKey(a))})"></div>`;
    const pick = pickable.has(a);
    animals += `<div class="ogroup${c === 4 ? " full" : ""}${pick ? " pick" : ""}" data-a="${a}"
      style="left:${q.left}px;top:${q.top}px;width:${q.width}px;z-index:${q.z}"
      title="${V.animals[a].name} · ${V.animals[a].value} · ${c === 4 ? "Quartett komplett" : `${c}/4`}${pick ? " – klicken zum Herausfordern" : ""}">${cards}<span class="cnt">${c === 4 ? "✓" : c}</span></div>`;
  });
  const animalsBox = groups.length
    ? `<div class="opp-animals" style="width:${boxW}px;height:${h}px">${animals}</div>`
    : `<div class="no-animals">noch keine Tiere</div>`;
  return `
    <div class="seat-head">
      ${moneyBox}
      <div class="avatar-wrap">${avatarHTML(p)}${badgesHTML(p)}</div>
      <div class="nameplate"><b>${P.name}${V.auction && V.phase === "auction" && V.auction.auctioneer === p ? `<span class="role">${GAVEL} versteigert</span>` : ""}</b><span class="sub"><span class="pts">${scoreOf(P.animals)}</span> Pkt · ${P.quartets} Quartett${P.quartets === 1 ? "" : "e"}${revealed}</span></div>
      ${bubbleHTML(p)}
    </div>
    <div class="seat-cards">${animalsBox}</div>`;
}

function renderSeats() {
  const box = $("#seats");
  const pos = L.seats[V.n - 1];
  const want = [];
  for (let i = 1; i < V.n; i++) want.push((V.me + i) % V.n);
  if (box.dataset.players !== want.join(",")) {
    box.innerHTML = "";
    box.dataset.players = want.join(",");
    want.forEach((p) => {
      const s = el("div", "seat");
      s.dataset.p = p;
      box.appendChild(s);
    });
  }
  want.forEach((p, i) => {
    const seat = box.querySelector(`.seat[data-p="${p}"]`);
    const [x, y, w, rows] = pos[i];
    seat.dataset.x = x; seat.dataset.w = w; seat.dataset.rows = rows;
    if (focusP !== p) {
      seat.style.left = `${x}px`;
      seat.style.width = `${w}px`;
    }
    seat.style.top = `${y}px`;
    seat.classList.toggle("active", V.to_act === p);
    seat.classList.toggle("spot", !!(V.auction && V.phase === "auction" && V.auction.auctioneer === p) && Date.now() >= spotReadyAt);
    seat.classList.toggle("rside", x > L.w * 0.7);
    const html = seatHTML(p, w, rows);
    if (seat.dataset.html !== html) {
      seat.dataset.html = html;
      seat.innerHTML = html;
      seat.querySelectorAll(".ogroup.pick").forEach((g) => (g.onclick = () => act({ kind: "challenge", target: p, animal: +g.dataset.a })));
      if (focusP === p) applySeatLayout(seat, p, true);
    }
  });
}

function renderCenter() {
  const area = $("#pile-area");
  const deck = $("#deck");
  const au = V.auction;
  const t = V.trade;
  // Stapel aus leicht versetzten Karten
  const layers = Math.min(8, Math.ceil(V.deck_left / 5));
  if (deck.dataset.n !== String(layers)) {
    deck.dataset.n = layers;
    deck.innerHTML = Array.from({ length: layers }, (_, i) => {
      const r = [-1.5, 1, -0.5, 1.8, -1.2, 0.6, -2, 1.4][i];
      return `<div class="card mid back" style="left:${i * 1.3}px;top:${-i * 1.7}px;transform:rotate(${r}deg)"></div>`;
    }).join("");
  }
  $("#deck-count").textContent = V.deck_left ? `${V.deck_left} Karten · Esel ${V.donkeys}/4` : "";
  $("#deck-count").style.display = V.deck_left ? "" : "none";

  let shown = null;
  let key = "none";
  const holding = Date.now() < revealHoldUntil;
  if (V.phase === "auction" && au && !holding) { shown = au.card; key = `a${au.card}-${V.deck_left}`; }
  else if (t) { shown = t.animal; key = `t${t.animal}-${t.challenger}-${t.target}`; }
  area.classList.toggle("hidden", shown === null && !V.deck_left);
  const rev = $("#revealed");
  if (rev.dataset.key !== key) {
    rev.dataset.key = key;
    if (shown === null) rev.innerHTML = "";
    else if (t && V.phase === "trade") rev.innerHTML = tradeCardsHTML(t);
    else {
      rev.innerHTML = `<div class="flip wait"><div class="face b"></div><div class="face f" style="background-image:url(${tierImg(animalKey(shown))})"></div></div>`;
      spotlightCard(rev.querySelector(".flip"));
    }
  }
  // verdeckter Geldstapel des Herausforderers liegt neben der Karte auf dem Tisch
  const ts = $("#tstack");
  const cnt = t && t.offer_count !== undefined ? t.offer_count : null;
  const tkey = cnt === null ? "" : `${cnt}-${t.my_offer ?? ""}`;
  if (ts.dataset.key !== tkey) {
    ts.dataset.key = tkey;
    ts.innerHTML = cnt === null ? "" : Array.from({ length: Math.max(cnt, 0) }, (_, i) =>
      `<div class="card mback" style="left:${i * 6}px;top:${-i * 2}px;transform:rotate(${((i * 37) % 11) - 5}deg)"></div>`).join("")
      + `<span class="cnt">×${cnt}</span>`
      + `<span class="lab">${cnt ? `${cnt} verdeckte Karte${cnt === 1 ? "" : "n"}` : "leerer Stapel"}${t.my_offer !== undefined ? ` · Wert ${t.my_offer}` : ""}</span>`;
    ts.title = cnt === null ? "" : `${cnt} verdeckte Geldkarte${cnt === 1 ? "" : "n"}`;
  }
  const flip = rev.querySelector(".flip");
  if (flip) flip.classList.toggle("glow", !!(au && au.high !== null));

  const plaque = $("#plaque");
  if (V.phase === "auction" && au && holding) {
    plaque.innerHTML = `<div class="lbl">Versteigerer</div><div class="who"><span class="pill auct">${GAVEL} ${nameOf(au.auctioneer)}</span></div>
      <hr><div class="who">Nächste Karte…</div>`;
  } else if (V.phase === "auction" && au) {
    const amount = au.high === null ? null : au.amount;
    const bump = amount !== null && amount !== lastAmount;
    lastAmount = amount;
    const hist = bidHistory.slice(-3).map((b) => `<b>${nameOf(b.p)}</b> ${b.amount}`).join(" → ");
    plaque.innerHTML = `
      <div class="lbl">Versteigerer</div>
      <div class="who"><span class="pill auct">${GAVEL} ${nameOf(au.auctioneer)}</span></div>
      <hr>
      <div class="lbl">Höchstgebot</div>
      <div class="amt${bump ? " bump" : ""}">${amount === null ? "–" : amount}</div>
      <div class="who">${au.high === null ? "noch kein Gebot" : `<span class="pill high">👑 ${nameOf(au.high)}</span>`}</div>
      ${hist ? `<div class="history">${hist}</div>` : ""}
      ${au.excluded.length ? `<hr><div class="lbl">Ausgeschlossen</div><div>${au.excluded.map((p) => `<span class="pill out">${nameOf(p)}</span>`).join(" ")}</div>` : ""}
      ${au.stage === "choice" ? `<hr><div class="who">${au.auctioneer === V.me ? "Deine Entscheidung!" : `${nameOf(au.auctioneer)} entscheidet…`}</div>` : ""}`;
  } else if (V.phase === "trade" && t) {
    const cnt = t.offer_count;
    plaque.innerHTML = `
      <div class="lbl">Kuhhandel</div>
      <div class="who" style="font-size:18px;margin:4px 0">${nameOf(t.challenger)} <span style="opacity:.6">⚔</span> ${nameOf(t.target)}</div>
      <div>${t.k}× ${V.animals[t.animal].name} gegen ${t.k}× ${V.animals[t.animal].name}</div>
      ${!t.involved ? `<hr><div class="who" style="font-size:14px">${t.stage === "offer" ? `${nameOf(t.challenger)} legt ein verdecktes Gebot…` : `${nameOf(t.target)} überlegt…`}</div>` : ""}
      ${cnt !== undefined ? `<hr><div class="lbl">Verdecktes Gebot</div>
        <div>${cnt} Karte${cnt === 1 ? " liegt" : "n liegen"} auf dem Tisch${t.my_offer !== undefined ? ` · Wert <b>${t.my_offer}</b>` : ""}</div>` : ""}`;
  } else if (V.phase === "trade") {
    const cur = V.to_act;
    plaque.innerHTML = `
      <div class="lbl">Phase 2</div>
      <div class="amt" style="font-size:36px">Kuhhandel</div>
      <div class="who" style="margin-top:6px">${cur === null ? "" : cur === V.me ? "Du bist am Zug" : `${nameOf(cur)} ist am Zug`}</div>`;
  } else {
    plaque.innerHTML = `<div class="amt" style="font-size:36px">Spielende</div>`;
  }
}

/** Kuhhandel in der Mitte: links die Karten des Herausforderers, rechts die des Gegners. */
function tradeCardsHTML(t) {
  const img = tierImg(animalKey(t.animal));
  const n = 2 * t.k;
  let cards = "";
  for (let i = 0; i < n; i++) {
    const side = i < t.k ? 0 : 1;
    const x = i * L.tStep[0] + side * L.tStep[1];
    const r = (i - (n - 1) / 2) * 5;
    cards += `<div class="card mid tcard" style="left:${x}px;top:${Math.abs(r) * 0.8}px;transform:rotate(${r}deg);background-image:url(${img})"></div>`;
  }
  const w = (n - 1) * L.tStep[0] + L.tStep[1];
  return `<div class="tcards">${cards}
    <span class="tname l">${nameOf(t.challenger)}</span>
    <span class="tname r" style="left:${w}px">${nameOf(t.target)}</span></div>`;
}

function renderTopButtons() {
  $("#m-skip").style.display = V.phase === "auction" ? "" : "none";
  $("#stage").classList.toggle("p2", V.phase !== "auction");
  $("#stage").classList.toggle("o34", V.n >= 4);   // hochkant: zwei Reihen Gegner
}

function renderMePlate() {
  const P = V.players[V.me];
  const plate = $("#me-plate");
  plate.className = (V.to_act === V.me ? "active" : "") + (V.auction && V.phase === "auction" && V.auction.auctioneer === V.me && Date.now() >= spotReadyAt ? " spot" : "");
  plate.innerHTML = `
    <div class="avatar-wrap">${avatarHTML(V.me)}${badgesHTML(V.me)}</div>
    <div class="nameplate">
      <b>${P.name}${V.auction && V.phase === "auction" && V.auction.auctioneer === V.me ? `<span class="role">${GAVEL} du versteigerst</span>` : ""}</b>
      <div class="chips">
        <span class="chip">💰 <b>${P.cash}</b></span>
        <span class="chip">⭐ <b>${scoreOf(P.animals)}</b> Pkt</span>
        ${V.phase === "auction" && V.auction && V.auction.auctioneer !== V.me ? `<span class="chip" title="Maximales Gebot = Bargeld × 2 + 100">Limit <b>${V.cap}</b></span>` : ""}
      </div>
    </div>
    ${bubbleHTML(V.me)}`;
}

function renderWallet() {
  const w = $("#wallet");
  w.innerHTML = "";
  const notes = V.players[V.me].notes;
  const idx = V.denoms.map((_, i) => i).filter((i) => notes[i] > 0);
  const { xs } = packPositions(idx.map(() => L.wal.w), L.walW[V.phase === "trade" ? 1 : 0], compact() ? 6 : 10);
  if (!selectMode) selected = notes.map(() => 0);   // Auswahl gilt nur im Kuhhandel-Gebot
  idx.forEach((i, k) => {
    selected[i] = Math.min(selected[i], notes[i]);
    const avail = Math.max(0, notes[i] - selected[i]);
    const d = V.denoms[i];
    const s = el("div", "mstack" + (avail ? "" : " empty") + (selectMode && avail ? " selectable" : ""));
    s.style.left = `${xs[k]}px`;
    s.style.zIndex = k + 1;
    const layers = Math.min(Math.max(avail, 1), 4);
    for (let j = 0; j < layers; j++) {
      s.appendChild(Object.assign(el("div", "card wal"), {
        style: `left:${j * 2}px;bottom:${j * 3}px;background-image:url(${geldImg(d)})`,
      }));
    }
    s.appendChild(el("span", "cnt", `×${avail}`));
    if (selectMode && avail) s.appendChild(el("span", "plus", "+1"));
    s.title = selectMode && avail ? `Eine ${d}er-Karte ins Gebot legen (${avail} übrig)` : `${avail}× ${d}`;
    if (selectMode && avail) s.onclick = () => { selected[i]++; render(); };
    w.appendChild(s);
  });
}

function renderOfferPile() {
  const box = $("#offer-pile");
  box.classList.toggle("show", !!selectMode);
  $("#stage").classList.toggle("selecting", !!selectMode);   // hochkant: Gebot liegt dort, wo sonst die Tierkarten sind
  if (!selectMode) { box.innerHTML = ""; return; }
  const list = [];
  selected.forEach((c, i) => { for (let k = 0; k < c; k++) list.push(i); });
  const sum = list.reduce((s, i) => s + V.denoms[i], 0);
  box.innerHTML = `<span class="title">${selectMode === "offer" ? "Dein Gebot" : "Dein Gegengebot"}: ${list.length} Karte${list.length === 1 ? "" : "n"} · Wert <b>${sum}</b> <span class="tip" style="opacity:.75">(Karte ${TOUCH ? "antippen" : "anklicken"} = zurücklegen)</span></span>`;
  if (!list.length) {
    box.innerHTML += `<div class="empty-hint">⬇ ${TOUCH ? "Tippe" : "Klicke"} unten auf deine Geldstapel, um Karten hierher zu legen.</div>`;
    return;
  }
  const cw = V.phase === "trade" ? L.offer.p2 : L.offer.w;
  const step = list.length > 1 ? Math.min(cw * 0.55, (L.offerW - cw) / (list.length - 1)) : 0;
  list.forEach((i, k) => {
    const c = el("div", "card own");
    c.style.cssText = `left:${k * step}px;top:${compact() ? 22 : 24}px;background-image:url(${geldImg(V.denoms[i])});transform:rotate(${(k - (list.length - 1) / 2) * 2}deg);z-index:${k + 1}`;
    c.title = "Zurücklegen";
    c.onclick = () => { selected[i]--; render(); };
    box.appendChild(c);
  });
}

function renderHand() {
  const hand = $("#hand");
  hand.innerHTML = "";
  const P = V.players[V.me];
  const p2 = V.phase === "trade";
  const CW = p2 ? L.own2.w : L.own.w, CH = p2 ? L.own2.h : L.own.h;
  const DX = L.handDX, DY = L.handDY, W = L.handW[p2 ? 1 : 0];
  const groups = [];
  shownAnimals(V.me).forEach((c, a) => { if (c) groups.push([a, c]); });
  hand.style.width = `${W}px`;
  if (!groups.length) { hand.innerHTML = `<div class="hand-empty">Noch keine Tierkarten</div>`; return; }
  const options = V.options || [];
  const pickAnimals = new Set(options.map((o) => o.animal));
  const target = V.trade && V.trade.target === V.me ? V.trade.animal : null;
  const widths = groups.map(([, c]) => groupWidth(c, CW, DX));
  const { xs, width } = packPositions(widths, W, L.handGap[p2 ? 1 : 0]);
  const x0 = compact() ? (W - width) / 2 : W - width; // Computer: rechtsbündig, Handy: mittig
  const handLeft = L.handLeft ?? L.w - 70 - W;
  groups.forEach(([a, c], gi) => {
    const full = c === 4;
    const g = el("div", "hgroup" + (full ? " full" : "") + (pickAnimals.has(a) ? " pick" : "") + (target === a ? " target" : "") + (p2 && openGroup === a ? " open" : ""));
    const left = x0 + xs[gi];
    const dx = groupDX(c, DX);
    g.dataset.a = a;
    g.style.left = `${left}px`;
    g.style.width = `${widths[gi]}px`;
    g.style.height = `${CH}px`;
    g.style.zIndex = gi + 1;
    for (let i = 0; i < c; i++) {
      const card = el("div", "card");
      card.style.cssText = `width:${CW}px;height:${CH}px;left:${i * dx}px;bottom:${full ? i : i * DY}px;z-index:${i + 2};background-image:url(${tierImg(animalKey(a))})`;
      g.appendChild(card);
    }
    g.appendChild(el("span", "cnt", full ? "✓ Quartett" : `${c}/4`));
    g.appendChild(el("span", "name", `${V.animals[a].name} · ${V.animals[a].value}`));
    if (p2) {
      // Am Tischrand fächern die Gegner-Karten zur Mitte hin auf (erste gerade nach oben)
      const cx = handLeft + left + widths[gi] / 2;   // Mitte der Gruppe in Bühnenkoordinaten
      const fan = cx + L.popReach > L.w - L.frame ? "left" : cx - L.popReach < L.frame ? "right" : "center";
      g.appendChild(popsFor(a, c, options, fan));
      // Handy: Antippen klappt die Gegner hinter der Karte auf (statt Überfahren mit der Maus)
      if (TOUCH) g.onclick = (e) => {
        if (e.target.closest(".pop")) return;
        e.stopPropagation();
        openGroup = openGroup === a ? null : a;
        document.querySelectorAll("#hand .hgroup.open").forEach((x) => x.classList.remove("open"));
        if (openGroup === a) g.classList.add("open");
        else unfocusSeat();
      };
    } else if (!full && c > 1 && !TOUCH) {
      // Phase 1: beim Hovern auffächern, ohne über den Tischrand zu ragen
      g.onmouseenter = () => {
        const sp = CW * 0.62;
        let shift = -((c - 1) * sp) / 2;
        shift = Math.min(shift, W - left - ((c - 1) * sp + CW));
        shift = Math.max(shift, -left);
        g.querySelectorAll(".card").forEach((k, i) => { k.style.transform = `translate(${shift + i * sp - i * DX}px, ${i * DY}px) rotate(${(i - (c - 1) / 2) * 4}deg)`; });
      };
      g.onmouseleave = () => g.querySelectorAll(".card").forEach((k) => { k.style.transform = ""; });
    }
    hand.appendChild(g);
  });
}

/** Kuhhandel: Hinter der Karte kommen die Gegner hervor, die dieses Tier auch haben. */
function popsFor(a, c, options, fan = "center") {
  const box = el("div", "pops");
  const holders = [];
  for (let i = 1; i < V.n; i++) {
    const q = (V.me + i) % V.n;
    const n = V.players[q].animals[a];
    if (n > 0) holders.push([q, n]);
  }
  const canChallenge = (q) => options.some((o) => o.target === q && o.animal === a);
  let items = holders;
  if (c === 4) items = [[null, "Quartett komplett"]];
  else if (!holders.length) items = [[null, "Niemand sonst"]];
  const spread = items.length > 1 ? Math.min(26, 60 / (items.length - 1)) : 0;
  items.forEach(([q, n], i) => {
    const ang = items.length < 2 ? 0
      : fan === "left" ? -i * spread
      : fan === "right" ? i * spread
      : -((items.length - 1) * spread) / 2 + i * spread;
    const active = q !== null && canChallenge(q);
    const pop = el("div", "pop" + (active ? " active" : "") + (q === null ? " info" : ""));
    pop.style.setProperty("--ang", `${ang}deg`);
    pop.style.setProperty("--d", `${i * 50}ms`);
    if (q === null) {
      pop.innerHTML = `<div class="pn">${n}</div>`;
    } else {
      const full = n === 4;
      pop.innerHTML = `${avatarHTML(q)}<div class="pn">${V.players[q].name}</div>
        <div class="pc"><b>${n}</b>× ${full ? "(komplett)" : ""}</div>
        ${active ? `<div class="pa">⚔ Herausfordern</div>` : ""}`;
      pop.title = active ? `${V.players[q].name} um ${V.animals[a].name} herausfordern` : `${V.players[q].name} hat ${n}× ${V.animals[a].name}`;
      if (active) pop.onclick = (e) => { e.stopPropagation(); openGroup = null; unfocusSeat(); act({ kind: "challenge", target: q, animal: a }); };
      if (!TOUCH) {
        pop.onmouseenter = () => focusSeat(q);
        pop.onmouseleave = () => unfocusSeat();
      }
    }
    box.appendChild(pop);
  });
  return box;
}

function quickPick(kind) {
  const notes = V.players[V.me].notes;
  if (kind === "all") selected = [...notes];
  else if (kind === "none") selected = notes.map(() => 0);
  else if (kind === "zeros") selected[0] = notes[0];
  else if (kind === "half") {
    // ungefähr die Hälfte des Bargelds, große Scheine zuerst
    const target = Math.floor(V.players[V.me].cash / 2);
    const pick = notes.map(() => 0);
    let sum = 0;
    for (let i = notes.length - 1; i >= 1; i--) {
      while (pick[i] < notes[i] && sum + V.denoms[i] <= target) { pick[i]++; sum += V.denoms[i]; }
    }
    pick[0] = selected[0];
    selected = pick;
  }
  render();
}
const QUICK_HTML = `<div class="btns quick">
  <button class="btn small" data-qp="all">All-in</button>
  <button class="btn small" data-qp="half">Hälfte</button>
  <button class="btn small" data-qp="zeros">+ alle 0er</button>
  <button class="btn small" data-qp="none">Leeren</button></div>`;
const bindQuick = () => document.querySelectorAll("[data-qp]").forEach((b) => (b.onclick = () => quickPick(b.dataset.qp)));
const cardsLabel = (n) => `${n} Karte${n === 1 ? "" : "n"}`;
// Im Kuhhandel liegt immer mindestens eine Karte (zur Not ein 0er) – wie am echten Tisch
const mustPick = () => notesCount(selected) === 0 && notesCount(V.players[V.me].notes) > 0;
function zeroGo(label = "Verdeckt hinlegen") {
  const hint = mustPick() ? `<div class="hint warn">Lege mindestens eine Karte – zur Not einen 0er.</div>` : "";
  return `<div class="btns" style="margin-top:8px"><button class="btn primary" id="go" ${mustPick() ? "disabled" : ""}>${label}</button>`
    + `${label === "Verdeckt hinlegen" ? "" : `<button class="btn small" id="back">Zurück</button>`}</div>${hint}`;
}
function zeroSubmit(kind) {
  if (mustPick()) return;
  act({ kind, notes: selected });
}
const notesSum = (c) => c.reduce((s, x, i) => s + x * V.denoms[i], 0);
const notesCount = (c) => c.reduce((s, x) => s + x, 0);

// Spielerschild sitzt immer direkt auf dem Aktionsfeld – auch wenn es beim Tippen wächst.
// Hochkant stapelt sich alles von unten: Aktionsfeld, darüber Geld + Schild, darüber die Tierkarten.
let openGroup = null;   // Handy: aufgeklappte eigene Tiergruppe im Kuhhandel
function placePlate() {
  const a = $("#actions").offsetHeight;
  const set = (sel, v) => { $(sel).style.bottom = v === "" ? "" : `${v}px`; };
  if (!isPort()) {
    // Handy quer: feste Plätze aus dem CSS
    set("#me-plate", compact() ? "" : 58 + a - 8);
    ["#wallet", "#hand", "#offer-pile"].forEach((s) => set(s, ""));
    return;
  }
  const row = 10 + Math.max(a, 150) + 8;       // Geld und Schild
  const hand = row + L.wal.h + 18;              // Tierkarten
  set("#me-plate", row);
  set("#wallet", row);
  set("#hand", hand);
  set("#offer-pile", hand);
}
new ResizeObserver(placePlate).observe($("#actions"));

let keyHandler = null;
document.addEventListener("keydown", (e) => {
  const menuOpen = $("#menu").classList.contains("open") || $("#log").classList.contains("open");
  if (keyHandler && !menuOpen && !$("#overlay").classList.contains("show")) keyHandler(e);
});
let panelErr = null, panelErrUntil = 0;

function renderActions() {
  keyHandler = null;
  const box = $("#actions");
  const P = V.players[V.me];
  const mine = V.to_act === V.me && V.phase !== "over";
  box.classList.toggle("mine", mine);
  if (V.phase === "over") {
    box.innerHTML = `<div class="waiting">Spiel beendet</div>`;
    return;
  }
  if (mine && V.phase === "trade" && !V.trade && Date.now() < actionHoldUntil) {
    box.classList.remove("mine");
    box.innerHTML = `<div class="waiting">Gleich bist du dran<span class="dots"></span></div>`;
    return;
  }
  if (mine && V.phase === "auction" && Date.now() < Math.max(revealHoldUntil, actionHoldUntil)) {
    box.classList.remove("mine");
    box.innerHTML = `<div class="waiting">Nächste Karte wird aufgedeckt<span class="dots"></span></div>`;
    return;
  }
  if (!mine) {
    selectMode = null;
    let txt = V.to_act === null ? "" : `${nameOf(V.to_act)} ist am Zug`;
    if (V.phase === "trade" && V.trade && !V.trade.involved) txt = `${nameOf(V.trade.challenger)} und ${nameOf(V.trade.target)} handeln`;
    if (V.phase === "auction" && V.auction && V.auction.auctioneer === V.me && V.auction.stage === "bidding") txt = `Du versteigerst – ${txt}`;
    if (V.phase === "auction" && V.auction && V.auction.excluded.includes(V.me)) txt = `Du bist von dieser Versteigerung ausgeschlossen – ${txt}`;
    box.innerHTML = `<div class="waiting">${txt}<span class="dots"></span></div>`;
    // Nur noch komplette Quartette -> man kann nichts mehr tun: Rest auf Wunsch schnell durchspielen
    const done = V.phase === "trade" && V.players[V.me].animals.every((c) => c === 0 || c === 4);
    if (done && speed !== 2) {
      box.insertAdjacentHTML("beforeend", `<div class="hint">Du hast nur noch komplette Quartette – der Rest läuft ohne dich.</div>
        <div class="btns" style="margin-top:8px"><button class="btn primary" id="gofast">⚡ Rest schnell durchspielen</button></div>`);
      $("#gofast").onclick = () => setSpeed(2);
    }
    return;
  }
  const au = V.auction;
  if (V.phase === "auction" && au.stage === "bidding" && autoPassKey === animalKeyNow()) {
    box.classList.remove("mine");
    box.innerHTML = `<h4>Du passt bei ${V.animals[au.card].name} automatisch</h4>
      <div class="btns"><button class="btn small" id="unpass">Doch mitbieten</button></div>`;
    $("#unpass").onclick = () => { autoPassKey = ""; clearTimeout(autoPassTimer); passCount = { key: "", n: 0 }; render(); };
    clearTimeout(autoPassTimer);
    autoPassTimer = setTimeout(() => {
      if (autoPassKey === animalKeyNow() && V.to_act === V.me && V.auction && V.auction.stage === "bidding") act({ kind: "pass" });
    }, 700);
    return;
  }
  if (V.phase === "auction" && au.stage === "bidding") {
    const min = au.min_bid;
    const key = `${au.card}-${V.deck_left}-${au.excluded.length}-${min}`;
    const fresh = key !== bidKey;
    // Ohne Wechselgeld: was müsste ich für x wirklich zahlen? (null = Bluff, mehr als Bargeld)
    const payFor = (x) => (x > P.cash ? null : KH.notesValue(KH.composePayment(P.notes, x) || P.notes));
    // automatisch gesetzte Werte springen auf den nächsten passend zahlbaren Betrag
    const autoSet = (x) => {
      x = Math.max(min, Math.min(V.cap, x));
      const pay = payFor(x);
      bidValue = pay !== null && pay > x ? pay : x;
      bidSnap = bidValue !== x ? { from: x, to: bidValue } : null;
    };
    if (fresh) { bidKey = key; autoSet(min); }
    const context = au.high === null ? "Noch kein Gebot"
      : `Höchstgebot <b class="num">${au.amount}</b> · 👑 ${nameOf(au.high)}`;
    const redo = au.excluded.length ? `<div class="ctx redo">🔁 Wiederholung – ${au.excluded.map(nameOf).join(", ")} ausgeschlossen</div>` : "";
    // Schnellwahl: Mindestgebot, 50 mehr, gesamtes Bargeld (ohne Bluff)
    const allIn = Math.floor(P.cash / 10) * 10;
    const quick = [["Min", min], ["Max", allIn]];
    box.innerHTML = `
      <h4>Dein Gebot für ${V.animals[au.card].name} <span class="ctx">· ${context}</span></h4>${redo}
      <div class="btns bidrow">
        <button class="btn small" id="bm">−10</button>
        <input class="bid-input" id="bv" type="text" inputmode="numeric" value="${bidValue}" autocomplete="off">
        <button class="btn small" id="bp">+10</button>
        <button class="btn primary" id="bgo" title="Enter">Bieten</button>
        <button class="btn danger" id="bpass" title="Esc">Passen</button>
      </div>
      <div class="btns quick">${quick.map(([l, q]) => `<button class="btn small" data-q="${q}" ${q > V.cap || q < min ? "disabled" : ""}
        title="${l === "Max" ? "Dein gesamtes Bargeld bieten" : ""}">${l} <b class="num">${q}</b></button>`).join("")}
        <button class="btn small" id="b50" title="50 mehr als oben eingestellt">+50</button>
        <button class="btn small out" id="bout" title="Passen und bei diesem Tier nicht mehr mitbieten">Aussteigen</button></div>
      <div class="hint" id="bhint"></div>`;
    const input = $("#bv");
    const valid = () => Number.isInteger(bidValue) && bidValue % 10 === 0 && bidValue >= min && bidValue <= V.cap;
    const upd = (fromInput) => {
      if (!fromInput) input.value = bidValue;
      const h = $("#bhint");
      const go = $("#bgo");
      // nach dem ersten Passen beim selben Tier darauf hinweisen, was ein zweites Passen bewirkt
      let msg = passCount.key === animalKeyNow() && passCount.n === 1 ? "Nochmal passen = du steigst bei diesem Tier ganz aus." : "";
      let cls = "hint";
      const pay = valid() ? payFor(bidValue) : null;
      if (bidSnap && bidSnap.to !== bidValue) bidSnap = null;
      if (valid() && bidSnap) {
        cls += " note";
        msg = `${bidSnap.from} kannst du nicht passend zahlen – Gebot auf ${bidValue} erhöht (ohne Wechselgeld).`;
      } else if (pay !== null && pay > bidValue) {
        cls += " warn";
        msg = `${bidValue} kannst du nicht passend zahlen – bekommst du die Karte, zahlst du ${pay} (ohne Wechselgeld).`;
      }
      if (!valid()) {
        cls += " warn";
        msg = bidValue > V.cap ? `Über deinem Limit von ${V.cap}.` : bidValue < min ? `Zu wenig – mindestens ${min}.` : "Nur Vielfache von 10.";
      } else if (bidValue > P.cash) {
        cls += " warn";
        msg = `Bluff – du hast nur ${P.cash}. Nimmt der Versteigerer das Geld, fliegst du auf.`;
      }
      h.className = cls;
      h.textContent = msg;
      h.style.display = msg ? "" : "none";
      go.disabled = !valid();
      go.textContent = valid() && bidValue > P.cash ? "Bluffen" : "Bieten";
      go.classList.toggle("bluff", valid() && bidValue > P.cash);
      placePlate();
      $("#bm").disabled = bidValue - 10 < min;
      $("#bp").disabled = bidValue + 10 > V.cap;
      $("#b50").disabled = bidValue + 50 > V.cap;
    };
    const submit = () => { if (valid()) act({ kind: "bid", amount: bidValue }); };
    upd();
    // selbst eingestellt (±10, Tippen): genau dieser Wert, ggf. mit roter Warnung
    $("#bm").onclick = () => { bidSnap = null; bidValue = Math.max(min, Math.ceil(bidValue / 10) * 10 - 10); upd(); };
    $("#bp").onclick = () => { bidSnap = null; bidValue = Math.min(V.cap, Math.floor(bidValue / 10) * 10 + 10); upd(); };
    input.oninput = () => { bidSnap = null; bidValue = parseInt(input.value.replace(/\D/g, ""), 10) || 0; upd(true); };
    // Schnellwahl: springt auf passend zahlbare Beträge (gelber Hinweis)
    box.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { autoSet(+b.dataset.q); upd(); if (!TOUCH) input.focus(); }));
    $("#b50").onclick = () => { autoSet(Math.floor(bidValue / 10) * 10 + 50); upd(); };
    $("#bgo").onclick = submit;
    $("#bpass").onclick = myPass;
    $("#bout").onclick = () => { autoPassKey = animalKeyNow(); act({ kind: "pass" }); };
    keyHandler = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); myPass(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); $("#bp").click(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); $("#bm").click(); }
    };
    // am Handy nicht automatisch fokussieren, sonst springt die Tastatur auf
    if (!TOUCH && (fresh || document.activeElement === document.body)) { input.focus(); input.select(); }
    return;
  }
  if (V.phase === "auction" && au.stage === "choice") {
    const canBuy = V.legal.includes("buy");
    box.innerHTML = `
      <h4>${nameOf(au.high)} bietet <span class="num" style="font-size:24px">${au.amount}</span> für ${V.animals[au.card].name}</h4>
      <div class="btns">
        <button class="btn primary" id="take">💰 ${au.amount} nehmen <small>G</small></button>
        <button class="btn go" id="buy" ${canBuy ? "" : "disabled"}>✋ Selbst kaufen (${au.amount}) <small>K</small></button>
      </div>
      ${canBuy ? "" : `<div class="hint">Für „Selbst kaufen“ reicht dein Bargeld nicht.</div>`}`;
    $("#take").onclick = () => act({ kind: "take" });
    if (canBuy) $("#buy").onclick = () => act({ kind: "buy" });
    keyHandler = (e) => {
      if (e.key === "g" || e.key === "G") act({ kind: "take" });
      if ((e.key === "k" || e.key === "K") && canBuy) act({ kind: "buy" });
    };
    return;
  }
  if (V.phase === "trade" && !V.trade) {
    box.innerHTML = `<h4>Du bist dran: Wen forderst du heraus?</h4>
      <div class="hint">${TOUCH ? "Tippe auf eine deiner Karten oder auf eine ⚔-Karte beim Gegner." : "Über eine deiner Karten fahren oder eine ⚔-Karte beim Gegner anklicken."}</div>`;
    return;
  }
  const t = V.trade;
  const quartet = V.animals[t.animal].value;
  const overWarn = (s) => (notesSum(s) > quartet ? `<div class="hint warn">Achtung: mehr als der ganze Quartettwert (${quartet})!</div>` : "");
  if (t.stage === "offer") {
    if (selectMode !== "offer") { selectMode = "offer"; selected = [0, 0, 0, 0, 0, 0]; renderWallet(); renderOfferPile(); }
    box.innerHTML = `<h4>Verdecktes Gebot für ${t.k}× ${V.animals[t.animal].name} von ${nameOf(t.target)}</h4>
      <div class="sumline">${cardsLabel(notesCount(selected))} · Wert <span class="num" style="font-size:20px">${notesSum(selected)}</span></div>
      ${QUICK_HTML}
      ${zeroGo()}
      ${overWarn(selected)}
      <div class="hint only">${nameOf(t.target)} sieht nur die Anzahl deiner Karten.</div>`;
    $("#go").onclick = () => zeroSubmit("offer");
    bindQuick();
    return;
  }
  if (selectMode !== "counter") {
    box.innerHTML = `<h4>${nameOf(t.challenger)} will ${t.k}× ${V.animals[t.animal].name} und bietet ${t.offer_count} verdeckte Karte${t.offer_count === 1 ? "" : "n"}</h4>
      <div class="btns"><button class="btn primary" id="acc">Annehmen</button><button class="btn go" id="ctr">Gegengebot</button></div>
      <div class="hint" title="Annehmen: Du bekommst den Stapel, ${nameOf(t.challenger)} die Karte(n). Gegengebot: Der Höhere gewinnt und zahlt die Differenz; bei Gleichstand gewinnt ${nameOf(t.challenger)}.">Gegengebot: Höheres Gebot gewinnt, zahlt nur die Differenz.</div>`;
    $("#acc").onclick = () => act({ kind: "accept" });
    $("#ctr").onclick = () => { selectMode = "counter"; selected = [0, 0, 0, 0, 0, 0]; render(); };
    return;
  }
  box.innerHTML = `<h4>Dein verdecktes Gegengebot (${nameOf(t.challenger)} bietet ${t.offer_count} Karte${t.offer_count === 1 ? "" : "n"})</h4>
    <div class="sumline">${cardsLabel(notesCount(selected))} · Wert <span class="num" style="font-size:20px">${notesSum(selected)}</span></div>
    ${QUICK_HTML}
    ${zeroGo("Gegengebot legen")}
    ${overWarn(selected)}`;
  $("#go").onclick = () => zeroSubmit("counter");
  bindQuick();
  $("#back").onclick = () => { selectMode = null; selected = [0, 0, 0, 0, 0, 0]; render(); };
}

// --------------------------------------------------------------- Kartenflüge
// Eine Karte wandert als "Stellvertreter": Er startet exakt auf der Karte im Inventar (die im selben
// Moment verschwindet), ändert nur während des Flugs seine Größe und übergibt am Ziel an die dort schon
// liegende, bis zur Landung unsichtbare Karte.
const FLY_MS = 620;
const stageScale = () => $("#stage").getBoundingClientRect().width / L.w;

/** Mittelpunkt, echte (unverdrehte) Größe und Drehung eines Karten-Elements in Bildschirmkoordinaten. */
function cardGeom(elm) {
  const r = elm.getBoundingClientRect();
  const s = stageScale();
  const m = /rotate\((-?[\d.]+)deg\)/.exec(elm.style.transform || "");
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: elm.offsetWidth * s, h: elm.offsetHeight * s, rot: m ? +m[1] : 0 };
}
function rectGeom(r, w, h) {
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: w ?? r.width, h: h ?? r.height, rot: 0 };
}
function groupEl(p, animal) {
  if (p === V.me) return document.querySelector(`#hand .hgroup[data-a="${animal}"]`);
  const seat = document.querySelector(`.seat[data-p="${p}"]`);
  return seat && seat.querySelector(`.ogroup[data-a="${animal}"]`);
}
/** Die obersten k Karten einer Tiergruppe (als Startpunkte), sonst der Auslagebereich. */
function topCardGeoms(p, animal, k) {
  const g = groupEl(p, animal);
  const cards = g ? [...g.querySelectorAll(".card")] : [];
  const out = [];
  for (let i = 0; i < k; i++) {
    const c = cards[cards.length - 1 - i];
    if (c) out.push(cardGeom(c));
    else {
      const area = p === V.me ? $("#hand") : document.querySelector(`.seat[data-p="${p}"]`);
      if (area) out.push(rectGeom(area.getBoundingClientRect()));
    }
  }
  return out;
}
function moneyRect(p) {
  if (p === V.me) return $("#wallet").getBoundingClientRect();
  const seat = document.querySelector(`.seat[data-p="${p}"]`);
  return seat ? (seat.querySelector(".mini-money, .seat-head") || seat).getBoundingClientRect() : null;
}

/** Vor dem Neuzeichnen: Startpunkte der Flüge merken. */
function planFlights(prev, events) {
  const out = [];
  const revFlip = document.querySelector("#revealed .flip");
  for (const ev of events) {
    if (["sold", "bought", "free"].includes(ev.kind) && revFlip) {
      out.push({ img: tierImg(prev.animals[ev.card].key), from: cardGeom(revFlip), to: { p: ev.player, animal: ev.card } });
      const au = prev.auction;
      if (au && ev.kind !== "free") {
        const payer = ev.kind === "sold" ? ev.player : au.auctioneer;
        const payee = ev.kind === "sold" ? au.auctioneer : au.high;
        const from = moneyRect(payer);
        for (let i = 0; i < 3 && from; i++) out.push({ money: true, from: rectGeom(from), to: { p: payee, money: true }, delay: 120 + i * 90 });
      }
    }
    if (ev.kind === "challenge" && ev.animal !== undefined) {
      for (const who of [ev.challenger, ev.target]) {
        topCardGeoms(who, ev.animal, ev.k).forEach((from, i) => {
          out.push({ img: tierImg(prev.animals[ev.animal].key), from,
            to: { center: true, idx: (who === ev.target ? ev.k : 0) + i }, delay: i * 120 + (who === ev.target ? 250 : 0) });
        });
      }
    }
    if (ev.kind === "offer" && prev.trade) {
      const from = moneyRect(prev.trade.challenger);
      for (let i = 0; i < Math.min(ev.count || 0, 8) && from; i++) {
        out.push({ money: true, from: rectGeom(from), to: { stack: true }, delay: i * 80 });
      }
    }
    if (ev.kind === "trade_result") {
      // Ablauf am Tisch: (Gegengebot hinlegen) -> Geldstapel tauschen -> Tierkarten zum Gewinner
      const cardsAt = planStackSwap(ev);
      const center = [...document.querySelectorAll("#revealed .tcard")];
      const froms = center.length ? center.map(cardGeom) : topCardGeoms(ev.loser, ev.animal, ev.k);
      froms.forEach((from, i) => out.push({ img: tierImg(prev.animals[ev.animal].key), from,
        to: { p: ev.winner, animal: ev.animal }, delay: cardsAt + i * 120, hold: true }));
    }
  }
  return out;
}

/** Nach dem Neuzeichnen: Zielkarten verstecken und die Stellvertreter fliegen lassen. */
let tradeAnimEnd = 0;   // bis wann die Kuhhandel-Animation am Tisch läuft

/** Verdeckte Geldstapel beim Kuhhandel sichtbar bewegen. Gibt zurück, wann die Tierkarten losfliegen. */
function planStackSwap(ev) {
  if (FAST) return 250;
  const k = speed === 2 ? 0.5 : 1;   // bei „Schnell“ halb so lang, damit sich Handel nicht überlappen
  const s = stageScale();
  const onTable = [...document.querySelectorAll("#tstack .card")].map(cardGeom);
  const small = (r) => (r ? rectGeom(r, L.mini.w * s, L.mini.h * s) : null);
  const money = (p) => small(moneyRect(p));
  const ts = $("#tstack").getBoundingClientRect();
  const make = (from, count, withBadge) => {
    const c = el("div", "card fly mback");
    Object.assign(c.style, { left: `${from.cx - from.w / 2}px`, top: `${from.cy - from.h / 2}px`, width: `${from.w}px`, height: `${from.h}px`, transform: `rotate(${from.rot}deg)` });
    if (withBadge) c.appendChild(el("span", "cnt", `×${count}`));
    document.body.appendChild(c);
    return { el: c, from };
  };
  const move = (c, to, at, remove) => setTimeout(() => {
    c.el.style.transform = `translate(${to.cx - c.from.cx}px, ${to.cy - c.from.cy}px) scale(${to.w / c.from.w}, ${to.h / c.from.h}) rotate(${to.rot}deg)`;
    if (remove) setTimeout(() => { c.el.style.transition = "opacity .25s"; c.el.style.opacity = "0"; setTimeout(() => c.el.remove(), 270); }, FLY_MS);
  }, at);
  // Stapel des Herausforderers: liegt schon auf dem Tisch (Stellvertreter an derselben Stelle)
  const offer = onTable.map((g, i) => make(g, ev.offer_count, i === onTable.length - 1));
  const back = (p) => money(p);
  const finish = (cardsAt) => {
    tradeAnimEnd = Date.now() + cardsAt + FLY_MS + 400;
    actionHoldUntil = tradeAnimEnd;          // eigener Zug erst, wenn der Tisch wieder ruhig ist
    setTimeout(render, cardsAt + FLY_MS + 420);
    const pl = $("#plaque");
    pl.style.transition = "opacity .25s";
    pl.style.opacity = "0";
    setTimeout(() => { pl.style.opacity = ""; }, cardsAt + FLY_MS);
    return cardsAt;
  };
  if (ev.accepted) {
    // angenommen: der Stapel geht an den Herausgeforderten
    const to = back(ev.target);
    offer.forEach((c, i) => to && move(c, to, (700 + i * 60) * k, true));
    return finish(1500 * k);
  }
  // Gegengebot: Stapel des Herausgeforderten kommt auf den Tisch, rechts neben den ersten
  const n = Math.min(ev.counter_count, 8);
  const src = back(ev.target);
  const counter = [];
  for (let i = 0; i < n && src; i++) {
    const c = make(src, ev.counter_count, i === n - 1);
    const to = { cx: ts.right + (L.ts.dx + i * 6) * s, cy: ts.top + (L.ts.h / 2 - i * 2) * s, w: L.ts.w * s, h: L.ts.h * s, rot: ((i * 37) % 11) - 5 };
    move(c, to, (150 + i * 70) * k, false);
    c.from2 = to;
    counter.push(c);
  }
  // nach einer kurzen Pause tauschen (bei Gleichstand nimmt jeder seinen Stapel zurück)
  const SWAP = 1700 * k;
  const offerTo = back(ev.tie ? ev.challenger : ev.target), counterTo = back(ev.tie ? ev.target : ev.challenger);
  offer.forEach((c, i) => offerTo && move(c, offerTo, SWAP + i * 60 * k, true));
  counter.forEach((c, i) => counterTo && move(c, counterTo, SWAP + (100 + i * 60) * k, true));
  return finish(SWAP + 800 * k);
}

function runFlights(flights) {
  const taken = new Map(); // Gruppe -> bereits vergebene Zielkarten
  const pendingBadges = new Map();
  for (const f of flights) {
    let dest = null, to = null;
    if (f.to.center) {
      dest = document.querySelectorAll("#revealed .tcard")[f.to.idx] || null;
    } else if (f.to.stack) {
      to = rectGeom($("#tstack").getBoundingClientRect(), L.ts.w * stageScale(), L.ts.h * stageScale());
    } else if (f.to.money) {
      const r = moneyRect(f.to.p);
      if (r) to = rectGeom(r, L.mini.w * stageScale(), L.mini.h * stageScale());
    } else {
      const g = groupEl(f.to.p, f.to.animal);
      if (g) {
        const cards = [...g.querySelectorAll(".card")];
        const n = taken.get(g) || 0;
        taken.set(g, n + 1);
        dest = cards[cards.length - 1 - n] || null;
        const badge = g.querySelector(".cnt");
        if (badge) { badge.style.visibility = "hidden"; pendingBadges.set(badge, (pendingBadges.get(badge) || 0) + 1); }
        f.badge = badge;
      } else {
        const area = f.to.p === V.me ? $("#hand") : document.querySelector(`.seat[data-p="${f.to.p}"] .seat-cards`);
        if (area) to = rectGeom(area.getBoundingClientRect(), f.from.w * 0.7, f.from.h * 0.7);
      }
    }
    if (dest) { to = cardGeom(dest); dest.style.visibility = "hidden"; }
    if (!to) continue;

    const { cx, cy, w, h, rot } = f.money ? { ...f.from, w: L.mini.w * stageScale(), h: L.mini.h * stageScale(), rot: 0 } : f.from;
    const c = el("div", "card fly" + (f.money ? " mback" : ""));
    Object.assign(c.style, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px`, transform: `rotate(${rot}deg)` });
    if (f.img) c.style.backgroundImage = `url(${f.img})`;
    document.body.appendChild(c);
    const land = () => {
      if (dest) {
        // Zielkarte blendet ein, während der Stellvertreter ausblendet -> kein harter Sprung hinter die Nachbarkarten
        dest.style.opacity = "0";
        dest.style.visibility = "";
        dest.style.transition = "opacity .25s ease";
        requestAnimationFrame(() => { dest.style.opacity = "1"; });
        setTimeout(() => { dest.style.transition = ""; dest.style.opacity = ""; }, 320);
      }
      if (f.badge) {
        const left = pendingBadges.get(f.badge) - 1;
        pendingBadges.set(f.badge, left);
        if (left <= 0) f.badge.style.visibility = "";
      }
      c.style.transition = "opacity .25s ease";
      c.style.opacity = "0";
      setTimeout(() => c.remove(), 270);
    };
    setTimeout(() => {
      // Position UND Größe ändern sich nur während des Flugs
      c.style.transform = `translate(${to.cx - cx}px, ${to.cy - cy}px) scale(${to.w / w}, ${to.h / h}) rotate(${to.rot}deg)`;
      if (f.money) setTimeout(() => { c.style.opacity = "0"; }, FLY_MS - 150);
      setTimeout(land, FLY_MS + 20);
    }, 30 + (f.delay || 0));
  }
}

// --------------------------------------------------------------- Ereignisse
function handleEvent(ev) {
  const li = el("li", null, ev.text);
  if (ev.kind === "reveal") {
    bidHistory = [];
    lastAmount = null;
    li.className = "card";
    li.textContent = `${EMOJI[V.animals[ev.card].key]} ${V.animals[ev.card].name} – Versteigerer ${nameOf(ev.auctioneer)}`;
  }
  if (ev.kind === "bid") bidHistory.push({ p: ev.player, amount: ev.amount });
  if (ev.kind === "bust") { li.className = "bad"; bidHistory = []; lastAmount = null; }
  if (["sold", "bought", "free", "trade_result"].includes(ev.kind)) li.className = "good";
  if (ev.kind === "reveal_bids") return;   // reine Daten für die Aufdeck-Szene
  $("#log-list").appendChild(li);
  $("#log-list").scrollTop = 1e9;
  const snd = { bid: "tick", sold: "sold", bought: "sold", free: "gavel", bust: "bust",
    donkey: "iah", challenge: "moo", offer: "flip", trade_result: "coins", phase: "fanfare" }[ev.kind];
  if (snd) Snd.play(snd);
  if (ev.kind === "over") Snd.play(V.ranking && V.ranking[0] === V.me ? "win" : "lose");

  if (ev.kind === "donkey") banner("Esel-Bonus!", ev.text.replace(/^\d+\. Esel! /, ""));
  else if (ev.kind === "bust") {
    banner("Aufgeflogen!", ev.text, true);
    setTimeout(() => {
      const s = ev.player === V.me ? $("#me-plate") : document.querySelector(`.seat[data-p="${ev.player}"]`);
      if (s) { s.classList.remove("shake"); void s.offsetWidth; s.classList.add("shake"); }
    }, 60);
  } else if (ev.kind === "trade_result") {
    const mine = ev.winner === V.me || ev.loser === V.me;
    banner(mine ? (ev.winner === V.me ? "Gewonnen!" : "Verloren!") : "Kuhhandel!", ev.text, mine && ev.loser === V.me, mine ? 3.2 : 2.1);
  }
  else if (ev.kind === "phase") banner("Phase 2", "Alle Karten sind versteigert – jetzt wird gehandelt!");
  else if (["sold", "bought", "free", "challenge", "offer"].includes(ev.kind)) toast(ev.text);
}
function toast(text) {
  const t = el("div", "toast", text);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4300);
  while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
}
function placeBanner() {
  const r = $("#stage").getBoundingClientRect();
  const w = $("#banner-wrap");
  const c = $("#center").getBoundingClientRect();
  w.style.left = `${r.left + r.width / 2}px`;
  w.style.top = `${compact() ? c.top + c.height / 2 : r.top + r.height * (380 / 900)}px`;
  w.style.transform = `translate(-50%, -50%) scale(${r.width / L.w})`;
}
function banner(title, text, bad, secs = 2.1) {
  placeBanner();
  const b = $("#banner");
  b.className = bad ? "bad" : "";
  b.style.animationDuration = `${secs}s`;
  b.innerHTML = `<div class="t">${title}</div><div class="d">${text}</div>`;
  void b.offsetWidth;
  b.classList.add("show");
}

// --------------------------------------------------------------- Aufdeck-Szene im Kuhhandel
// Nur die Karten des Gegners werden umgedreht und gegen das eigene (verdeckt bleibende) Gebot hochgezählt.
function expandNotes(notes) {
  const out = [];
  (notes || []).forEach((c, i) => { for (let k = 0; k < c; k++) out.push(V.denoms[i]); });
  return out.sort((a, b) => a - b);
}
function showReveal(ev, done) {
  const iAmC = ev.challenger === V.me;
  const other = iAmC ? ev.target : ev.challenger;
  const oppCards = expandNotes(iAmC ? ev.counter : ev.offer);
  const mine = ev.accepted ? null : expandNotes(iAmC ? ev.offer : ev.counter);
  const mySum = mine ? mine.reduce((a, b) => a + b, 0) : 0;
  const oppSum = oppCards.reduce((a, b) => a + b, 0);
  const box = el("div", "reveal");
  const back = (n, cls) => Array.from({ length: n }, (_, i) =>
    `<div class="rc ${cls}" style="--i:${i};--n:${n}"><div class="rf rb"></div><div class="rf rfront"></div></div>`).join("");
  box.innerHTML = `
    <div class="rtitle">${ev.accepted ? `Du nimmst an – ${nameOf(other)}s Stapel` : "Aufdecken!"}</div>
    <div class="rrow">
      <div class="rside"><div class="rwho">${nameOf(other)}</div>
        <div class="rcards">${back(Math.max(oppCards.length, 0), "opp") || '<span class="rempty">leerer Stapel</span>'}</div>
        <div class="rsum num" id="rv-opp">0</div></div>
      ${mine ? `<div class="rmid"><div class="rvs">gegen</div><div class="rdelta" id="rv-delta"></div></div>
      <div class="rside"><div class="rwho">Du <span class="rhint">(nur du siehst sie)</span></div>
        <div class="rcards">${back(mine.length, "mine") || '<span class="rempty">leerer Stapel</span>'}</div>
        <div class="rsum num">${mySum}</div></div>` : ""}
    </div>`;
  $("#stage").appendChild(box);
  const cards = [...box.querySelectorAll(".rc.opp")];
  cards.forEach((c, i) => { c.querySelector(".rfront").style.backgroundImage = `url(${geldImg(oppCards[i])})`; });
  // eigene Karten liegen von Anfang an offen (man weiß ja, was man gelegt hat)
  [...box.querySelectorAll(".rc.mine")].forEach((c, i) => {
    c.querySelector(".rfront").style.backgroundImage = `url(${geldImg(mine[i])})`;
    c.classList.add("up", "still");
  });
  let shown = 0;
  const STEP = Math.max(160, Math.min(300, 1700 / Math.max(1, cards.length)));
  const START = 1300;   // kurz Spannung aufbauen, bevor die erste Karte umgedreht wird
  cards.forEach((c, i) => setTimeout(() => {
    c.classList.add("up");
    Snd.play("flip");
    shown += oppCards[i];
    const s = $("#rv-opp");
    if (s) { s.textContent = shown; s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump"); }
  }, START + i * STEP));
  const end = START + cards.length * STEP + 600;
  setTimeout(() => {
    const dEl = $("#rv-delta");
    if (mine) {
      // Gewinner: höheres Gebot, Gleichstand -> Herausforderer. Differenz = was der Gewinner zahlt.
      const iWin = mySum > oppSum || (mySum === oppSum && iAmC);
      const diff = mySum - oppSum;
      box.classList.add(iWin ? "win" : "lose");
      if (dEl) {
        dEl.className = `rdelta num ${iWin ? "good" : "bad"}`;
        dEl.innerHTML = `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff)}
          <small>${diff === 0 ? "kein Geldfluss" : iWin ? `du zahlst ${Math.abs(diff)}` : `du bekommst ${Math.abs(diff)}`}</small>`;
      }
      Snd.play(iWin ? "chime" : "lose");
    } else {
      const s = $("#rv-opp");
      if (s) s.insertAdjacentHTML("afterend", `<div class="rdelta num good">+${oppSum}<small>du bekommst ${oppSum}</small></div>`);
      Snd.play("coins");
    }
  }, end);
  setTimeout(() => { box.classList.add("out"); setTimeout(() => box.remove(), 350); done(); }, end + 2600);
}

// --------------------------------------------------------------- Quartett-Momente
function quartetMoments(prev, after = 0) {
  let delay = Math.max(900, after + 150);
  for (let p = 0; p < V.n; p++) {
    const before = prev.players[p].animals, after = V.players[p].animals;
    for (let a = 0; a < after.length; a++) {
      if (after[a] === 4 && before[a] !== 4) {
        const gain = scoreOf(after) - scoreOf(before);
        setTimeout(() => {
          Snd.play("chime");
          banner("Quartett!", `${p === V.me ? "Du hast" : `${V.players[p].name} hat`} alle vier ${V.animals[a].name === "Schaf" ? "Schafe" : V.animals[a].name + "-Karten"} – jetzt ${scoreOf(after)} Punkte`, false, 2.4);
          scorePop(p, `+${gain}`);
        }, delay);
        delay += 1200;
      }
    }
  }
}
function scorePop(p, text) {
  const anchor = p === V.me ? $("#me-plate .nameplate") : document.querySelector(`.seat[data-p="${p}"] .nameplate`);
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const s = stageScale();
  const pop = el("div", "scorepop num", text);
  Object.assign(pop.style, { left: `${r.left + r.width / 2}px`, top: `${r.top}px`, fontSize: `${(compact() ? 30 : 40) * s}px` });
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 1900);
}

// --------------------------------------------------------------- Sounds (synthetisch, keine Dateien nötig)
const Snd = {
  ctx: null,
  on: (() => { try { return localStorage.getItem("kh-sound") !== "0"; } catch (e) { return true; } })(),
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; }
  },
  tone(f0, dur, { type = "sine", vol = 0.12, at = 0, f1 = null, lp = null } = {}) {
    const c = this.ctx, t = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (lp) { const fl = c.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = lp; o.connect(fl); node = fl; }
    node.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  },
  noise(dur, { vol = 0.2, at = 0, hp = null, lp = null } = {}) {
    const c = this.ctx, t = c.currentTime + at;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = buf;
    let node = src;
    if (hp) { const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp; node.connect(f); node = f; }
    if (lp) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; node.connect(f); node = f; }
    g.gain.value = vol;
    node.connect(g); g.connect(c.destination);
    src.start(t);
  },
  play(name) {
    if (!this.on || FAST) return;
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const T = this;
    ({
      flip: () => T.noise(0.07, { vol: 0.22, hp: 1800 }),
      tick: () => T.tone(900, 0.05, { type: "square", vol: 0.035 }),
      gavel: () => { T.tone(160, 0.14, { type: "triangle", vol: 0.35 }); T.noise(0.05, { vol: 0.3, lp: 900 }); },
      coins: () => [1900, 2500, 2200, 2800].forEach((f, i) => T.tone(f, 0.13, { vol: 0.05, at: i * 0.055 })),
      sold: () => { T.play("gavel"); setTimeout(() => T.play("coins"), 180); },
      bust: () => T.tone(230, 0.45, { type: "sawtooth", vol: 0.07, f1: 110, lp: 900 }),
      iah: () => { T.tone(480, 0.22, { type: "sawtooth", vol: 0.06, f1: 720, lp: 1500 }); T.tone(720, 0.35, { type: "sawtooth", vol: 0.06, at: 0.23, f1: 330, lp: 1200 }); },
      moo: () => T.tone(130, 0.7, { type: "sawtooth", vol: 0.08, f1: 98, lp: 480 }),
      chime: () => [1047, 1319, 1568, 2093].forEach((f, i) => T.tone(f, 0.35, { vol: 0.06, at: i * 0.09 })),
      win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => T.tone(f, 0.28, { type: "triangle", vol: 0.1, at: i * 0.11 })),
      lose: () => [392, 330, 262].forEach((f, i) => T.tone(f, 0.3, { type: "triangle", vol: 0.08, at: i * 0.16 })),
      fanfare: () => [392, 523, 659, 784].forEach((f, i) => T.tone(f, 0.22, { type: "triangle", vol: 0.08, at: i * 0.1 })),
    }[name] || (() => {}))();
  },
};

// --------------------------------------------------------------- Regeln
const RULES_HTML = `
  <h2>Kurzregeln (Hausregeln)</h2>
  <h3>Ziel</h3>
  <p>Sammle vollständige Quartette (alle 4 Karten einer Tierart). Punkte = Summe der Quartettwerte × Anzahl deiner Quartette. Unvollständige Sätze zählen nichts. Gleichstand: mehr Bargeld gewinnt.</p>
  <h3>Phase 1 – Versteigerung</h3>
  <ul>
    <li>Reihum ist jemand Versteigerer und bietet selbst nicht mit. Gebote in 10er-Schritten, mindestens 10 über dem Höchstgebot.</li>
    <li>Passen gilt nur, bis jemand anderes höher bietet – dann darfst du wieder mitbieten.</li>
    <li><b>Bluffen</b> ist erlaubt, aber höchstens bis <b>2 × Bargeld + 100</b> (dein Limit).</li>
    <li>Der Versteigerer wählt: <b>Geld nehmen</b> (Bieter zahlt ihm, bekommt die Karte) oder <b>selbst kaufen</b> (er zahlt dem Bieter und behält die Karte).</li>
    <li>Kann der Bieter nicht zahlen, fliegt er auf: Sein Geld wird gezeigt und die Karte ohne ihn neu versteigert.</li>
    <li>Bezahlt wird mit Geldkarten, <b>ohne Wechselgeld</b> – mit möglichst großen Scheinen, die kleinen bleiben dir zum Bieten.</li>
    <li>Bei jedem Esel bekommt jeder einen Bonus: 50, 100, 200, 500.</li>
  </ul>
  <h3>Phase 2 – Kuhhandel</h3>
  <ul>
    <li>Wer dran ist, fordert jemanden heraus, der dieselbe Tierart (unvollständig) hat. Haben beide mindestens 2, geht es um 2 Karten, sonst um 1.</li>
    <li>Der Herausforderer legt verdeckt Geldkarten hin – der Gegner sieht nur die Anzahl. Es liegt immer mindestens eine Karte (zur Not ein 0er).</li>
    <li>Der Gegner <b>nimmt an</b> (er bekommt das Geld, der Herausforderer die Karten) oder macht ein <b>Gegengebot</b>.</li>
    <li>Beim Gegengebot gewinnt das höhere Gebot und zahlt nur die <b>Differenz</b>. Gleichstand: Der Herausforderer gewinnt, kein Geld fließt.</li>
    <li>Herausfordern ist Pflicht, solange es möglich ist.</li>
  </ul>
  <h3>Bedienung</h3>
  <p>Enter = bieten, Esc = passen, ↑/↓ = ±10. Als Versteigerer: G = Geld nehmen, K = selbst kaufen.</p>`;
function showRules() {
  const ov = el("div", "rules-ov", `<div class="panel rules">${RULES_HTML}<button class="big" id="rules-close">Verstanden</button></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#rules-close").onclick = close;
}

// --------------------------------------------------------------- Konfetti
function confetti() {
  const cv = el("canvas", "confetti");
  cv.width = innerWidth; cv.height = innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d");
  const cols = ["#f5c542", "#7cc47f", "#ef9f96", "#9ec6ef", "#fbf3df", "#f6b26b"];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)],
  }));
  const t0 = performance.now();
  const tick = (t) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (t - t0 < 4500) requestAnimationFrame(tick); else cv.remove();
  };
  requestAnimationFrame(tick);
}

// --------------------------------------------------------------- Start / Ende / Menü
let nPlayers = 4;
let opponents = "ai";
let level = "schwer";
const START_HTML = $("#overlay").innerHTML;
function segment(sel, attr, cb) {
  document.querySelectorAll(`${sel} button`).forEach((b) => (b.onclick = () => {
    document.querySelectorAll(`${sel} button`).forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    cb(b.dataset[attr]);
  }));
}
function bindStart() {
  segment("#in-players", "n", (v) => (nPlayers = +v));
  segment("#in-opp", "o", (v) => { opponents = v; $("#level-row").style.display = v === "ai" ? "" : "none"; });
  segment("#in-level", "l", (v) => (level = v));
  document.querySelector(`#in-level [data-l="${level}"]`)?.click();
  document.querySelector(`#in-players [data-n="${nPlayers}"]`)?.click();
  Local.call("/api/info").then((info) => {
    if (!info.ai_available) {
      $("#ai-note").textContent = "Noch keine trainierte KI gefunden – es spielen die einfachen Bots.";
      document.querySelector('#in-opp [data-o="heuristic"]').click();
    } else {
      $("#ai-note").textContent = "Trainierte KI-Gegner – läuft komplett in deinem Browser";
    }
  });
  $("#btn-start").onclick = async () => {
    clearTimeout(botTimer);
    since = 0;
    V = null;
    bidHistory = [];
    lastBubble = {};
    selectMode = null;
    selected = [0, 0, 0, 0, 0, 0];
    $("#log-list").innerHTML = "";
    $("#seats").dataset.players = "";
    $("#overlay").classList.remove("show");
    accept(await api("/api/new", { players: nPlayers, name: $("#in-name").value.trim() || "Du", opponents, level }));
  };
}
bindStart();

function showStart() {
  clearTimeout(botTimer);
  $("#overlay").innerHTML = START_HTML;
  bindStart();
  $("#overlay").classList.add("show");
}

const closeMenu = () => $("#menu").classList.remove("open");
$("#menu-toggle").onclick = (e) => { e.stopPropagation(); $("#menu").classList.toggle("open"); };
function setSpeed(v) {
  speed = +v;
  try { localStorage.setItem("kh-speed", speed); } catch (e) { /* egal */ }
  document.querySelectorAll("#m-speed button").forEach((b) => b.classList.toggle("on", +b.dataset.s === speed));
  if (V) { render(); scheduleBot([]); }   // sofort im neuen Tempo weiter
}
segment("#m-speed", "s", (v) => setSpeed(v));
document.querySelector(`#m-speed [data-s="${speed}"]`).classList.add("on");
$("#m-log").onclick = () => { closeMenu(); $("#log").classList.add("open"); };
$("#m-rules").onclick = () => { closeMenu(); showRules(); };
const updSound = () => { $("#m-sound").textContent = Snd.on ? "🔊 Ton an" : "🔇 Ton aus"; };
$("#m-sound").onclick = () => {
  Snd.on = !Snd.on;
  try { localStorage.setItem("kh-sound", Snd.on ? "1" : "0"); } catch (e) { /* egal */ }
  updSound();
fetch("/api/training").then((r) => { if (!r.ok) throw new Error(); }).catch(() => { $("#m-train").style.display = "none"; });
  if (Snd.on) Snd.play("coins");
};
updSound();
fetch("/api/training").then((r) => { if (!r.ok) throw new Error(); }).catch(() => { $("#m-train").style.display = "none"; });
// Browser erlauben Ton erst nach einer Nutzeraktion
document.addEventListener("pointerdown", () => Snd.init(), { once: true });
$("#m-skip").onclick = async () => {
  closeMenu();
  if (busy) return;
  busy = true;
  clearTimeout(botTimer);
  selectMode = null;
  const v = await api("/api/skip_auction", {});
  busy = false;
  if (v) accept(v);
};
$("#m-new").onclick = () => {
  closeMenu();
  if (V && V.phase !== "over" && !confirm("Laufendes Spiel abbrechen und ein neues starten?")) return;
  showStart();
};
$("#log-close").onclick = () => $("#log").classList.remove("open");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#log").classList.remove("open"); closeMenu(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu, #menu-toggle")) closeMenu();
  // Handy: Tippen daneben klappt eine geöffnete Tiergruppe wieder zu
  if (openGroup !== null && !e.target.closest("#hand .hgroup")) {
    openGroup = null;
    document.querySelectorAll("#hand .hgroup.open").forEach((x) => x.classList.remove("open"));
    unfocusSeat();
  }
  if ($("#log").classList.contains("open") && !e.target.closest("#log, #top-buttons")) $("#log").classList.remove("open");
});

function showResults() {
  const ov = $("#overlay");
  if (ov.classList.contains("show")) return;
  const rows = V.ranking.map((p, i) => {
    const quads = V.players[p].animals.map((c, a) => (c === 4 ? a : -1)).filter((a) => a >= 0);
    const icons = quads.map((a) => `<i class="qi" style="background-image:url(${tierImg(animalKey(a))})" title="${V.animals[a].name} (${V.animals[a].value})"></i>`).join("");
    return `<div class="r ${i === 0 ? "win" : ""}">
      <span class="rname">${i === 0 ? "🏆" : `${i + 1}.`} ${V.players[p].name}<span class="qrow">${icons || '<em>kein Quartett</em>'}</span></span>
      <span><span class="num">${V.scores[p]}</span> Pkt · 💰 ${V.cash_all[p]}</span></div>`;
  }).join("");
  ov.innerHTML = `<div class="panel"><h1>${V.ranking[0] === V.me ? "Gewonnen!" : "Spielende"}</h1>
    <p class="sub">Quartettwert × Anzahl Quartette</p>
    <div class="results">${rows}</div>
    <button class="big" id="again">Nochmal spielen</button>
    <button class="big alt" id="stats">📊 Statistiken</button></div>`;
  $("#again").onclick = showStart;
  $("#stats").onclick = showStats;
  setTimeout(() => {
    ov.classList.add("show");
    if (V.ranking[0] === V.me) confetti();
  }, 1800);
}

/** Bühne an das Fenster anpassen; hochkant (Handy) wird eine eigene, schmale Anordnung verwendet.
 *  Gemessen wird der Layout-Viewport, damit Zoomen oder die Handy-Tastatur nichts umwirft. */
// --------------------------------------------------------------- Rückblick (Statistiken nach dem Spiel)
const TURN_NUM = ["①", "②", "③", "④"];
/** Kurve aus geraden Stücken; mid(k) = Punkt mitten im Abschnitt k→k+1. */
function linePath(P) {
  const d = P.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  const mid = (k) => {
    const a = P[Math.max(0, Math.min(P.length - 2, k))], b = P[Math.max(0, Math.min(P.length - 1, k + 1))];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  return { d, mid };
}
/** Siegchance vorher/nachher als Balken: dazugewonnener Teil dunkel, verlorener Teil blass gestreift;
 *  neben dem Namen ein farbiges Plus/Minus. animate: startet beim alten Wert (Übergang per JS). */
function chanceRow(name, color, b, a, isMe, animate = false) {
  const lo = Math.min(a, b), hi = Math.max(a, b), up = a > b;
  const d = Math.round((a - b) * 100);
  const badge = Math.abs(d) < 1 ? `<span class="dl eq">±0</span>` : `<span class="dl ${up ? "up" : "down"}">${up ? "+" : "−"}${Math.abs(d)}</span>`;
  const segW = (hi - lo) * 100;
  return `<div class="cr${isMe ? " me" : ""}" style="--c:${color}"><span class="cn"><span class="cnm">${name}</span>${badge}</span>
    <span class="cbar"><i class="seg ${up ? "gain" : "loss"}" style="left:${lo * 100}%;width:${animate && up ? 0 : segW}%" data-w="${segW}"></i>
      <i class="base" style="width:${(animate ? b : lo) * 100}%" data-w="${lo * 100}"></i></span>
    <b class="cv num">${a > 0 && a < 0.01 ? "<1" : Math.round(a * 100)}%</b></div>`;
}
const growChances = (root) => root.querySelectorAll(".cr .base, .cr .seg").forEach((x) => { x.style.width = `${x.dataset.w}%`; });
/** Mini-Animation einer Versteigerung: Karte erscheint, Preis, Karte geht zum Käufer, Geld zum Versteigerer.
 *  down = die Karte wandert nach unten (zu der unten genannten Person). */
function auctionAnim({ key, price, top, bottom, down, cls = "" }) {
  return `<div class="am-stage ${cls}" style="--dir:${down ? 1 : -1}">
    <span class="who top">${top}</span><span class="who bot">${bottom}</span>
    <div class="amc" style="background-image:url(${tierImg(key)})"></div>
    <div class="amp num">${price}</div>
    <div class="amm"><i></i><b class="num">${price}</b></div></div>`;
}
// feste Farbe je Sitz: du rot, Gegner blau, grün, lila, bernstein (farbenblind-tauglich geprüft)
const SEAT_COLORS = ["#c8372d", "#2f6fbd", "#1b9e77", "#7b52c4", "#c07a0c"];
const CH = { W: 600, H: 210, L: 38, R: 10, T: 12, B: 22 };
function winChart(S) {
  const { W, H, L, R, T, B } = CH;
  const n = S.points.length;
  const x = (i) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : 0);
  const y = (v) => T + (1 - v) * (H - T - B);
  const path = (vals) => linePath(vals.map((v, i) => [x(i), y(v)])).d;
  let g = "";
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  }
  const fair = 1 / S.n;
  g += `<line class="fair" x1="${L}" x2="${W - R}" y1="${y(fair)}" y2="${y(fair)}"/><text class="ax fairt" x="${W - R}" y="${y(fair) - 5}" text-anchor="end">Gleichstand ${Math.round(fair * 100)}%</text>`;
  if (S.p2At > 0) g += `<line class="p2" x1="${x(S.p2At)}" x2="${x(S.p2At)}" y1="${T}" y2="${y(0)}"/><text class="ax" x="${x(S.p2At) + 5}" y="${T + 12}">Kuhhandel</text>`;
  g += `<text class="ax" x="${L}" y="${H - 4}">Spielbeginn</text><text class="ax" x="${W - R}" y="${H - 4}" text-anchor="end">Ende</text>`;
  // jeder Gegner in seiner Farbe, man selbst kräftig obendrauf
  const others = S.others ? S.others.map((vals, q) => (q === 0 ? "" : `<path class="opp" data-q="${q}" style="stroke:${SEAT_COLORS[q]}" d="${path(vals)}"/>`)).join("") : "";
  // Nummer mitten im Wechsel (zwischen vorherigem und neuem Punkt), etwas über der Kurve, mit Strich zum Punkt
  const ms = S.moments || [];
  const me = linePath(S.points.map((v, i) => [x(i), y(v)]));
  const marks = ms.map((m, k) => {
    const [mx, my] = me.mid(m.i - 1);
    const top = Math.min(y(S.points[m.i - 1]), y(S.points[m.i]));
    const by = Math.max(T + 12, top - 22);
    return `<g class="tm" data-m="${k}"><line x1="${mx}" x2="${mx}" y1="${by + 12}" y2="${my}"/><circle class="tp" cx="${mx}" cy="${my}" r="3"/>
      <circle cx="${mx}" cy="${by}" r="12"/><text x="${mx}" y="${by + 4.5}" text-anchor="middle">${k + 1}</text></g>`;
  }).join("");
  return `<svg class="wchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Siegchance im Spielverlauf">
    ${g}${others}<path class="me" style="stroke:${SEAT_COLORS[0]}" d="${me.d}"/>
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${y(0)}" style="display:none"/><circle class="dot" r="5" style="display:none"/>${marks}</svg>`;
}
/** Karte mit Tierbild für einen auffälligen Kauf oder Verkauf. */
function dealCard(d) {
  const rel = Math.round((Math.abs(d.diff) / d.market) * 100);
  const good = d.type === "buy" ? d.diff < 0 : d.diff > 0;
  const tag = d.type === "buy" ? (good ? "Schnäppchen" : "Zu teuer") : (good ? "Gut verkauft" : "Unter Wert");
  const what = d.type === "buy" ? (d.vorkauf ? "per Vorkaufsrecht gekauft" : "ersteigert") : `an ${d.who} verkauft`;
  // Kauf: Karte kommt zu dir (unten), Geld geht zum Versteigerer (oben); Verkauf: umgekehrt
  const img = d.key ? auctionAnim({ key: d.key, price: d.price, top: d.type === "buy" ? (d.from || "") : d.who, bottom: "Du", down: d.type === "buy" }) : "";
  return `<div class="deal ${good ? "good" : "bad"}">${img}
    <div class="dtxt"><span class="tag">${tag}</span>
      <div class="dname">${d.animal} <small>${what}</small></div>
      <div class="dprice"><span class="num">${d.price}</span> <span class="vs">statt ≈ ${d.market}</span></div>
      <div class="drel">${d.diff > 0 ? "+" : "−"}${Math.abs(d.diff)} (${rel} %)</div></div></div>`;
}

// ---- Bausteine für die Statistik: Ring, Balken, Skala, Kachel (füllen sich beim Öffnen)
const ring = (frac, center, cls = "") => `<svg class="ring ${cls}" viewBox="0 0 42 42" aria-hidden="true">
  <circle class="rbg" cx="21" cy="21" r="15.915"/>
  <circle class="rfg" cx="21" cy="21" r="15.915" data-v="${Math.round(frac * 100)}" style="stroke-dasharray:0 100"/>
  <text x="21" y="24.5" text-anchor="middle">${center}</text></svg>`;
const meter = (label, a) => (a ? `<div class="meter"><span class="ml">${label}</span>
  <span class="mbar"><i data-w="${Math.round((100 * a.agree) / a.n)}"></i></span><b>${Math.round((100 * a.agree) / a.n)} %</b></div>` : "");
/** Skala 50 %–150 % mit Marker; lowGood: links ist gut (beim Einkaufen). */
function scale(title, r, lowGood, note) {
  if (r === null) return "";
  const pos = Math.max(0, Math.min(100, (r - 0.5) * 100));
  const good = lowGood ? r <= 0.95 : r >= 1.05, bad = lowGood ? r >= 1.05 : r <= 0.95;
  return `<div class="scale ${lowGood ? "low" : "high"}"><div class="st"><b>${title}</b>
    <span class="${good ? "good" : bad ? "bad" : ""}">${Math.round(r * 100)} % des üblichen Preises</span></div>
    <div class="sbar"><i class="mid"></i><span class="mk" data-l="${pos.toFixed(1)}"></span></div>
    <div class="sl"><span>${lowGood ? "günstig" : "billig"}</span><span>üblich</span><span>${lowGood ? "teuer" : "teuer"}</span></div>
    ${note ? `<div class="snote">${note}</div>` : ""}</div>`;
}
const tile = (num, label, cls = "") => `<div class="tile ${cls}"><b class="num">${num}</b><span>${label}</span></div>`;

const HL = {
  bargain: ["Schnäppchen", true], sold: ["Teuer verkauft", true], closewin: ["Knapp gewonnen", true],
  ripoff: ["Zu teuer bezahlt", false], cheap: ["Zu billig hergegeben", false], closeloss: ["Knapp verloren", false],
};
/** Kuhhandel-Highlight als Endlos-Animation: Karten von links/rechts, Gebote von oben/unten, Differenz, Karten zum Gewinner. */
function tradeHighlight(t, me) {
  const [title, good] = HL[t.kind];
  const img = tierImg(t.key);
  const cards = (side) => Array.from({ length: t.k }, (_, i) =>
    `<div class="hlc ${side}" style="--i:${i};--r:${(side === "l" ? -6 : 6) + i * (side === "l" ? 4 : -4)}deg;background-image:url(${img})"></div>`).join("");
  const diff = t.accepted ? (t.iC ? `für ${t.mine}` : `für ${t.theirs}`) : t.tie ? "Gleichstand" : `Δ ${Math.abs(t.mine - t.theirs)}`;
  const amt = (x, accepted) => (x === null ? (accepted ? "nimmt an" : "–") : x);
  const res = t.won
    ? `Du bekommst ${t.k}× ${t.animal}${t.net < 0 ? ` und zahlst <b>${-t.net}</b>` : t.net > 0 ? ` und erhältst sogar ${t.net}` : " ohne zu zahlen"}`
    : `${t.other} bekommt ${t.k}× ${t.animal}${t.net > 0 ? `, du erhältst <b>${t.net}</b>` : t.net < 0 ? `, du zahlst ${-t.net}` : ""}`;
  return `<div class="hl ${good ? "good" : "bad"}">
    <div class="hl-stage" style="--exit:${t.won ? 1 : -1}">
      <span class="who top">${t.other}</span><span class="who bot">${me}</span>
      <div class="hlm top"><i></i><b class="num">${amt(t.theirs, t.accepted && t.iC)}</b></div>
      <div class="hlm bot"><i></i><b class="num">${amt(t.mine, t.accepted && !t.iC)}</b></div>
      <div class="hlrow"><div class="hlg">${cards("l")}</div><div class="hlg">${cards("r")}</div></div>
      <div class="hld num">${diff}</div>
    </div>
    <div class="hl-txt"><span class="tag">${title}</span>
      <div class="dname">${t.k}× ${t.animal} <small>gegen ${t.other}${t.iC ? " · du hast herausgefordert" : ""}</small></div>
      <div class="hl-bids">${t.mine === null ? "Du hast angenommen" : `Du <b class="num">${t.mine}</b>`} · ${t.theirs === null ? `${t.other} hat angenommen` : `${t.other} <b class="num">${t.theirs}</b>`}</div>
      <div class="hl-res">${res}</div>
      <div class="hl-ref">üblich ≈ ${t.ref} für ${t.k === 1 ? "eine Karte" : `${t.k} Karten`}</div></div></div>`;
}

async function showStats() {
  const S = await Local.call("/api/stats", {});
  if (!S || S.error) { toast("Für diese Partie gibt es keine Statistik."); return; }
  const me = S.names[0];
  const A = S.auction || {}, T = S.trade || {};
  const pctS = (a) => (a ? `${Math.round((100 * a.agree) / a.n)} %` : "–");
  const pc = (v) => (v > 0 && v < 0.01 ? "<1" : Math.round(v * 100));
  const ms = S.moments || [];
  const turns = ms.length
    ? `<div class="moments">${ms.map((m, k) => {
        const who = m.before && m.after ? S.names.map((nm, q) => ({ nm, q, b: m.before[q], a: m.after[q] }))
          .filter((o) => o.q === 0 || Math.abs(o.a - o.b) >= 0.05).sort((x, y) => (x.q === 0 ? -1 : y.q === 0 ? 1 : Math.abs(y.a - y.b) - Math.abs(x.a - x.b))).slice(0, 3) : [];
        return `<div class="moment ${m.d > 0 ? "up" : "down"}">
          <div class="mnum">${k + 1}</div>
          ${m.sale ? auctionAnim({ key: m.sale.key, price: m.sale.price, down: m.sale.buyer === 0,
              top: m.sale.buyer === 0 ? m.sale.sellerName : m.sale.buyerName, bottom: m.sale.buyer === 0 ? "Du" : m.sale.sellerName, cls: "small" })
            : m.key ? `<div class="mimg" style="background-image:url(${tierImg(m.key)})"></div>` : ""}
          <div class="mtxt"><b>${m.title || ""}</b>
            ${m.detail ? `<div>${m.detail}</div>` : ""}
            ${m.conseq.map((c) => `<div class="mcq">★ ${c}</div>`).join("")}
            ${m.skip ? `<div class="muted">beim Überspringen – die KI spielte für dich</div>` : ""}
            <div class="crs">${who.map((o) => chanceRow(o.q === 0 ? "Du" : o.nm, SEAT_COLORS[o.q], o.b, o.a, o.q === 0)).join("")}</div>
            ${m.replay ? `<button class="btn small rp" data-m="${k}">▶ Replay ansehen</button>` : ""}
          </div></div>`;
      }).join("")}</div>`
    : `<p class="muted">Keine großen Ausschläge – deine Chancen haben sich eher gleichmäßig entwickelt.</p>`;
  const notes = (xs) => (xs && xs.length ? `<ul class="notable">${xs.map((d) => `<li><small>${d.ctx}</small>${d.text}</li>`).join("")}</ul>`
    : `<p class="muted">Hier hätte die KI nirgends deutlich anders entschieden.</p>`);

  const tabA = `
    <div class="tiles">
      ${tile(A.bought ?? 0, "Karten ersteigert")}${tile(A.sold ?? 0, "selbst verkauft")}
      ${tile(A.vorkauf ?? 0, "Vorkaufsrecht")}${tile(A.busts ?? 0, "aufgeflogen", A.busts ? "bad" : "")}
    </div>
    ${scale("Beim Einkaufen", A.buyRatio ?? null, true, A.bought ? `${A.bought} Karten für zusammen ${A.spent}` : "")}
    ${scale("Beim Verkaufen", A.sellRatio ?? null, false, A.sold ? `${A.sold} Karten für zusammen ${A.earned} verkauft` : "")}
    <h4>Auffällige Preise</h4>
    ${A.deals && A.deals.length ? `<div class="deals">${A.deals.map(dealCard).join("")}</div>` : `<p class="muted">Alle Preise lagen nah am üblichen Preis.</p>`}
    <h4>Hier hätte die KI anders entschieden</h4>
    ${meter("Wie die KI", A.agree)}
    ${notes(A.notable)}`;
  const tabT = T.n ? `
    <div class="tradehead">
      ${ring(T.won / T.n, `${T.won}/${T.n}`, "win")}
      <div><b>${T.won} von ${T.n}</b> Kuhhändeln gewonnen<div class="muted">${T.challenged} davon hast du selbst begonnen</div></div>
    </div>
    <div class="tiles">${tile(T.paid, "bezahlt", T.paid > T.received ? "bad" : "")}${tile(T.received, "erhalten", T.received > T.paid ? "good" : "")}
      ${tile((T.received - T.paid > 0 ? "+" : "") + (T.received - T.paid), "Saldo", T.received >= T.paid ? "good" : "bad")}</div>
    <h4>Deine Highlights</h4>
    ${T.highlights.length ? T.highlights.map((h) => tradeHighlight(h, me)).join("") : `<p class="muted">Keine besonders guten oder schlechten Händel – alles im üblichen Rahmen.</p>`}
    <h4>Hier hätte die KI anders entschieden</h4>
    ${meter("Wie die KI", T.agree)}
    ${notes(T.notable)}` : `<p class="muted">Du warst an keinem Kuhhandel beteiligt.</p>`;

  const ov = el("div", "rules-ov", `<div class="panel stats">
    <h2>${S.won ? "🏆 " : ""}Deine Partie im Rückblick</h2>
    ${S.agree ? `<div class="agreehead">${ring(S.agree.agree / S.agree.n, pctS(S.agree))}
      <div><b>Du hast in ${pctS(S.agree)} der Fälle so entschieden wie die KI.</b>
        ${meter("Versteigerung", A.agree)}${meter("Kuhhandel", T.agree)}</div></div>` : ""}
    <h3>Siegchance</h3>
    <div class="legend">${S.names.map((nm, q) => (q === 0 || S.others ? `<span class="lg${q === 0 ? " me" : ""}"><span class="sw" style="background:${SEAT_COLORS[q]}"></span>${q === 0 ? me : nm}</span>` : "")).join("")}<span class="lhint">Tippe auf die Kurve</span></div>
    ${winChart(S)}
    <div class="cap" id="wcap">&nbsp;</div>
    <h4>Deine Schlüsselmomente</h4>
    ${turns}
    <div class="tabs"><button data-tab="a" class="on">🔨 Versteigerung</button><button data-tab="t">🐄 Kuhhandel</button></div>
    <section class="tab" data-tab="a">${tabA}</section>
    <section class="tab" data-tab="t" hidden>${tabT}</section>
    ${S.skipped ? `<p class="muted">Die Versteigerung wurde (teilweise) übersprungen – dort hat die KI für dich gespielt.</p>` : ""}
    <p class="foot">Einschätzungen der KI „Schwer“: stark, aber nicht perfekt – eine Zweitmeinung, kein Urteil. „Üblich“ = was KIs für dieses Tier zum selben Spielzeitpunkt im Schnitt zahlen.</p>
    <button class="big" id="stats-close">Schließen</button></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#stats-close").onclick = close;
  // Replay eines Schlüsselmoments: Karte oder Nummer in der Kurve antippen
  const goReplay = (k) => { if (ms[k] && ms[k].trade) showTradeReplay(S, k); };
  ov.querySelectorAll(".rp").forEach((b) => (b.onclick = () => goReplay(+b.dataset.m)));
  ov.querySelectorAll(".tm").forEach((g) => g.addEventListener("click", (e) => { e.stopPropagation(); goReplay(+g.dataset.m); }));
  // Ringe, Balken und Skalen laufen beim Sichtbarwerden auf ihren Wert
  const animate = (root) => setTimeout(() => {
    root.querySelectorAll(".rfg").forEach((c) => { c.style.strokeDasharray = `${c.dataset.v} ${100 - c.dataset.v}`; });
    root.querySelectorAll(".mbar i").forEach((b) => { b.style.width = `${b.dataset.w}%`; });
    root.querySelectorAll(".mk").forEach((m) => { m.style.left = `${m.dataset.l}%`; });
  }, 60);
  animate(ov.querySelector(".panel"));
  ov.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    ov.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    ov.querySelectorAll("section.tab").forEach((sec) => {
      const show = sec.dataset.tab === b.dataset.tab;
      sec.hidden = !show;
      if (show) {
        sec.querySelectorAll(".rfg").forEach((c) => { c.style.strokeDasharray = "0 100"; });
        sec.querySelectorAll(".mbar i").forEach((x) => { x.style.width = "0"; });
        sec.querySelectorAll(".mk").forEach((x) => { x.style.left = "50%"; });
        animate(sec);
      }
    });
  }));
  // Kurve antippen/überfahren: nächsten Punkt zeigen
  const svg = ov.querySelector(".wchart"), cap = ov.querySelector("#wcap");
  const n = S.points.length;
  const fmt = (v) => (v > 0 && v < 0.01 ? "<1 %" : `${Math.round(v * 100)} %`);
  const pick = (ev) => {
    const r = svg.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * CH.W;
    const span = CH.W - CH.L - CH.R;
    const i = Math.max(0, Math.min(n - 1, Math.round(((vx - CH.L) / span) * (n - 1))));
    const px = CH.L + (n > 1 ? (i / (n - 1)) * span : 0), py = CH.T + (1 - S.points[i]) * (CH.H - CH.T - CH.B);
    const cr = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
    cr.setAttribute("x1", px); cr.setAttribute("x2", px); cr.style.display = "";
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.style.display = "";
    const all = S.others
      ? S.names.map((nm, q) => [nm, S.others[q][i], q]).sort((a, b) => b[1] - a[1])
        .map(([nm, v, q]) => `<span class="${q === 0 ? "me" : ""}">${nm} ${fmt(v)}</span>`).join(" · ")
      : `<b>${fmt(S.points[i])}</b>`;
    cap.innerHTML = `<div>${all}</div><div class="muted">${S.labels[i] || (i === 0 ? "Spielbeginn" : "")}</div>`;
  };
  svg.addEventListener("pointermove", pick);
  svg.addEventListener("pointerdown", pick);
}

// --------------------------------------------------------------- Replay eines Kuhhandels (eigenes kleines Fenster)
// Nur die zwei Händler: einer oben, einer unten (du immer unten). Karten in die Mitte, verdeckte Stapel,
// Aufdecken, Differenz, dann wandern Geld und Karten – darunter, wie sich die Siegchancen verschoben haben.
function showTradeReplay(S, k) {
  const m = S.moments[k], T = m.trade;
  if (!T) return;
  const meIn = T.c === 0 || T.t === 0;
  const bot = meIn ? 0 : T.c, top = bot === T.c ? T.t : T.c;      // wer unten/oben sitzt
  const name = (p) => (p === 0 ? "Du" : S.names[p]);
  const val = (p) => (p === T.c ? T.vo : T.vc), cnt = (p) => (p === T.c ? T.oc : T.cc);
  const img = tierImg(T.key);
  const pc = (v) => (v > 0 && v < 0.01 ? "<1" : Math.round(v * 100));
  const cards = (side) => Array.from({ length: T.k }, (_, i) => `<div class="trc ${side}" style="--i:${i};background-image:url(${img})"></div>`).join("");
  const stack = (p, pos) => {
    const n = Math.min(cnt(p), 8);
    const backs = Array.from({ length: Math.max(n, 1) }, (_, i) => `<i style="left:${i * 7}px;transform:rotate(${((i * 37) % 11) - 5}deg)${n ? "" : ";opacity:.25"}"></i>`).join("");
    return `<div class="trs ${pos}" data-p="${p}"><span class="backs" style="width:${26 + Math.max(n - 1, 0) * 7}px">${backs}</span>
      <span class="trn">×${cnt(p)}</span><b class="trv num" data-v="${val(p) ?? 0}">?</b></div>`;
  };
  const diff = T.accepted ? `angenommen: ${T.vo}` : T.tie ? "Gleichstand" : `Differenz ${Math.abs(T.vo - T.vc)}`;
  const res = T.winner === 0 ? `Du bekommst ${T.k}× ${T.animal}` : `${name(T.winner)} bekommt ${T.k}× ${T.animal}`;
  const bars = m.before && m.after ? `<div class="crs big"><div class="crh">Siegchancen</div>${S.names.map((nm, q) =>
    chanceRow(q === 0 ? "Du" : nm, SEAT_COLORS[q], m.before[q], m.after[q], q === 0, true)).join("")}</div>` : "";
  // Einblendung am Ende: Geld-Plus/-Minus je Spieler und ein Stempel, wenn es ein Schnäppchen oder zu teuer war
  const net = (p) => {
    if (T.accepted) return p === T.c ? -T.vo : T.vo;
    if (T.tie) return 0;
    return p === T.winner ? -Math.abs(T.vo - T.vc) : Math.abs(T.vo - T.vc);
  };
  const ai = KH.ANIMALS.findIndex((x) => x[0] === T.key);
  const TM = self.TRADE_MARKET || {};
  const ref = (TM[`${ai}-${S.n}`] || TM[`${ai}-x`] || 100) * T.k;
  const verdict = (p) => {
    const v = net(p);
    if (p === T.winner) return -v <= 0.6 * ref ? ["Schnäppchen!", "good"] : -v >= 1.5 * ref ? ["Zu teuer!", "bad"] : null;
    return v >= 1.5 * ref ? ["Gut verkauft!", "good"] : v <= 0.5 * ref ? ["Verschenkt!", "bad"] : null;
  };
  const pop = (p, pos) => {
    const v = net(p), vd = verdict(p);
    return `<div class="trx ${pos}"><span class="mon ${v > 0 ? "good" : v < 0 ? "bad" : ""}">${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}</span>
      ${p === T.winner ? `<span class="got"><i style="background-image:url(${img})"></i>+${T.k}</span>` : ""}
      ${vd ? `<span class="stamp ${vd[1]}">${vd[0]}</span>` : ""}</div>`;
  };
  const ov = el("div", "rules-ov trv-ov", `<div class="panel trv">
    <h2>Moment ${k + 1}</h2>
    <div class="trtitle">${T.c === 0 ? `Du forderst ${T.tName} heraus` : `${T.cName} fordert ${T.t === 0 ? "dich" : T.tName} heraus`}: <b>${T.k}× ${T.animal}</b></div>
    <div class="tr-stage" style="--win:${T.winner === bot ? 1 : -1}">
      <div class="trp top">${avatarHTML(top)}<b>${name(top)}</b>${top === T.c ? '<span class="role">fordert heraus</span>' : ""}</div>
      <div class="trp bot">${avatarHTML(bot)}<b>${name(bot)}</b>${bot === T.c ? '<span class="role">fordert heraus</span>' : ""}</div>
      <div class="trrow"><div class="trg">${cards("b")}</div><div class="trg">${cards("t")}</div></div>
      ${stack(top, "top")}${stack(bot, "bot")}
      <div class="trd num">${diff}</div>
      ${pop(top, "top")}${pop(bot, "bot")}
    </div>
    <div class="trres">${res}${m.detail ? `<div class="muted">${m.detail}</div>` : ""}${m.conseq.map((c) => `<div class="mcq">★ ${c}</div>`).join("")}</div>
    ${bars}
    <div class="btns" style="margin-top:12px"><button class="btn small" id="tr-again">⟲ Nochmal</button><button class="btn primary small" id="tr-close">Schließen</button></div>
  </div>`);
  document.body.appendChild(ov);
  const close = () => { ov.remove(); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector("#tr-close").onclick = close;
  ov.querySelector("#tr-again").onclick = () => { close(); showTradeReplay(S, k); };
  // Ablauf
  const st = ov.querySelector(".tr-stage");
  const at = (ms, fn) => setTimeout(() => { if (ov.isConnected) fn(); }, ms);
  const countUp = (el, to) => {
    const t0 = performance.now();
    const tick = (t) => { const f = Math.min(1, (t - t0) / 700); el.textContent = Math.round(to * f); if (f < 1 && ov.isConnected) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  at(250, () => st.classList.add("s-cards"));
  at(1100, () => st.querySelector(`.trs[data-p="${T.c}"]`).classList.add("in"));
  at(1900, () => {
    const g = st.querySelector(`.trs[data-p="${T.t}"]`);
    if (!T.accepted) g.classList.add("in");
    else { g.classList.add("acc"); g.querySelector(".trv").textContent = "nimmt an"; }
  });
  at(2900, () => st.querySelectorAll(".trs.in .trv").forEach((v) => { v.classList.add("on"); countUp(v, +v.dataset.v); }));
  at(4000, () => st.classList.add("s-diff"));
  at(5100, () => {
    // Geld: Gegengebot -> Stapel tauschen (Gleichstand: jeder behält seinen), angenommen -> Stapel zum Herausgeforderten
    if (T.accepted) st.querySelector(`.trs[data-p="${T.c}"]`).classList.add(T.c === top ? "to-bot" : "to-top");
    else if (!T.tie) { st.querySelector(".trs.top").classList.add("to-bot"); st.querySelector(".trs.bot").classList.add("to-top"); }
  });
  at(5900, () => st.classList.add("s-win"));
  at(6500, () => st.classList.add("s-pop"));
  at(6900, () => {
    ov.querySelector(".trres").classList.add("on");
    growChances(ov);
  });
}

function fit() {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const port = vh > vw * 1.15;
  const phl = !port && vh < 560;          // Handy quer (oder sehr niedriges Fenster)
  const next = port ? LAYOUT.port : phl ? LAYOUT.phl : LAYOUT.land;
  // am Handy wächst der Tisch mit dem Seitenverhältnis des Bildschirms
  if (port) next.h = Math.round(Math.min(1240, Math.max(960, (next.w * vh) / vw)));
  if (phl) next.h = Math.round(Math.min(600, Math.max(440, (next.w * vh) / vw)));
  const changed = next !== L || $("#stage").style.height !== `${next.h}px`;
  L = next;
  document.body.classList.toggle("portrait", port);
  document.body.classList.toggle("phland", phl);
  document.body.classList.toggle("compact", port || phl);
  const st = $("#stage");
  st.style.width = `${L.w}px`;
  st.style.height = `${L.h}px`;
  const s = port || phl ? Math.min(vw / L.w, vh / L.h) : Math.min(vw / 1620, vh / 920);
  st.style.transform = `translate(-50%, -50%) scale(${s})`;
  if (changed && V && V.phase !== "none") {
    unfocusSeat();
    $("#seats").dataset.players = "";   // Sitze neu anordnen
    render();
  }
}
fit();
window.addEventListener("resize", () => { fit(); placeBanner(); });
// Eigenes Tischbild für hochkant (assets/web/tisch_hochkant.webp), sonst wird das Querbild umgebaut
{
  const img = new Image();
  img.onload = () => document.body.classList.add("felt-port");
  img.src = `${A}tisch_hochkant.webp`;
}
// Die Seite ist ein Spieltisch, kein Dokument: Zoomen per Zwei-Finger-Geste und Doppeltippen verhindern
// (das Neuzeichnen der großen, skalierten Bühne ließ die Seite beim Zoomen weiß werden).
["gesturestart", "gesturechange"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
api("/api/takeover", {}).then((v) => {
  if (v && v.phase !== "none" && v.phase !== "over") {
    $("#overlay").classList.remove("show");
    accept(v);
  }
});
