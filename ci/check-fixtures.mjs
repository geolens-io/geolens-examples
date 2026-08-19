// Preflight for the demo fixtures every example in this repo hardcodes.
//
// The dataset UUIDs, the qualified table name and the shared-map token here
// belong to the public demo's catalog, and a demo reset can change all of
// them. When that happens the browser sweep goes red on every dependent
// example at once, each one saying "no successful demo response matched
// required URL ..." — true, and no help: nothing in that output separates a
// catalog that moved from nine examples that broke on the same afternoon.
//
// So this runs first and answers exactly that question. It asserts the
// invariants ci/fixtures.json names — the collection is still there, still
// titled what the examples say, still carries the geometry they draw, its
// tiles still come back as tiles, the saved map still has the layers the embed
// page describes — and when one stops holding it says which fixture, what it
// means, and what to grep for.
//
// A demo that cannot answer at all is reported as the demo being down and
// explicitly not as a fact about this repo. Those two conditions need
// different people to do different things, and the audit that asked for this
// file asked for them to be told apart.
//
// ponytail: no fixture schema validation, no per-fixture selector, no retry,
// no shared HTTP client. Every probe prints the invariant it checked, so a
// fixtures.json entry missing a key shows up as a short line rather than a
// silent pass.
// ponytail: fixtures.json says what the demo must answer, not which files
// hardcode it. The `grep -rl` in each failure message finds those, and unlike
// a list of paths in JSON it cannot go stale.
//
// Usage: node ci/check-fixtures.mjs
//   GEOLENS=https://demo.getgeolens.com    instance to probe
//   FIXTURE_TIMEOUT_MS=15000               per-request bound, so a hung demo
//                                          fails the step instead of holding
//                                          the job until its own timeout
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = (process.env.GEOLENS ?? "https://demo.getgeolens.com").replace(/\/+$/, "");
const DEMO_HOST = new URL(DEMO).host;
// Both knobs are validated the way verify-examples.mjs validates its manifest
// numbers: a typo becomes an error, not a zero timeout that aborts everything.
const knob = (name, fallback, min) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`${name}=${raw} is not a number of at least ${min}`);
    process.exit(2);
  }
  return value;
};
const TIMEOUT_MS = knob("FIXTURE_TIMEOUT_MS", 15000, 1000);

const { fixtures } = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8"));

// One shared demo on the public internet answers the odd request with a 502
// or a timeout with nothing wrong at either end, and the browser sweep already
// retries a page once for the same reason. A network error, a timeout, a 5xx,
// a 429 or a 408 gets three attempts with a widening gap; any other 4xx gets
// one, since asking the same wrong question again does not help. When the
// attempts run out the failure is a TransportError, which the loop below
// files under "demo unavailable" rather than under a fixture: a 502 says
// nothing about whether the dataset moved. Everything else about a response,
// including a 404, is for the caller to judge.
const ATTEMPTS = knob("FIXTURE_ATTEMPTS", 3, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class TransportError extends Error {}
const transient = (status) => status >= 500 || status === 429 || status === 408;
async function get(path) {
  const url = /^https?:\/\//i.test(path) ? path : `${DEMO}${path}`;
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!transient(res.status)) return res;
      last = new TransportError(`${url} answered ${res.status}`);
      // A Retry-After in seconds is the server naming its own gap.
      const after = Number(res.headers.get("retry-after"));
      if (attempt < ATTEMPTS && Number.isFinite(after) && after > 0) await sleep(Math.min(after, 30) * 1000);
    } catch (err) {
      last = err instanceof TransportError ? err : new TransportError(`${url} could not be read (${oneLine(err)})`);
    }
    if (attempt < ATTEMPTS) {
      console.log(`  retrying ${path} after ${oneLine(last)} (attempt ${attempt} of ${ATTEMPTS})`);
      await sleep(1000 * attempt);
    }
  }
  throw last;
}
// fetch() reports a DNS or connection failure as a bare "fetch failed" and puts
// what actually happened in .cause, which is the half worth printing.
const oneLine = (err) => String(err?.cause ?? err).split("\n")[0];

