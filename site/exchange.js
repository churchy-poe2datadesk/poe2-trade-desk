"use strict";
// Currency exchange calculator. All arithmetic uses exact fractions (BigInt), so a ratio such as 1.564
// is handled as 1564/1000 and never picks up floating point error.

// ---------- exact math ----------
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const frac = (n, d = 1n) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const mul = (a, b) => frac(a.n * b.n, a.d * b.d);
const div = (a, b) => frac(a.n * b.d, a.d * b.n);
const sub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const isWhole = a => a.d === 1n;
const ceilBig = a => (a.n >= 0n ? (a.n + a.d - 1n) / a.d : -((-a.n) / a.d));
const roundBig = a => (a.n >= 0n ? (2n * a.n + a.d) / (2n * a.d) : -((2n * -a.n + a.d) / (2n * a.d)));

function parseDec(text) {
  const raw = String(text ?? "").trim().replace(/\s+/g, "");
  // "1,000" and "1,234.5" use commas as thousands separators; "1,5" is a decimal comma.
  const s = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, "") : raw.replace(/,/g, ".");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) return null;
  const whole = m[1] || "0", decimals = m[2] || "";
  return frac(BigInt(whole + decimals), 10n ** BigInt(decimals.length));
}

function fmt(a, maxDp = 4) {
  const neg = a.n < 0n, n = neg ? -a.n : a.n;
  const scale = 10n ** BigInt(maxDp);
  let scaled = (n * scale * 2n + a.d) / (a.d * 2n);
  let int = scaled / scale, rest = String(scaled % scale).padStart(maxDp, "0").replace(/0+$/, "");
  const text = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (rest ? "." + rest : "");
  return (neg && scaled !== 0n ? "-" : "") + text;
}
// Plain text for an input box (no thousands separators).
const plain = (a, dp = 6) => fmt(a, dp).replace(/,/g, "");

// Raise one side to a whole number. `side` is the side being made whole, `ratio` = right per 1 left.
// Scans whole numbers from the current value upwards and returns the first one where the other side is
// exactly whole; if none is found within `look` steps, the one whose other side is closest to whole.
function raise(side, current, ratio, look) {
  const p = ratio.n, q = ratio.d; // right = left * p / q
  const start = ceilBig(current);
  let best = null;
  for (let i = 0n; i <= BigInt(look); i++) {
    const k = start + i;
    // other side = k*p/q (left whole) or k*q/p (right whole)
    const num = side === "left" ? k * p : k * q, den = side === "left" ? q : p;
    const rem = num % den;
    const off = rem * 2n > den ? den - rem : rem; // distance to the nearest whole, scaled by den
    if (!best || off < best.off) best = { k, off, den };
    if (off === 0n) break;
  }
  const k = best.k;
  const other = frac(side === "left" ? k * p : k * q, side === "left" ? q : p);
  const otherWhole = roundBig(other);
  return { whole: k, other: otherWhole, exactOther: other, exact: best.off === 0n, steps: k - start };
}

function reducedPair(ratio) { return { left: ratio.d, right: ratio.n }; } // left units : right units, lowest whole terms

