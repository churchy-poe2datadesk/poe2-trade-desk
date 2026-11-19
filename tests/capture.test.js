"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, CATEGORIES, ITEM_CATEGORIES } = require("../scripts/capture");

const settings = { leagueName: "Forbidden Rites", contact: "me@example.com", apiRoot: "https://poe.ninja/poe2/api/economy", historyDays: 30, uniqueItems: false };
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
const calls = [];
let price = 100, etagN = 0, failCategory = null, notModified = false;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const iconCalls = [];
const fakeFetch = async (url, opts) => {
  if (String(url).includes("/gen/image/")) { iconCalls.push(String(url)); return /bad/.test(url) ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => PNG }; }
  calls.push({ url: String(url), headers: opts.headers });
  const json = body => ({ ok: true, status: 200, headers: { get: h => (h.toLowerCase() === "etag" ? `"e${etagN++}"` : null) }, json: async () => body });
  if (String(url).endsWith("/leagues") && notModified && opts.headers["If-None-Match"]) return { ok: false, status: 304, headers: { get: () => null } };
  if (String(url).endsWith("/leagues")) return json([{ id: "L1", name: "Forbidden Rites" }, { id: "L2", name: "Other" }, { id: "L3", name: "HC Forbidden Rites" }]);
  const type = new URL(url).searchParams.get("type");
  if (type === failCategory) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  if (notModified && opts.headers["If-None-Match"]) return { ok: false, status: 304, headers: { get: () => null } };
  const lines = [{ id: `${type}-a`, primaryValue: price, volumePrimaryValue: 50, sparkline: { totalChange: 5, data: [0, 1, 2, 3, 4, 5, 5] } }];
  if (type === "Currency") lines.push({ id: "divine", primaryValue: 1, volumePrimaryValue: 999 });
  return json({ lines, items: lines.map(l => ({ id: l.id, name: `Name ${l.id}`, image: `/gen/image/${l.id}.png` })) });
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

  // Icons: downloaded once, published beside the data, referenced by relative path.
  const icons = fs.readdirSync(path.join(out, "icons"));
  assert.ok(icons.length >= CATEGORIES.length && icons.every(n => /^[a-f0-9]{20}\.png$/.test(n)), "icons saved with safe names");
  assert.ok(market.items.every(i => !i.icon || /^\/icons\/[a-f0-9]{20}\.png$/.test(i.icon)) && market.items.some(i => i.icon), "items point at local icon files");
  assert.ok(iconCalls.every(u => /^https:\/\/(web\.poecdn\.com|poe\.ninja)\//.test(u)), "icons only from allowed hosts");
  const firstIconCalls = iconCalls.length; iconCalls.length = 0;

  // Second run: unchanged price adds no history point; conditional requests are sent; 304 keeps previous data.
  notModified = true; calls.length = 0;
  r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 1), delayMs: 0 });
  assert.equal(iconCalls.length, 0, "known icons are not downloaded again"); assert.ok(firstIconCalls > 0);
  assert.equal(r.fresh, 0, "304 means nothing new");
  assert.ok(calls.some(c => c.headers["If-None-Match"]), "ETag sent back");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "market.json"), "utf8")).items.length, market.items.length, "items kept on 304");
  let hist = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
  assert.equal(hist["Currency:Currency-a"].length, 1, "no duplicate history point");

  // Saved data from an older version (no schema marker, no image addresses) is refetched once, so icons get their source.
  { const st = JSON.parse(fs.readFileSync(path.join(out, "state.json"), "utf8")); delete st.schema;
    for (const c of Object.values(st.categories)) for (const l of c.lines) delete l.i;
    fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(st)); iconCalls.length = 0;
    r = await run({ outDir: out, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 1, 30), delayMs: 0 });
    assert.equal(r.fresh, CATEGORIES.length, "old saved data is refetched once");
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, "state.json"), "utf8")).schema === 2); }

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
  assert.ok(Object.values(hist).every(list => list.length === 1 || list.slice(1).every(p => p[0] >= Math.floor(Date.UTC(2026, 11, 30) / 1000) - 30 * 86400)), "old history pruned (one anchor point may remain)");
  assert.ok(Object.values(hist).every(list => list.length <= 2), "no old points beyond the single anchor");

  // Switching league resets history and saved prices (icons are kept, they are shared artwork).
  {
    const before = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
    assert.ok(Object.keys(before).length > 0);
    price = 7; failCategory = null; notModified = false;
    r = await run({ outDir: out, settings: { ...settings, leagueName: "Other" }, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 11, 31), delayMs: 0 });
    const after = JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8"));
    assert.ok(Object.values(after).every(list => list.length === 1 && list[0][1] !== 120), "history restarted for the new league");
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "market.json"), "utf8")).league, "Other");
    assert.ok(fs.readdirSync(path.join(out, "icons")).length > 0, "icons kept");
  }

  // Missing league is a clear error.
  await assert.rejects(run({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), "pt-")), settings: { ...settings, leagueName: "Nope" }, fetchImpl: fakeFetch, delayMs: 0 }), /does not list the league/);

  // Site files: no local paths or secrets, footer credit present, CSP allows only our own and github.io data.
  const site = fs.readdirSync(path.join(__dirname, "..", "site")).map(f => [f, fs.readFileSync(path.join(__dirname, "..", "site", f), "utf8")]);
  for (const [f, t] of site) assert.ok(!/C:\\|\/home\/|127\.0\.0\.1:3|AIza|webhook/i.test(t.replace(/http:\/\/127\.0\.0\.1:3212\//g, "")), `${f}: no local addresses or secrets`);
  const ex = site.find(([f]) => f === "tradedesk.html")[1];
  assert.ok(/not affiliated with or endorsed by poe\.ninja/.test(ex) && ex.includes("config.js") && ex.includes("connect-src 'self' https://churchy-poe2datadesk.github.io"));
  assert.ok(!site.find(([f]) => f === "market-model.js")[1].includes('"/exchange/currencies"'), "no backend endpoint");
  const read = f => fs.readFileSync(path.join(__dirname, "..", "site", f), "utf8");
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "site", "exchange.html")), "old page name is gone");
  assert.ok(/\/exchange \/tradedesk 301/.test(read("_redirects")), "old address redirects");
  assert.ok(!/["'\/]exchange\?/.test(read("exchange.js") + read("ledger.js")), "links use /tradedesk");
  assert.ok(read("tools-ui.js").includes("REPORTS_URL") && read("config.js").includes("REPORTS_URL"), "Reports link configured");
  // Hardcore: its own files, its own league, softcore untouched.
  {
    const hcOut = fs.mkdtempSync(path.join(os.tmpdir(), "pt-hc-"));
    const sc = await run({ outDir: hcOut, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 0), delayMs: 0 });
    const hc = await run({ outDir: hcOut, settings, fetchImpl: fakeFetch, now: () => Date.UTC(2026, 10, 18, 0), delayMs: 0, mode: "hc" });
    const m = f => JSON.parse(fs.readFileSync(path.join(hcOut, f), "utf8"));
    assert.equal(m("market.json").league, "Forbidden Rites"); assert.equal(m("market-hc.json").league, "HC Forbidden Rites"); assert.equal(m("market-hc.json").mode, "hc");
    assert.ok(fs.existsSync(path.join(hcOut, "history-hc.json")) && fs.existsSync(path.join(hcOut, "state-hc.json")) && hc.items === sc.items);
    await assert.rejects(run({ outDir: hcOut, settings: { ...settings, hardcoreLeagueName: "HC Missing" }, fetchImpl: fakeFetch, delayMs: 0, mode: "hc" }), /does not list the league "HC Missing"/);
  }
  // Unique gear: captured on the first run, then only after 12 hours; no volume, no swing statistics, price-only history.
  {
    const gOut = fs.mkdtempSync(path.join(os.tmpdir(), "pt-gear-")), gSettings = { ...settings, uniqueItems: true };
    let gearPrice = 40, stashCalls = 0;
    const gearFetch = async (url, opts) => {
      if (!String(url).includes("/stash/current/item/overview")) return fakeFetch(url, opts);
      stashCalls++;
      const type = new URL(url).searchParams.get("type");
      const lines = [{ id: 1, name: `Sword of ${type}`, detailsId: `sword-${type}`, icon: "https://web.poecdn.com/gen/image/sword.png", primaryValue: gearPrice, listingCount: 12 + stashCalls, sparkline: { totalChange: 3, data: [0, 1, 2, 3, 3, 3, 3] } },
        { id: 2, name: `Sword of ${type}`, detailsId: `sword-${type}`, primaryValue: 5, listingCount: 1 }]; // a repeated id is ignored
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ lines }) };
    };
    const at = h => () => Date.UTC(2026, 10, 18, h);
    await run({ outDir: gOut, settings: gSettings, fetchImpl: gearFetch, now: at(0), delayMs: 0 });
    assert.equal(stashCalls, ITEM_CATEGORIES.length, "every gear category fetched on the first run");
    let gm = JSON.parse(fs.readFileSync(path.join(gOut, "market.json"), "utf8"));
    const sword = gm.items.find(i => i.key === "UniqueWeapons:sword-UniqueWeapons");
    assert.ok(sword && sword.kind === "unique" && sword.activity === 0 && sword.listings > 0 && sword.divine === 40 && sword.prof === null, "gear: no volume, listings kept apart, no swing profile");
    assert.equal(gm.items.filter(i => i.key === "UniqueWeapons:sword-UniqueWeapons").length, 1, "repeated gear id kept once");
    assert.ok(gm.items.some(i => i.key === "Currency:divine" && !i.kind), "currency is not marked as gear");
    stashCalls = 0; gearPrice = 50;
    await run({ outDir: gOut, settings: gSettings, fetchImpl: gearFetch, now: at(6), delayMs: 0 });
    assert.equal(stashCalls, 0, "gear is not fetched again within 12 hours");
    await run({ outDir: gOut, settings: gSettings, fetchImpl: gearFetch, now: at(12), delayMs: 0 });
    assert.equal(stashCalls, ITEM_CATEGORIES.length, "gear fetched again after 12 hours");
    const gh = JSON.parse(fs.readFileSync(path.join(gOut, "history.json"), "utf8"));
    assert.equal(gh["UniqueWeapons:sword-UniqueWeapons"].length, 2, "gear history grows only when the price changes");
    stashCalls = 0; await run({ outDir: gOut, settings: { ...gSettings, uniqueItems: false }, fetchImpl: gearFetch, now: at(30), delayMs: 0 });
    assert.equal(stashCalls, 0, "gear capture can be switched off");
  }
  console.log("public-tools capture: all checks passed");
})().catch(e => { console.error(e); process.exit(1); });
