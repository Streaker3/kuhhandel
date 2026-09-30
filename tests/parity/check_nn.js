// Vergleicht das Netz im Browser (web/js/ai.js) mit PyTorch und spielt KI-Partien in JavaScript durch.
//   node tests/parity/check_nn.js
const fs = require("fs");
const path = require("path");
const KH = require("../../web/js/kuhhandel.js");
global.KH = KH;
const AI = require("../../web/js/ai.js");

const web = path.join(__dirname, "../../web/");
const meta = JSON.parse(fs.readFileSync(web + "models/models.json"));
const net = new AI.PolicyNet(fs.readFileSync(web + meta.models.schwer.file).buffer.slice(0), meta.layers);
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, "nn_samples.json")));
let maxDiff = 0, maxV = 0;
for (const s of samples) {
  const mask = new Uint8Array(KH.N_ACTIONS); s.mask.forEach((i) => { mask[i] = 1; });
  const { logits, value } = net.forward(Float32Array.from(s.obs), mask);
  s.mask.forEach((i, j) => { maxDiff = Math.max(maxDiff, Math.abs(logits[i] - s.logits[j])); });
  maxV = Math.max(maxV, Math.abs(value - s.value));
}
console.log(`Netz: ${samples.length} Beobachtungen, größte Abweichung Logits ${maxDiff.toExponential(2)}, Value ${maxV.toExponential(2)}`);

// KI-Partien komplett in JavaScript: 1 Schwer-KI gegen einfache Bots
let wins = 0, games = 60, t0 = Date.now(), decisions = 0;
for (let i = 0; i < games; i++) {
  const n = 4, seat = i % n, g = new KH.Game(n);
  const bots = [...Array(n).keys()].map((p) => (p === seat ? new AI.NNBot(net) : new AI.HeuristicBot()));
  while (g.phase !== "over") { if (g.toAct === seat) decisions++; g.step(bots[g.toAct].act(g)); }
  if (g.winner() === seat) wins++;
}
const ms = (Date.now() - t0) / decisions;
console.log(`Schwer-KI in JS: ${wins}/${games} Siege gegen einfache Bots (${Math.round(100 * wins / games)} %), ${ms.toFixed(2)} ms pro KI-Entscheidung`);
process.exit(maxDiff < 1e-3 && maxV < 1e-3 ? 0 : 1);
