"use strict";
// Copies the Trade Desk (calculator + ledger) from the Data Desk app into site/ and adapts it for static hosting:
// prices come from the hourly data file instead of a local backend, and wording that mentions the backend is removed.
//   node scripts/sync-tools.js "<path to PoE2 Data Desk>/app/dashboard"
const fs = require("node:fs");
const path = require("node:path");

const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, "exchange.js"))) { console.error('Usage: node scripts/sync-tools.js "<...>/app/dashboard"'); process.exit(2); }
const out = path.join(__dirname, "..", "site");
fs.mkdirSync(out, { recursive: true });

function patch(text, file, pairs) {
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: expected text not found: ${String(from).slice(0, 60)}`);
    text = text.split(from).join(to);
  }
  return text;
}
const read = f => fs.readFileSync(path.join(src, f), "utf8");
const write = (f, t) => fs.writeFileSync(path.join(out, f), t);

write("market-model.js", patch(read("market-model.js"), "market-model.js", [
  ['for (const url of ["/exchange/currencies", "market.json"]) {', 'for (const url of [window.MARKET_URL || "market.json"]) {'],
  ['const r = await fetch("/settings", { cache: "no-store" });', 'const r = await Promise.reject(new Error("static site"));']
]));
for (const f of ["exchange.js", "ledger.js"]) {
  write(f, patch(read(f), f, [
    ["your latest poe.ninja capture", "the latest poe.ninja capture"],
    ["Is the Data Desk backend running?", "Please try again in a few minutes."],
    ["(local backend only; it never contacts poe.ninja)", "(this page only reads the published data file; it never contacts poe.ninja)"]
  ]).split("/exchange?").join("/tradedesk?").split("a[href^='/exchange?']").join("a[href^='/tradedesk?']"));
}
write("tools-ui.js", patch(read("tools-ui.js"), "tools-ui.js", [
  ['const links = [["/exchange", "Trade Desk", "exchange"]];', 'const links = [["/tradedesk", "Trade Desk", "exchange"]];'],
  ['if (location.protocol === "file:") a.setAttribute("href", "exchange.html");', 'if (location.protocol === "file:") a.setAttribute("href", "tradedesk.html");'],
  ['const gear = el("button"', 'if (window.REPORTS_URL) host.prepend(el("a", { href: window.REPORTS_URL, class: "xc-navlink" }, document.createTextNode("\u2190 Reports")));\n    const gear = el("button"']
]));
write("exchange.css", read("exchange.css") + "\n.pt-footer{margin:32px 0 8px;padding-top:14px;border-top:1px solid #3a3d42;color:#9a9ca1;font:12px/1.5 Arial,sans-serif}.pt-footer a{color:#c8a66d}\n");
write("ledger.css", read("ledger.css"));

let html = read("exchange.html");
html = html.replace('<script src="/market-model.js"></script>', '<script src="/config.js"></script>\n<script src="/market-model.js"></script>');
// Only the exact site that serves the data file may be contacted (read from config.js).
const dataOrigin = (() => { const m = /MARKET_URL\s*=\s*"(https:\/\/[^\/"]+)/.exec(fs.readFileSync(path.join(out, "config.js"), "utf8")); if (!m) throw new Error("config.js: MARKET_URL must be an https address"); return m[1]; })();
html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: ${dataOrigin}; connect-src 'self' ${dataOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'">`);
html = html.replace("</main>", `  <footer class="pt-footer"><p>Prices come from <a href="https://poe.ninja" target="_blank" rel="noopener noreferrer">poe.ninja</a> (economy overview data, refreshed hourly). This site is not affiliated with or endorsed by poe.ninja or Grinding Gear Games. Estimates only; not financial advice. Your ledger is saved in this browser only.</p></footer>\n</main>`);
if (!html.includes("pt-footer")) throw new Error("exchange.html: no </main> to add the footer before");
write("tradedesk.html", html);
// Old address and the ledger shortcut both lead to the Trade Desk.
fs.writeFileSync(path.join(out, "_redirects"), "/exchange /tradedesk 301\n/exchange.html /tradedesk 301\n/ledger /tradedesk 301\n");
fs.writeFileSync(path.join(out, "ledger.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/tradedesk"><title>Trade Desk</title></head><body><a href="/tradedesk">Trade Desk: calculator and ledger</a></body></html>\n');
console.log("Tools synced into site/.");
