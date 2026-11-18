"use strict";
// Price-history statistics for the trading tools. Pure functions, unit tested (tests/exchange-stats.test.js).
// All shape statistics work on log prices, so a move from 10 to 11 and from 100 to 110 count the same.

const HOUR_MS = 3600 * 1000, DAY_MS = 24 * HOUR_MS;
const WINDOW_MS = 30 * DAY_MS;

const median = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b), n = v.length;
  return n ? (v[Math.floor((n - 1) / 2)] + v[Math.ceil((n - 1) / 2)]) / 2 : 0;
};
const mad = values => { const m = median(values); return median(values.map(v => Math.abs(v - m))); };

// Theil-Sen slope: the median of all pairwise slopes. Robust to spikes. xs ascending.
function theilSen(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: median(ys) };
  const step = n > 300 ? Math.ceil(n / 300) : 1; // keep it fast on very long histories
  const slopes = [];
  for (let i = 0; i < n; i += step) for (let j = i + step; j < n; j += step) if (xs[j] > xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  const slope = median(slopes);
  return { slope, intercept: median(ys.map((y, i) => y - slope * xs[i])) };
}

// 7-day shape rebuilt from poe.ninja's cumulative % series (last point = today's price).
// Missing days stay null in place so positions keep their meaning.
function weekShape(value, spark) {
  const data = Array.isArray(spark && spark.data) ? spark.data : [];
  const total = Number.isFinite(spark && spark.total) ? spark.total : (Number.isFinite(data[data.length - 1]) ? data[data.length - 1] : null);
  if (!(value > 0) || total === null || total <= -99 || data.length < 4) return null;
  const base = value / (1 + total / 100);
  const week = data.map(p => (Number.isFinite(p) && base * (1 + p / 100) > 0 ? Number((base * (1 + p / 100)).toPrecision(5)) : null));
  const known = week.filter(v => v !== null);
  if (known.length < 4) return null;
  const last = week[week.length - 1], back = week[week.length - 4];
  return {
    week,
    change7: Number.isFinite(total) ? total : null,
    recent3: last !== null && back !== null ? (last / back - 1) * 100 : null,
    avg7: known.reduce((a, b) => a + b, 0) / known.length
  };
}

// One value per UTC day (the median of that day's distinct captures), newest 31 days.
function dailyBars(distinct) {
  const days = new Map();
  for (const p of distinct) { const d = Math.floor(p.t / DAY_MS); if (!days.has(d)) days.set(d, []); days.get(d).push(p.v); }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, vs]) => [d * DAY_MS / 1000, Number(median(vs).toPrecision(5))]);
}

