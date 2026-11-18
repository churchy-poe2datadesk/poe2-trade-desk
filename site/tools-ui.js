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

  function mountNav(current) {
    const host = document.getElementById("tools-nav");
    if (!host) return;
    const links = [["/tradedesk", "Trade Desk", "exchange"]];
    for (const [href, label, id] of links) {
      const a = el("a", { href, class: "xc-navlink" + (id === current ? " on" : "") }, document.createTextNode(label));
      if (location.protocol === "file:") a.setAttribute("href", "tradedesk.html");
      host.append(a);
    }
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) host.append(el("a", { href: "http://127.0.0.1:3212/", class: "xc-navlink" }, document.createTextNode("Dashboard")));
    if (window.REPORTS_URL) host.prepend(el("a", { href: window.REPORTS_URL, class: "xc-navlink" }, document.createTextNode("← Reports")));
    const gear = el("button", { id: "open-settings", type: "button", class: "xc-btn xc-navbtn" }, document.createTextNode("⚙ Settings"));
    host.append(gear);
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

  window.ToolsUI = { mountNav, openSettings };
})();
