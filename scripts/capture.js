"use strict";
// Economy-only poe.ninja capture for the public tools. No dependencies (Node 20+).
//   node scripts/capture.js --out <dir>
// Writes into <dir>: market.json (what the tools load), history.json (price history for the swing statistics),
// state.json (ETags and the latest lines, so a 304 reuses them). Uses only poe.ninja's supported economy overview
// endpoints, sends conditional requests, a descriptive User-Agent, and waits between requests.

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
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
  const names = new Map(), images = new Map();
  for (const item of Array.isArray(data.items) ? data.items : []) {
    if (item && item.id !== undefined && item.name) names.set(String(item.id), String(item.name));
    if (item && item.id !== undefined && typeof item.image === "string") images.set(String(item.id), item.image);
  }
  return data.lines.filter(l => l && l.id !== undefined).map(l => {
    const spark = l.sparkline || l.sparkLine || null;
    return {
      id: String(l.id), name: names.get(String(l.id)) || String(l.id), i: images.get(String(l.id)) || null, v: num(l.primaryValue), a: num(l.volumePrimaryValue),
      s: spark ? { total: num(spark.totalChange), data: Array.isArray(spark.data) ? spark.data.map(num) : [] } : null
    };
  });
}


// ---------- icons ----------
// Each icon is downloaded once (a few new ones per run at most), from the same hosts poe.ninja uses, and published
// beside the data so visitors load them from our own address, never from poe.ninja or Grinding Gear Games.
const ICON_HOSTS = ["https://web.poecdn.com", "https://poe.ninja"];
const MAX_JSON_BYTES = 40 * 1024 * 1024, MAX_ICON_BYTES = 250 * 1024, MAX_NEW_ICONS = 120, RETRY_FAILED_MS = 6 * 3600 * 1000;
const iconUrls = src => {
  if (typeof src !== "string" || !src) return [];
  if (src.startsWith("/gen/image/")) return ICON_HOSTS.map(h => h + src);
  try { const u = new URL(src); return u.protocol === "https:" && ICON_HOSTS.some(h => new URL(h).hostname === u.hostname) ? [u.href] : []; } catch { return []; }
};
const iconId = src => crypto.createHash("sha1").update(src).digest("hex").slice(0, 20);
function iconKind(b) {
  if (b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "png";
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "jpg";
  return null;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function syncIcons({ outDir, state, fetchImpl, t, delayMs, ua }) {
  const dir = path.join(outDir, "icons"); await fs.mkdir(dir, { recursive: true });
  const known = new Map(); // src -> file name
  for (const name of await fs.readdir(dir)) { const m = name.match(/^([a-f0-9]{20})\.(png|webp|jpg)$/); if (m) known.set(m[1], name); }
  state.iconFail = state.iconFail || {};
  const wanted = new Set();
  for (const snap of Object.values(state.categories)) for (const line of snap.lines) if (line.i && iconUrls(line.i).length) wanted.add(line.i);
  let fetched = 0;
  for (const src of wanted) {
    const id = iconId(src);
    if (known.has(id) || fetched >= MAX_NEW_ICONS) continue;
    if (state.iconFail[id] && t - state.iconFail[id] < RETRY_FAILED_MS) continue;
    let saved = false;
    for (const url of iconUrls(src)) {
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(8000), redirect: "error" });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer()), kind = iconKind(buf);
        if (!kind || !buf.length || buf.length > MAX_ICON_BYTES) continue;
        const name = `${id}.${kind}`; await fs.writeFile(path.join(dir, name), buf); known.set(id, name); saved = true; break;
      } catch { /* try the next host */ }
    }
    if (!saved) state.iconFail[id] = t; else delete state.iconFail[id];
    fetched++;
    await sleep(delayMs);
  }
  return known; // id -> file name
}