// The distinct exit. Everything below this line is a statement about a
// fixture; this one is a statement about the demo, and it says so, with its
// own exit code (75, EX_TEMPFAIL) so a caller can tell "come back later" from
// "someone has to edit this repo" without parsing the text.
function unavailable(why) {
  console.error(
    `public demo unavailable: ${why}\n` +
      `  No fixture verdict was reached and no example in this repo was evaluated, so this says nothing\n` +
      `  about whether the examples work. Check ${DEMO}/api/health and re-run when the demo is back.`,
  );
  process.exit(75);
}

let health;
try {
  const res = await get("/api/health");
  if (!res.ok) unavailable(`${DEMO}/api/health answered ${res.status}`);
  health = await res.json();
} catch (err) {
  unavailable(`${DEMO}/api/health could not be reached (${oneLine(err)})`);
}
console.log(`${DEMO} is healthy, GeoLens ${health.version ?? "(no version reported)"}`);

async function checkCollection(name, fx, notes, problems) {
  const res = await get(`/api/collections/${fx.collection}`);
  if (res.status === 404) {
    problems.push(
      `fixture ${name} no longer resolves on the demo (404): the demo was probably reset. ` +
        `Find the new ID at ${DEMO}/api/collections and replace ${fx.collection} across the repo ` +
        `(grep -rl ${fx.collection}).`,
    );
    return;
  }
  if (!res.ok) {
    problems.push(`fixture ${name}: /api/collections/${fx.collection} answered ${res.status}, so nothing about this dataset could be checked.`);
    return;
  }
  const collection = await res.json();
  notes.push(`itemType ${collection.itemType}`);
  // A title that changed under a live ID is the quieter half of a reset: the
  // requests all still work, and the examples now describe someone else's data.
  if (collection.title !== fx.title) {
    problems.push(
      `fixture ${name}: ${fx.collection} is now titled "${collection.title}", not "${fx.title}". ` +
        `The ID still resolves, but to a different dataset than the examples describe.`,
    );
  }
  if (fx.itemType && collection.itemType !== fx.itemType) {
    problems.push(
      `fixture ${name}: ${fx.collection} is itemType "${collection.itemType}", not "${fx.itemType}". ` +
        `The examples read it as ${fx.itemType} data and will not render it as anything else.`,
    );
  }

  if (fx.minNumberMatched === undefined && !fx.geometryType) return;
  const items = await get(`/api/collections/${fx.collection}/items?limit=1`);
  if (!items.ok) {
    problems.push(`fixture ${name}: the collection resolves but /items answered ${items.status}, so the examples get no features.`);
    return;
  }
  const body = await items.json();
  const matched = body.numberMatched;
  const geometry = body.features?.[0]?.geometry?.type ?? null;
  notes.push(`${matched} features`, geometry ?? "no geometry");
  if (fx.minNumberMatched !== undefined && !(matched >= fx.minNumberMatched)) {
    problems.push(
      `fixture ${name}: /items matches ${matched} feature(s), expected at least ${fx.minNumberMatched}. ` +
        `The dataset is still there and has been reloaded with different data.`,
    );
  }
  if (fx.geometryType && geometry !== fx.geometryType) {
    problems.push(
      `fixture ${name}: features are ${geometry ?? "missing geometry"}, not ${fx.geometryType}. ` +
        `The dataset was reloaded with different geometry, and the examples were written against the old one.`,
    );
  }

  // A collection-wide count says nothing about one view of it. An example
  // that opens on a particular bbox and expects a number of pages there names
  // that bbox, and the preflight asks the same question the page will.
  if (fx.view) {
    if (!Array.isArray(fx.view.bbox) || fx.view.bbox.length !== 4 || typeof fx.view.minNumberMatched !== "number") {
      problems.push(`fixture ${name}: view needs a 4-number bbox and a numeric minNumberMatched in ci/fixtures.json; this is a fixtures.json mistake, not the demo.`);
      return;
    }
    const bbox = fx.view.bbox.join(",");
    const inView = await get(`/api/collections/${fx.collection}/items?bbox=${bbox}&limit=1`);
    if (!inView.ok) {
      problems.push(`fixture ${name}: /items?bbox=${bbox} answered ${inView.status}, so the view the example opens on could not be checked.`);
      return;
    }
    const n = (await inView.json()).numberMatched;
    notes.push(`${n} in the ${fx.view.name ?? "opening"} view`);
    if (!(n >= fx.view.minNumberMatched)) {
      problems.push(
        `fixture ${name}: /items?bbox=${bbox} matches ${n} feature(s), expected at least ${fx.view.minNumberMatched} ` +
          `(${fx.view.why ?? "the example depends on that many in its opening view"}). The data moved, not the example.`,
      );
    }
  }
}

