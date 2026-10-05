// RRG page — relative rotation of the top 20 coins (plus any coin you search)
// against an equal-weight top-20 index (GET /api/rrg/rotation). Drawn on a
// canvas: four quadrants, a fading tail per coin and its head. ▶ replays the
// rotation; coins glide along their own path (positions are interpolated
// between candles), with 0.25x–4x speed and a timeline to scrub.
(function cryptoRrg() {
  const el = (id) => document.getElementById(id);
  const canvas = el("cdRrgCanvas");
  if (!canvas) return;
  const stage = el("cdRrgStage");
  const ctx = canvas.getContext("2d");

  const TF_REFRESH_MS = { "1h": 60e3, "1m": 600e3, "1y": 3600e3 };
  const TAIL_POINTS = 4; // each coin's trail: its last 4 points
  const FRAMES_PER_SEC = 2.2; // at 1x
  const MAX_EXTRA = 10;
  const QUADS = {
    leading: { label: "LEADING", color: "#22c55e" },
    weakening: { label: "WEAKENING", color: "#eab308" },
    lagging: { label: "LAGGING", color: "#ef4444" },
    improving: { label: "IMPROVING", color: "#3b82f6" },
  };
  const PALETTE = ["#f7931a", "#8b9dfc", "#14f195", "#38bdf8", "#facc15", "#f472b6", "#a78bfa", "#fb7185", "#34d399", "#60a5fa",
    "#f97316", "#c084fc", "#2dd4bf", "#e879f9", "#a3e635", "#fbbf24", "#22d3ee", "#f87171", "#4ade80", "#818cf8",
    "#fda4af", "#5eead4", "#fcd34d", "#93c5fd", "#d8b4fe", "#86efac", "#fdba74", "#67e8f9", "#f0abfc", "#bef264"];

  const store = {
    get(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage off */ } },
  };

  let tf = store.get("cdRrgTf", "1h");
  if (!TF_REFRESH_MS[tf]) tf = "1h";
  let extra = store.get("cdRrgExtra", []);
  let hidden = new Set(store.get("cdRrgHidden", []));
  let data = null;
  let frame = 0;
  let playing = false;
  let speed = 1;
  let highlight = null;
  let lastTs = 0;
  let drawDt = 0; // seconds since the last frame while playing (0 = jump straight there)
  let timer = null;
  let loading = false;
  let geom = null;
  const colorOf = new Map();

  const F = () => window.cdFormat || {};
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const onPage = () => document.querySelector(".tab-panel.active")?.dataset.panel === "rrg";
  const visibleCoins = () => (data ? data.coins.filter((c) => !hidden.has(c.base)) : []);
  const lastFrame = () => (data ? Math.max(0, data.times.length - 1) : 0);

  function colorFor(base) {
    if (!colorOf.has(base)) colorOf.set(base, PALETTE[colorOf.size % PALETTE.length]);
    return colorOf.get(base);
  }

  // ---------- data ----------
  async function load() {
    if (loading) return;
    loading = true;
    setStatus(data ? "" : "Loading the top 20 coins…");
    const wanted = tf;
    try {
      const res = await fetch(`/api/rrg/rotation?tf=${tf}&coins=${encodeURIComponent(extra.join(","))}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || "HTTP " + res.status);
      if (wanted !== tf) return;
      const wasAtEnd = !data || frame >= lastFrame() - 0.001;
      data = body;
      data.coins.forEach((c) => colorFor(c.base));
      if (body.skipped && body.skipped.length) {
        extra = extra.filter((b) => !body.skipped.includes(b));
        store.set("cdRrgExtra", extra);
        flash(`${body.skipped.join(", ")}: not enough price history for this timeframe yet.`);
      }
      if (!playing && wasAtEnd) frame = lastFrame();
      frame = Math.min(frame, lastFrame());
      setStatus("");
      renderAll();
      retries = 0;
    } catch (error) {
      setStatus(data ? "" : `Still loading the rotation… (${error.message})`);
      // First load failed: try again soon rather than after a full refresh period.
      if (!data && retries < 6 && onPage()) {
        retries += 1;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(load, 2500 * retries);
      }
    } finally {
      loading = false;
    }
  }
  let retries = 0;
  let retryTimer = null;

  function schedule() {
    clearTimeout(timer);
    if (!onPage()) return;
    timer = setTimeout(async () => {
      if (document.visibilityState === "visible" && onPage() && !playing) await load();
      schedule();
    }, TF_REFRESH_MS[tf]);
  }

  // ---------- geometry ----------
  function resize() {
    const width = stage.clientWidth;
    if (!width) return;
    const height = width < 640
      ? Math.round(Math.min(window.innerHeight * 0.72, Math.max(380, width * 1.22)))
      : Math.round(Math.min(760, Math.max(500, width * 0.62)));
    stage.style.height = height + "px";
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function domain() {
    let dx = 1.2, dy = 1.2;
    visibleCoins().forEach((c) => c.points.forEach((p) => {
      if (!p) return;
      dx = Math.max(dx, Math.abs(p[0] - 100));
      dy = Math.max(dy, Math.abs(p[1] - 100));
    }));
    return { hx: dx * 1.12, hy: dy * 1.12 };
  }

  function pointAt(points, f) {
    const i = Math.floor(f);
    const a = points[i];
    const b = points[Math.min(points.length - 1, i + 1)];
    if (!a) return b || null;
    if (!b) return a;
    const t = f - i;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Smooth position between candles (a Catmull-Rom curve through the
  // points), so the arrow glides through each candle without a sharp turn.
  function smoothAt(points, f) {
    const n = points.length;
    if (n < 2) return points[0] || null;
    f = Math.max(0, Math.min(n - 1, f));
    const i = Math.min(n - 2, Math.floor(f));
    const p1 = points[i], p2 = points[i + 1];
    if (!p1 || !p2) return pointAt(points, f);
    const p0 = points[i - 1] || p1, p3 = points[i + 2] || p2;
    const t = f - i, t2 = t * t, t3 = t2 * t;
    const c = (a, b, d, e) => 0.5 * (2 * b + (d - a) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (3 * b - a - 3 * d + e) * t3);
    return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
  }

  function quadOf(p) {
    if (p[0] >= 100 && p[1] >= 100) return "leading";
    if (p[0] >= 100) return "weakening";
    if (p[1] < 100) return "lagging";
    return "improving";
  }

  // ---------- drawing ----------
  function draw() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const small = W < 640;
    const pad = { l: small ? 44 : 60, r: 12, t: 12, b: small ? 40 : 48 };
    const { hx, hy } = domain();
    const X = (v) => pad.l + ((v - (100 - hx)) / (2 * hx)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - (100 - hy)) / (2 * hy)) * (H - pad.t - pad.b);
    geom = { X, Y };
    const cx = X(100), cy = Y(100);

    // quadrants
    const quad = (x0, y0, x1, y1, key, align, base) => {
      ctx.fillStyle = QUADS[key].color + "14";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = QUADS[key].color + "c0";
      ctx.font = `800 ${small ? 10.5 : 12.5}px Manrope, system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = base;
      ctx.fillText(QUADS[key].label, align === "left" ? x0 + 8 : x1 - 8, base === "top" ? y0 + 8 : y1 - 8);
    };
    quad(cx, pad.t, W - pad.r, cy, "leading", "right", "top");
    quad(cx, cy, W - pad.r, H - pad.b, "weakening", "right", "bottom");
    quad(pad.l, cy, cx, H - pad.b, "lagging", "left", "bottom");
    quad(pad.l, pad.t, cx, cy, "improving", "left", "top");

    // grid + ticks: a step that leaves room for each number on screen
    const step = (h, px, room) => [0.1, 0.25, 0.5, 1, 2, 5, 10].find((st) => (st / (2 * h)) * px >= room) || 10;
    ctx.lineWidth = 1;
    ctx.font = `600 ${small ? 9.5 : 11}px Manrope, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(161,161,181,0.75)";
    const sx = step(hx, W - pad.l - pad.r, small ? 40 : 56), sy = step(hy, H - pad.t - pad.b, small ? 30 : 40);
    for (let v = Math.ceil((100 - hx) / sx) * sx; v <= 100 + hx; v += sx) {
      ctx.strokeStyle = Math.abs(v - 100) < 1e-9 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(X(v), pad.t); ctx.lineTo(X(v), H - pad.b); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(v.toFixed(sx < 0.25 ? 1 : sx < 1 ? (sx === 0.25 ? 2 : 1) : 0), X(v), H - pad.b + 6);
    }
    for (let v = Math.ceil((100 - hy) / sy) * sy; v <= 100 + hy; v += sy) {
      ctx.strokeStyle = Math.abs(v - 100) < 1e-9 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(v.toFixed(sy < 0.25 ? 1 : sy < 1 ? (sy === 0.25 ? 2 : 1) : 0), pad.l - 6, Y(v));
    }
    ctx.fillStyle = "rgba(196,181,253,0.85)";
    ctx.font = `800 ${small ? 9.5 : 11}px Manrope, system-ui, sans-serif`;
    // axis titles sit in the margins, clear of the quadrant names
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("RS-RATIO (relative strength) →", pad.l + (W - pad.l - pad.r) / 2, H - 4);
    ctx.save(); ctx.translate(12, pad.t + (H - pad.t - pad.b) / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("RS-MOMENTUM →", 0, 0); ctx.restore();

    if (!data) return;
    const coins = visibleCoins();
    const tail = TAIL_POINTS;
    const order = coins.slice().sort((a, b) => (a.base === highlight) - (b.base === highlight));
    const labels = [];
    for (const coin of order) {
      const dim = highlight && highlight !== coin.base;
      const color = colorFor(coin.base);
      coin._head = null;
      if (coin._first === undefined) coin._first = coin.points.findIndex((p) => p);
      if (coin._first < 0 || frame < coin._first) continue;
      const head = smoothAt(coin.points, frame);
      if (!head) continue;
      // tail: the last few candles as one smooth curve that slides along
      // with the arrow (no segment drops off at once); older parts fade out
      const span = tail - 1;
      const from0 = Math.max(coin._first, frame - span);
      const steps = Math.max(1, Math.ceil((frame - from0) / 0.08));
      const base = dim ? 0.16 : 1;
      ctx.lineCap = "butt"; ctx.lineJoin = "round"; // butt: the short pieces don't overlap into beads
      ctx.strokeStyle = color;
      ctx.lineWidth = coin.base === highlight ? 3.2 : 2.2;
      let prev = smoothAt(coin.points, from0);
      for (let k = 1; k <= steps && prev; k++) {
        const f = from0 + ((frame - from0) * k) / steps;
        const cur = smoothAt(coin.points, f);
        if (!cur) break;
        ctx.globalAlpha = base * (0.1 + 0.9 * (1 - (frame - f) / span));
        ctx.beginPath();
        ctx.moveTo(X(prev[0]), Y(prev[1]));
        ctx.lineTo(X(cur[0]), Y(cur[1]));
        ctx.stroke();
        prev = cur;
      }
      // a small dot on each candle inside the tail, fading with age
      ctx.fillStyle = color;
      for (let k = Math.ceil(from0); k < frame - 0.15; k++) {
        const p = coin.points[k];
        if (!p) continue;
        ctx.globalAlpha = base * 0.85 * (1 - (frame - k) / span);
        ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 2.2, 0, Math.PI * 2); ctx.fill();
      }
      // head: an arrow along the curve's direction (keeps its last
      // direction while the coin is standing still)
      ctx.globalAlpha = dim ? 0.25 : 1;
      const hxp = X(head[0]), hyp = Y(head[1]);
      const back = smoothAt(coin.points, Math.max(coin._first, frame - 0.12));
      const ahead = frame - 0.12 < coin._first ? smoothAt(coin.points, Math.min(lastFrame(), frame + 0.12)) : null;
      let dx = 0, dy = 0;
      if (ahead) { dx = X(ahead[0]) - hxp; dy = Y(ahead[1]) - hyp; }
      else if (back) { dx = hxp - X(back[0]); dy = hyp - Y(back[1]); }
      let ang = Math.hypot(dx, dy) < 0.05 ? (coin._ang ?? 0) : Math.atan2(dy, dx);
      // While playing, the arrow turns gently toward its new direction
      // instead of snapping round at a sharp corner.
      if (drawDt && coin._ang !== undefined) {
        let turn = ang - coin._ang;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        ang = coin._ang + turn * (1 - Math.exp(-drawDt * 7 * Math.max(1, speed)));
      }
      coin._ang = ang;
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const big = coin.base === highlight;
      const al = big ? 20 : (small ? 14 : 16), aw = big ? 15 : (small ? 11 : 12);
      const bx = hxp - ux * al, by = hyp - uy * al;
      ctx.fillStyle = color;
      ctx.strokeStyle = "#0b0a14";
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(hxp, hyp);
      ctx.lineTo(bx - uy * aw / 2, by + ux * aw / 2);
      ctx.lineTo(bx + uy * aw / 2, by - ux * aw / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      coin._head = [hxp, hyp, head];
      labels.push({ coin, x: hxp, y: hyp, color, dim });
    }
    // Names last, highlighted coin first; a name that would cover another
    // tries the other sides of its dot, else stays hidden (tap shows it).
    ctx.globalAlpha = 1;
    ctx.font = `800 ${small ? 10.5 : 12}px Manrope, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const placed = [];
    const hit = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    labels.sort((a, b) => (b.coin.base === highlight) - (a.coin.base === highlight));
    for (const l of labels) {
      const w = ctx.measureText(l.coin.base).width + 4, h = small ? 13 : 15;
      const spots = [[9, -h / 2 - 7], [9, -h / 2 + 7], [-w - 9, -h / 2 - 7], [-w - 9, -h / 2 + 7], [-w / 2, -h - 10], [-w / 2, 10]];
      const forced = l.coin.base === highlight;
      let spot = spots.find(([dx, dy]) => { const r = { x: l.x + dx, y: l.y + dy, w, h }; return r.x > pad.l && r.x + r.w < W - pad.r && r.y > pad.t && r.y + r.h < H - pad.b && !hit(r); });
      if (!spot && forced) spot = spots[0];
      if (!spot) continue;
      const r = { x: l.x + spot[0], y: l.y + spot[1], w, h };
      placed.push(r);
      ctx.globalAlpha = l.dim ? 0.3 : 1;
      ctx.textAlign = "left";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(8,7,16,0.9)";
      ctx.strokeText(l.coin.base, r.x + 2, r.y + h / 2);
      ctx.fillStyle = forced ? "#ffffff" : l.color;
      ctx.fillText(l.coin.base, r.x + 2, r.y + h / 2);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- page parts ----------
  function fmtTime(ts) {
    if (!ts) return "--";
    const d = new Date(ts);
    if (data && data.interval === "1h") return d.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    if (data && data.interval === "1w") return "Week of " + d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
    return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
  }

  function renderPlayer() {
    const n = lastFrame();
    el("cdRrgScrub").value = n ? Math.round((frame / n) * 1000) : 1000;
    el("cdRrgWhen").textContent = data ? fmtTime(data.times[Math.round(frame)]) : "--";
    el("cdRrgPlay").textContent = playing ? "❚❚" : "▶";
    el("cdRrgPlay").setAttribute("aria-label", playing ? "Pause" : "Play");
    el("cdRrgPlay").classList.toggle("is-playing", playing);
    el("cdRrgLive").classList.toggle("is-replay", playing || frame < n - 0.001);
    el("cdRrgLive").lastChild.textContent = playing ? "REPLAY" : frame < n - 0.001 ? "PAUSED" : "LIVE";
  }

  function heading(points) {
    const real = points.filter(Boolean);
    if (real.length < 2) return { arrow: "•", cls: "" };
    const [a, b] = real.slice(-2);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const arrow = dx >= 0 ? (dy >= 0 ? "↗" : "↘") : (dy >= 0 ? "↖" : "↙");
    return { arrow, cls: dx >= 0 && dy >= 0 ? "cd-up" : dx < 0 && dy < 0 ? "cd-down" : "" };
  }

  function renderSide() {
    if (!data) return;
    const f = F();
    const coins = visibleCoins();
    el("cdRrgReset").hidden = !(extra.length || hidden.size);
    // quadrant summary
    const groups = { leading: [], weakening: [], lagging: [], improving: [] };
    coins.forEach((c) => groups[c.quadrant].push(c.base));
    el("cdRrgQuads").innerHTML = ["leading", "weakening", "lagging", "improving"].map((q) => `<div class="cd-rrg-quad is-${q}">
        <span>${QUADS[q].label}</span><b>${groups[q].length}</b><small>${esc(groups[q].slice(0, 6).join(" · ")) || "—"}${groups[q].length > 6 ? " …" : ""}</small></div>`).join("");
    // table
    const rank = { leading: 0, weakening: 1, improving: 2, lagging: 3 };
    // Every coin is listed — hidden ones dimmed — with its show / hide
    // switch, and × for coins added by search.
    el("cdRrgBody").innerHTML = data.coins.slice().sort((a, b) => hidden.has(a.base) - hidden.has(b.base) || rank[a.quadrant] - rank[b.quadrant] || b.ratio - a.ratio).map((c) => {
      const h = heading(c.points);
      const off = hidden.has(c.base);
      const added = extra.includes(c.base);
      return `<tr data-rrg-row="${esc(c.base)}" class="${highlight === c.base ? "is-hl" : ""}${off ? " is-off" : ""}">
        <td><span class="cd-rrg-dot" style="background:${colorFor(c.base)}"></span><strong>${esc(c.base)}</strong></td>
        <td><span class="cd-rrg-q is-${c.quadrant}">${QUADS[c.quadrant].label}</span></td>
        <td class="cd-num">${c.ratio.toFixed(2)}</td>
        <td class="cd-num">${c.momentum.toFixed(2)}</td>
        <td class="cd-num ${h.cls}">${h.arrow}</td>
        <td class="cd-num ${f.pctClass ? f.pctClass(c.change_percent) : ""}">${c.change_percent != null && f.fmtPct ? f.fmtPct(c.change_percent) : "--"}</td>
        <td class="cd-rrg-act"><button type="button" class="cd-rrg-eye${off ? "" : " is-on"}" data-rrg-x="${esc(c.base)}" aria-label="${off ? "Show" : "Hide"} ${esc(c.base)} on the chart"><i></i></button>${added ? `<button type="button" class="cd-rrg-del" data-rrg-del="${esc(c.base)}" aria-label="Remove ${esc(c.base)}">×</button>` : ""}</td>
      </tr>`;
    }).join("");
    el("cdRrgMeta").textContent = `${coins.length} coins vs ${data.benchmark} · ${data.label} · updated ${new Date(data.updated_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function renderAll() {
    draw();
    renderPlayer();
    renderSide();
  }

  function setStatus(text) {
    const s = el("cdRrgStatus");
    s.textContent = text || "";
    s.hidden = !text;
  }

  let flashTimer = null;
  function flash(text) {
    setStatus(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setStatus(""), 3500);
  }

  // ---------- playback ----------
  function tick(ts) {
    if (!playing) return;
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    frame = Math.min(lastFrame(), frame + dt * FRAMES_PER_SEC * speed);
    drawDt = dt;
    draw();
    drawDt = 0;
    renderPlayer();
    if (frame >= lastFrame()) { playing = false; renderAll(); schedule(); return; }
    requestAnimationFrame(tick);
  }

  function play() {
    if (!data) return;
    if (frame >= lastFrame() - 0.001) frame = 0; // replay from the start
    playing = true;
    lastTs = 0;
    hideTip();
    renderPlayer();
    requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    renderAll();
  }

  // ---------- tooltip / highlight ----------
  function hideTip() { el("cdRrgTip").hidden = true; }

  function showTip(coin) {
    const tip = el("cdRrgTip");
    if (!coin || !coin._head) { hideTip(); return; }
    const [x, y, p] = coin._head;
    const f = F();
    const q = quadOf(p);
    tip.innerHTML = `<strong style="color:${colorFor(coin.base)}">${esc(coin.base)}</strong><span class="cd-rrg-q is-${q}">${QUADS[q].label}</span>
      <div><small>RS-Ratio</small><b>${p[0].toFixed(2)}</b></div><div><small>RS-Momentum</small><b>${p[1].toFixed(2)}</b></div>
      ${coin.price != null && f.fmtUsd ? `<div><small>Price</small><b>${f.fmtUsd(coin.price)}</b></div>` : ""}`;
    tip.hidden = false;
    const sw = stage.clientWidth;
    const left = Math.min(sw - tip.offsetWidth - 6, Math.max(6, x + 14));
    const top = Math.max(6, y - tip.offsetHeight - 10);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function setHighlight(base, withTip) {
    highlight = base;
    renderAll();
    if (withTip && base) showTip(visibleCoins().find((c) => c.base === base)); else hideTip();
  }

  function nearest(evt) {
    const r = canvas.getBoundingClientRect();
    const x = evt.clientX - r.left, y = evt.clientY - r.top;
    let best = null, bestD = 22 * 22;
    visibleCoins().forEach((c) => {
      if (!c._head) return;
      const d = (c._head[0] - x) ** 2 + (c._head[1] - y) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }

  canvas.addEventListener("click", (evt) => {
    const coin = nearest(evt);
    setHighlight(coin ? (highlight === coin.base ? null : coin.base) : null, !!coin);
  });
  canvas.addEventListener("mousemove", (evt) => {
    if (playing) return;
    const coin = nearest(evt);
    canvas.style.cursor = coin ? "pointer" : "default";
    if (coin && !highlight) showTip(coin); else if (!highlight) hideTip();
  });
  canvas.addEventListener("mouseleave", () => { if (!highlight) hideTip(); });

  // ---------- search ----------
  const search = el("cdRrgSearch");
  const suggest = el("cdRrgSuggest");
  function suggestions(q) {
    const coins = (window.cdMarkets && window.cdMarkets.coins) || [];
    const shown = new Set((data ? data.coins : []).map((c) => c.base));
    return coins.filter((c) => c.base.includes(q)).sort((a, b) => (a.base.startsWith(q) ? 0 : 1) - (b.base.startsWith(q) ? 0 : 1) || (b.volume_usdt || 0) - (a.volume_usdt || 0)).slice(0, 8).map((c) => ({ base: c.base, shown: shown.has(c.base) }));
  }
  function renderSuggest() {
    const q = search.value.trim().toUpperCase();
    if (!q) { suggest.hidden = true; return; }
    const list = suggestions(q);
    suggest.innerHTML = list.length ? list.map((s) => `<button type="button" data-rrg-add="${esc(s.base)}">${F().avatar ? F().avatar(s.base) : ""}<span>${esc(s.base)}<small>/USDT</small></span>${s.shown ? "<em>on chart</em>" : "<em>+ add</em>"}</button>`).join("")
      : '<p class="cd-meta">No coin found</p>';
    suggest.hidden = false;
  }
  function addCoin(base) {
    search.value = "";
    suggest.hidden = true;
    const onChart = data && data.coins.some((c) => c.base === base);
    if (hidden.has(base)) { hidden.delete(base); store.set("cdRrgHidden", [...hidden]); }
    if (!onChart) {
      if (extra.length >= MAX_EXTRA) { flash(`Up to ${MAX_EXTRA} extra coins — remove one first.`); return; }
      extra.push(base);
      store.set("cdRrgExtra", extra);
      highlight = base;
      load().then(() => setHighlight(base, true));
      return;
    }
    setHighlight(base, true);
  }
  search.addEventListener("input", renderSuggest);
  search.addEventListener("focus", renderSuggest);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = suggestions(search.value.trim().toUpperCase())[0];
      if (first) addCoin(first.base);
    } else if (e.key === "Escape") { suggest.hidden = true; }
  });
  document.addEventListener("click", (e) => {
    const add = e.target.closest("[data-rrg-add]");
    if (add) { addCoin(add.dataset.rrgAdd); return; }
    if (!e.target.closest(".cd-rrg-search")) suggest.hidden = true;
  });

  // ---------- controls ----------
  el("cdRrgPlay").addEventListener("click", () => (playing ? pause() : play()));
  el("cdRrgScrub").addEventListener("input", (e) => {
    playing = false;
    frame = (Number(e.target.value) / 1000) * lastFrame();
    draw();
    renderPlayer();
  });
  el("cdRrgSpeeds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rrg-speed]");
    if (!b) return;
    speed = Number(b.dataset.rrgSpeed) || 1;
    el("cdRrgSpeeds").querySelectorAll("button").forEach((x) => x.classList.toggle("is-active", x === b));
  });
  el("cdRrgTfs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rrg-tf]");
    if (!b || b.dataset.rrgTf === tf) return;
    tf = b.dataset.rrgTf;
    store.set("cdRrgTf", tf);
    el("cdRrgTfs").querySelectorAll("[data-rrg-tf]").forEach((x) => x.classList.toggle("is-active", x === b));
    playing = false;
    data = null;
    frame = 0;
    hideTip();
    draw();
    load();
    schedule();
  });
  document.addEventListener("click", (e) => {
    const x = e.target.closest("[data-rrg-x]");
    if (x) {
      const base = x.dataset.rrgX;
      if (hidden.has(base)) hidden.delete(base);
      else hidden.add(base);
      store.set("cdRrgHidden", [...hidden]);
      if (highlight === base) highlight = null;
      hideTip();
      renderAll();
      return;
    }
    const del = e.target.closest("[data-rrg-del]");
    if (del) {
      const base = del.dataset.rrgDel;
      extra = extra.filter((b) => b !== base);
      hidden.delete(base);
      store.set("cdRrgExtra", extra);
      store.set("cdRrgHidden", [...hidden]);
      if (data) data.coins = data.coins.filter((c) => c.base !== base);
      if (highlight === base) highlight = null;
      hideTip();
      renderAll();
      return;
    }
    if (e.target.closest("#cdRrgReset")) {
      extra = []; hidden = new Set(); highlight = null;
      store.set("cdRrgExtra", extra); store.set("cdRrgHidden", []);
      hideTip();
      load();
      return;
    }
    const row = e.target.closest("[data-rrg-row]");
    if (row) {
      const base = row.dataset.rrgRow;
      if (hidden.has(base)) { hidden.delete(base); store.set("cdRrgHidden", [...hidden]); highlight = null; }
      setHighlight(highlight === base ? null : base, true);
      stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  // ---------- page life ----------
  el("cdRrgTfs").querySelectorAll("[data-rrg-tf]").forEach((x) => x.classList.toggle("is-active", x.dataset.rrgTf === tf));
  function open() {
    requestAnimationFrame(() => { resize(); if (!data) load(); else renderAll(); schedule(); });
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest('.app-tab[data-tab="rrg"]')) setTimeout(() => { if (onPage()) open(); }, 0);
    else if (e.target.closest(".app-tab")) setTimeout(() => { if (!onPage()) { clearTimeout(timer); playing = false; } }, 0);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && onPage()) { load(); schedule(); } });
  if (window.ResizeObserver) new ResizeObserver(() => { if (onPage()) resize(); }).observe(stage);
  else window.addEventListener("resize", resize);
  // The page can also become active without a click — e.g. the app reopens
  // on the last page used — so watch the panel itself.
  const panel = canvas.closest(".tab-panel");
  if (panel) {
    let wasActive = panel.classList.contains("active");
    new MutationObserver(() => {
      const active = panel.classList.contains("active");
      if (active === wasActive) return;
      wasActive = active;
      if (active) open();
      else { clearTimeout(timer); playing = false; }
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
  if (onPage()) open();
})();
