# Codex CLI

Add a `[mcp_servers.geolens]` table to `~/.codex/config.toml`:

```toml
[mcp_servers.geolens]
command = "uvx"
args = ["geolens-mcp@1.14.0"]

[mcp_servers.geolens.env]
GEOLENS_INSTANCE = "https://demo.getgeolens.com"
```

For your own instance, change `GEOLENS_INSTANCE` and add `GEOLENS_API_KEY` to the same `env` table.
