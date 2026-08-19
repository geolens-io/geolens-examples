# Working in geolens-examples

`CONTRIBUTING.md` holds the rules for an example itself (one file, pinned library, runs anonymously against the demo, what CI checks). This file holds the rules that reach across repos: the public demo, the docs site, the product README and the `geolens` source. Read both before changing anything here.

## Rules for changing this repo

1. When you add, change or remove a demo dataset UUID, table name, map UUID or share token that an example loads or links, update `ci/fixtures.json` in the same change and run `node ci/check-fixtures.mjs`. An ID the preflight does not know about reads as a broken example when the demo simply reset (CONTRIBUTING.md, Demo fixtures). Transcript output quoted in a README is illustrative and is not a fixture.

2. When an example depends on a demo dataset or map that `geolens/scripts/seed-showcase.py` does not pin (`PINNED_DATASET_TITLES`, `PINNED_FOREIGN_DATASET_TITLES`), ask for it to be pinned upstream before the example merges (a `geolens` PR or issue, rule 13). Unpinned fixtures are the ones a demo reset drops.

3. When you bump a GeoLens client pin, bump every pin at once, run `uv run ci/check-pins.py`, and re-run the full sweep against the demo. One pin moved on its own is drift nobody sees until an example stops matching the docs.

4. When you add a new form of pin (a Dockerfile `ARG`, a new file type), add its regex to `PATTERNS` in `ci/check-pins.py` and its suffix to `SUFFIXES` there (a `Dockerfile` has no suffix and is never read). That script is the only registry, and the pin it cannot see is the one that goes stale.

5. When the weekly run prints `WARNING: the demo runs X, this repo pins Y`, treat it as a task: bump, sweep, and read the geolens CHANGELOG for anything that changes what an example claims. Nothing dispatches a release to this repo; that warning is the only signal, and it never fails the build.

6. When you explain server behaviour the docs own (auth order, tile tokens, CORS, paging, manifest schema, export formats, analysis operations), write one sentence and link the `docs.getgeolens.com` page. When you have to say more, it is because the docs lack it: name what you verified against (a `geolens/backend/...` path or an issue number) in the comment, and open a docs PR or issue in `getgeolens.com` with the same text (rule 13).

7. When you add an outbound link to `getgeolens.com`, `docs.getgeolens.com`, or a `github.com/geolens-io/...` blob, tree, issue or pull path, run `uv run ci/check-links.py` afterwards; it checks the route and, on a docs page, the `#anchor`. CI runs it on every pull request and push to `main`; the Outbound links bullet in CONTRIBUTING.md has the details.

8. When you write an install one-liner, a port, `localhost:8080` or OGC wording, copy it from `getgeolens.com/public/docs-contract.json` rather than paraphrasing, and never write one of its `forbidden` patterns. That file is what those facts are checked against in the product READMEs, the marketing pages and the docs, and nothing scans this repo for it.

9. When you add an example directory or a new kind of example, get the sentence that describes this repo in `geolens/README.md` (and its de/es/fr copies) updated in `geolens` (rule 13). It went stale within two days of the last two example PRs.

10. When every browser example fails at once, read the "Preflight the demo fixtures" step first. Do not swap IDs until it names a fixture that moved; a demo that is down exits 75 and says nothing about this repo.

11. When prose needs a version floor, write "v1.13.0 or newer", never `geolens==`, `@geolens/sdk@`, or a backticked client name followed by a version. `ci/check-pins.py` reads those forms as pins and fails on the disagreement.

12. Before starting, run `gh pr list --state all --limit 10` and `git fetch origin main`. PRs may be landing here and in `geolens` at the same time, from another session or person; start from what has already merged.

13. Changes to `geolens` or `getgeolens.com` go in their own PR in that repo, made from a checkout or worktree of that repo after checking nobody else has it open (`gh pr list` there, and look for other worktrees). Do not edit `../geolens` or `../getgeolens.com` from a task here. When you cannot open that PR, file an issue there with the exact text you would have written.

14. Examples stay pinned; docs stay unpinned. That split is intentional: when a docs page needs a version it tells the reader to match their instance (which `/api/health` reports) and links here for the pinned command, and when an example needs one it pins.
