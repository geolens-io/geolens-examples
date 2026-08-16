# Embed a saved GeoLens map in your own page

`iframe.html` puts a saved GeoLens map inside a responsive iframe on a page that
is not GeoLens. There is no build step and no map library. The map you already
styled in the builder renders itself, and your page just gives it a box to live
in.

Every other example here reads GeoLens data and re-styles it client-side. This
one keeps the styling, legend and popups you configured.

It targets one specific share link on the demo, "Restless Earth". That link is
durable, not permanent: it would stop working if anyone revoked it or the demo
map were rebuilt from scratch. If you see GeoLens's "Map not found" card where
the map should be, that is what happened, and the code is fine.

This page is not yet in `ci/manifest.json`, so CI does not load it on every
push the way it loads the MapLibre, Leaflet, OpenLayers and ArcGIS examples.
Until it is, a revoked link would go unnoticed here.

## The URL

```
https://demo.getgeolens.com/m/<shareToken>?embed=true
```

`<shareToken>` is a share token, not the map's UUID. Requesting
`/api/maps/shared/<mapUUID>` returns 404. The token is a separate 32-byte random
secret.

`/m/<token>` is the only embeddable path. The ordinary viewer route,
`/maps/<mapUUID>`, serves `X-Frame-Options: SAMEORIGIN` and
`Content-Security-Policy: frame-ancestors 'self'`, so framing it from another
origin gives you a blank rectangle and this in the console:

```
Framing 'https://demo.getgeolens.com/' violates the following Content Security
Policy directive: "frame-ancestors 'self'". The request has been blocked.
```

That is deliberate. Only `/m/*` is built to be framed.

### Query parameters

Read by the viewer at `frontend/src/pages/PublicViewerPage.tsx`:

| Parameter | Effect |
|---|---|
| `embed=true` | Hides the site banner, footer and basemap switcher. Leaves the map, its title pill and optionally the legend. |
| `legend=true` / `legend=false` | Shows or hides the layer legend. Defaults to off when `embed=true`, on otherwise. |
| `center=lng,lat` | Overrides the map's saved centre. Silently ignored if out of range. |
| `zoom=<0-24>` | Overrides the saved zoom. |
| `et=<embedToken>` | A scoped embed token, for maps with private layers. See below. |
| `api_key=<key>` | An API key, as an alternative to `et`. |

`embed=true` also turns on a small GeoLens badge over the map, which is the
trade for a free embed. Enterprise instances can switch it off through the
branding setting.

## Using your own map

Make the map public first, or `POST /api/maps/{id}/share/` answers
`400 Map must be public before sharing`. Then create the link from the builder's
Share dialog, or call the API yourself:

```bash
curl -sS -X POST "https://your-geolens/api/maps/<mapId>/share/" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{}'
```

Put the returned `token` in `SHARE_TOKEN` and your host in `GEOLENS`.

With an empty body the token never expires. Pass `{"expires_in_days": 30}` if
you want it to, using 1, 7, 30 or 90; other values are rejected.

The raw token comes back only when the token is first created. Call the endpoint
again on a map that already has an active token and you get an eight-character
hint instead of anything you can embed. To recover a usable value you have to
revoke and re-create, and revoking a share token also kills every embed token on
that map.

## Public maps vs. private layers

A share token makes a public map reachable without a login. That is all
`iframe.html` needs, and it is why this example runs anonymously against the
demo.

The demo's token sits in `iframe.html` in the clear, and that is safe here for
one reason only: the map is public, so the token grants exactly what any
anonymous visitor to the demo catalog already has. Nothing is exposed by
publishing it that was not already public.

Do not read that as "share tokens are not credentials." A share token is
bearer-equivalent, and for a map whose layers are not public it is the entire
access control. Committing one to a repo, pasting it into a ticket or shipping
it in a client bundle hands that map to anyone who reads it. The rule is about
the map, not the token: public map, publishable token; anything else, treat it
like a password.

Maps with private layers need a second credential: a scoped embed token, passed
as `et=` next to the share token. These are a different thing from share tokens.

They are minted at `POST /api/maps/{mapId}/embed-tokens`, which requires
authentication. There is no anonymous path to one, by design, so this section is
documentation rather than a runnable example.

A token is scoped to a snapshot of that map's layer dataset IDs, frozen at mint
time, so a layer added afterwards is not covered by a token minted before it.
Tokens default to a 30-day expiry and one active token per map. Custom expiries
and `allowed_origins` domain-locking are Enterprise features.

Holding a token grants read access to exactly those datasets through the tile
and feature endpoints, via the `X-Embed-Token` header or the `et` query
parameter. It is bearer-equivalent: anyone who has it sees that data.

With `allowed_origins` set, the shell itself is domain-locked. The edge
validates the token and emits a per-token `frame-ancestors` policy on the HTML,
so a site that is not on the list gets blocked by the browser before the app
boots. An invalid or revoked token fails closed to `frame-ancestors 'none'`.

## React and Next.js

An embed is an `<iframe>`, so the React version is a component with no
dependencies and nothing GeoLens-specific in it. It works in the app and pages
routers, and as a server component:

```jsx
export function GeoLensMap({
  host = 'https://demo.getgeolens.com',
  shareToken,
  legend = true,
  title = 'Map',
}) {
  const src = `${host}/m/${shareToken}?embed=true&legend=${legend}`;
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9' }}>
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', height: '100%', border: 0 }}
      />
    </div>
  );
}
```

Keep the share token out of the bundle if the map is not meant to be
discoverable: read it from an environment variable server-side and pass it down.
For a public map it is not a secret, since it grants exactly what any visitor to
your catalog already has.

## The sandbox attribute

Use `sandbox="allow-scripts allow-same-origin"`, or leave `sandbox` off
entirely. Both work.

`sandbox="allow-scripts"` on its own does not, and it fails in a way worth
recognizing. An opaque origin makes every one of the viewer's ES module fetches
cross-origin, the static assets carry no `Access-Control-Allow-Origin` header,
and the shell reloads when they fail. You get a blank frame and several hundred
requests a minute.

`allow-same-origin` restores the frame's own origin, which is already a
different origin from your page. It gives the map no access to anything of
yours.

## Detecting a dead embed

`iframe.html` shows an error state if the frame has not loaded after 15 seconds.
That catches an unreachable host. It does not catch a revoked or expired token,
and nothing in the browser can. The shell returns 200 and renders GeoLens's own
"Map not found" card, which fires `load` like any successful page. The frame is
cross-origin so you cannot read into it, and `/api/maps/shared/{token}` sends no
CORS headers, so you cannot ask about the token from JavaScript either. CORS on
the demo is scoped to the OGC surface at `/api/collections`.

If you need to know that an embed is live, check it server-side.
