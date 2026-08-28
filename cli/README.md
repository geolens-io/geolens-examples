# Catalog as code with the GeoLens CLI

See the [CLI guide](https://docs.getgeolens.com/guides/cli/) for install and command reference.

A GeoLens catalog can be a thing people click together, or it can be a file in Git that a machine
reconciles. [`geolens.yaml`](geolens.yaml) is the second one: it declares what datasets exist, where
their data comes from, what metadata rides along, and whether each is published. `geolens apply`
POSTs that declaration to an instance, and the instance makes itself match. What the catalog holds
then shows up in a diff and a review, instead of in someone's memory of last Tuesday.

```
   geolens.yaml            geolens apply          the catalog
   in a Git repo    ─────────────────────────▶   on your instance
        │                (POST the manifest)            │
        │                                               │
   reviewed in a PR                            served straight out as
   like any code                               OGC API Features + Records,
                                               STAC 1.0, MVT and raster tiles
```

Nothing special happens at the far end. A dataset that arrived through a manifest is an ordinary
dataset, so every other example in this repo consumes it with no change at all.

## What is in this directory

| file | what it is |
| --- | --- |
| [`geolens.yaml`](geolens.yaml) | Two Natural Earth layers declared as a catalog. Comments explain each field that carries a decision. |
| [`github-actions.yml`](github-actions.yml) | A workflow for *your* repo: validate and preview on a PR, apply on a push to main. |

The manifest points at pinned Natural Earth GeoJSON on `raw.githubusercontent.com`, because `apply`
sends the document and nothing else. The server fetches the data itself, so every source has to be
a URI the server can already reach. A scheme-less path in a manifest is resolved against the
*server's* staging directory, not yours, and the CLI warns when it sees one, on stderr and only outside
`--json` mode. `geolens publish <file>` is the command that actually uploads a local file; see
[Publish a single file](https://docs.getgeolens.com/guides/cli/#publish-a-single-file).

## The three commands

Everything below runs the CLI through `uvx`, which fetches the pinned release on demand. There is
nothing to install and no virtualenv to keep.

### `validate`: offline, no instance, no credential

```bash
uvx --from geolens-cli==1.16.1 geolens validate cli/geolens.yaml
# Manifest valid: cli/geolens.yaml
```

This reads the manifest against the JSON Schema packaged inside the CLI and never opens a socket.
A dataset `key` that breaks the identity pattern, a `publication` block with no `intent`, a vector
source whose URI does not end in a format the server ingests: all of it fails here, in a second, on
a fork, with no secrets configured. `geolens schema` prints the schema itself over the same offline
path, which is what an editor wants for completion.

### `apply --dry-run`: reaches an instance, writes nothing

```bash
uvx --from geolens-cli==1.16.1 geolens --json apply --dry-run cli/geolens.yaml
```

The instance matches each entry to an existing dataset by `key`, fingerprints the rest, and answers
with a `create` / `update` / `skip` per entry. That is the review-time answer to "what does merging
this branch actually change?", and it is the reason `key` is worth thinking about once: it is the
identity across every future apply, so an entry whose key changes reads as a brand new dataset
rather than an edit to an old one.

`--json` goes *before* the subcommand. It is a global option, so `geolens --json apply` works and
`geolens apply --json` is an error.

### `apply`: the write

```bash
uvx --from geolens-cli==1.16.1 geolens --json apply cli/geolens.yaml
```

Same request without `dry_run`. Applying an unchanged entry skips rather than re-importing, so this
is safe to run on every push. It reconciles *declared configuration*, though, not data: if a source
URL serves new contents while the manifest is byte-identical, apply still skips it.

`geolens refresh <dataset-id>` re-pulls datasets that keep an upstream binding (a WFS/ArcGIS/OGC API
Features service, a registered PostGIS table, a STAC item). A manifest source the server downloaded
is an ordinary upload once ingested, so refresh refuses it; change the entry or its URI so apply sees
an update.

## Authenticating non-interactively

`geolens login` is interactive and writes to your OS keyring. CI wants neither. The CLI reads two
environment variables, and setting both replaces login entirely, so no credential ever touches the
runner's disk:

| variable | what it does |
| --- | --- |
| `GEOLENS_INSTANCE` | The instance URL. The CLI normalizes it and appends `/api` if you left it off. A `--instance` flag beats it. |
| `GEOLENS_TOKEN` | A bearer token, checked *before* the credentials file and the keyring. |

That is the whole list. `geolens_cli/config.py` reads exactly these two out of the environment.
There is no `GEOLENS_API_KEY`. If an API key is what you have, the CLI takes one only through
storage:

```bash
echo "$GEOLENS_API_KEY" | uvx --from geolens-cli==1.16.1 geolens login \
  https://geolens.example.com --api-key - --no-keyring
```

That writes a `0600` credentials file and makes no network call, so it is a local step rather than a
login round-trip. Piping through stdin keeps the key out of `argv` and out of the runner's process
list. Note the precedence: a bearer token in `GEOLENS_TOKEN` wins over a stored API key, so set one
or the other and not both. Bearer tokens expire and the environment variable path does not refresh
itself, which is the argument for the API key on a schedule that runs unattended.

## The public demo will not accept any of this

Every other example in this repo runs anonymously against `demo.getgeolens.com`. The `apply` steps
here cannot. Applying a manifest is a write, writes need a credential, and the demo hands out none:

```bash
GEOLENS_INSTANCE=https://demo.getgeolens.com \
  uvx --from geolens-cli==1.16.1 geolens apply --dry-run cli/geolens.yaml
# Error: Manifest apply request failed (401): Could not validate credentials
```

Even `--dry-run` needs the credential, because the dry run happens on the server. So run both apply
commands against your own instance. `validate` and `schema` have no such problem: they never contact
a server, which is why they are the parts this repo's CI runs on every pull request and push to `main`.

## Wiring it into your repo

[`github-actions.yml`](github-actions.yml) is meant to be copied into `.github/workflows/` in the
repo that holds your manifest. It is three jobs. `validate` runs on every event with no secrets and
checks the manifest offline. `preview` runs on pull requests and asks the instance what applying
would change, with `--dry-run`. `apply` runs on a push to `main`, and only there. `preview` skips
its dry run and says so when its secret is missing, so a fork's pull request stays green and honest
about what it checked. `apply` does the opposite: a push to `main` with `GEOLENS_INSTANCE` or
`GEOLENS_TOKEN` unset fails on purpose, because green on `main` has to mean the manifest was
applied, and a `catalog` environment nobody has set up yet must not pass for one. Applies to
`main` run one at a time, and a run in progress is left to finish rather than cancelled half way.
Because GitHub queues runs without promising their order, the apply step also checks that its
commit is still the tip of `main` before writing, and steps aside if a newer push has landed, so
the catalog ends up holding the manifest on `main` and not an older one that happened to run last.

Why three jobs rather than one: a pull request from a branch in the same repository receives the
repository's secrets, and it can edit the workflow it runs. A write-capable token in a job that runs
on pull requests is therefore a token any contributor can read out or use for a real apply. So the
write token is never in the pull-request path. `preview` uses a separate, low-privilege credential,
and `apply` runs behind a GitHub environment named `catalog`, whose secrets GitHub hands only to
runs that target the branch you restrict it to.

One GitHub Actions detail worth copying rather than rediscovering: the `secrets` context cannot be
read from an `if:` condition. The secrets go into job-level `env`, and the steps guard on
`env.GEOLENS_TOKEN != ''`. Writing `if: ${{ secrets.GEOLENS_TOKEN != '' }}` does not work.

Three secrets:

- `GEOLENS_INSTANCE`, a repository secret, for example `https://geolens.example.com`
- `GEOLENS_PREVIEW_TOKEN`, a repository secret: a bearer token for a user or key allowed to read the
  catalog and ask for a dry run, and nothing more, since whatever it can do a pull request can do
- `GEOLENS_TOKEN`, an *environment* secret in an environment named `catalog` restricted to `main`: a
  bearer token for a user allowed to write to the catalog

## Editing the manifest

Change titles, descriptions, tags and `publication.intent` freely; those are updates to the datasets
their keys name. Keep `key` stable, or you get a new dataset next to the old one. See
[Manifest schema (v1)](https://docs.getgeolens.com/guides/cli/#manifest-schema-v1) for the full
field list. Only one `sources` entry per dataset is allowed by the schema, and the source URI must
end in something the ingest path recognises: `zip`, `gpkg`, `geojson`, `json`, `csv`, `xlsx` or
`xls` for `vector`, and `tif` or `tiff` for `raster_cog`.

`publication.intent` is deliberately not a fixed enum. The valid values come from the workflow
statuses your deployment defines, validated server-side when you apply. The community default runs
`draft`, `ready`, `internal`, `published`, which is why `geolens validate` accepts an intent your
instance may still reject.
