"""Offline simulation: a synthetic listener compares shuffle strategies.
Usage: python sim.py [--grid]   (without --grid: baselines + default only; runs a self-check first)
"""
import itertools
import math
import sys
from dataclasses import dataclass, replace

import numpy as np

DAY = 40  # simulated plays per day


@dataclass(frozen=True)
class Params:
    k: float = 12.0         # exponent on theta in the draw
    prior: float = 2.0      # Beta(prior, prior)
    half: float = 120.0     # half-life (days) of counter decay
    eps: float = 0.05       # floor: share of uniform draws
    gap: int = 30           # anti-repeat gap (plays)
    hype_half: float = 5.0  # half-life (days) of the replay bonus
    hype_cap: float = 3.0   # cap of the replay bonus
    revive: float = 60.0    # days unplayed -> forced revival
    probation: int = 3      # probation plays for a new track
    p_new: float = 0.1      # chance to draw a probation track
    gain: float = 3.0       # evidence strength per play (confidence weighting)
    rank: bool = False      # weight by rank of the sampled theta instead of its value


class Shuffler:
    def __init__(self, kind, p, n, rng):
        self.kind, self.p, self.rng = kind, p, rng
        self.a = np.full(n, p.prior)
        self.b = np.full(n, p.prior)
        self.h = np.zeros(n)
        self.last_played = np.full(n, -10**9)
        self.last_seen = np.zeros(n)
        self.plays = np.zeros(n, int)
        self.recent = []

    def add(self, m, t):
        p = self.p
        self.a = np.concatenate([self.a, np.full(m, p.prior + 1.0)])  # Beta(3,2) for a new track
        self.b = np.concatenate([self.b, np.full(m, p.prior)])
        self.h = np.concatenate([self.h, np.zeros(m)])
        self.last_played = np.concatenate([self.last_played, np.full(m, -10**9)])
        self.last_seen = np.concatenate([self.last_seen, np.full(m, float(t))])
        self.plays = np.concatenate([self.plays, np.zeros(m, int)])

    def pick(self, t):
        p, rng = self.p, self.rng
        elig = (t - self.last_played) > p.gap
        if self.kind == "random":
            return int(rng.choice(np.flatnonzero(elig)))
        if self.kind == "greedy":
            mean = np.where(elig, self.a / (self.a + self.b), -1.0)
            return int(np.argmax(mean))
        stale = elig & ((t - self.last_seen) > p.revive * DAY)
        if stale.any():
            return int(np.flatnonzero(stale)[np.argmin(self.last_seen[stale])])
        prob = elig & (self.plays < p.probation)
        if prob.any() and rng.random() < p.p_new:
            return int(rng.choice(np.flatnonzero(prob)))
        if rng.random() < p.eps:
            return int(rng.choice(np.flatnonzero(elig)))
        theta = rng.beta(self.a, self.b)
        if p.rank:
            th = np.where(elig, theta, -1.0)
            order = np.argsort(np.argsort(th))  # 0 = lowest
            n_el = int(elig.sum())
            q = np.clip((order - (len(th) - n_el)) / max(1, n_el - 1), 0.0, 1.0)
            w = q ** p.k * (1.0 + np.minimum(self.h, p.hype_cap))
        else:
            w = theta ** p.k * (1.0 + np.minimum(self.h, p.hype_cap))
        w[~elig] = 0.0
        return int(rng.choice(len(w), p=w / w.sum()))

    def update(self, i, outcome, t):
        self.last_played[i] = t
        self.last_seen[i] = t
        self.plays[i] += 1
        g = self.p.gain
        ws = (0.3 if sum(self.recent[-5:]) >= 3 else 1.0) * g  # mood-noise guard x gain
        if outcome == "skip_early":
            self.b[i] += 1.0 * ws
        elif outcome == "skip_mid":
            self.a[i] += 0.3 * 0.6 * ws
            self.b[i] += 0.7 * 0.6 * ws
        elif outcome == "skip_late":
            self.a[i] += 0.7 * 0.6 * ws
            self.b[i] += 0.3 * 0.6 * ws
        else:
            self.a[i] += 1.0 * g
        self.recent.append(1 if outcome.startswith("skip") else 0)

    def replay(self, i, n, t):
        self.h[i] += math.log1p(n)
        self.a[i] += min(0.2 * n, 1.0)  # small lasting share
        self.last_played[i] = t
        self.last_seen[i] = t

    def daily(self):
        p = self.p
        f = 0.5 ** (1.0 / p.half)
        self.a = p.prior + (self.a - p.prior) * f
        self.b = p.prior + (self.b - p.prior) * f
        self.h *= 0.5 ** (1.0 / p.hype_half)


def react(q, rng, bad):
    s = 0.05 + 0.85 * (1 - q) ** 1.2
    if bad:
        s = min(0.95, 0.45 + 0.4 * s)
    if rng.random() < s:
        u = rng.random()
        return "skip_early" if u < 0.7 else "skip_mid" if u < 0.9 else "skip_late"
    return "full"