async function checkTile(name, kind, tile, notes, problems) {
  const path = `${tile.path}${tile.probe}`;
  const res = await get(path);
  if (!res.ok) {
    problems.push(
      `fixture ${name}: the ${kind} tile ${path} answered ${res.status}, over the middle of the dataset ` +
        `where a tile must exist. The demo was probably reset. Check ${DEMO}/api/collections and replace ` +
        `${tile.grep} across the repo (grep -rl ${tile.grep}).`,
    );
    return;
  }
  // 204 is GeoLens saying there is no tile at this address, which it also
  // answers for a dataset that is gone. The probe sits in the middle of the
  // footprint, so here it means the data is missing rather than the tile.
  if (res.status === 204) {
    problems.push(
      `fixture ${name}: the ${kind} tile ${path} answered 204, so the demo has no tile in the middle of ` +
        `this dataset. Check ${DEMO}/api/collections and replace ${tile.grep} across the repo (grep -rl ${tile.grep}).`,
    );
    return;
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = (await res.arrayBuffer()).byteLength;
  notes.push(`${kind} tile ${type} ${bytes}B`);
  if (!tile.contentTypes.includes(type)) {
    problems.push(
      `fixture ${name}: the ${kind} tile ${path} came back as "${type}", not one of ${tile.contentTypes.join(", ")}. ` +
        `A map library hands that to its decoder and draws nothing.`,
    );
    // Body length rather than status alone: this repo's whole premise is that
    // 200 is a claim. An empty body is a 200 carrying no map.
  } else if (bytes === 0) {
    problems.push(`fixture ${name}: the ${kind} tile ${path} answered 200 with an empty body, so it carries no data to draw.`);
  }
}

async function checkSharedMap(name, fx, notes, problems) {
  const { token, layers: expected } = fx.sharedMap;
  const res = await get(`/api/maps/shared/${token}`);
  if (res.status === 404) {
    problems.push(
      `fixture ${name}: the shared map token no longer resolves (404): the demo's share link was rotated. ` +
        `Mint a new one from the map's Share dialog and replace ${token} across the repo (grep -rl ${token}).`,
    );
    return;
  }
  if (!res.ok) {
    problems.push(`fixture ${name}: /api/maps/shared/${token} answered ${res.status}, so the embedded map could not be checked.`);
    return;
  }
  const map = await res.json();
  const layers = Array.isArray(map.layers) ? map.layers.length : null;
  notes.push(`shared map "${map.name}"`, `${layers} layers`);
  if (map.name !== fx.title) {
    problems.push(`fixture ${name}: the shared map is now named "${map.name}", not "${fx.title}". The token points at a different map.`);
  }
  // The layer count, server-side. embed/iframe.html frames a map GeoLens
  // styles itself, so the browser sweep can prove the frame loaded and its
  // tiles flowed but cannot see inside it — this is the only place the count
  // the page and the README both quote is actually checked.
  if (layers !== expected) {
    problems.push(
      `fixture ${name}: the shared map carries ${layers} layer(s), not ${expected}. ` +
        `embed/iframe.html and the README both describe it by that count, and the iframe cannot be read from outside.`,
    );
  }
}

async function checkSearch(name, fx, notes, problems) {
  const { q, limit, recordType } = fx.search;
  // search/catalog.html cannot use /api/search/ (no CORS header), so it asks
  // the OGC Records route with the same q and auto-draws the first hit
  // unfiltered. Probe that route too, and require the same dataset first
  // with a vector_tiles distribution, or the page loads a different layer
  // than its manifest entry names.
  const records = await get(`/api/collections/datasets/items?q=${encodeURIComponent(q)}&limit=10`);
  if (!records.ok) {
    problems.push(`fixture ${name}: /api/collections/datasets/items?q= answered ${records.status}, so search/catalog.html's query could not be checked.`);
  } else {
    const first = ((await records.json()).features ?? [])[0];
    const tiles = (first?.properties?.distributions ?? []).find((d) => d.type === "vector_tiles");
    if (!first || first.id !== fx.collection) {
      problems.push(
        `fixture ${name}: the Records query "${q}" now ranks ${first?.id ?? "nothing"} ("${first?.properties?.title ?? ""}") first, ` +
          `not ${fx.collection}. search/catalog.html draws the first hit, so it opens on a different dataset.`,
      );
    } else if (!tiles) {
      problems.push(`fixture ${name}: the first Records hit for "${q}" advertises no vector_tiles distribution, so search/catalog.html has nothing to draw on load.`);
    } else {
      notes.push(`records "${q}" → ${fx.collection} first, with vector tiles`);
    }
  }
  const res = await get(`/api/search/datasets/?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res.ok) {
    problems.push(`fixture ${name}: /api/search/datasets/ answered ${res.status}, so the catalog search could not be checked.`);
    return;
  }
  const body = await res.json();
  const hits = (body.features ?? []).filter((f) => f.properties?.record_type === recordType);
  notes.push(`search "${q}" → ${hits.length} ${recordType} hit(s)`);
  if (hits.length === 0) {
    problems.push(
      `fixture ${name}: searching "${q}" returns no ${recordType} at all. python/sdk-catalog.py picks its ` +
        `dataset from this search and exits when it comes back empty.`,
    );
  } else if (hits[0].id !== fx.collection) {
    problems.push(
      `fixture ${name}: searching "${q}" now ranks ${hits[0].id} ("${hits[0].properties?.title}") first, ` +
        `not ${fx.collection}. python/sdk-catalog.py takes the first hit, so it is describing a different dataset.`,
    );
  }
}

const problems = [];
// STAC search over the view stac/browse.html opens on. The page draws the
// item that covers the map centre with the tightest footprint, so the probe
// picks the same item and fetches one tile of its raster_tiles asset at the
// centre. A reset that leaves the STAC catalog empty over New York, or an
// item without a drawable asset, reads as a fixture change here rather than
// as a blank map in the sweep.
async function checkStac(name, fx, notes, problems) {
  const { bbox, center, minItems, probe } = fx.stac;
  // Walk the search the way the page does: every rel=next up to the page's
  // own cap, so the item chosen here is the item the page will draw.
  const items = [];
  const seen = new Set();
  let url = `${DEMO}/api/stac/search?bbox=${bbox.join(",")}&limit=20`;
  const visited = new Set();
  while (url && items.length < 100) {
    if (visited.has(url)) { problems.push(`fixture ${name}: /api/stac/search repeats a next link (${url}).`); return; }
    visited.add(url);
    const res = await get(url);
    if (!res.ok) {
      problems.push(`fixture ${name}: ${url} answered ${res.status}, so the STAC example's opening view could not be checked.`);
      return;
    }
    const page = await res.json();
    // Same budget as the page: fresh items are sliced to what still fits,
    // so a page that crosses the cap ranks the same items the browser holds.
    for (const f of page.features ?? []) {
      if (items.length >= 100) break;
      f._base = res.url || url;
      const k = JSON.stringify([f.collection ?? "", f.id]);
      if (!seen.has(k)) { seen.add(k); items.push(f); }
    }
    const next = page.links?.find((l) => l.rel === "next")?.href;
    url = next ? new URL(next, res.url || url).href : null;
  }
  notes.push(`${items.length} STAC item(s) over the opening view`);
  if (items.length < minItems) {
    problems.push(
      `fixture ${name}: /api/stac/search?bbox=${bbox.join(",")} returned ${items.length} item(s), expected at least ${minItems} ` +
        `(${fx.stac.why ?? "the STAC example opens here"}). The catalog moved, not the example.`,
    );
    return;
  }
  // The same ranking as stac/browse.html: does the item's geometry (bbox
  // when it has none) cover the map centre, tightest footprint first.
  const flat = (b) => (!Array.isArray(b) || b.length < 4 || !b.every(Number.isFinite) ? null : b.length === 6 ? [b[0], b[1], b[3], b[4]] : b);
  const width = (w, e) => (w <= e ? e - w : e + 360 - w);
  const coversBbox = (b) => { const f = flat(b); if (!f) return false; const [w, s, e, n] = f; const inLng = w <= e ? w <= center[0] && center[0] <= e : center[0] >= w || center[0] <= e; return inLng && s <= center[1] && center[1] <= n; };
  // Each edge takes the short arc (an edge 170 → -170 crosses the dateline), and the centre is tested in every world copy.
  const unwrap = (ring) => { const out = []; let prev = null; for (const [x0, y] of ring) { let x = x0; if (prev !== null) { while (x - prev > 180) x -= 360; while (x - prev < -180) x += 360; } out.push([x, y]); prev = x; } return out; };
  const planar = (ring, lng, lat) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const inRing = (ring) => { const r = unwrap(ring); return [center[0], center[0] + 360, center[0] - 360].some((x) => planar(r, x, center[1])); };
  const inPolygon = (rings) => rings.length > 0 && inRing(rings[0]) && !rings.slice(1).some(inRing);
  const covers = (i) => i.geometry?.type === "Polygon" ? inPolygon(i.geometry.coordinates ?? []) : i.geometry?.type === "MultiPolygon" ? (i.geometry.coordinates ?? []).some(inPolygon) : coversBbox(i.bbox);
  const area = (b) => { const f = flat(b); if (!f) return Infinity; const [w, s, e, n] = f; return width(w, e) * (n - s); };
  // Covering items first, tightest first, then the rest by area: the page's
  // sort, so the fixture probes the item the page will draw even when
  // nothing contains the exact centre.
  const pick = [...items].sort((a, b) => covers(b) - covers(a) || area(a.bbox) - area(b.bbox))[0];
  if (!pick) {
    problems.push(`fixture ${name}: the search returned nothing to rank over ${center.join(",")}, so the example has nothing to draw on load.`);
    return;
  }
  // Same resolution rules as the page: a relative asset href is relative to
  // the item's self link, itself relative to the response the item came in.
  let href = pick.assets?.raster_tiles?.href;
  if (typeof href === "string" && /^https?:\/\//i.test(href)) href = href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  if (typeof href === "string" && !/^https?:\/\//i.test(href)) {
    try {
      const self = pick.links?.find((l) => l.rel === "self")?.href;
      const base = self ? new URL(self, pick._base).href : pick._base;
      href = new URL(href, base).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
    } catch { href = null; }
  }
  if (typeof href !== "string" || !/^https?:\/\//i.test(href)) {
    problems.push(`fixture ${name}: "${pick.properties?.title ?? pick.id}" covers the centre but advertises no http raster_tiles asset, so the example draws nothing.`);
    return;
  }
  // The browser sweep only counts responses from the demo host, so an asset
  // served from anywhere else would pass here and fail there.
  if (new URL(href).host !== DEMO_HOST) {
    problems.push(`fixture ${name}: "${pick.properties?.title ?? pick.id}" serves its raster_tiles from ${new URL(href).host}, not ${DEMO_HOST}; the sweep would not count those tiles.`);
    return;
  }
  const [z, x, y] = probe.split("/");
  const tile = await get(href.replace("{z}", z).replace("{x}", x).replace("{y}", y));
  const type = tile.headers.get("content-type") ?? "";
  const bytes = tile.status === 200 ? (await tile.arrayBuffer()).byteLength : 0;
  if (tile.status !== 200 || !type.startsWith("image/") || bytes === 0) {
    problems.push(
      `fixture ${name}: tile ${probe} of "${pick.properties?.title ?? pick.id}" answered ${tile.status} ${type} ${bytes}B, ` +
        `so the STAC example paints nothing over its opening view.`,
    );
    return;
  }
  notes.push(`"${pick.properties?.title ?? pick.id}" tile ${probe} ${type} ${bytes}B`);
}

