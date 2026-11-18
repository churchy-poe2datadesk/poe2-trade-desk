"use strict";
// Economy-only poe.ninja capture for the public tools. No dependencies (Node 20+).
//   node scripts/capture.js --out <dir>
// Writes into <dir>: market.json (what the tools load), history.json (price history for the swing statistics),
// state.json (ETags and the latest lines, so a 304 reuses them). Uses only poe.ninja's supported economy overview
// endpoints, sends conditional requests, a descriptive User-Agent, and waits between requests.

const fs = require("node:fs/promises");
const path = require("node:path");
const { weekShape, swingProfile } = require("./lib/exchange-stats");

const CATEGORIES = ["Currency", "Fragments", "Abyss", "UncutGems", "LineageSupportGems", "Essences", "SoulCores", "Idols", "Runes", "Ritual", "Expedition", "Delirium", "Breach", "Verisium"];
const num = v => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

function lineSummary(data) {
  const names = new Map();
  for (const item of Array.isArray(data.items) ? data.items : []) if (item && item.id !== undefined && item.name) names.set(String(item.id), String(item.name));
  return data.lines.filter(l => l && l.id !== undefined).map(l => {
    const spark = l.sparkline || l.sparkLine || null;
    return {
      id: String(l.id), name: names.get(String(l.id)) || String(l.id), v: num(l.primaryValue), a: num(l.volumePrimaryValue),
      s: spark ? { total: num(spark.totalChange), data: Array.isArray(spark.data) ? spark.data.map(num) : [] } : null
    };
  });
}

async function run({ outDir, settings, fetchImpl = fetch, now = () => Date.now(), delayMs = 1500 }) {
  const root = settings.apiRoot, ua = `PoE2-Data-Desk-Public-Tools/1.0 (hourly economy snapshot; contact: ${settings.contact})`;
  const state = await readJson(path.join(outDir, "state.json"), { etags: {}, categories: {} });
  const history = await readJson(path.join(outDir, "history.json"), {});
  const t = now(), failures = [];

  async function get(url, key) {
    const headers = { Accept: "application/json", "User-Agent": ua };
    if (state.etags[key]) headers["If-None-Match"] = state.etags[key];
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etag = res.headers.get("etag");
    if (etag) state.etags[key] = etag;
    return { body: await res.json() };
  }

  const leagues = (await get(`${root}/leagues`, "leagues")).body;
  const league = Array.isArray(leagues) && leagues.find(l => l && l.name === settings.leagueName && l.id);
  if (!league) throw new Error(`poe.ninja does not list the league "${settings.leagueName}".`);

  let fresh = 0;
  for (const category of CATEGORIES) {
    try {
      const url = new URL(`${root}/exchange/current/overview`);
      url.searchParams.set("league", league.id); url.searchParams.set("type", category);
      const key = `cat:${category}`;
      const got = await get(url.toString(), key);
      if (!got.notModified) {
        if (!got.body || !Array.isArray(got.body.lines)) throw new Error("unexpected response");
        state.categories[category] = { at: new Date(t).toISOString(), lines: lineSummary(got.body) };
        fresh++;
      }
    } catch (error) { failures.push(`${category}: ${error.message}`); delete state.etags[`cat:${category}`]; }
    await sleep(delayMs);
  }

  // History: one point per change (price or volume), newest historyDays only.
  const cutoff = Math.floor(t / 1000) - settings.historyDays * 86400;
  for (const category of Object.keys(state.categories)) {
    const at = Math.floor(Date.parse(state.categories[category].at) / 1000);
    for (const line of state.categories[category].lines) {
      if (!(line.v > 0)) continue;
      const key = `${category}:${line.id}`, list = history[key] || (history[key] = []), last = list[list.length - 1];
      if (!last || last[1] !== line.v || last[2] !== line.a) if (!last || last[0] < at) list.push([at, line.v, line.a]);
    }
  }
  for (const key of Object.keys(history)) { history[key] = history[key].filter(p => p[0] >= cutoff); if (!history[key].length) delete history[key]; }

  const items = []; let latest = null;
  for (const category of Object.keys(state.categories)) {
    const snap = state.categories[category];
    if (!latest || snap.at > latest) latest = snap.at;
    for (const line of snap.lines) {
      if (!(line.v > 0)) continue;
      const points = (history[`${category}:${line.id}`] || []).map(p => ({ t: p[0] * 1000, v: p[1] }));
      const spark7 = line.s ? { total: line.s.total, data: line.s.data } : null;
      items.push({ key: `${category}:${line.id}`, name: line.name, category, divine: line.v, activity: Number(line.a) || 0,
        change7: Number.isFinite(spark7 && spark7.total) ? spark7.total : null, ...(weekShape(line.v, spark7) || {}), prof: swingProfile(points, line.v) });
    }
  }
  if (!items.length) throw new Error(`No market data captured (${failures.join("; ") || "nothing returned"}).`);
  if (!items.some(i => i.key === "Currency:divine")) items.push({ key: "Currency:divine", name: "Divine Orb", category: "Currency", divine: 1, activity: 0 });

  await writeJson(path.join(outDir, "market.json"), { ok: true, capturedAt: latest, league: league.name, items });
  await writeJson(path.join(outDir, "history.json"), history);
  await writeJson(path.join(outDir, "state.json"), state);
  return { items: items.length, fresh, failures };
}

module.exports = { run, CATEGORIES };

if (require.main === module) {
  (async () => {
    const out = process.argv[process.argv.indexOf("--out") + 1];
    if (!out || out.startsWith("--")) { console.error("Usage: node scripts/capture.js --out <dir>"); process.exit(2); }
    const settings = JSON.parse(await fs.readFile(path.join(__dirname, "..", "config", "settings.json"), "utf8"));
    const result = await run({ outDir: path.resolve(out), settings });
    console.log(`Captured ${result.items} entries (${result.fresh} categories updated).`);
    if (result.failures.length) console.warn("Some categories failed and kept their previous data:", result.failures.join("; "));
  })().catch(error => { console.error("Capture failed:", error.message); process.exit(1); });
}
