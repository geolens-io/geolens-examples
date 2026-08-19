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
//   4. The data was not empty, per collection: every collection the page
//      fetched items from produced at least one non-empty body of its own, and
//      none of them answered 200 with a body that could not be parsed — which
//      includes one that never finished arriving, see BODY_READ_TIMEOUT_MS. (At
//      least one non-empty rather than all, because ArcGIS's OGCFeatureLayer
//      fetches the same collection once per viewport tile and legitimately
//      gets empty answers for tiles the data does not reach.)
//   5. Something actually painted: in the middle of the viewport the pixels
//      are not a flat fill. See renderProof() for why that check is shaped the
//      way it is.
//   6. Each documented layer painted, for entries that list `requireColors`.
//      Check 5 only proves the page is not blank, which one surviving layer
//      satisfies on its own. Every entry drawing more than one layer in fixed
//      colours carries requireColors; a single-layer page does not need it,
//      because there "something painted" and "that layer painted" are the
//      same statement. A raster layer has no fixed colour, so the one entry
//      that pairs imagery with a thin outline (stac/browse.html) raises
//      minInkFraction instead: the imagery fills the viewport, the outline
//      alone could not.
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
//   requireColors     string[]  optional  "#rrggbb" of each layer the example
//                                         documents drawing; each must cover
//                                         minColorPixels pixels of the crop
//   minColorPixels    number    optional  overrides DEFAULTS
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
//   PAGE_GAP_MS=1500                      idle between page loads, to spare the demo
//   DIAGNOSTICS_DIR=ci/diagnostics        where failure evidence is written
import { chromium } from "playwright";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BASE = process.env.BASE ?? "http://localhost:8000";
const DIAGNOSTICS = process.env.DIAGNOSTICS_DIR ?? join(HERE, "diagnostics");
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 2);
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map((s) => s.trim()) : null;

