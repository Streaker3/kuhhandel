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
const OWN = { w: 110, h: 165 }, OPP = { w: 84, h: 126 };

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
let bidKey = "";         // ändert sich mit Karte/Wiederholung/Mindestgebot -> Gebotsfeld zurücksetzen
let botTimer = null;
let busy = false;
let bidHistory = [];       // Gebote der laufenden Versteigerung
let lastBubble = {};       // p -> zuletzt angezeigte Sprechblase (für Animation nur bei Änderung)
let lastAmount = null;
let revealHoldUntil = 0;   // nach einem Verkauf: nächste Karte erst nach Flug + kurzer Pause aufdecken
let holdTimer = null;
const REVEAL_PAUSE = 500;

// --------------------------------------------------------------- API
const CLIENT = Math.random().toString(36).slice(2); // dieser Tab
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify({ ...body, since, client: CLIENT }) : undefined,
  });
  const j = await r.json();
  if (j.error === "other_tab") { showOtherTab(); return null; }
  if (j.error) {
    // Ansicht war veraltet (z. B. anderer Tab) -> neu synchronisieren statt hängen zu bleiben
    panelErr = j.error;
    panelErrUntil = Date.now() + 4000;
    resync();
    return null;
  }
  return j;
}
async function resync() {
  clearTimeout(botTimer);
  const r = await fetch(`/api/state?since=${since}`);
  const v = await r.json();
  if (v && v.phase && v.phase !== "none") { busy = false; accept(v); }
}
function showOtherTab() {
  clearTimeout(botTimer);
  const ov = $("#overlay");
  ov.innerHTML = `<div class="panel"><h1 style="font-size:40px">Anderer Tab</h1>
    <p class="sub">Das Spiel wird gerade in einem anderen Browser-Tab gesteuert.</p>
    <button class="big" id="takeover">Hier weiterspielen</button></div>`;
  ov.classList.add("show");
  $("#takeover").onclick = async () => {
    const v = await api("/api/takeover", {});
    $("#overlay").classList.remove("show");
    if (v && v.phase !== "none") accept(v);
  };
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
  if (prev && events.length < 25) quartetMoments(prev);
  if (V.phase === "trade" && !V.trade && V.to_act !== null && V.to_act !== lastTurnP) {
    if (prev && prev.phase === "trade") setTimeout(() => spotlightTurn(lastTurnP, V.to_act), 700);
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
  img.src = `${A}avatar_${k}.webp`;
});
const GAVEL = `<svg class="gavel" viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-38 14 13)">
  <rect x="4" y="5" width="18" height="9" rx="2.5" fill="#f5c542" stroke="#3d2614" stroke-width="2.2"/>
  <rect x="3" y="6.5" width="3" height="6" rx="1" fill="#d9a41f" stroke="#3d2614" stroke-width="1.6"/>
  <rect x="20" y="6.5" width="3" height="6" rx="1" fill="#d9a41f" stroke="#3d2614" stroke-width="1.6"/>
  <rect x="11" y="14" width="4" height="15" rx="1.6" fill="#a86f38" stroke="#3d2614" stroke-width="2"/></g>
  <rect x="17" y="25.5" width="13" height="4.5" rx="1.6" fill="#a86f38" stroke="#3d2614" stroke-width="2"/></svg>`;

