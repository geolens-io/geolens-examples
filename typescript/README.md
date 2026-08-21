# TypeScript: drive a map from the catalog with `@geolens/sdk`

See the [TypeScript SDK guide](https://docs.getgeolens.com/guides/sdk/typescript/)
for install, auth and the first call; this page covers what running it in a browser adds.

`catalog-map.html` asks a GeoLens instance what it holds, shows what the catalog
knows about the dataset you picked, and draws it. The picker re-runs the whole
thing against a different dataset. The file contains no dataset id, no table
name, and no tile URL.

It is one static HTML page. Open it, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/typescript/catalog-map.html
```

## What it shows

**The SDK is the client, not `fetch`.** Every endpoint in the OpenAPI schema
gets a generated function with typed arguments and a typed response, so path and
query parameters are checked and serialized for you. The page uses four calls:

| Call | For |
|---|---|
| `createGeolensClient` | base URL and auth, once |
| `collectionItemsCollectionsDatasetsItemsGet` | query the catalog (OGC API Records) |
| `getDatasetCollectionCollectionsDatasetIdGet` | one dataset's collection document |
| `getCollectionItemsCollectionsDatasetIdItemsGet` | a single feature, for its attribute names |

Generated calls resolve to `{ data, error, response }` rather than throwing, so
a 404 is a value you branch on. That contract begins once bytes come back. A
request the browser refuses to make at all, whether from CORS, DNS or being
offline, resolves with `response` unset, which is why `unwrap()` in the example
checks for it first.

**The catalog carries what a tile URL cannot.** A tile template gets pixels on
screen and says nothing about where the data came from or whether it is still
true. The record behind each dataset carries the publisher, the ingest format,
the license, a quality score, an update frequency, and freshness and health
fields fed by source checks. The panel is a straight render of those fields.

The panel is built with `textContent` rather than `innerHTML`, and only
`http(s)` links become clickable. Catalog fields are strings someone typed, so
on an instance where your users can create datasets, a title or publisher name
is untrusted input.

On the demo, `source_health` reads `unknown` for every vector dataset, because
they were ingested from files rather than attached to a live service that
GeoLens polls. Datasets with a service behind them populate it, and
`source_freshness` already varies across the demo catalog: the earthquake feeds
report `due` against a `continual` update frequency, the hurricane and income
datasets `fresh` against `annually`.

**Links come from the record, not from string concatenation.** Each record
advertises its own distributions, meaning five download formats, the OGC
Features endpoint and the vector tile template, and the collection document
advertises its own links. The map reads the advertised tile template and takes
the MVT `source-layer` from the path segment inside it.

The alternative is what most integrations do: hardcode
`${GEOLENS}/api/tiles/data.<table>/{z}/{x}/{y}.pbf`. That bakes in an internal
table name, the `data.` schema prefix, and a URL shape the server owns, none of
which are yours to guess and any of which can change under you.

**Attribute schema without downloading the data.** `include_geometry=false` with
`limit=1` returns one feature stripped of its geometry, a few hundred bytes,
enough to list field names and types. The catalog counts columns; this is what
they are called.

## Loading an npm package with no build step

`@geolens/sdk` is ESM, so a pinned [esm.sh](https://esm.sh) URL loads it into the
browser directly:

```js
import { createGeolensClient } from "https://esm.sh/@geolens/sdk@1.14.2";
```

Pin the version. A floating specifier makes the page's behavior a function of
when it was loaded. In a real project, install from npm and let your bundler
resolve it. The CDN import is what keeps this example a single file with nothing
to install, the same way the other examples load MapLibre from unpkg.

`baseUrl` must include the `/api` prefix the deployed API is served under:

```js
const geolens = createGeolensClient({ baseUrl: "https://demo.getgeolens.com/api" });
```

One caveat before you build on it: `createGeolensClient` configures a
module-level singleton and hands it back, so calling it twice reconfigures the
first client rather than producing a second one. Two instances in one page is
not a thing the current SDK does.

## What a cross-origin page can read anonymously

This page runs on `localhost` and reads a GeoLens instance on another origin, so
every call has to clear CORS. The two halves of the API answer differently, and
the split is deliberate.

Standards routes (the landing page, `/conformance`, everything under
`/collections`, STAC) answer anonymous `GET` requests from any origin with
`Access-Control-Allow-Origin: *`. Tile requests do too, which is why MapLibre can
fetch the advertised template. A catalog that implements OGC API is supposed to
be reachable by clients it has never heard of.

Native routes (`/search/datasets`, `/datasets/{id}`, `/settings/*`) answer only
origins the instance lists in `CORS_ALLOWED_ORIGINS`. Cross-origin and unlisted,
they come back with no CORS header at all and the browser discards the response.

So a browser page on someone else's origin reaches the catalog through the
standards half. That costs nothing here, because `/search/datasets` and the OGC
Records items endpoint are the same search behind two doors, and the SDK types
both. From Node, or from a page the instance serves itself, the native routes
are available too. `/datasets/{id}` in particular returns `column_info`, the
column-level schema this page infers from a sample feature instead.

## Authentication

The SDK sends credentials as headers: `apiKey` becomes `X-Api-Key` and `bearerToken`
becomes `Authorization: Bearer`, one mode or the other. See the typescript guide's
[Authenticate](https://docs.getgeolens.com/guides/sdk/typescript/#authenticate) section for
both, and [Authentication](https://docs.getgeolens.com/guides/api/auth/) for how to get either.

```js
createGeolensClient({ baseUrl: `${GEOLENS}/api`, apiKey: "<key>" });
```

There is no option for a key in the query string, on purpose: a credential in a
URL ends up in access logs, browser history, and `Referer` headers on the way
out. Keep the key out of the page source too, and read it from wherever your app
keeps secrets.

Two things change once a request carries a credential.

The wildcard lane closes. The anonymous standards exemption above applies only to
requests with no `Authorization`, `Cookie`, `X-Api-Key` or `X-Embed-Token`. Add a
key to a cross-origin request and the preflight comes back without
`Access-Control-Allow-Origin`, so you get a CORS failure rather than a `401`. Put
your page's origin in the instance's `CORS_ALLOWED_ORIGINS`, which you would be
doing anyway for a private deployment.

The map still needs its own. MapLibre fetches tiles itself, outside the SDK, so a
private instance needs a `transformRequest` on the map to attach the same header
to tile requests.

## Pointing it at your own instance

Change one line:

```js
const GEOLENS = "https://demo.getgeolens.com";
```

Everything else is discovered. The page filters the catalog to
`record_type: "vector_dataset"` because it draws MVT, so your instance needs at
least one vector dataset for the picker to fill.

## Pinned versions

`@geolens/sdk@1.14.2` (current npm release) and `maplibre-gl@5.24.0`, verified
against the live demo on 2026-08-19: SDK loaded from esm.sh, all calls 2xx, clean
console, tiles rendering for point, line and polygon datasets.
