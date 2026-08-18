"""Headless check that QGIS reads the GeoLens demo. Run it with the Python QGIS ships:
    QT_QPA_PLATFORM=offscreen /Applications/QGIS.app/Contents/MacOS/python qgis/verify.py [render.png] [project.qgz]
Opens the two subway collections over OGC API - Features and the Matterhorn DEM as XYZ
tiles, asserts every layer is valid and the counts match the catalog (496 stations, 29
lines), renders the subway layers to a 760x427 PNG and, given a second path, writes the
same layers out as a QGIS project."""
import glob, os, sys
from urllib.parse import quote

# QGIS finds its providers through the prefix path: the macOS app bundle by default,
# QGIS_PREFIX_PATH for anything else (a Linux package install is /usr).
PREFIX = os.environ.get("QGIS_PREFIX_PATH") or next(iter(glob.glob("/Applications/QGIS*.app")), "/usr")
os.environ.setdefault("PROJ_DATA", PREFIX + "/Contents/Resources/qgis/proj")

from qgis.core import (Qgis, QgsApplication, QgsCoordinateReferenceSystem, QgsCoordinateTransform,
                       QgsMapRendererParallelJob, QgsMapSettings, QgsProject, QgsRasterLayer,
                       QgsReferencedRectangle, QgsVectorLayer)
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

settings = QgsMapSettings()
settings.setLayers([stations, lines])
settings.setDestinationCrs(mercator)
settings.setBackgroundColor(QColor("#0d1117"))
settings.setOutputSize(QSize(760, 427))
settings.setExtent(extent)
job = QgsMapRendererParallelJob(settings)
loop = QEventLoop()
job.finished.connect(loop.quit)
job.start()
loop.exec()
out = sys.argv[1] if len(sys.argv) > 1 else "qgis-features.png"
job.renderedImage().save(out)
print("rendered", out)

if len(sys.argv) > 2:
    project.viewSettings().setDefaultViewExtent(QgsReferencedRectangle(extent, mercator))
    print("project written" if project.write(sys.argv[2]) else "project write FAILED", sys.argv[2])
app.exitQgis()
