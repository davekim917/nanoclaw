import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { SHARED_WORK_DIR_NAME, workgroupSharedDir } from '../modules/workgroup/shared-dirs.js';
import { readContainedBytes } from './api/attention-fs.js';
import { resolveWorkgroup } from './api/workgroups.js';
import { requireAuth, type AuthHandler, type Handler } from './router.js';

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
};

export const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
].join('; ');

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function reportRelativePath(tail: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return null;
  }
  const relative = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const segments = relative.split('/');
  if (relative.includes('\0') || segments.some((s) => s === '' || s.startsWith('.'))) return null;
  return CONTENT_TYPES[path.extname(relative).toLowerCase()] ? relative : null;
}

export const workgroupReportHandler: AuthHandler = async (_req, params, ctx) => {
  const relative = reportRelativePath(params['tail'] ?? '');
  if (relative === null) return notFound();
  const wg = await resolveWorkgroup(params['id'] ?? '', ctx);
  if (!wg) return notFound();

  let base: string;
  try {
    base = fs.realpathSync(workgroupSharedDir(wg.id, DATA_DIR));
  } catch {
    return notFound();
  }
  const root = path.join(base, SHARED_WORK_DIR_NAME, 'reports');
  const read = readContainedBytes('Workgroup report', root, relative, wg.id, MAX_REPORT_BYTES);
  if (read === null) return notFound();

  return new Response(new Uint8Array(read.bytes), {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[path.extname(relative).toLowerCase()]!,
      'Content-Security-Policy': REPORT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    },
  });
};

const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign in</title><body style="font:16px system-ui;margin:2rem;max-width:32rem">
<p id="m" hidden>Not signed in. Run <b>/dashboard-token</b> in Slack, open that link on this device, then reopen this
report.</p><script>
const u = new URL(location.href);
if (u.searchParams.has('signin')) document.getElementById('m').hidden = false;
else { u.searchParams.set('signin', '1'); location.replace(u.href); }
</script>`;

export function reportGate(handler: AuthHandler): Handler {
  const authed = requireAuth(handler);
  return async (req, params, ctx) => {
    const res = await authed(req, params, ctx);
    if (res?.status !== 401) return res;
    return new Response(SIGN_IN_PAGE, {
      status: 401,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        'Cache-Control': 'no-store',
      },
    });
  };
}
