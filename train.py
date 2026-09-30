"""PPO-Self-Play-Training für Kuhhandel.

    .venv/bin/python train.py                 # neues Training
    .venv/bin/python train.py --resume        # an checkpoints/latest.pt weitermachen
    .venv/bin/python train.py --hours 8       # nach 8 Stunden automatisch stoppen

Belohnung: +1 für den Sieg, sonst 0. Der Value-Kopf lernt die Siegwahrscheinlichkeit
aus jeder Situation; über GAE bekommt so jede einzelne Aktion ein Lernsignal.
Gegner: aktuelle Version (Self-Play), ältere Versionen (Liga) und Heuristik-Bots.
"""
from __future__ import annotations

import argparse
import csv
import multiprocessing as mp
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from kuhhandel.bots import HeuristicBot
from kuhhandel.encode import decode_action, legal_mask, obs_size, observe
from kuhhandel.engine import Game
from kuhhandel.model import PolicyNet, adapt_state

ROOT = Path(__file__).parent
CKPT = ROOT / "checkpoints"
RUNS = ROOT / "runs"

PLAYER_COUNTS = (3, 4, 5)
PLAYER_WEIGHTS = (0.3, 0.4, 0.3)


# ====================================================================== Rollouts
def _new_net(state, hidden):
    net = PolicyNet(hidden=hidden)
    net.load_state_dict(adapt_state(state))
    net.eval()
    return net


def _assign_seats(rng, n, n_league, p_league, p_heur):
    seats = []
    for _ in range(n):
        r = rng.random()
        if r < p_heur:
            seats.append("heur")
        elif r < p_heur + p_league and n_league:
            seats.append(("league", rng.randrange(n_league)))
        else:
            seats.append("cur")
    if "cur" not in seats:
        seats[rng.randrange(n)] = "cur"
    return seats


