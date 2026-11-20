"use strict";
// Trade Ledger: log in-game trades, value them at today's poe.ninja price, suggest swaps, raise alerts.
// Trades live in this browser (localStorage) so the page also works as a hosted static site.
(function () {
  const MM = window.MarketModel;
  const $ = id => document.getElementById(id);
  const STORE = "poe2dd.ledger.v1", SEEN = "poe2dd.ledger.seen";
  const state = { items: [], map: new Map(), opts: MM.DEFAULT_OPTIONS, settings: null, trades: [], drops: [], capturedAt: null, source: "live", league: "" };

  // ---------- small helpers ----------
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (const kid of kids) e.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
    return e;
  };
  // "1,000" and "1,234.5" are thousands separators; "1,5" is a decimal comma. Anything else is left for Number() to reject.
  const plainNumber = text => { const t = String(text ?? "").trim().replace(/\s+/g, ""); return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(/,/g, "."); };
  const num = v => { const n = Number(plainNumber(v)); return Number.isFinite(n) ? n : NaN; };
  const fmt = v => { const n = Number(v); if (!Number.isFinite(n)) return "-"; return n >= 100 ? n.toFixed(1).replace(/\.0$/, "") : Number(n.toPrecision(4)).toString(); };
  const pct = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const when = iso => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const tone = v => (v >= 0 ? "lg-pos" : "lg-neg");

  // Each league keeps its own ledger, so trades from an old league are never valued at the new league's prices.
  // Trades saved before leagues were tracked (the plain key) move to the first league the page sees.
  const leagueSlug = v => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const storeKey = () => (state.league ? `${STORE}:${state.league}` : STORE);
  function adoptLeague(name) {
    const slug = leagueSlug(name);
    if (!slug || slug === state.league) return false;
    state.league = slug;
    try {
      const legacy = localStorage.getItem(STORE);
      if (legacy && !localStorage.getItem(storeKey())) { localStorage.setItem(storeKey(), legacy); localStorage.removeItem(STORE); }
    } catch { /* storage blocked */ }
    state.trades = loadTrades();
    return true;
  }
  function loadTrades() {
    try {
      const j = JSON.parse(localStorage.getItem(storeKey()) || "{}");
      state.drops = Array.isArray(j.drops) ? j.drops.filter(validDrop).slice(0, MAX_DROPS) : [];
      return Array.isArray(j.trades) ? j.trades.filter(validTrade) : [];
    } catch { state.drops = []; return []; }
  }
  function saveTrades() { try { localStorage.setItem(storeKey(), JSON.stringify({ version: 1, trades: state.trades, drops: state.drops })); } catch { /* storage blocked: kept in memory only */ } }
  const MAX_QTY = 1e12, MAX_TRADES = 5000, MAX_DROPS = 2000;
  const goodQty = q => typeof q === "number" && Number.isFinite(q) && q > 0 && q <= MAX_QTY; // JSON like 1e999 becomes Infinity
  function validTrade(t) {
    return t && typeof t.id === "string" && t.give && t.get && typeof t.give.key === "string" && typeof t.get.key === "string"
      && goodQty(Number(t.give.qty)) && goodQty(Number(t.get.qty)) && Number.isFinite(Date.parse(t.ts));
  }

  // The Divine value of both sides at the moment of the trade, so the real result can be measured later.
  const entryFor = (give, gq, got, tq) => (give.divine > 0 && got.divine > 0 ? { entry: { give: gq * give.divine, get: tq * got.divine } } : {});

  // ---------- values in Divine / Chaos / Exalted ----------
  const UNIT_KEY = "poe2dd.ledgerUnit";
  let unitPref = "auto"; try { const u = localStorage.getItem(UNIT_KEY); if (["auto", "div", "chaos", "ex"].includes(u)) unitPref = u; } catch { /* default */ }
  const priceDiv = key => { const i = state.map.get(key); return i && i.divine > 0 ? i.divine : null; };
  // Picks the unit for an amount worth `div` Divine. Automatic follows the size (1 Divine or more: Divine; 1 Chaos up to 1 Divine: Chaos; below that: Exalted),
  // so a position that jumps from Chaos-sized to Divine-sized is shown in Divine on the next refresh.
  function unitFor(div) {
    const chaos = priceDiv("Currency:chaos"), ex = priceDiv("Currency:exalted");
    const mk = (name, p) => ({ name, p });
    const pref = unitPref === "auto" ? (Math.abs(div) >= 1 || !chaos ? "div" : Math.abs(div) >= chaos || !ex ? "chaos" : "ex") : unitPref;
    if (pref === "chaos" && chaos) return mk("Chaos", chaos);
    if (pref === "ex" && ex) return mk("Exalted", ex);
    return mk("Divine", 1);
  }
  const money = (div, unit) => `${fmt(div / unit.p)} ${unit.name}`;
  const signedMoney = (div, unit) => `${div >= 0 ? "+" : "\u2212"}${fmt(Math.abs(div) / unit.p)} ${unit.name}`;

  function validDrop(d) {
    return d && typeof d.id === "string" && typeof d.key === "string" && goodQty(Number(d.qty)) && Number.isFinite(Date.parse(d.ts))
      && (!d.sold || (goodQty(Number(d.sold.divine)) && Number.isFinite(Date.parse(d.sold.ts))));
  }
  const cleanDrop = d => ({
    id: String(d.id).slice(0, 40), ts: new Date(d.ts).toISOString(), key: String(d.key).slice(0, 120), qty: Number(d.qty),
    note: typeof d.note === "string" ? d.note.slice(0, 120) : "",
    sold: d.sold ? { divine: Number(d.sold.divine), ts: new Date(d.sold.ts).toISOString() } : null
  });

  // ---------- item pickers ----------
  const labels = new Map(); // label (lowercase) -> item
  function buildLabels() {
    labels.clear();
    const counts = new Map(); for (const i of state.items) counts.set(i.name, (counts.get(i.name) || 0) + 1);
    const list = $("item-names"); list.textContent = "";
    const seen = new Set();
    for (const i of [...state.items].sort((a, b) => (a.category === "Currency" ? 0 : 1) - (b.category === "Currency" ? 0 : 1) || b.divine - a.divine)) {
      const label = counts.get(i.name) > 1 ? `${i.name} (${i.category})` : i.name;
      if (seen.has(label)) continue; seen.add(label);
      labels.set(label.toLowerCase(), i);
      list.append(el("option", { value: label }));
    }
  }
  const pick = text => labels.get(String(text).trim().toLowerCase()) || null;
  const nameOf = key => { const i = state.map.get(key); return i ? i.name : key.split(":").slice(1).join(":") || key; };

  // ---------- form ----------
  function syncFromRatio() { const g = num($("give-qty").value), r = num($("trade-ratio").value); if (g > 0 && r > 0) $("get-qty").value = fmt(g * r); }
  function syncFromGet() { const g = num($("give-qty").value), t = num($("get-qty").value); if (g > 0 && t > 0) $("trade-ratio").value = fmt(t / g); }
  // Live market ratio while typing: what 1 of the item you give is worth in the item you get.
  function updateHint() {
    const out = $("market-hint"), give = pick($("give-name").value), got = pick($("get-name").value);
    if (!give || !got || give.key === got.key) { out.textContent = give && got ? "Choose two different currencies." : "Pick both currencies to see the market ratio."; return; }
    const market = give.divine / got.divine;
    const uG = MM.usualPrice(give, state.opts), uB = MM.usualPrice(got, state.opts);
    const usual = uG > 0 && uB > 0 ? uG / uB : 0;
    let text = `Market now: 1 ${give.name} = ${fmt(market)} ${got.name}`;
    if (usual > 0 && Math.abs(usual / market - 1) > 0.005) text += ` · usual about ${fmt(usual)}`;
    let r = num($("trade-ratio").value);
    if (!(r > 0)) { const g = num($("give-qty").value), t = num($("get-qty").value); if (g > 0 && t > 0) r = t / g; }
    if (r > 0) {
      const d = (r / market - 1) * 100;
      text += Math.abs(d) < 0.5 ? ` · your ratio is at the market rate`
        : d > 0 ? ` · your ratio gets you ${d.toFixed(1)}% more than the market rate`
        : ` · your ratio gets you ${Math.abs(d).toFixed(1)}% less than the market rate`;
      if (Math.abs(d) >= 0.5) text += d > 0 ? " ▲" : " ▼";
    }
    out.textContent = text + ".";
  }
  function setNow() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); $("trade-when").value = d.toISOString().slice(0, 16); }

  function onSubmit(e) {
    e.preventDefault();
    const msg = $("form-msg"), give = pick($("give-name").value), got = pick($("get-name").value);
    const gq = num($("give-qty").value), tq = num($("get-qty").value);
    const fail = text => { msg.textContent = text; };
    if (!give) return fail("Choose the currency you gave from the list.");
    if (!got) return fail("Choose the currency you got from the list.");
    if (give.key === got.key) return fail("Give and get must be different currencies.");
    if (!(gq > 0) || !(tq > 0)) return fail("Enter an amount for both sides.");
    const ts = $("trade-when").value ? new Date($("trade-when").value).toISOString() : new Date().toISOString();
    const fresh = Math.abs(Date.now() - Date.parse(ts)) < 90 * 60 * 1000; // a back-dated trade has no known entry price
    state.trades.push({ id: uid(), ts, give: { key: give.key, qty: gq }, get: { key: got.key, qty: tq }, ...(fresh ? entryFor(give, gq, got, tq) : {}), note: $("trade-note").value.trim().slice(0, 120), closed: null });
    saveTrades(); msg.textContent = "";
    for (const id of ["give-name", "give-qty", "get-name", "get-qty", "trade-ratio", "trade-note"]) $(id).value = "";
    setNow(); render(); updateHint();
  }

  function onDropSubmit(e) {
    e.preventDefault();
    const msg = $("drop-msg"), item = pick($("drop-name").value), qty = num($("drop-qty").value);
    if (!item) { msg.textContent = "Choose the item from the list."; return; }
    if (!(qty > 0) || qty > MAX_QTY) { msg.textContent = "Enter how many dropped."; return; }
    if (state.drops.length >= MAX_DROPS) { msg.textContent = `The ledger holds at most ${MAX_DROPS} drops.`; return; }
    state.drops.push({ id: uid(), ts: new Date().toISOString(), key: item.key, qty, note: $("drop-note").value.trim().slice(0, 120), sold: null });
    saveTrades(); msg.textContent = "";
    $("drop-name").value = ""; $("drop-qty").value = "1"; $("drop-note").value = "";
    render();
  }

  // ---------- modal + toasts ----------
  function openModal(builder) {
    const body = $("lg-modal-body"); body.textContent = ""; builder(body); $("lg-modal").hidden = false; $("lg-modal-x").focus();
  }
  const closeModal = () => { $("lg-modal").hidden = true; };
  function confirmBox(title, text, okLabel, onOk) {
    openModal(body => {
      body.append(el("h4", {}, title), el("p", {}, text));
      const ok = el("button", { type: "button", class: "xc-btn lg-danger" }, okLabel), no = el("button", { type: "button", class: "xc-btn" }, "Cancel");
      ok.addEventListener("click", () => { closeModal(); onOk(); }); no.addEventListener("click", closeModal);
      body.append(el("div", { class: "lg-btns" }, ok, no));
    });
  }
  // "Ask before deleting" (on by default; remembered in this browser). With it off, deleting a trade happens at once and a
  // message offers Undo. Closing a trade always opens its own amount box. Clearing many trades at once always asks.
  const CONFIRM_KEY = "poe2dd.ledgerConfirm";
  const confirmOn = () => { const box = $("lg-confirm"); return !box || box.checked; };
  function removeTrade(trade, title, text) {
    const before = state.trades.slice();
    state.trades = state.trades.filter(x => x.id !== trade.id); saveTrades(); render();
    if (!confirmOn()) toast("info", title, text, { label: "Undo", run: () => { state.trades = before; saveTrades(); render(); } });
  }
  function toast(kind, title, text, action) {
    const t = el("div", { class: `lg-toast ${kind}`, role: "status" }, el("b", {}, title), el("span", {}, text));
    const close = el("button", { type: "button", class: "xc-btn" }, "Dismiss"); close.addEventListener("click", () => t.remove());
    const row = el("div", { class: "lg-btns" }, close);
    if (action) { const a = el("button", { type: "button", class: "xc-btn xc-primary" }, action.label); a.addEventListener("click", () => { t.remove(); action.run(); }); row.prepend(a); }
    t.append(row); $("toasts").append(t);
    setTimeout(() => t.remove(), 20000);
  }

  // ---------- rendering ----------
  function calcLink(left, right) {
    const ratio = left.divine / right.divine;
    return `/tradedesk?left=${encodeURIComponent(left.key)}&right=${encodeURIComponent(right.key)}&ratio=${encodeURIComponent(Number(ratio.toPrecision(5)))}`;
  }

  // ---------- view: cards or a simple list, each position expandable ----------
  // "cards" opens every position; "list" shows one compact line per position. Either way a position can be opened or
  // closed by clicking it, and what you opened stays open when prices refresh.
  const VIEW_KEY = "poe2dd.ledgerView";
  const view = { mode: (() => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards"; } catch { return "cards"; } })(), open: new Map() };
  function collapsible(id, title, sub, result, resultCls, body, cols) {
    const list = view.mode === "list" && cols;
    const d = el("details", { class: list ? "lg-row" : "lg-pcard lg-coll" });
    d.open = view.open.has(id) ? view.open.get(id) : view.mode === "cards";
    d.addEventListener("toggle", () => view.open.set(id, d.open));
    let sum;
    if (list) {
      // A real list: one line per position with the numbers in columns, details open underneath when clicked.
      sum = el("summary", { class: "lg-cols" }, el("span", { class: "lg-c-name" }, title));
      sum.style.gridTemplateColumns = tracks(cols.map(c => !!c.node)); // set from script: the page policy blocks style attributes
      for (const c of cols) sum.append(c.node ? el("span", { class: "lg-c lg-act" }, c.node) : el("span", { class: "lg-c " + (c.cls || "") }, c.t));
    } else {
      sum = el("summary", {}, el("span", { class: "lg-sum-t" }, title), el("span", { class: "lg-sum-m" }, sub));
      if (result) sum.append(el("strong", { class: "lg-sum-r " + (resultCls || "") }, result));
    }
    d.append(sum, body);
    return d;
  }
  // Column titles above a list.
  // Grid columns for a list row: a name column, then equal columns; a column holding a button is only as wide as the button.
  const tracks = acts => `minmax(0,1.5fr) ${acts.map(a => (a ? "auto" : "minmax(0,1fr)")).join(" ")}`;
  const listHead = (labels, acts) => {
    const h = el("div", { class: "lg-cols lg-head", "aria-hidden": "true" }, el("span", { class: "lg-c-name" }, labels[0]), ...labels.slice(1).map(t => el("span", { class: "lg-c" }, t)));
    h.style.gridTemplateColumns = tracks(acts);
    return h;
  };
  function setView(mode) {
    view.mode = mode; view.open.clear();
    try { localStorage.setItem(VIEW_KEY, mode); } catch { /* kept for this page */ }
    render();
  }
  function setAll(open) {
    document.querySelectorAll("#positions details, #closed details").forEach(d => { d.open = open; });
  }

  function positionCard(trade) {
    const { pos, options, basis, tooSmall, unique } = MM.swapOptions(trade, state.map, state.items, state.opts, 3);
    const A = state.map.get(trade.give.key), B = state.map.get(trade.get.key);
    const card = el("div", { class: "lg-body" });
    card.append(el("p", { class: "lg-meta" }, `Paid ${fmt(trade.give.qty)} ${nameOf(trade.give.key)} on ${when(trade.ts)} · ratio ${fmt(trade.get.qty / trade.give.qty)} per 1${trade.note ? ` · “${trade.note}”` : ""}`));
    if (!pos) {
      card.append(el("p", { class: "lg-empty" }, `${!A ? nameOf(trade.give.key) : nameOf(trade.get.key)} is not in the latest poe.ninja capture, so this position cannot be valued right now.`));
    } else {
      const chips = el("div", { class: "lg-chips" });
      const prem = pos.premiumB;
      if (prem !== null) chips.append(el("span", { class: `lg-chip ${prem >= 1 + state.opts.sellWindowPct / 100 ? "good" : prem <= 0.9 ? "warn" : ""}` }, `${nameOf(trade.get.key)} is ${Math.abs((prem - 1) * 100).toFixed(0)}% ${prem >= 1 ? "above" : "below"} its usual price`));
      if (pos.resultPct !== null && pos.resultPct <= -state.opts.badLossPct) chips.append(el("span", { class: "lg-chip bad" }, "Down in Divine value"));
      const sp = MM.spikeOf(pos.B, state.opts.spikePct).now; if (sp) chips.append(el("span", { class: "lg-chip warn" }, sp > 0 ? "Price spike right now" : "Price dip right now"));
      card.append(chips);
      const stat = (label, value, cls) => el("div", {}, el("span", {}, label), el("strong", { class: cls || "" }, value));
      const u = unitFor(Math.max(pos.nowDivine, pos.entryDivine || 0));
      const stats = [stat("Worth now", money(pos.nowDivine, u))];
      if (pos.entryDivine !== null) stats.push(
        stat("Gave up (its value then)", money(pos.entryDivine, u)),
        stat("Result (mid price)", `${signedMoney(pos.resultDivine, u)} (${pct(pos.resultPct)})`, tone(pos.resultPct)),
        stat(`Result after ${state.opts.exchangeSpreadPct}% spread`, `${signedMoney(pos.resultNetDivine, u)} (${pct(pos.resultNetPct)})`, tone(pos.resultNetPct)));
      stats.push(stat("Market ratio now", `${fmt(pos.marketRatio)} per 1`));
      card.append(el("div", { class: "lg-grid" }, ...stats));
      if (pos.entryDivine === null) card.append(el("p", { class: "lg-meta" }, "This trade was logged before entry prices were recorded (or back-dated), so its result cannot be measured. Trades logged from now on record it."));
      card.append(el("div", { class: "lg-h" }, "Top 3 swaps"));
      const ul = el("ul", { class: "lg-swaps" });
      if (!options.length) ul.append(el("li", { class: "lg-empty" }, unique ? "Swap ideas cover exchange currencies only. A unique is sold on the trade site, so watch its price against the usual level and list it when it is high." : basis && !(basis.F > 0) ? `There is no reliable usual price for ${nameOf(trade.get.key)} yet (${basis.trending ? "its price has been trending" : "not enough history"}), so swap ideas are held back until there is.` : tooSmall ? `A swap looks profitable, but ${fmt(trade.get.qty)} ${nameOf(trade.get.key)} is too little to get even 1 whole unit of the other currency (the exchange only trades whole numbers). Hold until you have more, or sell it for something cheaper.` : "No swap looks profitable right now once trading costs are paid. Holding, or selling at a better time, may be wiser."));
      for (const o of options) {
        ul.append(el("li", { class: "lg-swap" },
          el("span", {}, el("b", {}, `${nameOf(o.C.key)}`), ` · swap ${fmt(o.give)} ${nameOf(trade.get.key)} for about ${fmt(o.receive)}${o.keep > 0.0001 ? ` · keep ${fmt(o.keep)} ${nameOf(trade.get.key)}` : ""}`,
            el("small", {}, `Expected ${pct(o.net)} after spread (${pct(o.totalPct)} vs your original cost) · confidence ${o.confidence}${o.caution ? ` · note: ${o.caution}` : ""}`)),
          el("a", { href: calcLink(pos.B, o.C) }, "Open in calculator")));
      }
      card.append(ul);
    }
    const close = el("button", { type: "button", class: "xc-btn" }, "Close position…"), del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
    close.addEventListener("click", () => closePosition(trade, pos));
    del.addEventListener("click", () => { const go = () => removeTrade(trade, "Trade deleted", `${fmt(trade.get.qty)} ${nameOf(trade.get.key)} was removed.`); if (confirmOn()) confirmBox("Delete this trade?", "This removes it from your ledger. It cannot be undone.", "Delete", go); else go(); });
    card.append(el("div", { class: "lg-btns" }, close, del));
    const rowClose = el("button", { type: "button", class: "xc-btn lg-rowbtn" }, "Close");
    rowClose.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); closePosition(trade, pos); });
    return collapsible(trade.id, `${fmt(trade.get.qty)} ${nameOf(trade.get.key)}`, `paid ${fmt(trade.give.qty)} ${nameOf(trade.give.key)}`, pos && pos.resultPct !== null ? pct(pos.resultPct) : "", pos && pos.resultPct !== null ? tone(pos.resultPct) : "", card,
      [{ t: `${fmt(trade.give.qty)} ${nameOf(trade.give.key)}` }, { t: pos ? money(pos.nowDivine, unitFor(Math.max(pos.nowDivine, pos.entryDivine || 0))) : "-" },
       { t: pos && pos.resultPct !== null ? pct(pos.resultPct) : "-", cls: pos && pos.resultPct !== null ? tone(pos.resultPct) : "" },
       { t: pos && pos.resultNetPct !== null ? pct(pos.resultNetPct) : "-", cls: pos && pos.resultNetPct !== null ? tone(pos.resultNetPct) : "" }, { node: rowClose }]);
  }

  function closePosition(trade, pos) {
    openModal(body => {
      const A = nameOf(trade.give.key);
      body.append(el("h4", {}, "Close position"), el("p", {}, `How much ${A} did you get back for your ${fmt(trade.get.qty)} ${nameOf(trade.get.key)}?`));
      const input = el("input", { class: "xc-input", inputmode: "decimal", value: pos ? fmt(pos.nowInA * (1 - state.opts.exchangeSpreadPct / 100)) : "" });
      const msg = el("p", { class: "xc-set-msg" });
      const ok = el("button", { type: "button", class: "xc-btn xc-primary" }, "Close position");
      ok.addEventListener("click", () => {
        const q = num(input.value); if (!(q > 0)) { msg.textContent = "Enter an amount above zero."; return; }
        trade.closed = { qty: q, ts: new Date().toISOString() }; saveTrades(); closeModal(); render();
      });
      body.append(input, msg, el("div", { class: "lg-btns" }, ok));
    });
  }

  function dropCard(drop) {
    const v = valueDropNow(drop), name = nameOf(drop.key);
    const body = el("div", { class: "lg-body" });
    body.append(el("p", { class: "lg-meta" }, `Found ${when(drop.ts)}${drop.note ? ` \u00b7 \u201c${drop.note}\u201d` : ""}`));
    if (!v) {
      body.append(el("p", { class: "lg-empty" }, `${name} is not in the latest poe.ninja capture, so this drop cannot be valued right now.`));
    } else {
      const chips = el("div", { class: "lg-chips" }), prem = v.premiumB;
      if (prem !== null) chips.append(el("span", { class: `lg-chip ${prem >= 1 + state.opts.sellWindowPct / 100 ? "good" : prem <= 0.9 ? "warn" : ""}` }, `${name} is ${Math.abs((prem - 1) * 100).toFixed(0)}% ${prem >= 1 ? "above" : "below"} its usual price`));
      if (prem !== null && prem >= 1 + state.opts.sellWindowPct / 100) chips.append(el("span", { class: "lg-chip good" }, "Sell window"));
      const sp = MM.spikeOf(v.B, state.opts.spikePct).now; if (sp) chips.append(el("span", { class: "lg-chip warn" }, sp > 0 ? "Price spike right now" : "Price dip right now"));
      body.append(chips);
      const stat = (label, value) => el("div", {}, el("span", {}, label), el("strong", {}, value));
      body.append(el("div", { class: "lg-grid" },
        stat("Worth now (Divine)", fmt(v.nowDivine)),
        stat(`After ${state.opts.exchangeSpreadPct}% spread`, fmt(v.netDivine)),
        stat("Price now (Divine each)", fmt(v.B.divine)),
        stat("Usual price (Divine each)", v.usual > 0 ? fmt(v.usual) : "-")));
    }
    const sell = el("button", { type: "button", class: "xc-btn" }, "Sold\u2026"), del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
    sell.addEventListener("click", () => sellDrop(drop, v));
    del.addEventListener("click", () => { const go = () => removeDrop(drop, "Drop deleted", `${fmt(drop.qty)} ${name} was removed.`); if (confirmOn()) confirmBox("Delete this drop?", "This removes it from your ledger. It cannot be undone.", "Delete", go); else go(); });
    body.append(el("div", { class: "lg-btns" }, sell, del));
    const rowSell = el("button", { type: "button", class: "xc-btn lg-rowbtn" }, "Sold");
    rowSell.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); sellDrop(drop, v); });
    return collapsible(`drop:${drop.id}`, `${fmt(drop.qty)} ${name}`, `found ${when(drop.ts)}`, v ? `${fmt(v.nowDivine)} div` : "", "lg-pos", body,
      [{ t: `${fmt(drop.qty)} ${name}` }, { t: v ? `${fmt(v.nowDivine)} div` : "-" }, { t: v && v.premiumB !== null ? pct((v.premiumB - 1) * 100) : "-", cls: v && v.premiumB !== null ? tone(v.premiumB - 1) : "" }, { node: rowSell }]);
  }
  const valueDropNow = drop => MM.valueDrop(drop, state.map, state.opts);
  function removeDrop(drop, title, text) {
    const before = state.drops.slice();
    state.drops = state.drops.filter(x => x.id !== drop.id); saveTrades(); render();
    if (!confirmOn()) toast("info", title, text, { label: "Undo", run: () => { state.drops = before; saveTrades(); render(); } });
  }
  function sellDrop(drop, v) {
    openModal(body => {
      body.append(el("h4", {}, "Sold this drop"), el("p", {}, `How much did you get for ${fmt(drop.qty)} ${nameOf(drop.key)}, in Divine Orbs? Everything counts as profit.`));
      const input = el("input", { class: "xc-input", inputmode: "decimal", value: v ? fmt(v.netDivine) : "" });
      const msg = el("p", { class: "xc-set-msg" });
      const ok = el("button", { type: "button", class: "xc-btn xc-primary" }, "Mark sold");
      ok.addEventListener("click", () => {
        const q = num(input.value); if (!(q > 0) || q > MAX_QTY) { msg.textContent = "Enter an amount above zero."; return; }
        drop.sold = { divine: q, ts: new Date().toISOString() }; saveTrades(); closeModal(); render();
      });
      body.append(input, msg, el("div", { class: "lg-btns" }, ok));
    });
  }
  function renderDrops() {
    const open = state.drops.filter(d => !d.sold).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const host = $("drops"); host.textContent = "";
    host.classList.toggle("lg-table", view.mode === "list");
    if (!open.length) host.append(el("p", { class: "lg-empty" }, "No drops yet. Add one above to start watching its price."));
    else if (view.mode === "list") host.append(listHead(["Drop", "Worth now", "vs usual price", ""], [false, false, true]));
    for (const d of open) host.append(dropCard(d));
    const sold = state.drops.filter(d => d.sold).sort((a, b) => Date.parse(b.sold.ts) - Date.parse(a.sold.ts));
    const sh = $("drops-sold"); sh.textContent = "";
    if (!sold.length) { sh.append(el("p", { class: "lg-empty" }, "Nothing sold yet.")); return; }
    let total = 0;
    for (const d of sold) {
      total += d.sold.divine;
      const del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
      del.addEventListener("click", () => { const go = () => removeDrop(d, "Sold drop deleted", `${fmt(d.qty)} ${nameOf(d.key)} was removed.`); if (confirmOn()) confirmBox("Delete this sold drop?", "It cannot be undone.", "Delete", go); else go(); });
      sh.append(collapsible(`dropsold:${d.id}`, `${fmt(d.qty)} ${nameOf(d.key)} \u2192 ${fmt(d.sold.divine)} div`, `sold ${when(d.sold.ts)}`, `+${fmt(d.sold.divine)} div`, "lg-pos",
        el("div", { class: "lg-body" }, el("p", { class: "lg-meta" }, `Found ${when(d.ts)} \u00b7 sold ${when(d.sold.ts)}${d.note ? ` \u00b7 \u201c${d.note}\u201d` : ""}`), el("div", { class: "lg-btns" }, del))));
    }
    sh.prepend(el("p", { class: "lg-meta" }, `Earned from sold drops: ${fmt(total)} Divine.`));
  }

  function renderSummary() {
    const open = state.trades.filter(t => !t.closed);
    let cost = 0, value = 0, valueKnown = 0, realisedCost = 0, realisedBack = 0;
    for (const t of open) { const p = MM.valuePosition(t, state.map, state.opts); if (p) { value += p.nowDivine; if (p.entryDivine !== null) { cost += p.entryDivine; valueKnown += p.nowDivine; } } }
    for (const t of state.trades.filter(t => t.closed)) { const A = state.map.get(t.give.key); if (A) { realisedCost += t.give.qty * A.divine; realisedBack += t.closed.qty * A.divine; } }
    const open$ = cost > 0 ? (valueKnown / cost - 1) * 100 : null, real$ = realisedCost > 0 ? (realisedBack / realisedCost - 1) * 100 : null;
    const box = $("lg-summary"); box.textContent = "";
    const stat = (label, value, cls) => el("div", { class: "lg-stat" }, el("span", {}, label), el("strong", { class: cls || "" }, value));
    box.append(stat("Open positions", String(open.length)),
      stat(`Cost (${unitFor(Math.max(cost, value)).name})`, cost ? money(cost, unitFor(Math.max(cost, value))) .replace(/ \S+$/, "") : "-"),
      stat(`Worth now (${unitFor(Math.max(cost, value)).name})`, value ? money(value, unitFor(Math.max(cost, value))).replace(/ \S+$/, "") : "-"),
      stat("Open profit", open$ === null ? "-" : pct(open$), open$ === null ? "" : tone(open$)));
    if (real$ !== null) box.append(stat("Closed profit", pct(real$), tone(real$)));
  }

  function renderClosed() {
    const host = $("closed"); host.textContent = "";
    const list = state.trades.filter(t => t.closed).sort((a, b) => Date.parse(b.closed.ts) - Date.parse(a.closed.ts));
    if (!list.length) { host.append(el("p", { class: "lg-empty" }, "Nothing closed yet.")); return; }
    host.classList.toggle("lg-table", view.mode === "list");
    if (view.mode === "list") host.append(listHead(["Position", "Paid", "Closed", "Result", ""], [false, false, false, true]));
    for (const t of list) {
      const real = (t.closed.qty / t.give.qty - 1) * 100;
      const del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
      del.addEventListener("click", () => { const go = () => removeTrade(t, "Closed trade deleted", `${fmt(t.get.qty)} ${nameOf(t.get.key)} was removed.`); if (confirmOn()) confirmBox("Delete this closed trade?", "It cannot be undone.", "Delete", go); else go(); });
      const rowDel = el("button", { type: "button", class: "xc-btn lg-rowbtn lg-danger" }, "Delete");
      rowDel.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); del.click(); });
      host.append(collapsible(`closed:${t.id}`, `${fmt(t.get.qty)} ${nameOf(t.get.key)} \u2192 ${fmt(t.closed.qty)} ${nameOf(t.give.key)}`, `closed ${when(t.closed.ts)}`, pct(real), tone(real), el("div", { class: "lg-body" },
        el("p", { class: "lg-meta" }, `Opened ${when(t.ts)} · closed ${when(t.closed.ts)} · paid ${fmt(t.give.qty)} ${nameOf(t.give.key)}`),
        el("div", { class: "lg-grid" }, el("div", {}, el("span", {}, "Result"), el("strong", { class: tone(real) }, pct(real)))),
        el("div", { class: "lg-btns" }, del)),
        [{ t: `${fmt(t.give.qty)} ${nameOf(t.give.key)}` }, { t: when(t.closed.ts) }, { t: pct(real), cls: tone(real) }, { node: rowDel }]));
    }
  }

  let alerts = [];
  function renderAlerts() {
    alerts = MM.alertsFor(state.trades, state.map, state.items, state.opts, state.drops);
    const count = $("bell-count"); count.textContent = String(alerts.length); count.className = "lg-count" + (alerts.length ? " has" : "");
    let seen = []; try { seen = JSON.parse(localStorage.getItem(SEEN) || "[]"); } catch { /* ignore */ }
    const fresh = alerts.filter(a => !seen.includes(a.id));
    if (fresh.length) {
      const top = fresh[0];
      toast(top.kind, fresh.length === 1 ? top.title : `${fresh.length} new alerts`, fresh.length === 1 ? top.detail : `${top.title}, and ${fresh.length - 1} more.`, { label: "View alerts", run: openAlerts });
      try { localStorage.setItem(SEEN, JSON.stringify([...new Set([...seen, ...alerts.map(a => a.id)])].slice(-300))); } catch { /* ignore */ }
    }
  }
  function openAlerts() {
    openModal(body => {
      body.append(el("h4", {}, "Alerts"));
      if (!alerts.length) body.append(el("p", {}, "Nothing needs your attention. Alerts appear when a swap is worth a lot, an item hits a sell window, or a position goes bad."));
      for (const a of alerts) {
        const box = el("div", { class: `lg-alert ${a.kind}` }, el("b", {}, a.title), el("span", {}, a.detail));
        if (a.swapTo) {
          const t = state.trades.find(x => x.id === a.tradeId), B = t && state.map.get(t.get.key), C = state.map.get(a.swapTo);
          if (B && C) box.append(el("small", {}, el("a", { href: calcLink(B, C) }, "Open this swap in the calculator")));
        }
        body.append(box);
      }
      body.append(el("small", { class: "xc-set-help" }, "Estimates only. They assume prices drift back to their usual level and subtract the assumed spread; the market can move the other way."));
    });
  }

  function render() {
    const open = state.trades.filter(t => !t.closed).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const host = $("positions"); host.textContent = "";
    if (!open.length) host.append(el("p", { class: "lg-empty" }, "No open positions. Log a trade above to start tracking it."));
    host.classList.toggle("lg-table", view.mode === "list");
    if (open.length && view.mode === "list") host.append(listHead(["Position", "Paid", "Worth now", "Result", "After spread", ""], [false, false, false, false, true]));
    for (const t of open) host.append(positionCard(t));
    renderSummary(); renderDrops(); renderClosed(); renderAlerts();
  }

  // ---------- data tools ----------
  function exportData() {
    const blob = new Blob([JSON.stringify({ app: "poe2-data-desk-ledger", version: 1, league: state.league, exportedAt: new Date().toISOString(), trades: state.trades, drops: state.drops }, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `trade-ledger-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importData(file) {
    const msg = $("data-msg"); msg.textContent = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { msg.textContent = "That file is too large to be a ledger backup."; return; }
    file.text().then(text => {
      let parsed; try { parsed = JSON.parse(text); } catch { msg.textContent = "That file is not valid JSON."; return; }
      const incoming = (Array.isArray(parsed && parsed.trades) ? parsed.trades : []).filter(validTrade).map(t => ({
        id: String(t.id).slice(0, 40), ts: new Date(t.ts).toISOString(),
        give: { key: String(t.give.key).slice(0, 120), qty: Number(t.give.qty) }, get: { key: String(t.get.key).slice(0, 120), qty: Number(t.get.qty) },
        ...(t.entry && Number(t.entry.give) > 0 && Number(t.entry.give) < 1e12 ? { entry: { give: Number(t.entry.give), get: Number(t.entry.get) > 0 ? Number(t.entry.get) : 0 } } : {}),
        note: typeof t.note === "string" ? t.note.slice(0, 120) : "",
        closed: t.closed && goodQty(Number(t.closed.qty)) && Number.isFinite(Date.parse(t.closed.ts)) ? { qty: Number(t.closed.qty), ts: new Date(t.closed.ts).toISOString() } : null
      }));
      const haveDrop = new Set(state.drops.map(d => d.id));
      const incomingDrops = (Array.isArray(parsed && parsed.drops) ? parsed.drops : []).filter(validDrop).map(cleanDrop).filter(d => !haveDrop.has(d.id) && haveDrop.add(d.id)).slice(0, Math.max(0, MAX_DROPS - state.drops.length));
      state.drops.push(...incomingDrops);
      const have = new Set(state.trades.map(t => t.id));
      let added = incoming.filter(t => !have.has(t.id) && have.add(t.id)); // also skips an id repeated inside the file
      const room = Math.max(0, MAX_TRADES - state.trades.length);
      const overflow = Math.max(0, added.length - room);
      added = added.slice(0, room);
      state.trades.push(...added); saveTrades(); render();
      const other = parsed && typeof parsed.league === "string" && state.league && leagueSlug(parsed.league) !== state.league ? ` This backup is from a different league (${parsed.league.slice(0, 40)}); its trades are valued at the current league's prices.` : "";
      msg.textContent = `Imported ${added.length} trade${added.length === 1 ? "" : "s"}${incomingDrops.length ? ` and ${incomingDrops.length} drop${incomingDrops.length === 1 ? "" : "s"}` : ""}${incoming.length - added.length - overflow ? ` (${incoming.length - added.length - overflow} already there)` : ""}.${other}${overflow ? ` ${overflow} more were skipped: the ledger holds at most ${MAX_TRADES} trades.` : ""}`;
    });
  }

  function paintViewButtons() {
    document.querySelectorAll("#lg-view [data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === view.mode));
  }
  const confirmBoxEl = $("lg-confirm");
  if (confirmBoxEl) {
    try { confirmBoxEl.checked = localStorage.getItem(CONFIRM_KEY) !== "0"; } catch { /* default: on */ }
    confirmBoxEl.addEventListener("change", () => { try { localStorage.setItem(CONFIRM_KEY, confirmBoxEl.checked ? "1" : "0"); } catch { /* kept for this page */ } });
  }
  const bar = $("lg-view");
  if (bar) {
    bar.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.view) { setView(b.dataset.view); paintViewButtons(); }
      else if (b.dataset.all) setAll(b.dataset.all === "open");
    });
    paintViewButtons();
  }

  // ---------- start ----------
  async function boot() {
    setNow();
    state.trades = loadTrades();
    try {
      const data = await MM.loadMarket();
      state.settings = await MM.loadSettings();
      state.opts = MM.optionsFrom(state.settings.values);
      state.items = data.items; state.map = MM.byKey(state.items); state.capturedAt = data.capturedAt; adoptLeague(data.league);
      const stamp = data.capturedAt ? new Date(data.capturedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "unknown time";
      $("lg-meta").textContent = `Prices from ${data.source === "snapshot" ? "a saved poe.ninja snapshot" : "the latest poe.ninja capture"} (${stamp}). Estimates only.`;
      buildLabels(); render();
    } catch (error) {
      $("lg-meta").textContent = `Could not load prices (${error.message}). Please try again in a few minutes.`;
      render();
    }
  }

  // Re-reads the saved snapshots every 5 minutes (this page only reads the published data file; it never contacts poe.ninja).
  async function refreshQuietly() {
    if (document.hidden || !$("lg-modal").hidden) return;
    try {
      const data = await MM.loadMarket();
      if (data.capturedAt === state.capturedAt && data.source !== "snapshot") return;
      if (data.capturedAt === state.capturedAt) return;
      state.items = data.items; state.map = MM.byKey(state.items); state.capturedAt = data.capturedAt; adoptLeague(data.league);
      const stamp = data.capturedAt ? new Date(data.capturedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "unknown time";
      $("lg-meta").textContent = `Prices from ${data.source === "snapshot" ? "a saved poe.ninja snapshot" : "the latest poe.ninja capture"} (${stamp}). Estimates only. Refreshes itself.`;
      render();
    } catch { /* keep showing the last good data */ }
  }
  setInterval(refreshQuietly, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuietly(); });

  $("trade-form").addEventListener("submit", onSubmit);
  { const sel = $("lg-unit"); sel.value = unitPref; sel.addEventListener("change", () => { unitPref = sel.value; try { localStorage.setItem(UNIT_KEY, unitPref); } catch { /* kept for this page */ } render(); }); }
  $("drop-form").addEventListener("submit", onDropSubmit);
  $("trade-ratio").addEventListener("input", syncFromRatio);
  $("give-qty").addEventListener("input", () => { if (num($("trade-ratio").value) > 0) syncFromRatio(); else if (num($("get-qty").value) > 0) syncFromGet(); });
  $("get-qty").addEventListener("input", syncFromGet);
  for (const id of ["give-name", "get-name", "give-qty", "get-qty", "trade-ratio"]) $(id).addEventListener("input", updateHint);
  $("bell").addEventListener("click", openAlerts);
  $("lg-modal-x").addEventListener("click", closeModal);
  $("lg-modal").addEventListener("mousedown", e => { if (e.target === $("lg-modal")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("lg-modal").hidden) closeModal(); });
  $("export").addEventListener("click", exportData);
  $("import").addEventListener("change", e => { importData(e.target.files[0]); e.target.value = ""; });
  $("clear-closed").addEventListener("click", () => confirmBox("Clear closed positions?", "All closed trades and sold drops are removed. Open positions and unsold drops stay.", "Clear closed", () => { state.trades = state.trades.filter(t => !t.closed); state.drops = state.drops.filter(d => !d.sold); saveTrades(); render(); }));
  $("clear-all").addEventListener("click", () => confirmBox("Clear the whole ledger?", "Every open and closed trade and every drop is removed from this browser. Export a backup first if you might want them.", "Clear everything", () => { state.trades = []; state.drops = []; saveTrades(); try { localStorage.removeItem(SEEN); } catch { /* ignore */ } render(); }));
  // The calculator beside the ledger drives Settings and the "Add to ledger" button.
  function addFromCalc(g, t) {
    const give = state.map.get(g.key), got = state.map.get(t.key);
    if (!give || !got) return { ok: false, text: "Pick both currencies first." };
    if (give.key === got.key) return { ok: false, text: "Give and get must be different currencies." };
    if (!(g.qty > 0) || !(t.qty > 0)) return { ok: false, text: "Enter an amount on both sides first." };
    state.trades.push({ id: uid(), ts: new Date().toISOString(), give: { key: give.key, qty: g.qty }, get: { key: got.key, qty: t.qty }, ...entryFor(give, g.qty, got, t.qty), note: "", closed: null });
    saveTrades(); render();
    toast("good", "Added to ledger", `${fmt(g.qty)} ${give.name} for ${fmt(t.qty)} ${got.name}`, { label: "Show ledger", run: () => { if (window.ToolsUI && window.ToolsUI.showPanel) window.ToolsUI.showPanel("ledger"); $("col-ledger").scrollIntoView({ behavior: "smooth", block: "start" }); } });
    return { ok: true, text: "Added to your ledger." };
  }
  window.Ledger = {
    addFromCalc,
    applySettings(settings, values) { state.settings = settings; state.opts = MM.optionsFrom(values); state.items.forEach(i => { delete i._spike; }); render(); }
  };
  boot();
})();
