# leafmap: read a GeoLens catalog from Python

One notebook, [`quickstart.ipynb`](quickstart.ipynb), that reads a live GeoLens
instance with nothing but [leafmap](https://leafmap.org/), geopandas and
`requests`. No SDK, because the point is that none of this needs one: GeoLens
serves OGC API Features, OGC API Records, STAC 1.0, MVT vector tiles and
raster tiles baked by TiTiler, and every one of them is plain HTTP.

```bash
uv run --with jupyterlab --with ipykernel --with pip jupyter lab quickstart.ipynb
```

`uv` builds a throwaway environment holding just enough to open the notebook;
the notebook's own first cell installs the pinned `leafmap`, `geopandas` and
`requests` versions into it. Already have Jupyter running? Open
`quickstart.ipynb` there instead and run the pip-install cell yourself.

## What it does

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
5. **Optional: segment the DEM with [samgeo](https://samgeo.gishub.org/).**
   Off by default (`RUN_SEGMENTATION = False`) because it needs `torch` and a
   multi-hundred-megabyte checkpoint. Flip the flag and install
   `segment-geospatial` to run it.

## Using your own instance

Change `GEOLENS` near the top of the notebook. That alone doesn't make the
rest of it run: the two subway collection ids and the DEM id are the public
demo's, so list `/api/collections` on your own instance and substitute
yours. Past that, the notebook's own assertions (the meteorite search
result, the subway row counts and titles), the map centers, and the raster
probe tile are all calibrated to the demo's data. They're what makes the
notebook check itself rather than requirements your catalog has to meet,
so expect to loosen or drop them once you're pointed elsewhere.

## Re-running the check

[`verify.py`](verify.py) executes the actual `quickstart.ipynb` headlessly
with `nbclient` (the same kernel a person opening it in Jupyter gets) and
fails on the first cell that raises, which is what the assertions inside the
notebook are for. It never runs the samgeo section, because that section is
off in the notebook itself rather than skipped by the checker: the file this
executes is the file a reader opens.

```bash
uv run leafmap/verify.py
```
