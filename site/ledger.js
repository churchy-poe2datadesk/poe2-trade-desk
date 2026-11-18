"use strict";
// Trade Ledger: log in-game trades, value them at today's poe.ninja price, suggest swaps, raise alerts.
// Trades live in this browser (localStorage) so the page also works as a hosted static site.
(function () {
  const MM = window.MarketModel;
  const $ = id => document.getElementById(id);
  const STORE = "poe2dd.ledger.v1", SEEN = "poe2dd.ledger.seen";
  const state = { items: [], map: new Map(), opts: MM.DEFAULT_OPTIONS, settings: null, trades: [], capturedAt: null, source: "live" };

  // ---------- small helpers ----------
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (const kid of kids) e.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
    return e;
  };
  const num = v => { const n = Number(String(v).trim().replace(/,/g, ".")); return Number.isFinite(n) ? n : NaN; };
  const fmt = v => { const n = Number(v); if (!Number.isFinite(n)) return "-"; return n >= 100 ? n.toFixed(1).replace(/\.0$/, "") : Number(n.toPrecision(4)).toString(); };
  const pct = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const when = iso => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const tone = v => (v >= 0 ? "lg-pos" : "lg-neg");

  function loadTrades() {
    try {
      const j = JSON.parse(localStorage.getItem(STORE) || "{}");
      return Array.isArray(j.trades) ? j.trades.filter(validTrade) : [];
    } catch { return []; }
  }
  function saveTrades() { try { localStorage.setItem(STORE, JSON.stringify({ version: 1, trades: state.trades })); } catch { /* storage blocked: kept in memory only */ } }
  function validTrade(t) {
    return t && typeof t.id === "string" && t.give && t.get && typeof t.give.key === "string" && typeof t.get.key === "string"
      && t.give.qty > 0 && t.get.qty > 0 && Number.isFinite(Date.parse(t.ts));
  }

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
    state.trades.push({ id: uid(), ts, give: { key: give.key, qty: gq }, get: { key: got.key, qty: tq }, note: $("trade-note").value.trim().slice(0, 120), closed: null });
    saveTrades(); msg.textContent = "";
    for (const id of ["give-name", "give-qty", "get-name", "get-qty", "trade-ratio", "trade-note"]) $(id).value = "";
    setNow(); render(); updateHint();
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

  function positionCard(trade) {
    const { pos, options, basis } = MM.swapOptions(trade, state.map, state.items, state.opts, 3);
    const A = state.map.get(trade.give.key), B = state.map.get(trade.get.key);
    const card = el("article", { class: "lg-pcard" });
    card.append(el("h3", {}, `${fmt(trade.get.qty)} ${nameOf(trade.get.key)}`));
    card.append(el("p", { class: "lg-meta" }, `Paid ${fmt(trade.give.qty)} ${nameOf(trade.give.key)} on ${when(trade.ts)} · ratio ${fmt(trade.get.qty / trade.give.qty)} per 1${trade.note ? ` · “${trade.note}”` : ""}`));
    if (!pos) {
      card.append(el("p", { class: "lg-empty" }, `${!A ? nameOf(trade.give.key) : nameOf(trade.get.key)} is not in the latest poe.ninja capture, so this position cannot be valued right now.`));
    } else {
      const chips = el("div", { class: "lg-chips" });
      const prem = pos.premiumB;
      if (prem !== null) chips.append(el("span", { class: `lg-chip ${prem >= 1 + state.opts.sellWindowPct / 100 ? "good" : prem <= 0.9 ? "warn" : ""}` }, `${nameOf(trade.get.key)} is ${Math.abs((prem - 1) * 100).toFixed(0)}% ${prem >= 1 ? "above" : "below"} its usual price`));
      if (pos.plPct <= -state.opts.badLossPct) chips.append(el("span", { class: "lg-chip bad" }, "Down on your cost"));
      const sp = MM.spikeOf(pos.B, state.opts.spikePct).now; if (sp) chips.append(el("span", { class: "lg-chip warn" }, sp > 0 ? "Price spike right now" : "Price dip right now"));
      card.append(chips);
      const stat = (label, value, cls) => el("div", {}, el("span", {}, label), el("strong", { class: cls || "" }, value));
      card.append(el("div", { class: "lg-grid" },
        stat("Worth now", `${fmt(pos.nowInA)} ${nameOf(trade.give.key)}`),
        stat("Profit (mid price)", pct(pos.plPct), tone(pos.plPct)),
        stat(`Profit after ${state.opts.exchangeSpreadPct}% spread`, pct(pos.plNetPct), tone(pos.plNetPct)),
        stat("Market ratio now", `${fmt(pos.marketRatio)} per 1`)));
      card.append(el("div", { class: "lg-h" }, "Top 3 swaps"));
      const ul = el("ul", { class: "lg-swaps" });
      if (!options.length) ul.append(el("li", { class: "lg-empty" }, basis && !(basis.F > 0) ? `There is no reliable usual price for ${nameOf(trade.get.key)} yet (${basis.trending ? "its price has been trending" : "not enough history"}), so swap ideas are held back until there is.` : "No swap looks profitable right now once trading costs are paid. Holding, or selling at a better time, may be wiser."));
      for (const o of options) {
        ul.append(el("li", { class: "lg-swap" },
          el("span", {}, el("b", {}, `${nameOf(o.C.key)}`), ` · you'd receive about ${fmt(o.receive)}`,
            el("small", {}, `Expected ${pct(o.net)} after spread (${pct(o.totalPct)} vs your original cost) · confidence ${o.confidence}${o.caution ? ` · note: ${o.caution}` : ""}`)),
          el("a", { href: calcLink(pos.B, o.C) }, "Open in calculator")));
      }
      card.append(ul);
    }
    const close = el("button", { type: "button", class: "xc-btn" }, "Close position…"), del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
    close.addEventListener("click", () => closePosition(trade, pos));
    del.addEventListener("click", () => confirmBox("Delete this trade?", "This removes it from your ledger. It cannot be undone.", "Delete", () => { state.trades = state.trades.filter(t => t.id !== trade.id); saveTrades(); render(); }));
    card.append(el("div", { class: "lg-btns" }, close, del));
    return card;
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

  function renderSummary() {
    const open = state.trades.filter(t => !t.closed);
    let cost = 0, value = 0, realisedCost = 0, realisedBack = 0;
    for (const t of open) { const p = MM.valuePosition(t, state.map, state.opts); if (p) { cost += p.costDivine; value += p.nowDivine; } }
    for (const t of state.trades.filter(t => t.closed)) { const A = state.map.get(t.give.key); if (A) { realisedCost += t.give.qty * A.divine; realisedBack += t.closed.qty * A.divine; } }
    const open$ = cost > 0 ? (value / cost - 1) * 100 : null, real$ = realisedCost > 0 ? (realisedBack / realisedCost - 1) * 100 : null;
    const box = $("lg-summary"); box.textContent = "";
    const stat = (label, value, cls) => el("div", { class: "lg-stat" }, el("span", {}, label), el("strong", { class: cls || "" }, value));
    box.append(stat("Open positions", String(open.length)),
      stat("Cost (Divine)", cost ? fmt(cost) : "-"),
      stat("Worth now (Divine)", value ? fmt(value) : "-"),
      stat("Open profit", open$ === null ? "-" : pct(open$), open$ === null ? "" : tone(open$)));
    if (real$ !== null) box.append(stat("Closed profit", pct(real$), tone(real$)));
  }

  function renderClosed() {
    const host = $("closed"); host.textContent = "";
    const list = state.trades.filter(t => t.closed).sort((a, b) => Date.parse(b.closed.ts) - Date.parse(a.closed.ts));
    if (!list.length) { host.append(el("p", { class: "lg-empty" }, "Nothing closed yet.")); return; }
    for (const t of list) {
      const real = (t.closed.qty / t.give.qty - 1) * 100;
      const del = el("button", { type: "button", class: "xc-btn lg-danger" }, "Delete");
      del.addEventListener("click", () => confirmBox("Delete this closed trade?", "It cannot be undone.", "Delete", () => { state.trades = state.trades.filter(x => x.id !== t.id); saveTrades(); render(); }));
      host.append(el("article", { class: "lg-pcard" },
        el("h3", {}, `${fmt(t.get.qty)} ${nameOf(t.get.key)} → ${fmt(t.closed.qty)} ${nameOf(t.give.key)}`),
        el("p", { class: "lg-meta" }, `Opened ${when(t.ts)} · closed ${when(t.closed.ts)} · paid ${fmt(t.give.qty)} ${nameOf(t.give.key)}`),
        el("div", { class: "lg-grid" }, el("div", {}, el("span", {}, "Result"), el("strong", { class: tone(real) }, pct(real)))),
        el("div", { class: "lg-btns" }, del)));
    }
  }

  let alerts = [];
  function renderAlerts() {
    alerts = MM.alertsFor(state.trades, state.map, state.items, state.opts);
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
    for (const t of open) host.append(positionCard(t));
    renderSummary(); renderClosed(); renderAlerts();
  }

  // ---------- data tools ----------
  function exportData() {
    const blob = new Blob([JSON.stringify({ app: "poe2-data-desk-ledger", version: 1, exportedAt: new Date().toISOString(), trades: state.trades }, null, 2)], { type: "application/json" });
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
        note: typeof t.note === "string" ? t.note.slice(0, 120) : "",
        closed: t.closed && t.closed.qty > 0 && Number.isFinite(Date.parse(t.closed.ts)) ? { qty: Number(t.closed.qty), ts: new Date(t.closed.ts).toISOString() } : null
      }));
      const have = new Set(state.trades.map(t => t.id));
      const added = incoming.filter(t => !have.has(t.id));
      state.trades.push(...added); saveTrades(); render();
      msg.textContent = `Imported ${added.length} trade${added.length === 1 ? "" : "s"}${incoming.length - added.length ? ` (${incoming.length - added.length} already there)` : ""}.`;
    });
  }

  // ---------- start ----------
  async function boot() {
    setNow();
    state.trades = loadTrades();
    try {
      const data = await MM.loadMarket();
      state.settings = await MM.loadSettings();
      state.opts = MM.optionsFrom(state.settings.values);
      state.items = data.items; state.map = MM.byKey(state.items); state.capturedAt = data.capturedAt;
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
      state.items = data.items; state.map = MM.byKey(state.items); state.capturedAt = data.capturedAt;
      const stamp = data.capturedAt ? new Date(data.capturedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "unknown time";
      $("lg-meta").textContent = `Prices from ${data.source === "snapshot" ? "a saved poe.ninja snapshot" : "the latest poe.ninja capture"} (${stamp}). Estimates only. Refreshes itself.`;
      render();
    } catch { /* keep showing the last good data */ }
  }
  setInterval(refreshQuietly, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuietly(); });

  $("trade-form").addEventListener("submit", onSubmit);
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
  $("clear-closed").addEventListener("click", () => confirmBox("Clear closed positions?", "All closed trades are removed. Open positions stay.", "Clear closed", () => { state.trades = state.trades.filter(t => !t.closed); saveTrades(); render(); }));
  $("clear-all").addEventListener("click", () => confirmBox("Clear the whole ledger?", "Every open and closed trade is removed from this browser. Export a backup first if you might want them.", "Clear everything", () => { state.trades = []; saveTrades(); try { localStorage.removeItem(SEEN); } catch { /* ignore */ } render(); }));
  // The calculator beside the ledger drives Settings and the "Add to ledger" button.
  function addFromCalc(g, t) {
    const give = state.map.get(g.key), got = state.map.get(t.key);
    if (!give || !got) return { ok: false, text: "Pick both currencies first." };
    if (give.key === got.key) return { ok: false, text: "Give and get must be different currencies." };
    if (!(g.qty > 0) || !(t.qty > 0)) return { ok: false, text: "Enter an amount on both sides first." };
    state.trades.push({ id: uid(), ts: new Date().toISOString(), give: { key: give.key, qty: g.qty }, get: { key: got.key, qty: t.qty }, note: "", closed: null });
    saveTrades(); render();
    toast("good", "Added to ledger", `${fmt(g.qty)} ${give.name} for ${fmt(t.qty)} ${got.name}`, { label: "Show ledger", run: () => { $("col-ledger").scrollIntoView({ behavior: "smooth", block: "start" }); } });
    return { ok: true, text: "Added to your ledger." };
  }
  window.Ledger = {
    addFromCalc,
    applySettings(settings, values) { state.settings = settings; state.opts = MM.optionsFrom(values); state.items.forEach(i => { delete i._spike; }); render(); }
  };
  boot();
})();
