"use strict";

const EMOJI = {
  pferd: "🐴", kuh: "🐄", schwein: "🐖", esel: "🫏", ziege: "🐐",
  schaf: "🐑", hund: "🐕", katze: "🐈", gans: "🪿", hahn: "🐓",
};
const AVATARS = ["🧑‍🌾", "👵", "🧔", "👩‍🦰", "👴"];
const BILL_EMB = { 0: "🥚", 10: "🌾", 50: "🥕", 100: "🧀", 200: "🍎", 500: "🏆" };

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const FAST = location.search.includes("fast");
let V = null;            // aktuelle Ansicht vom Server
let since = 0;           // Anzahl bereits gesehener Ereignisse
let selected = new Set(); // ausgewählte Schein-Indizes (Kuhhandel)
let selectMode = null;   // "offer" | "counter" | null
let bidValue = 0;
let botTimer = null;
let busy = false;
const imgOk = {};
const moneyImg = {};  // Stückelung -> true, wenn assets/money/<d>.png existiert        // key -> true, wenn assets/cards/<key>.png existiert

// --------------------------------------------------------------- Assets
function probe(src) {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res(true);
    i.onerror = () => res(false);
    i.src = src;
  });
}
async function loadAssets() {
  await Promise.all(Object.keys(EMOJI).map(async (k) => {
    imgOk[k] = await probe(`assets/cards/${k}.png`);
  }));
  await Promise.all([0, 10, 50, 100, 200, 500].map(async (d) => {
    moneyImg[d] = await probe(`assets/money/${d}.png`);
  }));
  if (await probe("assets/card_back.png")) document.body.classList.add("img-back");
  if (await probe("assets/table.png")) $("#felt").classList.add("img");
}

// --------------------------------------------------------------- API
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify({ ...body, since }) : undefined,
  });
  const j = await r.json();
  if (j.error) { toast("⚠️ " + j.error); return null; }
  return j;
}

function accept(view) {
  if (!view) return;
  V = view;
  for (const ev of view.events) {
    if (ev.i < since) continue;
    logEvent(ev);
  }
  since = view.event_count;
  render();
  scheduleBot(view.events);
}

function scheduleBot(events) {
  clearTimeout(botTimer);
  if (!V || !V.bot_turn) return;
  const pause = events.some((e) => ["sold", "bought", "free", "bust", "trade_result", "donkey", "phase"].includes(e.kind));
  const delay = FAST ? 15 : pause ? 1700 : 750;
  botTimer = setTimeout(async () => accept(await api("/api/bot_step", {})), delay);
}

async function act(action) {
  if (busy) return;
  busy = true;
  selectMode = null;
  selected.clear();
  const v = await api("/api/act", { action });
  busy = false;
  if (v) accept(v); else render();
}

// --------------------------------------------------------------- Karten
function cardHTML(a, extra = "") {
  const A = V.animals[a];
  if (imgOk[A.key]) {
    return `<div class="card has-img a-${A.key} ${extra}"><div class="art"><img src="assets/cards/${A.key}.png" alt="${A.name}"></div></div>`;
  }
  return `<div class="card a-${A.key} ${extra}">
    <span class="val">${A.value}</span><div class="art">${EMOJI[A.key]}</div></div>`;
}
function miniHTML(a, cnt, extra = "") {
  const A = V.animals[a];
  const art = imgOk[A.key] ? `<img src="assets/cards/${A.key}.png" alt="">` : EMOJI[A.key];
  return `<div class="mini ${cnt === 4 ? "full" : ""} ${extra}" title="${cnt}× ${A.name} (Quartett ${A.value})" data-a="${a}">${art}<span class="cnt">${cnt}</span></div>`;
}

// --------------------------------------------------------------- Render
function render() {
  if (!V || V.phase === "none") return;
  renderOpponents();
  renderCenter();
  renderMe();
  renderActions();
  if (V.phase === "over") showResults();
}

function badgesFor(p) {
  const out = [];
  const au = V.auction;
  if (au && V.phase === "auction") {
    if (au.auctioneer === p) out.push(`<span class="tag auct">🔨 Versteigerer</span>`);
    if (au.high === p) out.push(`<span class="tag high">👑 Höchstgebot</span>`);
    if (au.excluded.includes(p)) out.push(`<span class="tag out">ausgeschlossen</span>`);
  }
  return out.join("");
}

