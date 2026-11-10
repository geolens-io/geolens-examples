// Subresource Integrity check for the CDN assets the example pages load.
//
// Every classic <script src> and <link href> that points at a version-pinned
// CDN file must carry `integrity` and `crossorigin="anonymous"`, and the
// sha384 must match the file the CDN serves today. The import map in a page
// can carry hashes for module files too (the browser applies them to the
// static `import` of that same URL), so each CDN URL it maps needs one. A
// literal CDN URL in an inline script's `import ... from`, `export ... from`,
// `import "..."` or `import("...")` needs an entry there too, even when the
// map has no `imports` for it.
//
// What is left out, on purpose, and the only place that says so: the floating
// js.arcgis.com/5.1/ loader (no fixed bytes to hash; it is not on a pinned CDN
// host); esm.sh, which is not in CDN_HOSTNAMES because a page can hash the
// module it imports but not the modules esm.sh's output imports in turn; and
// anything a library fetches for itself (workers, Cesium assets).
//
// Verification reads each page the way a browser does. Chromium parses the
// file with scripting off and no network, and the check looks at the DOM it
// built: every script `src`, link `href` and import map URL resolved to its
// absolute form, with the `integrity` and `crossorigin` the browser would act
// on (the first duplicate attribute wins, as in a browser). Anything that
// resolves to a CDN host has to carry a matching hash, however it is spelled.
// The DOM comes from the Playwright install the verify job already makes.
//
// `--write` edits text, so it only touches tags in one strict form: lowercase
// tag and attribute names, double-quoted values, an https URL, and at most one
// `integrity` and one `crossorigin`. A CDN asset the browser finds in any other
// spelling is reported as needing that form, and `--write` never edits a tag or
// import map it cannot parse.
//
// Usage: node ci/check-sri.mjs              verify every page
//        node ci/check-sri.mjs --write      add or refresh the hashes in place
//        node ci/check-sri.mjs --self-test  check the rules offline
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", ".claude", "node_modules", "assets", "diagnostics"]);
const CDN_HOSTNAMES = new Set(["unpkg.com", "cdn.jsdelivr.net"]);
// A trailing dot is the absolute DNS spelling of the same host.
const isCdnHost = (host) => CDN_HOSTNAMES.has(host.toLowerCase().replace(/\.$/, ""));
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

// The host a browser would load an attribute value from: numeric and the
// common named entities decoded, then the WHATWG URL parser, which also
// percent-decodes the host. Relative URLs resolve to a non-CDN base. Any other
// named entity returns null: the check can't tell where the URL points, so the
// caller refuses it rather than guess.
const NAMED = { amp: "&", period: ".", sol: "/", colon: ":", quot: '"', apos: "'" };
function resolvedHost(value) {
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => NAMED[n.toLowerCase()] ?? "\0")
    .trim();
  if (decoded.includes("\0")) return null;
  try {
    return new URL(decoded, "https://local.invalid/").hostname;
  } catch {
    return "";
  }
}

// Comments and the text inside script, style, textarea and template elements
// are blanked (same length, so offsets still match the page): a tag-shaped
// string there is not something the browser loads, and --write must not edit it.
function maskInert(html) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  // One pass, leftmost match first, so a comment opener inside a script body
  // stays script text and a script inside a comment stays commented out.
  return html.replace(
    /<!--[\s\S]*?-->|(<(script|style|textarea|template)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (all, open, _name, body, close) => (open ? open + blank(body) + close : blank(all)),
  );
}

