// Smart Shuffle for Spicetify: learns which songs of one playlist you like (skips, full plays, repeats, likes)
// and keeps the queue filled with weighted random picks. Local only: no network, no account data, no telemetry.
// Setup/usage: see README.md. Console helpers: SmartShuffle.status() / scores() / exportJson() / reset()
(function SmartShuffle() {
  const CFG = { pollMs: 250, earlyMs: 30000, fullPct: 0.93, maxEvents: 5000, key: "smartshuffle:log:v1", stateKey: "smartshuffle:state:v1" };
  // Parameters tuned in the offline simulation (see sim/ and docs/DESIGN.md)
  const P = { k: 12, prior: 2, half: 120, eps: 0.05, gap: 30, hypeHalf: 5, hypeCap: 3, revive: 60, probation: 3, pNew: 0.1, gain: 3, ahead: 2 };
  const DAY = 86400000;

  // ---------- pure logic (unit-tested in Node) ----------
  function classify({ playedMs, lastPct }) {
    if (lastPct >= CFG.fullPct) return "full";
    if (playedMs < CFG.earlyMs) return "skip_early";
    return lastPct < 0.5 ? "skip_mid" : "skip_late";
  }

  const normal = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  function gamma(shape, rng) { // Marsaglia-Tsang
    if (shape < 1) return gamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = rng();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  function beta(a, b, rng) { const x = gamma(a, rng), y = gamma(b, rng); return x / (x + y); }

  const newState = () => ({ t: {}, uris: [], rp: [], mood: [], lastDecay: 0, init: false, target: null, enabled: false });

  // Sync with the playlist: a track added after the first load starts at Beta(3,2) (small boost); removed tracks leave the candidates.
  function sync(st, uris, now, names = {}) {
    for (const u of uris) {
      if (!st.t[u]) st.t[u] = { a: P.prior + (st.init ? 1 : 0), b: P.prior, h: 0, plays: 0, seen: now };
      if (names[u]) st.t[u].n = names[u];
    }
    st.uris = uris.slice();
    st.init = true;
    if (!st.lastDecay) st.lastDecay = now;
  }

  // Notes are global per track: a track heard outside the target playlist is still learned.
  function ensure(st, uri, now, name) {
    if (!st.t[uri]) st.t[uri] = { a: P.prior, b: P.prior, h: 0, plays: 0, seen: now };
    if (name && !st.t[uri].n) st.t[uri].n = name;
    return st.t[uri];
  }

  function decay(st, now) { // taste drifts slowly; hype cools fast
    const days = (now - st.lastDecay) / DAY;
    if (days <= 0) return;
    const f = Math.pow(0.5, days / P.half), fh = Math.pow(0.5, days / P.hypeHalf);
    for (const t of Object.values(st.t)) {
      t.a = P.prior + (t.a - P.prior) * f;
      t.b = P.prior + (t.b - P.prior) * f;
      t.h *= fh;
    }
    st.lastDecay = now;
  }

  function touch(st, uri, t, now) {
    t.seen = now;
    st.rp.push(uri);
    if (st.rp.length > 60) st.rp.shift();
  }

  function update(st, uri, outcome, now) {
    const t = st.t[uri];
    if (!t) return;
    const ws = (st.mood.slice(-5).reduce((s, x) => s + x, 0) >= 3 ? 0.3 : 1) * P.gain; // mood-noise guard
    if (outcome === "skip_early") t.b += ws;
    else if (outcome === "skip_mid") { t.a += 0.18 * ws; t.b += 0.42 * ws; }
    else if (outcome === "skip_late") { t.a += 0.42 * ws; t.b += 0.18 * ws; }
    else t.a += P.gain;
    t.plays++;
    touch(st, uri, t, now);
    st.mood.push(outcome.startsWith("skip") ? 1 : 0);
    if (st.mood.length > 5) st.mood.shift();
  }

  function replay(st, uri, n, now) { // manual repeat: strong temporary boost (hype) that cools off
    const t = st.t[uri];
    if (!t) return;
    t.h += Math.log1p(n);
    t.a += Math.min(0.2 * n, 1);
    touch(st, uri, t, now);
  }

  function like(st, uri, now = 0, name) { // like button: strong, lasting evidence (weight 5)
    if (!uri) return false;
    const t = ensure(st, uri, now, name);
    t.a += 5;
    return true;
  }

  // Draw the next track. exclude = current track + already queued.
  function pick(st, rng, now, exclude = []) {
    const N = st.uris.length;
    if (!N) return null;
    const gap = Math.min(P.gap, Math.max(1, Math.floor(N * 0.1)));
    const ban = new Set([...st.rp.slice(-gap), ...exclude]);
    let elig = st.uris.filter((u) => !ban.has(u));
    if (!elig.length) elig = st.uris.filter((u) => !exclude.includes(u));
    if (!elig.length) return null;
    const rnd = (arr) => arr[Math.floor(rng() * arr.length)];
    const stale = elig.filter((u) => now - st.t[u].seen > P.revive * DAY);
    if (stale.length) return stale.reduce((m, u) => (st.t[u].seen < st.t[m].seen ? u : m));
    const prob = elig.filter((u) => st.t[u].plays < P.probation);
    if (prob.length && rng() < P.pNew) return rnd(prob);
    if (rng() < P.eps) return rnd(elig);
    // Relative (Elo-like) selection: weight depends on the RANK of each sampled score among the
    // eligible tracks, never on its absolute level, so a skip-heavy listener does not drift to the floor.
    const th = elig.map((u) => beta(st.t[u].a, st.t[u].b, rng));
    const order = th.map((x, i) => i).sort((i, j) => th[i] - th[j]);
    const q = new Array(elig.length);
    order.forEach((i, pos) => { q[i] = elig.length > 1 ? pos / (elig.length - 1) : 1; });
    const w = elig.map((u, i) => Math.pow(q[i], st.k || P.k) * (1 + Math.min(st.t[u].h, P.hypeCap)));
    let r = rng() * w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < elig.length; i++) { r -= w[i]; if (r <= 0) return elig[i]; }
    return elig[elig.length - 1];
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ensure, classify, newState, sync, decay, update, replay, like, pick, beta, P, CFG, DAY };
    return;
  }

  // ---------- runtime (only inside the Spotify client) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function main() {
    while (!(window.Spicetify && Spicetify.Platform && Spicetify.Platform.PlayerAPI && Spicetify.Platform.PlaylistAPI && Spicetify.LocalStorage && Spicetify.Player)) {
      await sleep(300);
    }
    const S = Spicetify;
    const PA = S.Platform.PlayerAPI;
    const readJson = (k, d) => { try { return JSON.parse(S.LocalStorage.get(k) || "null") || d; } catch (e) { return d; } };
    let log = readJson(CFG.key, []);
    let st = Object.assign(newState(), readJson(CFG.stateKey, {}));
    const saveLog = () => {
      if (log.length > CFG.maxEvents) log = log.slice(-CFG.maxEvents);
      try { S.LocalStorage.set(CFG.key, JSON.stringify(log)); } catch (e) { console.warn("[SmartShuffle] save log failed", e); }
    };
    const saveState = () => { try { S.LocalStorage.set(CFG.stateKey, JSON.stringify(st)); } catch (e) { console.warn("[SmartShuffle] save state failed", e); } };

    const isTrack = (u) => typeof u === "string" && u.startsWith("spotify:track:");
    const snapshot = () => {
      const s = PA.getState();
      const it = s && s.item;
      if (!it || !isTrack(it.uri)) return null; // ignore ads/podcasts
      return {
        pid: s.playbackId || it.uri, uri: it.uri, name: it.name,
        artist: (it.artists || []).map((a) => a.name).join(", "),
        dur: it.duration && it.duration.milliseconds,
        ctx: s.context && s.context.uri,
        nextUri: s.nextItems && s.nextItems[0] && s.nextItems[0].uri,
        playing: !s.isPaused,
      };
    };

    async function loadPlaylist() {
      if (!st.target) return;
      const r = await S.Platform.PlaylistAPI.getContents(st.target, { limit: 2000 });
      const items = (r && (r.items || r)) || [];
      const uris = items.map((i) => i.uri).filter(isTrack);
      if (!uris.length) return; // never wipe state on an empty read
      const names = {};
      for (const i of items) if (isTrack(i.uri)) names[i.uri] = (i.name || "?") + " - " + ((i.artists || []).map((a) => a.name).join(", "));
      sync(st, [...new Set(uris)], Date.now(), names);
      saveState();
    }

    function learn(ev) {
      if (!st.target) return; // set up once via the menu; then every track you play is learned
      const now = Date.now();
      decay(st, now);
      ensure(st, ev.uri, now, ev.name + " - " + ev.artist);
      if (ev.repeatStreak > 1) replay(st, ev.uri, 1, now);
      else update(st, ev.uri, ev.outcome, now);
      saveState();
    }

    let cur = null;
    let lastTick = Date.now();
    function finish(next) {
      if (!cur || cur.playedMs < 200) return;
      const prev = log[log.length - 1];
      const ev = {
        ts: Date.now(), uri: cur.uri, name: cur.name, artist: cur.artist, ctx: cur.ctx, dur: cur.dur,
        playedMs: Math.round(cur.playedMs), lastPct: +cur.lastPct.toFixed(3),
        outcome: classify(cur),
        jump: !!next && next.uri !== cur.nextUri,
        repeatStreak: prev && prev.uri === cur.uri ? (prev.repeatStreak || 1) + 1 : 1,
      };
      log.push(ev);
      saveLog();
      try { learn(ev); } catch (e) { console.warn("[SmartShuffle] learn failed", e); }
    }
    function tick() {
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;
      const s = snapshot();
      if (!s) return;
      if (!cur || cur.pid !== s.pid) { finish(s); cur = { ...s, playedMs: 0, lastPct: 0 }; }
      if (s.playing) cur.playedMs += Math.min(dt, 1000);
      cur.lastPct = S.Player.getProgressPercent();
      cur.nextUri = s.nextUri || cur.nextUri;
    }

    // Keep P.ahead tracks in the user queue. The queue updates ~1 s late: lock and wait.
    let busy = false, lastAdd = 0, lastLoad = 0;
    async function control() {
      if (busy || !st.enabled || !st.target) return;
      const s = PA.getState();
      if (!s || !s.item || !s.context || s.context.uri !== st.target) return;
      busy = true;
      try {
        if (s.shuffle === true) PA.setShuffle(false);
        if (Date.now() - lastLoad > 3600000) { lastLoad = Date.now(); await loadPlaylist(); }
        if (Date.now() - lastAdd < 2500) return;
        const q = await PA.getQueue();
        const queued = ((q && q.queued) || []).map((x) => x.uri).filter(isTrack);
        const need = P.ahead - queued.length;
        if (need <= 0) return;
        const now = Date.now();
        decay(st, now);
        const exclude = [s.item.uri, ...queued];
        const add = [];
        for (let i = 0; i < need; i++) {
          const u = pick(st, Math.random, now, exclude);
          if (!u) break;
          add.push({ uri: u });
          exclude.push(u);
        }
        if (add.length) { await PA.addToQueue(add); lastAdd = Date.now(); saveState(); }
      } catch (e) {
        console.warn("[SmartShuffle] control failed", e);
      } finally {
        busy = false;
      }
    }

    // ---------- mini UI ----------
    function initUi() {
      const toast = (m) => S.showNotification(m);
      const pt = /^pt/i.test(navigator.language || "");
      const tr = (en, p) => (pt ? p : en);
      const LEVELS = [["suave", 4], ["padrao", 12], ["radical", 20]];
      const level = () => LEVELS.find((l) => l[1] === (st.k || P.k)) || LEVELS[1];
      try {
        new S.Playbar.Button(tr("Smart Shuffle: I like this one", "Smart Shuffle: gostei desta"), "heart", () => {
          const s = snapshot();
          if (!s || !st.target || !like(st, s.uri, Date.now(), s.name + " - " + s.artist)) return toast(tr("Smart Shuffle: set up a playlist first", "Smart Shuffle: escolha uma playlist primeiro"));
          saveState();
          toast(tr("Smart Shuffle: liked ", "Smart Shuffle: gostei de ") + s.name);
        });
      } catch (e) { console.warn("[SmartShuffle] botao falhou", e); }

      const items = [];
      const add = (name, on, fn) => {
        try { const it = new S.Menu.Item(name, on, fn); if (it.register) it.register(); items.push(it); return it; }
        catch (e) { console.warn("[SmartShuffle] menu falhou", e); }
      };
      add(tr("Smart Shuffle: use the playlist playing now", "Smart Shuffle: usar a playlist tocando agora"), false, async (self) => {
        self.setState(false);
        try { const r = await window.SmartShuffle.useCurrent(); st.enabled = true; saveState(); toast("Smart Shuffle: " + r.tracks + tr(" tracks, learning and queue control on", " faixas, aprendizado e fila ligados")); }
        catch (e) { toast(tr("Play a track from a playlist first", "Toque uma faixa de uma playlist primeiro")); }
      });
      add(tr("Smart Shuffle on", "Smart Shuffle ligado"), st.enabled, (self) => { st.enabled = !st.enabled; self.setState(st.enabled); saveState(); toast("Smart Shuffle " + (st.enabled ? tr("on", "ligado") : tr("off", "desligado"))); });
      add(tr("Smart Shuffle: view scores", "Smart Shuffle: ver notas"), false, (self) => { self.setState(false); showScores(); });
      add(tr("Smart Shuffle: aggressiveness", "Smart Shuffle: agressividade"), false, (self) => {
        self.setState(false);
        const next = LEVELS[(LEVELS.indexOf(level()) + 1) % LEVELS.length];
        st.k = next[1]; saveState();
        toast(tr("Smart Shuffle: aggressiveness ", "Smart Shuffle: agressividade ") + next[0] + " (k=" + next[1] + ")");
      });
      add(tr("Smart Shuffle: export backup", "Smart Shuffle: exportar backup"), false, async (self) => {
        self.setState(false);
        try { await navigator.clipboard.writeText(window.SmartShuffle.exportJson()); toast(tr("Backup copied to clipboard", "Backup copiado para a área de transferência")); }
        catch (e) { toast(tr("Could not copy; use SmartShuffle.exportJson() in the console", "Não consegui copiar; use SmartShuffle.exportJson() no console")); }
      });
      add(tr("Smart Shuffle: export CSV (spreadsheet)", "Smart Shuffle: exportar CSV (planilha)"), false, (self) => {
        self.setState(false);
        try {
          const d = window.SmartShuffle.exportCsv(), day = new Date().toISOString().slice(0, 10);
          [["ranking", d.ranking], ["history", d.history]].forEach(([n, txt]) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob(["\ufeff" + txt], { type: "text/csv;charset=utf-8" }));
            a.download = "smartshuffle-" + n + "-" + day + ".csv";
            document.body.appendChild(a); a.click(); a.remove();
          });
          toast(tr("CSV files saved to your Downloads folder", "Arquivos CSV salvos na pasta Downloads"));
        } catch (e) { toast(tr("CSV export failed", "Falha ao exportar CSV")); }
      });
      let armed = 0;
      add(tr("Smart Shuffle: reset scores (click twice)", "Smart Shuffle: resetar notas (2 cliques)"), false, (self) => {
        self.setState(false);
        if (Date.now() - armed > 5000) { armed = Date.now(); return toast(tr("Click again within 5 s to reset all scores", "Clique de novo em até 5 s para zerar as notas")); }
        armed = 0; window.SmartShuffle.reset(); toast(tr("Scores reset", "Notas zeradas"));
      });

      // Look: reuse the client's own design tokens so it follows the active theme (dark/light).
      const T = { text: "var(--text-base, #fff)", sub: "var(--text-subdued, #b3b3b3)", accent: "var(--essential-bright-accent, #1ed760)", hover: "var(--background-tinted-base, rgba(255,255,255,.1))", track: "var(--decorative-subdued, rgba(255,255,255,.2))" };
      const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };

      function row(rank, x) {
        const [title, ...rest] = (x.nome || x.uri).split(" - ");
        const r = el("div", "display:grid;grid-template-columns:28px 1fr 90px;gap:12px;align-items:center;padding:6px 12px;border-radius:var(--encore-corner-radius-base,4px)");
        r.onmouseenter = () => { r.style.background = T.hover; };
        r.onmouseleave = () => { r.style.background = "transparent"; };
        r.appendChild(el("span", "color:" + T.sub + ";text-align:right;font-variant-numeric:tabular-nums", String(x.pos)));
        const col = el("div", "min-width:0");
        col.appendChild(el("div", "color:" + T.text + ";font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", title + (x.hype > 0.1 ? "  \u{1F525}" : "")));
        col.appendChild(el("div", "color:" + T.sub + ";font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", rest.join(" - ")));
        r.appendChild(col);
        const bar = el("div", "height:4px;border-radius:2px;background:" + T.track);
        bar.appendChild(el("div", "height:100%;border-radius:2px;background:" + T.accent + ";width:" + Math.max(3, Math.round(x.pct * 100)) + "%"));
        r.appendChild(bar);
        return r;
      }

      function showScores() {
        const sc = window.SmartShuffle.scores().filter((x) => x.plays > 0 || x.hype > 0 || Math.abs(x.nota - 0.5) > 0.01);
        const box = el("div", "max-height:60vh;overflow:auto;padding-right:8px");
        box.appendChild(el("p", "color:" + T.sub + ";font-size:14px;margin:0 0 16px", tr("Aggressiveness ", "Agressividade ") + level()[0] + " · " + sc.length + tr(" of ", " de ") + st.uris.length + tr(" tracks with history", " faixas com histórico")));
        if (!sc.length) box.appendChild(el("p", "color:" + T.text, tr("No data yet. Listen to a few songs and come back.", "Ainda sem dados. Ouça algumas músicas e volte aqui.")));
        const part = (title, arr) => {
          box.appendChild(el("h3", "color:" + T.text + ";font-size:20px;font-weight:700;margin:16px 0 8px", title));
          arr.forEach((x, i) => box.appendChild(row(i + 1, x)));
        };
        if (sc.length) { part(tr("Most liked", "Mais gostadas"), sc.slice(0, 15)); part(tr("Least liked", "Menos gostadas"), sc.slice(-15).reverse()); }
        S.PopupModal.display({ title: "Smart Shuffle", content: box, isLarge: true });
      }
    }

    const mean = (t) => t.a / (t.a + t.b);
    window.SmartShuffle = {
      version: "v3-ui",
      getLog: () => log.slice(),
      exportJson: () => JSON.stringify({ log, state: st }),
      clear: () => { log = []; saveLog(); },
      getState: () => st,
      useCurrent: async () => {
        const s = PA.getState();
        const c = s && s.context && s.context.uri;
        if (!c || !c.includes(":playlist:")) throw new Error("play a track from the target playlist first");
        st.target = c; // keep all notes: they belong to tracks, not to playlists
        await loadPlaylist();
        return { target: c, tracks: st.uris.length };
      },
      enable: () => { st.enabled = true; lastLoad = 0; saveState(); return "ligado"; },
      disable: () => { st.enabled = false; saveState(); return "desligado"; },
      reset: () => { st = Object.assign(newState(), { target: st.target, enabled: st.enabled }); lastLoad = 0; saveState(); return loadPlaylist(); },
      scores: () => st.uris.map((u) => ({ uri: u, nome: st.t[u].n, nota: +mean(st.t[u]).toFixed(3), hype: +st.t[u].h.toFixed(2), plays: st.t[u].plays })).sort((x, y) => y.nota - x.nota).map((x, i, a) => Object.assign(x, { pos: i + 1, pct: a.length > 1 ? 1 - i / (a.length - 1) : 1 })),
      exportCsv: () => {
        // Quote every field; prefix ' when a value could be read as a spreadsheet formula (CSV injection).
        const q = (v) => { let t = String(v == null ? "" : v); const c = t.charCodeAt(0); if ("=+-@".includes(t[0] || "x") || c === 9 || c === 13) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
        const rank = ["position,name,uri,percentile,plays,hype,a,b"].concat(window.SmartShuffle.scores().map((x) => [x.pos, q(x.nome), q(x.uri), x.pct.toFixed(3), x.plays, x.hype, st.t[x.uri].a.toFixed(2), st.t[x.uri].b.toFixed(2)].join(",")));
        const hist = ["time,name,artist,uri,outcome,played_ms,last_pct,duration_ms,jump,repeat_streak"].concat(log.map((e) => [new Date(e.ts).toISOString(), q(e.name), q(e.artist), q(e.uri), q(e.outcome), e.playedMs, e.lastPct, e.dur, e.jump, e.repeatStreak].join(",")));
        return { ranking: rank.join("\r\n"), history: hist.join("\r\n") };
      },
      status: () => ({ ativo: st.enabled, alvo: st.target, faixas: st.uris.length, eventos: log.length }),
    };
    initUi();
    setInterval(tick, CFG.pollMs);
    setInterval(control, 2000);
    console.log("[SmartShuffle] active. target:", st.target, "ligado:", st.enabled);
  }

  main();
})();