function avatarHTML(p) {
  const k = AVATAR_KEY[p % AVATAR_KEY.length];
  if (avatarOk[k]) return `<div class="avatar" style="background-image:url(${A}avatar_${k}.webp);background-size:128%;background-position:50% 28%"></div>`;
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

// Sitzpositionen der Gegner [Mitte x, Oberkante y, Breite] je Anzahl Gegner
const SEAT_POS = {
  1: [[800, 62, 440, 1]],
  2: [[600, 62, 320, 1], [1000, 62, 320, 1]],
  3: [[215, 120, 250, 2], [800, 62, 340, 1], [1385, 120, 250, 2]],
  4: [[215, 120, 250, 2], [600, 62, 300, 1], [1000, 62, 300, 1], [1385, 120, 250, 2]],
};
const MONEY_FAN = [0, 2, 3, 5, 7, 9]; // grobe Stapelgröße -> gezeigte Rückseiten (nicht exakt)
const ROW_STEP = 88;                 // vertikaler Abstand zweier Kartenreihen bei seitlichen Gegnern

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
  const W = wide ? (rows === 1 ? 760 : 470) : w;
  const lay = seatLayout(p, W, rows, wide ? 16 : 8);
  // im Tisch bleiben
  const cx = Math.min(Math.max(x, 70 + W / 2), 1530 - W / 2);
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
  const s = st.width / 1600;
  const d = $("#dim");
  const geo = (r) => ({
    cx: (r.left + r.width / 2 - st.left) / s, cy: (r.top + r.height / 2 - st.top) / s,
    rx: Math.max(170, r.width / s / 2 + 90), ry: Math.max(130, r.height / s / 2 + 70),
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
function spotlightCard() {
  const au = V.auction;
  const now = au ? au.auctioneer : null;
  const prevA = lastAuctioneer;
  lastAuctioneer = now;
  if (FAST || speed === 2 || focusP !== null || now === null) return;
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
    dimTimer = setTimeout(() => { undim(); setTimeout(() => $("#dim").classList.remove("soft"), 400); }, 1500);
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
  const DX = 10;
  const perRow = Math.max(1, Math.ceil(groups.length / rows));
  const usedRows = Math.max(1, Math.ceil(groups.length / perRow));
  const pos = {};
  let boxW = 0;
  for (let r = 0; r < usedRows; r++) {
    const rowGroups = groups.slice(r * perRow, (r + 1) * perRow);
    const widths = rowGroups.map(([, c]) => groupWidth(c, OPP.w, DX));
    const { xs, width: rw } = packPositions(widths, width, gap);
    boxW = Math.max(boxW, rw);
    rowGroups.forEach(([a], gi) => { pos[a] = { left: xs[gi], top: r * ROW_STEP, width: widths[gi], z: r * 20 + gi + 1 }; });
  }
  return { groups, pos, boxW, h: OPP.h + (usedRows - 1) * ROW_STEP + 8 };
}

function seatHTML(p, width, rows) {
  const P = V.players[p];
  const revealed = P.revealed !== undefined ? ` · <span title="nach Zahlungsunfähigkeit offengelegt">💰${P.revealed}</span>` : "";
  // Geld: kleiner Fächer aus Rückseiten, Anzahl nur grob
  const k = MONEY_FAN[P.stack];
  let money = "";
  for (let i = 0; i < k; i++) {
    money += `<div class="card mback" style="width:40px;height:60px;left:${i * 5}px;bottom:0;transform:rotate(${(i - (k - 1) / 2) * 4}deg)"></div>`;
  }
  const moneyBox = `<div class="mini-money" style="width:${k ? 40 + 5 * (k - 1) : 40}px" title="Geld (nur grob sichtbar)">${money || '<span class="broke">pleite</span>'}</div>`;
  // Tiere: pro Art ein Stapel, bei seitlichen Gegnern auf zwei Reihen verteilt
  const pickable = new Set((V.options || []).filter((o) => o.target === p).map((o) => o.animal));
  const { groups, pos, boxW, h } = seatLayout(p, width, rows);
  const DX = 10;
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
  const pos = SEAT_POS[V.n - 1];
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
    seat.classList.toggle("spot", !!(V.auction && V.phase === "auction" && V.auction.auctioneer === p));
    seat.classList.toggle("rside", x > 1200);
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
      rev.innerHTML = `<div class="flip in"><div class="face b"></div><div class="face f" style="background-image:url(${tierImg(animalKey(shown))})"></div></div>`;
      spotlightCard();
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
    const x = i * 30 + side * 26;
    const r = (i - (n - 1) / 2) * 5;
    cards += `<div class="card mid tcard" style="left:${x}px;top:${Math.abs(r) * 0.8}px;transform:rotate(${r}deg);background-image:url(${img})"></div>`;
  }
  const w = (n - 1) * 30 + 26;
  return `<div class="tcards">${cards}
    <span class="tname l">${nameOf(t.challenger)}</span>
    <span class="tname r" style="left:${w}px">${nameOf(t.target)}</span></div>`;
}

function renderTopButtons() {
  $("#m-skip").style.display = V.phase === "auction" ? "" : "none";
  $("#stage").classList.toggle("p2", V.phase !== "auction");
}

function renderMePlate() {
  const P = V.players[V.me];
  const plate = $("#me-plate");
  plate.className = (V.to_act === V.me ? "active" : "") + (V.auction && V.phase === "auction" && V.auction.auctioneer === V.me ? " spot" : "");
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
  const { xs } = packPositions(idx.map(() => OWN.w), V.phase === "trade" ? 470 : 460, 12);
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
      s.appendChild(Object.assign(el("div", "card own"), {
        style: `left:${j * 2}px;bottom:${j * 3}px;background-image:url(${geldImg(d)})`,
      }));
    }
    s.appendChild(el("span", "cnt", `×${avail}`));
    s.title = `${avail}× ${d}`;
    if (selectMode && avail) s.onclick = () => { selected[i]++; render(); };
    w.appendChild(s);
  });
}

