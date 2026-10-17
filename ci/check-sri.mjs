// Subresource Integrity check for the CDN assets the example pages load.
//
// Every classic <script src> and <link href> that points at a version-pinned
// CDN file must carry `integrity` and `crossorigin="anonymous"`, and the
// sha384 must match the file the CDN serves today. The import map in a page
// can carry hashes for module files too (the browser applies them to the
// static `import` of that same URL), so each CDN URL it maps needs one.
//
// What is left out, on purpose: `<script type="module" src>` (floating
// js.arcgis.com/5.1/ has no fixed bytes to hash), esm.sh module graphs, and
// anything a library fetches for itself (workers, Cesium assets). CONTRIBUTING
// says so.
//
// Usage: node ci/check-sri.mjs            verify every page
//        node ci/check-sri.mjs --write    add or refresh the hashes in place
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", ".claude", "node_modules", "assets", "diagnostics"]);
const CDN = /^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//;
const write = process.argv.includes("--write");

function* pages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* pages(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1];

// A stalled CDN fails here per URL instead of running into the job timeout.
const DEADLINE = AbortSignal.timeout(120_000);
const hashes = new Map();
async function sha384(url) {
  if (!hashes.has(url)) {
    hashes.set(
      url,
      fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(20_000), DEADLINE]) }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        return `sha384-${createHash("sha384").update(body).digest("base64")}`;
      }),
    );
  }
  return hashes.get(url);
}

const failures = [];
const fail = (file, url, why) => failures.push(`${relative(ROOT, file)}: ${url} ${why}`);

for (const file of pages(ROOT)) {
  let html = readFileSync(file, "utf8");
  const original = html;

  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of tags) {
    const isScript = tag.startsWith("<script");
    const url = attr(tag, isScript ? "src" : "href");
    if (!url || !CDN.test(url) || (isScript && attr(tag, "type") === "module")) continue;
    let want;
    try {
      want = await sha384(url);
    } catch (error) {
      fail(file, url, `could not be fetched (${error.message})`);
      continue;
    }
    if (write) {
      const fresh = tag
        .replace(/\s+integrity="[^"]*"/, "")
        .replace(/\s+crossorigin(="[^"]*")?/, "")
        .replace(/\s*\/?>$/, (end) => ` integrity="${want}" crossorigin="anonymous"${end.trim() === "/>" ? " />" : ">"}`);
      html = html.replace(tag, fresh);
      continue;
    }
    const have = attr(tag, "integrity");
    if (!have) fail(file, url, "has no integrity attribute");
    else if (have !== want) fail(file, url, `integrity is ${have}, the CDN serves ${want}`);
    if (attr(tag, "crossorigin") !== "anonymous") fail(file, url, 'needs crossorigin="anonymous"');
  }

  for (const [, body] of html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
    const map = JSON.parse(body);
    const before = JSON.stringify(map);
    const urls = [
      ...Object.values(map.imports ?? {}),
      ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope)),
    ].filter((u) => CDN.test(u));
    for (const url of new Set(urls)) {
      let want;
      try {
        want = await sha384(url);
      } catch (error) {
        fail(file, url, `could not be fetched (${error.message})`);
        continue;
      }
      if (write) {
        map.integrity = { ...map.integrity, [url]: want };
        continue;
      }
      const have = map.integrity?.[url];
      if (!have) fail(file, url, "has no import map integrity entry");
      else if (have !== want) fail(file, url, `import map integrity is ${have}, the CDN serves ${want}`);
    }
    if (write && JSON.stringify(map) !== before) {
      html = html.replace(body, () => `\n${JSON.stringify(map, null, 2).replace(/^/gm, "    ")}\n  `);
    }
  }

  if (write && html !== original) writeFileSync(file, html);
}

if (failures.length) {
  console.error(`SRI check failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
if (write) console.log(`Hashes written for ${hashes.size} CDN files`);
else console.log(`SRI ok: ${hashes.size} CDN files match their integrity hashes`);