function bubbleFor(p) {
  const au = V.auction;
  if (!au || au.stage !== "bidding" && au.stage !== "choice") return "";
  const last = au.last[String(p)];
  if (last === undefined) return "";
  if (last === "pass") return `<div class="bubble pass">Passe</div>`;
  return `<div class="bubble ${au.high === p ? "high" : ""}">${last}</div>`;
}

function renderOpponents() {
  const box = $("#opponents");
  box.innerHTML = "";
  const pickable = new Set();
  if (V.options) for (const o of V.options) pickable.add(`${o.target}:${o.animal}`);

  for (let i = 1; i < V.n; i++) {
    const p = (V.me + i) % V.n;
    const P = V.players[p];
    const seat = el("div", "seat" + (V.to_act === p ? " active" : ""));
    const sc = scoreOf(P.animals);
    seat.innerHTML = `
      <div class="plate">
        <div class="avatar">${AVATARS[p % AVATARS.length]}</div>
        <div><div class="nm">${P.name}</div>
        <div class="sub">${P.quartets} Quartett${P.quartets === 1 ? "" : "e"} · ${sc} Pkt${P.revealed !== undefined ? ` · 💰 ${P.revealed} (offen)` : ""}</div></div>
      </div>
      ${bubbleFor(p)}
      <div class="badges">${badgesFor(p)}</div>
      <div class="seat-body">
        <div class="mini-animals"></div>
        <div><div class="pile">${pileHTML(P.stack)}</div><div class="pile-cap">Geld</div></div>
      </div>`;
    const mini = seat.querySelector(".mini-animals");
    P.animals.forEach((c, a) => {
      if (!c) return;
      const pick = pickable.has(`${p}:${a}`);
      const wrap = el("div", null, miniHTML(a, c, pick ? "pick" : ""));
      const m = wrap.firstElementChild;
      if (pick) m.onclick = () => act({ kind: "challenge", target: p, animal: a });
      mini.appendChild(m);
    });
    if (!P.animals.some((c) => c)) mini.innerHTML = `<span style="opacity:.5;font-size:12px">noch keine Tiere</span>`;
    box.appendChild(seat);
  }
}

function pileHTML(size) {
  let s = "";
  for (let i = 0; i < size * 2; i++) {
    const r = ((i * 37) % 13) - 6;
    s += `<div class="b" style="bottom:${i * 3}px;left:${(i * 7) % 6}px;transform:rotate(${r}deg)"></div>`;
  }
  return s;
}

function scoreOf(animals) {
  const full = animals.map((c, a) => (c === 4 ? V.animals[a].value : 0)).filter(Boolean);
  return full.reduce((x, y) => x + y, 0) * full.length;
}

