/* Bitcoin Weather — front end. No build step; uses d3-geo + topojson from /vendor. */
(() => {
  "use strict";

  const WINDOW = 12;              // map shows the last 12 slots (3 hours)
  const TL_SMOOTH = 4;            // timeline uses a 1-hour rolling average
  const MIN_COUNTRY_N = 3;        // need this many articles to shade a country
  const MAX_ZOOM = 10;
  const DATA_URL = "/data/weather.json";
  const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const REGIONS = [
    { id: "world", label: "World" },
    { id: "us", label: "United States", box: [-125, 24, -66, 50] },
    { id: "europe", label: "Europe", box: [-12, 35, 40, 62] },
    { id: "asia", label: "Asia", box: [65, -10, 148, 50] },
    { id: "americas", label: "Americas", box: [-128, -50, -34, 58] },
    { id: "mea", label: "Africa & Middle East", box: [-18, -35, 60, 38] },
    { id: "oceania", label: "Oceania", box: [110, -47, 179, -5] },
  ];

  const $ = (id) => document.getElementById(id);
  const canvas = $("map"), ctx = canvas.getContext("2d");
  const stage = $("stage"), tip = $("tip"), sheet = $("sheet");
  $("yr").textContent = new Date().getFullYear();

  // ---------- color + conditions ----------
  const STOPS = [[-4, [61, 108, 240]], [-1.5, [124, 158, 242]], [0, [138, 143, 156]], [1.5, [242, 196, 107]], [4, [255, 178, 30]]];
  function toneRGB(t) {
    t = Math.max(-4, Math.min(4, t));
    for (let i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], k = (t - a) / (b - a);
        return ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  function condition(t) {
    if (t == null) return { key: "none", label: "No data" };
    if (t >= 1) return { key: "sun", label: "Sunny" };
    if (t >= 0) return { key: "partly", label: "Partly sunny" };
    if (t >= -1.5) return { key: "cloud", label: "Cloudy" };
    if (t >= -3) return { key: "rain", label: "Rain" };
    return { key: "storm", label: "Storms" };
  }
  const fmtTone = (t) => (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t).toFixed(1);

  const ICONS = {
    sun: `<svg viewBox="0 0 56 56"><g class="spin" stroke="#ffc94d" stroke-width="3" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>`<line x1="28" y1="6" x2="28" y2="12" transform="rotate(${a} 28 28)"/>`).join("")}</g><circle cx="28" cy="28" r="11" fill="#ffc94d"/></svg>`,
    partly: `<svg viewBox="0 0 56 56"><circle cx="22" cy="22" r="10" fill="#ffc94d"/><path d="M18 42h22a8 8 0 0 0 0-16 11 11 0 0 0-21 3 7 7 0 0 0-1 13z" fill="#c9d2e6"/></svg>`,
    cloud: `<svg viewBox="0 0 56 56"><path d="M14 40h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#aab3c8"/></svg>`,
    rain: `<svg viewBox="0 0 56 56"><path d="M14 32h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#8d97b0"/><g stroke="#7c9ef2" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="38" x2="16" y2="46"/><line x1="28" y1="38" x2="25" y2="46"/><line x1="37" y1="38" x2="34" y2="46"/></g></svg>`,
    storm: `<svg viewBox="0 0 56 56"><path d="M14 30h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#6b748c"/><path d="M30 30l-7 11h6l-4 10 11-14h-6l4-7z" fill="#ffd34d"/><g stroke="#5b8cff" stroke-width="2.5" stroke-linecap="round"><line x1="17" y1="36" x2="14" y2="44"/><line x1="42" y1="36" x2="39" y2="44"/></g></svg>`,
    none: `<svg viewBox="0 0 56 56"><circle cx="28" cy="28" r="12" fill="none" stroke="#56607a" stroke-width="2" stroke-dasharray="4 4"/></svg>`,
  };

  // ---------- state ----------
  let data = null, world = null, features = [], mesh = null;
  let projection = null, baseProj = null, path = null, k0 = 1, t0 = [0, 0];
  let zoom = { k: 1, x: 0, y: 0 }, zoomAnim = null, region = "world";
  let mode = "all";
  let sel = 0, live = true, playTimer = null;
  let view = null, selected = null, hoverIdx = -1;
  let W = 0, H = 0, dpr = 1, scale = 1;
  const base = document.createElement("canvas"), bctx = base.getContext("2d");
  let baseDirty = true, running = false, visible = true;
  const cellCountry = new Map();
  let particles = [], flashes = [];
  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  // ---------- helpers ----------
  const slotDate = (sid) => new Date(Date.UTC(+sid.slice(0, 4), +sid.slice(4, 6) - 1, +sid.slice(6, 8), +sid.slice(8, 10), +sid.slice(10, 12)));
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtDay = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const chip = (t) => `<span class="chip"><i style="background:${rgba(toneRGB(t), 1)}"></i>${fmtTone(t)}</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const countryName = (i) => { const n = features[i].properties.name; return n === "United States of America" ? "United States" : n; };
  const slotN = (s) => (mode === "all" ? s.n : s.fn || 0);
  const slotTone = (s) => (mode === "all" ? s.tone : s.ftone || 0);
  const cellNT = (c) => (mode === "all" ? [c[2], c[3]] : [c[4] || 0, c[5] || 0]);
  const headOK = (h) => mode === "all" || h.f;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2200); }

  function countryOf(lat, lon) {
    const key = lat + "," + lon;
    if (cellCountry.has(key)) return cellCountry.get(key);
    let found = -1;
    for (let i = 0; i < features.length; i++) {
      const b = features[i]._bounds;
      const wraps = b[0][0] > b[1][0];
      if (!wraps && (lon < b[0][0] - 1 || lon > b[1][0] + 1 || lat < b[0][1] - 1 || lat > b[1][1] + 1)) continue;
      if (d3.geoContains(features[i], [lon, lat])) { found = i; break; }
    }
    cellCountry.set(key, found);
    return found;
  }
  function countryAt(ll) {
    if (!ll) return -1;
    for (let i = 0; i < features.length; i++) if (d3.geoContains(features[i], ll)) return i;
    return -1;
  }
  const placeName = (lat, lon) => (data && data.names && data.names[lat + "," + lon]) || null;

  // ---------- projection & zoom ----------
  function applyZoom() {
    projection.scale(k0 * zoom.k).translate([t0[0] * zoom.k + zoom.x, t0[1] * zoom.k + zoom.y]);
    baseDirty = true;
  }
  function clampZoom(z) {
    const k = Math.max(1, Math.min(MAX_ZOOM, z.k));
    return { k, x: Math.min(0, Math.max(W - W * k, z.x)), y: Math.min(0, Math.max(H - H * k, z.y)) };
  }
  function setZoom(z, animate) {
    z = clampZoom(z);
    if (!animate || reduceMotion) { zoomAnim = null; zoom = z; applyZoom(); return; }
    zoomAnim = { from: { ...zoom }, to: z, t0: performance.now(), dur: 650 };
  }
  function zoomAt(px, py, factor, animate) {
    const k = Math.max(1, Math.min(MAX_ZOOM, zoom.k * factor)), r = k / zoom.k;
    setZoom({ k, x: px - (px - zoom.x) * r, y: py - (py - zoom.y) * r }, animate);
  }
  function zoomToBox(box) {
    if (!box) return setZoom({ k: 1, x: 0, y: 0 }, true);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const lon = box[0] + (box[2] - box[0]) * i / 8, lat = box[1] + (box[3] - box[1]) * i / 8;
      pts.push([lon, box[1]], [lon, box[3]], [box[0], lat], [box[2], lat]);
    }
    const xy = pts.map((p) => baseProj(p)).filter(Boolean);
    const x0 = Math.min(...xy.map((p) => p[0])), x1 = Math.max(...xy.map((p) => p[0]));
    const y0 = Math.min(...xy.map((p) => p[1])), y1 = Math.max(...xy.map((p) => p[1]));
    const k = Math.min(MAX_ZOOM, 0.92 * Math.min(W / (x1 - x0), H / (y1 - y0)));
    setZoom({ k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k }, true);
  }
  function zoomToCountry(i) {
    const b = features[i]._bounds;
    let box = [b[0][0], b[0][1], b[1][0], b[1][1]];
    if (box[0] > box[2]) box = [box[0], box[1], box[2] + 360, box[3]];
    const padLon = Math.max(4, (box[2] - box[0]) * 0.25), padLat = Math.max(3, (box[3] - box[1]) * 0.25);
    zoomToBox([box[0] - padLon, box[1] - padLat, box[2] + padLon, box[3] + padLat]);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const oldW = W;
    W = Math.max(280, r.width); H = Math.max(150, r.height);
    for (const c of [canvas, base]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.max(0.62, Math.min(1.1, W / 1100));
    if (!world) return;
    const fc = { type: "FeatureCollection", features };
    baseProj = d3.geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], fc);
    projection = d3.geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], fc);
    k0 = baseProj.scale(); t0 = baseProj.translate();
    path = d3.geoPath(projection, bctx);
    if (oldW && oldW !== W) { const r2 = W / oldW; zoom = clampZoom({ k: zoom.k, x: zoom.x * r2, y: zoom.y * r2 }); }
    applyZoom();
  }

  // ---------- aggregation ----------
  function aggregate(endIdx) {
    const slots = data.slots, start = Math.max(0, endIdx - WINDOW + 1);
    const cells = new Map(), countries = new Map();
    let n = 0, tone = 0;
    for (let i = start; i <= endIdx; i++) {
      const s = slots[i]; n += slotN(s); tone += slotTone(s);
      for (const c of s.cells) {
        const [cn, ct] = cellNT(c); if (!cn) continue;
        const key = c[0] + "," + c[1];
        const a = cells.get(key) || { key, lat: c[0], lon: c[1], n: 0, tone: 0 };
        a.n += cn; a.tone += ct; cells.set(key, a);
      }
    }
    for (const c of cells.values()) {
      c.avg = c.tone / c.n;
      c.country = countryOf(c.lat, c.lon);
      c.phase = Math.abs(c.lat * 13.7 + c.lon * 7.1) % 6.28;
      if (c.country >= 0) {
        const a = countries.get(c.country) || { idx: c.country, n: 0, tone: 0 };
        a.n += c.n; a.tone += c.tone; countries.set(c.country, a);
      }
    }
    for (const a of countries.values()) a.avg = a.tone / a.n;
    // previous window, for the trend arrow
    let pn = 0, pt = 0;
    for (let i = Math.max(0, start - WINDOW); i < start; i++) { pn += slotN(slots[i]); pt += slotTone(slots[i]); }
    const cellList = [...cells.values()].sort((a, b) => b.n - a.n);
    return { start, end: endIdx, n, avg: n ? tone / n : null, prev: pn ? pt / pn : null, cells: cellList, countries };
  }

  // ---------- drawing ----------
  function drawBase() {
    bctx.clearRect(0, 0, W, H);
    bctx.beginPath(); path(d3.geoGraticule10()); bctx.strokeStyle = "rgba(60,75,110,.22)"; bctx.lineWidth = 0.6; bctx.stroke();
    features.forEach((f, i) => {
      const a = view && view.countries.get(i);
      bctx.beginPath(); path(f);
      bctx.fillStyle = a && a.n >= MIN_COUNTRY_N ? rgba(toneRGB(a.avg), 0.42) : "#1a2440";
      bctx.fill();
    });
    bctx.beginPath(); path(mesh); bctx.strokeStyle = "#0b1020"; bctx.lineWidth = 0.8; bctx.stroke();
    const hi = selected && selected.type === "country" ? selected.idx : hoverIdx;
    if (hi >= 0) { bctx.beginPath(); path(features[hi]); bctx.strokeStyle = "rgba(233,237,247,.85)"; bctx.lineWidth = 1.5; bctx.stroke(); }
    baseDirty = false;
  }

  function cellRadius(c) { return (6 + 6 * Math.sqrt(c.n)) * scale * Math.sqrt(zoom.k); }

  function spawnParticles() {
    if (reduceMotion || !view) return;
    for (const c of view.cells) {
      const p = projection([c.lon, c.lat]); if (!p || p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
      const r = cellRadius(c);
      if (c.avg < -1.5 && Math.random() < 0.05 * Math.min(c.n, 8) && particles.length < 450) {
        particles.push({ kind: "rain", x: p[0] + (Math.random() - .5) * r * 1.6, y: p[1] - r * .6 + Math.random() * r * .4, vx: -0.25, vy: 1.5 + Math.random(), life: r * 0.9, age: 0 });
      } else if (c.avg >= 1 && Math.random() < 0.035 * Math.min(c.n, 8) && particles.length < 450) {
        particles.push({ kind: "spark", x: p[0] + (Math.random() - .5) * r, y: p[1] + (Math.random() - .5) * r * .5, vx: 0, vy: -0.35, life: 40, age: 0 });
      }
      if (c.avg < -3 && c.n >= 2 && Math.random() < 0.004) flashes.push({ x: p[0], y: p[1], r, age: 0, seed: Math.random() });
    }
  }

  function frame(ts) {
    if (!running) return;
    if (!projection) { requestAnimationFrame(frame); return; }
    const t = ts / 1000;
    if (zoomAnim) {
      const q = Math.min(1, (ts - zoomAnim.t0) / zoomAnim.dur), e = 1 - Math.pow(1 - q, 3);
      const f = zoomAnim.from, to = zoomAnim.to;
      // interpolate in log-scale for a natural fly-to
      const k = Math.exp(Math.log(f.k) + (Math.log(to.k) - Math.log(f.k)) * e);
      const cx = W / 2, cy = H / 2;
      const fx = (cx - f.x) / f.k, fy = (cy - f.y) / f.k, tx = (cx - to.x) / to.k, ty = (cy - to.y) / to.k;
      const mx = fx + (tx - fx) * e, my = fy + (ty - fy) * e;
      zoom = { k, x: cx - mx * k, y: cy - my * k };
      if (q >= 1) { zoom = to; zoomAnim = null; particles = []; }
      applyZoom();
    }
    if (baseDirty) drawBase();
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0, W, H);
    if (view && projection) {
      // radar sweep
      if (!reduceMotion) {
        const sx = ((t % 9) / 9) * (W + 300) - 150;
        const g = ctx.createLinearGradient(sx - 120, 0, sx + 30, 0);
        g.addColorStop(0, "rgba(159,186,255,0)"); g.addColorStop(0.85, "rgba(159,186,255,.05)"); g.addColorStop(1, "rgba(159,186,255,0)");
        ctx.fillStyle = g; ctx.fillRect(sx - 120, 0, 150, H);
      }
      ctx.globalCompositeOperation = "lighter";
      for (const c of view.cells) {
        const p = projection([c.lon, c.lat]); if (!p) continue;
        const r0 = cellRadius(c);
        if (p[0] < -r0 || p[0] > W + r0 || p[1] < -r0 || p[1] > H + r0) continue;
        const col = toneRGB(c.avg);
        const pulse = reduceMotion ? 1 : 1 + 0.08 * Math.sin(t * 1.6 + c.phase);
        const drift = reduceMotion ? 0 : Math.sin(t * 0.4 + c.phase) * 2 * scale;
        const r = r0 * pulse, x = p[0] + drift, y = p[1];
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(0.45, rgba(col, 0.22)); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      const dot = 2.2 + Math.min(2, (zoom.k - 1) * 0.4);
      for (const c of view.cells) {
        const p = projection([c.lon, c.lat]); if (!p) continue;
        const isSel = selected && selected.type === "spot" && selected.key === c.key;
        ctx.beginPath(); ctx.arc(p[0], p[1], isSel ? dot + 2 : dot, 0, Math.PI * 2);
        ctx.fillStyle = rgba(toneRGB(c.avg), 0.95); ctx.fill();
        ctx.lineWidth = isSel ? 2 : 1; ctx.strokeStyle = isSel ? "#e9edf7" : "rgba(11,16,32,.9)"; ctx.stroke();
      }
      // place labels when zoomed in
      if (zoom.k >= 2.2 && data.names) {
        ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "middle";
        const placed = [];
        for (const c of view.cells.slice(0, 40)) {
          const nm = placeName(c.lat, c.lon); if (!nm) continue;
          const p = projection([c.lon, c.lat]); if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
          const label = nm.split(",")[0], w = ctx.measureText(label).width, x = p[0] + 7, y = p[1];
          if (placed.some((b) => x < b[2] && x + w > b[0] && y - 7 < b[3] && y + 7 > b[1])) continue;
          placed.push([x, y - 7, x + w, y + 7]);
          ctx.lineWidth = 3; ctx.strokeStyle = "rgba(11,16,32,.85)"; ctx.strokeText(label, x, y);
          ctx.fillStyle = "#dfe5f3"; ctx.fillText(label, x, y);
          if (placed.length >= 12) break;
        }
      }
      spawnParticles();
      ctx.lineCap = "round";
      particles = particles.filter((q) => {
        q.age++; q.x += q.vx; q.y += q.vy;
        const a = 1 - q.age / q.life; if (a <= 0) return false;
        if (q.kind === "rain") {
          ctx.strokeStyle = `rgba(150,180,255,${0.55 * a})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + q.vx * 3, q.y + q.vy * 3); ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(255,214,120,${0.8 * a})`;
          ctx.beginPath(); ctx.arc(q.x, q.y, 1.3, 0, Math.PI * 2); ctx.fill();
        }
        return true;
      });
      flashes = flashes.filter((f) => {
        f.age++; if (f.age > 14) return false;
        const a = 1 - f.age / 14;
        ctx.fillStyle = `rgba(200,215,255,${0.18 * a})`; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 1.3, 0, Math.PI * 2); ctx.fill();
        if (f.age < 7) {
          ctx.strokeStyle = `rgba(255,236,150,${a})`; ctx.lineWidth = 1.6; ctx.beginPath();
          let x = f.x + (f.seed - .5) * f.r * .6, y = f.y - f.r * .7; ctx.moveTo(x, y);
          for (let k = 1; k <= 4; k++) { x += Math.sin(f.seed * 50 * k) * 0.5 * f.r * 0.35; y += f.r * 0.32; ctx.lineTo(x, y); }
          ctx.stroke();
        }
        return true;
      });
    }
    requestAnimationFrame(frame);
  }
  function setRunning(on) {
    if (on && !running) { running = true; requestAnimationFrame(frame); }
    else if (!on) running = false;
  }
  const updateRunning = () => setRunning(visible && !document.hidden);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; updateRunning(); }).observe(stage);
  document.addEventListener("visibilitychange", updateRunning);

  // ---------- hit testing ----------
  function hitTest(px, py) {
    let best = null, bd = 1e9;
    const minHit = isTouch ? 20 : 10;
    for (const c of view.cells) {
      const p = projection([c.lon, c.lat]); if (!p) continue;
      const d = Math.hypot(p[0] - px, p[1] - py);
      if (d < Math.max(minHit, cellRadius(c) * 0.55) && d < bd) { best = c; bd = d; }
    }
    return { cell: best, country: countryAt(projection.invert([px, py])) };
  }

  // ---------- pointer: tap, drag-pan, pinch, hover ----------
  const pts = new Map();
  let gesture = null, lastTap = 0;
  const localXY = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function syncTouchAction() { canvas.style.touchAction = zoom.k > 1.01 ? "none" : "pan-y"; }

  canvas.addEventListener("pointerdown", (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already released */ }
    pts.set(e.pointerId, localXY(e));
    zoomAnim = null;
    if (pts.size === 1) gesture = { type: "maybeTap", start: localXY(e), t: performance.now(), z: { ...zoom } };
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      gesture = { type: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]), m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z: { ...zoom } };
    }
    hideTip();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!view || !projection) return;
    const p = localXY(e);
    if (!pts.has(e.pointerId)) { if (e.pointerType === "mouse") hover(e, p); return; }
    pts.set(e.pointerId, p);
    if (gesture && gesture.type === "pinch" && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = gesture.z, k = Math.max(1, Math.min(MAX_ZOOM, z.k * d / gesture.d0)), r = k / z.k;
      zoom = clampZoom({ k, x: m[0] - (gesture.m0[0] - z.x) * r, y: m[1] - (gesture.m0[1] - z.y) * r });
      applyZoom(); region = null; markRegion();
      return;
    }
    if (gesture && (gesture.type === "maybeTap" || gesture.type === "pan")) {
      const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
      if (gesture.type === "maybeTap" && Math.hypot(dx, dy) > 6) { gesture.type = "pan"; canvas.classList.add("dragging"); }
      if (gesture.type === "pan" && gesture.z.k > 1.01) {
        zoom = clampZoom({ k: gesture.z.k, x: gesture.z.x + dx, y: gesture.z.y + dy });
        applyZoom(); region = null; markRegion();
      }
    }
  });
  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    const wasTap = gesture && gesture.type === "maybeTap" && pts.size === 1 && performance.now() - gesture.t < 500;
    const p = localXY(e);
    pts.delete(e.pointerId);
    canvas.classList.remove("dragging");
    if (wasTap && e.type === "pointerup") {
      const now = performance.now();
      if (now - lastTap < 300) { zoomAt(p[0], p[1], 2.2, true); region = null; markRegion(); lastTap = 0; }
      else { lastTap = now; handleTap(p); }
    }
    if (pts.size === 0) { gesture = null; syncTouchAction(); }
    else if (pts.size === 1) { const [q] = [...pts.values()]; gesture = { type: "pan", start: q, t: 0, z: { ...zoom } }; }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { hideTip(); if (hoverIdx >= 0) { hoverIdx = -1; baseDirty = true; } } });
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey && zoom.k <= 1.01) return; // let the page scroll unless zoomed or pinching a trackpad
    e.preventDefault();
    const p = localXY(e);
    zoomAt(p[0], p[1], Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), false);
    region = null; markRegion(); syncTouchAction();
  }, { passive: false });
  $("zin").onclick = () => { zoomAt(W / 2, H / 2, 1.8, true); region = null; markRegion(); setTimeout(syncTouchAction, 700); };
  $("zout").onclick = () => { zoomAt(W / 2, H / 2, 1 / 1.8, true); region = null; markRegion(); setTimeout(syncTouchAction, 700); };

  function hover(e, p) {
    const { cell, country } = hitTest(p[0], p[1]);
    if (country !== hoverIdx) { hoverIdx = country; baseDirty = true; }
    if (country < 0 && !cell) { hideTip(); canvas.style.cursor = zoom.k > 1.01 ? "grab" : "default"; return; }
    canvas.style.cursor = "pointer";
    let h = "";
    if (country >= 0) {
      const a = view.countries.get(country);
      h += `<b>${esc(countryName(country))}</b><br>` + (a ? `${condition(a.avg).label} · tone ${fmtTone(a.avg)}<br><span class="tt-muted">${a.n} article${a.n === 1 ? "" : "s"} in 3 hours</span>` : `<span class="tt-muted">No Bitcoin coverage in this window</span>`);
    }
    if (cell) {
      const nm = placeName(cell.lat, cell.lon);
      h += `${h ? "<br>" : ""}<span class="tt-muted">${nm ? esc(nm.split(",")[0]) : "This spot"}:</span> ${cell.n} article${cell.n === 1 ? "" : "s"}, tone ${fmtTone(cell.avg)}`;
    }
    h += `<br><span class="tt-muted">Click for details</span>`;
    tip.innerHTML = h; tip.hidden = false;
    tip.style.left = Math.min(p[0] + 14, W - 250) + "px"; tip.style.top = Math.max(8, p[1] - 10) + "px";
  }
  function hideTip() { tip.hidden = true; }

  function handleTap(p) {
    const { cell, country } = hitTest(p[0], p[1]);
    hideTip(); dismissHint();
    if (cell && (country < 0 || cell.country !== country || !view.countries.get(country))) openSheet({ type: "spot", key: cell.key });
    else if (country >= 0) openSheet({ type: "country", idx: country });
    else if (cell) openSheet({ type: "spot", key: cell.key });
    else closeSheet();
  }

  // ---------- detail sheet ----------
  function countrySeries(idx) {
    // per-slot n/tone for one country, smoothed over an hour
    const raw = data.slots.map((s) => {
      let n = 0, t = 0;
      for (const c of s.cells) { if (countryOf(c[0], c[1]) !== idx) continue; const [cn, ct] = cellNT(c); n += cn; t += ct; }
      return [n, t];
    });
    return raw.map((_, i) => { let n = 0, t = 0; for (let j = Math.max(0, i - TL_SMOOTH + 1); j <= i; j++) { n += raw[j][0]; t += raw[j][1]; } return n ? t / n : null; });
  }
  function spotSeries(key) {
    const raw = data.slots.map((s) => { const c = s.cells.find((c) => c[0] + "," + c[1] === key); return c ? cellNT(c) : [0, 0]; });
    return raw.map((_, i) => { let n = 0, t = 0; for (let j = Math.max(0, i - TL_SMOOTH + 1); j <= i; j++) { n += raw[j][0]; t += raw[j][1]; } return n ? t / n : null; });
  }
  function sparkSVG(series, selIdx) {
    const w = 300, h = 46, vals = series.filter((v) => v != null);
    if (vals.length < 2) return `<div class="tt-muted" style="font-size:12px">Not enough data for a 24-hour trend.</div>`;
    const lo = Math.min(-1, ...vals), hi = Math.max(1, ...vals);
    const x = (i) => (i / (series.length - 1)) * w, y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (h - 6);
    let d = "", pen = false;
    series.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); pen = true; });
    const z = Math.max(0, Math.min(1, (y(0) - 0) / h));
    const sv = series[selIdx];
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="spg" x1="0" x2="0" y1="0" y2="${h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffb21e"/><stop offset="${z}" stop-color="#d9c08a"/><stop offset="${z}" stop-color="#9fb5f2"/><stop offset="1" stop-color="#3d6cf0"/></linearGradient></defs>
      <line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="#56607a" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="url(#spg)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <line x1="${x(selIdx)}" x2="${x(selIdx)}" y1="0" y2="${h}" stroke="#e9edf7" opacity=".4" vector-effect="non-scaling-stroke"/>
      ${sv != null ? `<circle cx="${x(selIdx)}" cy="${y(sv)}" r="3.5" fill="${rgba(toneRGB(sv), 1)}" stroke="#0e1527" stroke-width="1.5"/>` : ""}</svg>`;
  }
  function headsFor(match) {
    const lo = data.slots[view.start].t, hi = data.slots[view.end].t;
    const all = data.headlines.filter((h) => headOK(h) && h.loc && h.loc.some(match));
    let list = all.filter((h) => h.t >= lo && h.t <= hi);
    let note = "";
    if (list.length < 2) { list = all.filter((h) => h.t <= hi); note = " (last 24h)"; }
    list.sort((a, b) => (b.f || 0) - (a.f || 0) || (b.t > a.t ? 1 : -1));
    return { list: list.slice(0, 4), note };
  }
  function openSheet(s) {
    selected = s; baseDirty = true;
    renderSheet();
    if (window.matchMedia("(max-width: 960px)").matches) {
      const r = sheet.getBoundingClientRect();
      if (r.bottom > window.innerHeight) sheet.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    }
  }
  function closeSheet() { selected = null; sheet.hidden = true; baseDirty = true; }
  function renderSheet() {
    if (!selected || !view) { sheet.hidden = true; return; }
    let name, stats, series, heads;
    if (selected.type === "country") {
      const a = view.countries.get(selected.idx);
      name = countryName(selected.idx);
      stats = a ? { avg: a.avg, n: a.n } : null;
      series = countrySeries(selected.idx);
      heads = headsFor((k) => { const [la, lo] = k.split(",").map(Number); return countryOf(la, lo) === selected.idx; });
    } else {
      const c = view.cells.find((c) => c.key === selected.key);
      const [la, lo] = selected.key.split(",").map(Number);
      const nm = placeName(la, lo), ci = countryOf(la, lo);
      name = nm || (ci >= 0 ? `Near ${countryName(ci)}` : `${Math.abs(la)}°${la >= 0 ? "N" : "S"}, ${Math.abs(lo)}°${lo >= 0 ? "E" : "W"}`);
      stats = c ? { avg: c.avg, n: c.n } : null;
      series = spotSeries(selected.key);
      heads = headsFor((k) => k === selected.key);
    }
    const cond = condition(stats ? stats.avg : null);
    sheet.innerHTML = `
      <div class="sh-head">
        <div class="sh-icon">${ICONS[cond.key]}</div>
        <div class="sh-title"><div class="sh-name">${esc(name)}</div>
          <div class="sh-sub">${stats ? `${cond.label} · tone ${fmtTone(stats.avg)} · ${stats.n} article${stats.n === 1 ? "" : "s"} in 3h${stats.n < MIN_COUNTRY_N && selected.type === "country" ? " · low coverage" : ""}` : "No coverage in this 3-hour window"}</div></div>
        <button class="sh-close" aria-label="Close details">✕</button>
      </div>
      <div class="sh-spark">${sparkSVG(series, sel)}<div class="sh-cap"><span>24h ago</span><span>Tone trend</span><span>${live ? "now" : fmtTime(slotDate(data.slots[sel].t))}</span></div></div>
      ${heads.list.length ? `<ul class="sh-heads">${heads.list.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="meta"><span>${esc(h.src)} · ${fmtTime(slotDate(h.t))}${heads.note}</span>${chip(h.tone)}</div></li>`).join("")}</ul>` : `<div class="tt-muted" style="font-size:12px;margin-top:6px">No headlines tied to this place yet.</div>`}`;
    sheet.hidden = false;
    sheet.querySelector(".sh-close").onclick = closeSheet;
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  // ---------- panels ----------
  function renderPanels() {
    const end = slotDate(data.slots[view.end].t), start = slotDate(data.slots[view.start].t);
    const cond = condition(view.avg);
    $("fcIcon").innerHTML = ICONS[cond.key];
    $("fcCond").textContent = cond.label;
    let trend = "";
    if (view.avg != null && view.prev != null) {
      const d = view.avg - view.prev;
      trend = d > 0.4 ? "↗ brightening" : d < -0.4 ? "↘ darkening" : "→ steady";
    }
    $("fcTrend").textContent = trend;
    $("fcTone").textContent = view.avg == null ? "–" : fmtTone(view.avg);
    $("fcN").textContent = view.n.toLocaleString();
    $("fcWhen").textContent = live ? "Global forecast · now" : `Global · ${fmtDay(end)} ${fmtTime(end)}`;
    $("ctrySub").textContent = `${fmtTime(new Date(start - 15 * 60000))} – ${fmtTime(end)} · tap to explore`;

    const list = [...view.countries.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    $("countries").innerHTML = list.length ? list.map((a) =>
      `<li><button data-idx="${a.idx}"><span>${esc(countryName(a.idx))}</span><span class="c-n">${a.n} art.</span>${chip(a.avg)}</button></li>`).join("")
      : `<li class="empty">No located articles in this window.</li>`;
    $("countries").querySelectorAll("button").forEach((b) => b.onclick = () => {
      const i = +b.dataset.idx; zoomToCountry(i); region = null; markRegion(); openSheet({ type: "country", idx: i });
      setTimeout(syncTouchAction, 700);
      if (window.matchMedia("(max-width: 960px)").matches) stage.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    });

    const lo = data.slots[view.start].t, hi = data.slots[view.end].t;
    let heads = data.headlines.filter((h) => headOK(h) && h.t >= lo && h.t <= hi);
    heads.sort((a, b) => (b.f || 0) - (a.f || 0) || (b.t > a.t ? 1 : b.t < a.t ? -1 : 0));
    heads = heads.slice(0, 20);
    $("headsTitle").textContent = mode === "all" ? "Latest coverage" : "Latest Bitcoin headlines";
    $("heads").innerHTML = heads.length ? heads.map((h) =>
      `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="meta"><span>${esc(h.src)} · ${fmtTime(slotDate(h.t))}${mode === "all" && !h.f ? `<span class="tagline">mentions BTC</span>` : ""}</span>${chip(h.tone)}</div></li>`).join("")
      : `<li class="empty">No headlines in this window.</li>`;

    $("tlLabel").textContent = `${fmtDay(end)}, ${fmtTime(end)} · map shows the 3 hours before`;
    $("updated").textContent = new Date(data.updated).toLocaleString();
    document.title = `${cond.label} · Bitcoin Weather`;
  }

  // ---------- timeline ----------
  let tlSeries = [], tlGeom = null;
  function buildSeries() {
    tlSeries = data.slots.map((s, i) => {
      let n = 0, t = 0;
      for (let j = Math.max(0, i - TL_SMOOTH + 1); j <= i; j++) { n += slotN(data.slots[j]); t += slotTone(data.slots[j]); }
      return { i, n, v: n ? t / n : null, d: slotDate(s.t) };
    });
  }
  function drawTimeline() {
    const svg = $("tl"), w = svg.clientWidth || 600, h = 120, m = { l: 30, r: 10, t: 10, b: 20 };
    const vals = tlSeries.filter((p) => p.v != null).map((p) => p.v);
    const lo = Math.min(-2, ...vals), hi = Math.max(1, ...vals);
    const x = (i) => m.l + (i / Math.max(1, tlSeries.length - 1)) * (w - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (h - m.t - m.b);
    tlGeom = { w, m, x };
    let d = "", area = "", pen = false, firstX = 0;
    for (const p of tlSeries) {
      if (p.v == null) { if (pen) area += `L${x(p.i - 1)},${y(0)}Z`; pen = false; continue; }
      if (!pen) { firstX = x(p.i); area += `M${firstX},${y(0)}`; }
      d += (pen ? "L" : "M") + x(p.i).toFixed(1) + "," + y(p.v).toFixed(1);
      area += `L${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    if (pen) area += `L${x(tlSeries.length - 1)},${y(0)}Z`;
    const zeroY = y(0), z = Math.max(0, Math.min(1, (zeroY - m.t) / (h - m.t - m.b)));
    const ticks = [0];
    for (const v of [Math.ceil(lo), Math.floor(hi)]) if (Math.abs(y(v) - y(0)) > 14) ticks.push(v);
    const step = w < 480 ? 12 : 6;
    const hours = tlSeries.filter((p) => p.d.getMinutes() === 0 && p.d.getHours() % step === 0);
    const sv = tlSeries[sel] && tlSeries[sel].v;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <defs><linearGradient id="tlg" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffb21e"/><stop offset="${z}" stop-color="#d9c08a"/><stop offset="${z}" stop-color="#9fb5f2"/><stop offset="1" stop-color="#3d6cf0"/></linearGradient>
        <linearGradient id="tla" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffb21e" stop-opacity=".22"/><stop offset="${z}" stop-color="#ffb21e" stop-opacity=".02"/><stop offset="${z}" stop-color="#3d6cf0" stop-opacity=".02"/><stop offset="1" stop-color="#3d6cf0" stop-opacity=".25"/></linearGradient></defs>
      <g class="tl-axis">${ticks.map((v) => `<line class="${v === 0 ? "tl-zero" : "tl-grid"}" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${v > 0 ? "+" + v : v < 0 ? "−" + -v : "0"}</text>`).join("")}
        ${hours.map((p) => `<text x="${x(p.i)}" y="${h - 5}" text-anchor="middle">${fmtTime(p.d)}</text>`).join("")}</g>
      <path d="${area}" fill="url(#tla)"/>
      <path d="${d}" fill="none" stroke="url(#tlg)" stroke-width="2" stroke-linejoin="round"/>
      <rect x="${x(Math.max(0, sel - WINDOW + 1))}" y="${m.t}" width="${Math.max(1, x(sel) - x(Math.max(0, sel - WINDOW + 1)))}" height="${h - m.t - m.b}" fill="#9fbaff" opacity=".07"/>
      <line x1="${x(sel)}" x2="${x(sel)}" y1="${m.t - 4}" y2="${h - m.b}" stroke="#e9edf7" stroke-width="1.5" opacity=".75"/>
      ${sv != null ? `<circle cx="${x(sel)}" cy="${y(sv)}" r="6" fill="${rgba(toneRGB(sv), 1)}" stroke="#121a2e" stroke-width="2.5"/>` : ""}
      <rect id="tlHit" x="0" y="0" width="${w}" height="${h}" fill="transparent"/>`;
  }
  (function wireTimeline() {
    const svg = $("tl");
    const idxAt = (e) => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (tlGeom.w / r.width);
      return Math.max(0, Math.min(tlSeries.length - 1, Math.round(((px - tlGeom.m.l) / (tlGeom.w - tlGeom.m.l - tlGeom.m.r)) * (tlSeries.length - 1))));
    };
    let dragging = false, startX = 0, startY = 0, decided = false;
    svg.addEventListener("pointerdown", (e) => {
      if (!data) return;
      dragging = true; decided = e.pointerType === "mouse"; startX = e.clientX; startY = e.clientY;
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (decided) { stopPlay(); select(idxAt(e), idxAt(e) === tlSeries.length - 1); }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!data || !tlGeom) return;
      if (dragging) {
        if (!decided) {
          if (Math.abs(e.clientX - startX) > 6) decided = true;
          else if (Math.abs(e.clientY - startY) > 8) { dragging = false; return; }
          else return;
          stopPlay();
        }
        const i = idxAt(e); if (i !== sel) select(i, i === tlSeries.length - 1);
      } else if (e.pointerType === "mouse") {
        const p = tlSeries[idxAt(e)];
        $("tlLabel").textContent = `${fmtDay(p.d)}, ${fmtTime(p.d)} · ${p.v == null ? "no articles" : `tone ${fmtTone(p.v)} · ${condition(p.v).label} · ${p.n} articles/hr`}`;
      }
    });
    const up = (e) => {
      if (dragging && !decided && e.type === "pointerup") { stopPlay(); const i = idxAt(e); select(i, i === tlSeries.length - 1); }
      dragging = false;
    };
    svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
    svg.addEventListener("pointerleave", () => { if (!dragging && view) renderPanels(); });
  })();

  // ---------- selection / playback / mode ----------
  function select(i, isLive) {
    sel = i; live = isLive;
    $("live").classList.toggle("on", live);
    view = aggregate(i);
    baseDirty = true;
    renderPanels(); drawTimeline();
    if (selected) renderSheet();
  }
  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; $("play").textContent = "▶ Replay 24h"; } }
  $("play").onclick = () => {
    if (playTimer) return stopPlay();
    let i = Math.min(WINDOW - 1, data.slots.length - 1);
    $("play").textContent = "❚❚ Pause";
    select(i, false);
    playTimer = setInterval(() => {
      i++;
      if (i >= data.slots.length) { stopPlay(); select(data.slots.length - 1, true); return; }
      select(i, false);
    }, 280);
  };
  $("live").onclick = () => { stopPlay(); select(data.slots.length - 1, true); };
  document.querySelectorAll(".seg button").forEach((b) => b.onclick = () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".seg button").forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    particles = []; buildSeries(); select(sel, live);
  });

  // regions
  $("regions").innerHTML = REGIONS.map((r) => `<button data-r="${r.id}">${r.label}</button>`).join("");
  function markRegion() { $("regions").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.r === region)); }
  $("regions").querySelectorAll("button").forEach((b) => b.onclick = () => {
    const r = REGIONS.find((x) => x.id === b.dataset.r);
    region = r.id; markRegion(); zoomToBox(r.box); closeSheet(); dismissHint();
    setTimeout(syncTouchAction, 700);
  });
  markRegion();

  // hint
  $("hint").textContent = isTouch ? "Tap a country · pinch to zoom" : "Click a country · double-click or ⌘/Ctrl-scroll to zoom";
  let hintTimer = setTimeout(dismissHint, 6000);
  function dismissHint() { clearTimeout(hintTimer); $("hint").classList.add("gone"); }

  // share
  $("share").onclick = async () => {
    const cond = view ? condition(view.avg) : null;
    const text = cond && view.avg != null ? `Bitcoin news weather right now: ${cond.label} (tone ${fmtTone(view.avg)}).` : "Bitcoin Weather: how the world's news feels about Bitcoin.";
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) await navigator.share({ title: "Bitcoin Weather", text, url });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast("Link copied"); }
    } catch (e) { /* user cancelled */ }
  };

  // ---------- data loading ----------
  async function loadData() {
    try {
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (!d.slots || !d.slots.length) throw new Error("empty");
      data = d; buildSeries();
      if (live || sel > data.slots.length - 1) select(data.slots.length - 1, true); else select(sel, false);
    } catch (e) {
      if (!data) { $("fcCond").textContent = "Data loading soon"; $("fcIcon").innerHTML = ICONS.none; }
    }
  }
  async function loadPrice() {
    try {
      const r = await fetch(PRICE_URL); if (!r.ok) return;
      const b = (await r.json()).bitcoin; if (!b) return;
      $("priceVal").textContent = "$" + Math.round(b.usd).toLocaleString();
      const c = b.usd_24h_change, el = $("priceChg");
      el.textContent = (c >= 0 ? "▲ " : "▼ ") + Math.abs(c).toFixed(2) + "%";
      el.className = "price-chg " + (c >= 0 ? "up" : "down");
      $("price").hidden = false;
    } catch (e) { /* price is optional */ }
  }

  async function init() {
    world = await (await fetch("/data/countries-110m.json")).json();
    features = topojson.feature(world, world.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
    features.forEach((f) => { f._bounds = d3.geoBounds(f); });
    mesh = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
    resize();
    await loadData();
    loadPrice();
    setInterval(() => { if (!document.hidden) loadData(); }, 5 * 60 * 1000);
    setInterval(() => { if (!document.hidden) loadPrice(); }, 2 * 60 * 1000);
    let rt, lastW = canvas.getBoundingClientRect().width;
    new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const w = canvas.getBoundingClientRect().width;
        if (Math.abs(w - lastW) >= 1) { lastW = w; resize(); }
        if (data) drawTimeline();
      }, 120);
    }).observe(document.body);
    updateRunning();
  }
  init();
})();