def rollout_worker(args):
    """Spielt `games` Partien gebündelt; liefert Trainingsdaten der 'cur'-Sitze."""
    (state, league_states, hidden, games, seed, gamma, lam, mode, p_league, p_heur, bust_penalty) = args
    torch.set_num_threads(1)
    rng = random.Random(seed)
    torch.manual_seed(seed)
    cur = _new_net(state, hidden)
    league = [_new_net(s, hidden) for s in league_states]
    heur = HeuristicBot(seed=seed)

    def new_game():
        if mode in ("eval", "evalvs"):
            # eval: 1× KI gegen Heuristik-Bots; evalvs: 1× KI gegen eine ältere Version (league[0])
            n = rng.choice((3, 4, 5))
            seats = ["heur" if mode == "eval" else ("league", 0)] * n
            seats[rng.randrange(n)] = "cur"
        else:
            n = rng.choices(PLAYER_COUNTS, PLAYER_WEIGHTS)[0]
            seats = _assign_seats(rng, n, len(league), p_league, p_heur)
        g = Game(n, seed=rng.randrange(1 << 30))
        return {"g": g, "seats": seats, "traj": defaultdict(list), "ev": 0}

    BATCH = min(games, 48)
    active = [new_game() for _ in range(BATCH)]
    started = BATCH
    out = {k: [] for k in ("obs", "mask", "act", "logp", "adv", "ret")}
    stats = {"games": 0, "cur_wins": 0.0, "cur_seats": 0, "steps": 0, "busts": 0,
             "by_n": defaultdict(lambda: [0, 0])}

    def after_step(slot):
        """Auffliegen (Zahlungsunfähigkeit) der KI zählen und mit einem kleinen Malus belegen."""
        g = slot["g"]
        for ev in g.events[slot["ev"]:]:
            if ev.get("kind") == "bust" and slot["seats"][ev["player"]] == "cur":
                stats["busts"] += 1
                tr = slot["traj"][ev["player"]]
                if tr:
                    tr[-1][5] -= bust_penalty
        slot["ev"] = len(g.events)

    def finish(slot):
        g = slot["g"]
        w = g.winner()
        stats["games"] += 1
        for p, s in enumerate(slot["seats"]):
            if s != "cur":
                continue
            r = 1.0 if p == w else 0.0
            stats["cur_wins"] += r
            stats["cur_seats"] += 1
            stats["by_n"][g.n][0] += r
            stats["by_n"][g.n][1] += 1
            tr = slot["traj"][p]
            if mode != "train" or not tr:
                continue
            vals = np.array([t[4] for t in tr] + [0.0], dtype=np.float32)
            shaped = [t[5] for t in tr]
            T = len(tr)
            adv = np.zeros(T, dtype=np.float32)
            last = 0.0
            for t in reversed(range(T)):
                rew = shaped[t] + (r if t == T - 1 else 0.0)
                nxt = 0.0 if t == T - 1 else vals[t + 1]
                delta = rew + gamma * nxt - vals[t]
                last = delta + gamma * lam * last
                adv[t] = last
            ret = adv + vals[:T]
            for t in range(T):
                out["obs"].append(tr[t][0]); out["mask"].append(tr[t][1])
                out["act"].append(tr[t][2]); out["logp"].append(tr[t][3])
            out["adv"].append(adv); out["ret"].append(ret)

    with torch.no_grad():
        while active:
            groups = defaultdict(list)
            for i, slot in enumerate(active):
                groups[slot["seats"][slot["g"].to_act]].append(i)
            for key, idxs in groups.items():
                if key == "heur":
                    for i in idxs:
                        g = active[i]["g"]
                        g.step(heur.act(g))
                        after_step(active[i])
                    continue
                net = cur if key == "cur" else league[key[1]]
                obs = np.stack([observe(active[i]["g"]) for i in idxs])
                mask = np.stack([legal_mask(active[i]["g"]) for i in idxs])
                logits, v = net(torch.from_numpy(obs), torch.from_numpy(mask))
                dist = torch.distributions.Categorical(logits=logits)
                a = dist.sample()
                logp = dist.log_prob(a)
                for j, i in enumerate(idxs):
                    slot = active[i]
                    g = slot["g"]
                    p = g.to_act
                    ai = int(a[j])
                    if key == "cur":
                        slot["traj"][p].append([obs[j], mask[j], ai, float(logp[j]), float(v[j]), 0.0])
                        stats["steps"] += 1
                    g.step(decode_action(g, ai))
                    after_step(slot)
            nxt = []
            for slot in active:
                if slot["g"].phase == "over":
                    finish(slot)
                    if started < games:
                        nxt.append(new_game())
                        started += 1
                else:
                    nxt.append(slot)
            active = nxt

    if out["obs"]:
        res = {
            "obs": np.stack(out["obs"]), "mask": np.stack(out["mask"]),
            "act": np.array(out["act"], dtype=np.int64), "logp": np.array(out["logp"], dtype=np.float32),
            "adv": np.concatenate(out["adv"]), "ret": np.concatenate(out["ret"]),
        }
    else:
        res = None
    stats["by_n"] = dict(stats["by_n"])
    return res, stats


# ====================================================================== Training
def ppo_update(net, opt, data, args):
    N = len(data["act"])
    t = {k: torch.from_numpy(v) for k, v in data.items()}
    adv = (t["adv"] - t["adv"].mean()) / (t["adv"].std() + 1e-8)
    info = defaultdict(float)
    nb = 0
    for _ in range(args.epochs):
        perm = torch.randperm(N)
        for s in range(0, N, args.minibatch):
            b = perm[s:s + args.minibatch]
            logits, v = net(t["obs"][b], t["mask"][b])
            dist = torch.distributions.Categorical(logits=logits)
            logp = dist.log_prob(t["act"][b])
            ratio = torch.exp(logp - t["logp"][b])
            a = adv[b]
            pg = -torch.min(ratio * a, ratio.clamp(1 - args.clip, 1 + args.clip) * a).mean()
            vl = F.mse_loss(v, t["ret"][b])
            # Entropie nur über erlaubte Aktionen
            p = torch.softmax(logits, -1)
            ent = -(p * torch.log_softmax(logits, -1)).masked_fill(~t["mask"][b], 0).sum(-1).mean()
            loss = pg + args.vf_coef * vl - args.ent_coef * ent
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5)
            opt.step()
            with torch.no_grad():
                info["kl"] += (t["logp"][b] - logp).mean().item()
                info["clipfrac"] += ((ratio - 1).abs() > args.clip).float().mean().item()
            info["pg"] += pg.item(); info["vl"] += vl.item(); info["ent"] += ent.item()
            nb += 1
    return {k: v / nb for k, v in info.items()}


def save(net, opt, it, league, path, extra=None):
    torch.save({"model": net.state_dict(), "opt": opt.state_dict(), "iter": it,
                "obs_dim": obs_size(), "hidden": net.v.in_features,
                "league": league, **(extra or {})}, path)


