// Loads every browser example against the live GeoLens demo and fails the
// build when reality stops matching ci/manifest.json.
//
// A page passes only when all of the following hold:
//
//   1. Nothing broke on our side: no console errors, no uncaught exceptions
//      and no failed requests attributable to the demo or to the server
//      hosting the page. Third-party hosts and cancelled requests are
//      reported but never fatal; see isOurs() and IGNORED_REQUEST_FAILURE.
//   2. It reached the demo at all, and loaded the data it claims to: at least
//      one successful demo response, and every `requireUrls` substring shows
//      up in the URL of one.
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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const BASE_HOST = new URL(BASE).host;

// What these examples verify is that GeoLens's own responses are clean and its
// data renders. A CDN we do not control being unreachable from one runner is
// not a fact about GeoLens, so it is reported and never fatal.
//
// Deliberately a host predicate and not a list of known-noisy hosts: two runs
// of embed/iframe.html in different environments produced different
// third-party hosts (static.cloudflareinsights.com in one, the cartocdn
// basemap tiles in the other), so any enumerated allowlist is a list you
// maintain against a moving target. This one cannot quietly widen, because a
// genuine demo-side failure still carries a demo host.
const isOurs = (host) => host === DEMO_HOST || host === BASE_HOST;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Map libraries cancel in-flight tile requests whenever the view settles, and
// a cancellation is not a failure. This has to be excluded on its own merits,
// independently of host: embed/iframe.html produces ~36 ERR_ABORTED against
// demo.getgeolens.com itself on a page that renders perfectly, so the host
// predicate above would not save it.
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

