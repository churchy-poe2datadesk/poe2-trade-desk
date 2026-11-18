"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, CATEGORIES } = require("../scripts/capture");

const settings = { leagueName: "Forbidden Rites", contact: "me@example.com", apiRoot: "https://poe.ninja/poe2/api/economy", historyDays: 30 };
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
const calls = [];
let price = 100, etagN = 0, failCategory = null, notModified = false;

const fakeFetch = async (url, opts) => {
  calls.push({ url: String(url), headers: opts.headers });
  const json = body => ({ ok: true, status: 200, headers: { get: h => (h.toLowerCase() === "etag" ? `"e${etagN++}"` : null) }, json: async () => body });
  if (String(url).endsWith("/leagues")) return json([{ id: "L1", name: "Forbidden Rites" }, { id: "L2", name: "Other" }]);
  const type = new URL(url).searchParams.get("type");
  if (type === failCategory) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  if (notModified && opts.headers["If-None-Match"]) return { ok: false, status: 304, headers: { get: () => null } };
  const lines = [{ id: `${type}-a`, primaryValue: price, volumePrimaryValue: 50, sparkline: { totalChange: 5, data: [0, 1, 2, 3, 4, 5, 5] } }];
  if (type === "Currency") lines.push({ id: "divine", primaryValue: 1, volumePrimaryValue: 999 });
  return json({ lines, items: lines.map(l => ({ id: l.id, name: `Name ${l.id}` })) });
};

(async () => {
  let r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 0), delayMs: 0 });
  const market = JSON.parse(fs.readFileSync(path.join(out, "market.json"), "utf8"));
  assert.equal(market.ok, true); assert.equal(market.league, "Forbidden Rites");
  assert.equal(r.fresh, CATEGORIES.length, "every category fetched");
  assert.ok(market.items.some(i => i.key === "Currency:divine" && i.divine === 1), "divine present");
  assert.ok(market.items.every(i => i.divine > 0 && typeof i.name === "string" && i.key.includes(":")), "item shape");
  assert.ok(calls.every(c => /poe\.ninja\/poe2\/api\/economy\/(leagues|exchange\/current\/overview)/.test(c.url)), "only supported economy endpoints");
  assert.ok(calls.every(c => /contact: me@example\.com/.test(c.headers["User-Agent"])), "descriptive User-Agent with contact");
  assert.ok(!calls.some(c => /stash|item\/overview|build/i.test(c.url)), "no items or builds endpoints");
  const text = fs.readFileSync(path.join(out, "market.json"), "utf8") + fs.readFileSync(path.join(out, "history.json"), "utf8");
  assert.ok(!/me@example\.com|token|secret|AIza/i.test(text), "no secrets in published data");

  // Second run: unchanged price adds no history point; conditional requests are sent; 304 keeps previous data.
  notModified = true; calls.length = 0;
  r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 1), delayMs: 0 });
  assert.equal(r.fresh, 0, "304 means nothing new");
  assert.ok(calls.some(c => c.headers["If-None-Match"]), "ETag sent back");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "market.json"), "utf8")).items.length, market.items.length, "items kept on 304");
  let hist = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
  assert.equal(hist["Currency:Currency-a"].length, 1, "no duplicate history point");

  // Third run: price changes, one category fails and keeps its old data; a point is added.
  notModified = false; price = 120; failCategory = "Fragments"; calls.length = 0;
  r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 2), delayMs: 0 });
  assert.equal(r.failures.length, 1); assert.match(r.failures[0], /^Fragments:/);
  hist = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
  assert.equal(hist["Currency:Currency-a"].length, 2, "price change recorded");
  assert.equal(hist["Fragments:Fragments-a"].length, 1, "failed category keeps old history");
  const m3 = JSON.parse(fs.readFileSync(path.join(out, "market.json"), "utf8"));
  assert.ok(m3.items.some(i => i.key === "Fragments:Fragments-a" && i.divine === 100), "failed category keeps previous price");

  // History older than the window is dropped.
  r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 11, 30), delayMs: 0 });
  hist = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
  assert.ok(Object.values(hist).every(list => list.every(p => p[0] >= Math.floor(Date.UTC(2026, 11, 30) / 1000) - 30 * 86400)), "old history pruned");

  // Missing league is a clear error.
  await assert.rejects(run({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), "pt-")), settings: { ...settings, leagueName: "Nope" }, fetchImpl: fakeFetch, delayMs: 0 }), /does not list the league/);

  // Site files: no local paths or secrets, footer credit present, CSP allows only our own and github.io data.
  const site = fs.readdirSync(path.join(__dirname, "..", "site")).map(f => [f, fs.readFileSync(path.join(__dirname, "..", "site", f), "utf8")]);
  for (const [f, t] of site) assert.ok(!/C:\\|\/home\/|127\.0\.0\.1:3|AIza|webhook/i.test(t.replace(/http:\/\/127\.0\.0\.1:3212\//g, "")), `${f}: no local addresses or secrets`);
  const ex = site.find(([f]) => f === "exchange.html")[1];
  assert.ok(/not affiliated with or endorsed by poe\.ninja/.test(ex) && ex.includes("config.js") && ex.includes("connect-src 'self' https://*.github.io"));
  assert.ok(!site.find(([f]) => f === "market-model.js")[1].includes('"/exchange/currencies"'), "no backend endpoint");
  console.log("public-tools capture: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