// The value of a start tag's type attribute, whatever the quoting.
const typeOf = (tag) => {
  const m = tag.match(/\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim().toLowerCase();
};

// Specifiers an inline script imports that resolve to a CDN host: `from "u"`,
// `import "u"`, `import("u")`. A small lexer walks the code, so quoted
// strings, template text and comments are skipped rather than matched, while
// the code inside a template's ${ } is scanned like any other.
// Known gap: a regex literal that contains a quote or comment opener can
// confuse it. Specifiers are resolved against an https base, so `//unpkg.com/x`
// is found too; the caller refuses any that is not a canonical https URL. A
// specifier holding a backslash escape is refused outright rather than decoded,
// since a URL nobody can read at a glance is not one to maintain a hash for.
function importSpecifiers(code) {
  const tokens = [];
  const nested = [];
  const n = code.length;
  for (let i = 0; i < n; ) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      tokens.push({ str: code.slice(i + 1, j) });
      i = j + 1;
    } else if (c === "`") {
      const exprs = [];
      const start = i;
      i = skipTemplate(code, i, exprs);
      for (const e of exprs) nested.push(...importSpecifiers(e));
      // A template with no ${ } is a constant string and works as a specifier.
      tokens.push({ str: exprs.length ? null : code.slice(start + 1, i - 1) });
    } else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j])) j++;
      tokens.push({ word: code.slice(i, j) });
      i = j;
    } else {
      if (!/\s/.test(c)) tokens.push({ punct: c });
      i++;
    }
  }
  const found = [];
  const isStr = (t) => typeof t?.str === "string";
  for (let k = 0; k < tokens.length; k++) {
    const w = tokens[k].word;
    if (w === "from" && isStr(tokens[k + 1])) found.push(tokens[k + 1].str);
    else if (w === "import" && isStr(tokens[k + 1])) found.push(tokens[k + 1].str);
    else if (w === "import" && tokens[k + 1]?.punct === "(") {
      // import("u"), import(("u")) and import("u", options): unwrap the parens.
      let j = k + 1;
      let depth = 0;
      while (tokens[j]?.punct === "(") (depth++, j++);
      let e = j + 1;
      while (e - j - 1 < depth - 1 && tokens[e]?.punct === ")") e++;
      if (isStr(tokens[j]) && e - j - 1 === depth - 1 && [",", ")"].includes(tokens[e]?.punct)) found.push(tokens[j].str);
    }
  }
  return [...found, ...nested];
}

// Index just past the template literal that starts at `i`. Code inside ${ }
// is skipped with its braces balanced, and pushed to `exprs` when given;
// quotes and nested templates inside it are stepped over whole.
function skipTemplate(code, i, exprs) {
  const n = code.length;
  for (i++; i < n && code[i] !== "`"; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === "$" && code[i + 1] === "{") {
      let depth = 1;
      const start = i + 2;
      for (i += 2; i < n && depth; i++) {
        const c = code[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === "`") i = skipTemplate(code, i) - 1;
        else if (c === '"' || c === "'") {
          for (i++; i < n && code[i] !== c; i++) if (code[i] === "\\") i++;
        } else if (c === "/" && code[i + 1] === "/") while (i + 1 < n && code[i + 1] !== "\n") i++;
        else if (c === "/" && code[i + 1] === "*") {
          const end = code.indexOf("*/", i + 2);
          i = end < 0 ? n : end + 1;
        }
      }
      i--;
      exprs?.push(code.slice(start, i));
    }
  }
  return i + 1;
}

// The script types a browser runs as JavaScript (HTML's JavaScript MIME type
// essence match), plus no type at all. Any of them can call import().
const JS_TYPES = /^$|^(?:application|text)\/(?:x-)?(?:java|ec)script$|^text\/javascript1\.[0-5]$|^text\/(?:jscript|livescript)$/;

// The CDN URLs inline scripts import, with `first` set to where the earliest
// such script starts: an import map registered after it cannot cover it.
function directImports(masked, html) {
  const found = new Set();
  found.first = Infinity;
  for (const m of masked.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const open = m[0].slice(0, m[0].indexOf(">") + 1);
    if (/\ssrc\s*=/i.test(open) || !(typeOf(open) === "module" || JS_TYPES.test(typeOf(open)))) continue;
    const start = m.index + open.length;
    for (const url of importSpecifiers(html.slice(start, start + m[1].length))) {
      if (url.includes("\\") || inScope(url)) {
        found.add(url);
        found.first = Math.min(found.first, m.index);
      }
    }
  }
  return found;
}

