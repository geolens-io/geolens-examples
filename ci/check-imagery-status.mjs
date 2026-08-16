// Regression check for the maplibre/imagery.html catalog-probe fix (#18).
//
// The page asks /api/collections/<id> whether the dataset exists, because the
// tile route cannot say: it answers 204 for a tile outside the footprint and
// 204 for a dataset id that was never there. Measured against the live demo,
// MapLibre reports both of those exactly as it reports real imagery — same
// `data` event, same `state: "loaded"` — so a tile answering proves nothing
// about existence, and the catalog is genuinely the only signal available.
//
// That makes *how the page reads the catalog's answer* the whole correctness
// question, and it is not one the ci/manifest.json sweep can reach: the sweep
// runs against the public demo, where the probe answers 200 and none of these
// branches execute. Each condition has to be forced.
//
// Three answers, three different meanings:
//
//   404  Either the dataset is gone or it is private — GeoLens answers 404 for
//        a dataset you may not read (backend `_get_visible_dataset` applies the
//        visibility filter and 404s on an empty result), and this page's probe
//        is deliberately anonymous. Latched: a tile must not clear it, or a
//        genuinely missing dataset goes back to rendering nothing and saying
//        nothing.
//   401  Says nothing about existence. Must not latch, must not paint red over
//        a map whose tiles are working off a scoped token.
//   none A rejected fetch — no status at all. Cross-origin this is the common
//        case for 401, because the demo sends access-control-allow-origin on
//        200 and 404 but not on 401, so the browser blocks the response before
//        the page can read it. Must be handled, not left to reject unhandled.
//
// Usage: node ci/check-imagery-status.mjs   (expects the repo served at BASE)
//   BASE=http://localhost:8000              where the repo is served
//   PAGE=maplibre/imagery.html              page under test; point it at a
//                                           pre-fix copy to confirm this file
//                                           still fails against one
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8000";
const PAGE = process.env.PAGE ?? "maplibre/imagery.html";

const PROBE = "**/api/collections/**";
const TILES = "**/raster-tiles/**";

const CORS = { "access-control-allow-origin": "*", "content-type": "application/json" };

const browser = await chromium.launch();
const failures = [];

// `tiles: "hang"` holds the tile requests open so the catalog message is still
// on screen when we read it. Aborting them instead would raise a MapLibre
// `error`, and the page — correctly — lets a tile error outrank the catalog
// note, so we would be reading the wrong line.
async function run({ label, probe, tiles }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.route(PROBE, (route) =>
    probe === "abort"
      ? route.abort("failed")
      : route.fulfill({ status: probe, headers: CORS, body: JSON.stringify({ detail: "forced" }) }),
  );
  if (tiles === "hang") await page.route(TILES, () => {});

  await page.goto(`${BASE}/${PAGE}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(tiles === "hang" ? 4000 : 9000);

  const hud = await page.evaluate(() => {
    const el = document.getElementById("status");
    return { hidden: el.hidden, className: el.className, text: el.textContent.trim() };
  });
  await page.close();

  const shown = hud.hidden ? "(hidden)" : `[${hud.className || "neutral"}] ${hud.text}`;
  console.log(`\n${label}\n  ${shown}`);
  if (pageErrors.length > 0) console.log(`  pageErrors: ${pageErrors.length} — ${pageErrors[0]}`);
  return { ...hud, pageErrors, label };
}

// --- 404 latches, over working tiles ------------------------------------
// The one answer that carries information about existence. A tile must not
// clear it: 204s keep arriving for a dataset that is not there.
const gone = await run({ label: "probe 404, tiles answering", probe: 404, tiles: "live" });
if (gone.hidden) {
  failures.push("probe 404: HUD was cleared by tiles — a missing dataset now renders nothing and says nothing");
}
if (gone.className !== "err") {
  failures.push(`probe 404: expected the error style, got ${JSON.stringify(gone.className)}`);
}
// The message must not assert non-existence outright, because an anonymous
// probe cannot tell "deleted" from "private".
if (!/private/i.test(gone.text)) {
  failures.push(`probe 404: message does not mention that a private dataset also answers 404: ${gone.text}`);
}

// --- 401 does not latch --------------------------------------------------
// The bug in #18: tiles authorized by a scoped token render fine while the
// anonymous catalog request is rejected, and the page called the dataset
// missing over a working map.
const unauth = await run({ label: "probe 401, tiles answering", probe: 401, tiles: "live" });
if (!unauth.hidden) {
  failures.push(`probe 401: HUD stayed up over working tiles: [${unauth.className}] ${unauth.text}`);
}

// --- a rejected fetch does not latch, and is handled ---------------------
const dead = await run({ label: "probe network failure, tiles answering", probe: "abort", tiles: "live" });
if (!dead.hidden) {
  failures.push(`probe network failure: HUD stayed up over working tiles: [${dead.className}] ${dead.text}`);
}
if (dead.pageErrors.length > 0) {
  failures.push(`probe network failure: left ${dead.pageErrors.length} unhandled error(s): ${dead.pageErrors[0]}`);
}

// --- what the reader is actually told, with the tiles still in flight ----
// Asserting only the cleared end state would pass a page that says something
// false in the seconds before the tiles arrive.
const note = await run({ label: "probe 401, tiles still in flight", probe: 401, tiles: "hang" });
if (note.hidden) {
  failures.push("probe 401 with tiles in flight: HUD said nothing at all");
}
if (note.className === "err") {
  failures.push(`probe 401 with tiles in flight: styled as an error, but nothing is known to be broken: ${note.text}`);
}
if (/has no dataset|not found|does not exist/i.test(note.text)) {
  failures.push(`probe 401 with tiles in flight: claims the dataset is absent, which a 401 does not say: ${note.text}`);
}

const deadNote = await run({ label: "probe network failure, tiles still in flight", probe: "abort", tiles: "hang" });
if (deadNote.hidden) {
  failures.push("probe network failure with tiles in flight: HUD said nothing at all");
}
if (/has no dataset|not found|does not exist/i.test(deadNote.text)) {
  failures.push(`probe network failure with tiles in flight: claims the dataset is absent: ${deadNote.text}`);
}

await browser.close();

if (failures.length > 0) {
  console.error("\nFAILED:\n" + failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log("\nPASSED");
