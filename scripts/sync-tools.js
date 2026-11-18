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
  ]));
}
write("tools-ui.js", read("tools-ui.js"));
write("exchange.css", read("exchange.css") + "\n.pt-footer{margin:32px 0 8px;padding-top:14px;border-top:1px solid #3a3d42;color:#9a9ca1;font:12px/1.5 Arial,sans-serif}.pt-footer a{color:#c8a66d}\n");
write("ledger.css", read("ledger.css"));

let html = read("exchange.html");
html = html.replace('<script src="/market-model.js"></script>', '<script src="/config.js"></script>\n<script src="/market-model.js"></script>');
html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.github.io; base-uri 'none'; form-action 'none'; object-src 'none'">`);
html = html.replace("</main>", `  <footer class="pt-footer"><p>Prices come from <a href="https://poe.ninja" target="_blank" rel="noopener noreferrer">poe.ninja</a> (economy overview data, refreshed hourly). This site is not affiliated with or endorsed by poe.ninja or Grinding Gear Games. Estimates only; not financial advice. Your ledger is saved in this browser only.</p></footer>\n</main>`);
if (!html.includes("pt-footer")) throw new Error("exchange.html: no </main> to add the footer before");
write("exchange.html", html);
console.log("Tools synced into site/.");
