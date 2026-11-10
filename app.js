'use strict';

/*
 * Min ström – spotpriser för SE1–SE4 utan reklam.
 *
 * Datakälla: Nord Pools öppna dataportal (day-ahead, SEK/MWh).
 * Reserv: elprisetjustnu.se (bygger på samma Nord Pool-data) om Nord Pool
 * inte svarar eller blockerar anropet från webbläsaren.
 *
 * Alla priser lagras internt som öre/kWh exkl. moms.
 */

const AREAS = ['SE1', 'SE2', 'SE3', 'SE4'];
const AREA_NAMES = { SE1: 'Luleå', SE2: 'Sundsvall', SE3: 'Stockholm', SE4: 'Malmö' };
const TZ = 'Europe/Stockholm';
const VAT = 1.25;
const CACHE_PREFIX = 'minstrom:day:';
const SETTINGS_KEY = 'minstrom:settings';

// ---------- Små hjälpfunktioner ----------

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat läge e.d. */ }
  },
};

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const longDateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

/** "2026-11-10" för ett datum i svensk tid. */
const localDate = (d = new Date()) => dateFmt.format(d);
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtTime = (ms) => timeFmt.format(new Date(ms));
const localHour = (ms) => Number(hourFmt.format(new Date(ms)));

const numFmt1 = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const numFmt0 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const fmtPrice = (v) => (Math.abs(v) >= 100 ? numFmt0 : numFmt1).format(v);

// ---------- Inställningar ----------

const settings = Object.assign(
  { area: 'SE3', vat: true, quarter: false, markup: 0 },
  store.get(SETTINGS_KEY, {})
);
const saveSettings = () => store.set(SETTINGS_KEY, settings);

/** Pris som användaren ska se, i öre/kWh. */
const display = (spot) => (spot + (Number(settings.markup) || 0)) * (settings.vat ? VAT : 1);

// ---------- Hämtning av data ----------

/**
 * Returnerar { SE1: [{start, end, price}], ... } för ett leveransdatum,
 * eller null om priserna inte är publicerade än.
 */