const KNOWN = ["collection", "stac", "vectorTile", "rasterTile", "sharedMap", "search"];
const transport = [];
for (const [name, fx] of Object.entries(fixtures)) {
  const notes = [];
  const before = problems.length;
  // A fixture that names no probe this script understands would otherwise
  // pass by saying nothing. A misspelled key is an error, not an OK.
  if (!KNOWN.some((k) => fx[k])) {
    problems.push(`fixture ${name} declares none of ${KNOWN.join("/")}, so nothing was probed for it; check the key names in ci/fixtures.json.`);
  }
  try {
    if (fx.collection) await checkCollection(name, fx, notes, problems);
    if (fx.stac) await checkStac(name, fx, notes, problems);
    if (fx.vectorTile) await checkTile(name, "vector", fx.vectorTile, notes, problems);
    if (fx.rasterTile) await checkTile(name, "raster", fx.rasterTile, notes, problems);
    if (fx.sharedMap) await checkSharedMap(name, fx, notes, problems);
    if (fx.search) await checkSearch(name, fx, notes, problems);
  } catch (err) {
    // A response that never came, kept failing, or was not JSON is the demo
    // (or the path to it) misbehaving, not the catalog moving. It goes on the
    // transport list, and only a fixture-shaped problem gets the "IDs moved"
    // footer.
    if (err instanceof TransportError || err instanceof SyntaxError || err?.name === "TimeoutError") {
      transport.push(`fixture ${name}: ${oneLine(err)}`);
    } else {
      problems.push(`fixture ${name}: a probe never completed (${oneLine(err)}), so this fixture is unverified.`);
    }
  }
  const state = problems.length === before && transport.length === 0 ? "OK" : problems.length === before ? "UNREACHED" : "FAIL";
  console.log(`${name}: ${state} ${notes.join(", ")}`.trimEnd());
}

if (problems.length > 0) {
  console.error(
    `\nFIXTURE PREFLIGHT FAILED (${problems.length} problem(s)):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      (transport.length > 0 ? `\n  and ${transport.length} probe(s) never got a usable answer:\n` + transport.map((t) => `  - ${t}`).join("\n") : "") +
      `\n\nThese are the demo's IDs, not this repo's code. Unless someone edited an example, the examples\n` +
      `did not break: the demo catalog moved under them, and ci/fixtures.json is where the names it moved\n` +
      `away from are written down.`,
  );
  process.exit(1);
}
if (transport.length > 0) {
  unavailable(`${transport.length} probe(s) got no usable answer after ${ATTEMPTS} attempts each:\n  - ${transport.join("\n  - ")}`);
}
console.log(`\nAll ${Object.keys(fixtures).length} demo fixtures in ci/fixtures.json still hold on ${DEMO}.`);
