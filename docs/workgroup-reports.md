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
- No network: no `fetch`, no external script, stylesheet or font, no remote image.
  Images must be `data:` URIs. A page is one self-contained file.
- No storage: `localStorage` and cookies throw in an opaque origin. Wrap them in
  `try`/`catch`, or keep state in the URL hash.
- Links open normally; `target="_blank"` works.

Files are read on each request (8 MiB cap) with `Cache-Control: private, no-store`, so an
agent republishes by replacing the file; write to a dot-named temp file, then rename.

Client data belongs here and never on a public host: this route is the private surface.
