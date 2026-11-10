// Regression check for the maplibre/features.html popup-XSS fix, and for its
// keyboard path to the same details. Three things,
// against a real page load rather than a unit test of the fix in isolation:
//
//   1. The page's own click handler is safe: every station arrives from the
//      demo with a hostile `name`, a click on a rendered station opens the
//      page's popup, and it shows the markup as readable JSON text while
//      injecting no element.
//   2. The station picker opens the same details with keys alone.
//   3. The payload is really hostile: the OLD `setHTML` pattern, replayed with
//      the same properties inside the same map, does inject an element. A
//      check that passes against both patterns is not a counterfactual and
//      proves nothing.
//
// Usage: node ci/check-popup-safety.mjs   (expects the repo served at BASE)
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8000";

const browser = await chromium.launch();
const page = await browser.newPage();

// The page never assigns `map` to `window`, and it shouldn't — this is a
// copy-paste example, not a test harness. MapLibre 6 is an ES module the page
// imports, so there is no global to wrap either. Instead the page gets a thin
// module in the library's place: it re-exports the real one, with Map
// subclassed to record the instance, and leaves the page's own code untouched.
// The real module is fetched under a `?real` query so this route skips it.
const LIBRARY = /\/maplibre-gl@[^/]+\/dist\/maplibre-gl\.mjs$/;
await page.route(
  (url) => LIBRARY.test(url.pathname) && url.search === "",
  (route) => {
    const real = `${route.request().url()}?real`;
    route.fulfill({
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: [
        `import * as real from ${JSON.stringify(real)};`,
        `export * from ${JSON.stringify(real)};`,
        `export class Map extends real.Map {`,
        `  constructor(options) { super(options); window.__map = this; }`,
        `}`,
        `window.__maplibregl = real;`,
      ].join("\n"),
    });
  },
);
// The page pins the library's hash in its import map, and the module above is
// not those bytes, so the copy served here drops that one integrity entry.
await page.route(`${BASE}/maplibre/features.html`, async (route) => {
  const response = await route.fetch();
  const body = (await response.text()).replace(
    /(<script type="importmap">)([\s\S]*?)(<\/script>)/,
    (_, open, json, close) => {
      const map = JSON.parse(json);
      for (const url of Object.keys(map.integrity ?? {})) if (LIBRARY.test(new URL(url).pathname)) delete map.integrity[url];
      return open + JSON.stringify(map) + close;
    },
  );
  await route.fulfill({ response, body });
});

// The injected element is the evidence, so its handler does nothing. An
// `alert(1)` here opened a real dialog when the image failed to load, and
// Playwright dismissing it raced the browser closing, which crashed a run that
// had already passed (#53).
const HOSTILE = "</pre><img src=x onerror=void(0)>";

// Every feature the page loads arrives as the demo serves it, with its name
// replaced, so whichever station the click lands on is hostile. Matching every
// items request rather than the stations id keeps this check out of the id
// swap after a demo reset.
let rewritten = 0;
await page.route(
  (url) => /\/api\/collections\/[^/]+\/items$/.test(url.pathname),
  async (route) => {
    const response = await route.fetch();
    const collection = await response.json();
    for (const feature of collection.features) feature.properties.name = HOSTILE;
    rewritten += collection.features.length;
    await route.fulfill({ response, json: collection });
  },
);

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(`${BASE}/maplibre/features.html`, { waitUntil: "load" });
await page.waitForFunction(() => window.__map?.loaded());
await page.waitForFunction(
  () => window.__map.querySourceFeatures("stations").length > 0,
  { timeout: 15000 },
);

const failures = [];

// --- 1. The page's click handler, on a hostile station -------------------
const station = await page.evaluate(() => {
  const map = window.__map;
  const [feature] = map.queryRenderedFeatures({ layers: ["subway-stations"] });
  const point = map.project(feature.geometry.coordinates);
  return { x: point.x, y: point.y };
});
await page.mouse.click(station.x, station.y);
const popup = page.locator(".maplibregl-popup-content").first();
const popupText = await popup.locator("pre").textContent({ timeout: 5000 }).catch(() => null);
const pageImgCount = popupText === null ? null : await popup.locator("img").count();

if (rewritten === 0) {
  failures.push("the stations response was never rewritten, so the click tested nothing hostile");
} else if (!popupText || !/^\{\s*\n\s*"/.test(popupText.trim())) {
  failures.push(`click on a station did not produce readable JSON popup text: ${popupText}`);
} else if (pageImgCount !== 0) {
  failures.push(`the page's popup injected ${pageImgCount} element(s) from a station name`);
} else if (!popupText.includes(JSON.stringify(HOSTILE))) {
  failures.push(`the popup does not show the hostile name as text: ${popupText}`);
} else {
  console.log(`page popup: showed the hostile name as text, injected 0 elements (${rewritten} features rewritten)`);
}

// --- 1b. The same details from the keyboard -----------------------------
// A canvas click is unreachable without a mouse, so the page also offers a
// native <select>. Drive it with keys only and expect another popup carrying
// the same hostile name as text.
await page.waitForFunction(() => !document.getElementById("station-picker")?.disabled, { timeout: 15000 });
const before = await page.locator(".maplibregl-popup").count();
await page.focus("#station-picker");
// Type-ahead picks an option on a closed select; ArrowDown opens the native
// menu instead on macOS, where headless Chromium never commits a choice.
await page.keyboard.type("Chambers");
const keyPopup = page.locator(".maplibregl-popup-content").last();
const keyText = await keyPopup.locator("pre").textContent({ timeout: 5000 }).catch(() => null);
if ((await page.locator(".maplibregl-popup").count()) <= before || !keyText?.includes(JSON.stringify(HOSTILE))) {
  failures.push(`choosing a station with the keyboard did not open its details: ${keyText}`);
} else if ((await keyPopup.locator("img").count()) !== 0) {
  failures.push("the keyboard path injected an element from a station name");
} else {
  console.log("keyboard path: the station picker opened the same details as text");
}

// --- 2. Counterfactual: the OLD pattern injects the same payload ----------
const oldImgCount = await page.evaluate((name) => {
  const map = window.__map;
  const oldPopup = new window.__maplibregl.Popup()
    .setLngLat(map.getCenter())
    .setHTML(`<pre>${JSON.stringify({ name }, null, 2).slice(0, 500)}</pre>`)
    .addTo(map);
  const count = oldPopup.getElement().querySelectorAll("img").length;
  oldPopup.remove();
  return count;
}, HOSTILE);

console.log(`counterfactual: the old setHTML pattern injected ${oldImgCount} element(s)`);
if (oldImgCount === 0) {
  failures.push("counterfactual is vacuous: the OLD pattern injected 0 elements too");
}

if (consoleErrors.length > 0) {
  console.log("console errors during the run:", consoleErrors);
}

await browser.close();

if (failures.length > 0) {
  console.error("FAILED:\n" + failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASSED");