function renderOfferPile() {
  const box = $("#offer-pile");
  box.classList.toggle("show", !!selectMode);
  if (!selectMode) { box.innerHTML = ""; return; }
  const list = [];
  selected.forEach((c, i) => { for (let k = 0; k < c; k++) list.push(i); });
  const sum = list.reduce((s, i) => s + V.denoms[i], 0);
  box.innerHTML = `<span class="title">${selectMode === "offer" ? "Dein Gebot" : "Dein Gegengebot"}: ${list.length} Karte${list.length === 1 ? "" : "n"} · Wert <b>${sum}</b> <span style="opacity:.75">(Karte anklicken = zurücklegen)</span></span>`;
  if (!list.length) {
    box.innerHTML += `<div class="empty-hint">⬇ Klicke unten auf deine Geldstapel, um Karten hierher zu legen.</div>`;
    return;
  }
  const step = list.length > 1 ? Math.min(60, (460 - OWN.w) / (list.length - 1)) : 0;
  list.forEach((i, k) => {
    const c = el("div", "card own");
    c.style.cssText = `left:${k * step}px;top:24px;background-image:url(${geldImg(V.denoms[i])});transform:rotate(${(k - (list.length - 1) / 2) * 2}deg);z-index:${k + 1}`;
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
  const CW = p2 ? 124 : OWN.w, CH = p2 ? 186 : OWN.h;
  const DX = 16, DY = 8, W = p2 ? 500 : 480;
  const groups = [];
  shownAnimals(V.me).forEach((c, a) => { if (c) groups.push([a, c]); });
  hand.style.width = `${W}px`;
  if (!groups.length) { hand.innerHTML = `<div class="hand-empty">Noch keine Tierkarten</div>`; return; }
  const options = V.options || [];
  const pickAnimals = new Set(options.map((o) => o.animal));
  const target = V.trade && V.trade.target === V.me ? V.trade.animal : null;
  const widths = groups.map(([, c]) => groupWidth(c, CW, DX));
  const { xs, width } = packPositions(widths, W, p2 ? 22 : 14);
  const x0 = W - width; // rechtsbündig
  groups.forEach(([a, c], gi) => {
    const full = c === 4;
    const g = el("div", "hgroup" + (full ? " full" : "") + (pickAnimals.has(a) ? " pick" : "") + (target === a ? " target" : ""));
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
      const pops = popsFor(a, c, options);
      const cx = 1600 - 70 - W + left + widths[gi] / 2;   // Mitte der Gruppe in Bühnenkoordinaten
      const reach = 175;
      const shift = Math.min(0, 1530 - (cx + reach)) + Math.max(0, 70 - (cx - reach));
      pops.style.setProperty("--shift", `${shift}px`);
      g.appendChild(pops);
    } else if (!full && c > 1) {
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
function popsFor(a, c, options) {
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
    const ang = items.length > 1 ? -((items.length - 1) * spread) / 2 + i * spread : 0;
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
      if (active) pop.onclick = (e) => { e.stopPropagation(); unfocusSeat(); act({ kind: "challenge", target: q, animal: a }); };
      pop.onmouseenter = () => focusSeat(q);
      pop.onmouseleave = () => unfocusSeat();
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
function zeroGo(label = "Verdeckt hinlegen") {
  if (notesCount(selected) > 0) { zeroConfirm = false; return label; }
  return zeroConfirm ? "Wirklich mit 0 Karten? Nochmal klicken" : label;
}
function zeroSubmit(kind) {
  if (notesCount(selected) === 0 && !zeroConfirm) { zeroConfirm = true; renderActions(); return; }
  zeroConfirm = false;
  act({ kind, notes: selected });
}
const notesSum = (c) => c.reduce((s, x, i) => s + x * V.denoms[i], 0);
const notesCount = (c) => c.reduce((s, x) => s + x, 0);

// Spielerschild sitzt immer direkt auf dem Aktionsfeld – auch wenn es beim Tippen wächst
const placePlate = () => { $("#me-plate").style.bottom = `${58 + $("#actions").offsetHeight - 8}px`; };
new ResizeObserver(placePlate).observe($("#actions"));

let keyHandler = null;
document.addEventListener("keydown", (e) => {
  const menuOpen = $("#menu").classList.contains("open") || $("#log").classList.contains("open");
  if (keyHandler && !menuOpen && !$("#overlay").classList.contains("show")) keyHandler(e);
});
let zeroConfirm = false;   // Gebot mit 0 Karten muss bestätigt werden
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
  if (mine && V.phase === "auction" && Date.now() < revealHoldUntil) {
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
    return;
  }
  const au = V.auction;
  if (V.phase === "auction" && au.stage === "bidding") {
    const min = au.min_bid;
    const key = `${au.card}-${V.deck_left}-${au.excluded.length}-${min}`;
    const fresh = key !== bidKey;
    if (fresh) { bidKey = key; bidValue = min; }
    const context = au.high === null ? "Noch kein Gebot"
      : `Höchstgebot <b class="num">${au.amount}</b> · 👑 ${nameOf(au.high)}`;
    const redo = au.excluded.length ? `<div class="ctx redo">🔁 Wiederholung – ${au.excluded.map(nameOf).join(", ")} ausgeschlossen</div>` : "";
    const quick = [["Min", min], ["+50", min + 40], ["+100", min + 90], ["Limit", V.cap]]
      .filter(([, x], i, arr) => arr.findIndex(([, y]) => y === x) === i);
    box.innerHTML = `
      <h4>Dein Gebot für ${V.animals[au.card].name} <span class="ctx">· ${context}</span></h4>${redo}
      <div class="btns bidrow">
        <button class="btn small" id="bm">−10</button>
        <input class="bid-input" id="bv" type="text" inputmode="numeric" value="${bidValue}" autocomplete="off">
        <button class="btn small" id="bp">+10</button>
        <button class="btn primary" id="bgo" title="Enter">Bieten</button>
        <button class="btn danger" id="bpass" title="Esc">Passen</button>
      </div>
      <div class="btns quick">${quick.map(([l, q]) => `<button class="btn small" data-q="${q}" ${q > V.cap ? "disabled" : ""}>${l} <b class="num">${q}</b></button>`).join("")}</div>
      <div class="hint" id="bhint"></div>`;
    const input = $("#bv");
    const valid = () => Number.isInteger(bidValue) && bidValue % 10 === 0 && bidValue >= min && bidValue <= V.cap;
    const upd = (fromInput) => {
      if (!fromInput) input.value = bidValue;
      const h = $("#bhint");
      const go = $("#bgo");
      let msg = "";
      let cls = "hint";
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
    };
    const submit = () => { if (valid()) act({ kind: "bid", amount: bidValue }); };
    upd();
    $("#bm").onclick = () => { bidValue = Math.max(min, Math.ceil(bidValue / 10) * 10 - 10); upd(); };
    $("#bp").onclick = () => { bidValue = Math.min(V.cap, Math.floor(bidValue / 10) * 10 + 10); upd(); };
    input.oninput = () => { bidValue = parseInt(input.value.replace(/\D/g, ""), 10) || 0; upd(true); };
    box.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { bidValue = +b.dataset.q; upd(); input.focus(); }));
    $("#bgo").onclick = submit;
    $("#bpass").onclick = () => act({ kind: "pass" });
    keyHandler = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); act({ kind: "pass" }); }
      else if (e.key === "ArrowUp") { e.preventDefault(); $("#bp").click(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); $("#bm").click(); }
    };
    if (fresh || document.activeElement === document.body) { input.focus(); input.select(); }
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
      <div class="hint">Über eine deiner Karten fahren oder eine ⚔-Karte beim Gegner anklicken.</div>`;
    return;
  }
  const t = V.trade;
  const quartet = V.animals[t.animal].value;
  const overWarn = (s) => (notesSum(s) > quartet ? `<div class="hint warn">Achtung: mehr als der ganze Quartettwert (${quartet})!</div>` : "");
  if (t.stage === "offer") {
    if (selectMode !== "offer") { selectMode = "offer"; selected = [0, 0, 0, 0, 0, 0]; renderWallet(); renderOfferPile(); }
    box.innerHTML = `<h4>Verdecktes Gebot für ${t.k}× ${V.animals[t.animal].name} von ${nameOf(t.target)}</h4>
      <div>${cardsLabel(notesCount(selected))} · Wert <span class="num" style="font-size:20px">${notesSum(selected)}</span></div>
      ${QUICK_HTML}
      <div class="btns" style="margin-top:8px"><button class="btn primary" id="go">${zeroGo()}</button></div>
      ${overWarn(selected)}
      <div class="hint">${nameOf(t.target)} sieht nur die Anzahl deiner Karten.</div>`;
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
    <div>${cardsLabel(notesCount(selected))} · Wert <span class="num" style="font-size:20px">${notesSum(selected)}</span></div>
    ${QUICK_HTML}
    <div class="btns" style="margin-top:8px"><button class="btn primary" id="go">${zeroGo("Gegengebot legen")}</button><button class="btn small" id="back">Zurück</button></div>
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
const stageScale = () => $("#stage").getBoundingClientRect().width / 1600;

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
      const center = [...document.querySelectorAll("#revealed .tcard")];
      const froms = center.length ? center.map(cardGeom) : topCardGeoms(ev.loser, ev.animal, ev.k);
      froms.forEach((from, i) => out.push({ img: tierImg(prev.animals[ev.animal].key), from,
        to: { p: ev.winner, animal: ev.animal }, delay: 250 + i * 120 }));
    }
  }
  return out;
}

/** Nach dem Neuzeichnen: Zielkarten verstecken und die Stellvertreter fliegen lassen. */
function runFlights(flights) {
  const taken = new Map(); // Gruppe -> bereits vergebene Zielkarten
  const pendingBadges = new Map();
  for (const f of flights) {
    let dest = null, to = null;
    if (f.to.center) {
      dest = document.querySelectorAll("#revealed .tcard")[f.to.idx] || null;
    } else if (f.to.stack) {
      to = rectGeom($("#tstack").getBoundingClientRect(), 64 * stageScale(), 96 * stageScale());
    } else if (f.to.money) {
      const r = moneyRect(f.to.p);
      if (r) to = rectGeom(r, 40 * stageScale(), 60 * stageScale());
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

    const { cx, cy, w, h, rot } = f.money ? { ...f.from, w: 40 * stageScale(), h: 60 * stageScale(), rot: 0 } : f.from;
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
  const snd = { reveal: "flip", bid: "tick", sold: "sold", bought: "sold", free: "gavel", bust: "bust",
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
  w.style.left = `${r.left + r.width / 2}px`;
  w.style.top = `${r.top + r.height * (380 / 900)}px`;
  w.style.transform = `translate(-50%, -50%) scale(${r.width / 1600})`;
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
function quartetMoments(prev) {
  let delay = 900;
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
  const s = $("#stage").getBoundingClientRect().width / 1600;
  const pop = el("div", "scorepop num", text);
  Object.assign(pop.style, { left: `${r.left + r.width / 2}px`, top: `${r.top}px`, fontSize: `${40 * s}px` });
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
    <li>Bezahlt wird mit Geldkarten, <b>ohne Wechselgeld</b>.</li>
    <li>Bei jedem Esel bekommt jeder einen Bonus: 50, 100, 200, 500.</li>
  </ul>
  <h3>Phase 2 – Kuhhandel</h3>
  <ul>
    <li>Wer dran ist, fordert jemanden heraus, der dieselbe Tierart (unvollständig) hat. Haben beide mindestens 2, geht es um 2 Karten, sonst um 1.</li>
    <li>Der Herausforderer legt verdeckt Geldkarten hin – der Gegner sieht nur die Anzahl.</li>
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
let level = "mittel";
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
  fetch("/api/info").then((r) => r.json()).then((info) => {
    if (!info.ai_available) {
      $("#ai-note").textContent = "Noch keine trainierte KI gefunden – es spielen die einfachen Bots.";
      document.querySelector('#in-opp [data-o="heuristic"]').click();
    } else {
      $("#ai-note").textContent = "Trainierte KI-Gegner";
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
segment("#m-speed", "s", (v) => {
  speed = +v;
  try { localStorage.setItem("kh-speed", speed); } catch (e) { /* egal */ }
});
document.querySelector(`#m-speed [data-s="${speed}"]`).classList.add("on");
$("#m-log").onclick = () => { closeMenu(); $("#log").classList.add("open"); };
$("#m-rules").onclick = () => { closeMenu(); showRules(); };
const updSound = () => { $("#m-sound").textContent = Snd.on ? "🔊 Ton an" : "🔇 Ton aus"; };
$("#m-sound").onclick = () => {
  Snd.on = !Snd.on;
  try { localStorage.setItem("kh-sound", Snd.on ? "1" : "0"); } catch (e) { /* egal */ }
  updSound();
  if (Snd.on) Snd.play("coins");
};
updSound();
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
    <div class="results">${rows}</div><button class="big" id="again">Nochmal spielen</button></div>`;
  $("#again").onclick = showStart;
  setTimeout(() => {
    ov.classList.add("show");
    if (V.ranking[0] === V.me) confetti();
  }, 1800);
}

function fit() {
  const s = Math.min(innerWidth / 1620, innerHeight / 920);
  $("#stage").style.transform = `translate(-50%, -50%) scale(${s})`;
}
fit();
window.addEventListener("resize", () => { fit(); placeBanner(); });
api("/api/takeover", {}).then((v) => {
  if (v && v.phase !== "none" && v.phase !== "over") {
    $("#overlay").classList.remove("show");
    accept(v);
  }
});