async function fetchNordPool(date) {
  const url = 'https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices'
    + `?date=${date}&market=DayAhead&deliveryArea=${AREAS.join(',')}&currency=SEK`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Nord Pool svarade ${res.status}`);
  const json = await res.json();
  const entries = json.multiAreaEntries || [];
  if (!entries.length) return null;
  const out = Object.fromEntries(AREAS.map((a) => [a, []]));
  for (const e of entries) {
    const start = Date.parse(e.deliveryStart);
    const end = Date.parse(e.deliveryEnd);
    for (const a of AREAS) {
      const v = e.entryPerArea && e.entryPerArea[a];
      if (typeof v === 'number') out[a].push({ start, end, price: v / 10 }); // SEK/MWh -> öre/kWh
    }
  }
  return out;
}

async function fetchElprisetJustNu(date) {
  const [y, m, d] = date.split('-');
  const results = await Promise.all(AREAS.map(async (a) => {
    const res = await fetch(`https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${a}.json`);
    if (res.status === 404) return [a, null];
    if (!res.ok) throw new Error(`elprisetjustnu svarade ${res.status}`);
    const rows = await res.json();
    return [a, rows.map((r) => ({
      start: Date.parse(r.time_start),
      end: Date.parse(r.time_end),
      price: r.SEK_per_kWh * 100,
    }))];
  }));
  if (results.some(([, rows]) => !rows || !rows.length)) return null;
  return Object.fromEntries(results);
}

async function fetchDay(date) {
  try {
    return await fetchNordPool(date);
  } catch (err) {
    console.warn('Nord Pool misslyckades, provar reserv:', err);
    return await fetchElprisetJustNu(date);
  }
}

/** Hämtar ett datum, med lokal cache. Publicerade priser ändras inte. */
async function loadDay(date, force) {
  const cached = store.get(CACHE_PREFIX + date, null);
  if (cached && !force) return { data: cached, fromCache: true };
  try {
    const data = await fetchDay(date);
    if (data) store.set(CACHE_PREFIX + date, data);
    return { data, fromCache: false };
  } catch (err) {
    if (cached) return { data: cached, fromCache: true, offline: true };
    throw err;
  }
}

function pruneCache() {
  const keep = new Set([localDate(), addDays(localDate(), 1)].map((d) => CACHE_PREFIX + d));
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX) && !keep.has(k)) localStorage.removeItem(k);
    }
  } catch { /* ignorera */ }
}

// ---------- Beräkningar ----------

/** Slår ihop kvartspriser till timmedel. */
function toHourly(rows) {
  const byHour = new Map();
  for (const r of rows) {
    const h = Math.floor(r.start / 3600000) * 3600000;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(r.price);
  }
  return [...byHour].sort((a, b) => a[0] - b[0]).map(([h, ps]) => ({
    start: h, end: h + 3600000, price: ps.reduce((s, p) => s + p, 0) / ps.length,
  }));
}

const series = (rows) => (settings.quarter ? rows : toHourly(rows));

function stats(rows) {
  const ps = rows.map((r) => display(r.price));
  let iMin = 0, iMax = 0;
  ps.forEach((p, i) => { if (p < ps[iMin]) iMin = i; if (p > ps[iMax]) iMax = i; });
  const sorted = [...ps].sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return {
    avg: ps.reduce((s, p) => s + p, 0) / ps.length,
    min: rows[iMin], max: rows[iMax],
    minV: ps[iMin], maxV: ps[iMax],
    low: q(1 / 3), high: q(2 / 3),
  };
}

function level(v, st) {
  if (st.maxV - st.minV < 2) return 'cheap'; // platt dag – inget är dyrt
  if (v <= st.low) return 'cheap';
  if (v >= st.high) return 'high';
  return 'mid';
}

/** Billigaste sammanhängande fönster om `hours` timmar från och med nu. */
function cheapestWindow(rows, hours, now) {
  const future = rows.filter((r) => r.end > now);
  if (!future.length) return null;
  const slot = future[0].end - future[0].start;
  const n = Math.round((hours * 3600000) / slot);
  if (future.length < n) return null;
  let best = null;
  let sum = 0;
  for (let i = 0; i < future.length; i++) {
    sum += future[i].price;
    if (i >= n) sum -= future[i - n].price;
    if (i >= n - 1 && (!best || sum < best.sum)) best = { sum, from: future[i - n + 1].start, to: future[i].end };
  }
  return { from: best.from, to: best.to, avg: display(best.sum / n) };
}

// ---------- Tillstånd ----------

const state = {
  today: null,      // { SE1: [...], ... }
  tomorrow: null,
  todayDate: localDate(),
  day: 'today',
  selected: null,   // index i grafen
  status: '',
};

// ---------- Rendering ----------

function currentRow(rows, now) {
  return rows ? rows.find((r) => r.start <= now && now < r.end) : null;
}

function renderAreas(now) {
  const nav = $('areas');
  nav.innerHTML = '';
  for (const a of AREAS) {
    const r = currentRow(state.today && series(state.today[a]), now);
    const b = document.createElement('button');
    b.className = 'area';
    b.setAttribute('aria-pressed', String(a === settings.area));
    b.title = AREA_NAMES[a];
    b.innerHTML = `<b>${a}</b><small>${r ? fmtPrice(display(r.price)) : '–'}</small>`;
    b.onclick = () => { settings.area = a; saveSettings(); state.selected = null; render(); };
    nav.appendChild(b);
  }
}

function renderNow(now) {
  const raw = state.today && state.today[settings.area];
  const rows = raw ? series(raw) : null;
  const r = currentRow(rows, now);
  $('now-label').textContent = `Pris just nu i ${settings.area} (${AREA_NAMES[settings.area]})`;
  const el = $('now-value');
  el.className = '';
  if (!r) {
    el.textContent = '–';
    $('now-sub').textContent = '';
    return;
  }
  const st = stats(rows);
  const v = display(r.price);
  el.textContent = fmtPrice(v);
  el.classList.add('lvl-' + level(v, st));
  const next = rows.find((x) => x.start === r.end) || (state.tomorrow && series(state.tomorrow[settings.area])[0]);
  let sub = `${fmtTime(r.start)}–${fmtTime(r.end)}`;
  if (next) {
    const nv = display(next.price);
    const arrow = nv > v + 0.05 ? '↑' : nv < v - 0.05 ? '↓' : '→';
    sub += ` · Nästa ${arrow} ${fmtPrice(nv)}`;
  }
  $('now-sub').textContent = sub;
}

function renderStats(rows) {
  if (!rows) { $('stats').innerHTML = ''; return; }
  const st = stats(rows);
  $('stats').innerHTML = `
    <div class="stat"><span>Lägst</span><b class="lvl-cheap">${fmtPrice(st.minV)}</b><small>${fmtTime(st.min.start)}</small></div>
    <div class="stat"><span>Snitt</span><b>${fmtPrice(st.avg)}</b><small>öre/kWh</small></div>
    <div class="stat"><span>Högst</span><b class="lvl-high">${fmtPrice(st.maxV)}</b><small>${fmtTime(st.max.start)}</small></div>`;
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function renderChart(rows, now) {
  const svg = $('chart');
  const tip = $('tooltip');
  const empty = $('empty');
  tip.hidden = true;
  if (!rows || !rows.length) {
    svg.innerHTML = '';
    svg.style.display = 'none';
    empty.hidden = false;
    empty.textContent = state.day === 'tomorrow'
      ? 'Morgondagens priser publiceras normalt runt kl. 13.'
      : 'Inga priser tillgängliga just nu.';
    return;
  }
  svg.style.display = '';
  empty.hidden = true;

  const W = svg.clientWidth || 600;
  const H = 220;
  const padL = 34, padR = 4, padT = 26, padB = 20;
  const st = stats(rows);
  const vals = rows.map((r) => display(r.price));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(1, ...vals);
  const step = niceStep(hi - lo);
  const yMin = Math.floor(lo / step) * step;
  const yMax = Math.ceil(hi / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - (v - yMin) / (yMax - yMin));
  const bw = (W - padL - padR) / rows.length;
  const gap = bw > 6 ? 1.5 : 0.5;

  let out = '';
  for (let t = yMin; t <= yMax + 1e-9; t += step) {
    out += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
    out += `<text class="axis" x="${padL - 4}" y="${y(t) + 4}" text-anchor="end">${numFmt0.format(t)}</text>`;
  }
  rows.forEach((r, i) => {
    const v = vals[i];
    const x = padL + i * bw;
    const top = Math.min(y(v), y(0));
    const h = Math.max(1, Math.abs(y(v) - y(0)));
    const cls = [`bar-${level(v, st)}`];
    if (r.end <= now) cls.push('past');
    if (i === state.selected) cls.push('sel');
    out += `<rect class="${cls.join(' ')}" x="${x + gap / 2}" y="${top}" width="${Math.max(0.5, bw - gap)}" height="${h}" rx="${bw > 6 ? 2 : 0}"/>`;
    const hour = localHour(r.start);
    if (new Date(r.start).getUTCMinutes() === 0 && hour % 3 === 0) {
      out += `<text class="axis" x="${x}" y="${H - 5}">${String(hour).padStart(2, '0')}</text>`;
    }
  });
  out += `<line class="avg-line" x1="${padL}" x2="${W - padR}" y1="${y(st.avg)}" y2="${y(st.avg)}"/>`;
  const ni = rows.findIndex((r) => r.start <= now && now < r.end);
  if (ni >= 0) {
    const nx = padL + ni * bw + bw * ((now - rows[ni].start) / (rows[ni].end - rows[ni].start));
    out += `<line class="now-line" x1="${nx}" x2="${nx}" y1="${padT - 6}" y2="${H - padB}"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;

  if (state.selected != null && rows[state.selected]) {
    const r = rows[state.selected];
    tip.hidden = false;
    tip.textContent = `${fmtTime(r.start)}–${fmtTime(r.end)} · ${fmtPrice(vals[state.selected])} öre`;
    const cx = padL + (state.selected + 0.5) * bw;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(W - half, Math.max(half, cx))}px`;
  }

  const pick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - padL) / bw);
    if (i >= 0 && i < rows.length && i !== state.selected) {
      state.selected = i;
      renderChart(rows, now);
    }
  };
  svg.onpointerdown = pick;
  svg.onpointermove = (ev) => { if (ev.pointerType === 'mouse' || ev.buttons) pick(ev); };
  svg.onpointerleave = (ev) => {
    if (ev.pointerType === 'mouse') { state.selected = null; renderChart(rows, now); }
  };
}

function renderBest(now) {
  const a = settings.area;
  const all = [
    ...((state.today && state.today[a]) || []),
    ...((state.tomorrow && state.tomorrow[a]) || []),
  ];
  const el = $('best');
  if (!all.length) { el.innerHTML = '<span class="empty">–</span>'; return; }
  const today = state.todayDate;
  const dayLabel = (ms) => (localDate(new Date(ms)) === today ? 'idag' : 'imorgon');
  el.innerHTML = [1, 3, 6].map((h) => {
    const w = cheapestWindow(all, h, now);
    if (!w) return '';
    return `<div class="best-row"><div>${h} h · <span>${dayLabel(w.from)} ${fmtTime(w.from)}–${fmtTime(w.to)}</span></div><b>${fmtPrice(w.avg)} öre</b></div>`;
  }).join('') || '<span class="empty">–</span>';
}

function render() {
  const now = Date.now();
  const dayData = state.day === 'today' ? state.today : state.tomorrow;
  const rows = dayData ? series(dayData[settings.area]) : null;
  renderAreas(now);
  renderNow(now);
  renderStats(rows);
  renderChart(rows, now);
  renderBest(now);
  const date = state.day === 'today' ? state.todayDate : addDays(state.todayDate, 1);
  $('chart').setAttribute('aria-label', `Elpris ${settings.area} ${longDateFmt.format(new Date(date + 'T12:00:00Z'))}`);
  document.querySelectorAll('.day-tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.day === state.day));
  });
  $('status').textContent = state.status;
}

// ---------- Uppdatering ----------

let loading = false;
async function refresh(force = false) {
  if (loading) return;
  loading = true;
  $('refresh').classList.add('spin');
  const today = localDate();
  if (today !== state.todayDate) {
    state.todayDate = today;
    state.today = state.tomorrow = null;
    state.selected = null;
  }
  const tomorrow = addDays(today, 1);
  try {
    const [t, tm] = await Promise.all([loadDay(today, force), loadDay(tomorrow, force).catch(() => ({ data: null }))]);
    state.today = t.data;
    state.tomorrow = tm.data;
    state.status = t.offline
      ? 'Offline – visar sparade priser'
      : `Uppdaterad ${fmtTime(Date.now())}`;
    pruneCache();
  } catch (err) {
    console.error(err);
    state.status = 'Kunde inte hämta priser. Kontrollera anslutningen.';
  } finally {
    loading = false;
    $('refresh').classList.remove('spin');
    render();
  }
}

/** Morgondagens priser publiceras ca 12:45–13:00. Kolla då och då efter det. */
function maybeFetchTomorrow() {
  if (state.tomorrow) return;
  if (localHour(Date.now()) >= 12) refresh(false);
}

// ---------- Start ----------

function init() {
  $('opt-vat').checked = settings.vat;
  $('opt-quarter').checked = settings.quarter;
  $('opt-markup').value = settings.markup;
  $('opt-vat').onchange = (e) => { settings.vat = e.target.checked; saveSettings(); render(); };
  $('opt-quarter').onchange = (e) => { settings.quarter = e.target.checked; state.selected = null; saveSettings(); render(); };
  $('opt-markup').oninput = (e) => { settings.markup = parseFloat(e.target.value.replace(',', '.')) || 0; saveSettings(); render(); };
  $('refresh').onclick = () => refresh(true);
  document.querySelectorAll('.day-tabs button').forEach((b) => {
    b.onclick = () => { state.day = b.dataset.day; state.selected = null; render(); };
  });

  // Visa sparat direkt, hämta sedan.
  state.today = store.get(CACHE_PREFIX + state.todayDate, null);
  state.tomorrow = store.get(CACHE_PREFIX + addDays(state.todayDate, 1), null);
  render();
  refresh(false);

  // Uppdatera "just nu" vid varje kvartsskifte.
  const tick = () => {
    if (localDate() !== state.todayDate) refresh(false); else render();
    const ms = 900000 - (Date.now() % 900000) + 500;
    setTimeout(tick, ms);
  };
  setTimeout(tick, 900000 - (Date.now() % 900000) + 500);
  setInterval(maybeFetchTomorrow, 10 * 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (localDate() !== state.todayDate) refresh(false);
      else { render(); maybeFetchTomorrow(); }
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
