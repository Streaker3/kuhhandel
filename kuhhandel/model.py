"""Policy-/Value-Netz und KI-Spieler."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn

from .encode import N_ACTIONS, decode_action, legal_mask, obs_size, observe
from .engine import Game

NEG = -1e9


class PolicyNet(nn.Module):
    def __init__(self, obs_dim: int | None = None, hidden: int = 512):
        super().__init__()
        obs_dim = obs_dim or obs_size()
        self.body = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
        )
        self.pi = nn.Linear(hidden, N_ACTIONS)
        self.v = nn.Linear(hidden, 1)  # geschätzte Siegwahrscheinlichkeit

    def forward(self, obs, mask):
        h = self.body(obs)
        logits = self.pi(h).masked_fill(~mask, NEG)
        return logits, self.v(h).squeeze(-1)


def load_net(path, map_location="cpu") -> PolicyNet:
    ckpt = torch.load(path, map_location=map_location, weights_only=False)
    net = PolicyNet(ckpt.get("obs_dim"), ckpt.get("hidden", 512))
    net.load_state_dict(ckpt["model"])
    net.eval()
    return net


class NNBot:
    """Spielt mit einem trainierten Netz. `greedy` wählt immer die beste Aktion."""

    def __init__(self, net_or_path, greedy: bool = False, seed=None):
        self.net = load_net(net_or_path) if isinstance(net_or_path, (str, Path)) else net_or_path
        self.greedy = greedy
        self.gen = torch.Generator().manual_seed(seed if seed is not None else np.random.randint(1 << 30))

    @torch.no_grad()
    def act(self, g: Game):
        obs = torch.from_numpy(observe(g)).unsqueeze(0)
        mask = torch.from_numpy(legal_mask(g)).unsqueeze(0)
        logits, _ = self.net(obs, mask)
        if self.greedy:
            idx = int(logits.argmax(-1))
        else:
            idx = int(torch.distributions.Categorical(logits=logits).sample())
        return decode_action(g, idx)

    @torch.no_grad()
    def win_estimate(self, g: Game) -> float:
        obs = torch.from_numpy(observe(g)).unsqueeze(0)
        mask = torch.from_numpy(legal_mask(g)).unsqueeze(0)
        return float(self.net(obs, mask)[1])
