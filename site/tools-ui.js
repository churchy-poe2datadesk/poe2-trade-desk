"use strict";
// Shared UI bits for the trading tools: the header navigation and the Settings box.
// Settings are saved through the backend when it is there (so the dashboard sees them too),
// or in this browser when the page is hosted as a plain static site.
(function () {
  const MM = window.MarketModel;
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (const kid of kids) e.append(kid);
    return e;
  };

  // The sticky top bar, laid out like the reports' bar: Home on the left, what this page is in the middle
  // (with the softcore / hardcore switch), Settings on the right.
  function mountNav(current) {
    const host = document.getElementById("tools-nav");
    if (!host) return;
    const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
    const left = el("span", { class: "xc-nav-l" });
    if (window.REPORTS_URL) left.append(el("a", { href: window.REPORTS_URL, class: "xc-navlink" }, document.createTextNode("\u2190 Home")));
    if (local) left.append(el("a", { href: "http://127.0.0.1:3212/", class: "xc-navlink" }, document.createTextNode("\u2190 Dashboard")));

    const mode = MM.getMode();
    const pick = el("select", { class: "xc-input xc-modepick", "aria-label": "Softcore or hardcore market" });
    for (const [value, label] of [["sc", "Softcore"], ["hc", "Hardcore"]]) { const o = el("option", { value }, document.createTextNode(label)); if (value === mode) o.selected = true; pick.append(o); }
    const switchTo = m => { MM.setMode(m); const u = new URL(location.href); u.searchParams.delete("mode"); location.href = u.toString(); };
    pick.addEventListener("change", () => switchTo(pick.value));
    const tag = el("button", { type: "button", class: "xc-modetag xc-mode-" + mode, title: "Click to switch to " + (mode === "hc" ? "softcore" : "hardcore") }, document.createTextNode(mode === "hc" ? "HARDCORE" : "SOFTCORE"));
    tag.addEventListener("click", () => switchTo(mode === "hc" ? "sc" : "hc"));
    const league = el("span", { class: "xc-nav-league", id: "xc-nav-league" });
    const mid = el("span", { class: "xc-nav-mid" }, el("strong", {}, document.createTextNode("Trade Desk")), league, pick, tag);

    const gear = el("button", { id: "open-settings", type: "button", class: "xc-btn xc-navbtn" }, document.createTextNode("\u2699 Settings"));
    const right = el("span", { class: "xc-nav-r" });
    // Discord invite: from config.js on the public site; from your Publishing setting when running offline.
    const addDiscord = url => {
      try { const u = new URL(url); if (u.protocol !== "https:" || u.username || u.password) return; right.prepend(el("a", { href: u.href, class: "xc-navlink", rel: "noopener noreferrer", target: "_blank" }, document.createTextNode("Discord"))); } catch { /* not a valid link */ }
    };
    if (window.DISCORD_URL) addDiscord(window.DISCORD_URL);
    if (local) {
      right.prepend(el("span", { class: "xc-off" }, document.createTextNode("Offline version")));
      fetch("/settings", { cache: "no-store" }).then(r => r.json()).then(d => { if (d && d.values && d.values["publish.discordUrl"]) addDiscord(d.values["publish.discordUrl"]); }).catch(() => {});
    }
    right.append(el("a", { href: "https://poe.ninja", class: "xc-navlink xc-credit", rel: "noopener noreferrer", target: "_blank", title: "Market data comes from poe.ninja" }, document.createTextNode("Data: poe.ninja")), gear);
    host.append(left, mid, right);
  }
  // Called once the market data is loaded: shows the league name in the bar ("HC Forbidden Rites" or "forbidden-rites-hc" become "Forbidden Rites").
  function setLeague(name) {
    const node = document.getElementById("xc-nav-league");
    if (!node || !name) return;
    const pretty = String(name).replace(/-/g, " ").replace(/^hc\s+/i, "").replace(/\s+hc$/i, "").replace(/\b[a-z]/g, c => c.toUpperCase());
    node.textContent = ` \u00b7 ${pretty} \u00b7 `;
  }

  // state: { values, source }; onSaved(values) runs after a successful save.
  function openSettings(state, onSaved) {
    const overlay = el("div", { class: "xc-modal", role: "presentation" });
    const card = el("div", { class: "xc-modal-card", role: "dialog", "aria-modal": "true", "aria-label": "Settings" });
    const close = el("button", { class: "xc-modal-x", type: "button", "aria-label": "Close" }, document.createTextNode("×"));
    const body = el("div", { class: "xc-detail on" });
    body.append(el("h4", {}, document.createTextNode("Settings")));
    body.append(el("p", {}, document.createTextNode(state.source === "backend"
      ? "Saved on this computer, and shared with the dashboard."
      : "Saved in this browser only.")));
    const inputs = new Map();
    let group = "";
    for (const s of MM.TOOL_SETTINGS) {
      if (s.group !== group) { group = s.group; body.append(el("h3", { class: "xc-set-group" }, document.createTextNode(group))); }
      const input = el("input", { class: "xc-input xc-small", inputmode: "decimal", value: String(state.values[s.key] ?? s.default), "aria-label": s.label });
      inputs.set(s.key, input);
      const row = el("label", { class: "xc-set-row" }, el("span", {}, document.createTextNode(s.label)), input);
      body.append(row);
      if (s.help) body.append(el("small", { class: "xc-set-help" }, document.createTextNode(s.help)));
    }
    const msg = el("p", { class: "xc-set-msg", "aria-live": "polite" });
    const save = el("button", { type: "button", class: "xc-btn xc-primary" }, document.createTextNode("Save settings"));
    const reset = el("button", { type: "button", class: "xc-btn" }, document.createTextNode("Reset to defaults"));
    body.append(msg, el("div", { class: "xc-actions" }, save, reset));
    card.append(close, body); overlay.append(card); document.body.append(overlay);
    const done = () => overlay.remove();
    close.addEventListener("click", done);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) done(); });
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") done(); });
    close.focus();

    const collect = useDefaults => {
      const values = { ...state.values };
      for (const s of MM.TOOL_SETTINGS) {
        const n = useDefaults ? s.default : Number(String(inputs.get(s.key).value).replace(",", "."));
        if (!Number.isFinite(n) || n < s.min || n > s.max || (s.type === "int" && !Number.isInteger(n))) { msg.textContent = `${s.label}: enter a ${s.type === "int" ? "whole " : ""}number from ${s.min} to ${s.max}.`; return null; }
        values[s.key] = n;
      }
      return values;
    };
    const commit = async values => {
      if (!values) return;
      const result = await MM.saveSettings(values, state.source);
      if (result && result.ok) { state.values = result.values || values; done(); onSaved(state.values); }
      else msg.textContent = "Could not save: " + Object.values((result && result.errors) || { x: "unknown error" }).join(", ");
    };
    save.addEventListener("click", () => commit(collect(false)));
    reset.addEventListener("click", () => commit(collect(true)));
  }

  window.ToolsUI = { mountNav, openSettings, setLeague };
})();