function renderCenter() {
  $("#deck").classList.toggle("empty", V.deck_left === 0);
  $("#deck").classList.toggle("img", document.body.classList.contains("img-back"));
  $("#deck-count").textContent = V.deck_left ? `${V.deck_left} Karten · ${V.donkeys}/4 Esel` : "";
  const rev = $("#revealed");
  const hud = $("#hud");
  const au = V.auction;
  const key = au ? `${au.card}-${V.deck_left}` : "none";
  if (rev.dataset.key !== key) {
    rev.dataset.key = key;
    rev.innerHTML = au ? cardHTML(au.card) : "";
  }
  if (V.phase === "auction" && au) {
    const name = (p) => (p === V.me ? "Du" : V.players[p].name);
    hud.innerHTML = `
      <div class="row"><span class="lbl">Versteigerer</span><span class="who"><span class="tag auct">🔨 ${name(au.auctioneer)}</span></span></div>
      <div class="row" style="margin-top:4px">
        <div><div class="lbl">Höchstgebot</div><div class="amt">${au.high === null ? "–" : au.amount}</div></div>
        <div><div class="lbl">Höchstbietend</div><div class="who">${au.high === null ? "niemand" : `<span class="tag high">👑 ${name(au.high)}</span>`}</div></div>
      </div>
      ${au.excluded.length ? `<div class="row" style="margin-top:4px"><span class="lbl">Ausgeschlossen:</span> ${au.excluded.map((p) => `<span class="tag out">${name(p)}</span>`).join(" ")}</div>` : ""}
      ${au.stage === "choice" ? `<div class="row" style="margin-top:6px"><span class="lbl">${name(au.auctioneer)} entscheidet: Geld nehmen oder Vorkaufsrecht</span></div>` : ""}`;
  } else if (V.phase === "trade") {
    const t = V.trade;
    if (t) {
      const A = V.animals[t.animal];
      const name = (p) => (p === V.me ? "Du" : V.players[p].name);
      rev.innerHTML = cardHTML(t.animal);
      rev.dataset.key = "trade";
      hud.innerHTML = `
        <div class="lbl">Kuhhandel</div>
        <div class="who" style="font-size:20px;margin:4px 0">${name(t.challenger)} ⚔️ ${name(t.target)}</div>
        <div>${t.k}× ${A.name}</div>
        ${t.offer_count !== undefined ? `<div class="row" style="margin-top:6px"><div class="pile">${pileHTML(Math.min(5, Math.ceil(t.offer_count / 2)))}</div><div>${t.offer_count} Schein${t.offer_count === 1 ? "" : "e"} verdeckt${t.my_offer !== undefined ? ` (Wert ${t.my_offer})` : ""}</div></div>` : ""}`;
    } else {
      rev.innerHTML = "";
      rev.dataset.key = "";
      const cur = V.players[V.to_act];
      hud.innerHTML = `<div class="lbl">Phase 2</div><div class="who" style="font-size:20px">Kuhhandel</div>
        <div style="margin-top:4px">${V.trade_busy ? "Zwei Spieler verhandeln verdeckt…" : cur ? `${V.to_act === V.me ? "Du bist" : cur.name + " ist"} am Zug` : ""}</div>`;
    }
  } else if (V.phase === "over") {
    rev.innerHTML = "";
    hud.innerHTML = `<div class="who" style="font-size:22px">Spiel beendet</div>`;
  }
}

function renderMe() {
  const P = V.players[V.me];
  const plate = $("#me-plate");
  plate.className = V.to_act === V.me ? "active" : "";
  plate.innerHTML = `<div class="avatar">${AVATARS[V.me % AVATARS.length]}</div>
    <div><div class="nm" style="font-weight:600">${P.name}</div><div class="badges">${badgesFor(V.me)}</div></div>${bubbleFor(V.me)}`;
  renderWallet(P);
  renderHand(P);
}

function noteList(notes) {
  const list = [];
  notes.forEach((c, i) => { for (let k = 0; k < c; k++) list.push(i); });
  return list;
}

function renderWallet(P) {
  const w = $("#wallet");
  w.innerHTML = "";
  const list = noteList(P.notes);
  const width = w.offsetWidth || 400;
  const step = list.length > 1 ? Math.min(30, (width - 130) / (list.length - 1)) : 0;
  const spread = Math.min(50, list.length * 4);
  list.forEach((di, idx) => {
    const d = V.denoms[di];
    const b = moneyImg[d]
      ? el("div", "bill img", `<img src="assets/money/${d}.png" alt="${d}">`)
      : el("div", `bill d${d}`, `<span class="v s">${d}</span><span class="emb">${BILL_EMB[d]}</span><span class="v">${d}</span>`);
    const ang = list.length > 1 ? -spread / 2 + (spread * idx) / (list.length - 1) : 0;
    const sel = selected.has(idx);
    b.style.left = `${idx * step}px`;
    b.style.zIndex = idx + 1;
    b.style.transform = `rotate(${ang}deg) translateY(${sel ? -34 : 0}px)`;
    b.onmouseenter = () => { if (!selected.has(idx)) b.style.transform = `rotate(${ang}deg) translateY(-18px)`; };
    b.onmouseleave = () => { b.style.transform = `rotate(${ang}deg) translateY(${selected.has(idx) ? -34 : 0}px)`; };
    if (selectMode) {
      b.classList.add("selectable");
      if (sel) b.classList.add("sel");
      b.onclick = () => { selected.has(idx) ? selected.delete(idx) : selected.add(idx); render(); };
    }
    w.appendChild(b);
  });
  const counts = V.denoms.map((d, i) => `${P.notes[i]}×${d}`).filter((s) => !s.startsWith("0×")).join(" · ");
  $("#wallet-help").innerHTML = `
    <span class="chip">💰 Bargeld <b>${P.cash}</b></span>
    <span class="chip">${list.length} Scheine</span>
    ${V.phase === "auction" ? `<span class="chip" title="Max. Gebot = Bargeld × 2 + 100">Gebotslimit <b>${V.cap}</b></span>` : ""}
    <span class="chip" title="${counts}">Punkte jetzt <b>${scoreOf(P.animals)}</b></span>`;
}

