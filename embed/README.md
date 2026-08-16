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

CI loads this page against the live demo on pull requests, on pushes to `main`,
and on a weekly schedule, and fails if the frame stops rendering the map. So a
revoked link surfaces as a red build rather than as a blank box someone
eventually notices.

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
| `et=<embedToken>` | A scoped embed token, for maps with private layers. Viewer only; the API takes it as a header. See below. |
| `api_key=<key>` | Accepted, but do not use it here. See below. |

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

On a map with no share token yet, an empty body creates one that never expires.
Pass `{"expires_in_days": 30}` if you want one that does, using 1, 7, 30 or 90;
other values are rejected.

Against a map that already has an active token, the endpoint reuses the existing
row, and two things change. The raw token is not returned again, only an
eight-character hint, so you get nothing you can embed. And an empty body leaves
the stored expiry alone rather than clearing it, so a token minted with 30 days
stays on 30 days. Sending `expires_in_days` does update it, but there is no body
that sets an existing token back to never expiring.

To recover a usable raw value, or to clear an expiry you no longer want, revoke
and re-create. Revoking a share token also kills every embed token on that map.

## Public maps vs. private layers

A share token makes a public map reachable without a login. That is all
`iframe.html` needs, and it is why this example runs anonymously against the
demo.

The demo's token sits in `iframe.html` in the clear, and that is safe here for
one reason only: the map is public, so the token grants exactly what any
anonymous visitor to the demo catalog already has. Nothing is exposed by
publishing it that was not already public.

Do not read that as "share tokens are not credentials." A share token is
bearer-equivalent: anyone holding it gets the map without logging in. Publishing
one for a map you did not mean to hand out gives away the map, its composition,
and every layer on it that an anonymous visitor is allowed to see.

What a share token does not do is leak private data. The shared-map endpoint
runs each layer through the same visibility rules as the rest of the catalog
with no user attached, so a private layer is dropped from the response rather
than served to the holder. That is precisely why the next section needs a second
credential. The embed token is what gates non-public data, which makes it the
one that must never be committed, pasted into a ticket or shipped in a client
bundle.

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
and feature endpoints, via the `X-Embed-Token` header. The header is the only
way in. No tile or feature route reads a token from the query string, so
`/api/tiles/data.foo/12/1/1.pbf?et=<token>` gets you nothing. `et=` is a viewer
parameter rather than an API one: the `/m/` page reads it client-side and sends
it as a header on the requests it makes for you. The token is bearer-equivalent
either way, so anyone who has it sees that data.

With `allowed_origins` set, the shell itself is domain-locked. The edge
validates the token and emits a per-token `frame-ancestors` policy on the HTML,
so a site that is not on the list gets blocked by the browser before the app
boots. An invalid or revoked token fails closed to `frame-ancestors 'none'`.

### Why not `api_key=`

The viewer also accepts a plain `api_key=` query parameter, so it will appear to
work where `et=` does. Do not use it for an embed. An iframe `src` is visible in
the page source of every site the embed appears on, and it travels into browser
history, referrer headers, proxy logs and analytics. An API key is scoped to a
user across the whole catalog, not to one map, and revoking it breaks everything
else that user's key is doing.

An embed token is the narrower instrument, and the difference is the point: it
covers a frozen snapshot of one map's datasets, it expires, and revoking it
affects nothing but that embed. The parameter is documented above because it
exists and you will find it; it is not an alternative worth reaching for.

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

Mostly you cannot, and the shape of what you can detect is worth understanding
before you write a health check that does not work.

An iframe fires `load` whether the frame succeeded or failed, and never fires
`error`. Measured in Chromium with both listeners attached before `src` was set:

| case | first event |
|---|---|
| dead host | `load` at 5ms |
| DNS failure | `load` at 28ms |
| 404 on a live host | `load` at 130ms |
| CSP frame-refused | `load` at 145ms |
| working embed | `load` at 295ms |
| server accepts then stalls | no event, ever |

Every failure the browser can detect resolves faster than the success case, so
no timeout separates a broken embed from a working one. A revoked token is the
hardest of those: the shell returns 200 and renders GeoLens's own "Map not
found" card, a successful load by every measure available from outside, and the
frame is cross-origin so nothing on the host page can read into it.

The last row is the exception, and it is the only thing a timer is good for. A
server that accepts the connection and then holds it open fires no event at all,
so without a timeout the page waits on "Loading map…" indefinitely.
`iframe.html` therefore keeps a 15-second timer that reports a stall and says
nothing about whether the link is valid. Those are genuinely different
questions, and a timer can only answer the first.

Asking the API instead depends on the deployment. On a default instance
`/api/maps/shared/{token}` sends no CORS headers, so the fetch fails in the
browser; the anonymous wildcard is scoped to the OGC surface at
`/api/collections`. If the operator has listed your site in
`CORS_ALLOWED_ORIGINS`, which is the setup the rest of this repo recommends,
then `DynamicCORSMiddleware` serves credentialed CORS on every route including
that one, and a client-side check becomes possible. That only helps when you
control the instance. Against the demo you do not.

So check server-side if it matters, and tell the reader what a stale link looks
like when it does not. That is what the caption under the map is for.