def run(kind, p, seed, P=3000, n0=365, n_new=100, add_at=1500, q=None):
    ru, ra = np.random.default_rng(seed), np.random.default_rng(seed + 1000)
    qs = ru.beta(1.5, 2.0, n0 + n_new) if q is None else q
    n = n0
    sh = Shuffler(kind, p, n0, ra)
    idx = np.zeros(P, int)
    skip = np.zeros(P, bool)
    t, bad, nextday = 0, False, DAY
    for step in range(P):
        if step == add_at:
            sh.add(n_new, t)
            n = n0 + n_new
        if step % 40 == 0:
            bad = ru.random() < 0.25
        i = sh.pick(t)
        out = react(qs[i], ru, bad)
        sh.update(i, out, t)
        idx[step], skip[step] = i, out.startswith("skip")
        t += 1
        if ru.random() < 0.01:  # user picks and repeats a favorite
            top = np.argsort(-qs[:n])[: max(1, n // 10)]
            j, r = int(ru.choice(top)), int(ru.integers(3, 11))
            sh.replay(j, r, t)
            t += r
        while t >= nextday:
            sh.daily()
            nextday += DAY
    return metrics(qs, idx, skip, n0, n_new, add_at, P)


def metrics(q, idx, skip, n0, n_new, add_at, P):
    thrA = np.quantile(q[:n0], 0.7)
    thrB = np.quantile(q[: n0 + n_new], 0.7)
    A = slice(500, add_at)
    B = slice(add_at + 300, P)
    new_plays = idx[add_at:add_at + 300] >= n0
    newB = idx[B][idx[B] >= n0]
    bottom = np.flatnonzero(q[:n0] <= np.quantile(q[:n0], 0.3))
    last1000 = set(idx[P - 1000:].tolist())
    return {
        "topA": float(np.mean(q[idx[A]] >= thrA)),
        "topB": float(np.mean(q[idx[B]] >= thrB)),
        "skipB": float(np.mean(skip[B])),
        "cover": float(len(set(idx[:600].tolist()) & set(range(n0))) / n0),
        "newExp": float(np.mean(new_plays)),
        "newTop": float(np.mean(q[newB] >= thrB)) if len(newB) else 0.0,
        "floor": float(np.mean([b in last1000 for b in bottom])),
        "maxShare": float(np.bincount(idx[B]).max() / len(idx[B])),
    }


def avg(kind, p, seeds=range(5)):
    rs = [run(kind, p, s) for s in seeds]
    return {k: float(np.mean([r[k] for r in rs])) for k in rs[0]}


def selfcheck():
    rnd = avg("random", Params(), seeds=range(3))
    assert 0.25 <= rnd["topA"] <= 0.36, rnd  # random ~ 30% of the top 30%
    sh = Shuffler("smart", Params(), 5, np.random.default_rng(0))
    sh.h[:] = 3.0
    for _ in range(40 * 40):
        sh.daily()
    assert sh.h.max() < 0.01  # replay cools off
    sh.a[:] = 12.0
    for _ in range(40 * 1500):
        sh.daily()
    assert abs(sh.a[0] - 2.0) < 0.05  # counters return to the prior
    print("selfcheck OK")


def row(name, m):
    return (f"{name:<34} topB={m['topB']:.2f} topA={m['topA']:.2f} skip={m['skipB']:.2f} "
            f"cover={m['cover']:.2f} newExp={m['newExp']:.2f} newTop={m['newTop']:.2f} "
            f"floor={m['floor']:.2f} maxSh={m['maxShare']:.3f}")


def main():
    selfcheck()
    base = Params()
    print("baselines (fair share of new tracks = 0.21):")
    for kind in ("random", "greedy", "smart"):
        print(row(kind, avg(kind, base)))
    if "--grid" not in sys.argv:
        return
    res = []
    for k, pr, g, eps, pn in itertools.product((2.0, 3.0, 4.0, 6.0), (1.0, 2.0), (1.0, 2.0, 3.0), (0.02, 0.05), (0.1, 0.2)):
        p = replace(base, k=k, prior=pr, gain=g, eps=eps, p_new=pn)
        res.append((f"k={k:.0f} prior={pr:.0f} gain={g:.0f} eps={eps} pnew={pn}", avg("smart", p)))
    ok = [r for r in res if r[1]["cover"] >= 0.78 and r[1]["floor"] >= 0.70 and r[1]["newExp"] >= 0.12]
    ok.sort(key=lambda r: -r[1]["topB"])
    print(f"\n{len(ok)}/{len(res)} configs pass the constraints (cover>=.78, floor>=.70, newExp>=.12). Top 8:")
    for name, m in ok[:8]:
        print(row(name, m))
    print("\nWorst that passes:")
    if ok:
        print(row(*ok[-1]))


if __name__ == "__main__":
    main()