function renderHand(P) {
  const hand = $("#hand");
  hand.innerHTML = "";
  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-w"));
  const groups = [];
  P.animals.forEach((c, a) => { if (c) groups.push([a, c]); });
  const pickAnimals = new Set((V.options || []).map((o) => o.animal));
  const DX = 16, DY = 9;
  const widths = groups.map(([, c]) => cw + (c - 1) * DX);
  const total = widths.reduce((x, y) => x + y, 0) + 12 * Math.max(0, groups.length - 1);
  const avail = hand.offsetWidth - 20;
  const overlap = groups.length > 1 && total > avail ? (total - avail) / (groups.length - 1) + 12 : -12;
  groups.forEach(([a, c], gi) => {
    const g = el("div", "group" + (c === 4 ? " full" : "") + (pickAnimals.has(a) ? " pick" : ""));
    g.style.width = `${widths[gi]}px`;
    if (gi > 0) g.style.marginLeft = `${-overlap}px`;
    g.innerHTML = `<span class="count">${c}<span class="lbl">/4 ${V.animals[a].name}${c === 4 ? " ✓" : ""}</span></span>`;
    const cardH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-h"));
    g.querySelector(".count").style.bottom = `${cardH + (c - 1) * DY - 14}px`;
    for (let i = 0; i < c; i++) {
      const w = el("div", null, cardHTML(a));
      const card = w.firstElementChild;
      card.style.left = `${i * DX}px`;
      card.style.bottom = `${i * DY}px`;
      card.style.zIndex = i;
      g.appendChild(card);
    }
    // Beim Hovern auffächern, damit jede Karte sichtbar ist
    g.onmouseenter = () => g.querySelectorAll(".card").forEach((k, i) => { k.style.transform = `translate(${i * (cw * 0.62 - DX)}px, ${-i * 4}px)`; });
    g.onmouseleave = () => g.querySelectorAll(".card").forEach((k) => { k.style.transform = ""; });
    if (pickAnimals.has(a)) g.title = "Mit dieser Tierart herausfordern";
    hand.appendChild(g);
  });
  if (!groups.length) hand.innerHTML = `<div style="opacity:.55;margin-bottom:60px">Noch keine Tierkarten</div>`;
}

function selectedNotes() {
  const counts = V.denoms.map(() => 0);
  const list = noteList(V.players[V.me].notes);
  for (const idx of selected) counts[list[idx]]++;
  return counts;
}
const notesSum = (c) => c.reduce((s, x, i) => s + x * V.denoms[i], 0);

