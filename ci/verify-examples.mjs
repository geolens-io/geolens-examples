// Loads every browser example against the live GeoLens demo and fails the
// build when reality stops matching ci/manifest.json.
//
// A page passes only when all of the following hold:
//
//   1. Nothing broke: no console errors, no uncaught exceptions, no failed
//      requests.
//   2. It loaded the data it claims to: every `requireUrls` substring shows up
//      in the URL of a successful demo response.
//   3. It got enough of that data: at least `minDataResponses` demo responses
//      with status 200 for a data URL (items / .pbf / .png). A 204 is the
//      server saying "no tile here", so 204s are counted and reported but do
//      not satisfy the minimum.
//   4. The data was not empty: if the page fetched /items at all, at least one
//      of those responses carried features. (At least one, not all — ArcGIS's
//      OGCFeatureLayer fetches per-viewport-tile and legitimately gets empty
//      answers for the tiles the data does not reach.)
//   5. Something actually painted: in the middle of the viewport the pixels
//      are not a flat fill. See renderProof() for why that check is shaped the
//      way it is.
//
// Checks 2-5 are what separate this from a smoke test. HTTP 200 on a vector
// tile proves nothing about the map: name the source-layer wrong and every
// tile still returns 200 while the canvas stays empty.
//
// Manifest schema — ci/manifest.json is an array of these objects:
//
//   path              string    required  repo-relative page to load
//   wait              number    required  ms to watch the page after load
//   requireUrls       string[]  required  substrings, each of which must appear
//                                         in a successful demo response URL
//   minDataResponses  number    required  see 3 above
//   minDistinctColors number    optional  overrides DEFAULTS
//   minInkFraction    number    optional  overrides DEFAULTS
//   cropFraction      number    optional  overrides DEFAULTS
//
// Unknown or missing keys fail the run before the browser starts, so a typo in
// a new entry is a loud error and not a silently skipped assertion.
//
// Usage: node ci/verify-examples.mjs      (expects the repo served at BASE)
//   BASE=http://localhost:8000            where the repo is served
//   ONLY=maplibre/features.html           run one entry (comma-separated list)
//   ATTEMPTS=2                            tries per page before it counts as red
//   DIAGNOSTICS_DIR=ci/diagnostics        where failure evidence is written
import { chromium } from "playwright";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BASE = process.env.BASE ?? "http://localhost:8000";
const DIAGNOSTICS = process.env.DIAGNOSTICS_DIR ?? join(HERE, "diagnostics");
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 2);
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map((s) => s.trim()) : null;

// Pinned so the pixel thresholds below mean the same thing on every machine.
const VIEWPORT = { width: 1280, height: 720 };

const DEFAULTS = {
  // Fraction of the viewport, centered, that the render proof looks at.
  // Cropping keeps map controls (zoom, attribution — all corner-anchored) out
  // of the sample, so their pixels can never stand in for rendered data.
  cropFraction: 0.6,
  minDistinctColors: 32,
  minInkFraction: 0.01,
};

const DATA_URL = /\/items(\?|$)|\.pbf|\.png/;
const ITEMS_URL = /\/items(\?|$)/;
const DEMO_HOST = "demo.getgeolens.com";

// Map libraries cancel in-flight tile requests whenever the view changes, and
// a cancellation is not a failure. Everything else counts.
const IGNORED_REQUEST_FAILURE = /net::ERR_ABORTED/;

const REQUIRED_KEYS = ["path", "wait", "requireUrls", "minDataResponses"];
const OPTIONAL_KEYS = ["minDistinctColors", "minInkFraction", "cropFraction"];

