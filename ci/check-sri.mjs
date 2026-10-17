// Subresource Integrity check for the CDN assets the example pages load.
//
// Every classic <script src> and <link href> that points at a version-pinned
// CDN file must carry `integrity` and `crossorigin="anonymous"`, and the
// sha384 must match the file the CDN serves today. The import map in a page
// can carry hashes for module files too (the browser applies them to the
// static `import` of that same URL), so each CDN URL it maps needs one.
//
// What is left out, on purpose: the floating js.arcgis.com/5.1/ loader (no
// fixed bytes to hash; it is not on a pinned CDN host), esm.sh module graphs, and
// anything a library fetches for itself (workers, Cesium assets). CONTRIBUTING
// says so.
//
// Discovery fails closed. Any <script> or <link> start tag that mentions a CDN
// host must be written in the one form this script parses: lowercase tag and
// attribute names, double-quoted values, an https URL, and at most one
// `integrity` and one `crossorigin`. Single quotes, unquoted values,
// protocol-relative URLs and the like are reported instead of skipped, and
// `--write` never edits a tag it cannot parse. The same goes for an import map.
//
// Usage: node ci/check-sri.mjs              verify every page
//        node ci/check-sri.mjs --write      add or refresh the hashes in place
//        node ci/check-sri.mjs --self-test  check the discovery rules offline
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", ".claude", "node_modules", "assets", "diagnostics"]);
const CDN_HOST = /unpkg\.com|cdn\.jsdelivr\.net/i;
const CDN_URL = /^https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)\/[^\s"']+$/;
const CDN = /^https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)\//;

function* pages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* pages(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

// A stalled CDN fails here per URL instead of running into the job timeout.
const DEADLINE = AbortSignal.timeout(120_000);
const hashes = new Map();
async function sha384(url) {
  if (!hashes.has(url)) {
    hashes.set(
      url,
      fetch(url, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(20_000), DEADLINE]) }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        return `sha384-${createHash("sha384").update(body).digest("base64")}`;
      }),
    );
  }
  return hashes.get(url);
}

const FORM =
  'write it as <script src="https://..." integrity="sha384-..." crossorigin="anonymous"> or ' +
  '<link href="https://..." integrity="..." crossorigin="anonymous">: lowercase names, double quotes, one of each attribute';