function renderActions() {
  const box = $("#actions");
  const name = (p) => V.players[p].name;
  if (V.phase === "over") { box.innerHTML = `<h4>Spiel beendet</h4><button class="btn primary" onclick="showStart()">Neues Spiel</button>`; return; }
  if (V.to_act !== V.me) {
    selectMode = null;
    let txt = V.to_act === null ? "" : `${name(V.to_act)} ist am Zug`;
    if (V.phase === "trade" && V.trade_busy) txt = "Andere Spieler verhandeln";
    if (V.phase === "auction" && V.auction && V.auction.auctioneer === V.me) txt = `Du versteigerst · ${txt}`;
    box.innerHTML = `<div class="waiting">${txt}<span class="dots"></span></div>`;
    return;
  }
  const au = V.auction;
  const P = V.players[V.me];
  if (V.phase === "auction" && au.stage === "bidding") {
    const min = au.min_bid;
    if (bidValue < min || bidValue > V.cap) bidValue = min;
    const quick = [min, min + 40, min + 90, min + 190].filter((x, i, arr) => x <= V.cap && arr.indexOf(x) === i);
    box.innerHTML = `
      <h4>Dein Gebot für ${V.animals[au.card].name}</h4>
      <div class="btns" style="align-items:center">
        <button class="btn small" id="bm">−10</button>
        <input class="bid-input" id="bv" type="number" step="10" min="${min}" max="${V.cap}" value="${bidValue}">
        <button class="btn small" id="bp">+10</button>
        <button class="btn primary" id="bgo">Bieten</button>
        <button class="btn danger" id="bpass">Passen</button>
      </div>
      <div class="btns" style="margin-top:6px">${quick.map((q) => `<button class="btn small" data-q="${q}">${q}</button>`).join("")}</div>
      <div class="hint ${bidValue > P.cash ? "warn" : ""}" id="bhint"></div>`;
    const upd = () => {
      $("#bv").value = bidValue;
      const h = $("#bhint");
      h.className = "hint" + (bidValue > P.cash ? " warn" : "");
      h.textContent = bidValue > P.cash
        ? `Bluff! Du hast nur ${P.cash}. Nimmt der Versteigerer das Geld, fliegst du auf.`
        : `Mindestens ${min} · Limit ${V.cap}`;
    };
    upd();
    $("#bm").onclick = () => { bidValue = Math.max(min, bidValue - 10); upd(); };
    $("#bp").onclick = () => { bidValue = Math.min(V.cap, bidValue + 10); upd(); };
    $("#bv").oninput = (e) => { bidValue = Math.round((+e.target.value || min) / 10) * 10; };
    box.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { bidValue = +b.dataset.q; upd(); }));
    $("#bgo").onclick = () => act({ kind: "bid", amount: bidValue });
    $("#bpass").onclick = () => act({ kind: "pass" });
    return;
  }
  if (V.phase === "auction" && au.stage === "choice") {
    const canBuy = V.legal.includes("buy");
    box.innerHTML = `
      <h4>${name(au.high)} bietet ${au.amount} für ${V.animals[au.card].name}</h4>
      <div class="btns">
        <button class="btn primary" id="take">💰 Geld nehmen</button>
        <button class="btn" id="buy" ${canBuy ? "" : "disabled"}>✋ Vorkaufsrecht (${au.amount} zahlen)</button>
      </div>
      <div class="hint">${canBuy ? "Vorkaufsrecht: Du zahlst den Betrag und behältst die Karte." : "Für das Vorkaufsrecht reicht dein Bargeld nicht."}</div>`;
    $("#take").onclick = () => act({ kind: "take" });
    if (canBuy) $("#buy").onclick = () => act({ kind: "buy" });
    return;
  }
  if (V.phase === "trade" && !V.trade) {
    const opts = V.options || [];
    box.innerHTML = `<h4>Wen forderst du heraus?</h4>
      <div class="opt-grid">${opts.map((o, i) => `<button class="btn small" data-o="${i}">${EMOJI[V.animals[o.animal].key]} ${V.animals[o.animal].name} ↔ ${name(o.target)}</button>`).join("")}</div>
      <div class="hint">Oder klicke auf eine markierte Karte eines Gegners.</div>`;
    box.querySelectorAll("[data-o]").forEach((b) => (b.onclick = () => {
      const o = opts[+b.dataset.o];
      act({ kind: "challenge", target: o.target, animal: o.animal });
    }));
    return;
  }
  const t = V.trade;
  if (t && t.stage === "offer") {
    selectMode = "offer";
    const s = selectedNotes();
    box.innerHTML = `<h4>Dein verdecktes Gebot: ${t.k}× ${V.animals[t.animal].name} von ${name(t.target)}</h4>
      <div>Klicke Geldscheine an: <b>${s.reduce((a, b) => a + b, 0)} Scheine · Wert ${notesSum(s)}</b></div>
      <div class="btns" style="margin-top:8px"><button class="btn primary" id="go">Verdeckt hinlegen</button></div>
      <div class="hint">${name(t.target)} sieht nur die Anzahl der Scheine. 0er-Scheine eignen sich zum Bluffen.</div>`;
    $("#go").onclick = () => act({ kind: "offer", notes: selectedNotes() });
    renderWallet(P);
    return;
  }
  if (t && t.stage === "respond") {
    if (selectMode !== "counter") {
      box.innerHTML = `<h4>${name(t.challenger)} will ${t.k}× ${V.animals[t.animal].name} und legt ${t.offer_count} Schein${t.offer_count === 1 ? "" : "e"}</h4>
        <div class="btns"><button class="btn primary" id="acc">Annehmen (Geld nehmen)</button><button class="btn" id="ctr">Gegengebot</button></div>
        <div class="hint">Bei einem Gegengebot werden die Stapel getauscht, der Höhere gewinnt. Gleichstand: ${name(t.challenger)} gewinnt.</div>`;
      $("#acc").onclick = () => act({ kind: "accept" });
      $("#ctr").onclick = () => { selectMode = "counter"; selected.clear(); render(); };
      return;
    }
    const s = selectedNotes();
    box.innerHTML = `<h4>Dein Gegengebot (verdeckt)</h4>
      <div>Ausgewählt: <b>${s.reduce((a, b) => a + b, 0)} Scheine · Wert ${notesSum(s)}</b></div>
      <div class="btns" style="margin-top:8px"><button class="btn primary" id="go">Gegengebot legen</button><button class="btn small" id="back">Zurück</button></div>`;
    $("#go").onclick = () => act({ kind: "counter", notes: selectedNotes() });
    $("#back").onclick = () => { selectMode = null; selected.clear(); render(); };
    renderWallet(P);
  }
}

