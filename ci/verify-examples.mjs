// Loads every browser example against the live GeoLens demo and fails the
// build when reality stops matching ci/manifest.json.
//
// expect "render":  zero console errors AND at least one successful demo
//                   data response (items / .pbf / .png tiles).
// expect "blocked": at least one CORS error naming Access-Control-Allow-Origin
//                   and no OTHER console errors. When geolens#1464 deploys,
//                   these entries fail loudly with instructions to flip them —
//                   that red is the signal to promote the example, on purpose.
//
// Usage: node ci/verify-examples.mjs   (expects the repo served at BASE)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8000";
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url)));

const browser = await chromium.launch();
const failures = [];

for (const entry of manifest) {
  const page = await browser.newPage();
  const consoleErrors = [];
  let demoDataResponses = 0;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => {
    const url = res.url();
    if (
      url.includes("demo.getgeolens.com") &&
      res.ok() &&
      /items|\.pbf|\.png/.test(url)
    ) {
      demoDataResponses += 1;
    }
  });

  await page.goto(`${BASE}/${entry.path}`, { waitUntil: "load" });
  await page.waitForTimeout(entry.wait);

  const corsErrors = consoleErrors.filter((t) =>
    t.includes("Access-Control-Allow-Origin"),
  );
  const otherErrors = consoleErrors.filter(
    (t) => !t.includes("Access-Control-Allow-Origin") && !t.includes("ERR_FAILED"),
  );

  if (entry.expect === "render") {
    if (consoleErrors.length > 0) {
      failures.push(`${entry.path}: expected clean console, got ${consoleErrors.length} errors; first: ${consoleErrors[0]}`);
    } else if (demoDataResponses === 0) {
      failures.push(`${entry.path}: no successful demo data responses — nothing rendered`);
    }
  } else if (entry.expect === "blocked") {
    if (corsErrors.length === 0) {
      failures.push(
        `${entry.path}: expected CORS-blocked but saw no CORS errors. ` +
          `If geolens#1464 has deployed, this example now renders: flip its ` +
          `manifest entry to "render" and update the README status row.`,
      );
    }
    if (otherErrors.length > 0) {
      failures.push(`${entry.path}: non-CORS errors while blocked: ${otherErrors[0]}`);
    }
  }

  console.log(
    `${entry.path}: expect=${entry.expect} consoleErrors=${consoleErrors.length} ` +
      `corsErrors=${corsErrors.length} demoDataResponses=${demoDataResponses}`,
  );
  await page.close();
}

await browser.close();

if (failures.length > 0) {
  console.error("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("\nAll examples match their manifest expectations.");