// Parses the strict form only: `<name attr="value" flag />`. Returns null for
// anything else, which the caller reports when the tag mentions a CDN.
function parseTag(tag) {
  const m = tag.match(/^<(script|link)((?:\s+[a-z][a-z-]*(?:="[^"<>]*")?)*)\s*(\/?)>$/);
  if (!m) return null;
  const attrs = [...m[2].matchAll(/\s+([a-z][a-z-]*)(?:="([^"]*)")?/g)].map((a) => ({ name: a[1], value: a[2] }));
  return { name: m[1], attrs, selfClose: m[3] === "/" };
}

const get = (parsed, name) => parsed.attrs.filter((a) => a.name === name);

// Returns the page with hashes written (write mode) and the problems found.
// `hashOf` is injected so the self-test needs no network.
export async function processHtml(html, { write, hashOf }) {
  const problems = [];
  const edits = [];
  const note = (url, why) => problems.push(`${url} ${why}`);

  for (const m of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const isScript = /^<script/i.test(tag);
    if (isScript && /importmap/i.test(tag)) continue;
    // A browser decodes `unpkg%2ecom` or `unpkg&#46;com` to a CDN host that the
    // raw-text test below would miss, so an encoded URL is refused outright.
    const raw = tag.match(/\s(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? "";
    if (/[%&\\]/.test(raw)) {
      note(tag, `has a percent-encoded, entity-encoded or backslashed URL; write it plainly`);
      continue;
    }
    if (!CDN_HOST.test(tag)) continue;
    const parsed = parseTag(tag);
    const urlName = isScript ? "src" : "href";
    if (!parsed || parsed.name !== (isScript ? "script" : "link")) {
      note(tag, `is not in the form this check parses; ${FORM}`);
      continue;
    }
    const urls = get(parsed, urlName);
    const url = urls[0]?.value;
    if (urls.length !== 1 || !url || !CDN_URL.test(url)) {
      note(tag, `needs exactly one double-quoted https ${urlName} on the CDN; ${FORM}`);
      continue;
    }
    const [integrity, crossorigin] = [get(parsed, "integrity"), get(parsed, "crossorigin")];
    if (integrity.length > 1 || crossorigin.length > 1) {
      note(url, `repeats integrity or crossorigin; ${FORM}`);
      continue;
    }
    let want;
    try {
      want = await hashOf(url);
    } catch (error) {
      note(url, `could not be fetched (${error.message})`);
      continue;
    }
    const upToDate = integrity[0]?.value === want && crossorigin[0]?.value === "anonymous";
    if (write) {
      if (upToDate) continue;
      const kept = parsed.attrs.filter((a) => a.name !== "integrity" && a.name !== "crossorigin");
      const attrs = [...kept, { name: "integrity", value: want }, { name: "crossorigin", value: "anonymous" }]
        .map((a) => (a.value === undefined ? a.name : `${a.name}="${a.value}"`))
        .join(" ");
      edits.push([tag, `<${parsed.name} ${attrs}${parsed.selfClose ? " /" : ""}>`]);
      continue;
    }
    if (!integrity.length) note(url, "has no integrity attribute");
    else if (integrity[0].value !== want) note(url, `integrity is ${integrity[0].value}, the CDN serves ${want}`);
    if (crossorigin[0]?.value !== "anonymous") note(url, 'needs crossorigin="anonymous"');
  }

  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/importmap/i.test(m[0].slice(0, m[0].indexOf(">") + 1))) continue;
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    if (openTag !== '<script type="importmap">') {
      note(openTag, 'is an import map this check cannot parse; write it exactly as <script type="importmap">');
      continue;
    }
    let map;
    try {
      map = JSON.parse(m[1]);
    } catch (error) {
      note(openTag, `holds JSON that does not parse (${error.message})`);
      continue;
    }
    const before = JSON.stringify(map);
    const urls = [
      ...Object.values(map.imports ?? {}),
      ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope)),
    ].filter((u) => CDN_HOST.test(u));
    for (const url of new Set(urls)) {
      if (!CDN.test(url)) {
        note(url, "in the import map must be an https URL on the CDN");
        continue;
      }
      let want;
      try {
        want = await hashOf(url);
      } catch (error) {
        note(url, `could not be fetched (${error.message})`);
        continue;
      }
      if (write) {
        map.integrity = { ...map.integrity, [url]: want };
        continue;
      }
      const have = map.integrity?.[url];
      if (!have) note(url, "has no import map integrity entry");
      else if (have !== want) note(url, `import map integrity is ${have}, the CDN serves ${want}`);
    }
    if (write && JSON.stringify(map) !== before) {
      edits.push([m[1], `\n${JSON.stringify(map, null, 2).replace(/^/gm, "    ")}\n  `]);
    }
  }

  for (const [from, to] of edits) html = html.replace(from, () => to);
  return { html, problems };
}

async function selfTest() {
  const STUB = "sha384-STUB";
  const hashOf = async () => STUB;
  const css = "https://unpkg.com/lib@1.0.0/lib.css";
  const js = "https://cdn.jsdelivr.net/npm/lib@1.0.0/lib.js";
  const good = `<script src="${js}" integrity="${STUB}" crossorigin="anonymous"></script>`;
  const bypass = {
    "single-quoted src": `<script src='${js}'></script>`,
    "unquoted src": `<script src=${js}></script>`,
    "uppercase tag": `<SCRIPT src="${js}"></SCRIPT>`,
    "uppercase attribute": `<script SRC="${js}"></script>`,
    "uppercase host": `<link href="https://UNPKG.COM/lib@1.0.0/lib.css" rel="stylesheet">`,
    "whitespace around the URL": `<script src=" ${js} "></script>`,
    "protocol-relative URL": `<script src="//unpkg.com/lib@1.0.0/lib.js"></script>`,
    "single-quoted integrity": `<script src="${js}" integrity='${STUB}' crossorigin="anonymous"></script>`,
    "duplicate integrity": `<script src="${js}" integrity="${STUB}" integrity="sha384-OLD" crossorigin="anonymous"></script>`,
    "duplicate crossorigin": `<script src="${js}" integrity="${STUB}" crossorigin="anonymous" crossorigin="use-credentials"></script>`,
    "import map with single quotes": `<script type='importmap'>{"imports":{"a":"${js}"}}</script>`,
    "import map with an extra attribute": `<script type="importmap" nonce="x">{"imports":{"a":"${js}"}}</script>`,
    "uppercase import map type": `<script type="IMPORTMAP">{"imports":{"a":"${js}"}}</script>`,
    "import map that is not JSON": `<script type="importmap">{</script>`,
  };
  let bad = 0;
  const expect = (name, ok) => {
    if (!ok) {
      bad++;
      console.error(`  FAIL ${name}`);
    }
  };
  const count = (html, needle) => html.split(needle).length - 1;

  for (const [name, html] of Object.entries(bypass)) {
    const verify = await processHtml(html, { write: false, hashOf });
    expect(`verify rejects ${name}`, verify.problems.length > 0);
    const wrote = await processHtml(html, { write: true, hashOf });
    expect(`--write rejects ${name}`, wrote.problems.length > 0);
    expect(`--write leaves ${name} untouched`, wrote.html === html);
  }

  expect("verify accepts the canonical script", (await processHtml(good, { write: false, hashOf })).problems.length === 0);
  const missing = `<link href="${css}" rel="stylesheet" />`;
  expect("verify rejects a missing integrity", (await processHtml(missing, { write: false, hashOf })).problems.length > 0);
  expect(
    "verify rejects a stale integrity",
    (await processHtml(good.replace(STUB, "sha384-OLD"), { write: false, hashOf })).problems.length > 0,
  );
  expect(
    "verify rejects a missing crossorigin",
    (await processHtml(good.replace(' crossorigin="anonymous"', ""), { write: false, hashOf })).problems.length > 0,
  );

  for (const [name, html] of Object.entries({
    "missing": missing,
    "stale": `<link href="${css}" integrity="sha384-OLD" rel="stylesheet" crossorigin="anonymous" />`,
  })) {
    const wrote = await processHtml(html, { write: true, hashOf });
    expect(`--write on a ${name} tag succeeds`, wrote.problems.length === 0);
    expect(`--write on a ${name} tag leaves one integrity`, count(wrote.html, "integrity=") === 1);
    expect(`--write on a ${name} tag sets the hash`, wrote.html.includes(`integrity="${STUB}"`));
    expect(`--write on a ${name} tag leaves one crossorigin`, count(wrote.html, "crossorigin=") === 1);
    expect(`--write on a ${name} tag verifies`, (await processHtml(wrote.html, { write: false, hashOf })).problems.length === 0);
  }

  const map = `<script type="importmap">{"imports":{"a":"${js}"},"scopes":{"/s/":{"b":"${css}"}}}</script>`;
  expect("verify rejects an import map with no integrity", (await processHtml(map, { write: false, hashOf })).problems.length === 2);
  const wrote = await processHtml(map, { write: true, hashOf });
  expect("--write keeps the import map scopes", wrote.html.includes('"scopes"'));
  expect("--write hashes both import map URLs", count(wrote.html, STUB) === 2);
  expect("--write output verifies", (await processHtml(wrote.html, { write: false, hashOf })).problems.length === 0);

  const plain = `<script src="/local.js"></script><script type='module'>import "x"</script><script type="module" src="https://js.arcgis.com/5.1/"></script>`;
  expect("non-CDN tags are ignored", (await processHtml(plain, { write: false, hashOf })).problems.length === 0);
  const cdnModule = `<script type="module" src="https://unpkg.com/x@1.0.0/x.mjs"></script>`;
  for (const enc of ["https://unpkg%2ecom/x@1.0.0/x.js", "https://unpkg&#46;com/x@1.0.0/x.js"]) {
    const page = `<script src="${enc}"></script>`;
    expect(`an encoded CDN host is refused (${enc})`, (await processHtml(page, { write: false, hashOf })).problems.length > 0);
  }
  expect("a CDN module script needs integrity too", (await processHtml(cdnModule, { write: false, hashOf })).problems.length > 0);

  if (bad) process.exit(1);
  console.log("SRI self-test ok");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  process.exit(0);
}

const write = process.argv.includes("--write");
const failures = [];
for (const file of pages(ROOT)) {
  const original = readFileSync(file, "utf8");
  const { html, problems } = await processHtml(original, { write, hashOf: sha384 });
  for (const problem of problems) failures.push(`${relative(ROOT, file)}: ${problem}`);
  if (write && html !== original) writeFileSync(file, html);
}

if (failures.length) {
  console.error(`SRI check failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
if (write) console.log(`Hashes written for ${hashes.size} CDN files`);
else console.log(`SRI ok: ${hashes.size} CDN files match their integrity hashes`);