// --------------------------------------------------------------- Log & Toasts
function logEvent(ev) {
  const li = el("li", null, ev.text);
  $("#log-list").appendChild(li);
  $("#log").scrollTop = 1e9;
  const important = ["reveal", "donkey", "sold", "bought", "free", "bust", "trade_result", "phase", "challenge", "offer", "over"];
  if (important.includes(ev.kind)) toast(ev.text, ["donkey", "bust", "phase", "over"].includes(ev.kind));
}
function toast(text, gold) {
  const t = el("div", "toast" + (gold ? " gold" : ""), text);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 3300);
  while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
}

// --------------------------------------------------------------- Start / Ende
let nPlayers = 4;
document.querySelectorAll("#in-players button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("#in-players button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  nPlayers = +b.dataset.n;
}));
$("#btn-start").onclick = async () => {
  since = 0;
  $("#log-list").innerHTML = "";
  $("#overlay").classList.remove("show");
  accept(await api("/api/new", { players: nPlayers, name: $("#in-name").value.trim() || "Du" }));
};
$("#log-toggle").onclick = () => $("#log").classList.toggle("open");

function showStart() {
  $("#overlay").innerHTML = "";
  location.reload();
}
function showResults() {
  const ov = $("#overlay");
  if (ov.classList.contains("show")) return;
  const rows = V.ranking.map((p, i) => `<div class="r ${i === 0 ? "win" : ""}"><span>${i === 0 ? "🏆" : i + 1 + "."} ${V.players[p].name}</span><span>${V.scores[p]} Pkt · 💰 ${V.cash_all[p]}</span></div>`).join("");
  ov.innerHTML = `<div class="panel"><h1>Ende!</h1><p class="sub">Quartettwert × Anzahl Quartette</p>
    <div class="results">${rows}</div><button class="big" onclick="location.reload()">Nochmal spielen</button></div>`;
  setTimeout(() => ov.classList.add("show"), 1500);
}

function fit() {
  const s = Math.min(innerWidth / 1476, innerHeight / 896);
  $("#stage").style.transform = `translate(-50%, -50%) scale(${s})`;
}
fit();
window.addEventListener("resize", () => { fit(); render(); });
loadAssets().then(async () => {
  const v = await api("/api/state");
  if (v && v.phase !== "none" && v.phase !== "over") {
    $("#overlay").classList.remove("show");
    accept(v);
  }
});
