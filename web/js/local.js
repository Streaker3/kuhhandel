/* Kuhhandel – Spielleiter im Browser (ersetzt den Python-Server).
 * Bietet dieselben Aufrufe wie früher server.py (/api/new, /api/act, /api/bot_step, …) und speichert
 * den Spielstand im Browser (localStorage), damit man nach dem Neuladen weiterspielen kann.
 */
(function (root) {
  "use strict";
  const HUMAN = 0;
  const BOT_NAMES = ["Berta", "Konrad", "Hilde", "Gustav"];
  const SAVE_KEY = "kh-spielstand-v1";

  const st = { game: null, bots: {}, opponents: "ai", level: "mittel", loaded: false };

  function save() {
    if (!st.game) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ game: st.game.toJSON(), opponents: st.opponents, level: st.level }));
    } catch (e) { /* Speicher voll oder gesperrt – dann eben ohne Speichern */ }
  }

  async function makeBots(n) {
    const bots = {};
    for (let p = 1; p < n; p++) bots[p] = await AI.makeBot(st.opponents, st.level);
    return bots;
  }

  async function load() {
    if (st.loaded) return;
    st.loaded = true;
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch (e) { data = null; }
    if (!data) return;
    try {
      st.game = KH.Game.fromJSON(data.game);
      st.opponents = data.opponents;
      st.level = data.level;
      st.bots = await makeBots(st.game.n);
    } catch (e) {
      st.game = null;   // alter oder beschädigter Spielstand
    }
  }

  function view(since) {
    const g = st.game;
    if (!g) return { phase: "none" };
    const v = KH.playerView(g, HUMAN, since || 0);
    v.bot_turn = g.toAct !== null && g.toAct !== HUMAN;
    return v;
  }

  function parseAction(a) {
    const k = a.kind;
    if (k === "bid") return ["bid", Number(a.amount)];
    if (k === "challenge") return ["challenge", Number(a.target), Number(a.animal)];
    if (k === "offer" || k === "counter") return [k, a.notes.map(Number)];
    return [k];
  }

  /** Gleiche Schnittstelle wie früher der Server: call("/api/…", body) -> Ansicht oder {error}. */
  async function call(path, body = {}) {
    await load();
    const since = Number(body.since || 0);
    try {
      switch (path) {
        case "/api/info":
          return { ai_available: true, checkpoint: "Browser" };
        case "/api/new": {
          const n = Number(body.players || 4);
          st.opponents = body.opponents || "ai";
          st.level = body.level || "mittel";
          st.game = new KH.Game(n, { names: [body.name || "Du", ...BOT_NAMES.slice(0, n - 1)] });
          st.bots = await makeBots(n);
          save();
          return view(0);
        }
        case "/api/takeover":
        case "/api/state":
          return view(since);
        case "/api/act": {
          const g = st.game;
          if (!g) return { error: "Kein Spiel" };
          if (g.toAct !== HUMAN) return { error: "Du bist nicht dran" };
          g.step(parseAction(body.action));
          save();
          return view(since);
        }
        case "/api/bot_step": {
          const g = st.game;
          if (g && g.toAct !== null && g.toAct !== HUMAN) { g.step(st.bots[g.toAct].act(g)); save(); }
          return view(since);
        }
        case "/api/skip_auction": {
          // Test-Hilfe: Versteigerung automatisch zu Ende spielen (eigene Züge macht ein einfacher Bot)
          const g = st.game, standIn = new AI.HeuristicBot();
          while (g.phase === "auction") g.step((g.toAct === HUMAN ? standIn : st.bots[g.toAct]).act(g));
          save();
          return view(since);
        }
        default:
          return { error: "unbekannt" };
      }
    } catch (e) {
      if (e instanceof KH.IllegalAction) return { error: e.message };
      throw e;
    }
  }

  root.Local = { call };
})(typeof self !== "undefined" ? self : this);
