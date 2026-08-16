# Contributing

This repo holds runnable examples for consuming GeoLens: one static file per example, no build step, no framework glue beyond what the library itself needs.

## What makes a good example here

- One file. No bundler and no `package.json` for the example itself: the library loads from a pinned CDN `<script>`/`<link>` (or, for `python/`, a single-file `uv run` script with inline dependencies).
- Pin the library version explicitly (e.g. `maplibre-gl@5.24.0`), not `@latest`. A silent upstream upgrade shouldn't be what breaks someone's afternoon.
- Runs anonymously against the public demo (`https://demo.getgeolens.com`) with zero setup. The `GEOLENS` constant near the top is the only thing a reader needs to change to point it at their own instance.
- Comment the *why*, not the *what*. The existing examples explain things like why `<img>`-tag tile loading never checks CORS while `fetch`/WebGL loading does, or why OpenLayers reprojects GeoJSON automatically, not what `new ol.Map(...)` does.

## CI verifies every example against the live demo

`.github/workflows/verify.yml` runs on every push and PR:

- **Browser examples**: `ci/verify-examples.mjs` loads every entry in `ci/manifest.json` with Playwright against the real demo and checks the console is clean and at least one real data request succeeded. An entry marked `"expect": "blocked"` is checked the other way: it must fail with a CORS error and nothing else (see the comment at the top of that file for why some examples are deliberately still red).
- **Python example**: runs `python/analyze.py` with `uv run` and checks it produces `subway.png`.
- **MCP example**: runs `ci/check-mcp.py` against the live demo.

If your PR adds or changes a browser example, add or update its entry in `ci/manifest.json` and the status row in the README table. Otherwise CI isn't actually checking what you changed.

The bar is simple: if it doesn't render against `demo.getgeolens.com` right now, it doesn't merge.

## Running the verifier locally

```bash
npm init -y && npm install playwright@1 && npx playwright install chromium
python3 -m http.server 8000 &
node ci/verify-examples.mjs
```

For the Python example:

```bash
cd python && uv run analyze.py
```