// The demo is one small VM that normally serves almost nothing, and this
// workflow runs on every push, every PR and weekly. Idling between pages
// spreads the sweep instead of handing the VM a new page the instant the last
// one closes.
//
// Being honest about what this does not fix: the sweep is already strictly
// sequential and most of its wall clock is the per-entry `wait`, so the
// sustained rate is around 2 req/s. The actual burst is inside a single page
// (arcgis-js/imagery.html pulls ~130 tiles inside its 20s window, ~6/s) and
// that is the map library requesting tiles, which cannot be paced from here
// without weakening what the page proves.
const PAGE_GAP_MS = Number(process.env.PAGE_GAP_MS ?? 1500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A body read that never settles costs more than one that fails. runOnce waits
// for every /items body before it asserts anything, so a demo that sends 200
// headers and then stalls the body holds the whole run until the workflow's own
// 15-minute timeout kills it — naming no page, no screenshot and no failed
// request, which is the opposite of what these diagnostics are for (#17).
// Bounding each read turns that into an unreadable body: an ordinary failed
// attempt that retries, writes diagnostics, and says which collection stalled.
//
// Fixed rather than configurable, because it is a hang bound and not a tuning
// knob. It sits far above any real read here — every items body is one page of
// a subway collection, and the page has already had its whole `wait` to receive
// it before the drain even starts — and far below the workflow timeout it
// exists to keep the run away from.
const BODY_READ_TIMEOUT_MS = 15000;

// Promise.race plus the clearTimeout that makes it safe to call once per
// response: an uncleared timer per read would keep the event loop alive after
// the verdict is in, so a run that finished would sit waiting on nothing.
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Pinned so the pixel thresholds below mean the same thing on every machine.
const VIEWPORT = { width: 1280, height: 720 };

const DEFAULTS = {
  // Fraction of the viewport, centered, that the render proof looks at.
  // Cropping keeps map controls (zoom, attribution — all corner-anchored) out
  // of the sample, so their pixels can never stand in for rendered data.
  cropFraction: 0.6,
  minDistinctColors: 32,
  minInkFraction: 0.01,
  // Pixels of an exact requireColors match needed to call that layer drawn.
  // Measured across all four libraries, the documented colors survive to the
  // screenshot unconverted and land between 1264 and 12034 pixels, while the
  // largest antialiased blend around them is about 120. 200 sits an order of
  // magnitude below the tightest real layer and well above the blends.
  minColorPixels: 200,
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
const OPTIONAL_KEYS = ["minDistinctColors", "minInkFraction", "cropFraction", "requireColors", "minColorPixels"];
const HEX_COLOR = /^#[0-9a-f]{6}$/;

// Floors that cannot be configured away. Checking that a key exists is not the
// same as checking that its value means anything, and every bound below exists
// because the value past it turns an assertion into a no-op that still reports
// green:
//
//   requireUrls: [""]       an empty needle is a substring of every URL
//   minDataResponses: 0     satisfied by no data at all
//   minDistinctColors: 1    a flat fill measures exactly 1, so 1 passes it
//   minInkFraction: 0       satisfied by a blank canvas
//   cropFraction: 1         samples the corners, where the zoom control and
//                           attribution paint pixels a dead map hides behind
//
// A placeholder or a typo must not quietly revert this to the smoke test it
// replaced.
const MAX_CROP_FRACTION = 0.8;
const MIN_DISTINCT_FLOOR = 2;
const MIN_NEEDLE_LENGTH = 3;

// A needle naming /items has to name the collection, not the endpoint.
// "/items" clears every bound above while matching every items response on the
// page, so it proves only that the example fetched something, not that it
// fetched the dataset it documents. The features assertion no longer depends on
// needles at all (see byCollection below), but requireUrls still carries the
// "it loaded what it claims to" job, and that job needs a specific needle.
//
// Structural rather than another length guess: there must be a path segment
// immediately before /items.
const ITEMS_NEEDLE_NAMES_COLLECTION = /[^/]\/items(\?|$)/;

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function validateEntry(entry, where, problems) {
  for (const key of REQUIRED_KEYS) {
    if (entry?.[key] === undefined) problems.push(`${where}: missing required key "${key}"`);
  }
  for (const key of Object.keys(entry ?? {})) {
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
      problems.push(`${where}: unknown key "${key}"`);
    }
  }

  const { path, wait, requireUrls, minDistinctColors, minInkFraction, cropFraction } = entry ?? {};
  const { requireColors, minColorPixels } = entry ?? {};
  const minDataResponses = entry?.minDataResponses;

  if (requireColors !== undefined) {
    if (!Array.isArray(requireColors) || requireColors.length === 0) {
      problems.push(`${where}: requireColors must be a non-empty array of "#rrggbb" strings`);
    } else {
      for (const color of requireColors) {
        if (typeof color !== "string" || !HEX_COLOR.test(color)) {
          problems.push(`${where}: requireColors entry ${JSON.stringify(color)} must be lowercase "#rrggbb"`);
        }
      }
    }
  }
  if (minColorPixels !== undefined && !isPositiveInt(minColorPixels)) {
    problems.push(
      `${where}: minColorPixels must be a positive integer, got ${JSON.stringify(minColorPixels)}. ` +
        `Zero would be satisfied by a layer that painted nothing.`,
    );
  }

  if (path !== undefined && (typeof path !== "string" || path.trim() === "")) {
    problems.push(`${where}: path must be a non-empty string`);
  }
  if (wait !== undefined && !(isFiniteNumber(wait) && wait > 0)) {
    problems.push(`${where}: wait must be a positive number of milliseconds, got ${JSON.stringify(wait)}`);
  }

  if (requireUrls !== undefined) {
    if (!Array.isArray(requireUrls) || requireUrls.length === 0) {
      problems.push(`${where}: requireUrls must be a non-empty array of URL substrings`);
    } else {
      for (const needle of requireUrls) {
        if (typeof needle !== "string" || needle.trim().length < MIN_NEEDLE_LENGTH || !/[a-z0-9]/i.test(needle)) {
          problems.push(
            `${where}: requireUrls entry ${JSON.stringify(needle)} is not specific enough to assert anything. ` +
              `Name the dataset id, qualified table name or tile path the example loads.`,
          );
        } else if (ITEMS_URL.test(needle) && !ITEMS_NEEDLE_NAMES_COLLECTION.test(needle)) {
          problems.push(
            `${where}: requireUrls entry ${JSON.stringify(needle)} names the items endpoint rather than a collection, ` +
              `so it matches every items response on the page and the per-collection features check stops ` +
              `distinguishing them. Use the full path, e.g. "/collections/<dataset-id>/items".`,
          );
        }
      }
    }
  }

  if (minDataResponses !== undefined && !isPositiveInt(minDataResponses)) {
    problems.push(
      `${where}: minDataResponses must be a positive integer, got ${JSON.stringify(minDataResponses)}. ` +
        `Zero would be satisfied by an example that loaded nothing.`,
    );
  }
  if (minDistinctColors !== undefined && !(Number.isInteger(minDistinctColors) && minDistinctColors >= MIN_DISTINCT_FLOOR)) {
    problems.push(
      `${where}: minDistinctColors must be an integer of at least ${MIN_DISTINCT_FLOOR}, got ${JSON.stringify(minDistinctColors)}. ` +
        `A map that failed to draw measures exactly 1 distinct color.`,
    );
  }
  if (minInkFraction !== undefined && !(isFiniteNumber(minInkFraction) && minInkFraction > 0 && minInkFraction <= 1)) {
    problems.push(
      `${where}: minInkFraction must be greater than 0 and at most 1, got ${JSON.stringify(minInkFraction)}. ` +
        `Zero would be satisfied by a blank canvas.`,
    );
  }
  if (cropFraction !== undefined && !(isFiniteNumber(cropFraction) && cropFraction > 0 && cropFraction <= MAX_CROP_FRACTION)) {
    problems.push(
      `${where}: cropFraction must be greater than 0 and at most ${MAX_CROP_FRACTION}, got ${JSON.stringify(cropFraction)}. ` +
        `Sampling more than that reaches the corners, where the zoom control and attribution paint ` +
        `pixels a dead map can hide behind.`,
    );
  }
}

function loadManifest() {
  const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
  const problems = [];
  if (!Array.isArray(manifest)) problems.push("manifest.json must be an array");
  else {
    manifest.forEach((entry, i) => {
      validateEntry(entry, `manifest[${i}]${entry?.path ? ` (${entry.path})` : ""}`, problems);
    });
  }

  if (problems.length > 0) {
    console.error("Invalid ci/manifest.json:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  return manifest;
}

// A needle names a demo fixture, and those are hardcoded across this repo.
// ci/fixtures.json is where they are declared and ci/check-fixtures.mjs
// preflights them, so a needle naming one that file has never heard of is a
// fixture nothing preflights: when the demo is reset, that entry fails here
// with no sign that the reset is the cause.
//
// The needle is read by the shape of the demo path rather than by the shape
// of the value, so a share token, a Records collection or a tile path counts
// as much as a UUID: the segment after /api/collections/, /api/tiles/,
// /raster-tiles/, /m/ or /api/stac/ is the thing a fixture must name.
//
// A note and not a failure. This is a registration reminder resting on a
// pattern match, and a heuristic that can block a PR gets deleted the first
// time it is wrong.
const FIXTURE_PATH = /(?:\/api\/collections|\/api\/tiles|\/raster-tiles|\/m|\/api\/stac)\/([A-Za-z0-9_.-]+)/g;

function noteUnregisteredFixtures(manifest) {
  let fixtures;
  try {
    fixtures = readFileSync(join(HERE, "fixtures.json"), "utf8");
  } catch {
    return; // ponytail: no fixtures.json in this checkout, nothing to compare against.
  }
  for (const entry of manifest) {
    for (const needle of entry.requireUrls) {
      for (const [, segment] of needle.matchAll(FIXTURE_PATH)) {
        // "data." alone is a prefix the TypeScript example matches any table
        // with, not a fixture; a segment that is only a route word (search,
        // items) names nothing either.
        if (segment === "data." || ["search", "items", "collections", "conformance"].includes(segment)) continue;
        if (fixtures.includes(segment)) continue;
        console.log(
          `note: ${entry.path} requires "${needle}", whose segment "${segment}" ci/fixtures.json does not name, so ` +
            `ci/check-fixtures.mjs never preflights it. Add it there, and a demo reset reads as a reset.`,
        );
      }
    }
  }
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
// A row claims verification in one of two forms, because the table has already
// changed shape once mid-flight:
//
//   "Verified live" in a Status column   (the older shape; note the Python row
//                                         said "Verified: runs green with one
//                                         command", which is a different claim
//                                         and correctly does not match)
//   a [Live](...) link in a Run it cell  (the current shape, where the claim
//                                         itself moved into one sentence under
//                                         the table asserting that every
//                                         browser row is checked)
//
// Rows offering a command instead (`uv run python/analyze.py`, the `claude mcp
// add` line) are verified by other jobs, and rows saying Planned assert
// nothing. Both are recognised by what the row offers rather than by directory
// name, so new planned rows and new tools keep working without editing this
// file. Those command rows used to be the only ones in the table nothing read,
// which is how they drifted from index.html for a full review round;
// checkReadmeCommandsMatchGallery below now pairs each one with its gallery
// card (#16).
//
// Rows are read whole, never by column position: this table gained a column
// change and a semantic relocation in a single commit, and a check that breaks
// on that gets deleted the first time it is inconvenient.
const CLAIM_MARKERS = [/verified live/i, /\[Live\]\(/i];
const claimsVerification = (row) => CLAIM_MARKERS.some((re) => re.test(row));

// Paths, not directories: rows now name the exact file, so `maplibre/x.html`
// has to match a manifest entry rather than merely landing in a directory that
// has some other entry in it. A trailing slash means the row names a directory.
const PATH_IN_BACKTICKS = /`([A-Za-z0-9][\w.-]*\/[\w./-]*)`/g;
const PATH_IN_LINK_TARGET = /\]\(([A-Za-z0-9][\w.-]*\/[\w./-]*)\)/g;

function pathsIn(row) {
  const paths = new Set();
  for (const re of [PATH_IN_BACKTICKS, PATH_IN_LINK_TARGET]) {
    for (const m of row.matchAll(re)) paths.add(m[1]);
  }
  return paths;
}

function checkReadmeAgainstCi(manifest) {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const problems = [];

  const manifestPaths = new Set(manifest.map((e) => e.path));

  // A directory claim covers every browser example the directory holds, not
  // whichever one happens to have an entry. Backing it by "any entry under
  // this directory" let a tenth maplibre example land unverified while the
  // other three kept the row green, and let an entry be deleted while the row
  // still claimed it — the drift this check exists to catch, surviving inside
  // the check.
  const unbacked = (path) => {
    if (!path.endsWith("/")) return manifestPaths.has(path) ? [] : [path];
    const dir = path.slice(0, -1);
    let examples;
    try {
      examples = readdirSync(join(REPO, dir), { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".html"))
        .map((d) => `${dir}/${d.name}`);
    } catch {
      return [`${path} (no such directory in this checkout)`];
    }
    if (examples.length === 0) return [`${path} (contains no browser examples)`];
    return examples.filter((e) => !manifestPaths.has(e));
  };

  const rows = readme.split("\n").filter((l) => l.trimStart().startsWith("|"));
  const claiming = rows.filter(claimsVerification);

  // If the table gets reshaped again into something neither marker matches,
  // this check would go on passing while asserting nothing at all, which is the
  // failure it exists to prevent. So say so instead.
  if (rows.length > 0 && claiming.length === 0) {
    problems.push(
      "no row in README.md claims verification in a form this check recognises, " +
        "so it is asserting nothing. The table shape has probably changed again: " +
        "update CLAIM_MARKERS in ci/verify-examples.mjs to match how a row now says it is checked.",
    );
  }

  for (const row of claiming) {
    const paths = pathsIn(row);
    if (paths.size === 0) {
      problems.push(`README.md row claims verification but names no example path: ${row.trim().slice(0, 90)}`);
      continue;
    }
    for (const path of paths) {
      for (const missing of unbacked(path)) {
        problems.push(
          `README.md offers ${path} as checked against the live demo, but ci/manifest.json has no entry for ` +
            `${missing}, so nothing checks it. Add a manifest entry, or stop claiming the row is verified.`,
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

// The other pair of hand-maintained copies, and the one nothing was reading.
// README.md's Examples table offers a paste-able command in the `Run it` cell
// of every row no browser job can check, and index.html carries that same
// command again as the `address` of the matching gallery card. Both drifted in
// #10: the README was corrected, index.html was not, and CI stayed green for a
// full review round because no job compared the two files (#16).
//
// Two copies is fine. Two copies with nothing reading them shipped a broken
// command to the page a reader is most likely to paste from.
//
// Both sides go through one predicate, so neither list can hide in the other's
// blind spot. What each side offers up for comparison:
//
//   README   a table cell that is entirely one code span and nothing else.
//            Read from a row's cells, never from a column index — this table
//            has already gained a column and moved a claim between columns in
//            a single commit, and a check that breaks on that gets deleted the
//            first time it is inconvenient.
//   index    the `address:` string literal of a card in the EXAMPLES array.
//
// and then what makes one of those a command rather than an endpoint: it opens
// with an executable name followed by an argument. Every endpoint address on
// either side opens with "/" or with a scheme ("https://demo..." on the QGIS
// row), including the two carrying prose after it ("/api/ → collectionId"),
// so the two populations do not overlap: a scheme's ":" cannot sit inside the
// executable name the command shape requires.
//
// Compared PAIRWISE, by identity, never as two sets of strings. Set equality is
// the tempting shape and it is wrong: swap the `address` of two existing cards
// and both sets still hold the same three commands, so the check passes green
// while every card shows another example's command. The association between a
// row and its card IS the thing #16 is about, so the check has to carry it.
//
// The identity on each side is the example path: the README row names it
// (`python/analyze.py`, `mcp/`, `cli/`) and the card carries it as `source`.
// They agree exactly for the file rows. The directory rows do not, and the
// rule says so rather than being loosened until it passes:
//
//   a README path pairs with a card `source` when the two are equal, or when
//   the path names a directory (trailing "/") and the source is a file under it
//
// which is what lets the row saying `mcp/` pair with the card sourced at
// `mcp/README.md`. That card's `source` also builds the "View source"
// link, so it is not free to rewrite to satisfy this check.
//
// A rule that can match loosely can match twice, and a check that silently
// picks one of two candidates has swapped one blind spot for another. So the
// pairing must be exactly one card per row and one row per card; anything else
// is a failure, in both directions.
const COMMAND_SHAPE = /^[a-z][a-z0-9_.+-]*\s+\S/i;
const CELL_IS_ONE_CODE_SPAN = /^`([^`]+)`$/;
const CARD_ADDRESS = /[{,]\s*address:\s*("(?:[^"\\]|\\.)*")/;
const CARD_SOURCE = /[{,]\s*source:\s*("(?:[^"\\]|\\.)*")/;

// Splits the EXAMPLES array into one text chunk per card object, so `address`
// and `source` can be read off the SAME card. Reading each key independently
// with a global regex would produce two parallel lists and lose exactly the
// association this check now depends on.
//
// Brace depth with string tracking rather than a line-shape heuristic: card
// addresses are full of braces ("/tiles/{z}/{x}/{y}.png"), and every one of
// them sits inside a string literal.
function cardObjects(html) {
  const arrayStart = html.indexOf("const EXAMPLES = [");
  if (arrayStart === -1) return null;
  const objects = [];
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = html.indexOf("[", arrayStart); i < html.length; i++) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) objects.push(html.slice(start, i + 1));
    } else if (ch === "]" && depth === 0) break;
  }
  return objects;
}

function checkReadmeCommandsMatchGallery() {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const html = readFileSync(join(REPO, "index.html"), "utf8");
  const problems = [];

  // Each command row carries the example path(s) that say which card it is.
  // pathsIn() is the same reader the claims check uses, and it cannot pick the
  // command cell up as a path: a path pattern anchors on a backtick and allows
  // no spaces, so `uv run python/analyze.py` matches nothing.
  const rows = readme.split("\n").filter((l) => l.trimStart().startsWith("|"));
  const commandRows = [];
  for (const row of rows) {
    let command = null;
    for (const cell of row.split("|").map((c) => c.trim())) {
      const span = CELL_IS_ONE_CODE_SPAN.exec(cell);
      if (span && COMMAND_SHAPE.test(span[1])) command = span[1];
    }
    if (command !== null) commandRows.push({ command, paths: [...pathsIn(row)] });
  }

  const objects = cardObjects(html);
  const cards = [];
  for (const [i, text] of (objects ?? []).entries()) {
    const read = (re, key) => {
      const match = re.exec(text);
      if (match === null) return null;
      try {
        return JSON.parse(match[1]);
        // Never skipped quietly. A value this check cannot read is a value it
        // is not comparing, and a comparison that silently stops covering one
        // of its inputs is the exact state issue #16 exists to end.
      } catch {
        problems.push(
          `index.html card ${i} carries a ${key} literal this check cannot read: ${match[1].slice(0, 60)}. ` +
            `Keep it a plain double-quoted string, or teach CARD_${key.toUpperCase()} the new form.`,
        );
        return null;
      }
    };
    const source = read(CARD_SOURCE, "source");
    cards.push({ address: read(CARD_ADDRESS, "address"), source, where: source ?? `EXAMPLES[${i}]` });
  }

  // The guards that keep this from decaying into decoration. Reshape either
  // side past what the patterns above recognise and every comparison below
  // ranges over an empty set: green, and asserting nothing, which is
  // indistinguishable from the drift it is here to catch. So say so instead.
  if (rows.length > 0 && commandRows.length === 0) {
    problems.push(
      "no README.md table cell offers a command in a form this check recognises, so it is asserting nothing. " +
        "The Examples table has probably changed shape again: update CELL_IS_ONE_CODE_SPAN or COMMAND_SHAPE in " +
        "ci/verify-examples.mjs to match how a row now offers a command to paste.",
    );
  }
  if (objects === null || cards.every((c) => c.address === null)) {
    problems.push(
      "index.html has no card `address:` values this check can read, so it is asserting nothing. The EXAMPLES " +
        "array has probably changed shape: update cardObjects() or CARD_ADDRESS in ci/verify-examples.mjs.",
    );
  }

  // The rule, stated once and used in both directions.
  const pairs = (path, source) =>
    source !== null && (path.endsWith("/") ? source.startsWith(path) : source === path);

  for (const row of commandRows) {
    if (row.paths.length === 0) {
      problems.push(
        `README.md offers \`${row.command}\` on a row that names no example path, so nothing identifies which ` +
          `gallery card it belongs to. Name the example the command runs.`,
      );
      continue;
    }
    const matched = cards.filter((card) => row.paths.some((path) => pairs(path, card.source)));
    if (matched.length === 0) {
      problems.push(
        `README.md offers \`${row.command}\` for ${row.paths.join(", ")}, but no gallery card in index.html is ` +
          `sourced there, so the command reaches readers on the landing page unchecked.`,
      );
    } else if (matched.length > 1) {
      problems.push(
        `README.md's row for ${row.paths.join(", ")} pairs with ${matched.length} gallery cards ` +
          `(${matched.map((c) => c.where).join(", ")}), so the check cannot say which one it is comparing. ` +
          `Make the sources distinct, or tighten the pairing rule in ci/verify-examples.mjs.`,
      );
    } else if (matched[0].address === null) {
      problems.push(
        `README.md offers \`${row.command}\` for ${row.paths.join(", ")}, but the gallery card sourced at ` +
          `${matched[0].where} has no address this check can read, so the two are not being compared.`,
      );
    } else if (matched[0].address !== row.command) {
      problems.push(
        `README.md offers \`${row.command}\` for ${row.paths.join(", ")}, but the gallery card sourced at ` +
          `${matched[0].where} shows \`${matched[0].address}\`. These are two copies of one paste-able command; ` +
          `fix whichever one is wrong.`,
      );
    }
  }

  for (const card of cards) {
    if (card.address === null || !COMMAND_SHAPE.test(card.address)) continue;
    const matched = commandRows.filter((row) => row.paths.some((path) => pairs(path, card.source)));
    if (matched.length === 0) {
      problems.push(
        `index.html's card sourced at ${card.where} shows the command \`${card.address}\`, which no row of ` +
          `README.md's Examples table offers, so nothing checks it.`,
      );
    } else if (matched.length > 1) {
      problems.push(
        `index.html's card sourced at ${card.where} pairs with ${matched.length} README.md rows ` +
          `(${matched.map((r) => r.paths.join(", ")).join("; ")}), so the check cannot say which one it is ` +
          `comparing. Tighten the pairing rule in ci/verify-examples.mjs.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("README.md and index.html disagree:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
}

// A `python3 -m http.server 8000` left running in a different checkout answers
// on that port just as happily as yours, and a second one started on top of it
// fails to bind while the `&` hides the error. The run then verifies someone
// else's files and passes, which is the one outcome worse than failing.
//
// So prove the server is serving THIS checkout before trusting a single
// assertion: every page under test has to come back over HTTP byte-identical
// to the file on disk next to the manifest that named it.
async function assertServerServesThisCheckout(manifest) {
  const problems = [];
  for (const entry of manifest) {
    let local;
    try {
      local = readFileSync(join(REPO, entry.path), "utf8");
    } catch {
      problems.push(`${entry.path}: named in ci/manifest.json but not present in this checkout`);
      continue;
    }
    try {
      const res = await fetch(`${BASE}/${entry.path}`);
      if (!res.ok) {
        problems.push(`${entry.path}: ${BASE} answered ${res.status}`);
      } else if ((await res.text()) !== local) {
        problems.push(`${entry.path}: ${BASE} serves different bytes than this checkout`);
      }
    } catch (err) {
      problems.push(`${entry.path}: cannot reach ${BASE} (${String(err).split("\n")[0]})`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `${BASE} is not serving this checkout:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nStart the server from ${REPO}, and check nothing else already holds that port.`,
    );
    process.exit(1);
  }
}

// Decode the screenshot in the browser we already have rather than pulling in
// a PNG library: a data: URL is CORS-clean, so getImageData() works on it.
async function pixelStats(scratch, png, requireColors = []) {
  return scratch.evaluate(async ([src, wanted]) => {
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
    const colorCounts = {};
    for (const hex of wanted) colorCounts[hex] = counts.get(parseInt(hex.slice(1), 16)) ?? 0;
    return {
      distinct: counts.size,
      modal: `#${modal.toString(16).padStart(6, "0")}`,
      inkFraction: 1 - modalCount / total,
      colorCounts,
    };
  }, [`data:image/png;base64,${png.toString("base64")}`, requireColors]);
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
  return { crop, stats: await pixelStats(scratch, crop, entry.requireColors ?? []) };
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
  // Recorded per response and aggregated per required collection at assert
  // time, never into one page-wide counter. Pushed from inside the body-read
  // continuation, so a response landing as the run ends cannot look like
  // "fetched but empty".
  const itemsBodies = [];

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
      // Recorded synchronously, in the response handler, before any await can
      // intervene. The read that fills it in is asynchronous, so if the
      // assertions ever run before it resolves the entry is still `pending`
      // and fails on that. Evidence that exists but was not waited for is
      // evidence not checked, and this makes that state visible instead of
      // absent.
      const record = { url, features: 0, unreadable: null, mismatch: null, pending: true };
      itemsBodies.push(record);
      bodyReads.push(
        // Bounded, never bare: see BODY_READ_TIMEOUT_MS. A stalled body lands
        // in the rejection handler below like any other unreadable one.
        withTimeout(
          res.json(),
          BODY_READ_TIMEOUT_MS,
          `body never finished arriving, ${BODY_READ_TIMEOUT_MS}ms after the 200`,
        ).then(
          (body) => {
            // The features array is the evidence; numberReturned is the
            // server's claim about itself. Taking the larger of the two let
            // {"numberReturned": 496, "features": []} record 496 features the
            // client never received and could not draw — this file exists
            // because a 200 is a claim rather than evidence, so it must not
            // trust a count over the artifact.
            record.pending = false;
            const features = Array.isArray(body?.features) ? body.features : null;
            if (features === null) {
              record.unreadable = "parsed as JSON but carries no features array, so it is not a FeatureCollection";
              return;
            }
            record.features = features.length;
            const claimed = body?.numberReturned;
            // Worth its own failure rather than silently preferring one: if
            // these ever disagree it is a server bug, not a test nuance.
            if (typeof claimed === "number" && claimed !== features.length) {
              record.mismatch = `claims numberReturned=${claimed} but carries ${features.length} feature(s)`;
            }
          },
          // Recorded against the collection, never swallowed. A discarded
          // parse failure removes that collection from byCollection entirely,
          // so a required layer serving garbage behind a 200 was skipped by
          // the features check while the URL and response-count assertions
          // both accepted the 200 and the surviving layer carried the paint
          // proof. Required data that arrived and cannot be understood is a
          // failure, not an absence.
          (err) => {
            record.pending = false;
            record.unreadable = String(err).split("\n")[0];
          },
        ),
      );
    }
  });

  await page.goto(`${BASE}/${entry.path}`, { waitUntil: "load" });
  await page.waitForTimeout(entry.wait);

  const { crop, stats } = await renderProof(page, scratch, entry);
  // Promise.allSettled snapshots its iterable, so a body read appended while
  // it is awaiting would never be waited on: with several ArcGIS /items
  // requests in flight, one can land after the snapshot, and its body would
  // then miss the assertions entirely. Drain until the list stops growing.
  //
  // This loop is why every read is bounded: it waits for all of them, so one
  // that never settles stops the run here, before a single assertion or any
  // diagnostics (#17). Each read settles within BODY_READ_TIMEOUT_MS either way.
  for (let drained = 0; drained < bodyReads.length; ) {
    const batch = bodyReads.slice(drained);
    drained = bodyReads.length;
    await Promise.allSettled(batch);
  }

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
  // Per collection, never pooled across the page. A single page-wide "at least
  // one non-empty body" counter passes when one of two collections vanishes:
  // the surviving layer satisfies the counter, satisfies the render proof by
  // painting, and both URLs still answer 2xx. The stations layer could
  // disappear from maplibre/features.html and CI stayed green.
  //
  // Collections are grouped by the items URL minus its query string, derived
  // from what the page actually fetched rather than from what the manifest
  // declares. Grouping by requireUrls needle had the same hole one level down:
  // a needle broad enough to match every items response ("/items", or "items",
  // both of which pass validation) pooled the collections straight back
  // together. There is no configuration in this grouping, so there is nothing
  // to configure away.
  //
  // Still "at least one non-empty per collection" rather than "every response
  // non-empty": ArcGIS's OGCFeatureLayer fetches the same collection once per
  // viewport tile and legitimately gets empty answers for tiles the data does
  // not reach.
  const byCollection = new Map();
  for (const body of itemsBodies) {
    const collection = body.url.split("?")[0];
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push(body);
  }
  for (const [collection, bodies] of byCollection) {
    const mismatched = bodies.filter((b) => b.mismatch);
    if (mismatched.length > 0) {
      failures.push(`${collection} ${mismatched[0].mismatch} — the response contradicts itself`);
    }
    const pending = bodies.filter((b) => b.pending);
    const unreadable = bodies.filter((b) => b.unreadable);
    if (pending.length > 0) {
      failures.push(
        `${pending.length} of ${bodies.length} /items response(s) for ${collection} arrived but were never ` +
          `finished being read, so this run cannot say what that layer received`,
      );
    } else if (unreadable.length > 0) {
      failures.push(
        `${unreadable.length} of ${bodies.length} /items response(s) for ${collection} answered 200 with a body ` +
          `that could not be parsed (${unreadable[0].unreadable}) — required data arrived and cannot be understood`,
      );
    } else if (!bodies.some((b) => b.features > 0)) {
      failures.push(
        `every /items response for ${collection} came back empty (${bodies.length} response(s), 0 features) — ` +
          `that layer is missing from the map even though the page still renders`,
      );
    }
  }
  if (stats.distinct < minDistinct || stats.inkFraction < minInk) {
    failures.push(`nothing painted: center of the viewport has ${stats.distinct} distinct colors (need ${minDistinct}) and ${(stats.inkFraction * 100).toFixed(2)}% non-background pixels (need ${(minInk * 100).toFixed(2)}%), modal color ${stats.modal}`);
  }
  // Per documented layer, where the checks above only prove that something
  // painted. Delete the stations layer from a features page and both /items
  // responses stay populated, both collections pass, and the surviving lines
  // clear the ink and distinct-color floors on their own.
  const minColorPixels = entry.minColorPixels ?? DEFAULTS.minColorPixels;
  for (const color of entry.requireColors ?? []) {
    const painted = stats.colorCounts?.[color] ?? 0;
    if (painted < minColorPixels) {
      failures.push(
        `the layer painted ${color} covers ${painted} pixel(s), need ${minColorPixels} — ` +
          `a documented layer is not drawing even though the page renders`,
      );
    }
  }

  const summary =
    `consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} ` +
    `failedRequests=${failedRequests.length} thirdParty=${thirdPartyIssues.length} ` +
    `aborted=${abortedRequests.length} dataResponses=${dataResponses.length} ` +
    `emptyTiles=${emptyTiles} items=${itemsBodies.filter((b) => b.features > 0).length}/${itemsBodies.length} ` +
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
noteUnregisteredFixtures(manifest);
checkReadmeAgainstCi(manifest);
checkReadmeCommandsMatchGallery();

const entries = ONLY ? manifest.filter((e) => ONLY.includes(e.path)) : manifest;
if (entries.length === 0) {
  console.error(`ONLY=${process.env.ONLY} matched no manifest entry`);
  process.exit(1);
}

await assertServerServesThisCheckout(entries);

rmSync(DIAGNOSTICS, { recursive: true, force: true });

const browser = await chromium.launch();
const scratch = await browser.newPage();
await scratch.setContent("<!doctype html><title>pixel scratch</title>");

const failed = [];
let pagesRun = 0;
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
    if (pagesRun > 0) await sleep(PAGE_GAP_MS);
    pagesRun += 1;
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
      // Losing the evidence must not also lose the verdict: the failure is
      // already recorded and printed, so a broken screenshot or an unreadable
      // page here degrades to a note rather than crashing the run and
      // truncating the summary of everything else.
      try {
        const dir = writeDiagnostics(entry, last.failures, await last.collect());
        console.log(`    diagnostics written to ${dir}`);
      } catch (err) {
        console.log(`    could not write diagnostics: ${String(err).split("\n")[0]}`);
      }
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
