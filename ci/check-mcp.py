# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "mcp>=1.2,<2",
# ]
# ///
"""Smoke-check the claude-mcp example: spawn the published geolens-mcp server
over stdio against the demo, list its tools, and run one real search.

Run with: uv run ci/check-mcp.py
"""

import asyncio
import os
import sys

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


async def main() -> None:
    params = StdioServerParameters(
        command="uvx",
        args=["geolens-mcp"],
        env={
            **os.environ,
            "GEOLENS_INSTANCE": os.environ.get(
                "GEOLENS_INSTANCE", "https://demo.getgeolens.com"
            ),
        },
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

            print(f"tools: {sorted(tools)}")
            print("search_datasets(subway) returned content — OK")


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(main(), timeout=120))
    except TimeoutError:
        print("MCP smoke check timed out after 120s", file=sys.stderr)
        sys.exit(1)
