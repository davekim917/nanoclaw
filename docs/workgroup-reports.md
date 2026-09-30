# Workgroup reports

An agent publishes a page for the humans in its workgroup by writing it under
`/workspace/workgroup/artifacts/reports/<slug>/` (host:
`data/workgroups/<workgroup>/artifacts/reports/<slug>/`). The host serves it at

```
<NANOCLAW_DASHBOARD_URL>/dashboard/reports/<workgroup>/<slug>/
```

`<slug>/` serves `<slug>/index.html`; `<slug>/<name>.png` serves the image. Nothing else
is served: only `.html` and `.png`, no dot-named files or directories, and no file whose
real path leaves that workgroup's `artifacts/reports/`.

## Who can open it

The dashboard's session cookie (`/dashboard-token` in Slack), and a user whose scope
reaches an agent group in that workgroup: the owner, a global admin, or an admin or member
of one of its groups. Anyone else, and an unknown workgroup, gets the same 404.

The cookie is `SameSite=Strict`, so a link followed from Slack arrives without it. The
host answers that request with a small page that reloads the same URL, a same-site
navigation that carries the cookie. A viewer who is still signed out sees how to sign in.

## What a page may do

Pages are agent-authored and share the dashboard's origin, so every response carries a CSP
sandbox without `allow-same-origin`, plus `default-src 'none'`:

- Inline `<script>` and `<style>` run. Filters, tabs, sorting and expanders work.
- No subresource network: no `fetch`, XHR or WebSocket, and no external script,
  stylesheet, font or remote image. Images must be `data:` URIs. A page is one
  self-contained file.
- No storage: `localStorage` and cookies throw in an opaque origin. Wrap them in
  `try`/`catch`, or keep state in the URL hash.
- Links open normally; `target="_blank"` works.

What the sandbox protects is the dashboard: a page cannot read the viewer's cookie,
call the dashboard API as the viewer, or read another page. It does **not** stop egress
by navigation. CSP governs resource loads, not navigations, so a page can still send the
tab (script `location`, a meta refresh, a link) to another site with its own content in
the URL. That content is only what the page's author wrote into it, and the author could
already send it elsewhere. The reports route adds no path to data the author did not
have, but it cannot vouch that a page keeps its own content in.

Files are read on each request (8 MiB cap) with `Cache-Control: private, no-store`, so an
agent republishes by replacing the file; write to a dot-named temp file, then rename.

Client data belongs here and never on a public host: this route is the private surface.
It serves only the workgroup's own members; it is not an egress control on its authors.
