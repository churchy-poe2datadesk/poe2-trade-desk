"use strict";
// Shared market maths for the trading tools (Exchange Calculator and Trade Ledger).
// Pure functions only, so the same code runs in the browser and in the Node tests.
// Prices are in Divine Orbs ("divine"); every ratio is "right units per 1 left unit".
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MarketModel = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // The tool settings, declared once. The backend settings store and the in-page settings box both use these.
  const TOOL_SETTINGS = [
    { key: "tools.defaultMarginPct", group: "Trading tools", label: "Smallest net profit worth showing (%)", type: "number", min: 0, max: 100, default: 3,
      help: "After the estimated buy/sell price gap. Anything expected to earn less than this is left out of the lists." },
    { key: "tools.exchangeSpreadPct", group: "Trading tools", label: "Buy/sell price gap on busy markets (%)", type: "number", min: 0, max: 25, default: 2,
      help: "Estimated loss from buying at the asking price and selling back at the bidding price, on items trading 1000+ Divine a day (not a fee: the game charges none). Set 0 to ignore it. Markets of 100 to 1000 are assumed to cost double, thinner ones four times." },
    { key: "tools.reversionPct", group: "Trading tools", label: "How much of a price gap to expect to close (%)", type: "number", min: 0, max: 100, default: 20,
      help: "Prices rarely return to their usual level, and for busy items the evidence of it is weak. Used until an item has enough of its own history to measure it." },
    { key: "tools.minVolumeDiv", group: "Trading tools", label: "Calculator, Ledger & report Buy low / Sell high: minimum daily volume (Divine)", type: "number", min: 0, max: 100000, default: 50,
      help: "Affects the Exchange Calculator, the Trade Ledger and the Buy low / Sell high chapter of reports. Items trading less than this are ignored: their prices are too noisy to trust. (Report rankings use their own setting under Reports.)" },
    { key: "tools.trendLimitPct", group: "Trading tools", label: "Week-long move where trend caution starts (%)", type: "number", min: 5, max: 100, default: 25,
      help: "Until we have about 5 days of our own captures, a currency that moved more than this over poe.ninja's 7 days is treated as trending: its usual price is pulled toward today's price, so the idea fades out gradually and is dropped at 4 times this. Raise it for more (riskier) ideas; lower it to be stricter." },
    { key: "tools.spikePct", group: "Trading tools", label: "Spike sensitivity (% from median)", type: "number", min: 10, max: 200, default: 35 },
    { key: "tools.topCount", group: "Trading tools", label: "Top recommendations shown", type: "int", min: 3, max: 30, default: 10 },
    { key: "tools.candidateCount", group: "Trading tools", label: "Calculator: ideas shown each way", type: "int", min: 10, max: 200, default: 50 },
    { key: "ledger.bigProfitPct", group: "Trade Ledger alerts", label: "Alert on a swap worth at least (%)", type: "number", min: 1, max: 200, default: 10 },
    { key: "ledger.sellWindowPct", group: "Trade Ledger alerts", label: "Sell window: item this far above usual (%)", type: "number", min: 1, max: 200, default: 15 },
    { key: "ledger.badLossPct", group: "Trade Ledger alerts", label: "Flag a position down by (%)", type: "number", min: 1, max: 100, default: 10 }
  ];

  function optionsFrom(values) {
    const out = {};
    for (const s of TOOL_SETTINGS) {
      const short = s.key.split(".")[1];
      const raw = values && values[s.key];
      out[short] = typeof raw === "number" && Number.isFinite(raw) ? raw : s.default;
    }
    return out;
  }
  const DEFAULT_OPTIONS = optionsFrom({});

  // ---------- basic statistics ----------
  const median = a => {
    const v = [...a].sort((x, y) => x - y), n = v.length;
    return n ? (v[Math.floor((n - 1) / 2)] + v[Math.ceil((n - 1) / 2)]) / 2 : 0;
  };

  // A spike is a point at least `pct`% away from the median and more than 3 robust deviations out.
  // Returns -1 (dip), 0 or 1 (spike up) per point.
  function spikeFlags(values, pct = DEFAULT_OPTIONS.spikePct) {
    if (values.length < 4) return values.map(() => 0);
    const m = median(values), mad = median(values.map(v => Math.abs(v - m))) * 1.4826;
    const rel = pct / 100;
    return values.map(v => (m > 0 && Math.abs(v / m - 1) >= rel && (mad === 0 || Math.abs(v - m) / mad > 3) ? (v > m ? 1 : -1) : 0));
  }

  // ---------- price history helpers ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const DIVINE_KEY = "Currency:divine";

  // Theil-Sen line through (xs, ys): the median of all pairwise slopes, so spikes barely move it.
  function theilSen(xs, ys) {
    const n = xs.length;
    if (n < 3) return { slope: 0, intercept: median(ys) };
    const slopes = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (xs[j] > xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    const slope = median(slopes);
    return { slope, intercept: median(ys.map((y, i) => y - slope * xs[i])) };
  }

  // The 7-day sparkline with its original positions (missing days are null in place).
  const weekPoints = item => {
    const w = Array.isArray(item.week) ? item.week : [];
    return w.map((v, i) => ({ i, v })).filter(p => Number.isFinite(p.v) && p.v > 0);
  };

  // Typical price change between updates, by trading volume. Measured on 600+ currencies and items from real poe.ninja
  // captures (robust spread of capture-to-capture changes: 1.7% above 1000 Divine/day, 2.3% for 250-1000, 4.5% for 100-250,
  // 4.4-6.4% for 25-100, 7.3% for 10-25, 17% below 10).
  const sigmaFloor = vol => (vol >= 1000 ? 0.017 : vol >= 250 ? 0.023 : vol >= 100 ? 0.045 : vol >= 25 ? 0.055 : vol >= 10 ? 0.073 : 0.17);
  const sigmaOf = item => (item.prof && item.prof.n >= 49 && item.prof.sigma ? Math.max(item.prof.sigma, 0.005) : sigmaFloor(item.activity));

  // Buy-then-sell cost for an item: the base cost on busy markets, doubled at 100-1000 Divine a day, quadrupled below.
  const roundTripCost = (item, opts) => (opts.exchangeSpreadPct / 100) * (item.activity >= 1000 ? 1 : item.activity >= 100 ? 2 : 4);

  // ---------- fair value ("usual price") ----------
  // From the item's own daily captures when there are 5+ days: a robust trend line if the slope is significant,
  // otherwise the median of the last 7 days. With less history, the median of poe.ninja's 7-day shape, but only
  // when that week was calm (a +-15% week is a trend, and a trend is not a bargain).
  function fairValue(item, opts = DEFAULT_OPTIONS) {
    const cacheKey = `${opts.reversionPct}/${opts.trendLimitPct}`;
    if (item._fair && item._fairKey === cacheKey) return item._fair;
    const out = { F: null, basis: null, trending: false, confidence: "low", phi: opts.reversionPct / 100 };
    const prior = opts.reversionPct / 100;
    if (item.key === DIVINE_KEY) { out.F = item.divine; out.basis = "numeraire"; item._fair = out; item._fairKey = cacheKey; return out; }
    const daily = item.prof && Array.isArray(item.prof.daily) ? item.prof.daily.filter(d => d[1] > 0) : [];
    if (daily.length >= 5) {
      const last = daily.slice(-14), x0 = last[0][0] / 86400, xs = last.map(d => d[0] / 86400 - x0), logs = last.map(d => Math.log(d[1]));
      const { slope, intercept } = theilSen(xs, logs);
      const resid = logs.map((l, i) => l - (intercept + slope * xs[i]));
      const sigmaD = 1.4826 * median(resid.map(r => Math.abs(r - median(resid))));
      const span = xs[xs.length - 1] - xs[0];
      out.trending = Math.abs(slope) * span > Math.max(2 * sigmaD, 0.05);
      out.F = out.trending ? Math.exp(intercept + slope * xs[xs.length - 1]) : median(daily.slice(-7).map(d => d[1]));
      out.basis = "captures";
      if (daily.length >= 10) { // how much of a gap has closed from one day to the next
        const r = resid, m = median(r); let num = 0, den = 0;
        for (let i = 1; i < r.length; i++) { num += (r[i] - m) * (r[i - 1] - m); }
        for (let i = 0; i < r.length; i++) den += (r[i] - m) ** 2;
        const rho = den > 0 ? num / den : 0, phiHat = clamp(1 - rho, 0, 0.8), k = daily.length;
        out.phi = (k * phiHat + 8 * prior) / (k + 8);
      }
    } else {
      const pts = weekPoints(item);
      if (pts.length >= 4) {
        const change = Number.isFinite(item.change7) ? item.change7 : 0;
        out.basis = "poe.ninja 7-day";
        // Soft, not a cliff: past the limit the usual price slides toward today's price (so the gap, and the idea,
        // shrink as the move grows) and it is dropped entirely only at 4x the limit. Big weekly moves early in a league
        // are often the economy establishing itself rather than noise.
        const L = Math.max(opts.trendLimitPct, 1);
        const w = clamp((Math.abs(change) - L) / (3 * L), 0, 1);
        out.trendWeight = w; out.trending = w > 0;
        out.F = w >= 1 ? null : median(pts.map(p => p.v)) * (1 - w) + item.divine * w;
      }
    }
    const p = item.prof, days = p ? p.spanH / 24 : 0, n = p ? p.n : 0, vol = item.activity;
    out.confidence = out.basis === "captures" && days >= 14 && n >= 100 && vol >= 1000 ? "high"
      : out.basis === "captures" && days >= 7 && n >= 48 && vol >= 100 ? "medium" : "low";
    item._fair = out; item._fairKey = cacheKey;
    return out;
  }
  const usualPrice = (item, opts = DEFAULT_OPTIONS) => { const f = fairValue(item, opts); return f.F > 0 ? f.F : 0; };

  // A spike: a point at least `pct`% away from the median and more than 3 robust deviations out.
  // Returns -1 (dip), 0 or 1 (spike up) per point.
  function spikeFlags(values, pct = DEFAULT_OPTIONS.spikePct) {
    if (values.length < 4) return values.map(() => 0);
    const m = median(values), mad = median(values.map(v => Math.abs(v - m))) * 1.4826;
    const rel = pct / 100;
    return values.map(v => (m > 0 && Math.abs(v / m - 1) >= rel && (mad === 0 || Math.abs(v - m) / mad > 3) ? (v > m ? 1 : -1) : 0));
  }

  // Spike facts from the 7-day shape: is today a spike, and was there a recent one that the usual price ignores?
  function spikeOf(item, pct = DEFAULT_OPTIONS.spikePct) {
    if (item._spike && item._spike.pct === pct) return item._spike;
    const pts = weekPoints(item), last = Array.isArray(item.week) ? item.week.length - 1 : -1;
    const out = { pct, now: 0, past: null };
    if (pts.length >= 4) {
      const f = spikeFlags(pts.map(p => p.v), pct), lastPt = pts[pts.length - 1];
      out.now = lastPt.i === last ? f[f.length - 1] : 0;
      const k = f.findIndex((x, idx) => x !== 0 && idx < f.length - 1);
      if (k >= 0) out.past = { value: pts[k].v, dir: f[k], daysAgo: last - pts[k].i };
    }
    item._spike = out;
    return out;
  }

  // ---------- edge, liquidity and scoring ----------
  // Items worth considering: enough daily volume, a real price, and never the Divine Orb itself (it is the unit of account).
  function liquidPool(items, opts = DEFAULT_OPTIONS) {
    const pool = items.filter(i => i.key !== DIVINE_KEY && i.divine > 0.0005 && i.activity >= opts.minVolumeDiv && i.activity > 0);
    return { pool, floor: opts.minVolumeDiv, liquid: pool };
  }
  // 0 = quietest, 1 = busiest, on a log scale from 100 to 10,000 Divine a day.
  const liquidityScore = vol => clamp(Math.log10(Math.max(vol, 1) / 100) / 2, 0, 1);

  // Net expected profit of buying (side "buy") or selling (side "sell") at today's price.
  // edge = reversion share x gap to the usual price - round-trip trading cost.
  // With `loose` true the bar is lower, for the long candidate lists: a quarter of the volume, a gap of
  // at least one normal day-to-day move (not two), and any net profit after costs (no minimum).
  const looseVolume = opts => Math.max(1, opts.minVolumeDiv / 4);
  const barVolume = (opts, level) => Math.max(1, opts.minVolumeDiv * BARS[level].vol);
  // level 0 = full bar, 1 = solid (half volume, gap of 1.5 moves, half the minimum profit), 2 = loosest.
  const BARS = [{ vol: 1, z: 2, margin: 1 }, { vol: 0.5, z: 1.5, margin: 0.5 }, { vol: 0.25, z: 1, margin: 0 }];
  function edgeOf(item, side, opts = DEFAULT_OPTIONS, level = 0) {
    const bar = BARS[level === true ? 2 : (level || 0)], loose = level === true || level > 0;
    const fv = fairValue(item, opts), P = item.divine, F = fv.F;
    const out = { fair: fv, price: P, usual: F, eligible: false, reason: "" };
    if (!(F > 0)) { out.reason = fv.trending ? "its price is trending, which is momentum rather than a bargain" : "not enough price history to work out a usual price"; return out; }
    const cost = roundTripCost(item, opts), sigma = sigmaOf(item);
    out.discount = 1 - P / F;                       // positive: priced below usual
    out.premium = P / F - 1;                        // positive: priced above usual
    const gap = side === "buy" ? F / P - 1 : P / F - 1; // what is on offer if the price returns all the way
    out.gap = gap; out.cost = cost; out.sigma = sigma;
    out.edge = fv.phi * gap - cost;
    out.z = gap / sigma;
    if (gap <= 0) out.reason = side === "buy" ? "not priced below its usual level" : "not priced above its usual level";
    else if (item.activity < (loose ? barVolume(opts, level === true ? 2 : level) : opts.minVolumeDiv)) out.reason = `trades under ${loose ? barVolume(opts, level === true ? 2 : level) : opts.minVolumeDiv} Divine a day`;
    else if (Math.abs(P / F - 1) > 1) out.reason = "its price is more than double or half its usual level, which looks like a thin-market glitch";
    else if (out.z < bar.z) out.reason = "the gap is within its normal day-to-day noise";
    else if (bar.margin === 0 ? out.edge <= 0 : out.edge * 100 < opts.defaultMarginPct * bar.margin) out.reason = `expected net profit (${(out.edge * 100).toFixed(1)}%) is under your ${opts.defaultMarginPct}% minimum`;
    else out.eligible = true;
    return out;
  }

  // Strictest band an item passes on this side: edge with .tier 0, 1 or 2, or null when it passes none.
  function tierOf(item, side, opts = DEFAULT_OPTIONS) {
    for (let level = 0; level < BARS.length; level++) {
      const e = edgeOf(item, side, opts, level);
      if (e.eligible) { e.tier = level; return e; }
    }
    return null;
  }

  // Score 0-100 for a candidate. Edge 45%, swing regularity 25%, liquidity 20%, confidence 10%,
  // scaled down when the price is still moving against you or today's gap is an unconfirmed jump.
  function scoreOf(item, side, edge, opts = DEFAULT_OPTIONS) {
    const p = item.prof, cost = Math.max(edge.cost, 0.005);
    let R = 0;
    if (p && (p.kind === "regular" || p.kind === "some")) {
      const strength = Math.min(p.swings / 6, 1) * Math.min((p.avgSwing / 100) / (2 * cost), 1) * (1 - Math.min(p.cv === null ? 1 : p.cv, 1));
      R = (p.kind === "regular" ? 1 : 0.5) * strength;
    }
    const C = { high: 1, medium: 0.6, low: 0.2 }[edge.fair.confidence];
    let M = 1 - 0.5 * (edge.fair.trendWeight || 0); // a trending week counts for less, in proportion
    const adverse = Math.max(5, 200 * sigmaOf(item));
    if (side === "buy" && item.recent3 !== null && item.recent3 <= -adverse) M = Math.min(M, 0.5);
    if (side === "sell" && item.recent3 !== null && item.recent3 >= adverse) M = Math.min(M, 0.5);
    const sp = spikeOf(item, opts.spikePct).now;
    if ((side === "buy" && sp < 0) || (side === "sell" && sp > 0)) M = Math.min(M, 0.6);
    return 100 * M * (0.45 * Math.min(Math.max(edge.edge, 0) / 0.15, 1) + 0.25 * R + 0.20 * liquidityScore(item.activity) + 0.10 * C);
  }

  // ---------- trade ledger ----------
  const byKey = items => { const m = new Map(); for (const i of items) m.set(i.key, i); return m; };

  // Current standing of one trade: you gave `give.qty` of A and got `get.qty` of B.
  function valuePosition(trade, map, opts = DEFAULT_OPTIONS) {
    const A = map.get(trade.give.key), B = map.get(trade.get.key);
    if (!A || !B || !(A.divine > 0) || !(B.divine > 0)) return null;
    const leg = roundTripCost(B, opts) / 2; // selling B back costs one leg
    const nowInA = trade.get.qty * B.divine / A.divine;
    const F = usualPrice(B, opts);
    const out = {
      A, B, nowInA,
      nowDivine: trade.get.qty * B.divine,
      costDivine: trade.give.qty * A.divine,
      entryRatio: trade.get.qty / trade.give.qty,
      marketRatio: A.divine / B.divine,
      plPct: (nowInA / trade.give.qty - 1) * 100,
      plNetPct: (nowInA * (1 - leg) / trade.give.qty - 1) * 100,
      premiumB: F > 0 ? B.divine / F : null,
      exitShare: B.activity > 0 ? (trade.get.qty * B.divine) / B.activity : null // your position as a share of a day's volume
    };
    if (trade.closed) out.realisedPct = (trade.closed.qty / trade.give.qty - 1) * 100;
    return out;
  }

  // A drop is something found in game (no trade, no cost): { id, ts, key, qty, note, sold: null | { divine, ts } }.
  // Everything it is worth now is profit, so it is valued at today's price and checked against its usual price.
  function valueDrop(drop, map, opts = DEFAULT_OPTIONS) {
    const B = map.get(drop.key);
    if (!B || !(B.divine > 0)) return null;
    const leg = roundTripCost(B, opts) / 2;
    const F = usualPrice(B, opts);
    const nowDivine = drop.qty * B.divine;
    return {
      B, nowDivine, netDivine: nowDivine * (1 - leg), usual: F, usualDivine: F > 0 ? drop.qty * F : null,
      premiumB: F > 0 ? B.divine / F : null,
      exitShare: B.activity > 0 ? nowDivine / B.activity : null
    };
  }

  // Best swaps for the held currency B. Each side is expected to close `phi` of its gap to its usual level;
  // you swap now and swap back later, paying a leg of cost each time. The target must be able to absorb the
  // position (daily volume at least twice its value).
  function swapOptions(trade, map, items, opts = DEFAULT_OPTIONS, n = 3) {
    const pos = valuePosition(trade, map, opts);
    if (!pos) return { pos: null, options: [], all: [] };
    if (pos.B.kind === "unique") return { pos, options: [], all: [], unique: true }; // uniques have no exchange to swap on
    const fB = fairValue(pos.B, opts), out = [];
    if (fB.F > 0) {
      const bFuture = pos.B.divine + fB.phi * (fB.F - pos.B.divine);
      for (const C of items) {
        if (C.key === pos.B.key || !(C.divine > 0.0005)) continue;
        if (C.key !== DIVINE_KEY && C.activity < Math.max(opts.minVolumeDiv, 2 * pos.nowDivine)) continue;
        const fC = fairValue(C, opts);
        if (!(fC.F > 0)) continue;
        if (Math.abs(C.divine / fC.F - 1) > 1) continue;
        const cFuture = C.divine + fC.phi * (fC.F - C.divine);
        // Swap B into C now and back later: you end with (C later / C now) / (B later / B now) of what you began with.
        const ratioMove = (cFuture / C.divine) / (bFuture / pos.B.divine);
        const leg = Math.max(roundTripCost(pos.B, opts), C.key === DIVINE_KEY ? 0 : roundTripCost(C, opts)) / 2;
        const net = ((1 - leg) ** 2 * ratioMove - 1) * 100;
        const spikeC = spikeOf(C, opts.spikePct).now;
        // The in-game exchange only trades whole numbers: work out the biggest whole amount of C you can get from
        // whole units of B, then the fewest whole B that buys it.
        const rateNet = pos.B.divine / C.divine * (1 - leg);
        const giveMax = Math.floor(trade.get.qty + 1e-9);
        const receive = Math.floor(giveMax * rateNet + 1e-9);
        const feasible = receive >= 1;
        const give = feasible ? Math.min(giveMax, Math.ceil(receive / rateNet - 1e-9)) : 0;
        out.push({
          C, net, gross: (ratioMove - 1) * 100,
          receive, give, keep: Math.max(0, trade.get.qty - give), feasible,
          receiveExact: trade.get.qty * rateNet,
          totalPct: (pos.nowInA * (1 - leg) ** 2 * ratioMove / trade.give.qty - 1) * 100,
          confidence: fC.confidence === "low" || fB.confidence === "low" ? "low" : fC.confidence === "medium" || fB.confidence === "medium" ? "medium" : "high",
          caution: spikeC < 0 ? "its price right now looks like a one-off dip, which can be a bad listing" : spikeC > 0 ? "its price right now looks like a one-off spike" : ""
        });
      }
    }
    out.sort((a, b) => b.net - a.net);
    const profitable = out.filter(o => o.net > 0);
    return { pos, options: profitable.filter(o => o.feasible).slice(0, n), all: out, basis: fB,
      tooSmall: profitable.filter(o => !o.feasible).length };
  }

  // Alerts for the open positions. kind: "good" | "bad" | "info".
  function alertsFor(trades, map, items, opts = DEFAULT_OPTIONS, drops = []) {
    const alerts = [];
    for (const drop of drops) {
      if (drop.sold) continue;
      const v = valueDrop(drop, map, opts);
      if (!v) continue;
      const name = v.B.name, id = drop.id;
      if (v.premiumB !== null && (v.premiumB - 1) * 100 >= opts.sellWindowPct) {
        alerts.push({ id: `${id}:dropsell`, tradeId: id, kind: "good", title: `Good time to sell your ${name} drop`,
          detail: `${name} is ${((v.premiumB - 1) * 100).toFixed(0)}% above its usual price. Your ${drop.qty} would fetch about ${v.netDivine.toFixed(2)} Divine after the buy/sell gap, all of it profit.` });
      }
      if (v.B.kind === "unique") { /* priced from listings: no volume to judge */ } else if (!(v.B.activity > 0)) {
        alerts.push({ id: `${id}:dropdead`, tradeId: id, kind: "bad", title: `${name} has no recent trading`, detail: `poe.ninja shows no trading volume for it in the latest capture, so your drop may be hard to sell.` });
      } else if (v.exitShare !== null && v.exitShare > 0.25) {
        alerts.push({ id: `${id}:dropsize`, tradeId: id, kind: "bad", title: `Your ${name} drop is a big share of its daily trading`,
          detail: `It is about ${(v.exitShare * 100).toFixed(0)}% of a day's volume, so selling it all at once may move the price against you.` });
      }
    }
    for (const trade of trades) {
      if (trade.closed) continue;
      const { pos, options } = swapOptions(trade, map, items, opts, 3);
      if (!pos) continue;
      const name = pos.B.name, id = trade.id, best = options[0];
      const sellWin = pos.premiumB !== null && (pos.premiumB - 1) * 100 >= opts.sellWindowPct;
      if (best && best.net >= opts.bigProfitPct) {
        alerts.push({ id: `${id}:big:${best.C.key}`, tradeId: id, kind: "good", title: `Big swap for ${name}`,
          detail: `Trading ${name} for ${best.C.name} could earn about +${best.net.toFixed(0)}% if part of both price gaps closes (confidence ${best.confidence}, after the buy/sell gap).`, swapTo: best.C.key });
      }
      if (sellWin && pos.plNetPct > 0) {
        alerts.push({ id: `${id}:sell`, tradeId: id, kind: "good", title: `Good time to sell ${name}`,
          detail: `${name} is ${((pos.premiumB - 1) * 100).toFixed(0)}% above its usual price and your position is up ${pos.plNetPct.toFixed(1)}% after the buy/sell gap.` });
      }
      if (pos.plPct <= -opts.badLossPct) {
        alerts.push({ id: `${id}:loss`, tradeId: id, kind: "bad", title: `${name} is down ${Math.abs(pos.plPct).toFixed(0)}%`,
          detail: `You paid ${trade.give.qty} ${pos.A.name}; it is worth about ${pos.nowInA.toFixed(2)} ${pos.A.name} now.` });
        if (best && best.totalPct >= 0) {
          alerts.push({ id: `${id}:recoup:${best.C.key}`, tradeId: id, kind: "good", title: `Swap ${name} to ${best.C.name} could recoup the loss`,
            detail: `If it works out the position would end about ${best.totalPct >= 0 ? "+" : ""}${best.totalPct.toFixed(0)}% vs what you paid (confidence ${best.confidence}).`, swapTo: best.C.key });
        }
      }
      if (pos.B.kind === "unique") { /* priced from listings: no volume to judge */ } else if (!(pos.B.activity > 0)) {
        alerts.push({ id: `${id}:dead`, tradeId: id, kind: "bad", title: `${name} has no recent trading`, detail: `poe.ninja shows no trading volume for it in the latest capture, so you may struggle to sell it.` });
      } else if (pos.B.activity < opts.minVolumeDiv) {
        alerts.push({ id: `${id}:thin`, tradeId: id, kind: "bad", title: `${name} is not trading much`, detail: `It trades under ${opts.minVolumeDiv} Divine a day, so it may be slow or costly to sell.` });
      } else if (pos.exitShare !== null && pos.exitShare > 0.25) {
        alerts.push({ id: `${id}:size`, tradeId: id, kind: "bad", title: `Your ${name} is a big share of its daily trading`,
          detail: `It is about ${(pos.exitShare * 100).toFixed(0)}% of a day's volume, so selling it all may move the price against you.` });
      }
      if (pos.B.recent3 !== null && pos.B.recent3 <= -8 && pos.premiumB !== null && pos.premiumB < 1) {
        alerts.push({ id: `${id}:falling`, tradeId: id, kind: "bad", title: `${name} is falling`, detail: `Down ${Math.abs(pos.B.recent3).toFixed(0)}% over the last few days and below its usual price.` });
      }
    }
    const order = { good: 0, bad: 1, info: 2 };
    return alerts.sort((a, b) => order[a.kind] - order[b.kind]);
  }

  // ---------- browser helpers (data + settings), harmless under Node ----------
  const LOCAL_KEY = "poe2dd.tools.v1";
  // Softcore ("sc") or hardcore ("hc"): chosen with the drop-down at the top of the tools; kept in this browser.
  function getMode() {
    try {
      const q = new URLSearchParams(location.search).get("mode");
      if (q === "hc" || q === "sc") return q;
      return localStorage.getItem("poe2dd.mode") === "hc" ? "hc" : "sc";
    } catch { return "sc"; }
  }
  function setMode(mode) { try { localStorage.setItem("poe2dd.mode", mode === "hc" ? "hc" : "sc"); } catch { /* kept for this page only */ } }
  async function loadMarket() {
    const hc = getMode() === "hc";
    for (const url of [hc ? (window.MARKET_URL_HC || "market-hc.json") : (window.MARKET_URL || "market.json")]) {
      try {
        // The local backend is always asked fresh. A published data file is revalidated instead ("has it changed?"), so an unchanged file costs a few bytes, not a full download.
        const r = await fetch(url, { cache: /^\/exchange\//.test(url) ? "no-store" : "no-cache" });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.items) && j.items.length) return { ...j, mode: hc ? "hc" : "sc", source: /market(-hc)?\.json$/.test(url) ? "snapshot" : "live" };
      } catch { /* try the next source */ }
    }
    throw new Error(hc ? "No hardcore market data is available yet. Switch back to softcore, or try again after the next capture." : "No market data is available.");
  }
  async function loadSettings() {
    try {
      const r = await Promise.reject(new Error("static site"));
      if (r.ok) { const j = await r.json(); if (j && j.values) return { values: j.values, schema: j.schema, source: "backend" }; }
    } catch { /* fall through to local settings */ }
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") || {}; } catch { /* ignore */ }
    const values = {}; for (const s of TOOL_SETTINGS) values[s.key] = typeof stored[s.key] === "number" ? stored[s.key] : s.default;
    return { values, schema: TOOL_SETTINGS, source: "local" };
  }
  async function saveSettings(values, source) {
    if (source === "backend") {
      const r = await fetch("/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
      return r.json();
    }
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(values)); } catch { /* storage blocked */ }
    return { ok: true, values };
  }

  return {
    TOOL_SETTINGS, DEFAULT_OPTIONS, optionsFrom, median, theilSen, spikeFlags, weekPoints, fairValue, usualPrice, spikeOf, edgeOf,
    liquidPool, looseVolume, barVolume, tierOf, BARS, liquidityScore, roundTripCost, sigmaOf, scoreOf, byKey, valuePosition, valueDrop, swapOptions, alertsFor, loadMarket, getMode, setMode, loadSettings, saveSettings
  };
});
