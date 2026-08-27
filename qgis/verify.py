"""Headless check that QGIS reads the GeoLens demo. Run it with the Python QGIS ships:
    QT_QPA_PLATFORM=offscreen /Applications/QGIS.app/Contents/MacOS/python qgis/verify.py [render.png] [project.qgz]
Opens the two subway collections over OGC API - Features and the Matterhorn DEM as XYZ
tiles, asserts every layer is valid, the counts match the catalog (496 stations, 29
lines) and a CQL2 subset filter answers right (153 Manhattan stations), renders the subway
layers to a 760x427 PNG and, given a second path, writes the same layers out as a QGIS
project."""
import glob, os, sys
from urllib.parse import quote

# QGIS finds its providers through the prefix path: the macOS app bundle by default,
# QGIS_PREFIX_PATH for anything else (a Linux package install is /usr).
PREFIX = os.environ.get("QGIS_PREFIX_PATH") or next(iter(glob.glob("/Applications/QGIS*.app")), "/usr")
# The macOS bundle keeps its own PROJ grid data and needs to be told where; a
# packaged Linux install has PROJ configured already, so leave it alone there.
_bundled_proj = PREFIX + "/Contents/Resources/qgis/proj"
if os.path.isdir(_bundled_proj):
    os.environ.setdefault("PROJ_DATA", _bundled_proj)

from qgis.core import (Qgis, QgsApplication, QgsCoordinateReferenceSystem, QgsCoordinateTransform,
                       QgsMapRendererParallelJob, QgsMapSettings, QgsProject, QgsRasterLayer,
                       QgsRectangle, QgsReferencedRectangle, QgsVectorLayer)
from qgis.PyQt.QtCore import QEventLoop, QSize, Qt
from qgis.PyQt.QtGui import QColor

QgsApplication.setPrefixPath(PREFIX, True)
app = QgsApplication([], False)
app.initQgis()
print("QGIS", Qgis.QGIS_VERSION)

GEOLENS = "https://demo.getgeolens.com"
API = GEOLENS + "/api/"  # keep the slash: bare /api answers with a redirect QGIS cannot follow
LINES = "de602fbe-8b30-4755-924f-c9e7fd9613b6"
STATIONS = "724bf894-dc1a-418c-abc6-555798c44d7c"
DEM = "6f03bafa-34b3-4902-9351-40ce09a8181f"

def oapif(collection_id, name):
    return QgsVectorLayer(f"url='{API}' typename='{collection_id}' pagingEnabled='true'", name, "OAPIF")

lines = oapif(LINES, "NYC subway lines")
stations = oapif(STATIONS, "NYC subway stations")
template = f"{GEOLENS}/raster-tiles/{DEM}/tiles/{{z}}/{{x}}/{{y}}.png"
dem = QgsRasterLayer("type=xyz&zmin=0&zmax=17&url=" + quote(template, safe=":/"), "Matterhorn DEM", "wms")

for layer in (lines, stations, dem):
    assert layer.isValid(), f"{layer.name()} did not load"
counts = {layer.name(): sum(1 for _ in layer.getFeatures()) for layer in (lines, stations)}
print(counts)
assert counts == {"NYC subway lines": 29, "NYC subway stations": 496}, counts

# fix(geolens-examples#45): GeoLens 1.16.0 declares the Part 3 filter classes, so a
# subset string travels to the server as CQL2 (measured; README section 2). The count
# is the same if a QGIS build evaluates it client-side instead, so this asserts the
# filter's answer, not which side computed it.
assert stations.setSubsetString("\"borough\" = 'M'"), "subset string rejected"
manhattan = sum(1 for _ in stations.getFeatures())
assert manhattan == 153, f"borough = 'M' matched {manhattan} stations, expected 153"
print("subset filter borough = 'M' matched", manhattan, "stations")
stations.setSubsetString("")

# Same palette as the browser examples: blue lines, amber stations, dark ground.
lines.renderer().symbol().setColor(QColor("#4da3ff"))
lines.renderer().symbol().setWidth(0.4)
stations.renderer().symbol().setColor(QColor("#ffd166"))
stations.renderer().symbol().setSize(1.1)
stations.renderer().symbol().symbolLayer(0).setStrokeStyle(Qt.PenStyle.NoPen)

mercator = QgsCoordinateReferenceSystem("EPSG:3857")
project = QgsProject.instance()
project.setCrs(mercator)
project.setBackgroundColor(QColor("#0d1117"))
project.addMapLayers([stations, lines, dem])
extent = QgsCoordinateTransform(stations.crs(), mercator, project).transformBoundingBox(stations.extent())
extent.scale(1.08)

def render(layers, box, size=QSize(760, 427)):
    settings = QgsMapSettings()
    settings.setLayers(layers)
    settings.setDestinationCrs(mercator)
    settings.setBackgroundColor(QColor("#0d1117"))
    settings.setOutputSize(size)
    settings.setExtent(box)
    job = QgsMapRendererParallelJob(settings)
    loop = QEventLoop()
    job.finished.connect(loop.quit)
    job.start()
    loop.exec()
    return job.renderedImage()

out = sys.argv[1] if len(sys.argv) > 1 else "qgis-features.png"
assert render([stations, lines], extent).save(out), f"could not write {out}"
print("rendered", out)

# isValid() on an XYZ layer only says the provider accepted the template. Draw
# the DEM over the Matterhorn and require more than one colour, so a route that
# starts answering errors or blank tiles fails here instead of passing quietly.
wgs84 = QgsCoordinateReferenceSystem("OGC:CRS84")
summit = QgsCoordinateTransform(wgs84, mercator, project).transformBoundingBox(
    QgsRectangle(7.63, 45.95, 7.70, 46.00))
image = render([dem], summit, QSize(256, 256))
shades = {image.pixel(x, y) for x in range(0, 256, 16) for y in range(0, 256, 16)}
assert len(shades) > 4, f"DEM render is a flat fill ({len(shades)} colour(s)): tiles did not paint"
print("DEM painted", len(shades), "distinct colours in a 16x16 sample")

if len(sys.argv) > 2:
    project.viewSettings().setDefaultViewExtent(QgsReferencedRectangle(extent, mercator))
    assert project.write(sys.argv[2]), f"could not write project {sys.argv[2]}"
    print("project written", sys.argv[2])
app.exitQgis()