// Returns the page with hashes written (write mode) and the problems found.
// `hashOf` is injected so the self-test needs no network.
export async function processHtml(html, { write, hashOf }) {
  const problems = [];
  const edits = [];
  // Absolute URLs this pass read in the strict form, so the DOM pass can tell
  // which CDN assets the text rules cannot maintain.
  const handled = new Set();
  const note = (url, why) => problems.push(`${url} ${why}`);

  const masked = maskInert(html);
  for (const m of masked.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const isScript = /^<script/i.test(tag);
    if (isScript && typeOf(tag) === "importmap") continue;
    // A browser decodes `unpkg%2ecom` or `unpkg&#46;com` to a CDN host the raw
    // test below would miss. Resolve the URL as a browser would; only a URL that
    // lands on a CDN host has to be written plainly.
    const raw = tag.match(/\s(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? "";
    const resolved = resolvedHost(raw.replace(/^["']|["']$/g, ""));
    if (resolved === null) {
      note(tag, `uses an HTML entity this check cannot decode in its URL; write the URL plainly`);
      continue;
    }
    if (resolved && isCdnHost(resolved) && /[%&\\]/.test(raw)) {
      note(tag, `has a percent-encoded, entity-encoded or backslashed CDN URL; write it plainly`);
      continue;
    }
    if (!resolved || !isCdnHost(resolved)) continue;
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
    handled.add(new URL(url).href);
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
      edits.push([m.index, m.index + tag.length, `<${parsed.name} ${attrs}${parsed.selfClose ? " /" : ""}>`]);
      continue;
    }
    if (!integrity.length) note(url, "has no integrity attribute");
    else if (integrity[0].value !== want) note(url, `integrity is ${integrity[0].value}, the CDN serves ${want}`);
    if (crossorigin[0]?.value !== "anonymous") note(url, 'needs crossorigin="anonymous"');
  }

  const direct = directImports(masked, html);
  let mapsSeen = 0;
  for (const m of masked.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    if (typeOf(openTag) !== "importmap") continue;
    mapsSeen++;
    if (mapsSeen === 1 && m.index > direct.first) note(openTag, "comes after a script that imports a CDN module directly; move it above that script");
    // The masked copy blanked the JSON; read it from the page itself.
    const bodyStart = m.index + openTag.length;
    const body = html.slice(bodyStart, bodyStart + m[1].length);
    if (openTag !== '<script type="importmap">') {
      note(openTag, 'is an import map this check cannot parse; write it exactly as <script type="importmap">');
      continue;
    }
    let map;
    try {
      map = JSON.parse(body);
    } catch (error) {
      note(openTag, `holds JSON that does not parse (${error.message})`);
      continue;
    }
    const before = JSON.stringify(map);
    const urls = [
      ...Object.values(map.imports ?? {}),
      ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope)),
    ].filter((u) => isCdnHost(resolvedHost(String(u)) ?? ""));
    // Direct imports are checked against the first map; one map per page is
    // the supported form.
    if (mapsSeen === 1) urls.push(...direct);
    for (const url of new Set(urls)) {
      if (!CDN.test(url)) {
        note(url, "in the import map must be an https URL on the CDN");
        continue;
      }
      handled.add(new URL(url).href);
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
      edits.push([bodyStart, bodyStart + body.length, `\n${JSON.stringify(map, null, 2).replace(/^/gm, "    ")}\n  `]);
    }
  }

  if (direct.size && !mapsSeen) {
    const integrity = {};
    for (const url of direct) {
      if (!CDN.test(url)) {
        note(url, "imported directly must be an https URL on the CDN");
        continue;
      }
      handled.add(new URL(url).href);
      try {
        integrity[url] = await hashOf(url);
      } catch (error) {
        note(url, `could not be fetched (${error.message})`);
      }
    }
    if (!write) for (const url of Object.keys(integrity)) note(url, "is imported directly but the page has no import map integrity entry for it");
    else if (Object.keys(integrity).length) {
      // Before </head>, or before the first importing script when that comes
      // earlier, so the map is registered before any import starts.
      const headAt = masked.search(/[ \t]*<\/head\s*>/i);
      const head = Math.min(headAt < 0 ? Infinity : headAt, direct.first);
      if (head === Infinity) note("page", "imports a CDN module directly and has no </head> to put the import map in");
      else {
        const body = JSON.stringify({ integrity }, null, 2).replace(/^/gm, "    ");
        edits.push([head, head, `  <script type="importmap">\n${body}\n  </script>\n`]);
      }
    }
  }

  for (const [start, end, to] of edits.sort((a, b) => b[0] - a[0])) html = html.slice(0, start) + to + html.slice(end);
  return { html, problems, handled };
}


// What the browser made of the page: scripting off, every request but the page
// itself aborted. Runs in the page, so it can only return plain data.
function readDom() {
  const assets = [];
  for (const el of document.querySelectorAll("script[src], link[href]")) {
    const isScript = el.localName === "script";
    assets.push({
      tag: isScript ? "script" : "link",
      url: isScript ? el.src : el.href,
      integrity: el.getAttribute("integrity"),
      crossOrigin: el.crossOrigin,
    });
  }
  const maps = [];
  for (const el of document.querySelectorAll("script")) {
    if (el.type.trim().toLowerCase() !== "importmap") continue;
    try {
      const map = JSON.parse(el.textContent);
      const resolve = (value) => new URL(value, document.baseURI).href;
      const integrity = {};
      for (const [key, value] of Object.entries(map.integrity ?? {})) {
        try {
          integrity[resolve(key)] = value;
        } catch {}
      }
      const urls = [];
      for (const value of [
        ...Object.values(map.imports ?? {}),
        ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope)),
      ]) {
        try {
          urls.push(resolve(value));
        } catch {}
      }
      maps.push({ urls, integrity });
    } catch (error) {
      maps.push({ error: String(error.message ?? error), urls: [], integrity: {} });
    }
  }
  return { assets, maps };
}

