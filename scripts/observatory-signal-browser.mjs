/** Dependency-free Chrome/CDP read-only real-data verification.
 * node scripts/observatory-signal-browser.mjs
 * Requires running observatory-signal-preview.mjs. Never submits mutations.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const evidence = process.env.SIGNAL_EVIDENCE_DIR || '/tmp/observatory-signal-evidence';
const liveOrigin = process.env.SIGNAL_LIVE_ORIGIN;
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const preview = liveOrigin
  ? {
      url: new URL('/observatory/', liveOrigin).href,
      mode: 'live production GET-only browser verification',
      observed_at: new Date().toISOString(),
      user_id: process.env.SIGNAL_LIVE_USER,
    }
  : JSON.parse(fs.readFileSync(path.join(evidence, 'preview.json'), 'utf8'));
const origin = new URL(preview.url).origin;
let cookie;
if (liveOrigin) {
  if (!process.env.SIGNAL_LIVE_USER) throw new Error('SIGNAL_LIVE_USER required');
  const key = Buffer.from(fs.readFileSync(path.join(os.homedir(), '.nanoclaw/cookie-secret'), 'utf8').trim(), 'hex');
  const payload = Buffer.from(
    JSON.stringify({ user_id: process.env.SIGNAL_LIVE_USER, expires_at: new Date(Date.now() + 3600000).toISOString() }),
  ).toString('base64');
  cookie = 'spawn_board=' + payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('base64');
} else cookie = fs.readFileSync(path.join(evidence, 'preview-cookie'), 'utf8').trim();
const debugPort = Number(process.env.SIGNAL_CHROME_PORT || 9328);
const profile = fs.mkdtempSync(path.join(evidence, 'chrome-'));
const chrome = spawn(
  '/opt/google/chrome/chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    ...(liveOrigin ? ['--incognito'] : []),
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let targets;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      if (targets.length) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error; // Chrome is still opening its loopback listener.
    }
    await sleep(100);
  }
  if (!targets?.length) throw new Error('Chrome did not start');
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  const consoleErrors = [],
    failedRequests = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    }
    if (message.method === 'Runtime.exceptionThrown')
      consoleErrors.push(
        message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text,
      );
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400)
      failedRequests.push({ url: message.params.response.url, status: message.params.response.status });
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', {
    name: 'spawn_board',
    value: cookie.slice('spawn_board='.length),
    url: origin + '/dashboard',
    path: '/dashboard',
    httpOnly: true,
    sameSite: 'Strict',
  });
  if (process.env.SIGNAL_PAGING_ONLY === '1') {
    const requests = [];
    socket.addEventListener('message', async (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      const url = new URL(message.params.request.url);
      if (url.pathname !== '/dashboard/api/observatory/v2') {
        await cdp('Fetch.continueRequest', { requestId: message.params.requestId });
        return;
      }
      // Exercise the unchanged application against real one-record API pages.
      // Only page size changes; no response data or counts are fabricated.
      url.searchParams.set('thread_limit', '1');
      requests.push({ at: Date.now(), url: url.href });
      await cdp('Fetch.continueRequest', { requestId: message.params.requestId, url: url.href });
    });
    await cdp('Fetch.enable', {
      patterns: [{ urlPattern: origin + '/dashboard/api/observatory/v2?*', requestStage: 'Request' }],
    });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: preview.url });
    const waitFor = async (expression) => {
      for (let i = 0; i < 120; i++) {
        if (await evaluate(expression)) return;
        await sleep(250);
      }
      throw new Error('Pagination UI timed out: ' + expression);
    };
    await waitFor("!![...document.querySelectorAll('button')].find(e=>e.textContent.includes('Load more threads'))");
    const summaries = () =>
      evaluate(
        "[...document.querySelectorAll('.signal-lane details summary, .signal-unmapped summary')].map(e=>e.textContent)",
      );
    const before = await summaries();
    const clicked = await evaluate(
      "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Load more threads'));if(!b)return false;b.click();return true;})()",
    );
    await waitFor("![...document.querySelectorAll('button')].some(e=>e.textContent.includes('Loading more'))");
    await sleep(2500);
    const after = await summaries();
    const loadedText = await evaluate('document.body.innerText');
    await evaluate('document.querySelector(\'button[aria-label="Refresh records"]\').click()');
    await sleep(3500);
    const refreshed = await summaries();
    const report = {
      mode: 'Real data; Chrome request interception changes only thread_limit to1',
      clicked,
      requests,
      before,
      after,
      refreshed,
      loadedText,
      consoleErrors,
      failedRequests,
    };
    fs.writeFileSync(path.join(evidence, 'browser-paging.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        {
          report: path.join(evidence, 'browser-paging.json'),
          clicked,
          requests: requests.map((r) => r.url),
          before,
          after,
          refreshed,
          consoleErrors,
          failedRequests,
        },
        null,
        2,
      ),
    );
    socket.close();
    chrome.kill('SIGTERM');
    process.exit(0);
  }
  const api = async (pathname) => {
    const response = await fetch(origin + pathname, { headers: { cookie } });
    return { status: response.status, body: await response.json() };
  };
  const unauthorized = await fetch(origin + '/dashboard/api/observatory/v2');
  const mutation = liveOrigin
    ? { status: null }
    : await fetch(origin + '/dashboard/api/observatory/v2/decisions/never/review', {
        method: 'POST',
        headers: { cookie },
      });
  const aggregate = await api('/dashboard/api/observatory/v2?workgroup=all');
  fs.writeFileSync(path.join(evidence, 'overview.json'), JSON.stringify(aggregate, null, 2));
  const detailResults = [];
  for (const decision of (aggregate.body.decisions || []).slice(0, 5)) {
    const detail = await api('/dashboard/api/observatory/v2/decisions/' + encodeURIComponent(decision.id));
    detailResults.push({
      id: decision.id,
      source_id: decision.source_id,
      status: detail.status,
      error: detail.body.error,
      evidence_count: detail.body.evidence?.length,
      question_matches: detail.body.decision?.question === decision.question,
    });
  }
  const views = [];
  const interactionChecks = [];
  for (const viewport of [
    { label: 'desktop', width: 1440, height: 900 },
    { label: 'mobile', width: 390, height: 844 },
  ]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.label === 'mobile',
    });
    await cdp('Page.navigate', { url: preview.url });
    await sleep(2500);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("document.querySelectorAll('select[aria-label=Workspace] option').length > 1")) break;
      await sleep(250);
    }
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2 });
    interactionChecks.push({
      viewport: viewport.label,
      check: 'keyboard-search',
      focused_label: await evaluate("document.activeElement?.getAttribute('aria-label')"),
    });
    const options = await evaluate(
      "[...document.querySelectorAll('select[aria-label=Workspace] option')].map(e => e.value)",
    );
    interactionChecks.push({
      viewport: viewport.label,
      check: 'workspace-coverage',
      values: options,
      all_visible: (aggregate.body.workgroups || []).every((w) => options.includes(w.id)),
    });
    for (const name of ['Overview', 'Projects', 'Decisions', 'Agents', 'Threads', 'Schedule']) {
      const clicked = await evaluate(
        `(() => { const elements = [...document.querySelectorAll('a,button')]; const target = elements.find(el => (el.querySelector('span')?.textContent || el.textContent || '').trim() === ${JSON.stringify(name)} || el.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!target) return false; target.click(); return true; })()`,
      );
      await sleep(1400);
      for (let attempt = 0; attempt < 60; attempt++) {
        if (
          !(await evaluate('/Loading exact decision evidence|Reading workspace records/.test(document.body.innerText)'))
        )
          break;
        await sleep(250);
      }
      const dom = await evaluate(
        `({ title: document.title, url: location.href, scripts: [...document.scripts].map(e=>e.src), text: document.body.innerText, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, headings: [...document.querySelectorAll('h1,h2,h3')].map(e => e.textContent), alerts: [...document.querySelectorAll('[role=alert]')].map(e=>e.textContent), loading: /Loading exact decision evidence|Reading workspace records/.test(document.body.innerText), controls: [...document.querySelectorAll('button,input,select,textarea')].map(e => ({ tag:e.tagName, text:(e.textContent||'').trim().slice(0,100), label:e.getAttribute('aria-label'), disabled:e.disabled })), overflowing: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0,15).map(e => ({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right})) })`,
      );
      const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const stem = `${viewport.label}-${name.toLowerCase()}`;
      fs.writeFileSync(path.join(evidence, `${stem}.png`), Buffer.from(screenshot.data, 'base64'));
      fs.writeFileSync(path.join(evidence, `${stem}.json`), JSON.stringify(dom, null, 2));
      views.push({
        viewport: viewport.label,
        name,
        clicked,
        url: dom.url,
        headings: dom.headings,
        alerts: dom.alerts,
        loading: dom.loading,
        overflow: dom.scrollWidth > dom.width,
        screenshot: `${stem}.png`,
      });
    }
    const thread = (aggregate.body.agents || []).flatMap((agent) => agent.thread_ids)[0];
    if (thread) {
      await cdp('Page.navigate', { url: preview.url + '#/threads/' + encodeURIComponent(thread) });
      await sleep(1800);
      const response = await api('/dashboard/api/threads/' + encodeURIComponent(thread));
      interactionChecks.push({
        viewport: viewport.label,
        check: 'exact-thread-deep-link',
        id: thread,
        api_status: response.status,
        url: await evaluate('location.href'),
        visible_text: (await evaluate('document.body.innerText')).slice(-5000),
      });
    }
    const before = await evaluate('location.href');
    await evaluate('history.back()');
    await sleep(500);
    views.push({
      viewport: viewport.label,
      name: 'browser-back',
      changed: before !== (await evaluate('location.href')),
    });
  }
  const report = {
    preview,
    unauthorized_status: unauthorized.status,
    mutation_blocked_status: mutation.status,
    aggregate_status: aggregate.status,
    counts: {
      workgroups: aggregate.body.workgroups?.length,
      projects: aggregate.body.projects?.length,
      decisions: aggregate.body.decisions?.length,
      agents: aggregate.body.agents?.length,
      activity: aggregate.body.activity?.length,
    },
    workgroup_ids: aggregate.body.workgroups?.map((row) => row.id),
    decision_sources: aggregate.body.decisions?.map((row) => ({
      id: row.id,
      kind: row.source_kind,
      source_id: row.source_id,
      as_of: row.source_as_of,
    })),
    sources: aggregate.body.sources,
    detailResults,
    views,
    interactionChecks,
    consoleErrors,
    failedRequests,
    limitations: liveOrigin
      ? [
          'Only authenticated GETs executed against production; mutation semantics verified separately on isolated fixtures.',
        ]
      : [
          'Central records are an online snapshot, not a live central-update test.',
          'Runtime awake/active uses the existing live host scene API. New Signal aggregators run in the isolated preview; production route activation is not verified.',
          'Project mappings are explicitly initialized in the disposable snapshot from exact source repository references; no live project state was changed.',
          'Preview rejects every mutation. Review/dispatch require separate isolated HTTP fixtures.',
          'Synthetic preview SSE only establishes a connection; it does not verify host event delivery.',
        ],
  };
  fs.writeFileSync(path.join(evidence, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: path.join(evidence, 'browser-report.json'),
        counts: report.counts,
        aggregate_status: report.aggregate_status,
        unauthorized_status: report.unauthorized_status,
        overflow_views: views.filter((view) => view.overflow),
        missing_navigation: views.filter((view) => view.clicked === false),
        console_errors: consoleErrors.length,
        failed_requests: failedRequests.length,
        unfinished_views: views.filter((view) => view.loading),
        alert_views: views.filter((view) => view.alerts?.length),
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
}
