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
const TIMEOUT_MS = Number(process.env.FIXTURE_TIMEOUT_MS ?? 15000);

const { fixtures } = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8"));

const get = (path) => fetch(`${DEMO}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
// fetch() reports a DNS or connection failure as a bare "fetch failed" and puts
// what actually happened in .cause, which is the half worth printing.
const oneLine = (err) => String(err?.cause ?? err).split("\n")[0];

// The distinct exit. Everything below this line is a statement about a
// fixture; this one is a statement about the demo, and it says so.
function unavailable(why) {
  console.error(
    `public demo unavailable: ${why}\n` +
      `  Nothing was probed and no example in this repo was evaluated, so this says nothing about\n` +
      `  whether the examples work. Check ${DEMO}/api/health and re-run when the demo is back.`,
  );
  process.exit(1);
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
        `The examples style one geometry type, so the map draws nothing for the others.`,
    );
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
for (const [name, fx] of Object.entries(fixtures)) {
  const notes = [];
  const before = problems.length;
  try {
    if (fx.collection) await checkCollection(name, fx, notes, problems);
    if (fx.vectorTile) await checkTile(name, "vector", fx.vectorTile, notes, problems);
    if (fx.rasterTile) await checkTile(name, "raster", fx.rasterTile, notes, problems);
    if (fx.sharedMap) await checkSharedMap(name, fx, notes, problems);
    if (fx.search) await checkSearch(name, fx, notes, problems);
  } catch (err) {
    // The demo answered /api/health, so a request that dies here is about this
    // fixture rather than about the demo being down.
    problems.push(`fixture ${name}: a probe never completed (${oneLine(err)}), so this fixture is unverified.`);
  }
  console.log(`${name}: ${problems.length === before ? "OK" : "FAIL"} ${notes.join(", ")}`.trimEnd());
}

if (problems.length > 0) {
  console.error(
    `\nFIXTURE PREFLIGHT FAILED (${problems.length} problem(s)):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nThese are the demo's IDs, not this repo's code. Unless someone edited an example, the examples\n` +
      `did not break — the demo catalog moved under them, and ci/fixtures.json is where the names it moved\n` +
      `away from are written down.`,
  );
  process.exit(1);
}
console.log(`\nAll ${Object.keys(fixtures).length} demo fixtures in ci/fixtures.json still hold on ${DEMO}.`);