function loadManifest() {
  const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
  const problems = [];
  if (!Array.isArray(manifest)) problems.push("manifest.json must be an array");

  manifest.forEach((entry, i) => {
    const where = `manifest[${i}]${entry?.path ? ` (${entry.path})` : ""}`;
    for (const key of REQUIRED_KEYS) {
      if (entry?.[key] === undefined) problems.push(`${where}: missing required key "${key}"`);
    }
    for (const key of Object.keys(entry ?? {})) {
      if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
        problems.push(`${where}: unknown key "${key}"`);
      }
    }
    if (entry?.requireUrls !== undefined && (!Array.isArray(entry.requireUrls) || entry.requireUrls.length === 0)) {
      problems.push(`${where}: requireUrls must be a non-empty array of URL substrings`);
    }
  });

  if (problems.length > 0) {
    console.error("Invalid ci/manifest.json:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  return manifest;
}

// The README status table drifting away from what CI actually verifies was the
// top finding of the last examples audit, so it is now a build failure.
//
// The README documents examples a directory at a time, so either the full path
// or its directory counts as documented. That catches the case that actually
// bit — a whole example landing in CI with no row in the table — without
// dictating how the table is written.
function checkReadmeCoverage(manifest) {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const missing = manifest
    .map((e) => e.path)
    .filter((path) => !readme.includes(path) && !readme.includes(`${path.split("/")[0]}/`));
  if (missing.length > 0) {
    console.error(
      "ci/manifest.json verifies examples that README.md never mentions:\n" +
        missing.map((p) => `  - ${p}`).join("\n") +
        "\nAdd a row for each, or drop the entry from ci/manifest.json.",
    );
    process.exit(1);
  }
}

// Decode the screenshot in the browser we already have rather than pulling in
// a PNG library: a data: URL is CORS-clean, so getImageData() works on it.
async function pixelStats(scratch, png) {
  return scratch.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modal = 0;
    let modalCount = 0;
    for (const [key, n] of counts) {
      if (n > modalCount) {
        modal = key;
        modalCount = n;
      }
    }
    const total = data.length / 4;
    return {
      distinct: counts.size,
      modal: `#${modal.toString(16).padStart(6, "0")}`,
      inkFraction: 1 - modalCount / total,
    };
  }, `data:image/png;base64,${png.toString("base64")}`);
}

// One check for all nine pages, because the thing they have in common is the
// only thing worth asserting generically: a map that failed to draw is a flat
// fill of the page background, and a map that drew is not.
//
//   distinct      distinct RGB values in the crop. A blank map is exactly 1.
//   inkFraction   share of pixels that are NOT the most common color.
//
// Both, because either alone has a hole. inkFraction alone passes a map
// covered edge to edge in one wrong solid color (a broken tile served as a
// grey square); distinct alone passes a map where a handful of stray pixels
// carry hundreds of antialiased shades.
async function renderProof(page, scratch, entry) {
  const cropFraction = entry.cropFraction ?? DEFAULTS.cropFraction;
  const width = Math.round(VIEWPORT.width * cropFraction);
  const height = Math.round(VIEWPORT.height * cropFraction);
  const crop = await page.screenshot({
    clip: {
      x: (VIEWPORT.width - width) / 2,
      y: (VIEWPORT.height - height) / 2,
      width,
      height,
    },
  });
  return { crop, stats: await pixelStats(scratch, crop) };
}

