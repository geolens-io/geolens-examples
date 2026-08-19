# Contributing

This repo holds runnable examples for consuming GeoLens: one static file per example, no build step, no framework glue beyond what the library itself needs.

## Two kinds of example

**Live.** A read, made anonymously, against the public demo. One file, zero setup, and CI replays it against `demo.getgeolens.com` on every pull request and every push to `main`. Nearly everything here is one of these, and the rules in the next section are written for them.

**Workflow.** An example CI cannot replay end to end: it authenticates, or writes, or drives an application no runner has. `cli/` and `qgis/` are the two. Applying a catalog manifest is a write and the demo accepts no anonymous writes; QGIS is a desktop application, and `qgis/verify.py` needs the Python that ships with it, so it runs once a month inside the upstream QGIS container rather than on every push. A workflow example may hold more than one file, typically a manifest or project, a workflow YAML and a README, and CI checks whichever part runs with no credential, which for `cli/` means offline schema validation. Two things are not negotiable. The README says plainly which steps need a real instance or a desktop, so a green build is never read as a verified apply. And nothing in the repo is a credential.

## What makes a good example here

- One file. No bundler and no `package.json` for the example itself: the library loads from a pinned CDN `<script>`/`<link>` (or, for `python/`, a single-file `uv run` script with inline dependencies).
- Pin the library version explicitly (e.g. `maplibre-gl@5.24.0`), not `@latest`. A silent upstream upgrade shouldn't be what breaks someone's afternoon.
- Runs anonymously against the public demo (`https://demo.getgeolens.com`) with zero setup. The `GEOLENS` constant near the top is the only thing a reader needs to change to point it at their own instance.
- Comment the *why*, not the *what*. The existing examples explain things like why a plain `<img>` tile load skips the CORS check while `crossOrigin`-set `<img>` and `fetch`/WebGL loading both need the header, or why OpenLayers reprojects GeoJSON automatically, not what `new ol.Map(...)` does.

## What CI checks

`.github/workflows/verify.yml` runs on every pull request, on pushes to `main`, and once a week on a schedule:

- **Demo fixtures**: `ci/check-fixtures.mjs` runs first and probes the demo datasets, tile paths and share token named in `ci/fixtures.json`, which is where the IDs hardcoded across the examples are declared. Red there means the demo changed under the examples, not that an example broke.
- **Browser examples**: `ci/verify-examples.mjs` loads every entry in `ci/manifest.json` with Playwright against the real demo. A page passes only if it reaches the demo, loads the specific data its manifest entry names, gets features back rather than an empty collection, keeps the console free of errors from the demo or the page itself, and actually paints. The middle of the viewport is screenshotted and must not be a flat fill. HTTP status alone is not the check: a vector tile answers 200 with its source-layer named wrong while the map stays blank. Failures from third-party hosts (a CDN, an analytics beacon) and cancelled requests are reported but never fail the build, and a page that fails is retried once before it counts as red. Pushes and pull requests sweep in Chromium; the weekly schedule and manual runs sweep the whole manifest again in Firefox and WebKit (`BROWSERS=chromium,firefox,webkit`), and the job summary reports each engine on its own row.
- **Python examples**: runs `python/analyze.py` with `uv run` and checks it produces `subway.png`, then runs `python/sdk-catalog.py` the same way. Separate steps, so a failure names the script rather than the job.
- **DuckDB example**: `uv run duckdb/run.py` executes `duckdb/features.sql` against the demo and fails if any `SELECT` comes back with no rows.
- **Version pins**: `ci/check-pins.py` reads every GeoLens client pin in the repo (`geolens`, `@geolens/sdk`, `geolens-mcp`, `geolens-cli`) and fails if they disagree. It also asks the demo what version it runs and warns, without failing, when the demo has moved ahead of the pins.
- **MCP example**: `ci/check-mcp.py` spawns the exact `geolens-mcp` version pinned in `mcp/clients/generic.json`, then the latest release. The pin gates the build, since that is what the docs tell people to install; the float only warns.
- **CLI manifest**: `geolens validate cli/geolens.yaml` and `geolens schema` against the pinned `geolens-cli`. Both are offline, so they check that the manifest still matches the schema that release packages without needing an instance or a credential. The `apply` steps `cli/README.md` documents are not run here and cannot be.

`.github/workflows/qgis.yml` runs on the first day of each month and on demand. No hosted runner has QGIS, so it runs `qgis/verify.py` inside the upstream `qgis/qgis` image (the 3.44 LTR, pinned by digest) with `QT_QPA_PLATFORM=offscreen`: the two subway collections over OGC API - Features and the DEM as XYZ tiles have to load, count right and draw. It runs monthly because the providers it exercises change with QGIS releases rather than with commits to this repo.

If your PR adds or changes a browser example, add or update its entry in `ci/manifest.json` and the status row in the README table. Otherwise CI isn't actually checking what you changed — and a README row claiming a directory is verified with nothing backing it fails the build on its own. An entry is four keys, five when the page draws more than one layer of its own:

```json
{
  "path": "maplibre/vector-tiles.html",
  "wait": 8000,
  "requireUrls": ["/api/tiles/data.nyc_subway_lines_mta/"],
  "minDataResponses": 3
}
```

`requireUrls` are substrings that must each turn up in the URL of a successful demo response: the dataset UUID, qualified table name or tile path your example claims to load. `minDataResponses` is how many responses of real data it takes, counting only status 200, since a 204 is the server saying there is no tile at that address. `requireColors` lists the fixed colours a page draws its own layers in (`["#4da3ff", "#ffd166"]` for the two-layer feature examples), and each must appear in the painted viewport, so a layer that silently stops drawing turns the build red. Unknown or missing keys fail before the browser even starts, so a typo is an error rather than a check that quietly does nothing.

The bar for a live example is simple: if it doesn't render against `demo.getgeolens.com` right now, it doesn't merge. A workflow example is held to whatever CI can genuinely run without a credential, plus a README that is straight about the steps it cannot.

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

To sweep the other engines as the scheduled run does, install them and name them in `BROWSERS`:

```bash
npx playwright install firefox webkit
BROWSERS=chromium,firefox,webkit node ci/verify-examples.mjs
```

For the Python examples:

```bash
cd python
uv run analyze.py
uv run sdk-catalog.py
```
