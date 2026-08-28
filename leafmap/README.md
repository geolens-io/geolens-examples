# leafmap: read a GeoLens catalog from Python

Two notebooks that read a live GeoLens instance with nothing but
[leafmap](https://leafmap.org/), `requests`, and — for `quickstart.ipynb` —
geopandas. No SDK, because the point is that none of this needs one: GeoLens
serves OGC API Features, OGC API Records, STAC 1.0, MVT vector tiles and
raster tiles served through TiTiler, and every one of them is plain HTTP.

| notebook | what it reads | use it for |
| --- | --- | --- |
| [`quickstart.ipynb`](quickstart.ipynb) | catalog search, two vector collections, a CQL2 filter, DEM raster tiles | a tour of every surface GeoLens serves |
| [`samgeo.ipynb`](samgeo.ipynb) | STAC item search, a by-reference Sentinel-2 tile's two assets, its raster tiles | segmenting GeoLens-served imagery with [samgeo](https://samgeo.gishub.org/) |

```bash
uv run --with jupyterlab --with ipykernel --with pip jupyter lab quickstart.ipynb
uv run --with jupyterlab --with ipykernel --with pip jupyter lab samgeo.ipynb
```

`uv` builds a throwaway environment holding just enough to open the
notebook; each notebook's own first cell installs its pinned dependencies
into it. Already have Jupyter running? Open either notebook there instead
and run its pip-install cell yourself.

## quickstart.ipynb: what it does

1. **Search the catalog.** `GET /api/search/datasets/` runs a phrase against
   embeddings of each record's title, description and keywords: a semantic
   match, not a keyword one.
2. **Load a vector collection.** Two of the demo's NYC subway layers, read
   over OGC API Features straight into GeoPandas, then onto the map.
3. **Filter server-side with CQL2.** `filter=title LIKE '%Subway%'` against
   the `datasets` (Records) collection, narrowing the catalog itself before
   anything downloads. The notebook checks `/api/conformance` for
   `basic-cql2` first rather than assuming a version, since this instance
   answers CQL2 on the catalog and not yet on a dataset's own feature
   collection.
4. **Raster tiles through TiTiler.** GeoLens bakes an uploaded raster into
   XYZ tiles once; the notebook points a tile layer at that template, the
   same URL a browser or QGIS would use.
5. **Optional: segment the DEM with samgeo.** Off by default
   (`RUN_SEGMENTATION = False`) because it needs `torch` and a
   multi-hundred-megabyte checkpoint. Flip the flag and install
   `segment-geospatial` to run it.

## samgeo.ipynb: what it does

1. **Find imagery by footprint.** `GET /api/stac/search` with a `bbox`
   against `geolens-unassigned` (published rasters not yet filed under a
   collection) returns whichever Sentinel-2 tiles overlap it, the STAC
   Item Search a desktop client or `pystac-client` would run.
2. **Read both assets a by-reference import preserves.** The matched item
   carries GeoLens's own `raster_tiles` template alongside a `data` asset
   that still points at the origin catalog's COG, untouched: proof that
   importing by reference doesn't copy the pixels onto GeoLens's own
   domain, so any generic STAC client can read the original file too.
3. **Draw the GeoLens-served tiles** on a leafmap map with the same
   `raster-tiles/{id}/tiles/{z}/{x}/{y}.png` template `quickstart.ipynb`
   uses for the DEM, this time over real Sentinel-2 true-colour imagery.
4. **Optional: segment the harbor with samgeo.** Off by default
   (`RUN_SEGMENTATION = False`) for the same reason as `quickstart.ipynb`'s
   own samgeo section — `torch` and a multi-hundred-megabyte checkpoint
   don't belong in a notebook meant to run anywhere in a few seconds. Flip
   the flag and install `segment-geospatial` to run it.

## Using your own instance

Change `GEOLENS` near the top of either notebook. That alone doesn't make
the rest of it run: `quickstart.ipynb`'s two subway collection ids and DEM
id, and `samgeo.ipynb`'s bbox and STAC collection, are the public demo's, so
list `/api/collections` or query `/api/stac/search` on your own instance and
substitute yours. Past that, each notebook's own assertions (the meteorite
search result and subway row counts in `quickstart.ipynb`; the single
matching STAC item and its asset hrefs in `samgeo.ipynb`), the map centers,
and the raster probe tiles are all calibrated to the demo's data. They're
what makes each notebook check itself rather than requirements your catalog
has to meet, so expect to loosen or drop them once you're pointed elsewhere.

One more thing a private instance needs: a raster tile template is fetched
straight by the browser, which has no way to attach an `X-Api-Key` header to
a plain URL. A public raster (like the demo's DEM and Sentinel-2 tile)
doesn't care, but a private one needs a signed tile token in its place;
`GET /api/tiles/token/<id>/` mints one and, for a raster dataset, hands
back a `tile_url` with the signature already in the query string, though
it's root-relative and still needs `GEOLENS` prefixed onto it before it's
a URL a browser can request.

And any of the data requests above (search, the collections, the
conformance check) will 401 against a private instance with nothing more
done: set the `GEOLENS_API_KEY` environment variable before opening either
notebook, and every request in it sends that as an `X-Api-Key` header.

## Re-running the checks

[`verify.py`](verify.py) and [`verify_samgeo.py`](verify_samgeo.py) each
execute their own notebook headlessly with `nbclient` (the same kernel a
person opening it in Jupyter gets) and fail on the first cell that raises,
which is what the assertions inside each notebook are for. Neither ever runs
its samgeo section, because that section is off in the notebook itself
rather than skipped by the checker: the file this executes is the file a
reader opens.

```bash
uv run leafmap/verify.py
uv run leafmap/verify_samgeo.py
```

## Data

`quickstart.ipynb` reads MTA subway data and a swissALTI3D DEM. `samgeo.ipynb`
reads Sentinel-2 imagery: contains modified Copernicus Sentinel data,
processed by ESA/Copernicus and served through
[Element 84's Earth Search](https://element84.com/earth-search/) STAC API,
imported into the GeoLens demo by reference.
