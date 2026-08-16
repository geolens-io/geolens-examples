# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "mcp>=1.2,<2",
# ]
# ///
"""Smoke-check the claude-mcp example: spawn the geolens-mcp server over stdio
against the demo, list its tools, and run one real search.

Runs twice, because the two runs catch different things:

  pinned  the exact version claude-mcp/ tells users to install. This is the
          one that gates the build. A check that does not exercise what the
          docs say to run is testing the wrong thing.
  latest  whatever `uvx geolens-mcp` resolves today. Early warning that a new
          release broke against a live instance. That is real information but
          it is not a regression in this repo, and failing on it would block
          unrelated PRs, so it warns and does not fail.

The pinned version is read from claude-mcp/mcp-config.example.json rather than
written here. Two independent copies of a version string is the bug PR #7 just
fixed, and rebuilding it one directory over would be a poor tribute.

Run with: uv run ci/check-mcp.py
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

EXPECTED_TOOLS = {
    "search_datasets",
    "get_dataset_schema",
    "get_features",
    "list_maps",
    "get_map",
    "query",
}

REPO = Path(__file__).resolve().parent.parent
MCP_CONFIG = REPO / "claude-mcp" / "mcp-config.example.json"
INSTANCE = os.environ.get("GEOLENS_INSTANCE", "https://demo.getgeolens.com")


def documented_spec() -> str:
    """The `uvx` argument claude-mcp/mcp-config.example.json documents."""
    config = json.loads(MCP_CONFIG.read_text())
    args = config["mcpServers"]["geolens"]["args"]
    spec = next((a for a in args if a.startswith("geolens-mcp")), None)
    if spec is None:
        raise SystemExit(f"{MCP_CONFIG} names no geolens-mcp package in args: {args}")
    if not re.fullmatch(r"geolens-mcp@\d+\.\d+\.\d+", spec):
        raise SystemExit(
            f"{MCP_CONFIG} should pin an exact version (geolens-mcp@X.Y.Z), got {spec!r}. "
            "The docs and this check read the same string, so unpinning there unpins CI here."
        )
    return spec


def _returned_count(content) -> int:
    """How many datasets the tool actually returned.

    The features array is the evidence; numberReturned is the server's claim
    about itself. Taking the larger of the two let a response of
    {"numberReturned": 1, "features": []} report one dataset the client never
    received, which is the same metadata-over-artifact hole the browser
    verifier had. Every way of being unreadable raises rather than returning a
    number, so a body this cannot understand fails instead of counting as zero
    and hiding behind some other assertion.
    """
    text = "".join(getattr(block, "text", "") or "" for block in content)
    try:
        body = json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        raise AssertionError(f"search_datasets returned a body that is not JSON: {exc}") from exc

    features = body.get("features") if isinstance(body, dict) else None
    if not isinstance(features, list):
        raise AssertionError(
            "search_datasets returned JSON with no features array, so it is not a FeatureCollection"
        )

    claimed = body.get("numberReturned")
    if isinstance(claimed, int) and claimed != len(features):
        raise AssertionError(
            f"search_datasets claims numberReturned={claimed} but carries {len(features)} "
            "feature(s) — the response contradicts itself"
        )
    return len(features)


async def check(spec: str) -> None:
    params = StdioServerParameters(
        command="uvx",
        args=[spec],
        env={**os.environ, "GEOLENS_INSTANCE": INSTANCE},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = {t.name for t in (await session.list_tools()).tools}
            missing = EXPECTED_TOOLS - tools
            assert not missing, f"server is missing documented tools: {missing}"

            result = await session.call_tool(
                "search_datasets", {"query": "subway", "limit": 1}
            )
            assert not result.isError, f"search_datasets errored: {result.content}"
            assert result.content, "search_datasets returned no content"

            # Judge the result set, not the envelope. A query matching nothing
            # comes back isError=False with truthy content carrying
            # numberReturned 0 and an empty features list, so asserting on
            # content alone passes against an empty catalog, a broken search
            # index, or the dataset having been removed. Verified against the
            # live demo before writing this.
            found = _returned_count(result.content)
            assert found > 0, (
                "search_datasets('subway') returned an empty result set. "
                "The server answered fine; it just found nothing."
            )

            print(f"  tools: {sorted(tools)}")
            print(f"  search_datasets(subway) returned {found} dataset(s)")


async def main() -> int:
    pinned = documented_spec()

    print(f"[pinned] {pinned} against {INSTANCE} — this one gates the build")
    try:
        await asyncio.wait_for(check(pinned), timeout=120)
    except TimeoutError:
        print(f"FAILED (pinned): {pinned} timed out after 120s", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - the failure text is the signal
        print(f"FAILED (pinned): {pinned}: {exc!r}", file=sys.stderr)
        print(
            "The version claude-mcp/ documents does not work against the demo. "
            "Fix the server or correct the pin in claude-mcp/mcp-config.example.json.",
            file=sys.stderr,
        )
        return 1
    print(f"[pinned] {pinned} OK")

    print(f"\n[latest] geolens-mcp (unpinned) against {INSTANCE} — warning only")
    try:
        await asyncio.wait_for(check("geolens-mcp"), timeout=120)
        print("[latest] geolens-mcp OK")
    except TimeoutError:
        print(f"WARNING (latest): unpinned geolens-mcp timed out after 120s; {pinned} passed")
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING (latest): unpinned geolens-mcp failed: {exc!r}")
        print(f"WARNING (latest): {pinned} passed, so this repo is not broken. A newer release may be.")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
