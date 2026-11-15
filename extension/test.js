// node extension/test.js -> unit tests for classification and scoring (port of sim/sim.py)
const assert = require("assert");
const M = require("./smartshuffle.js");
const { classify, newState, sync, decay, update, replay, like, pick, beta, P, DAY } = M;

const seeded = (s) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// classify
assert.strictEqual(classify({ playedMs: 4000, lastPct: 0.02 }), "skip_early");
assert.strictEqual(classify({ playedMs: 29999, lastPct: 0.3 }), "skip_early");
assert.strictEqual(classify({ playedMs: 60000, lastPct: 0.3 }), "skip_mid");
assert.strictEqual(classify({ playedMs: 120000, lastPct: 0.7 }), "skip_late");
assert.strictEqual(classify({ playedMs: 200000, lastPct: 0.97 }), "full");
assert.strictEqual(classify({ playedMs: 5000, lastPct: 0.95 }), "full");
assert.strictEqual(classify({ playedMs: 180000, lastPct: 0.929 }), "skip_late");

// beta: mean ~ a/(a+b)
{
  const r = seeded(1); let s = 0;
  for (let i = 0; i < 20000; i++) s += beta(3, 2, r);
  assert(Math.abs(s / 20000 - 0.6) < 0.01, "beta mean");
}

const mk = (n) => { const st = newState(); sync(st, Array.from({ length: n }, (_, i) => "t" + i), 0); return st; };

// update: score direction
{
  const st = mk(3);
  update(st, "t0", "skip_early", 1); update(st, "t1", "full", 1); update(st, "t2", "skip_late", 1);
  const m = (u) => st.t[u].a / (st.t[u].a + st.t[u].b);
  assert(m("t1") > m("t2") && m("t2") > m("t0"));
}

// a track added after the first load starts above the prior
{
  const st = mk(2);
  sync(st, ["t0", "t1", "novo"], 5);
  assert(st.t.novo.a > st.t.t0.a);
}

// mood guard: after 3 skips in a row the 4th weighs less
{
  const st = mk(6);
  for (const u of ["t0", "t1", "t2"]) update(st, u, "skip_early", 1);
  update(st, "t3", "skip_early", 1);
  assert(st.t.t3.b < st.t.t0.b);
}

// replay: hype rises and cools; counters return to the prior
{
  const st = mk(3);
  replay(st, "t0", 5, 0);
  assert(st.t.t0.h > 1.5);
  st.lastDecay = 0; decay(st, 40 * DAY);
  assert(st.t.t0.h < 0.02);
  st.t.t1.a = 12; st.lastDecay = 0; decay(st, 1500 * DAY);
  assert(Math.abs(st.t.t1.a - P.prior) < 0.05);
}

// like: raises score; unknown track is safe; names stored; higher k concentrates more
{
  const st = mk(3);
  const before = st.t.t0.a;
  assert(like(st, "t0") && st.t.t0.a === before + 5 && !like(st, "x"));
  sync(st, ["t0", "t1", "t2"], 1, { t0: "Musica - Artista" });
  assert.strictEqual(st.t.t0.n, "Musica - Artista");
  const share = (k) => {
    const s2 = mk(40), r = seeded(5); s2.k = k; s2.t.t0.a = 20;
    let hit = 0;
    for (let i = 0; i < 400; i++) { s2.rp = []; if (pick(s2, r, 0) === "t0") hit++; }
    return hit;
  };
  assert(share(20) > share(4), "k maior = mais agressivo");
}

// pick: honors exclusion and anti-repeat gap
{
  const st = mk(100), rng = seeded(7);
  for (let i = 0; i < 20; i++) update(st, "t" + i, "full", 1);
  for (let i = 0; i < 500; i++) {
    const u = pick(st, rng, 2, ["t50"]);
    assert(u !== "t50" && !st.rp.slice(-10).includes(u), "gap/exclude: " + u);
    update(st, u, "full", 2);
  }
  assert.strictEqual(pick(newState(), rng, 0), null);
}

// revival: a track unplayed for >60 days comes back
{
  const st = mk(50), rng = seeded(3);
  for (const u of st.uris) st.t[u].seen = 100 * DAY;
  st.t.t9.seen = 0;
  assert.strictEqual(pick(st, rng, 100 * DAY), "t9");
}

// relative ranking: a uniformly low (skip-heavy) listener picks the same as a happy one
{
  const share = (shift) => {
    const s2 = mk(40), r = seeded(11); s2.k = 12; s2.t.t0.a += 6;
    for (const u of s2.uris) s2.t[u].b += shift;
    let hit = 0;
    for (let i = 0; i < 600; i++) { s2.rp = []; if (pick(s2, r, 0) === "t0") hit++; }
    return hit;
  };
  assert(share(0) > 60 && share(8) > 60, "rank-based pick must not collapse when all scores are low");
}

// mini-simulation (same synthetic listener as sim/): smart must clearly beat random (~30%)
{
  const run = (smart, seed) => {
    const ru = seeded(seed), rs = seeded(seed + 99);
    const N = 365, q = Array.from({ length: N }, () => beta(1.5, 2, ru));
    const thr = [...q].sort((x, y) => x - y)[Math.floor(N * 0.7)];
    const st = mk(N); let hit = 0, tot = 0, bad = false;
    for (let step = 0; step < 2500; step++) {
      const now = Math.floor(step / 40) * DAY;
      decay(st, now);
      if (step % 40 === 0) bad = ru() < 0.25;
      const u = smart ? pick(st, rs, now) : "t" + Math.floor(rs() * N);
      const qi = q[+u.slice(1)];
      let s = 0.05 + 0.85 * Math.pow(1 - qi, 1.2); if (bad) s = Math.min(0.95, 0.45 + 0.4 * s);
      let out = "full";
      if (ru() < s) { const v = ru(); out = v < 0.7 ? "skip_early" : v < 0.9 ? "skip_mid" : "skip_late"; }
      update(st, u, out, now);
      if (step >= 500) { tot++; if (qi >= thr) hit++; }
    }
    return hit / tot;
  };
  const avg = (smart) => [1, 2, 3].reduce((s, sd) => s + run(smart, sd), 0) / 3;
  const rnd = avg(false), sm = avg(true);
  console.log(`mini-sim topo30%: aleatorio=${rnd.toFixed(2)} smart=${sm.toFixed(2)}`);
  assert(rnd > 0.24 && rnd < 0.36, "baseline aleatorio");
  assert(sm > 1.5 * rnd, "smart deve bater 1.5x o aleatorio");
}
console.log("tests OK");
