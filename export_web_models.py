"""Exportiert die KI-Netze für die Browser-Version (web/models/*.bin + models.json).

    .venv/bin/python export_web_models.py

Format: alle Gewichte als float32 (little endian) hintereinander, Reihenfolge wie in LAYERS.
Ältere Netze mit kleinerer Beobachtung werden verlustfrei auf die aktuelle Größe erweitert.
"""
import json
import random
from pathlib import Path

import numpy as np
import torch

from kuhhandel.bots import HeuristicBot
from kuhhandel.encode import legal_mask, obs_size, observe
from kuhhandel.engine import Game
from kuhhandel.model import adapt_state, load_net

ROOT = Path(__file__).parent
OUT = ROOT / "web" / "models"
MODELS = {"leicht": ROOT / "checkpoints" / "snap_00060.pt", "schwer": ROOT / "checkpoints_rules" / "best.pt"}   # nachtrainiert auf: mind. 1 Karte, große Scheine
LAYERS = ["body.0.weight", "body.0.bias", "body.2.weight", "body.2.bias", "body.4.weight", "body.4.bias",
          "pi.weight", "pi.bias", "v.weight", "v.bias"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"obs_dim": obs_size(), "layers": {}, "models": {}}
    for name, path in MODELS.items():
        ck = torch.load(path, map_location="cpu", weights_only=False)
        state = adapt_state(ck["model"])
        parts = [state[k].detach().numpy().astype("<f4") for k in LAYERS]
        meta["layers"] = {k: list(p.shape) for k, p in zip(LAYERS, parts)}
        (OUT / f"{name}.bin").write_bytes(b"".join(p.tobytes() for p in parts))
        meta["models"][name] = {"file": f"models/{name}.bin", "iter": ck.get("iter")}
        print(f"{name}: {path.name} -> {name}.bin ({sum(p.size for p in parts) * 4 / 1e6:.1f} MB)")
    (OUT / "models.json").write_text(json.dumps(meta, indent=1))

    # Referenzwerte für den Vergleichstest (tests/parity/check_nn.js)
    net = load_net(MODELS["schwer"])
    rng = random.Random(3)
    samples = []
    while len(samples) < 200:
        g = Game(rng.choice([3, 4, 5]), seed=rng.randrange(1 << 30))
        bot = HeuristicBot(rng.randrange(1000))
        while g.phase != "over" and len(samples) < 200:
            if rng.random() < 0.15:
                obs, mask = observe(g), legal_mask(g)
                with torch.no_grad():
                    logits, v = net(torch.from_numpy(obs).unsqueeze(0), torch.from_numpy(mask).unsqueeze(0))
                samples.append({"obs": obs.tolist(), "mask": np.flatnonzero(mask).tolist(),
                                "logits": [float(x) for x in logits[0][mask]], "value": float(v[0])})
            g.step(bot.act(g))
    (ROOT / "tests" / "parity" / "nn_samples.json").write_text(json.dumps(samples))
    print(f"{len(samples)} Referenz-Beobachtungen für den Netz-Vergleich")


if __name__ == "__main__":
    main()