def evaluate(pool, net, args, games, opponent=None):
    """Siegquote der KI (1 Sitz) gegen Heuristik-Bots oder gegen eine ältere Version."""
    state = {k: v.clone() for k, v in net.state_dict().items()}
    per = max(1, games // args.workers)
    league = [opponent] if opponent is not None else []
    mode = "evalvs" if opponent is not None else "eval"
    jobs = [(state, league, args.hidden, per, random.randrange(1 << 30), 1.0, 0.95, mode, 0, 0, 0.0)
            for _ in range(args.workers)]
    wins = seats = busts = 0
    by_n = defaultdict(lambda: [0, 0])
    for _, st in pool.map(rollout_worker, jobs):
        wins += st["cur_wins"]; seats += st["cur_seats"]; busts += st["busts"]
        for n, (w, s) in st["by_n"].items():
            by_n[n][0] += w; by_n[n][1] += s
    return wins / max(1, seats), {n: w / s for n, (w, s) in sorted(by_n.items())}, busts / max(1, seats)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=100000)
    ap.add_argument("--hours", type=float, default=0)
    ap.add_argument("--games", type=int, default=384, help="Partien pro Iteration")
    ap.add_argument("--workers", type=int, default=max(1, (mp.cpu_count() or 4) - 1))
    ap.add_argument("--hidden", type=int, default=512)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--minibatch", type=int, default=4096)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--ent-coef", type=float, default=0.01)
    ap.add_argument("--gamma", type=float, default=1.0)
    ap.add_argument("--lam", type=float, default=0.98)
    ap.add_argument("--snapshot-every", type=int, default=10)
    ap.add_argument("--league-size", type=int, default=15)
    ap.add_argument("--eval-every", type=int, default=10)
    ap.add_argument("--eval-games", type=int, default=700)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--bust-penalty", type=float, default=0.05,
                    help="Malus pro Auffliegen (Siegbelohnung = 1); Spielregeln bleiben unverändert")
    args = ap.parse_args()

    CKPT.mkdir(exist_ok=True)
    RUNS.mkdir(exist_ok=True)
    torch.set_num_threads(max(1, (mp.cpu_count() or 4) // 2))
    net = PolicyNet(hidden=args.hidden)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, eps=1e-5)
    start_it, league = 0, []
    elapsed0, games0, best = 0.0, 0, -1.0
    if args.resume and (CKPT / "latest.pt").exists():
        ck = torch.load(CKPT / "latest.pt", weights_only=False)
        grown = ck["model"]["body.0.weight"].shape[1] < obs_size()
        net.load_state_dict(adapt_state(ck["model"]))
        if grown:
            print(f"Beobachtung erweitert auf {obs_size()} Eingaben – Netz angepasst, Optimizer neu gestartet")
        else:
            opt.load_state_dict(ck["opt"])
        start_it, league = ck["iter"], [adapt_state(s_) for s_ in ck.get("league", [])]
        elapsed0, games0 = ck.get("elapsed_min", 0.0), ck.get("games_total", 0)
        best = ck.get("best", -1.0)
        print(f"Fortsetzen ab Iteration {start_it}, Liga: {len(league)} Versionen")

    header = ["iter", "time_min", "games_total", "steps", "selfplay_winrate", "eval_winrate", "eval_by_n",
              "vs_old_winrate", "vs_old_iter", "vs_old_by_n", "busts_per_game", "eval_busts", "bust_penalty", "pg", "vl", "ent", "kl", "clipfrac", "sps"]
    log_path = RUNS / "log.csv"
    old_rows = []
    if args.resume and log_path.exists():
        with open(log_path, newline="") as f:
            old_rows = list(csv.DictReader(f))
    logf = open(log_path, "w", newline="")
    log = csv.DictWriter(logf, fieldnames=header, extrasaction="ignore", restval="")
    log.writeheader()
    if start_it and not games0:
        games0 = start_it * args.games  # Schätzung für ältere Checkpoints
    if old_rows and not elapsed0:
        elapsed0 = float(old_rows[-1]["time_min"] or 0)
    for r in old_rows:  # alte Zeilen übernehmen (fehlende Spalten bleiben leer)
        if int(r["iter"]) <= start_it:
            log.writerow(r)
    logf.flush()
    snap_iters = sorted(int(p.stem.split("_")[1]) for p in CKPT.glob("snap_*.pt"))

    ctx = mp.get_context("spawn")
    pool = ctx.Pool(args.workers)
    t0 = time.time()
    try:
        for it in range(start_it + 1, start_it + args.iters + 1):
            if args.hours and time.time() - t0 > args.hours * 3600:
                print("Zeitlimit erreicht.")
                break
            ti = time.time()
            # Heuristik-Anteil sinkt, Liga-Anteil steigt mit der Zeit
            p_heur = max(0.1, 0.5 - it * 0.004)
            p_league = min(0.35, 0.02 * len(league))
            state = {k: v.clone() for k, v in net.state_dict().items()}
            per = max(1, args.games // args.workers)
            jobs = [(state, league, args.hidden, per, random.randrange(1 << 30), args.gamma, args.lam,
                     "train", p_league, p_heur, args.bust_penalty) for _ in range(args.workers)]
            results = pool.map(rollout_worker, jobs)
            data = [r for r, _ in results if r is not None]
            batch = {k: np.concatenate([d[k] for d in data]) for k in data[0]}
            wins = sum(s["cur_wins"] for _, s in results)
            seats = sum(s["cur_seats"] for _, s in results)
            t_roll = time.time() - ti
            net.train()
            info = ppo_update(net, opt, batch, args)
            net.eval()
            steps = len(batch["act"])
            sps = steps / (time.time() - ti)

            games_total = games0 + sum(s["games"] for _, s in results)
            games0 = games_total
            row = {}
            if it % args.eval_every == 0:
                wr, by_n, eb = evaluate(pool, net, args, args.eval_games)
                row["eval_busts"] = f"{eb:.3f}"
                row["eval_winrate"] = f"{wr:.3f}"
                row["eval_by_n"] = " ".join(f"{n}:{v:.2f}" for n, v in by_n.items())
                # gegen die eigene Version von vor ~50 Iterationen (Fortschritt trotz Sättigung gegen Heuristik)
                old = [s for s in snap_iters if s <= it - 50]
                if old:
                    ck_old = torch.load(CKPT / f"snap_{old[-1]:05d}.pt", weights_only=False)
                    wr_o, by_o, _ = evaluate(pool, net, args, args.eval_games, opponent=ck_old["model"])
                    row["vs_old_winrate"] = f"{wr_o:.3f}"
                    row["vs_old_iter"] = old[-1]
                    row["vs_old_by_n"] = " ".join(f"{n}:{v:.2f}" for n, v in by_o.items())
                if wr > best:
                    best = wr
                    save(net, opt, it, league, CKPT / "best.pt", {"best": best})
            if it % args.snapshot_every == 0:
                league.append({k: v.clone() for k, v in net.state_dict().items()})
                league = league[-args.league_size:]
                torch.save({"model": net.state_dict(), "obs_dim": obs_size(), "hidden": args.hidden, "iter": it},
                           CKPT / f"snap_{it:05d}.pt")
                snap_iters.append(it)
            mins = elapsed0 + (time.time() - t0) / 60
            save(net, opt, it, league, CKPT / "latest.pt",
                 {"elapsed_min": mins, "games_total": games_total, "best": best})

            row.update({"iter": it, "time_min": f"{mins:.1f}", "games_total": games_total, "steps": steps,
                        "selfplay_winrate": f"{wins / max(1, seats):.3f}", "pg": f"{info['pg']:.4f}",
                        "busts_per_game": f"{sum(s['busts'] for _, s in results) / max(1, seats):.3f}",
                        "bust_penalty": args.bust_penalty,
                        "vl": f"{info['vl']:.4f}", "ent": f"{info['ent']:.3f}", "kl": f"{info['kl']:.4f}",
                        "clipfrac": f"{info['clipfrac']:.3f}", "sps": f"{sps:.0f}"})
            log.writerow(row)
            logf.flush()
            eval_wr = row.get("eval_winrate", "")
            eval_by_n = row.get("eval_by_n", "")
            msg = (f"it {it:5d} | {mins:6.1f} min | steps {steps:6d} | roll {t_roll:4.1f}s | "
                   f"ent {info['ent']:.2f} vl {info['vl']:.3f} kl {info['kl']:.4f}")
            if eval_wr:
                msg += f" | vs Heuristik: {eval_wr} ({eval_by_n})"
            print(msg, flush=True)
    finally:
        pool.close()
        pool.join()
        logf.close()


if __name__ == "__main__":
    main()