// ---------- page ----------
if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const state = { items: [], left: null, right: null, active: null, zeroNote: "" };

  const initials = name => name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const marketText = v => { const n = Number(v); return n >= 100 ? n.toFixed(1).replace(/\.0$/, "") : Number(n.toPrecision(5)).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""); };
  const priceHint = divine => divine >= 1 ? `${Number(divine.toPrecision(4)).toLocaleString("en-AU")} div` : `${Number(divine.toPrecision(3))} div`;

  // Shows the real icon when the backend can supply it; the initials badge stays as the fallback.
  function paintBadge(badge, item) {
    badge.textContent = initials(item.name);
    if (!item.icon) return;
    const img = new Image();
    img.alt = ""; img.decoding = "async";
    img.addEventListener("load", () => { badge.textContent = ""; badge.classList.add("has-icon"); badge.append(img); });
    img.src = (window.XC_BACKEND || "") + item.icon;
  }

  function makeCombo(root, side) {
    root.innerHTML = `<button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false"></button>
      <div class="combo-panel" hidden><input class="combo-search" placeholder="Search currencies…" aria-label="Search currencies"><ul class="combo-list" role="listbox"></ul></div>`;
    const btn = root.querySelector(".combo-btn"), panel = root.querySelector(".combo-panel"), search = root.querySelector(".combo-search"), list = root.querySelector(".combo-list");
    let shown = [], index = 0;

    const render = () => {
      const q = search.value.trim().toLowerCase();
      shown = state.items.filter(i => !q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
      list.textContent = "";
      if (!shown.length) { const li = document.createElement("li"); li.className = "combo-empty"; li.textContent = "No match."; list.append(li); return; }
      index = Math.min(index, shown.length - 1);
      let group = null;
      shown.forEach((item, i) => {
        if (item.category !== group) { group = item.category; const g = document.createElement("li"); g.className = "combo-group"; g.textContent = group.replace(/([a-z])([A-Z])/g, "$1 $2"); list.append(g); }
        const li = document.createElement("li");
        li.className = "combo-item" + (i === index ? " active" : "");
        li.setAttribute("role", "option");
        li.innerHTML = `<span class="badge"></span><span class="combo-name"></span><small></small>`;
        paintBadge(li.querySelector(".badge"), item);
        li.querySelector(".combo-name").textContent = item.name;
        li.querySelector("small").textContent = priceHint(item.divine);
        li.addEventListener("mousedown", e => { e.preventDefault(); choose(item); });
        list.append(li);
      });
    };
    const open = () => { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); search.value = ""; index = Math.max(0, state.items.findIndex(i => i === state[side])); render(); search.focus(); const a = list.querySelector(".active"); if (a) a.scrollIntoView({ block: "nearest" }); };
    const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    const choose = item => { close(); state[side] = item; paintButton(); onCurrencyChange(); btn.focus(); };
    const paintButton = () => {
      const item = state[side];
      btn.innerHTML = `<span class="badge"></span><span class="combo-name"></span><small></small>`;
      if (!item) return;
      paintBadge(btn.querySelector(".badge"), item);
      btn.querySelector(".combo-name").textContent = item.name;
      btn.querySelector("small").textContent = priceHint(item.divine);
    };
    btn.addEventListener("click", () => (panel.hidden ? open() : close()));
    search.addEventListener("input", () => { index = 0; render(); });
    search.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { index = Math.min(shown.length - 1, index + 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { index = Math.max(0, index - 1); render(); e.preventDefault(); }
      else if (e.key === "Enter") { if (shown[index]) choose(shown[index]); e.preventDefault(); }
      else if (e.key === "Escape") { close(); btn.focus(); }
      const a = list.querySelector(".active"); if (a) a.scrollIntoView({ block: "nearest" });
    });
    document.addEventListener("mousedown", e => { if (!root.contains(e.target)) close(); });
    return { paint: paintButton };
  }

  let leftCombo, rightCombo, settingsState = null;

  const readRatio = () => { const r = parseDec($("ratio").value); return r && r.n > 0n ? r : null; };
  const readQty = id => parseDec($(id).value);

  function showResult(kind, html) { const el = $("xc-result"); el.className = "xc-result" + (kind ? " " + kind : ""); el.innerHTML = html; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const names = () => [state.left ? state.left.name : "left", state.right ? state.right.name : "right"];

  function summary() {
    const ratio = readRatio(), [ln, rn] = names();
    if (!ratio) { $("xc-line").textContent = "Enter a ratio greater than 0."; $("xc-exact").textContent = ""; ["raise-left", "raise-right", "exact-pair"].forEach(id => ($(id).disabled = true)); return; }
    ["raise-left", "raise-right", "exact-pair"].forEach(id => ($(id).disabled = false));
    const l = readQty("left-qty"), r = readQty("right-qty");
    $("xc-line").textContent = l && r ? `${fmt(l)} ${ln}  →  ${fmt(r)} ${rn}` : "";
    const pair = reducedPair(ratio);
    $("xc-exact").textContent = `Exact whole-number pairs on this ratio come in steps of ${fmt(frac(pair.left))} ${ln} : ${fmt(frac(pair.right))} ${rn}.`;
    if (state.left && state.right) {
      const market = state.left.divine / state.right.divine;
      const mine = Number(ratio.n) / Number(ratio.d);
      const diff = (mine / market - 1) * 100;
      const el = $("xc-market-text"), box = $("xc-market");
      const tier = diff >= 2 ? "good" : diff <= -2 ? "bad" : "fair";
      const verdict = tier === "good" ? "Good for you" : tier === "bad" ? "Bad for you" : "About market";
      const how = tier === "fair" ? "close to market" : `${Math.abs(diff).toFixed(1)}% ${diff > 0 ? "more" : "less"} ${rn} than market`;
      box.className = "xc-market " + tier;
      // Live margin from the amounts actually typed (so whole-number tweaks show), else from the ratio.
      const toNum = v => { const d = parseDec(v); return d ? Number(d.n) / Number(d.d) : NaN; };
      const lq = toNum($("left-qty").value), rq = toNum($("right-qty").value);
      const live = lq > 0 && rq > 0 ? (rq / lq / market - 1) * 100 : diff;
      const lm = $("live-margin"), ltier = live >= 0.05 ? "good" : live <= -0.05 ? "bad" : "fair";
      lm.className = "xc-live " + ltier;
      $("live-word").textContent = ltier === "good" ? "Profit margin" : ltier === "bad" ? "Loss margin" : "Margin";
      if (document.activeElement !== $("margin")) $("margin").value = (Math.abs(live) < 0.005 ? 0 : live).toFixed(Math.abs(live) >= 10 ? 1 : 2);
      el.textContent = `Market: 1 ${ln} = ${marketText(market)} ${rn}. Your ratio: ${verdict} (${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%, ${how}).`;
    }
  }

  function fromLeft() { const l = readQty("left-qty"), r = readRatio(); if (l && r) $("right-qty").value = plain(mul(l, r)); summary(); }
  function fromRight() { const rt = readQty("right-qty"), r = readRatio(); if (rt && r) $("left-qty").value = plain(div(rt, r)); summary(); }
  function onRatio() { showResult("", ""); fromLeft(); }
  function onCurrencyChange() {
    if (state.left && state.right) $("ratio").value = marketText(state.left.divine / state.right.divine);
    showResult("", ""); fromLeft();
  }

  function doRaise(side) {
    const ratio = readRatio(); if (!ratio) return;
    const look = Math.max(0, Math.min(100000, parseInt($("lookahead").value, 10) || 0));
    const cur = readQty(side === "left" ? "left-qty" : "right-qty");
    if (!cur) { showResult("close", "Enter an amount first."); return; }
    const res = raise(side, cur, ratio, look);
    const [ln, rn] = names();
    const wholeName = side === "left" ? ln : rn, otherName = side === "left" ? rn : ln;
    const l = side === "left" ? res.whole : res.other, r = side === "left" ? res.other : res.whole;
    $("left-qty").value = String(l); $("right-qty").value = String(r);
    summary();
    if (res.exact) {
      showResult("exact", `<strong>Exact:</strong> ${esc(fmt(frac(l)))} ${esc(ln)} → ${esc(fmt(frac(r)))} ${esc(rn)} sits exactly on the ratio${res.steps > 0n ? ` (raised by ${esc(String(res.steps))} ${esc(wholeName)})` : " (no change needed)"}.`);
    } else {
      const delta = sub(frac(res.other), res.exactOther); // whole other side minus exact other side
      const eff = side === "left" ? div(frac(r), frac(l)) : div(frac(r), frac(l));
      const gain = side === "left" ? delta.n >= 0n : delta.n <= 0n; // more right received, or less left paid
      showResult("close", `<strong>Closest within ${look} steps:</strong> ${esc(fmt(frac(l)))} ${esc(ln)} → ${esc(fmt(frac(r)))} ${esc(rn)}. No exact match was found in that range, so ${esc(otherName)} is rounded to the nearest whole number. The ratio works out at 1 : ${esc(fmt(eff, 6))} instead of 1 : ${esc(fmt(ratio, 6))} (${esc(fmt(delta, 4))} ${esc(otherName)} off, ${gain ? "slightly in your favour" : "slightly against you"}). Try a larger look-ahead for an exact match.`);
    }
  }

  function doExact() {
    const ratio = readRatio(); if (!ratio) return;
    const pair = reducedPair(ratio), [ln, rn] = names();
    $("left-qty").value = String(pair.left); $("right-qty").value = String(pair.right);
    summary();
    showResult("exact", `<strong>Smallest exact pair:</strong> ${esc(String(pair.left))} ${esc(ln)} → ${esc(String(pair.right))} ${esc(rn)}. Multiply both sides by the same whole number to scale it up.`);
  }

  function doSwap() {
    const ratio = readRatio(), l = readQty("left-qty"), r = readQty("right-qty");
    [state.left, state.right] = [state.right, state.left];
    leftCombo.paint(); rightCombo.paint();
    if (ratio) $("ratio").value = plain(div(frac(1n), ratio), 6);
    if (l && r) { $("left-qty").value = plain(r); $("right-qty").value = plain(l); }
    showResult("", ""); summary();
  }

  const fmtVol = v => `${Math.round(v).toLocaleString("en-AU")} div`;
  const kindLabel = { regular: "Regular swinger", some: "Some swings", steady: "Steady", developing: "Developing", early: "Too early" };

  function quoteFor(item) {
    const quotes = ["Currency:divine", "Currency:chaos", "Currency:exalted"].map(k => state.items.find(i => i.key === k)).filter(q => q && q !== item);
    const usable = quotes.filter(q => item.divine / q.divine >= 1).sort((a, b) => b.divine - a.divine);
    return usable[0] || quotes.sort((a, b) => a.divine - b.divine)[0] || null;
  }

  function useIdea(item, quote, side, ratio) {
    // buy: give quote, get item. sell: give item, get quote.
    state.left = side === "buy" ? quote : item;
    state.right = side === "buy" ? item : quote;
    leftCombo.paint(); rightCombo.paint();
    $("ratio").value = marketText(ratio);
    $("left-qty").value = "1";
    showResult("", ""); fromLeft();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const MM = window.MarketModel;
  let opts = MM.DEFAULT_OPTIONS;
  const { median, spikeFlags, usualPrice } = MM;
  const spikeOf = item => MM.spikeOf(item, opts.spikePct);

  const hoursText = h => (h < 48 ? `${Math.round(h)} hours` : `${(h / 24).toFixed(1)} days`);
  function swingText(item) {
    const p = item.prof;
    if (!p) return "No capture history yet.";
    const bits = [];
    if (p.kind === "early") return `Too early to judge: ${p.n} distinct capture${p.n === 1 ? "" : "s"} over ${hoursText(p.spanH)}. Swings need about 3 days of captures to start showing and a week to be trusted.`;
    if (p.kind === "developing") bits.push(`Developing: ${p.swings} swing${p.swings === 1 ? "" : "s"} so far over ${hoursText(p.spanH)}. A pattern needs a week of captures before it counts as regular.`);
    else if (p.kind === "regular") bits.push(`Regular swinger: ${p.swings} swings over ${hoursText(p.spanH)}, typically ${p.avgSwing.toFixed(0)}% each, about every ${hoursText(p.periodH)} (a full up-and-down).`);
    else if (p.kind === "some") bits.push(`Some swings: ${p.swings} over ${hoursText(p.spanH)}, typically ${p.avgSwing.toFixed(0)}%, but not regular enough to rely on.`);
    else bits.push(`Steady: only ${p.swings} swing${p.swings === 1 ? "" : "s"} over ${hoursText(p.spanH)}.`);
    if (p.trending) bits.push(`It is also trending ${p.trendPctPerDay >= 0 ? "up" : "down"} about ${Math.abs(p.trendPctPerDay).toFixed(1)}% a day, which is separate from the swings.`);
    if (p.phase !== "flat" && p.kind !== "steady") bits.push(`It is currently ${p.phase} of its swing range${p.lastTurnH !== null ? `, ${hoursText(p.lastTurnH)} since the last turn` : ""}.`);
    return bits.join(" ");
  }

  // Price chart (SVG built with DOM calls so the page's no-inline-style CSP is respected).
  function drawChart(host, item, quote, capturedAt) {
    host.textContent = "";
    const p = item.prof, perQ = v => v / quote.divine;
    let pts = [], source;
    if (p && p.series && p.series.length >= 6 && p.spanH >= 48) { pts = p.series.map(([t, v]) => ({ t: t * 1000, v })); source = `Price at each of your captures over ${(p.spanH / 24).toFixed(1)} days`; }
    else if (MM.weekPoints(item).length >= 4) {
      const end = capturedAt ? new Date(capturedAt).getTime() : Date.now(), len = item.week.length;
      pts = MM.weekPoints(item).map(pt => ({ t: end - (len - 1 - pt.i) * 86400000, v: pt.v }));
      source = "Last 7 days from poe.ninja's own trend (your own captures cover too little time to draw yet)";
    }
    if (pts.length < 2) { const m = document.createElement("p"); m.className = "xc-chart-cap"; m.textContent = "No price history to graph yet."; host.append(m); return; }
    const NS = "http://www.w3.org/2000/svg", W = 600, H = 220, L = 58, R = 14, T = 12, B = 28;
    const usual = usualPrice(item, opts);
    const vals = pts.map(x => perQ(x.v)).concat(usual > 0 ? [perQ(usual)] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals); const padv = (hi - lo || hi * 0.1 || 1) * 0.12; lo = Math.max(0, lo - padv); hi += padv;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const X = t => L + (t - t0) / (t1 - t0 || 1) * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const el = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).append(e); return e; };
    const cap = document.createElement("p"); cap.className = "xc-chart-cap"; cap.textContent = `${source}, in ${quote.name}. Dashed line is the usual level (spike-resistant). Orange rings mark one-off spikes and dips.`;
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Price history of ${item.name} in ${quote.name}`);
    for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3, y = Y(v); el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "xc-chart-grid" }); const t = el("text", { x: L - 6, y: y + 4, "text-anchor": "end", class: "xc-chart-axis" }); t.textContent = marketText(v); }
    const dateFmt = t => new Date(t).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", ...((t1 - t0) < 2 * 86400000 ? { hour: "numeric", minute: "2-digit", hour12: true } : {}) });
    [[t0, "start"], [t1, "end"]].forEach(([t, a]) => { const x = el("text", { x: X(t), y: H - 8, "text-anchor": a, class: "xc-chart-axis" }); x.textContent = dateFmt(t); });
    if (usual > 0) { const y = Y(perQ(usual)); el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "xc-chart-usual" }); const u = el("text", { x: W - R - 2, y: y - 5, "text-anchor": "end", class: "xc-chart-usual-t" }); u.textContent = "usual"; }
    const path = pts.map((x, i) => `${i ? "L" : "M"}${X(x.t).toFixed(1)},${Y(perQ(x.v)).toFixed(1)}`).join("");
    el("path", { d: `${path}L${X(t1).toFixed(1)},${H - B}L${X(t0).toFixed(1)},${H - B}Z`, class: "xc-chart-area" });
    el("path", { d: path, class: "xc-chart-line" });
    const flags = spikeFlags(pts.map(x => x.v), opts.spikePct);
    pts.forEach((x, i) => { if (flags[i]) { el("circle", { cx: X(x.t), cy: Y(perQ(x.v)), r: 6, class: "xc-chart-spike" }); } });
    const last = pts[pts.length - 1]; el("circle", { cx: X(last.t), cy: Y(perQ(last.v)), r: 4.5, class: "xc-chart-now" });
    const cross = el("line", { x1: 0, x2: 0, y1: T, y2: H - B, class: "xc-chart-cross" }); cross.setAttribute("visibility", "hidden");
    const read = document.createElement("p"); read.className = "xc-chart-read";
    const show = (pt) => { read.textContent = `${new Date(pt.t).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}: ${marketText(perQ(pt.v))} ${quote.name}`; };
    const show2 = pt => { show(pt); const k = pts.indexOf(pt); if (k >= 0 && flags[k]) read.textContent += flags[k] > 0 ? "  (spike)" : "  (dip)"; };
    show2(last);
    const move = e => { const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W; let best = pts[0]; for (const q of pts) if (Math.abs(X(q.t) - x) < Math.abs(X(best.t) - x)) best = q; cross.setAttribute("x1", X(best.t)); cross.setAttribute("x2", X(best.t)); cross.setAttribute("visibility", "visible"); show2(best); };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); show2(last); });
    host.append(cap, svg, read);
  }

  let modalReturn = null;
  const modal = () => $("xc-modal");
  function closeModal() { modal().hidden = true; document.body.style.overflow = ""; if (modalReturn && document.contains(modalReturn)) modalReturn.focus(); modalReturn = null; }
  function openModal(from) { modalReturn = from || null; modal().hidden = false; document.body.style.overflow = "hidden"; $("xc-modal-x").focus(); }

  const confLabel = { high: "High", medium: "Medium", low: "Low" };
  function selectIdea(item, quote, side, market, edge, from) {
    document.querySelectorAll(".xc-idea.sel").forEach(el => el.classList.remove("sel"));
    document.querySelectorAll(`.xc-idea[data-key="${CSS.escape(item.key)}"][data-side="${side}"]`).forEach(el => el.classList.add("sel"));
    const per = v => marketText(v / quote.divine), p = item.prof, el = $("flip-detail"), fv = edge.fair;
    el.className = "xc-detail on"; el.textContent = "";
    const h = document.createElement("h4"); h.textContent = `${item.name}: ${side === "buy" ? "buy low" : "sell high"}`;
    const lines = [
      `Now ${per(item.divine)} ${quote.name}. Usual level ${per(edge.usual)} ${quote.name}, so it sits ${Math.abs((side === "buy" ? edge.discount : edge.premium) * 100).toFixed(0)}% ${side === "buy" ? "below" : "above"} usual.`,
      `Expected net profit: ${edge.edge >= 0 ? "+" : ""}${(edge.edge * 100).toFixed(1)}% after an estimated ${(edge.cost * 100).toFixed(0)}% buy/sell price gap, assuming ${(fv.phi * 100).toFixed(0)}% of the gap closes. Confidence: ${confLabel[fv.confidence]}${fv.basis === "poe.ninja 7-day" ? " (based on poe.ninja's 7-day shape only)" : ""}.`,
      fv.trendWeight > 0 ? `Its price moved a lot this week, so its usual level is pulled ${Math.round(fv.trendWeight * 100)}% of the way toward today's price and the idea counts for less. It may simply be the economy settling at new prices.` : fv.trending ? "Its price has been trending, so the usual level follows the trend line instead of a flat average." : "",
      p ? `Range over ${p.n} capture${p.n === 1 ? "" : "s"}: ${per(p.low)} to ${per(p.high)} ${quote.name}; today sits at the ${Math.round(p.pctile * 100)}th percentile of that range.` : "",
      swingText(item),
      ...(() => {
        const sp = MM.spikeOf(item, opts.spikePct), out = [];
        if (sp.now) out.push(`Spike alert: today's price looks like a one-off ${sp.now > 0 ? "spike up" : "dip"} against its usual level, so the gap may not last${side === "buy" && sp.now < 0 ? " (and a dip can be a bad listing)" : ""}.`);
        if (sp.past) out.push(`A one-off ${sp.past.dir > 0 ? "spike" : "dip"} to ${per(sp.past.value)} ${quote.name} about ${sp.past.daysAgo} day${sp.past.daysAgo === 1 ? "" : "s"} ago is ignored when working out the usual level.`);
        return out;
      })(),
      `Trading volume: ${fmtVol(item.activity)} a day.${item.recent3 !== null && item.recent3 !== undefined && Math.abs(item.recent3) >= 5 ? ` Recent direction: ${item.recent3 > 0 ? "+" : ""}${item.recent3.toFixed(0)}% over the last few days.` : ""}`
    ].filter(Boolean);
    el.append(h);
    const chartHost = document.createElement("div"); chartHost.className = "xc-chart"; el.append(chartHost);
    drawChart(chartHost, item, quote, state.capturedAt);
    for (const t of lines) { const pp = document.createElement("p"); pp.textContent = t; el.append(pp); }
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "xc-btn xc-primary";
    btn.textContent = side === "buy" ? `Load buy into calculator (1 ${quote.name} → ${item.name})` : `Load sell into calculator (1 ${item.name} → ${quote.name})`;
    btn.addEventListener("click", () => { modalReturn = null; closeModal(); useIdea(item, quote, side, market); });
    el.append(btn);
    openModal(from);
  }

  const TIER_NAME = ["Strongest", "Solid", "Speculative"];
  const TIER_NOTE = [
    () => `Meets the full bar: trades at least ${fmtVol(opts.minVolumeDiv)} a day, today's price is at least 2 normal day-to-day swings away from its usual price, and at least ${opts.defaultMarginPct}% net profit.`,
    () => `Slightly lower bar: trades at least ${fmtVol(MM.barVolume(opts, 1))} a day, 1.5 normal swings from its usual price, and at least ${+(opts.defaultMarginPct / 2).toFixed(2)}% net profit.`,
    () => `Lowest bar: trades at least ${fmtVol(MM.barVolume(opts, 2))} a day, 1 normal swing from its usual price, and any profit after costs. Thinner bets, so size them smaller.`
  ];

  function rowFor(entry, side, showScore) {
    const { item, quote, edge, market, score } = entry;
    const per = v => marketText(v / quote.divine);
    const li = document.createElement("li"), btn = document.createElement("button");
    btn.type = "button"; btn.className = "xc-idea " + side; btn.dataset.key = item.key; btn.dataset.side = side;
    btn.innerHTML = `<span class="badge"></span><span><b></b><span class="xc-sub xc-l1"></span><span class="xc-sub xc-l2"></span></span><span class="xc-chg xc-score"></span>`;
    paintBadge(btn.querySelector(".badge"), item);
    const b = btn.querySelector("b"); b.textContent = item.name;
    const kind = item.prof ? item.prof.kind : "early";
    if (kind === "regular" || kind === "some") { const tag = document.createElement("span"); tag.className = "xc-tag " + kind; tag.textContent = kindLabel[kind]; b.append(tag); }
    if (edge.tier > 0) { const tag = document.createElement("span"); tag.className = "xc-tag"; tag.textContent = edge.tier === 1 ? "SOLID" : "SPECULATIVE"; tag.title = TIER_NOTE[edge.tier](); b.append(tag); }
    const spikeNow = MM.spikeOf(item, opts.spikePct).now;
    if (spikeNow) { const tag = document.createElement("span"); tag.className = "xc-tag spike"; tag.textContent = spikeNow > 0 ? "SPIKE UP" : "DIP"; tag.title = "Today's price is far from its usual level, so it may be a one-off."; b.append(tag); }
    btn.querySelector(".xc-l1").textContent = `Now ${per(item.divine)} · usual ${per(edge.usual)} ${quote.name}`;
    btn.querySelector(".xc-l2").textContent = `Volume ${fmtVol(item.activity)} · ${side === "buy" ? Math.round(edge.discount * 100) : Math.round(edge.premium * 100)}% ${side === "buy" ? "below" : "above"} usual · ${confLabel[edge.fair.confidence]} confidence`;
    const chg = btn.querySelector(".xc-score");
    chg.className = "xc-chg xc-score " + (side === "buy" ? "up" : "down");
    chg.textContent = `${edge.edge >= 0 ? "+" : ""}${(edge.edge * 100).toFixed(1)}% net`;
    if (showScore) { const sm = document.createElement("small"); sm.textContent = `Score ${Math.round(score)}`; chg.append(sm); }
    btn.addEventListener("click", () => selectIdea(item, quote, side, market, edge, btn));
    li.append(btn);
    return li;
  }

  function renderIdeas() {
    const { pool, liquid } = MM.liquidPool(state.items, opts);
    const looseFloor = MM.looseVolume(opts);
    const loosePool = state.items.filter(i => i.key !== "Currency:divine" && i.divine > 0.0005 && i.activity >= looseFloor);
    const build = side => {
      const out = [];
      for (const item of loosePool) {
        const edge = MM.tierOf(item, side, opts);
        if (!edge) continue;
        const quote = quoteFor(item); if (!quote) continue;
        const market = side === "buy" ? quote.divine / item.divine : item.divine / quote.divine;
        out.push({ item, quote, edge, market, score: MM.scoreOf(item, side, edge, opts) });
      }
      return out.sort((a, b) => a.edge.tier - b.edge.tier || b.score - a.score);
    };
    const q = $("flip-search").value.trim().toLowerCase();
    const matches = i => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q);
    const lists = {};
    for (const side of ["buy", "sell"]) {
      const all = build(side);
      lists[side] = all;
      // When nothing qualifies, show what comes closest and exactly what is holding it back.
      const nearList = () => {
        const out = [];
        for (const item of liquid) {
          const edge = MM.edgeOf(item, side, opts);
          if (!edge.eligible && edge.usual > 0 && edge.gap > 0) out.push({ item, edge });
        }
        return out.sort((a, b) => b.edge.edge - a.edge.edge).slice(0, 5);
      };
      const fill = (id, list, showScore, emptyText) => {
        const ul = $(id); ul.textContent = "";
        if (!list.length) {
          const li = document.createElement("li"); li.className = "xc-none"; li.textContent = emptyText; ul.append(li);
          const near = q || !id.startsWith("flip-") ? [] : nearList();
          if (near.length) {
            const head = document.createElement("li"); head.className = "xc-none xc-near-head"; head.textContent = "Closest to qualifying (not a trade yet):"; ul.append(head);
            for (const { item, edge } of near) {
              const row = document.createElement("li"); row.className = "xc-none xc-near";
              const name = document.createElement("strong"); name.textContent = item.name;
              row.append(name, document.createTextNode(` · ${(edge.gap * 100).toFixed(1)}% ${side === "buy" ? "below" : "above"} usual · net edge ${(edge.edge * 100).toFixed(1)}%`));
              const why = document.createElement("small"); why.textContent = `Not yet: ${edge.reason}`; row.append(why);
              ul.append(row);
            }
          }
          return;
        }
        let lastTier = -1;
        for (const entry of list) {
          if (id.startsWith("flip-") && !q && entry.edge.tier !== lastTier) {
            lastTier = entry.edge.tier;
            const n = list.filter(x => x.edge.tier === lastTier).length;
            const h = document.createElement("li"); h.className = "xc-tier xc-tier" + lastTier;
            const b = document.createElement("strong"); b.textContent = `${TIER_NAME[lastTier]} · ${n}`;
            const t = document.createElement("small"); t.textContent = TIER_NOTE[lastTier]();
            h.append(b, t); ul.append(h);
          }
          ul.append(rowFor(entry, side, showScore));
        }
      };
      const word = side === "buy" ? "buy low" : "sell high";
      const noneWide = `Nothing clears even the lowest bar right now (trades at least ${fmtVol(looseFloor)} a day, 1 normal swing from its usual price, and any profit after costs).`;
      const none = `Nothing qualifies as a ${word} right now. That is normal: the list only shows items with a gap big enough to beat the buy/sell price gap, trading at least ${opts.minVolumeDiv} Divine a day.`;
      const scoped = q ? all.filter(e => matches(e.item)) : all;
      fill(`flip-${side}`, scoped.slice(0, opts.candidateCount), true, q ? `No ${word} candidate matches “${$("flip-search").value.trim()}”.` : noneWide);
    }
    // Why items did not qualify, so an empty list is explained.
    const tally = { checked: loosePool.length, trending: 0, nohist: 0, noise: 0, small: 0 };
    for (const item of loosePool) {
      const e = MM.edgeOf(item, "buy", opts, 2), f = MM.edgeOf(item, "sell", opts, 2), best = e.eligible || f.eligible ? null : (e.gap > f.gap ? e : f);
      if (!best) continue;
      if (!(best.usual > 0)) { if (best.fair.trending) tally.trending++; else tally.nohist++; }
      else if (/noise/.test(best.reason)) tally.noise++;
      else tally.small++;
    }
    const diag = $("flip-diag");
    diag.textContent = `${tally.checked} items trade at least ${fmtVol(looseFloor)} a day (the lowest bar). Not listed in any band: ${tally.trending} trending (momentum, not a bargain), ${tally.nohist} without enough history, ${tally.noise} within normal day-to-day noise, ${tally.small} with a gap too small to cover the buy/sell gap, or priced at their usual level.`;
    const msg = $("flip-search-msg"); msg.textContent = "";
    if (q) {
      const found = state.items.filter(matches);
      const inLists = new Set([...lists.buy, ...lists.sell].filter(e => matches(e.item)).map(e => e.item.key));
      const say = html => { const p = document.createElement("div"); p.innerHTML = html; msg.append(p); };
      if (!found.length) say(`<strong>“${esc($("flip-search").value.trim())}”</strong> is not in your captured poe.ninja data, so it can't appear in these lists.`);
      else {
        const missing = found.filter(i => !inLists.has(i.key));
        if (!missing.length) say(`${found.length} match${found.length === 1 ? "" : "es"} for <strong>“${esc($("flip-search").value.trim())}”</strong>, all shown below.`);
        else for (const item of missing.slice(0, 6)) {
          let why;
          if (item.key === "Currency:divine") why = "the Divine Orb is the unit every price is measured in, so it has no price of its own to buy low or sell high";
          else if (!(item.activity > 0)) why = "it has no trading volume in the latest capture";
          else if (item.activity < opts.minVolumeDiv) why = `it trades only ${fmtVol(item.activity)} a day, under your ${opts.minVolumeDiv} minimum`;
          else {
            const eb = MM.edgeOf(item, "buy", opts), es = MM.edgeOf(item, "sell", opts);
            why = !eb.usual ? eb.reason : `buying: ${eb.reason}; selling: ${es.reason}`;
          }
          say(`<strong>${esc(item.name)}</strong> is in your data but not listed: ${esc(why)}.`);
        }
        if (missing.length > 6) say(`…and ${missing.length - 6} more matches that are not candidates.`);
      }
    }
  }

  // Re-reads the saved snapshots every 5 minutes (this page only reads the published data file; it never contacts poe.ninja).
  async function refreshQuietly() {
    if (document.hidden || !state.items.length) return;
    try {
      const data = await MM.loadMarket();
      if (data.capturedAt === state.capturedAt) return;
      const order = c => (c === "Currency" ? "" : c);
      const l = state.left && state.left.key, r = state.right && state.right.key;
      state.capturedAt = data.capturedAt;
      state.items = data.items.sort((a, b) => order(a.category).localeCompare(order(b.category)) || b.divine - a.divine);
      state.left = state.items.find(i => i.key === l) || state.items[0];
      state.right = state.items.find(i => i.key === r) || state.items[1];
      leftCombo.paint(); rightCombo.paint(); onCurrencyChange(); renderIdeas();
      const when = data.capturedAt ? new Date(data.capturedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "unknown time";
      $("xc-meta").textContent = `${state.items.length} currencies from ${data.source === "snapshot" ? "a saved poe.ninja snapshot" : "the latest poe.ninja capture"} (${when}). Refreshes itself.`;
    } catch { /* keep the last good data */ }
  }

  async function boot() {
    setInterval(refreshQuietly, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuietly(); });
    leftCombo = makeCombo($("combo-left"), "left");
    rightCombo = makeCombo($("combo-right"), "right");
    try {
      const data = await MM.loadMarket();
      if (window.ToolsUI && ToolsUI.setLeague) ToolsUI.setLeague(data.league);
      settingsState = await MM.loadSettings();
      opts = MM.optionsFrom(settingsState.values);
      const order = c => (c === "Currency" ? "" : c);
      state.capturedAt = data.capturedAt;
      state.items = data.items.sort((a, b) => order(a.category).localeCompare(order(b.category)) || b.divine - a.divine);
      const find = key => state.items.find(i => i.key === key);
      state.left = find("Currency:divine") || state.items[0];
      state.right = find("Currency:chaos") || state.items[1];
      const q = new URLSearchParams(location.search); // ?left=Currency:divine&right=Currency:chaos&ratio=1.564
      if (find(q.get("left"))) state.left = find(q.get("left"));
      if (find(q.get("right"))) state.right = find(q.get("right"));
      if (q.get("ratio") && /^[0-9.,]+$/.test(q.get("ratio"))) $("ratio").value = q.get("ratio");
      leftCombo.paint(); rightCombo.paint();
      const when = data.capturedAt ? new Date(data.capturedAt).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "unknown time";
      $("xc-meta").textContent = `${state.items.length} currencies from ${data.source === "snapshot" ? "a saved poe.ninja snapshot" : "the latest poe.ninja capture"} (${when}). Prices are guides; type any ratio you like.`;
      onCurrencyChange();
      if (q.get("ratio") && /^[0-9.,]+$/.test(q.get("ratio"))) { $("ratio").value = q.get("ratio"); fromLeft(); }
      renderIdeas();
    } catch (error) {
      $("xc-meta").textContent = `Could not load currencies (${error.message}). Please try again in a few minutes.`;
    }
  }

  window.ToolsUI.mountNav("exchange");
  document.getElementById("open-settings").addEventListener("click", () => {
    if (!settingsState) return;
    window.ToolsUI.openSettings(settingsState, values => { if (window.Ledger) window.Ledger.applySettings(settingsState, values); opts = MM.optionsFrom(values); state.items.forEach(i => { delete i._spike; }); renderIdeas(); });
  });
  $("left-qty").addEventListener("input", fromLeft);
  $("right-qty").addEventListener("input", fromRight);
  $("ratio").addEventListener("input", onRatio);
  $("swap").addEventListener("click", doSwap);
  $("raise-left").addEventListener("click", () => doRaise("left"));
  $("raise-right").addEventListener("click", () => doRaise("right"));
  $("exact-pair").addEventListener("click", doExact);
  $("use-market").addEventListener("click", () => { if (state.left && state.right) onCurrencyChange(); });
  // Typing a margin sets the ratio from the market ratio; otherwise the box just follows the numbers.
  $("margin").addEventListener("input", () => {
    if (!state.left || !state.right) return;
    const txt = (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test($("margin").value.trim()) ? $("margin").value.trim().replace(/,/g, "") : $("margin").value.trim().replace(",", "."));
    if (!/^[+-]?\d*\.?\d+$/.test(txt)) return;
    const m = Math.max(-99, Math.min(1000, Number(txt))) / 100;
    $("ratio").value = marketText(state.left.divine / state.right.divine * (1 + m));
    showResult("", ""); fromLeft();
  });
  function applyPair(leftKey, rightKey, ratio) {
    const l = state.items.find(i => i.key === leftKey), r = state.items.find(i => i.key === rightKey);
    if (!l || !r) return;
    state.left = l; state.right = r; leftCombo.paint(); rightCombo.paint(); onCurrencyChange();
    if (/^[0-9.,]+$/.test(ratio || "")) { $("ratio").value = ratio; fromLeft(); }
    $("col-calc").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // Links from the ledger ("Open in calculator") act on this page instead of leaving it.
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[href^='/tradedesk?']");
    if (!a) return;
    e.preventDefault();
    const q = new URL(a.href).searchParams;
    const lm = $("lg-modal"); if (lm) lm.hidden = true;
    applyPair(q.get("left"), q.get("right"), q.get("ratio"));
  });
  $("add-ledger").addEventListener("click", () => {
    const msg = $("add-msg"), num = v => { const d = parseDec(v); return d ? Number(d.n) / Number(d.d) : NaN; };
    const res = window.Ledger && state.left && state.right
      ? window.Ledger.addFromCalc({ key: state.left.key, qty: num($("left-qty").value) }, { key: state.right.key, qty: num($("right-qty").value) })
      : { ok: false, text: "Prices are still loading." };
    msg.textContent = res.text; clearTimeout(msg._t); msg._t = setTimeout(() => { msg.textContent = ""; }, 4000);
  });
  $("xc-modal-x").addEventListener("click", closeModal);
  $("xc-modal").addEventListener("mousedown", e => { if (e.target === $("xc-modal")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal().hidden) closeModal(); });
  $("flip-search").addEventListener("input", () => { if (state.items.length) renderIdeas(); });
  boot();
}

if (typeof module !== "undefined") module.exports = { parseDec, frac, mul, div, fmt, raise, reducedPair };