// The README drifting away from what CI actually verifies was the top finding
// of the last examples audit, so both directions are now build failures.
//
// The one that matters is rows claiming verification with nothing behind them.
// That is the shape the repo actually shipped: the intro claimed every example
// rendered while the table's own Status column said two were blocked. A path
// check in either direction would have passed that, because every path was
// present and correctly documented. The lie was in the claim.
//
// A row claims verification if it says "verified". "Planned" and "Ready" rows
// assert nothing and need no backing, which is why the exemption is written as
// what the row claims rather than a list of directory names: new planned rows
// will appear and must not need an entry here.
//
// Rows are read whole, never by column position. ws4-gallery is reshaping this
// table and more rows are coming; a check that breaks when someone adds a
// column gets deleted the first time it is inconvenient.
const CLAIMS_VERIFICATION = /\bverified\b/i;
const DIR_IN_BACKTICKS = /`([A-Za-z0-9][\w.-]*)\//g;
const DIR_IN_LINK_TARGET = /\]\(([A-Za-z0-9][\w.-]*)\//g;

function directoriesIn(row) {
  const dirs = new Set();
  for (const re of [DIR_IN_BACKTICKS, DIR_IN_LINK_TARGET]) {
    for (const m of row.matchAll(re)) dirs.add(m[1]);
  }
  return dirs;
}

function checkReadmeAgainstCi(manifest) {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const workflow = readFileSync(join(REPO, ".github/workflows/verify.yml"), "utf8");
  const problems = [];

  // A directory is backed if the manifest verifies a page inside it, or if the
  // workflow names it (python/ is verified by its own job, not by the
  // browser manifest).
  const manifestDirs = new Set(manifest.map((e) => e.path.split("/")[0]));
  const isBacked = (dir) =>
    manifestDirs.has(dir) || new RegExp(`\\b${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(workflow);

  for (const row of readme.split("\n").filter((l) => l.trimStart().startsWith("|"))) {
    if (!CLAIMS_VERIFICATION.test(row)) continue;
    for (const dir of directoriesIn(row)) {
      if (!isBacked(dir)) {
        problems.push(
          `README.md claims \`${dir}/\` is verified, but nothing verifies it: ` +
            `no ci/manifest.json entry under ${dir}/ and no mention in the workflow. ` +
            `Add a manifest entry, or change the row's status to what is actually true.`,
        );
      }
    }
  }

  // The milder direction: an example CI verifies that the README never
  // mentions. Directory-level, because the table documents a directory at a
  // time; a passing mention anywhere in the README counts.
  for (const path of manifest.map((e) => e.path)) {
    if (!readme.includes(path) && !readme.includes(`${path.split("/")[0]}/`)) {
      problems.push(`ci/manifest.json verifies ${path}, which README.md never mentions. Add a row to the Examples table, or drop the entry.`);
    }
  }

  if (problems.length > 0) {
    console.error("README.md and CI disagree:\n" + problems.map((p) => `  - ${p}`).join("\n"));
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
  const thirdPartyIssues = [];
  const abortedRequests = [];
  const demoResponses = [];
  const bodyReads = [];
  // Both counters move in the same async continuation, so a response that
  // lands as the run ends can never look like "fetched but empty".
  let itemsRead = 0;
  let itemsWithFeatures = 0;

  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() !== "error") return;
    // Measured attribution: a page-context console.error() reports an EMPTY
    // location, a failed subresource reports the resource URL, and a CORS
    // rejection reports the URL of whatever initiated the fetch. So an
    // unattributable error is the page's own and counts against it.
    const host = hostOf(msg.location()?.url ?? "");
    if (host === null || isOurs(host)) consoleErrors.push(msg.text());
    else thirdPartyIssues.push(`console [${host}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? String(err)));
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "unknown";
    const line = `${reason} ${req.url()}`;
    if (IGNORED_REQUEST_FAILURE.test(reason)) abortedRequests.push(line);
    else if (isOurs(hostOf(req.url()) ?? BASE_HOST)) failedRequests.push(line);
    else thirdPartyIssues.push(`request ${line}`);
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
    failures.push(`${consoleErrors.length} same-origin console error(s); first: ${consoleErrors[0]}`);
  }
  if (pageErrors.length > 0) {
    failures.push(`${pageErrors.length} uncaught exception(s); first: ${pageErrors[0].split("\n")[0]}`);
  }
  if (failedRequests.length > 0) {
    failures.push(`${failedRequests.length} failed same-origin request(s); first: ${failedRequests[0]}`);
  }
  // Unconditional, and not expressible as minDataResponses: 0. Filtering
  // third-party noise must never leave a path where a page that loaded
  // nothing at all still passes.
  if (ok2xx.length === 0) {
    failures.push(`no successful ${DEMO_HOST} responses at all — the page reached the demo for nothing`);
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
    `failedRequests=${failedRequests.length} thirdParty=${thirdPartyIssues.length} ` +
    `aborted=${abortedRequests.length} dataResponses=${dataResponses.length} ` +
    `emptyTiles=${emptyTiles} items=${itemsWithFeatures}/${itemsRead} ` +
    `distinct=${stats.distinct} ink=${(stats.inkFraction * 100).toFixed(2)}%`;

  // Not fatal, but a page that cannot reach its basemap renders differently
  // from what a reader will see, so it stays visible in the log.
  const notes = thirdPartyIssues.map((i) => `third-party (not fatal): ${i}`);

  // Called only on the final failing attempt, while the page is still open.
  const collect = async () => ({
    "crop.png": crop,
    "screenshot.png": await page.screenshot({ fullPage: false }),
    "page.html": await page.content(),
    "console.log": consoleMessages.join("\n") || "(no console output)",
    "requests.txt":
      `FAILED SAME-ORIGIN REQUESTS (${failedRequests.length})\n` +
      failedRequests.map((f) => `  ${f}`).join("\n") +
      `\n\nTHIRD-PARTY ISSUES, NOT FATAL (${thirdPartyIssues.length})\n` +
      thirdPartyIssues.map((f) => `  ${f}`).join("\n") +
      `\n\nCANCELLED REQUESTS, NOT FATAL (${abortedRequests.length})\n` +
      abortedRequests.map((f) => `  ${f}`).join("\n") +
      `\n\nDEMO RESPONSES (${demoResponses.length})\n` +
      demoResponses.map((r) => `  ${r.status} ${r.url}`).join("\n"),
    "page-errors.txt": pageErrors.join("\n\n") || "(none)",
  });

  return { failures, notes, summary, collect };
}

function writeDiagnostics(entry, failures, files) {
  const dir = join(DIAGNOSTICS, entry.path.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "failures.txt"), failures.map((f) => `- ${f}`).join("\n"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const manifest = loadManifest();
checkReadmeAgainstCi(manifest);

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
const flaky = [];
for (const entry of entries) {
  let last;
  let firstFailure = null;
  // These pages talk to a live demo over the public internet, so a single
  // network hiccup is not a broken example. Retry, loudly: an example that is
  // genuinely broken fails every attempt, and one that only passed on a retry
  // is called out below in the log and in the job summary. A silently retried
  // flake is how a degrading demo goes unnoticed.
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    last = await runOnce(page, scratch, entry).catch((err) => ({
      failures: [`the page run threw: ${String(err).split("\n")[0]}`],
      notes: [],
      summary: "(threw before it could be measured)",
      collect: async () => ({ "error.txt": String(err.stack ?? err) }),
    }));

    const passed = last.failures.length === 0;
    console.log(`${entry.path}: ${passed ? "OK" : "FAIL"} ${last.summary}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    for (const n of last.notes ?? []) console.log(`    ${n}`);
    for (const f of last.failures) console.log(`    ${f}`);

    if (!passed && firstFailure === null) firstFailure = last.failures[0];
    if (passed && attempt > 1) {
      console.log(`    FLAKE: ${entry.path} passed only on attempt ${attempt}. Attempt 1 said: ${firstFailure}`);
      flaky.push({ path: entry.path, attempt, firstFailure });
    }

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

// GitHub renders this above the job log, so a retry that would otherwise be
// buried in 100 lines of passing output is the first thing a reader sees.
if (process.env.GITHUB_STEP_SUMMARY && flaky.length > 0) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Examples that passed only on retry\n\n` +
      `These went green, but not on the first try. Repeated appearances here mean the demo is degrading.\n\n` +
      flaky.map((f) => `- \`${f.path}\` passed on attempt ${f.attempt}. First attempt: ${f.firstFailure}`).join("\n") +
      "\n",
  );
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
