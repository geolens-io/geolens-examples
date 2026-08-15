// Regression check for the maplibre/features.html popup-XSS fix (see PR
// description). Two things, against a real page load — not a unit test of
// the fix in isolation:
//
//   1. The real click handler still works: click a rendered subway station
//      and a popup shows readable JSON.
//   2. The vulnerability is actually closed: replay the OLD `setHTML`
//      pattern and the NEW `setDOMContent` pattern against a hostile
//      property value inside the same live map, and assert the OLD one
//      injects a DOM element while the NEW one injects none. A check that
//      passes against both is not a counterfactual and proves nothing.
//
// Usage: node ci/check-popup-safety.mjs   (expects the repo served at BASE)
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8000";

const browser = await chromium.launch();
const page = await browser.newPage();

// The page never assigns `map` to `window`, and it shouldn't — this is a
// copy-paste example, not a test harness. Capture the instance from outside
// by wrapping the constructor before the page's own script runs.
await page.addInitScript(() => {
  let lib;
  Object.defineProperty(window, "maplibregl", {
    configurable: true,
    get() {
      return lib;
    },
    set(realLib) {
      const RealMap = realLib.Map;
      class CapturedMap extends RealMap {
        constructor(options) {
          super(options);
          window.__map = this;
        }
      }
      realLib.Map = CapturedMap;
      lib = realLib;
    },
  });
});

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

// --- 1. Real click on a real rendered station shows a readable popup -----
const station = await page.evaluate(() => {
  const map = window.__map;
  const [feature] = map.queryRenderedFeatures({ layers: ["subway-stations"] });
  const point = map.project(feature.geometry.coordinates);
  return { x: point.x, y: point.y };
});
await page.mouse.click(station.x, station.y);
const popupText = await page
  .locator(".maplibregl-popup-content pre")
  .first()
  .textContent({ timeout: 5000 })
  .catch(() => null);

if (!popupText || !/^\{\s*\n\s*"/.test(popupText.trim())) {
  failures.push(`click on a station did not produce readable JSON popup text: ${popupText}`);
} else {
  console.log("click-to-popup: OK —", popupText.split("\n")[0]);
}

// --- 2. Counterfactual: OLD pattern injects, NEW pattern does not --------
const hostile = { name: "</pre><img src=x onerror=alert(1)>" };
const injection = await page.evaluate((hostileProps) => {
  const map = window.__map;

  const oldPopup = new maplibregl.Popup()
    .setLngLat(map.getCenter())
    .setHTML(`<pre>${JSON.stringify(hostileProps, null, 2).slice(0, 500)}</pre>`)
    .addTo(map);
  const oldImgCount = oldPopup.getElement().querySelectorAll("img").length;
  oldPopup.remove();

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(hostileProps, null, 2).slice(0, 500);
  const newPopup = new maplibregl.Popup()
    .setLngLat(map.getCenter())
    .setDOMContent(pre)
    .addTo(map);
  const newImgCount = newPopup.getElement().querySelectorAll("img").length;
  newPopup.remove();

  return { oldImgCount, newImgCount };
}, hostile);

console.log(
  `counterfactual: old pattern injected ${injection.oldImgCount} element(s), new pattern injected ${injection.newImgCount}`,
);
if (injection.oldImgCount === 0) {
  failures.push("counterfactual is vacuous: the OLD pattern injected 0 elements too");
}
if (injection.newImgCount !== 0) {
  failures.push(`fix did not close the injection: NEW pattern injected ${injection.newImgCount} element(s)`);
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