// Swing profile from every stored capture (last 30 days). Swings are measured on detrended log prices, so a
// steady climb or slide is reported as a trend and not as swings, and the leg threshold scales with the
// item's own noise: max(5%, 3 x typical change between captures).
function swingProfile(points, current) {
  const raw = (Array.isArray(points) ? points : [])
    .map(p => ({ t: Number(p && p.t), v: Number(p && p.v) })).filter(p => p.v > 0 && Number.isFinite(p.t)).sort((x, y) => x.t - y.t);
  if (!raw.length) return null;
  const cutoff = raw[raw.length - 1].t - WINDOW_MS;
  const distinct = [];
  for (const p of raw) if (p.t >= cutoff && (!distinct.length || distinct[distinct.length - 1].v !== p.v)) distinct.push(p);
  const n = distinct.length, values = distinct.map(p => p.v);
  const spanH = n > 1 ? (distinct[n - 1].t - distinct[0].t) / HOUR_MS : 0;
  const hours = distinct.map(p => (p.t - distinct[0].t) / HOUR_MS), logs = values.map(Math.log);

  const sorted = [...values].sort((a, b) => a - b);
  const now = current > 0 ? current : values[n - 1];
  const below = sorted.filter(v => v < now).length, equal = sorted.filter(v => v === now).length;
  const pctile = (below + 0.5 * equal) / n; // mid-rank: 0.5 when level with everything, never exactly 0 or 1 from ties

  const { slope, intercept } = theilSen(hours, logs);
  const resid = logs.map((l, i) => l - (intercept + slope * hours[i]));
  const diffs = logs.slice(1).map((l, i) => l - logs[i]);
  const sigma = diffs.length >= 3 ? 1.4826 * mad(diffs) : null;       // typical change between captures (log)
  const sigmaRes = 1.4826 * mad(resid);
  const trending = n >= 6 && spanH >= 48 && Math.abs(slope) * spanH > 2 * sigmaRes && Math.abs(slope) * spanH > 0.05;
  const trendPctPerDay = (Math.exp(slope * 24) - 1) * 100;

  // Zig-zag on the detrended series.
  const th = Math.max(Math.log(1.05), 3 * (sigma || 0));
  const pivots = [{ r: resid[0], h: hours[0] }]; let dir = 0, ext = { r: resid[0], h: hours[0] };
  for (let i = 1; i < n; i++) {
    const cur = { r: resid[i], h: hours[i] };
    if (dir === 0) { if (cur.r - pivots[0].r >= th) { dir = 1; ext = cur; } else if (pivots[0].r - cur.r >= th) { dir = -1; ext = cur; } }
    else if (dir === 1) { if (cur.r > ext.r) ext = cur; else if (ext.r - cur.r >= th) { pivots.push(ext); dir = -1; ext = cur; } }
    else { if (cur.r < ext.r) ext = cur; else if (cur.r - ext.r >= th) { pivots.push(ext); dir = 1; ext = cur; } }
  }
  const legs = pivots.slice(1).map((p, i) => ({ amp: Math.abs(p.r - pivots[i].r), dh: p.h - pivots[i].h }));
  const amps = legs.map(l => Math.exp(l.amp) - 1);
  const avgSwing = amps.length ? median(amps) * 100 : 0;
  const cv = amps.length >= 2 ? (1.4826 * mad(amps)) / (median(amps) || 1) : null;
  const cycle = pivots.length >= 3 ? pivots.slice(2).map((p, i) => p.h - pivots[i].h) : [];
  const periodH = cycle.length ? median(cycle) : null;
  const lastTurnH = pivots.length > 1 ? hours[n - 1] - pivots[pivots.length - 1].h : null;
  const rmin = Math.min(...resid), rmax = Math.max(...resid), rnow = resid[n - 1];
  const phase = rmax - rmin < th ? "flat" : (rnow - rmin) / (rmax - rmin) >= 0.75 ? "near peak" : (rnow - rmin) / (rmax - rmin) <= 0.25 ? "near trough" : "mid-range";

  let kind = "early";
  if (n >= 12 && spanH >= 72) {
    if (spanH < 168) kind = "developing";
    else if (legs.length >= 6 && cv !== null && cv <= 0.6 && periodH !== null && periodH >= 12 && periodH <= 168) kind = "regular";
    else kind = legs.length >= 2 ? "some" : "steady";
  }

  // Chart series: at most 48 points, keeping each bucket's low and high so peaks and dips survive.
  let chart = distinct;
  if (n > 48) {
    chart = [];
    const size = Math.ceil(n / 24);
    for (let i = 0; i < n; i += size) {
      const slice = distinct.slice(i, i + size);
      const lo = slice.reduce((a, b) => (b.v < a.v ? b : a)), hi = slice.reduce((a, b) => (b.v > a.v ? b : a));
      chart.push(...(lo === hi ? [lo] : lo.t < hi.t ? [lo, hi] : [hi, lo]));
    }
  }
  return {
    n, spanH, median: median(values), low: sorted[0], high: sorted[n - 1], pctile,
    swings: legs.length, avgSwing, cv, periodH, lastTurnH, phase, kind, trending, trendPctPerDay,
    sigma: sigma === null ? null : Number(sigma.toPrecision(4)),
    series: chart.map(p => [Math.round(p.t / 1000), Number(p.v.toPrecision(5))]),
    daily: dailyBars(distinct)
  };
}

module.exports = { median, mad, theilSen, weekShape, dailyBars, swingProfile };