async function runOnce(page, scratch, entry) {
  const consoleMessages = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const demoResponses = [];
  const bodyReads = [];
  // Both counters move in the same async continuation, so a response that
  // lands as the run ends can never look like "fetched but empty".
  let itemsRead = 0;
  let itemsWithFeatures = 0;

  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? String(err)));
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "unknown";
    if (!IGNORED_REQUEST_FAILURE.test(reason)) failedRequests.push(`${reason} ${req.url()}`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes(DEMO_HOST)) return;
    demoResponses.push({ status: res.status(), url });
    if (res.status() === 200 && ITEMS_URL.test(url)) {
      bodyReads.push(
        res
          .json()
          .then((body) => {
            itemsRead += 1;
            const n = Math.max(body?.numberReturned ?? 0, body?.features?.length ?? 0);
            if (n > 0) itemsWithFeatures += 1;
          })
          .catch(() => {}),
      );
    }
  });

  await page.goto(`${BASE}/${entry.path}`, { waitUntil: "load" });
  await page.waitForTimeout(entry.wait);

  const { crop, stats } = await renderProof(page, scratch, entry);
  await Promise.allSettled(bodyReads);

  const ok2xx = demoResponses.filter((r) => r.status >= 200 && r.status < 300);
  const dataResponses = demoResponses.filter((r) => r.status === 200 && DATA_URL.test(r.url));
  const emptyTiles = demoResponses.filter((r) => r.status === 204).length;

  const minDistinct = entry.minDistinctColors ?? DEFAULTS.minDistinctColors;
  const minInk = entry.minInkFraction ?? DEFAULTS.minInkFraction;

  const failures = [];
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console error(s); first: ${consoleErrors[0]}`);
  }
  if (pageErrors.length > 0) {
    failures.push(`${pageErrors.length} uncaught exception(s); first: ${pageErrors[0].split("\n")[0]}`);
  }
  if (failedRequests.length > 0) {
    failures.push(`${failedRequests.length} failed request(s); first: ${failedRequests[0]}`);
  }
  for (const needle of entry.requireUrls) {
    if (!ok2xx.some((r) => r.url.includes(needle))) {
      failures.push(`no successful demo response matched required URL "${needle}" — the example is not loading the data it documents`);
    }
  }
  if (dataResponses.length < entry.minDataResponses) {
    failures.push(`only ${dataResponses.length} successful data response(s), need ${entry.minDataResponses} (${emptyTiles} empty 204 tile(s) do not count)`);
  }
  if (itemsRead > 0 && itemsWithFeatures === 0) {
    failures.push(`${itemsRead} /items response(s), every one an empty FeatureCollection`);
  }
  if (stats.distinct < minDistinct || stats.inkFraction < minInk) {
    failures.push(`nothing painted: center of the viewport has ${stats.distinct} distinct colors (need ${minDistinct}) and ${(stats.inkFraction * 100).toFixed(2)}% non-background pixels (need ${(minInk * 100).toFixed(2)}%), modal color ${stats.modal}`);
  }

  const summary =
    `consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} ` +
    `failedRequests=${failedRequests.length} dataResponses=${dataResponses.length} ` +
    `emptyTiles=${emptyTiles} items=${itemsWithFeatures}/${itemsRead} ` +
    `distinct=${stats.distinct} ink=${(stats.inkFraction * 100).toFixed(2)}%`;

  // Called only on the final failing attempt, while the page is still open.
  const collect = async () => ({
    "crop.png": crop,
    "screenshot.png": await page.screenshot({ fullPage: false }),
    "page.html": await page.content(),
    "console.log": consoleMessages.join("\n") || "(no console output)",
    "requests.txt":
      `FAILED REQUESTS (${failedRequests.length})\n` +
      failedRequests.map((f) => `  ${f}`).join("\n") +
      `\n\nDEMO RESPONSES (${demoResponses.length})\n` +
      demoResponses.map((r) => `  ${r.status} ${r.url}`).join("\n"),
    "page-errors.txt": pageErrors.join("\n\n") || "(none)",
  });

  return { failures, summary, collect };
}

function writeDiagnostics(entry, failures, files) {
  const dir = join(DIAGNOSTICS, entry.path.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "failures.txt"), failures.map((f) => `- ${f}`).join("\n"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const manifest = loadManifest();
checkReadmeCoverage(manifest);

const entries = ONLY ? manifest.filter((e) => ONLY.includes(e.path)) : manifest;
if (entries.length === 0) {
  console.error(`ONLY=${process.env.ONLY} matched no manifest entry`);
  process.exit(1);
}

rmSync(DIAGNOSTICS, { recursive: true, force: true });

const browser = await chromium.launch();
const scratch = await browser.newPage();
await scratch.setContent("<!doctype html><title>pixel scratch</title>");

const failed = [];
for (const entry of entries) {
  let last;
  // These pages talk to a live demo over the public internet, so a single
  // network hiccup is not a broken example. Retry once, loudly — an example
  // that is genuinely broken fails every attempt, and an example that needed a
  // retry leaves its first failure in the log where someone can see it.
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    last = await runOnce(page, scratch, entry).catch((err) => ({
      failures: [`the page run threw: ${String(err).split("\n")[0]}`],
      summary: "(threw before it could be measured)",
      collect: async () => ({ "error.txt": String(err.stack ?? err) }),
    }));

    const passed = last.failures.length === 0;
    console.log(`${entry.path}: ${passed ? "OK" : "FAIL"} ${last.summary}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    for (const f of last.failures) console.log(`    ${f}`);

    if (!passed && attempt === ATTEMPTS) {
      const dir = writeDiagnostics(entry, last.failures, await last.collect());
      console.log(`    diagnostics written to ${dir}`);
    }
    await page.close();

    if (passed) break;
    if (attempt < ATTEMPTS) console.log(`    retrying ${entry.path} (attempt ${attempt + 1} of ${ATTEMPTS})`);
  }

  if (last.failures.length > 0) failed.push({ path: entry.path, failures: last.failures });
}

await browser.close();

if (failed.length > 0) {
  console.error(
    `\nFAILURES (${failed.length} example(s)):\n` +
      failed.map((f) => `  ${f.path}\n` + f.failures.map((x) => `    - ${x}`).join("\n")).join("\n"),
  );
  process.exit(1);
}
console.log(
  `\nAll ${entries.length} example${entries.length === 1 ? "" : "s"} rendered live data and match ci/manifest.json.`,
);
