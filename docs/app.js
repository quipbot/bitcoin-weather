/* Bitcoin Weather — front end. No build step; uses d3-geo + topojson from /vendor. */
(() => {
  "use strict";

  const WINDOW = 12;              // map shows the last 12 slots (3 hours)
  const TL_SMOOTH = 4;            // timeline uses a 1-hour rolling average
  const MIN_COUNTRY_N = 3;        // need this many articles to color a country
  const DATA_URL = "data/weather.json";
  const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (id) => document.getElementById(id);
  const canvas = $("map"), ctx = canvas.getContext("2d");
  const tip = $("tip");
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
    sun: `<svg viewBox="0 0 56 56"><g stroke="#ffc94d" stroke-width="3" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>`<line x1="28" y1="6" x2="28" y2="12" transform="rotate(${a} 28 28)"/>`).join("")}</g><circle cx="28" cy="28" r="11" fill="#ffc94d"/></svg>`,
    partly: `<svg viewBox="0 0 56 56"><circle cx="22" cy="22" r="10" fill="#ffc94d"/><path d="M18 42h22a8 8 0 0 0 0-16 11 11 0 0 0-21 3 7 7 0 0 0-1 13z" fill="#c9d2e6"/></svg>`,
    cloud: `<svg viewBox="0 0 56 56"><path d="M14 40h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#aab3c8"/></svg>`,
    rain: `<svg viewBox="0 0 56 56"><path d="M14 32h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#8d97b0"/><g stroke="#7c9ef2" stroke-width="2.5" stroke-linecap="round"><line x1="19" y1="38" x2="16" y2="46"/><line x1="28" y1="38" x2="25" y2="46"/><line x1="37" y1="38" x2="34" y2="46"/></g></svg>`,
    storm: `<svg viewBox="0 0 56 56"><path d="M14 30h26a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-3 15z" fill="#6b748c"/><path d="M30 30l-7 11h6l-4 10 11-14h-6l4-7z" fill="#ffd34d"/><g stroke="#5b8cff" stroke-width="2.5" stroke-linecap="round"><line x1="17" y1="36" x2="14" y2="44"/><line x1="42" y1="36" x2="39" y2="44"/></g></svg>`,
    none: `<svg viewBox="0 0 56 56"><circle cx="28" cy="28" r="12" fill="none" stroke="#56607a" stroke-width="2" stroke-dasharray="4 4"/></svg>`,
  };

  // ---------- state ----------
  let data = null, world = null, features = [], projection = null, path = null;
  let sel = 0, live = true, playTimer = null;
  let view = null;               // aggregated window for the selected slot
  let W = 0, H = 0, dpr = 1, scale = 1;
  const base = document.createElement("canvas"), bctx = base.getContext("2d");
  const cellCountry = new Map(); // "lat,lon" -> feature index (or -1)
  let particles = [], flashes = [];

  // ---------- geometry ----------
  function countryOf(lat, lon) {
    const key = lat + "," + lon;
    if (cellCountry.has(key)) return cellCountry.get(key);
    let found = -1;
    for (let i = 0; i < features.length; i++) {
      const b = features[i]._bounds;
      if (lon < b[0][0] - 1 || lon > b[1][0] + 1 || lat < b[0][1] - 1 || lat > b[1][1] + 1) {
        if (!(b[0][0] > b[1][0])) continue; // antimeridian-crossing bounds: check fully
      }
      if (d3.geoContains(features[i], [lon, lat])) { found = i; break; }
    }
    cellCountry.set(key, found);
    return found;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(300, r.width); H = Math.max(160, r.height);
    for (const c of [canvas, base]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = W / 1200;
    if (world) {
      projection = d3.geoEqualEarth().fitExtent([[10, 10], [W - 10, H - 6]], { type: "FeatureCollection", features });
      path = d3.geoPath(projection, bctx);
      drawBase();
    }
  }

  // ---------- aggregation ----------
  function aggregate(endIdx) {
    const slots = data.slots, start = Math.max(0, endIdx - WINDOW + 1);
    const cells = new Map(), countries = new Map();
    let n = 0, tone = 0;
    for (let i = start; i <= endIdx; i++) {
      const s = slots[i]; n += s.n; tone += s.tone;
      for (const [lat, lon, cn, ct] of s.cells) {
        const k = lat + "," + lon;
        const c = cells.get(k) || { lat, lon, n: 0, tone: 0 };
        c.n += cn; c.tone += ct; cells.set(k, c);
      }
    }
    for (const c of cells.values()) {
      c.avg = c.tone / c.n;
      c.country = countryOf(c.lat, c.lon);
      c.phase = (Math.abs(c.lat * 13.7 + c.lon * 7.1) % 6.28);
      if (c.country >= 0) {
        const a = countries.get(c.country) || { idx: c.country, n: 0, tone: 0 };
        a.n += c.n; a.tone += c.tone; countries.set(c.country, a);
      }
    }
    for (const a of countries.values()) a.avg = a.tone / a.n;
    return { start, end: endIdx, n, avg: n ? tone / n : null, cells: [...cells.values()], countries };
  }

  // ---------- drawing ----------
  function drawBase() {
    bctx.clearRect(0, 0, W, H);
    bctx.beginPath(); path(d3.geoGraticule10()); bctx.strokeStyle = "rgba(60,75,110,.25)"; bctx.lineWidth = 0.6; bctx.stroke();
    features.forEach((f, i) => {
      const a = view && view.countries.get(i);
      bctx.beginPath(); path(f);
      bctx.fillStyle = a && a.n >= MIN_COUNTRY_N ? rgba(toneRGB(a.avg), 0.42) : "#1a2440";
      bctx.fill();
    });
    bctx.beginPath(); path(topojson.mesh(world, world.objects.countries, (a, b) => a !== b));
    bctx.strokeStyle = "#0b1020"; bctx.lineWidth = 0.8; bctx.stroke();
  }

  function cellRadius(c) { return (7 + 6 * Math.sqrt(c.n)) * Math.max(0.6, scale); }

  function spawnParticles(t) {
    if (reduceMotion || !view) return;
    for (const c of view.cells) {
      const p = projection([c.lon, c.lat]); if (!p) continue;
      const r = cellRadius(c);
      if (c.avg < -1.5 && Math.random() < 0.06 * Math.min(c.n, 8) && particles.length < 500) {
        particles.push({ kind: "rain", x: p[0] + (Math.random() - .5) * r * 1.6, y: p[1] - r * .6 + Math.random() * r * .4, vx: -0.25, vy: 1.6 + Math.random(), life: r * 0.9, age: 0 });
      } else if (c.avg >= 1 && Math.random() < 0.035 * Math.min(c.n, 8) && particles.length < 500) {
        particles.push({ kind: "spark", x: p[0] + (Math.random() - .5) * r, y: p[1] + (Math.random() - .5) * r * .5, vx: 0, vy: -0.35, life: 40, age: 0 });
      }
      if (c.avg < -3 && c.n >= 2 && Math.random() < 0.004) flashes.push({ x: p[0], y: p[1], r, age: 0, seed: Math.random() });
    }
  }

  function frame(ts) {
    const t = ts / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0, W, H);
    if (view && projection) {
      ctx.globalCompositeOperation = "lighter";
      for (const c of view.cells) {
        const p = projection([c.lon, c.lat]); if (!p) continue;
        const col = toneRGB(c.avg);
        const pulse = reduceMotion ? 1 : 1 + 0.08 * Math.sin(t * 1.6 + c.phase);
        const drift = reduceMotion ? 0 : Math.sin(t * 0.4 + c.phase) * 2 * scale;
        const r = cellRadius(c) * pulse, x = p[0] + drift, y = p[1];
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(0.45, rgba(col, 0.22)); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      for (const c of view.cells) {
        const p = projection([c.lon, c.lat]); if (!p) continue;
        ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(toneRGB(c.avg), 0.95); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(11,16,32,.9)"; ctx.stroke();
      }
      // particles
      spawnParticles(t);
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
      // lightning
      flashes = flashes.filter((f) => {
        f.age++; if (f.age > 14) return false;
        const a = 1 - f.age / 14;
        ctx.fillStyle = `rgba(200,215,255,${0.18 * a})`; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 1.3, 0, Math.PI * 2); ctx.fill();
        if (f.age < 7) {
          ctx.strokeStyle = `rgba(255,236,150,${a})`; ctx.lineWidth = 1.6; ctx.beginPath();
          let x = f.x + (f.seed - .5) * f.r * .6, y = f.y - f.r * .7; ctx.moveTo(x, y);
          for (let k = 1; k <= 4; k++) { x += (Math.sin(f.seed * 50 * k) * 0.5) * f.r * 0.35; y += f.r * 0.32; ctx.lineTo(x, y); }
          ctx.stroke();
        }
        return true;
      });
    }
    requestAnimationFrame(frame);
  }

  // ---------- panels ----------
  const slotDate = (sid) => new Date(Date.UTC(+sid.slice(0, 4), +sid.slice(4, 6) - 1, +sid.slice(6, 8), +sid.slice(8, 10), +sid.slice(10, 12)));
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtDay = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const chip = (t) => `<span class="chip"><i style="background:${rgba(toneRGB(t), 1)}"></i>${fmtTone(t)}</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const countryName = (i) => { const n = features[i].properties.name; return n === "United States of America" ? "United States" : n; };

  function renderPanels() {
    const end = slotDate(data.slots[view.end].t), start = slotDate(data.slots[view.start].t);
    const cond = condition(view.avg);
    $("fcIcon").innerHTML = ICONS[cond.key];
    $("fcCond").textContent = cond.label;
    $("fcTone").textContent = view.avg == null ? "–" : fmtTone(view.avg);
    $("fcN").textContent = view.n.toLocaleString();
    $("fcWhen").textContent = live ? "Global forecast · now" : `Global forecast · ${fmtDay(end)} ${fmtTime(end)}`;
    $("ctrySub").textContent = `${fmtTime(new Date(start - 15 * 60000))} – ${fmtTime(end)} · ranked by coverage`;

    const list = [...view.countries.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    $("countries").innerHTML = list.length ? list.map((a) =>
      `<li><span>${esc(countryName(a.idx))}</span><span class="c-n">${a.n} art.</span>${chip(a.avg)}</li>`).join("")
      : `<li class="empty">No located articles in this window.</li>`;

    const lo = data.slots[view.start].t, hi = data.slots[view.end].t;
    const heads = data.headlines.filter((h) => h.t >= lo && h.t <= hi).slice(0, 20);
    $("heads").innerHTML = heads.length ? heads.map((h) =>
      `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="meta"><span>${esc(h.src)} · ${fmtTime(slotDate(h.t))}</span>${chip(h.tone)}</div></li>`).join("")
      : `<li class="empty">No headlines in this window.</li>`;

    $("tlLabel").textContent = `${fmtDay(end)}, ${fmtTime(end)} · map shows the 3 hours before`;
    $("updated").textContent = new Date(data.updated).toLocaleString();
  }

  // ---------- timeline ----------
  let tlSeries = [];
  function buildSeries() {
    tlSeries = data.slots.map((s, i) => {
      let n = 0, t = 0;
      for (let j = Math.max(0, i - TL_SMOOTH + 1); j <= i; j++) { n += data.slots[j].n; t += data.slots[j].tone; }
      return { i, n, v: n ? t / n : null, d: slotDate(s.t) };
    });
  }
  function drawTimeline() {
    const svg = $("tl"), w = svg.clientWidth || 600, h = 110, m = { l: 34, r: 8, t: 8, b: 18 };
    const vals = tlSeries.filter((p) => p.v != null).map((p) => p.v);
    const lo = Math.min(-2, ...vals), hi = Math.max(1, ...vals);
    const x = (i) => m.l + (i / Math.max(1, tlSeries.length - 1)) * (w - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (h - m.t - m.b);
    let d = "", pen = false;
    for (const p of tlSeries) { if (p.v == null) { pen = false; continue; } d += (pen ? "L" : "M") + x(p.i).toFixed(1) + "," + y(p.v).toFixed(1); pen = true; }
    const zeroY = y(0), z = Math.max(0, Math.min(1, (zeroY - m.t) / (h - m.t - m.b)));
    const ticks = [0];
    for (const v of [Math.ceil(lo), Math.floor(hi)]) if (Math.abs(y(v) - y(0)) > 14) ticks.push(v);
    const hours = tlSeries.filter((p) => p.d.getMinutes() === 0 && p.d.getHours() % 6 === 0);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <defs><linearGradient id="tlg" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffb21e"/><stop offset="${z}" stop-color="#d9c08a"/><stop offset="${z}" stop-color="#9fb5f2"/><stop offset="1" stop-color="#3d6cf0"/></linearGradient></defs>
      <g class="tl-axis">${ticks.map((v) => `<line class="${v === 0 ? "tl-zero" : "tl-grid"}" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${v > 0 ? "+" + v : v < 0 ? "−" + -v : "0"}</text>`).join("")}
        ${hours.map((p) => `<text x="${x(p.i)}" y="${h - 4}" text-anchor="middle">${fmtTime(p.d)}</text>`).join("")}</g>
      <path d="${d}" fill="none" stroke="url(#tlg)" stroke-width="2" stroke-linejoin="round"/>
      <line id="tlSel" x1="${x(sel)}" x2="${x(sel)}" y1="${m.t}" y2="${h - m.b}" stroke="#e9edf7" stroke-width="1" opacity=".6"/>
      ${tlSeries[sel] && tlSeries[sel].v != null ? `<circle cx="${x(sel)}" cy="${y(tlSeries[sel].v)}" r="4.5" fill="${rgba(toneRGB(tlSeries[sel].v), 1)}" stroke="#121a2e" stroke-width="2"/>` : ""}
      <line id="tlHover" y1="${m.t}" y2="${h - m.b}" stroke="#aab3c8" stroke-width="1" stroke-dasharray="2 2" visibility="hidden"/>
      <rect id="tlHit" x="${m.l}" y="0" width="${w - m.l - m.r}" height="${h}" fill="transparent" style="cursor:pointer"/>`;
    const hit = $("tlHit"), hov = $("tlHover");
    const idxAt = (ev) => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (w / r.width); return Math.round(((px - m.l) / (w - m.l - m.r)) * (tlSeries.length - 1)); };
    hit.onmousemove = (ev) => {
      const i = Math.max(0, Math.min(tlSeries.length - 1, idxAt(ev))), p = tlSeries[i];
      hov.setAttribute("x1", x(i)); hov.setAttribute("x2", x(i)); hov.setAttribute("visibility", "visible");
      showTip(ev, `<b>${fmtDay(p.d)}, ${fmtTime(p.d)}</b><br>${p.v == null ? "No articles" : `Tone ${fmtTone(p.v)} · ${condition(p.v).label}<br><span class="tt-muted">${p.n} articles in the past hour</span>`}`, true);
    };
    hit.onmouseleave = () => { hov.setAttribute("visibility", "hidden"); hideTip(); };
    hit.onclick = (ev) => { stopPlay(); select(Math.max(0, Math.min(tlSeries.length - 1, idxAt(ev))), false); };
  }

  // ---------- tooltip ----------
  function showTip(ev, htmlStr, fixedToPage) {
    tip.innerHTML = htmlStr; tip.hidden = false;
    const wrap = canvas.parentElement.getBoundingClientRect();
    if (fixedToPage) { tip.style.position = "fixed"; tip.style.left = ev.clientX + 12 + "px"; tip.style.top = ev.clientY - 60 + "px"; return; }
    tip.style.position = "absolute";
    const x = ev.clientX - wrap.left, y = ev.clientY - wrap.top;
    tip.style.left = Math.min(x + 14, wrap.width - 190) + "px"; tip.style.top = Math.max(8, y - 10) + "px";
  }
  function hideTip() { tip.hidden = true; }

  canvas.addEventListener("mousemove", (ev) => {
    if (!view || !projection) return;
    const r = canvas.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best = null, bd = 1e9;
    for (const c of view.cells) {
      const p = projection([c.lon, c.lat]); if (!p) continue;
      const dd = Math.hypot(p[0] - px, p[1] - py);
      if (dd < Math.max(10, cellRadius(c) * 0.6) && dd < bd) { best = c; bd = dd; }
    }
    const ll = projection.invert([px, py]);
    let ci = -1;
    if (ll) for (let i = 0; i < features.length; i++) if (d3.geoContains(features[i], ll)) { ci = i; break; }
    if (ci < 0 && !best) { hideTip(); canvas.style.cursor = "default"; return; }
    let h = "";
    if (ci >= 0) {
      const a = view.countries.get(ci);
      h += `<b>${esc(countryName(ci))}</b><br>` + (a ? `${condition(a.avg).label} · tone ${fmtTone(a.avg)}<br><span class="tt-muted">${a.n} article${a.n === 1 ? "" : "s"} in 3 hours${a.n < MIN_COUNTRY_N ? " (too few to shade)" : ""}</span>` : `<span class="tt-muted">No Bitcoin coverage in this window</span>`);
    }
    if (best) h += `${h ? "<br>" : ""}<span class="tt-muted">This spot:</span> ${best.n} article${best.n === 1 ? "" : "s"}, tone ${fmtTone(best.avg)}`;
    canvas.style.cursor = "crosshair";
    showTip(ev, h);
  });
  canvas.addEventListener("mouseleave", hideTip);

  // ---------- selection / playback ----------
  function select(i, isLive) {
    sel = i; live = isLive;
    $("live").classList.toggle("on", live);
    $("scrub").value = i;
    view = aggregate(i);
    drawBase(); renderPanels(); drawTimeline();
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
    }, 300);
  };
  $("live").onclick = () => { stopPlay(); select(data.slots.length - 1, true); };
  $("scrub").oninput = (e) => { stopPlay(); const i = +e.target.value; select(i, i === data.slots.length - 1); };

  // ---------- data loading ----------
  async function loadData() {
    try {
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (!d.slots || !d.slots.length) throw new Error("empty");
      data = d; buildSeries();
      $("scrub").max = data.slots.length - 1;
      if (live || sel > data.slots.length - 1) select(data.slots.length - 1, true); else select(sel, false);
    } catch (e) {
      if (!data) { $("fcCond").textContent = "Data unavailable"; $("fcIcon").innerHTML = ICONS.none; }
    }
  }
  async function loadPrice() {
    try {
      const r = await fetch(PRICE_URL); if (!r.ok) return;
      const b = (await r.json()).bitcoin; if (!b) return;
      $("priceVal").textContent = "$" + Math.round(b.usd).toLocaleString();
      const c = b.usd_24h_change, el = $("priceChg");
      el.textContent = (c >= 0 ? "▲ " : "▼ ") + Math.abs(c).toFixed(2) + "% 24h";
      el.className = "price-chg " + (c >= 0 ? "up" : "down");
      $("price").hidden = false;
    } catch (e) { /* price is optional */ }
  }

  async function init() {
    world = await (await fetch("data/countries-110m.json")).json();
    features = topojson.feature(world, world.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
    features.forEach((f) => { f._bounds = d3.geoBounds(f); });
    resize();
    await loadData();
    loadPrice();
    setInterval(loadData, 5 * 60 * 1000);
    setInterval(loadPrice, 2 * 60 * 1000);
    let rt, lastW = 0;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { const w = canvas.getBoundingClientRect().width; if (Math.abs(w - lastW) < 1) return; lastW = w; resize(); if (data) drawTimeline(); }, 120); }).observe(canvas.parentElement);
    requestAnimationFrame(frame);
  }
  init();
})();
