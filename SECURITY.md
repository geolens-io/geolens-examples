# Security Policy

This repo holds static example code (HTML files and a single-file Python script) that talks to a GeoLens server over its public API. There's no server, no user data, and no build pipeline of its own here, but two different kinds of report can come out of it, and they go to different places.

## An unsafe pattern in an example

If an example does something that would be unsafe to copy into a real application (rendering untrusted data as HTML, leaking a credential in a URL, disabling a security check just to make a demo run), please don't open a public issue or PR describing the exploit. Someone may already have copied the pattern into a deployed app, and a public writeup before a fix lands makes that easier to find and hit.

Use the "Report a vulnerability" button on this repository's Security tab: private vulnerability reporting is enabled here, and it's the more discoverable route. If you'd rather not use GitHub, email **security@getgeolens.com** instead. Either way, include:

- Which file and line
- What the unsafe pattern does and why it's exploitable
- A suggested fix, if you have one

We'll acknowledge within 48 hours. Fixes land as a normal PR once triaged; example code doesn't carry a CVE or a release, so there's no disclosure timeline beyond that.

## A vulnerability in the GeoLens server

If you find a vulnerability in the GeoLens server itself, in official container images or packages, or in the public demo (demo.getgeolens.com), including while running one of these examples, that's covered by the main repository's policy, not this one: see [geolens-io/geolens's SECURITY.md](https://github.com/geolens-io/geolens/blob/main/.github/SECURITY.md) for full scope and response timeline. Report it through the same channels above.
