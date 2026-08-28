# Claude Code

```bash
claude mcp add geolens -e GEOLENS_INSTANCE=https://demo.getgeolens.com -- uvx geolens-mcp@1.16.1
```

For your own instance, add the key:

```bash
claude mcp add geolens \
  -e GEOLENS_INSTANCE=https://geolens.example.com \
  -e GEOLENS_API_KEY=your-api-key \
  -- uvx geolens-mcp@1.16.1
```

`claude mcp add` writes to your local project scope by default; pass `-s user` to make it available
in every project. Prefer a checked-in config? A `.mcp.json` at the repo root does the same job and
travels with the project; [`generic.json`](./generic.json) has the shape.

Keep real API keys out of a committed `.mcp.json`. Use `claude mcp add` locally, or have the config
reference an environment variable your shell already exports.
