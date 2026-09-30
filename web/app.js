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
  const prev = V;
  const events = view.events.filter((e) => e.i >= since);
  const flights = prev && events.length < 25 ? planFlights(prev, events) : [];
  if (events.some((e) => ["sold", "bought", "free"].includes(e.kind)) && events.length < 25) {
    revealHoldUntil = Date.now() + FLY_MS + REVEAL_PAUSE;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(render, FLY_MS + REVEAL_PAUSE + 20);
  }
  V = view;
  for (const ev of events) handleEvent(ev);
  since = view.event_count;
  render();
  runFlights(flights);
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
  const groups = [];
  shownAnimals(p).forEach((c, a) => { if (c) groups.push([a, c]); });
  const DX = 10;
  const perRow = Math.max(1, Math.ceil(groups.length / rows));
  let animals = "";
  let boxW = 0;
  const usedRows = Math.max(1, Math.ceil(groups.length / perRow));
  for (let r = 0; r < usedRows; r++) {
    const rowGroups = groups.slice(r * perRow, (r + 1) * perRow);
    const widths = rowGroups.map(([, c]) => groupWidth(c, OPP.w, DX));
    const { xs, width: rw } = packPositions(widths, width, 8);
    boxW = Math.max(boxW, rw);
    rowGroups.forEach(([a, c], gi) => {
      const dx = groupDX(c, DX);
      let cards = "";
      for (let i = 0; i < c; i++) cards += `<div class="card opp" style="left:${i * dx}px;bottom:${c === 4 ? i : i * 3}px;background-image:url(${tierImg(animalKey(a))})"></div>`;
      const pick = pickable.has(a);
      animals += `<div class="ogroup${c === 4 ? " full" : ""}${pick ? " pick" : ""}" data-a="${a}"
        style="left:${xs[gi]}px;top:${r * ROW_STEP}px;width:${widths[gi]}px;z-index:${r * 20 + gi + 1}"
        title="${V.animals[a].name} · ${V.animals[a].value} · ${c === 4 ? "Quartett komplett" : `${c}/4`}${pick ? " – klicken zum Herausfordern" : ""}">${cards}<span class="cnt">${c === 4 ? "✓" : c}</span></div>`;
    });
  }
  const h = OPP.h + (usedRows - 1) * ROW_STEP + 8;
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
    seat.style.left = `${x}px`;
    seat.style.top = `${y}px`;
    seat.style.width = `${w}px`;
    seat.classList.toggle("active", V.to_act === p);
    seat.classList.toggle("spot", !!(V.auction && V.phase === "auction" && V.auction.auctioneer === p));
    seat.classList.toggle("rside", x > 1200);
    const html = seatHTML(p, w, rows);
    if (seat.dataset.html !== html) {
      seat.dataset.html = html;
      seat.innerHTML = html;
      seat.querySelectorAll(".ogroup.pick").forEach((g) => (g.onclick = () => act({ kind: "challenge", target: p, animal: +g.dataset.a })));
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
    else rev.innerHTML = `<div class="flip in"><div class="face b"></div><div class="face f" style="background-image:url(${tierImg(animalKey(shown))})"></div></div>`;
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
  idx.forEach((i, k) => {
    const avail = notes[i] - selected[i];
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
      if (active) pop.onclick = (e) => { e.stopPropagation(); act({ kind: "challenge", target: q, animal: a }); };
    }
    box.appendChild(pop);
  });
  return box;
}

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
    if (selectMode !== "offer") { selectMode = "offer"; renderWallet(); renderOfferPile(); }
    box.innerHTML = `<h4>Verdecktes Gebot für ${t.k}× ${V.animals[t.animal].name} von ${nameOf(t.target)}</h4>
      <div>${cardsLabel(notesCount(selected))} · Wert <span class="num" style="font-size:20px">${notesSum(selected)}</span></div>
      <div class="btns" style="margin-top:10px"><button class="btn primary" id="go">${zeroGo()}</button></div>
      ${overWarn(selected)}
      <div class="hint">${nameOf(t.target)} sieht nur die Anzahl deiner Karten.</div>`;
    $("#go").onclick = () => zeroSubmit("offer");
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
    <div class="btns" style="margin-top:10px"><button class="btn primary" id="go">${zeroGo("Gegengebot legen")}</button><button class="btn small" id="back">Zurück</button></div>
    ${overWarn(selected)}`;
  $("#go").onclick = () => zeroSubmit("counter");
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
      if (dest) dest.style.visibility = "";
      if (f.badge) {
        const left = pendingBadges.get(f.badge) - 1;
        pendingBadges.set(f.badge, left);
        if (left <= 0) f.badge.style.visibility = "";
      }
      c.remove();
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
  $("#log-list").appendChild(li);
  $("#log-list").scrollTop = 1e9;

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
function banner(title, text, bad, secs = 2.1) {
  const b = $("#banner");
  b.className = bad ? "bad" : "";
  b.style.animationDuration = `${secs}s`;
  b.innerHTML = `<div class="t">${title}</div><div class="d">${text}</div>`;
  void b.offsetWidth;
  b.classList.add("show");
}

// --------------------------------------------------------------- Start / Ende / Menü
let nPlayers = 4;
let opponents = "ai";
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
  segment("#in-opp", "o", (v) => (opponents = v));
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
    accept(await api("/api/new", { players: nPlayers, name: $("#in-name").value.trim() || "Du", opponents }));
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
  const rows = V.ranking.map((p, i) => `<div class="r ${i === 0 ? "win" : ""}">
      <span>${i === 0 ? "🏆" : `${i + 1}.`} ${V.players[p].name}</span>
      <span><span class="num">${V.scores[p]}</span> Pkt · 💰 ${V.cash_all[p]}</span></div>`).join("");
  ov.innerHTML = `<div class="panel"><h1>${V.ranking[0] === V.me ? "Gewonnen!" : "Spielende"}</h1>
    <p class="sub">Quartettwert × Anzahl Quartette</p>
    <div class="results">${rows}</div><button class="big" id="again">Nochmal spielen</button></div>`;
  $("#again").onclick = showStart;
  setTimeout(() => ov.classList.add("show"), 1800);
}

function fit() {
  const s = Math.min(innerWidth / 1620, innerHeight / 920);
  $("#stage").style.transform = `translate(-50%, -50%) scale(${s})`;
}
fit();
window.addEventListener("resize", fit);
api("/api/takeover", {}).then((v) => {
  if (v && v.phase !== "none" && v.phase !== "over") {
    $("#overlay").classList.remove("show");
    accept(v);
  }
});