const inScope = (url) => {
  try {
    return isCdnHost(new URL(url, "https://local.invalid/").hostname);
  } catch {
    return false;
  }
};

// Problems the browser's reading of `html` has, given the URLs the text pass
// handled in the strict form.
async function domProblems(browser, html, handled, hashOf) {
  const origin = "http://sri.invalid/";
  const context = await browser.newContext({ javaScriptEnabled: false });
  const problems = [];
  const note = (url, why) => problems.push(`${url} ${why}`);
  try {
    await context.route("**/*", (route) =>
      route.request().url() === `${origin}page.html`
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    const page = await context.newPage();
    await page.goto(`${origin}page.html`);
    const { assets, maps } = await page.evaluate(readDom);

    const check = async (url) => {
      if (!url.startsWith("https://")) {
        note(url, "is a CDN URL that is not https");
        return null;
      }
      if (!handled.has(url)) {
        note(url, `is a CDN asset in a spelling this check cannot maintain; ${FORM}`);
      }
      try {
        return await hashOf(url);
      } catch (error) {
        note(url, `could not be fetched (${error.message})`);
        return null;
      }
    };

    for (const asset of assets.filter((a) => inScope(a.url))) {
      const want = await check(asset.url);
      if (want === null) continue;
      if (asset.integrity === null) note(asset.url, "has no integrity attribute");
      else if (asset.integrity !== want) note(asset.url, `integrity is ${asset.integrity}, the CDN serves ${want}`);
      if (asset.crossOrigin !== "anonymous") note(asset.url, 'needs crossorigin="anonymous"');
    }
    for (const map of maps) {
      if (map.error) note("import map", `holds JSON that does not parse (${map.error})`);
      for (const url of new Set(map.urls.filter(inScope))) {
        const want = await check(url);
        if (want === null) continue;
        const have = map.integrity[url];
        if (!have) note(url, "has no import map integrity entry");
        else if (have !== want) note(url, `import map integrity is ${have}, the CDN serves ${want}`);
      }
    }
  } finally {
    await context.close();
  }
  return problems;
}

async function launchBrowser() {
  const { chromium } = await import("playwright");
  return chromium.launch();
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

  const direct = `<script type="module">import * as m from "${js}"; const x = await import("${css}");</script>`;
  expect("verify rejects direct imports with no import map", (await processHtml(direct, { write: false, hashOf })).problems.length === 2);
  const withMap = (integrity) => `<script type="importmap">{"integrity":${JSON.stringify(integrity)}}</script>${direct}`;
  expect("verify rejects a direct import missing from the import map", (await processHtml(withMap({ [js]: STUB }), { write: false, hashOf })).problems.length === 1);
  expect("verify accepts direct imports with integrity entries", (await processHtml(withMap({ [js]: STUB, [css]: STUB }), { write: false, hashOf })).problems.length === 0);
  const headed = `<html><head><title>t</title></head><body>${direct}</body></html>`;
  const fixed = await processHtml(headed, { write: true, hashOf });
  expect("--write adds an import map in the head for direct imports", fixed.html.indexOf('type="importmap"') < fixed.html.indexOf("</head>") && count(fixed.html, STUB) === 2);
  expect("--write output for direct imports verifies", (await processHtml(fixed.html, { write: false, hashOf })).problems.length === 0);
  const fromMap = await processHtml(withMap({}), { write: true, hashOf });
  expect("--write fills a direct import into an existing map", count(fromMap.html, STUB) === 2 && count(fromMap.html, 'type="importmap"') === 1);
  const quiet = `<script type="module">// import x from "${js}"\n/* import("${js}") */ import y from "https://esm.sh/y@1.0.0";</script>`;
  expect("comments and esm.sh imports are not demanded", (await processHtml(quiet, { write: false, hashOf })).problems.length === 0);

  const literal = `<script type="module">const s = 'import x from "${js}"'; const t = \`import("${js}")\`;</script>`;
  expect("an import-shaped string literal is not an import", (await processHtml(literal, { write: false, hashOf })).problems.length === 0);
  const hidden = `<script type="module">const a = "/*"; import * as m from "${js}"; const b = "*/";</script>`;
  expect("an import between strings holding comment markers is found", (await processHtml(hidden, { write: false, hashOf })).problems.length === 1);
  const interpolated = `<script type="module">const r = \`\${await import("${js}")} and \${\`\${await import("${css}")}\`}\`;</script>`;
  expect("imports inside template interpolations are found", (await processHtml(interpolated, { write: false, hashOf })).problems.length === 2);
  const early = `<html><head>\n  <script>import("${js}")</script>\n</head><body></body></html>`;
  const placed = (await processHtml(early, { write: true, hashOf })).html;
  expect("--write puts the import map before a head script that imports", placed.indexOf('type="importmap"') < placed.indexOf('import("'));
  expect("verify rejects an import map that comes after an importing script", (await processHtml(`<script>import("${js}")</script><script type="importmap">{"integrity":{"${js}":"${STUB}"}}</script>`, { write: false, hashOf })).problems.length === 1);
  const backticked = `<script type="module">import x from \`${js}\`; await import(\`${css}\`);</script>`;
  expect("constant template literal specifiers are found", (await processHtml(backticked, { write: false, hashOf })).problems.length === 2);
  const sameLine = `<html><head><!--\n--><script>import("${js}")</script></head><body></body></html>`;
  const boundary = (await processHtml(sameLine, { write: true, hashOf })).html;
  expect("--write inserts the map at the script tag, not inside a comment on its line", boundary.indexOf('type="importmap"') > boundary.indexOf("-->") && boundary.indexOf('type="importmap"') < boundary.indexOf('import("'));
  const wrapped = `<script type="module">await import(("${js}"));</script>`;
  expect("a parenthesized import() argument is found", (await processHtml(wrapped, { write: false, hashOf })).problems.length === 1);
  const opener = `<script>const marker = "<!--";</script><script type="module">import "${js}";</script><!-- end -->`;
  expect("a comment opener inside a script does not hide the next script", (await processHtml(opener, { write: false, hashOf })).problems.length === 1);
  const commented = `<script type="module">const r = \`\${ /* } */ await import("${js}") }\`;</script>`;
  expect("a brace inside a comment in an interpolation does not end it", (await processHtml(commented, { write: false, hashOf })).problems.length === 1);
  const classic = `<script type="application/javascript">import("${js}")</script>`;
  expect("a classic script typed application/javascript is scanned", (await processHtml(classic, { write: false, hashOf })).problems.length === 1);
  const escaped = `<script type="module">import x from "\\u0068ttps://unpkg.com/lib@1.0.0/lib.js";</script>`;
  for (const write of [false, true]) {
    expect(`an escaped import specifier is refused (write=${write})`, (await processHtml(escaped, { write, hashOf })).problems.length > 0);
  }
  const relative = `<script type="module">import x from "//unpkg.com/lib@1.0.0/lib.js";</script>`;
  for (const write of [false, true]) {
    expect(`a protocol-relative import is refused (write=${write})`, (await processHtml(relative, { write, hashOf })).problems.length > 0);
  }

  const plain = `<script src="/local.js"></script><script type='module'>import "x"</script><script type="module" src="https://js.arcgis.com/5.1/"></script>`;
  expect("non-CDN tags are ignored", (await processHtml(plain, { write: false, hashOf })).problems.length === 0);
  const inert = `<!-- <script src="https://unpkg.com/x@1.0.0/old.js"></script> --><script>const snippet = '<script src="https://unpkg.com/x@1.0.0/x.js"><\\/script>';</script>`;
  expect("tags inside comments and inline scripts are out of scope", (await processHtml(inert, { write: false, hashOf })).problems.length === 0);
  expect("--write leaves comments and inline scripts alone", (await processHtml(inert, { write: true, hashOf })).html === inert);
  const named = `<script src="https://unpkg.com/x@1.0.0/importmap.js" integrity="${STUB}" crossorigin="anonymous"></script>`;
  expect("a script whose URL says importmap is not an import map", (await processHtml(named, { write: false, hashOf })).problems.length === 0);
  expect("a script whose URL says importmap is still hash-checked", (await processHtml(named.replace(STUB, "sha384-OLD"), { write: false, hashOf })).problems.length > 0);
  const dotted = `<script src="https://unpkg.com./x@1.0.0/x.js"></script>`;
  expect("a trailing-dot CDN host is in scope", (await processHtml(dotted, { write: false, hashOf })).problems.length > 0);
  for (const other of ["https://notunpkg.com/x@1.0.0/x.js", "https://example.org/unpkg.com/x.js", "https://cdn.jsdelivr.net.example.org/x.js"]) {
    const page = `<script src="${other}"></script>`;
    expect(`a host that only contains a CDN name is out of scope (${other})`, (await processHtml(page, { write: false, hashOf })).problems.length === 0);
  }
  const cdnModule = `<script type="module" src="https://unpkg.com/x@1.0.0/x.mjs"></script>`;
  for (const enc of ["https://unpkg%2ecom/x@1.0.0/x.js", "https://unpkg&#46;com/x@1.0.0/x.js", "https://unpkg&percnt;2ecom/x@1.0.0/x.js", "https://unpkg&period;com/x@1.0.0/x.js"]) {
    const page = `<script src="${enc}"></script>`;
    expect(`an encoded CDN host is refused (${enc})`, (await processHtml(page, { write: false, hashOf })).problems.length > 0);
  }
  for (const local of ["/local.js?a=1&amp;b=2", "/assets/report%20viewer.js", "https://example.org/x.js?a=1&b=2"]) {
    const page = `<script src="${local}"></script>`;
    expect(`an encoded non-CDN URL is out of scope (${local})`, (await processHtml(page, { write: false, hashOf })).problems.length === 0);
  }
  expect("a CDN module script needs integrity too", (await processHtml(cdnModule, { write: false, hashOf })).problems.length > 0);

  let browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    if (process.env.CI) throw error;
    console.warn(`  skipping the DOM cases: playwright is not available (${error.message.split("\n")[0]})`);
  }
  if (browser) {
    const doc = (body) => `<!doctype html><html><head><meta charset="utf-8">${body}</head><body></body></html>`;
    const scan = async (body) => {
      const { problems, handled } = await processHtml(doc(body), { write: false, hashOf });
      return [...problems, ...(await domProblems(browser, doc(body), handled, hashOf))];
    };
    const link = `<link href="${css}" rel="stylesheet" integrity="${STUB}" crossorigin="anonymous">`;
    const clean = `${link}<script type="importmap">{"imports":{"a":"${js}"},"integrity":{"${js}":"${STUB}"}}</script>${good}`;
    expect("DOM: a clean canonical page passes", (await scan(clean)).length === 0);
    const dom = {
      "a quoted > inside an attribute": `<script data-note=">" src="${js}"></script>`,
      "an import map with an encoded host and no integrity": `<script type="importmap">{"imports":{"a":"https://unpkg%2ecom/lib@1.0.0/lib.js"}}</script>`,
      "an import map with an encoded host and an integrity entry": `<script type="importmap">{"imports":{"a":"https://unpkg%2ecom/lib@1.0.0/lib.js"},"integrity":{"https://unpkg.com/lib@1.0.0/lib.js":"${STUB}"}}</script>`,
      "an entity-encoded host": `<script src="https://unpkg&#46;com/lib@1.0.0/lib.js" integrity="${STUB}" crossorigin="anonymous"></script>`,
      "a stale first integrity before a correct one": `<script src="${js}" integrity="sha384-OLD" integrity="${STUB}" crossorigin="anonymous"></script>`,
      "uppercase tag and attributes": `<SCRIPT SRC="${js}" INTEGRITY="${STUB}" CROSSORIGIN="anonymous"></SCRIPT>`,
      "a protocol-relative URL": `<script src="//unpkg.com/lib@1.0.0/lib.js" integrity="${STUB}" crossorigin="anonymous"></script>`,
      "single-quoted attributes": `<script src='${js}' integrity='${STUB}' crossorigin='anonymous'></script>`,
      "a missing crossorigin": `<script src="${js}" integrity="${STUB}"></script>`,
      "a stale integrity": `<link href="${css}" rel="stylesheet" integrity="sha384-OLD" crossorigin="anonymous">`,
      "a trailing-dot CDN host": `<script src="https://unpkg.com./lib@1.0.0/lib.js" integrity="${STUB}" crossorigin="anonymous"></script>`,
      "a scoped import map URL without integrity": `<script type="importmap">{"imports":{},"scopes":{"/s/":{"b":"${css}"}}}</script>`,
    };
    for (const [name, body] of Object.entries(dom)) {
      expect(`DOM: rejects ${name}`, (await scan(body)).length > 0);
    }
    const quoted = doc(`<script data-note=">" src="${js}"></script>`);
    expect("DOM: --write fails on a tag it cannot maintain", (await checkPage(browser, quoted, { write: true, hashOf })).problems.length > 0);
    expect(
      "DOM: ignores a non-CDN asset",
      (await scan(`<script src="/local.js"></script><script type="module" src="https://js.arcgis.com/5.1/"></script>`)).length === 0,
    );
    await browser.close();
  }

  if (bad) {
    process.exitCode = 1;
    return;
  }
  console.log("SRI self-test ok");
}

