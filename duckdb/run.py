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

import sys
from pathlib import Path

import duckdb

path = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("features.sql"))
con = duckdb.connect()
for statement in duckdb.extract_statements(path.read_text()):
    rel = con.sql(statement.query)
    if rel is None:  # INSTALL, LOAD, CREATE, COPY: nothing to show
        continue
    lines = statement.query.strip().splitlines()
    print(next(l for l in lines if l.strip() and not l.lstrip().startswith("--")), "...")
    rel.show()
    if not rel.fetchall():
        sys.exit(f"empty result for: {statement.query.strip()[:80]}")
