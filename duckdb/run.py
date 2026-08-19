# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb==1.5.5"]
# ///
"""Run features.sql statement by statement and print each result.

    uv run run.py            # features.sql next to this file
    uv run run.py other.sql

The DuckDB CLI does the same job (`duckdb < features.sql`); this exists so the
example runs where only Python and uv are installed, CI included. It exits
non-zero if any SELECT comes back empty, which is how CI notices the demo
changed under the example.
"""

import os
import sys
from pathlib import Path

import duckdb

# The spatial extension's GDAL is built against the Red Hat certificate bundle
# path. On Debian and Ubuntu (GitHub's runners included) every https read via
# ST_Read fails with "error adding trust anchors" until GDAL is pointed at the
# bundle those systems ship. The DuckDB CLI needs the same variable exported.
if not Path("/etc/pki/tls/certs/ca-bundle.crt").exists() and Path("/etc/ssl/certs/ca-certificates.crt").exists():
    os.environ.setdefault("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt")

path = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("features.sql"))
con = duckdb.connect()
for statement in duckdb.extract_statements(path.read_text()):
    if statement.type != duckdb.StatementType.SELECT:  # INSTALL, LOAD, CREATE, COPY
        con.execute(statement.query)
        continue
    # Materialise the SELECT once (a relation re-runs on every read, and two of
    # these go over the network), then print and check the local copy.
    con.execute(f"CREATE OR REPLACE TEMP TABLE shown AS {statement.query}")
    lines = statement.query.strip().splitlines()
    print(next(l for l in lines if l.strip() and not l.lstrip().startswith("--")), "...")
    con.table("shown").show()
    if not con.table("shown").fetchall():
        sys.exit(f"empty result for: {statement.query.strip()[:80]}")
