# Contributing

This repo holds runnable examples for consuming GeoLens: one static file per example, no build step, no framework glue beyond what the library itself needs.

## What makes a good example here

- One file. No bundler and no `package.json` for the example itself: the library loads from a pinned CDN `<script>`/`<link>` (or, for `python/`, a single-file `uv run` script with inline dependencies).
- Pin the library version explicitly (e.g. `maplibre-gl@5.24.0`), not `@latest`. A silent upstream upgrade shouldn't be what breaks someone's afternoon.
- Runs anonymously against the public demo (`https://demo.getgeolens.com`) with zero setup. The `GEOLENS` constant near the top is the only thing a reader needs to change to point it at their own instance.
- Comment the *why*, not the *what*. The existing examples explain things like why a plain `<img>` tile load skips the CORS check while `crossOrigin`-set `<img>` and `fetch`/WebGL loading both need the header, or why OpenLayers reprojects GeoJSON automatically, not what `new ol.Map(...)` does.

## CI verifies every example against the live demo

`.github/workflows/verify.yml` runs on every push and PR:

- **Demo fixtures**: `ci/check-fixtures.mjs` runs first and probes the demo datasets, tile paths and share token named in `ci/fixtures.json`, which is where the IDs hardcoded across the examples are declared. Red there means the demo changed under the examples, not that an example broke.
- **Browser examples**: `ci/verify-examples.mjs` loads every entry in `ci/manifest.json` with Playwright against the real demo. A page passes only if it reaches the demo, loads the specific data its manifest entry names, gets features back rather than an empty collection, keeps the console free of errors from the demo or the page itself, and actually paints — the middle of the viewport is screenshotted and must not be a flat fill. HTTP status alone is not the check: a vector tile answers 200 with its source-layer named wrong while the map stays blank. Failures from third-party hosts (a CDN, an analytics beacon) and cancelled requests are reported but never fail the build, and a page that fails is retried once before it counts as red.
- **Python examples**: runs `python/analyze.py` with `uv run` and checks it produces `subway.png`, then runs `python/sdk-catalog.py` the same way. Separate steps, so a failure names the script rather than the job.
- **Version pins**: `ci/check-pins.py` reads every GeoLens client pin in the repo (`geolens`, `@geolens/sdk`, `geolens-mcp`) and fails if they disagree. It also asks the demo what version it runs and warns, without failing, when the demo has moved ahead of the pins.
- **MCP example**: `ci/check-mcp.py` spawns the exact `geolens-mcp` version pinned in `claude-mcp/mcp-config.example.json`, then the latest release. The pin gates the build, since that is what the docs tell people to install; the float only warns.

If your PR adds or changes a browser example, add or update its entry in `ci/manifest.json` and the status row in the README table. Otherwise CI isn't actually checking what you changed — and a README row claiming a directory is verified with nothing backing it fails the build on its own. An entry is four keys:

```json
{
  "path": "maplibre/vector-tiles.html",
  "wait": 8000,
  "requireUrls": ["/api/tiles/data.nyc_subway_lines_mta/"],
  "minDataResponses": 3
}
```

`requireUrls` are substrings that must each turn up in the URL of a successful demo response: the dataset UUID, qualified table name or tile path your example claims to load. `minDataResponses` is how many responses of real data it takes, counting only status 200, since a 204 is the server saying there is no tile at that address. Unknown or missing keys fail before the browser even starts, so a typo is an error rather than a check that quietly does nothing.

The bar is simple: if it doesn't render against `demo.getgeolens.com` right now, it doesn't merge.

## Running the verifier locally

```bash
npm init -y && npm install playwright@1.62.1 && npx playwright install chromium
python3 -m http.server 8000 &
node ci/verify-examples.mjs
```

Use that exact Playwright version. The workflow pins it, and the paint check is calibrated against that browser build. To iterate on one example instead of running the whole sweep at the demo, set `ONLY`:

```bash
ONLY=maplibre/features.html node ci/verify-examples.mjs
```

For the Python examples:

```bash
cd python
uv run analyze.py
uv run sdk-catalog.py
```
