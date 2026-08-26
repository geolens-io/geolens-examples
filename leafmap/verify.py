# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "nbclient==0.11.0",
#     "nbformat==5.11.1",
#     "ipykernel==7.3.0",
#     "leafmap==0.63.1",
#     "geopandas==1.1.4",
#     "requests==2.33.1",
# ]
# ///
"""Execute quickstart.ipynb headlessly against a live GeoLens instance.

Run it with no setup at all:

    uv run leafmap/verify.py

uv reads the PEP 723 block above and builds one throwaway environment holding
both the notebook's own dependencies and the ones needed to run it outside
Jupyter (nbclient drives the same kernel a person opening the notebook would
get). This runs the actual shipped .ipynb, not a copy of its logic: the
assertions that matter live in the notebook's own cells, and a cell raising
is what turns this red.

The one thing this never runs is the optional samgeo section, because it's
off by default in the notebook itself (`RUN_SEGMENTATION = False`) rather
than skipped here: the same file a person opens is the file this executes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError

NOTEBOOK = Path(__file__).with_name("quickstart.ipynb")


def main() -> int:
    print(f"Executing {NOTEBOOK.name} ...")
    nb = nbformat.read(NOTEBOOK, as_version=4)
    client = NotebookClient(nb, timeout=120, kernel_name="python3")
    try:
        client.execute()
    except CellExecutionError as exc:
        print(f"\n{NOTEBOOK.name} failed:\n{exc}", file=sys.stderr)
        return 1

    # Print what each cell printed, so a green run in CI shows the same catalog
    # search results, feature counts and CQL2 match a person sees in Jupyter.
    for cell in nb.cells:
        for output in cell.get("outputs", []):
            if output.get("output_type") == "stream":
                print(output["text"], end="")
            elif output.get("output_type") == "error":
                print("\n".join(output.get("traceback", [])), file=sys.stderr)
                return 1

    print(f"\n{NOTEBOOK.name} executed cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
