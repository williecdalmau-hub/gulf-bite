"use strict";
/* Gulf Bite: fishing & boating forecast.
   Data: Open-Meteo (weather + marine, no key), NOAA CO-OPS (tide predictions), SunCalc (sun & moon, on-device). */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = a => a.reduce((s, x) => s + x, 0);
const avg = a => a.length ? sum(a) / a.length : 0;
const uid = () => Math.random().toString(36).slice(2, 9);
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtT = t => t ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
const fmtH = h => { const x = ((h % 24) + 24) % 24; return (x % 12 || 12) + (x < 12 ? " AM" : " PM"); };
const dayName = d => d.toLocaleDateString([], { weekday: "short" });
const dayLong = d => d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
const inHg = hpa => hpa * 0.02953;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const compass = deg => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const scoreClass = s => s == null ? "s-none" : s >= 80 ? "s-good" : s >= 65 ? "s-ok" : s >= 45 ? "s-fair" : "s-poor";
const scoreColor = s => s == null ? "var(--card2)" : s >= 80 ? "var(--good)" : s >= 65 ? "var(--ok)" : s >= 45 ? "var(--fair)" : "var(--poor)";
function miles(a, b, c, d) { const R = 3958.8, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function ymd(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"); }
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
function arrowSVG(deg, color) { // deg = direction wind comes FROM; arrow points where it blows
  return `<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate(${(deg + 180) % 360}deg)"><path d="M12 2l6 10h-4v10h-4V12H6z" fill="${color || "currentColor"}"/></svg>`;
}

/* ---------------- state ---------------- */
let spots = LS.get("gb_spots", null);
if (!spots || !spots.length) { spots = [{ id: "s1", name: "St. Andrew Bay", lat: 30.1588, lon: -85.6935 }]; LS.set("gb_spots", spots); }
let catches = LS.get("gb_catches", []);
let selId = LS.get("gb_sel", spots[0].id);
let selDay = 0;
const cache = {};
const saveSpots = () => LS.set("gb_spots", spots);
const saveCatches = () => LS.set("gb_catches", catches);
const curSpot = () => spots.find(s => s.id === selId) || spots[0];

/* ---------------- data ---------------- */
async function tideStations() {
  const c = LS.get("gb_tidest", null);
  if (c && Date.now() - c.ts < 30 * 864e5) return c.list;
  const j = await getJSON("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions");
  const list = (j.stations || []).map(s => [s.id, s.name, +s.lat, +s.lng]);
  LS.set("gb_tidest", { ts: Date.now(), list });
  return list;
}
async function loadTides(sp) {
  const list = await tideStations();
  let best = null, bd = 1e9;
  for (const s of list) { const d = miles(sp.lat, sp.lon, s[2], s[3]); if (d < bd) { bd = d; best = s; } }
  if (!best || bd > 40) return null;
  const base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=GulfBite&begin_date=" + ymd(new Date()) +
    "&range=192&datum=MLLW&station=" + best[0] + "&time_zone=lst_ldt&units=english&format=json&interval=";
  const [hl, hr] = await Promise.all([getJSON(base + "hilo"), getJSON(base + "h")]);
  const p = x => new Date(x.replace(" ", "T"));
  return {
    station: best[1], id: best[0], dist: bd,
    hilo: (hl.predictions || []).map(x => ({ t: p(x.t), v: +x.v, type: x.type })),
    curve: (hr.predictions || []).map(x => ({ t: p(x.t), v: +x.v }))
  };
}
async function loadSpot(sp, force) {
  const c = cache[sp.id];
  if (c && !force && Date.now() - c.ts < 30 * 60e3) return c.data;
  const W = `https://api.open-meteo.com/v1/forecast?latitude=${sp.lat}&longitude=${sp.lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
  const M = `https://marine-api.open-meteo.com/v1/marine?latitude=${sp.lat}&longitude=${sp.lon}&hourly=wave_height,wave_period,wave_direction,sea_surface_temperature,ocean_current_velocity,ocean_current_direction&length_unit=imperial&timezone=auto&forecast_days=7`;
  const [w, m, t] = await Promise.allSettled([getJSON(W), getJSON(M), loadTides(sp)]);
  if (w.status !== "fulfilled") throw new Error("Couldn't get the weather forecast. Check your connection and tap refresh.");
  const data = assemble(w.value, m.status === "fulfilled" ? m.value : null, t.status === "fulfilled" ? t.value : null, sp);
  data.tideError = t.status !== "fulfilled";
  cache[sp.id] = { ts: Date.now(), data };
  return data;
}
function assemble(w, m, t, sp) {
  const H = w.hourly;
  const hours = H.time.map((s, i) => ({
    t: new Date(s), temp: H.temperature_2m[i], wind: H.wind_speed_10m[i], dir: H.wind_direction_10m[i],
    gust: H.wind_gusts_10m[i], pres: H.pressure_msl[i], code: H.weather_code[i],
    pop: H.precipitation_probability ? H.precipitation_probability[i] : null
  }));
  let marine = null;
  if (m && m.hourly && m.hourly.wave_height && m.hourly.wave_height.some(v => v != null)) {
    const MH = m.hourly, U = m.hourly_units || {};
    const sstC = String(U.sea_surface_temperature || "").includes("C");
    const curK = String(U.ocean_current_velocity || "").includes("km");
    const val = (arr, i, f) => arr && arr[i] != null ? (f ? f(arr[i]) : arr[i]) : null;
    marine = MH.time.map((s, i) => ({
      t: new Date(s), wave: val(MH.wave_height, i), per: val(MH.wave_period, i), wdir: val(MH.wave_direction, i),
      sst: val(MH.sea_surface_temperature, i, v => sstC ? v * 9 / 5 + 32 : v),
      cur: val(MH.ocean_current_velocity, i, v => curK ? v / 1.609 : v), cdir: val(MH.ocean_current_direction, i)
    }));
  }
  const D = w.daily;
  const days = D.time.map((s, i) => {
    const [y, mo, da] = s.split("-").map(Number);
    const date = new Date(y, mo - 1, da);
    const d = { date, code: D.weather_code[i], hi: D.temperature_2m_max[i], lo: D.temperature_2m_min[i], sunrise: new Date(D.sunrise[i]), sunset: new Date(D.sunset[i]) };
    d.hours = hours.filter(h => sameDay(h.t, date));
    d.marine = marine ? marine.filter(h => sameDay(h.t, date)) : null;
    d.tides = t ? t.hilo.filter(x => sameDay(x.t, date)) : null;
    d.curve = t ? t.curve.filter(x => sameDay(x.t, date)) : null;
    d.moon = moonInfo(date, sp.lat, sp.lon);
    return d;
  });
  const res = { sp, hours, marine, tides: t, days };
  scoreDays(res);
  return res;
}

/* ---------------- sun, moon, score ---------------- */
function phaseName(p) {
  if (p < 0.03 || p > 0.97) return "New moon"; if (p < 0.22) return "Waxing crescent"; if (p < 0.28) return "First quarter";
  if (p < 0.47) return "Waxing gibbous"; if (p < 0.53) return "Full moon"; if (p < 0.72) return "Waning gibbous";
  if (p < 0.78) return "Last quarter"; return "Waning crescent";
}
function moonInfo(date, lat, lon) {
  const noon = new Date(date); noon.setHours(12);
  const ill = SunCalc.getMoonIllumination(noon);
  const tm = SunCalc.getMoonTimes(date, lat, lon);
  let maxA = -9, minA = 9, over = null, under = null;
  for (let mn = 0; mn < 1440; mn += 10) {
    const t = new Date(date.getTime() + mn * 60e3);
    const a = SunCalc.getMoonPosition(t, lat, lon).altitude;
    if (a > maxA) { maxA = a; over = t; } if (a < minA) { minA = a; under = t; }
  }
  return { phase: ill.phase, frac: ill.fraction, name: phaseName(ill.phase), rise: tm.rise || null, set: tm.set || null, over, under };
}
function scoreDays(res) {
  const ranges = res.days.map(d => d.tides && d.tides.length >= 2 ? Math.max(...d.tides.map(x => x.v)) - Math.min(...d.tides.map(x => x.v)) : null);
  const valid = ranges.filter(x => x != null);
  const maxR = valid.length ? Math.max(0.1, ...valid) : 1;
  res.days.forEach((d, i) => {
    const day = d.hours.filter(h => h.t.getHours() >= 5 && h.t.getHours() <= 20);
    const parts = [];
    if (day.length) {
      const wa = avg(day.map(h => h.wind));
      parts.push({ k: "Wind", got: wa <= 8 ? 25 : wa <= 12 ? 20 : wa <= 15 ? 13 : wa <= 20 ? 6 : 0, max: 25, txt: `averages ${Math.round(wa)} mph in daylight` });
      const dp = d.hours[d.hours.length - 1].pres - d.hours[0].pres;
      parts.push({ k: "Pressure", got: dp <= -4 ? 8 : dp <= -0.5 ? 20 : dp < 0.5 ? 14 : dp < 3 ? 9 : 4, max: 20,
        txt: (dp <= -4 ? `dropping fast, storm risk` : dp <= -0.5 ? `slowly falling` : dp >= 0.5 ? `rising` : "steady") + ` (${inHg(d.hours[0].pres).toFixed(2)} → ${inHg(d.hours[d.hours.length - 1].pres).toFixed(2)} inHg)` });
    }
    const p = d.moon.phase, dist = Math.min(p, Math.abs(p - 0.5), 1 - p);
    parts.push({ k: "Moon", got: Math.round(20 * (1 - dist / 0.25)), max: 20, txt: d.moon.name });
    if (ranges[i] != null) parts.push({ k: "Tide movement", got: Math.round(20 * ranges[i] / maxR), max: 20, txt: `${ranges[i].toFixed(1)} ft between high and low` });
    if (d.marine && d.marine.length) {
      const dw = d.marine.filter(h => h.t.getHours() >= 5 && h.t.getHours() <= 20 && h.wave != null).map(h => h.wave);
      if (dw.length) { const wv = Math.max(...dw); parts.push({ k: "Waves", got: wv <= 1 ? 15 : wv <= 2 ? 12 : wv <= 3 ? 7 : wv <= 4 ? 3 : 0, max: 15, txt: `up to ${wv.toFixed(1)} ft` }); }
    }
    d.parts = parts;
    d.score = Math.round(sum(parts.map(x => x.got)) / sum(parts.map(x => x.max)) * 100);
    d.label = d.score >= 80 ? "Excellent" : d.score >= 65 ? "Good" : d.score >= 45 ? "Fair" : "Poor";
    d.windows = bestWindows(d);
  });
}
function bestWindows(d) {
  const r = new Array(24).fill(0);
  const add = (t, half, wt) => {
    if (!t || !sameDay(t, d.date)) return;
    const c = t.getHours() + t.getMinutes() / 60;
    for (let h = 0; h < 24; h++) if (Math.abs(h + 0.5 - c) <= half + 0.5) r[h] += wt;
  };
  add(d.moon.over, 1, 3); add(d.moon.under, 1, 3); add(d.moon.rise, 0.5, 2); add(d.moon.set, 0.5, 2);
  add(d.sunrise, 1, 2.5); add(d.sunset, 1, 2.5);
  (d.tides || []).forEach(x => add(x.t, 1, 2));
  d.hours.forEach(h => { const H = h.t.getHours(); if (h.wind > 15) r[H] -= 2; if (h.wind > 20) r[H] -= 3; });
  for (let h = 0; h < 24; h++) if (h < 5 || h > 21) r[h] -= 1.5;
  const blocks = [];
  for (let h = 0; h < 23; h++) blocks.push({ h, s: r[h] + r[h + 1] });
  blocks.sort((a, b) => b.s - a.s);
  const out = [];
  for (const b of blocks) { if (out.length >= 2 || b.s <= 2) break; if (out.some(o => Math.abs(o.h - b.h) < 3)) continue; out.push(b); }
  out.sort((a, b) => a.h - b.h);
  return { rating: r, list: out.map(b => ({ start: b.h, end: b.h + 2, why: reasons(d, b.h) })) };
}
function hourBite(d, h) {
  const r = d.windows.rating, mx = Math.max(...r), mn = Math.min(...r), n = mx > mn ? (r[h] - mn) / (mx - mn) : 0.5;
  return clamp(Math.round(d.score * 0.55 + n * 45 - 5), 3, 97);
}
function windAlert(d) {
  const day = d.hours.filter(h => h.t.getHours() >= 5 && h.t.getHours() <= 21);
  if (!day.length) return null;
  const top = day.reduce((a, b) => (b.wind > a.wind ? b : a));
  const gust = Math.max(...day.map(h => h.gust || 0));
  if (top.wind < 15 && gust < 22) return null;
  return `Strong wind ${Math.round(top.wind)} mph ${compass(top.dir)} around ${fmtH(top.t.getHours())}, gusts to ${Math.round(gust)} mph`;
}
function biteChart(d) {
  const hs = [1, 4, 7, 10, 13, 16, 19, 22].map(h => ({ h, hr: d.hours.find(x => x.t.getHours() === h) })).filter(x => x.hr);
  if (!hs.length) return "";
  const W = 344, cw = W / hs.length, ps = hs.map(x => inHg(x.hr.pres)), lo = Math.min(...ps), hi = Math.max(...ps), rg = Math.max(0.03, hi - lo);
  const py = v => 34 + (hi - v) / rg * 34;
  const line = hs.map((x, i) => (i ? "L" : "M") + (cw * i + cw / 2).toFixed(1) + " " + py(ps[i]).toFixed(1)).join(" ");
  const cols = hs.map((x, i) => {
    const b = hourBite(d, x.h), cx = cw * i + cw / 2, bh = 8 + b * 0.62, col = b >= 55 ? "var(--good)" : b >= 40 ? "#3aa6b9" : "#3a6fc9";
    return `<text x="${cx}" y="12" text-anchor="middle" fill="var(--muted)" font-size="10">${fmtH(x.h)}</text>
      <circle cx="${cx}" cy="${py(ps[i])}" r="3.5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2"/>
      <text x="${cx}" y="${py(ps[i]) - 7}" text-anchor="middle" fill="var(--ink)" font-size="10">${ps[i].toFixed(2)}</text>
      <rect x="${cx - cw / 2 + 4}" y="${170 - bh}" width="${cw - 8}" height="${bh}" rx="4" fill="${col}"/>
      <text x="${cx}" y="${170 - bh + 14}" text-anchor="middle" fill="#0b1d2a" font-size="11" font-weight="700">${b}%</text>
      <text x="${cx}" y="188" text-anchor="middle" fill="var(--muted)" font-size="10">${Math.round(x.hr.temp)}°</text>`;
  }).join("");
  return `<svg class="tide" viewBox="0 0 ${W} 194" role="img" aria-label="Bite chance and pressure by hour"><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${cols}</svg>
    <p class="muted small" style="margin:0">Top line: pressure in inHg. Bars: chance of a good bite. Bottom: air temperature.</p>`;
}
function reasons(d, h) {
  const ev = [];
  const near = (t, n) => { if (t && sameDay(t, d.date)) { const c = t.getHours() + t.getMinutes() / 60; if (c >= h - 1 && c <= h + 3) ev.push(n); } };
  near(d.sunrise, "sunrise"); near(d.sunset, "sunset"); near(d.moon.over, "moon overhead"); near(d.moon.under, "moon underfoot");
  near(d.moon.rise, "moonrise"); near(d.moon.set, "moonset");
  (d.tides || []).forEach(x => near(x.t, x.type === "H" ? "high tide" : "low tide"));
  return [...new Set(ev)].join(", ") || "calm conditions";
}
function nowHour(data) {
  const n = Date.now(); let best = data.hours[0], bd = 1e15;
  data.hours.forEach(h => { const d = Math.abs(h.t - n); if (d < bd) { bd = d; best = h; } });
  return best;
}
function nearest(arr, t) { if (!arr || !arr.length) return null; let b = arr[0], bd = 1e15; arr.forEach(x => { const d = Math.abs(x.t - t); if (d < bd) { bd = d; b = x; } }); return b; }
const WX = c => c == null ? "" : c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : "Thunderstorms";

/* ---------------- tabs ---------------- */
let tab = "home";
function show(t) {
  tab = t;
  $$(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + t));
  $$("nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  if (t === "home") renderHome();
  if (t === "spot") renderSpot();
  if (t === "log") renderLog();
  if (t === "map") openMap();
}
$$("nav button").forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
$("#refresh").addEventListener("click", () => { Object.keys(cache).forEach(k => delete cache[k]); Object.keys(obsCache).forEach(k => delete obsCache[k]); gridCache = {}; show(tab); });

/* ---------------- home ---------------- */
function renderHome() {
  const el = $("#tab-home");
  el.innerHTML = `<div class="row between"><h2>My spots</h2><button class="btn ghost" id="addSpot">+ Add spot</button></div>` +
    spots.map(s => `<article class="card spot" data-id="${s.id}" tabindex="0">
      <div class="row between"><div class="name">${esc(s.name)}</div><div class="now" id="now-${s.id}"><span class="loading">Loading…</span></div></div>
      <div class="week" id="wk-${s.id}">${Array.from({ length: 7 }, () => `<div class="dayc s-none">··<b>–</b></div>`).join("")}</div>
    </article>`).join("") +
    `<p class="muted small">Scores rate each day for fishing from wind, pressure, moon, tide movement and waves. Tap a spot for the full forecast.</p>`;
  $("#addSpot").onclick = () => spotSheet();
  $$(".spot").forEach(c => {
    const go = () => { selId = c.dataset.id; LS.set("gb_sel", selId); selDay = 0; show("spot"); };
    c.onclick = go; c.onkeydown = e => { if (e.key === "Enter") go(); };
  });
  spots.forEach(async s => {
    try {
      const d = await loadSpot(s);
      const h = nowHour(d);
      const nowEl = $("#now-" + s.id); if (!nowEl) return;
      nowEl.innerHTML = `<b>${Math.round(h.temp)}°F</b><span class="mono">${arrowSVG(h.dir, "var(--accent)")} ${Math.round(h.wind)} mph</span>`;
      $("#wk-" + s.id).innerHTML = d.days.map(x => `<div class="dayc ${scoreClass(x.score)}">${dayName(x.date)}<b>${x.score}</b></div>`).join("");
    } catch (e) {
      const nowEl = $("#now-" + s.id); if (nowEl) nowEl.innerHTML = `<span class="err">Offline</span>`;
    }
  });
}

/* ---------------- NOAA live observations (CO-OPS) ---------------- */
const obsCache = {};
async function obsStations() {
  const c = LS.get("gb_obsst", null);
  if (c && Date.now() - c.ts < 30 * 864e5) return c.list;
  const j = await getJSON("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels");
  const list = (j.stations || []).map(s => [s.id, s.name, +s.lat, +s.lng]);
  LS.set("gb_obsst", { ts: Date.now(), list });
  return list;
}
async function nearestObs(lat, lon, maxMi) {
  const list = await obsStations(); let best = null, bd = 1e9;
  list.forEach(s => { const d = miles(lat, lon, s[2], s[3]); if (d < bd) { bd = d; best = s; } });
  return best && bd <= maxMi ? { id: best[0], name: best[1], lat: best[2], lon: best[3], dist: bd } : null;
}
async function latestObs(id) {
  const c = obsCache[id]; if (c && Date.now() - c.ts < 6 * 60e3) return c.o;
  const u = p => `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=${id}&product=${p}&units=english&time_zone=lst_ldt&format=json&application=GulfBite${p === "water_level" ? "&datum=MLLW" : ""}`;
  const [wt, wi, ap, wl] = await Promise.allSettled(["water_temperature", "wind", "air_pressure", "water_level"].map(p => getJSON(u(p))));
  const first = r => r.status === "fulfilled" && r.value && r.value.data && r.value.data[0] ? r.value.data[0] : null;
  const tt = x => new Date(x.t.replace(" ", "T"));
  const o = {}, a = first(wt), b = first(wi), p = first(ap), l = first(wl);
  if (a && a.v !== "") o.temp = { v: +a.v, t: tt(a) };
  if (b && b.s !== "") o.wind = { mph: +b.s * 1.15078, gust: b.g !== "" ? +b.g * 1.15078 : null, dir: +b.d, dr: b.dr, t: tt(b) };
  if (p && p.v !== "") o.pres = { v: inHg(+p.v), t: tt(p) };
  if (l && l.v !== "") o.level = { v: +l.v, t: tt(l) };
  obsCache[id] = { ts: Date.now(), o };
  return o;
}
function ago(t) { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " hr ago"; }
function obsHTML(o) {
  const items = [];
  if (o.temp) items.push(`<div><span>Water temp</span><b>${o.temp.v.toFixed(1)}°F</b></div>`);
  if (o.wind) items.push(`<div><span>Wind ${esc(o.wind.dr || compass(o.wind.dir))}</span><b>${Math.round(o.wind.mph)}${o.wind.gust != null ? `<span class="muted">/${Math.round(o.wind.gust)}</span>` : ""} mph</b></div>`);
  if (o.pres) items.push(`<div><span>Pressure</span><b>${o.pres.v.toFixed(2)} inHg</b></div>`);
  if (o.level) items.push(`<div><span>Water level</span><b>${o.level.v.toFixed(2)} ft</b></div>`);
  if (!items.length) return `<p class="muted small" style="margin:0">This station isn't reporting right now.</p>`;
  const t = (o.temp || o.wind || o.pres || o.level).t;
  return `<div class="kv">${items.join("")}</div><p class="muted small" style="margin:0">Measured ${ago(t)}</p>`;
}
async function fillObsCard(sp) {
  const el = $("#obsCard"); if (!el) return;
  try {
    const st = await nearestObs(sp.lat, sp.lon, 35);
    if (!st) { el.innerHTML = `<h3>Right now · NOAA</h3><p class="muted small" style="margin:0">No NOAA station within 35 miles of this spot.</p>`; return; }
    const o = await latestObs(st.id);
    if (!$("#obsCard")) return;
    $("#obsCard").innerHTML = `<h3>Right now · NOAA ${esc(st.name)}</h3>${obsHTML(o)}<p class="muted small" style="margin:0">${st.dist.toFixed(0)} mi from this spot. These are real measurements, not a forecast.</p>`;
  } catch (e) { el.innerHTML = `<h3>Right now · NOAA</h3><p class="muted small" style="margin:0">NOAA readings couldn't load. Tap refresh to try again.</p>`; }
}

/* ---------------- spot detail ---------------- */
async function renderSpot() {
  const el = $("#tab-spot"), sp = curSpot();
  el.innerHTML = `<div class="row between"><div><h2>${esc(sp.name)}</h2><div class="muted small mono">${sp.lat.toFixed(4)}, ${sp.lon.toFixed(4)}</div></div>
    <div class="row"><button class="btn quiet" id="editSpot">Edit</button></div></div><p class="loading">Getting the forecast…</p>`;
  $("#editSpot").onclick = () => spotSheet(sp);
  let data;
  try { data = await loadSpot(sp); } catch (e) { el.querySelector(".loading").outerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (curSpot().id !== sp.id || tab !== "spot") return;
  selDay = Math.min(selDay, data.days.length - 1);
  const d = data.days[selDay];
  const chips = data.days.map((x, i) => `<button class="chip ${i === selDay ? "on" : ""}" data-i="${i}">${i === 0 ? "Today" : dayName(x.date)}<i style="background:${scoreColor(x.score)}">${x.score}</i></button>`).join("");
  const parts = d.parts.map(p => `<div class="bar"><span>${p.k}</span><div class="tr"><span style="width:${Math.round(p.got / p.max * 100)}%"></span></div><small>${esc(p.txt)}</small></div>`).join("");
  const wins = d.windows.list.length ? d.windows.list.map(w => `<div class="win"><b>${fmtH(w.start)}–${fmtH(w.end)}</b><span class="muted small">${esc(w.why)}</span></div>`).join("") : `<p class="muted small">No standout window. Conditions are even through the day.</p>`;
  const maxR = Math.max(1, ...d.windows.rating);
  const strip = d.windows.rating.map((v, h) => `<span title="${fmtH(h)}" style="background:${v <= 0 ? "var(--card2)" : `rgba(255,181,71,${(0.2 + 0.8 * v / maxR).toFixed(2)})`}"></span>`).join("");
  const rows = d.hours.filter(h => h.t.getHours() >= 5 && h.t.getHours() <= 21 && h.t.getHours() % 2 === 1).map(h => {
    const m = d.marine ? nearest(d.marine, h.t) : null;
    return `<tr><td>${fmtH(h.t.getHours())}</td><td>${arrowSVG(h.dir, "var(--accent)")} ${Math.round(h.wind)}<span class="muted">/${Math.round(h.gust)}</span></td>${data.marine ? `<td>${m && m.wave != null ? m.wave.toFixed(1) : "–"}</td>` : ""}<td>${Math.round(h.temp)}°</td><td>${h.pop != null ? h.pop + "%" : "–"}</td></tr>`;
  }).join("");
  const sstVals = d.marine ? d.marine.map(h => h.sst).filter(v => v != null) : [];
  const curVals = d.marine ? d.marine.map(h => h.cur).filter(v => v != null) : [];
  el.innerHTML = `
    <div class="row between"><div><h2>${esc(sp.name)}</h2><div class="muted small mono">${sp.lat.toFixed(4)}, ${sp.lon.toFixed(4)}</div></div>
      <div class="row"><button class="btn quiet" id="editSpot">Edit</button></div></div>
    <div class="chips" id="dayChips">${chips}</div>
    ${selDay === 0 ? `<section class="card" id="obsCard"><h3>Right now · NOAA</h3><p class="loading">Getting live readings…</p></section>` : ""}
    <section class="card">
      <h3>${dayLong(d.date)}</h3>
      <div class="big"><div class="ring" style="background:${scoreColor(d.score)}">${d.score}</div>
        <div><div style="font:600 20px var(--font-display)">${d.label} fishing</div><div class="muted small">${WX(d.code)} · ${Math.round(d.lo)}° to ${Math.round(d.hi)}°F</div></div></div>
      <div class="bars">${parts}</div>
    </section>
    ${windAlert(d) ? `<div class="card" style="border-color:var(--poor);background:rgba(229,83,75,.12)"><div class="row"><span style="color:var(--poor);font-size:20px">⚠</span><b>${esc(windAlert(d))}</b></div></div>` : ""}
    <section class="card"><h3>Bite chance by hour</h3>${biteChart(d)}</section>
    <section class="card"><h3>Best times to fish</h3>${wins}
      <div class="strip" aria-label="Bite rating by hour">${strip}</div>
      <div class="strip-l"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
      <p class="muted small" style="margin:0">Based on solunar periods (moon overhead and underfoot), sunrise and sunset, and tide changes, with windy hours marked down.</p>
    </section>
    <section class="card"><h3>Tides</h3>${tideBlock(data, d)}</section>
    <section class="card"><h3>Wind${data.marine ? ", waves" : ""} & weather</h3>
      <div class="tbl"><table><thead><tr><th>Time</th><th>Wind/gust mph</th>${data.marine ? "<th>Waves ft</th>" : ""}<th>Air</th><th>Rain</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${data.marine ? "" : `<p class="muted small" style="margin:0">No wave forecast here. This spot looks inland or sheltered.</p>`}
    </section>
    <section class="card"><h3>Water, sun & moon</h3><div class="kv">
      <div><span>Water temp</span><b>${sstVals.length ? Math.round(avg(sstVals)) + "°F" : "—"}</b></div>
      <div><span>Strongest current</span><b>${curVals.length ? Math.max(...curVals).toFixed(1) + " mph" : "—"}</b></div>
      <div><span>Sunrise</span><b>${fmtT(d.sunrise)}</b></div><div><span>Sunset</span><b>${fmtT(d.sunset)}</b></div>
      <div><span>Moonrise</span><b>${sameDay(d.moon.rise, d.date) ? fmtT(d.moon.rise) : "—"}</b></div><div><span>Moonset</span><b>${sameDay(d.moon.set, d.date) ? fmtT(d.moon.set) : "—"}</b></div>
      <div><span>Moon</span><b>${d.moon.name}</b></div><div><span>Moon lit</span><b>${Math.round(d.moon.frac * 100)}%</b></div>
    </div>
    ${sstVals.length ? `<p class="muted small" style="margin:0">Water temperature is the offshore sea-surface forecast. Shallow bays and bayous can run a few degrees different.</p>` : ""}</section>
    <div class="row"><button class="btn" id="logHere">Log a catch here</button><button class="btn ghost" id="mapHere">Show on map</button></div>
    <p class="muted small">Weather & marine: Open-Meteo. Tides: NOAA. Sun & moon: calculated on your phone.</p>`;
  $("#editSpot").onclick = () => spotSheet(sp);
  $$("#dayChips .chip").forEach(b => b.onclick = () => { selDay = +b.dataset.i; renderSpot(); });
  if (selDay === 0) fillObsCard(sp);
  $("#logHere").onclick = () => catchSheet({ spotId: sp.id });
  $("#mapHere").onclick = () => { pendingCenter = [sp.lat, sp.lon]; show("map"); };
}
function tideBlock(data, d) {
  if (!data.tides) return `<p class="muted small" style="margin:0">${data.tideError ? "Tide data couldn't load right now. Tap refresh to try again." : "No NOAA tide station within 40 miles. This spot is likely inland or non-tidal."}</p>`;
  const c = d.curve || [];
  if (!c.length) return `<p class="muted small">No tide predictions for this day.</p>`;
  const W = 340, H = 120, P = 18;
  const vs = c.map(x => x.v), lo = Math.min(...vs), hi = Math.max(...vs), rg = Math.max(0.2, hi - lo);
  const X = t => P + (t.getHours() + t.getMinutes() / 60) / 24 * (W - 2 * P);
  const Y = v => H - P - (v - lo) / rg * (H - 2 * P - 10);
  const path = c.map((x, i) => (i ? "L" : "M") + X(x.t).toFixed(1) + " " + Y(x.v).toFixed(1)).join(" ");
  const area = path + ` L${X(c[c.length - 1].t).toFixed(1)} ${H - P} L${X(c[0].t).toFixed(1)} ${H - P} Z`;
  const now = new Date();
  const nowLine = sameDay(now, d.date) ? `<line x1="${X(now)}" x2="${X(now)}" y1="6" y2="${H - P}" stroke="var(--accent)" stroke-dasharray="3 3"/><text x="${X(now) + 3}" y="14" fill="var(--accent)" font-size="10">now</text>` : "";
  const marks = (d.tides || []).map(x => `<circle cx="${X(x.t)}" cy="${Y(x.v)}" r="3.5" fill="var(--ink)"/><text x="${X(x.t)}" y="${Y(x.v) + (x.type === "H" ? -7 : 15)}" text-anchor="middle" fill="var(--ink)" font-size="10">${x.v.toFixed(1)}′</text>`).join("");
  const ticks = [0, 6, 12, 18, 24].map(h => `<text x="${P + h / 24 * (W - 2 * P)}" y="${H - 3}" text-anchor="middle" fill="var(--muted)" font-size="9">${h === 24 ? "" : fmtH(h)}</text>`).join("");
  const list = (d.tides || []).map(x => `<tr><td>${x.type === "H" ? "High" : "Low"}</td><td>${fmtT(x.t)}</td><td>${x.v.toFixed(1)} ft</td></tr>`).join("");
  return `<svg class="tide" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tide height through the day">
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--line)"/>
    <path d="${area}" fill="rgba(80,170,230,.22)"/><path d="${path}" fill="none" stroke="#5fb4ea" stroke-width="2"/>${marks}${nowLine}${ticks}</svg>
    <div class="tbl"><table><tbody>${list}</tbody></table></div>
    <p class="muted small" style="margin:0">NOAA station: ${esc(data.tides.station)} (${data.tides.dist.toFixed(0)} mi away). Heights above mean lower low water.</p>`;
}

/* ---------------- spot add / edit sheet ---------------- */
function openSheet(html) { $("#panel").innerHTML = html; $("#sheet").classList.add("open"); }
function closeSheet() { $("#sheet").classList.remove("open"); }
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
function spotSheet(sp, latlon) {
  if (sp && sp._new) { latlon = [sp.lat, sp.lon]; sp = { name: sp.name, lat: sp.lat, lon: sp.lon, _prefill: true }; }
  const isNew = !sp || sp._prefill;
  const s = sp || { name: "", lat: latlon ? latlon[0] : "", lon: latlon ? latlon[1] : "" };
  openSheet(`<h2>${isNew ? "Add a spot" : "Edit spot"}</h2>
    <label class="f" for="spName">Name<input id="spName" value="${esc(s.name)}" placeholder="e.g. Lynn Haven Bayou"></label>
    <div class="grid2"><label class="f" for="spLat">Latitude<input id="spLat" inputmode="decimal" value="${s.lat === "" ? "" : (+s.lat).toFixed(5)}"></label>
      <label class="f" for="spLon">Longitude<input id="spLon" inputmode="decimal" value="${s.lon === "" ? "" : (+s.lon).toFixed(5)}"></label></div>
    <button class="btn quiet" id="spGps">Use my current location</button>
    <p class="err" id="spErr"></p>
    <div class="row"><button class="btn" id="spSave">Save spot</button><button class="btn quiet" id="spCancel">Cancel</button>
    ${!isNew && spots.length > 1 ? `<button class="btn danger" id="spDel">Delete</button>` : ""}</div>`);
  $("#spCancel").onclick = closeSheet;
  $("#spGps").onclick = () => {
    if (!navigator.geolocation) { $("#spErr").textContent = "This phone isn't sharing location with the app."; return; }
    $("#spErr").textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(p => { $("#spLat").value = p.coords.latitude.toFixed(5); $("#spLon").value = p.coords.longitude.toFixed(5); $("#spErr").textContent = ""; },
      () => { $("#spErr").textContent = "Location is blocked. Allow it in your phone settings, or type the numbers in."; }, { enableHighAccuracy: true, timeout: 15000 });
  };
  $("#spSave").onclick = () => {
    const name = $("#spName").value.trim(), lat = parseFloat($("#spLat").value), lon = parseFloat($("#spLon").value);
    if (!name) { $("#spErr").textContent = "Give the spot a name."; return; }
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { $("#spErr").textContent = "Latitude and longitude need to be numbers, like 30.2 and -85.6."; return; }
    if (isNew) { const ns = { id: uid(), name, lat, lon }; spots.push(ns); selId = ns.id; }
    else { Object.assign(sp, { name, lat, lon }); delete cache[sp.id]; }
    LS.set("gb_sel", selId); saveSpots(); closeSheet(); selDay = 0; show(isNew ? "spot" : tab);
    if (mapReady) drawMarks();
  };
  const del = $("#spDel");
  if (del) del.onclick = () => {
    if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Tap again to delete"; return; }
    spots = spots.filter(x => x.id !== sp.id); selId = spots[0].id; saveSpots(); LS.set("gb_sel", selId); closeSheet(); show("home"); if (mapReady) drawMarks();
  };
}

/* ---------------- map ---------------- */
let noaaOn = true, obsLayer = null;
let hotOn = true, hotLayer = null, hotCache = {}, hotTimer = null;
let map = null, mapReady = false, layerMode = "wind", gridLayer = null, markLayer = null, gridCache = {}, gridTimer = null, pendingCenter = null, gridData = null;
const SCALES = {
  wind: { unit: "mph", stops: [[0, "#4a7bd0"], [5, "#3ec1e0"], [10, "#4fd18b"], [15, "#e3d44a"], [20, "#f39a3d"], [25, "#e8504f"], [35, "#b03a8c"]] },
  waves: { unit: "ft", stops: [[0, "#3a6fc9"], [1, "#3ec1e0"], [2, "#4fd18b"], [3, "#e3d44a"], [4, "#f39a3d"], [6, "#e8504f"], [8, "#b03a8c"]] },
  sst: { unit: "°F", stops: [[50, "#3a4fc9"], [60, "#3e9be0"], [68, "#4fd18b"], [75, "#e3d44a"], [82, "#f39a3d"], [88, "#e8504f"]] }
};
function colorAt(mode, v) {
  const st = SCALES[mode].stops; if (v <= st[0][0]) return st[0][1]; if (v >= st[st.length - 1][0]) return st[st.length - 1][1];
  for (let i = 1; i < st.length; i++) if (v <= st[i][0]) {
    const [a, ca] = st[i - 1], [b, cb] = st[i], f = (v - a) / (b - a);
    const h = c => [1, 3, 5].map(j => parseInt(c.slice(j, j + 2), 16));
    const A = h(ca), B = h(cb); return "rgb(" + A.map((x, k) => Math.round(x + (B[k] - x) * f)).join(",") + ")";
  }
}
function legend() {
  const s = SCALES[layerMode], st = s.stops, lo = st[0][0], hi = st[st.length - 1][0];
  $("#legend").innerHTML = `<div>${{ wind: "Wind", waves: "Wave height", sst: "Water temp" }[layerMode]} (${s.unit})</div>
    <div class="grad" style="background:linear-gradient(90deg,${st.map(x => `${x[1]} ${((x[0] - lo) / (hi - lo) * 100).toFixed(0)}%`).join(",")})"></div>
    <div class="ticks">${st.map(x => `<span>${x[0]}</span>`).join("")}</div>`;
}
function openMap() {
  if (typeof L === "undefined") { $("#mapStatus").textContent = "Map couldn't load"; return; }
  const sp = curSpot();
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView(pendingCenter || [sp.lat, sp.lon], 10);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "Imagery © Esri" }).addTo(map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, opacity: .8 }).addTo(map);
    gridLayer = L.layerGroup().addTo(map); hotLayer = L.layerGroup().addTo(map); obsLayer = L.layerGroup().addTo(map); markLayer = L.layerGroup().addTo(map);
    map.on("moveend", () => { clearTimeout(gridTimer); gridTimer = setTimeout(loadGrid, 400); clearTimeout(hotTimer); hotTimer = setTimeout(loadHot, 700); });
    $("#noaaBtn").onclick = () => { noaaOn = !noaaOn; $("#noaaBtn").classList.toggle("on", noaaOn); $("#noaaBtn").setAttribute("aria-pressed", noaaOn); drawObs(); };
    map.on("moveend", drawObs);
    $("#hotBtn").onclick = () => { hotOn = !hotOn; $("#hotBtn").classList.toggle("on", hotOn); $("#hotBtn").setAttribute("aria-pressed", hotOn); loadHot(); };
    map.on("click", e => {
      const ll = [e.latlng.lat, e.latlng.lng];
      const div = document.createElement("div"); div.className = "pop";
      div.innerHTML = `<div class="pinfo loading">Checking conditions…</div><span class="muted small mono">${ll[0].toFixed(4)}, ${ll[1].toFixed(4)}</span><button class="btn">Save as a spot</button><button class="btn quiet">Log a catch here</button>`;
      pointInfo(ll, div.querySelector(".pinfo"));
      const btns = div.querySelectorAll("button");
      btns[0].onclick = () => { map.closePopup(); spotSheet(null, ll); };
      btns[1].onclick = () => { map.closePopup(); catchSheet({ lat: ll[0], lon: ll[1] }); };
      L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
    });
    $$("#layerSeg button").forEach(b => b.onclick = () => { layerMode = b.dataset.l; $$("#layerSeg button").forEach(x => x.classList.toggle("on", x === b)); legend(); loadGrid(); });
    $("#mapSlider").oninput = drawGrid;
    mapReady = true; legend();
  } else if (pendingCenter) map.setView(pendingCenter, Math.max(map.getZoom(), 11));
  pendingCenter = null;
  setTimeout(() => { map.invalidateSize(); loadGrid(); loadHot(); drawObs(); }, 60);
  drawMarks();
}
function drawMarks() {
  if (!markLayer) return; markLayer.clearLayers();
  spots.forEach(s => {
    const m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="pin"><span>📍</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(markLayer);
    m.on("click", () => { selId = s.id; LS.set("gb_sel", selId); selDay = 0; show("spot"); });
  });
  const groups = [];
  catches.filter(c => c.lat != null).forEach(c => {
    const g = groups.find(g => miles(g.lat, g.lon, c.lat, c.lon) < 0.4);
    if (g) g.list.push(c); else groups.push({ lat: c.lat, lon: c.lon, list: [c] });
  });
  groups.filter(g => g.list.length >= 2).forEach(g => {
    const top = topOf(g.list.map(c => c.species)), bait = topOf(g.list.map(c => c.bait));
    L.marker([g.lat, g.lon], { zIndexOffset: 500, icon: L.divIcon({ className: "", html: `<div class="star">⭐<b>${g.list.length}</b></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>Your hotspot: ${g.list.length} catches</b><br>Most caught: ${esc(top)}<br>Best bait: ${esc(bait)}`).addTo(markLayer);
  });
  groups.filter(g => g.list.length < 2).map(g => g.list[0]).forEach(c => {
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<div class="fishm">🐟</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
      .bindPopup(`<b>${esc(c.species || "Catch")}</b><br><span class="muted">${new Date(c.time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>${c.bait ? `<br>Bait: ${esc(c.bait)}` : ""}`).addTo(markLayer);
  });
}
async function drawObs() {
  if (!obsLayer) return;
  obsLayer.clearLayers();
  if (!noaaOn) return;
  let list; try { list = await obsStations(); } catch (e) { $("#mapStatus").textContent = "NOAA stations unavailable"; return; }
  const b = map.getBounds().pad(0.1);
  list.filter(s => b.contains([s[2], s[3]])).slice(0, 60).forEach(s => {
    const m = L.marker([s[2], s[3]], { zIndexOffset: 300, icon: L.divIcon({ className: "", html: `<div class="obs">N</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(obsLayer);
    m.on("click", async () => {
      const div = document.createElement("div"); div.className = "pop";
      div.innerHTML = `<b>${esc(s[1])}</b><span class="muted small">NOAA station ${esc(s[0])} · live readings</span><div class="loading">Getting readings…</div>`;
      L.popup().setLatLng([s[2], s[3]]).setContent(div).openOn(map);
      try { const o = await latestObs(s[0]); div.querySelector(".loading").outerHTML = obsHTML(o); }
      catch (e) { div.querySelector(".loading").textContent = "Readings couldn't load."; }
    });
  });
}
async function loadHot() {
  if (!hotLayer) return;
  if (!hotOn) { hotLayer.clearLayers(); return; }
  if (map.getZoom() < 9) { hotLayer.clearLayers(); $("#mapStatus").textContent = "Zoom in to see hotspots"; return; }
  const b = map.getBounds(), r = v => v.toFixed(2);
  const bb = `${r(b.getSouth())},${r(b.getWest())},${r(b.getNorth())},${r(b.getEast())}`;
  try {
    if (!hotCache[bb]) {
      const q = `[out:json][timeout:25];(node["leisure"="fishing"](${bb});way["leisure"="fishing"](${bb});node["fishing"="yes"](${bb});way["fishing"="yes"](${bb});way["man_made"="pier"](${bb});node["man_made"="pier"](${bb});node["leisure"="slipway"](${bb});way["leisure"="slipway"](${bb}););out center 250;`;
      const j = await getJSON("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q));
      hotCache[bb] = (j.elements || []).map(e => {
        const t = e.tags || {}, lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
        const kind = t.leisure === "slipway" ? "ramp" : t.man_made === "pier" ? "pier" : "fish";
        return { lat, lon, kind, name: t.name || { ramp: "Boat ramp", pier: "Fishing pier", fish: "Fishing spot" }[kind] };
      }).filter(x => x.lat != null && !(x.kind === "pier" && false));
    }
    if (!hotOn) return;
    hotLayer.clearLayers();
    const ico = { fish: "🐟", pier: "🎣", ramp: "⛵" };
    hotCache[bb].forEach(x => {
      const m = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "", html: `<div class="hot ${x.kind}"><span>${ico[x.kind]}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(hotLayer);
      m.on("click", () => {
        const div = document.createElement("div"); div.className = "pop";
        div.innerHTML = `<b>${esc(x.name)}</b><span class="muted small">${{ fish: "Public fishing spot", pier: "Pier", ramp: "Boat ramp" }[x.kind]}</span><div class="pinfo loading">Checking conditions…</div><button class="btn">Save as a spot</button>`;
        div.querySelector("button").onclick = () => { map.closePopup(); spotSheet({ name: x.name, lat: x.lat, lon: x.lon, _new: true }); };
        pointInfo([x.lat, x.lon], div.querySelector(".pinfo"));
        L.popup({ offset: [0, -24] }).setLatLng([x.lat, x.lon]).setContent(div).openOn(map);
      });
    });
    if ($("#mapStatus").textContent.startsWith("Zoom")) $("#mapStatus").textContent = "";
  } catch (e) { $("#mapStatus").textContent = "Hotspots unavailable right now"; }
}
async function pointInfo(ll, el) {
  const t = gridData && gridData.times ? gridData.times[+$("#mapSlider").value] : new Date();
  try {
    const d = await loadSpot({ id: "pt" + ll[0].toFixed(3) + ll[1].toFixed(3), name: "Map point", lat: ll[0], lon: ll[1] });
    const h = nearest(d.hours, t), day = d.days.find(x => sameDay(x.date, h.t)) || d.days[0], m = d.marine ? nearest(d.marine, h.t) : null;
    el.className = "pinfo";
    el.innerHTML = `<div class="row" style="gap:8px">${arrowSVG(h.dir, "var(--accent)")}<b style="font:600 20px var(--font-mono)">${h.wind.toFixed(1)} mph</b><span class="muted small">${compass(h.dir)}</span></div>
      <div class="row small" style="gap:14px"><span>🐟 <b class="mono">${hourBite(day, h.t.getHours())}%</b> bite</span><span>⏲ <b class="mono">${inHg(h.pres).toFixed(2)}</b> inHg</span></div>
      <div class="row small muted" style="gap:14px"><span>${Math.round(h.temp)}°F air</span>${m && m.wave != null ? `<span>${m.wave.toFixed(1)} ft waves</span>` : ""}${m && m.sst != null ? `<span>${Math.round(m.sst)}°F water</span>` : ""}</div>
      <div class="muted small">${h.t.toLocaleString([], { weekday: "short", hour: "numeric" })} · day score ${day.score}</div>`;
  } catch (e) { el.className = "pinfo err"; el.textContent = "Couldn't get conditions here."; }
}
async function loadGrid() {
  if (!map) return;
  const b = map.getBounds(), n = 6;
  const lats = [], lons = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    lats.push(+(b.getSouth() + (i + 0.5) / n * (b.getNorth() - b.getSouth())).toFixed(3));
    lons.push(+(b.getWest() + (j + 0.5) / n * (b.getEast() - b.getWest())).toFixed(3));
  }
  const key = layerMode + lats.join() + lons.join();
  $("#mapStatus").textContent = "Loading…";
  try {
    if (!gridCache[key]) {
      const q = `latitude=${lats.join(",")}&longitude=${lons.join(",")}&timezone=auto&forecast_days=2`;
      const url = layerMode === "wind"
        ? `https://api.open-meteo.com/v1/forecast?${q}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph`
        : `https://marine-api.open-meteo.com/v1/marine?${q}&hourly=${layerMode === "waves" ? "wave_height,wave_direction" : "sea_surface_temperature"}&length_unit=imperial`;
      let j = await getJSON(url); if (!Array.isArray(j)) j = [j];
      gridCache[key] = j;
    }
    gridData = { mode: layerMode, pts: gridCache[key], lats, lons };
    const times = gridData.pts[0].hourly.time.map(s => new Date(s));
    gridData.times = times;
    const sl = $("#mapSlider"); sl.max = times.length - 1;
    if (!sl.dataset.init) { const now = Date.now(); let bi = 0; times.forEach((t, i) => { if (t <= now) bi = i; }); sl.value = bi; sl.dataset.init = "1"; }
    $("#mapStatus").textContent = "";
    drawGrid();
  } catch (e) { $("#mapStatus").textContent = "Couldn't load map data"; }
}
function drawGrid() {
  if (!gridData || !gridLayer) return;
  gridLayer.clearLayers();
  const i = +$("#mapSlider").value, t = gridData.times[i];
  if (t) $("#mapTime").textContent = t.toLocaleString([], { weekday: "short", hour: "numeric" });
  gridData.pts.forEach((p, k) => {
    const H = p.hourly, ll = [gridData.lats[k], gridData.lons[k]];
    let html = null;
    if (gridData.mode === "wind") {
      const v = H.wind_speed_10m[i], d = H.wind_direction_10m[i]; if (v == null) return;
      html = `<div class="wx">${arrowSVG(d, colorAt("wind", v)).replace('class="arrow"', "")}<span>${Math.round(v)}</span></div>`;
    } else {
      const unitC = String((p.hourly_units || {}).sea_surface_temperature || "").includes("C");
      let v = gridData.mode === "waves" ? H.wave_height[i] : H.sea_surface_temperature[i]; if (v == null) return;
      if (gridData.mode === "sst" && unitC) v = v * 9 / 5 + 32;
      html = `<div class="dot" style="background:${colorAt(gridData.mode, v)}">${gridData.mode === "waves" ? v.toFixed(1) : Math.round(v)}</div>`;
    }
    L.marker(ll, { interactive: false, icon: L.divIcon({ className: "", html, iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(gridLayer);
  });
}

/* ---------------- catch log ---------------- */
const SPECIES = ["Redfish", "Speckled trout", "Flounder", "Sheepshead", "Black drum", "Spanish mackerel", "King mackerel", "Cobia", "Snapper", "Grouper", "Pompano", "Largemouth bass", "Bream", "Crappie", "Catfish"];
const BAITS = ["Live shrimp", "Pinfish", "Mullet", "Cut bait", "Soft plastic", "Topwater", "Spoon", "Jig", "Crankbait", "Worm", "Cricket"];
function localInput(d) { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60e3); return z.toISOString().slice(0, 16); }
function catchSheet(pre) {
  pre = pre || {};
  const spotOpts = spots.map(s => `<option value="${s.id}" ${s.id === (pre.spotId || (pre.lat == null ? selId : "")) ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  openSheet(`<h2>Log a catch</h2>
    <label class="f" for="cSpot">Where<select id="cSpot">${pre.lat != null ? `<option value="pt" selected>Map point ${pre.lat.toFixed(3)}, ${pre.lon.toFixed(3)}</option>` : ""}${spotOpts}</select></label>
    <label class="f" for="cTime">When<input id="cTime" type="datetime-local" value="${localInput(new Date())}"></label>
    <label class="f" for="cSpecies">Species<input id="cSpecies" list="dlS" placeholder="Redfish"></label>
    <div class="grid2"><label class="f" for="cLen">Length (in)<input id="cLen" inputmode="decimal"></label><label class="f" for="cWt">Weight (lb)<input id="cWt" inputmode="decimal"></label></div>
    <label class="f" for="cBait">Bait or lure<input id="cBait" list="dlB" placeholder="Live shrimp"></label>
    <label class="f" for="cNotes">Notes<textarea id="cNotes" placeholder="Depth, structure, what worked"></textarea></label>
    <label class="row small" for="cRel"><input id="cRel" type="checkbox" style="width:auto;min-height:0"> Released</label>
    <datalist id="dlS">${SPECIES.map(s => `<option value="${s}">`).join("")}</datalist><datalist id="dlB">${BAITS.map(s => `<option value="${s}">`).join("")}</datalist>
    <p class="muted small" style="margin:0">The app saves the wind, pressure, tide and moon with each catch so it can show your patterns.</p>
    <p class="err" id="cErr"></p>
    <div class="row"><button class="btn" id="cSave">Save catch</button><button class="btn quiet" id="cCancel">Cancel</button></div>`);
  $("#cCancel").onclick = closeSheet;
  $("#cSave").onclick = async () => {
    const sv = $("#cSpot").value, t = new Date($("#cTime").value || Date.now());
    const sp = sv === "pt" ? { id: "pt", name: "Map point", lat: pre.lat, lon: pre.lon } : spots.find(s => s.id === sv);
    const c = { id: uid(), time: t.toISOString(), spotId: sv === "pt" ? null : sp.id, spotName: sp.name, lat: sp.lat, lon: sp.lon,
      species: $("#cSpecies").value.trim(), len: parseFloat($("#cLen").value) || null, wt: parseFloat($("#cWt").value) || null,
      bait: $("#cBait").value.trim(), notes: $("#cNotes").value.trim(), released: $("#cRel").checked, cond: null };
    $("#cSave").disabled = true; $("#cErr").textContent = "Saving conditions…";
    try { c.cond = await conditionsAt(sp, t); } catch (e) { /* save without conditions */ }
    catches.unshift(c); saveCatches(); closeSheet(); if (mapReady) drawMarks(); show("log");
  };
}
async function conditionsAt(sp, t) {
  const d = await loadSpot(sp.id === "pt" ? Object.assign({}, sp, { id: "pt" + sp.lat + sp.lon }) : sp);
  const h = nearest(d.hours, t);
  if (!h || Math.abs(h.t - t) > 3 * 3600e3) { // outside forecast window: keep moon only
    const ill = SunCalc.getMoonIllumination(t); return { moon: phaseName(ill.phase) };
  }
  const m = d.marine ? nearest(d.marine, t) : null;
  let tide = null;
  if (d.tides && d.tides.curve.length) {
    const a = nearest(d.tides.curve, t), b = nearest(d.tides.curve, new Date(t.getTime() + 3600e3));
    if (a && b) tide = b.v > a.v + 0.02 ? "Rising" : b.v < a.v - 0.02 ? "Falling" : "Slack";
  }
  const day = d.days.find(x => sameDay(x.date, t));
  return { wind: Math.round(h.wind), dir: compass(h.dir), pres: +inHg(h.pres).toFixed(2), bite: day ? hourBite(day, h.t.getHours()) : null, air: Math.round(h.temp), sst: m && m.sst != null ? Math.round(m.sst) : null,
    tide, moon: phaseName(SunCalc.getMoonIllumination(t).phase), score: day ? day.score : null };
}
function topOf(arr) { const c = {}; arr.filter(Boolean).forEach(x => c[x] = (c[x] || 0) + 1); const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return e ? `${e[0]} (${e[1]})` : "—"; }
function renderLog() {
  const el = $("#tab-log");
  const pat = catches.length >= 3 ? `<section class="card"><h3>Your patterns (${catches.length} catches)</h3><div class="kv">
      <div><span>Top species</span><b>${esc(topOf(catches.map(c => c.species)))}</b></div>
      <div><span>Best bait</span><b>${esc(topOf(catches.map(c => c.bait)))}</b></div>
      <div><span>Best tide</span><b>${esc(topOf(catches.map(c => c.cond && c.cond.tide)))}</b></div>
      <div><span>Best moon</span><b>${esc(topOf(catches.map(c => c.cond && c.cond.moon)))}</b></div>
      <div><span>Best spot</span><b>${esc(topOf(catches.map(c => c.spotName)))}</b></div>
      <div><span>Avg wind</span><b>${(() => { const w = catches.map(c => c.cond && c.cond.wind).filter(v => v != null); return w.length ? Math.round(avg(w)) + " mph" : "—"; })()}</b></div>
    </div></section>` : "";
  el.innerHTML = `<div class="row between"><h2>Catch log</h2><div class="row"><button class="btn" id="newCatch">+ Log catch</button></div></div>${pat}` +
    (catches.length ? catches.map(c => {
      const k = c.cond || {};
      return `<article class="card catch"><div class="row between"><span class="t">${esc(c.species || "Catch")}</span><button class="btn quiet small" data-del="${c.id}" style="min-height:34px;padding:4px 10px">Delete</button></div>
        <div class="muted small">${new Date(c.time).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${esc(c.spotName)}</div>
        <div class="tags">${[c.len ? c.len + " in" : "", c.wt ? c.wt + " lb" : "", c.bait, c.released ? "Released" : "", k.tide ? k.tide + " tide" : "", k.moon, k.wind != null ? `Wind ${k.wind} mph ${k.dir}` : "", k.pres ? k.pres + " inHg" : "", k.bite != null ? k.bite + "% bite" : "", k.sst ? "Water " + k.sst + "°F" : ""].filter(Boolean).map(x => `<span class="tag">${esc(x)}</span>`).join("")}</div>
        ${c.notes ? `<div class="small">${esc(c.notes)}</div>` : ""}</article>`;
    }).join("") + `<button class="btn ghost" id="exportCsv">Export log (CSV)</button>`
      : `<div class="card empty">No catches yet. Log your first one and the app starts learning which tides, moons and baits work for you.</div>`);
  $("#newCatch").onclick = () => catchSheet();
  $$("[data-del]").forEach(b => b.onclick = () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap to confirm"; return; }
    catches = catches.filter(c => c.id !== b.dataset.del); saveCatches(); renderLog(); if (mapReady) drawMarks();
  });
  const ex = $("#exportCsv");
  if (ex) ex.onclick = () => {
    const head = ["time", "spot", "lat", "lon", "species", "length_in", "weight_lb", "bait", "released", "tide", "moon", "wind_mph", "wind_dir", "pressure_inhg", "water_f", "notes"];
    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = catches.map(c => { const k = c.cond || {}; return [c.time, c.spotName, c.lat, c.lon, c.species, c.len, c.wt, c.bait, c.released, k.tide, k.moon, k.wind, k.dir, k.pres, k.sst, c.notes].map(q).join(","); });
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "gulf-bite-catches.csv"; document.body.appendChild(a); a.click(); a.remove();
  };
}

/* ---------------- start ---------------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (typeof SunCalc === "undefined") { $("#tab-home").innerHTML = `<p class="err">Part of the app didn't load. Check your connection and reopen it.</p>`; }
else show("home");
