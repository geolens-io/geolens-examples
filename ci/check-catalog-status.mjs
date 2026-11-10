// Exercise catalog states the live demo's populated catalog cannot cover.
// Usage: BASE=http://localhost:8000 node ci/check-catalog-status.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8000";
const browser = await chromium.launch();
const failures = [];
const record = (id) => ({
  id,
  properties: {
    title: id,
    distributions: [{ type: "vector_tiles", title: "Tiles",
      url: `https://demo.getgeolens.com/api/tiles/data.${id}/{z}/{x}/{y}.pbf` }],
  },
});

try {
  for (const path of ["typescript/catalog-map.html", "search/catalog.html", "stac/browse.html"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${BASE}/${path}`);
      const layout = await page.evaluate(() => ({
        map: document.querySelector("#map").getBoundingClientRect().toJSON(),
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(layout.map.width >= 380, `map is only ${layout.map.width}px wide`);
      assert.ok(layout.map.height >= 400, `map is only ${layout.map.height}px tall`);
      assert.ok(layout.map.bottom <= 845, "map extends below the viewport");
      assert.ok(layout.scrollWidth <= 390, "page scrolls horizontally");
      console.log(`${path}: mobile map ${layout.map.width}x${layout.map.height}`);
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  for (const state of ["loading", "empty", "http-error", "network-error", "partial", "selection-error"]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/collections/datasets/items") {
        if (state === "loading") await hold;
        if (state === "network-error") return route.abort();
        if (state === "http-error") return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
        const features = ["partial", "selection-error"].includes(state) ? [record("first"), record("second")] : [];
        return route.fulfill({ json: { type: "FeatureCollection", features,
          links: state === "partial" ? [{ rel: "next", href: "?offset=2" }] : [] } });
      }
      if (url.pathname.startsWith("/api/tiles/")) return route.fulfill({ status: 204 });
      if (url.pathname === "/api/collections/second" && state === "selection-error") {
        return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
      }
      return route.fulfill({ json: { features: [], links: [] } });
    });
    try {
      await page.goto(`${BASE}/typescript/catalog-map.html`);
      const status = page.locator("#catalog-status");
      const picker = page.getByRole("combobox", { name: "Dataset" });
      if (state === "loading") {
        assert.match(await status.innerText(), /Loading catalog/);
        assert.ok(await picker.isDisabled());
        release();
      } else if (state === "empty") {
        await page.waitForFunction(() => document.querySelector("#catalog-status")?.textContent.includes("No vector datasets"));
        assert.ok(await picker.isDisabled());
      } else if (state.endsWith("error") && state !== "selection-error") {
        await page.waitForFunction(() => document.querySelector("#catalog-status")?.textContent.includes("Catalog failed"));
        assert.ok(await picker.isDisabled());
        if (state === "http-error") assert.match(await status.innerText(), /503/);
      } else {
        await page.waitForFunction(() => document.body.dataset.dataset === "first");
        if (state === "partial") {
          assert.match(await status.innerText(), /first 2 datasets; more/);
          await picker.selectOption("second");
          await page.waitForFunction(() => document.body.dataset.dataset === "second");
        } else {
          await picker.selectOption("second");
          await page.waitForFunction(() => document.querySelector("#tiles").textContent.includes("Dataset failed"));
          assert.match(await page.locator("#tiles").innerText(), /503/);
          assert.equal(await page.getAttribute("body", "data-dataset"), null);
          await picker.selectOption("first");
          await page.waitForFunction(() => document.body.dataset.dataset === "first");
          assert.equal(await page.locator("#tiles").innerText(), "");
        }
      }
      assert.deepEqual(pageErrors, []);
      console.log(`catalog ${state}: OK`);
    } catch (error) {
      failures.push(`catalog ${state}: ${error.message}`);
    } finally {
      release();
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