// mode "sc" (softcore, market.json) or "hc" (hardcore, market-hc.json): the same capture into its own files.
async function run({ outDir, settings, fetchImpl = fetch, now = () => Date.now(), delayMs = 1500, mode = "sc" }) {
  const sfx = mode === "hc" ? "-hc" : "";
  const wanted = mode === "hc" ? (settings.hardcoreLeagueName || `HC ${settings.leagueName}`) : settings.leagueName;
  const root = settings.apiRoot, ua = `PoE2-Data-Desk-Public-Tools/1.0 (hourly economy snapshot; contact: ${settings.contact})`;
  const state = await readJson(path.join(outDir, `state${sfx}.json`), { etags: {}, categories: {} });
  // Saved data from an older version lacks fields this version needs (icons): forget the ETags once so every category is fetched again.
  if (state.schema !== 2) { state.etags = {}; state.schema = 2; }
  const history = await readJson(path.join(outDir, `history${sfx}.json`), {});
  const t = now(), failures = [];

  async function get(url, key) {
    const headers = { Accept: "application/json", "User-Agent": ua };
    if (state.etags[key]) headers["If-None-Match"] = state.etags[key];
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etag = res.headers.get("etag");
    if (etag) state.etags[key] = etag;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_JSON_BYTES) throw new Error("response too large");
    if (typeof res.text !== "function") return { body: await res.json() };
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new Error("response too large");
    return { body: JSON.parse(text) };
  }

  // The league list is conditional too: on a 304 reuse the league found last time.
  const got = await get(`${root}/leagues`, "leagues");
  let league = null;
  if (got.notModified) league = state.league && state.league.name === wanted ? state.league : null;
  else league = (Array.isArray(got.body) && got.body.find(l => l && l.name === wanted && l.id)) || null;
  if (!league && got.notModified) { // the saved league does not match: ask again without the ETag
    delete state.etags.leagues;
    const again = await get(`${root}/leagues`, "leagues");
    league = (Array.isArray(again.body) && again.body.find(l => l && l.name === wanted && l.id)) || null;
  }
  if (!league) throw new Error(`poe.ninja does not list the league "${wanted}".`);
  // A new league starts clean: another league's prices must never feed this league's history or statistics.
  if (state.league && state.league.name !== league.name) {
    state.categories = {}; state.etags = { leagues: state.etags.leagues }; state.iconFail = {};
    for (const key of Object.keys(history)) delete history[key];
    console.log(`League changed from ${state.league.name} to ${league.name}: history and saved prices reset.`);
  }
  state.league = { id: league.id, name: league.name };

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
  // Keep one point from before the cutoff: it is the price at the start of the window (still valid until the next change).
  // Items no longer listed are pruned strictly.
  const listed = new Set();
  for (const category of Object.keys(state.categories)) for (const line of state.categories[category].lines) listed.add(`${category}:${line.id}`);
  for (const key of Object.keys(history)) {
    const list = history[key], firstIn = list.findIndex(p => p[0] >= cutoff);
    history[key] = firstIn === -1 ? (listed.has(key) ? list.slice(-1) : []) : list.slice(Math.max(0, firstIn - 1));
    if (!history[key].length) delete history[key];
  }


  let iconFiles = new Map();
  try { iconFiles = await syncIcons({ outDir, state, fetchImpl, t, delayMs, ua }); } catch (error) { failures.push(`icons: ${error.message}`); }

  const items = []; let latest = null;
  for (const category of Object.keys(state.categories)) {
    const snap = state.categories[category];
    if (!latest || snap.at > latest) latest = snap.at;
    for (const line of snap.lines) {
      if (!(line.v > 0)) continue;
      const points = (history[`${category}:${line.id}`] || []).map(p => ({ t: p[0] * 1000, v: p[1] }));
      const spark7 = line.s ? { total: line.s.total, data: line.s.data } : null;
      const iconFile = line.i && iconFiles.get(iconId(line.i));
      items.push({ key: `${category}:${line.id}`, name: line.name, category, ...(iconFile ? { icon: `/icons/${iconFile}` } : {}), divine: line.v, activity: Number(line.a) || 0,
        change7: Number.isFinite(spark7 && spark7.total) ? spark7.total : null, ...(weekShape(line.v, spark7) || {}), prof: swingProfile(points, line.v) });
    }
  }
  if (!items.length) throw new Error(`No market data captured (${failures.join("; ") || "nothing returned"}).`);
  if (!items.some(i => i.key === "Currency:divine")) items.push({ key: "Currency:divine", name: "Divine Orb", category: "Currency", divine: 1, activity: 0 });

  await writeJson(path.join(outDir, `market${sfx}.json`), { ok: true, capturedAt: latest, league: league.name, mode, items });
  await writeJson(path.join(outDir, `history${sfx}.json`), history);
  await writeJson(path.join(outDir, `state${sfx}.json`), state);
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
    // Hardcore is a second, separate capture. A problem here never fails the softcore data above.
    if (settings.hardcore !== false) {
      try {
        const hc = await run({ outDir: path.resolve(out), settings, mode: "hc" });
        console.log(`Hardcore: captured ${hc.items} entries (${hc.fresh} categories updated).`);
        if (hc.failures.length) console.warn("Hardcore: some categories failed and kept their previous data:", hc.failures.join("; "));
      } catch (error) { console.warn("Hardcore capture skipped:", error.message); }
    }
  })().catch(error => { console.error("Capture failed:", error.message); process.exit(1); });
}