// One page, both passes. With `write`, the rewritten page is what gets
// verified, so a tag `--write` could not maintain still fails.
export async function checkPage(browser, original, { write, hashOf }) {
  const first = await processHtml(original, { write, hashOf });
  const html = write ? first.html : original;
  const final = write ? await processHtml(html, { write: false, hashOf }) : first;
  const problems = new Set([...first.problems, ...final.problems]);
  for (const problem of await domProblems(browser, html, final.handled, hashOf)) problems.add(problem);
  return { html, problems: [...problems] };
}

async function main() {
  const write = process.argv.includes("--write");
  const failures = [];
  const browser = await launchBrowser();
  for (const file of pages(ROOT)) {
    const original = readFileSync(file, "utf8");
    const { html, problems } = await checkPage(browser, original, { write, hashOf: sha384 });
    for (const problem of problems) failures.push(`${relative(ROOT, file)}: ${problem}`);
    if (write && html !== original) writeFileSync(file, html);
  }
  await browser.close();

  if (failures.length) {
    console.error(`SRI check failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
    // exit() would cut off stderr when it is a pipe.
    process.exitCode = 1;
  } else if (write) console.log(`Hashes written for ${hashes.size} CDN files`);
  else console.log(`SRI ok: ${hashes.size} CDN files match their integrity hashes`);
}

await (process.argv.includes("--self-test") ? selfTest() : main());
