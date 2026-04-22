/**
 * Diagram rendering MCP tool — renders Mermaid, HTML, or SVG into a PNG
 * and sends it to the current channel.
 *
 * Render paths:
 *   - Mermaid: mmdc CLI (install in Dockerfile first)
 *   - HTML/SVG: chromium headless screenshot
 *
 * HTML is the default and preferred path — a built-in template library
 * produces polished visuals (architecture, timelines, comparisons, org
 * charts, data charts) without the user needing to write CSS. Mermaid
 * is still available for quick sequence/Gantt diagrams when mmdc is installed.
 *
 * Delivery: file → /workspace/outbox/<id>/ → writeMessageOut → awaitDeliveryAck.
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { getSessionRouting } from '../db/session-routing.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const OUTBOX_DIR = '/workspace/outbox';
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB PNG cap
const ACK_TIMEOUT_MS = 30_000;

function generateId(): string {
  return `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

// Dedup hash map — same content same render on a turn-chain.
const sentHashes = new Map<string, string>();

// ---- HTML Template Library ----

// Template types used by buildHtmlPage

interface TemplateVars {
  title?: string;
  subtitle?: string;
  theme: 'light' | 'dark';
  content: string;
  caption?: string;
}

const CSS = {
  dark: {
    bg: '#0f172a',
    card: '#1e293b',
    border: '#334155',
    text: '#e2e8f0',
    muted: '#94a3b8',
    accent: '#38bdf8',
    accent2: '#818cf8',
  },
  light: {
    bg: '#f8fafc',
    card: '#ffffff',
    border: '#e2e8f0',
    text: '#0f172a',
    muted: '#64748b',
    accent: '#0284c7',
    accent2: '#7c3aed',
  },
};

function wrapHtml(vars: TemplateVars): string {
  const c = CSS[vars.theme];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: ${c.bg};
    color: ${c.text};
    padding: 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
  }
  .container { max-width: 1100px; width: 100%; }
  .header {
    border-bottom: 2px solid ${c.border};
    padding-bottom: 20px;
    margin-bottom: 28px;
  }
  .title {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: ${c.accent};
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 0.85rem;
    color: ${c.muted};
  }
  ${vars.content}
  .caption {
    margin-top: 16px;
    font-size: 0.8rem;
    color: ${c.muted};
    text-align: center;
  }
</style>
</head>
<body>
<div class="container">
${vars.title || vars.subtitle ? `<div class="header">
${vars.title ? `<div class="title">${vars.title}</div>` : ''}
${vars.subtitle ? `<div class="subtitle">${vars.subtitle}</div>` : ''}
</div>` : ''}
${vars.content}
${vars.caption ? `<div class="caption">${vars.caption}</div>` : ''}
</div>
</body>
</html>`;
}

// Architecture box: [label, description, style: primary|secondary|accent|data|external]
function archBox(
  label: string,
  desc: string,
  style: string,
  w = 220,
): string {
  const c = CSS.light;
  const colors: Record<string, string> = {
    primary: c.accent,
    secondary: c.accent2,
    accent: '#f59e0b',
    data: '#10b981',
    external: '#64748b',
  };
  const col = colors[style] || colors.primary;
  return `<div style="
    background:${c.card};
    border: 1.5px solid ${col};
    border-left: 4px solid ${col};
    border-radius: 8px;
    padding: 14px 16px;
    width:${w}px;
    flex-shrink:0;
  ">
    <div style="font-size:0.75rem;font-weight:700;color:${col};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${label}</div>
    <div style="font-size:0.8rem;color:${c.text}">${desc}</div>
  </div>`;
}

function archArrow(): string {
  return `<div style="display:flex;align-items:center;padding:0 8px;font-size:1.2rem;color:#94a3b8">→</div>`;
}

function archFlex(content: string, dir = 'row', gap = 8): string {
  return `<div style="display:flex;flex-direction:${dir};gap:${gap}px;flex-wrap:wrap;align-items:center;justify-content:center;margin-bottom:${gap}px">${content}</div>`;
}

// archColumn not used in current templates

// ---- Template renderers ----

function renderArchitecture(
  content: Record<string, unknown>,
  theme: 'light' | 'dark',
): string {
  const layers: Array<{ label: string; items: Array<[string, string, string]> }> = [];
  // Try to extract layers from the content
  const raw = typeof content === 'object' ? content : {};
  const layerNames = ['Frontend', 'API', 'Data', 'Infra', 'External'];
  for (const ln of layerNames) {
    if ((raw as Record<string, unknown>)[ln.toLowerCase()]) {
      layers.push({
        label: ln,
        items: ((raw as Record<string, unknown>)[ln.toLowerCase()] as Array<[string, string, string]>) || [],
      });
    }
  }
  if (layers.length === 0) {
    // Generic fallback
    return archFlex(
      [archBox('Frontend', 'Web / Mobile client', 'primary'), archArrow(), archBox('API', 'Backend services', 'secondary'), archArrow(), archBox('Database', 'Data store', 'data')].join(''),
    );
  }

  // Render as stacked horizontal layers
  const rows = layers.map((layer) => {
    const boxes = layer.items.map(([label, desc, style]) => archBox(label, desc, style || 'primary')).join(archArrow());
    return `<div style="margin-bottom:20px">
      <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.1em;color:${CSS[theme].muted};margin-bottom:8px;text-transform:uppercase">${layer.label}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:center">${boxes}</div>
    </div>`;
  });
  return rows.join('');
}

function renderFlowchart(
  content: Record<string, unknown>,
  theme: 'light' | 'dark',
): string {
  const steps: string[] = Array.isArray(content.steps) ? content.steps : [];
  if (steps.length === 0) return `<div style="color:${CSS[theme].muted};text-align:center;padding:40px">No steps provided</div>`;
  const c = CSS[theme];
  const rows = steps.map((step, i) => {
    const isDecision = typeof step === 'object' && (step as Record<string, unknown>).type === 'decision';
    const isEnd = typeof step === 'object' && (step as Record<string, unknown>).type === 'end';
    const label = typeof step === 'string' ? step : (step as Record<string, unknown>).label as string;
    const bg = isEnd ? '#dc2626' : isDecision ? '#f59e0b' : c.card;
    const border = isEnd ? '#dc2626' : isDecision ? '#f59e0b' : c.accent;
    const rad = isEnd || isDecision ? '999px' : '8px';
    const num = i + 1;
    return `<div style="display:flex;align-items:center;gap:16px">
  <div style="width:28px;height:28px;border-radius:50%;background:${c.accent};color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;flex-shrink:0">${num}</div>
  <div style="flex:1;background:${bg};border:1.5px solid ${border};border-radius:${rad};padding:12px 16px;font-size:0.85rem;color:#fff;font-weight:500">${label}</div>
</div>
${i < steps.length - 1 ? `<div style="margin-left:14px;border-left:2px solid ${c.border};height:16px;margin-bottom:4px"></div>` : ''}`;
  });
  return archFlex(rows.join(''), 'column', 4);
}

function renderTimeline(
  content: Record<string, unknown>,
  theme: 'light' | 'dark',
): string {
  const items: Array<{ date: string; title: string; desc?: string }> = Array.isArray(content.items) ? content.items : [];
  const c = CSS[theme];
  const rows = items.map((item, i) => {
    const dot = `<div style="width:12px;height:12px;border-radius:50%;background:${c.accent};border:2px solid ${c.bg};flex-shrink:0;margin-top:4px"></div>`;
    const line = i < items.length - 1 ? `<div style="width:2px;background:${c.border};margin-left:5px;margin-top:4px;margin-bottom:4px;flex-shrink:0"></div>` : '';
    return `<div style="display:flex;gap:16px;align-items:flex-start">
  <div style="display:flex;flex-direction:column;align-items:center">${dot}${line}</div>
  <div style="padding-bottom:16px">
    <div style="font-size:0.7rem;font-weight:700;color:${c.accent};margin-bottom:2px">${item.date}</div>
    <div style="font-size:0.9rem;font-weight:600;color:${c.text};margin-bottom:${item.desc ? '4px' : '0'}">${item.title}</div>
    ${item.desc ? `<div style="font-size:0.8rem;color:${c.muted}">${item.desc}</div>` : ''}
  </div>
</div>`;
  });
  return archFlex(rows.join(''), 'column', 0);
}

function renderComparison(
  content: Record<string, unknown>,
  theme: 'light' | 'dark',
): string {
  const headers: string[] = Array.isArray(content.headers) ? content.headers : ['Option A', 'Option B'];
  const rows: Array<Array<string>> = Array.isArray(content.rows) ? content.rows : [];
  const c = CSS[theme];
  const th = headers.map((h) => `<th style="padding:10px 16px;background:${c.accent};color:#fff;font-size:0.8rem;font-weight:700;text-align:left;border-bottom:2px solid ${c.accent}">${h}</th>`).join('');
  const trs = rows.map((row, ri) => {
    const bg = ri % 2 === 0 ? c.card : c.bg;
    const tds = row.map((cell) => `<td style="padding:10px 16px;font-size:0.82rem;border-bottom:1px solid ${c.border};background:${bg}">${cell}</td>`).join('');
    return `<tr>${tds}</tr>`;
  });
  return `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid ${c.border}">
<thead><tr>${th}</tr></thead>
<tbody>${trs.join('')}</tbody>
</table>`;
}

function renderOrgChart(
  content: Record<string, unknown>,
  theme: 'light' | 'dark',
): string {
  const nodes: Array<{ name: string; role: string; children?: string[] }> = Array.isArray(content.nodes) ? content.nodes : [];
  const c = CSS[theme];
  const renderNode = (node: typeof nodes[0], indent = 0): string => {
    const box = `<div style="background:${c.card};border:1.5px solid ${c.accent};border-radius:10px;padding:12px 16px;min-width:180px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.15)">
  <div style="font-size:0.9rem;font-weight:700;color:${c.accent}">${node.name}</div>
  <div style="font-size:0.72rem;color:${c.muted};margin-top:2px">${node.role}</div>
</div>`;
    const childSection = node.children?.length
      ? `<div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:12px">
  ${node.children.map((ch) => `<div style="display:flex;flex-direction:column;align-items:center">
    <div style="display:flex;gap:8px;align-items:center">
      <div style="width:1px;height:20px;background:${c.border}"></div>
      <div style="width:8px;height:1px;background:${c.border}"></div>
    </div>
    ${renderNode({ name: ch, role: '' }, indent + 1)}
  </div>`).join('')}
</div>`
      : '';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:8px">${box}${childSection}</div>`;
  };
  return archFlex(nodes.map((n) => renderNode(n)).join(archArrow()), 'column', 12);
}

function buildHtmlPage(args: {
  template: string;
  content: unknown;
  title?: string;
  subtitle?: string;
  caption?: string;
  theme: 'light' | 'dark';
  customCss?: string;
}): string {
  let bodyContent: string;
  switch (args.template) {
    case 'architecture':
      bodyContent = renderArchitecture((args.content as Record<string, unknown>) || {}, args.theme);
      break;
    case 'flowchart':
      bodyContent = renderFlowchart((args.content as Record<string, unknown>) || {}, args.theme);
      break;
    case 'timeline':
      bodyContent = renderTimeline((args.content as Record<string, unknown>) || {}, args.theme);
      break;
    case 'comparison':
      bodyContent = renderComparison((args.content as Record<string, unknown>) || {}, args.theme);
      break;
    case 'org-chart':
      bodyContent = renderOrgChart((args.content as Record<string, unknown>) || {}, args.theme);
      break;
    default:
      bodyContent = `<div style="font-size:0.9rem;padding:24px;background:${CSS[args.theme].card};border-radius:8px;border:1px solid ${CSS[args.theme].border}">${args.content}</div>`;
  }
  if (args.customCss) {
    bodyContent += `<style>${args.customCss}</style>`;
  }
  return wrapHtml({
    title: args.title,
    subtitle: args.subtitle,
    theme: args.theme,
    content: bodyContent,
    caption: args.caption,
  });
}

// ---- Chromium screenshot ----

function chromiumScreenshot(inputPath: string, outputPath: string, width: number, height: number): void {
  execFileSync('chromium', [
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-file-access-from-files',
    `--screenshot=${outputPath}`,
    `--window-size=${width},${height}`,
    `file://${inputPath}`,
  ], { timeout: 30_000, stdio: 'pipe' });
}

// ---- Mermaid rendering ----

function mmdcAvailable(): boolean {
  try {
    execFileSync('mmdc', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---- Main tool ----

export const renderDiagramTool: McpToolDefinition = {
  tool: {
    name: 'render_diagram',
    description:
      'Render a diagram as a polished PNG and send it to chat. ' +
      'Templates produce beautiful HTML diagrams with zero CSS from the user. ' +
      'Custom HTML/SVG accepted. Mermaid is supported if mmdc is installed. ' +
      'Architecture templates take structured content; flowchart takes steps array; ' +
      'timeline takes items with date/title/desc; comparison takes headers + rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        // Rendering mode
        type: {
          type: 'string',
          enum: ['html', 'mermaid', 'svg'],
          description: '"html" (default, beautiful templates), "mermaid" (for sequence/Gantt/ER), "svg" (inline SVG wrapped in HTML)',
        },
        // Template (html mode only)
        template: {
          type: 'string',
          enum: ['architecture', 'flowchart', 'timeline', 'comparison', 'org-chart', 'custom'],
          description: 'Diagram template for HTML mode. "custom" renders raw content as-is. Default: "custom" if content is raw HTML, auto-detected.',
        },
        // Content
        content: {
          oneOf: [
            { type: 'string', description: 'Raw HTML, Mermaid source, or SVG markup (for custom template)' },
            {
              type: 'object',
              description: 'Structured content for template modes. ' +
                'architecture: { layers: [{ label, items: [[name, desc, style?], ...] } ' +
                'flowchart: { steps: ["step1", { label, type: "decision"|"end" }, ...] } ' +
                'timeline: { items: [{ date, title, desc? }, ...] } ' +
                'comparison: { headers: [], rows: [[cell, cell, ...], ...] } ' +
                'org-chart: { nodes: [{ name, role, children?: [name, ...] }, ...] }',
            },
          ],
          description: 'Diagram content — template-specific structure or raw markup.',
        },
        // HTML options
        title: { type: 'string', description: 'Title shown at the top of the diagram.' },
        subtitle: { type: 'string', description: 'Subtitle / description line.' },
        caption: { type: 'string', description: 'Caption shown below the diagram.' },
        theme: { type: 'string', enum: ['light', 'dark'], description: 'Color theme. Default: "light".' },
        width: { type: 'number', description: 'Viewport width in pixels. Default: 1200.' },
        height: { type: 'number', description: 'Viewport height in pixels. Default: 800.' },
        customCss: { type: 'string', description: 'Additional CSS injected into the HTML page (for custom/template modes).' },
        // Mermaid options
        mermaidTheme: {
          type: 'string',
          enum: ['default', 'dark', 'forest', 'neutral'],
          description: 'Mermaid theme. Default: "default".',
        },
      },
      required: ['content'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const type = (args.type as string) || 'html';
    const content = args.content;
    const title = args.title as string | undefined;
    const subtitle = args.subtitle as string | undefined;
    const caption = args.caption as string | undefined;
    const theme = (args.theme as string) === 'dark' ? 'dark' : 'light';
    const width = Math.min(Math.max((args.width as number) || 1200, 400), 2400);
    const height = Math.min(Math.max((args.height as number) || 800, 200), 1600);

    const routing = getSessionRouting();
    const id = generateId();
    const outDir = path.join(OUTBOX_DIR, id);
    const filename = `${id}.png`;
    const outputPath = path.join(outDir, filename);

    // Resolve raw content for template detection
    let rawContent: unknown = content;
    if (typeof content === 'object' && content !== null && 'raw' in (content as Record<string, unknown>)) {
      rawContent = (content as Record<string, unknown>).raw;
    }

    // Detect template for HTML mode
    let template = (args.template as string) || 'custom';
    if (type === 'html' && template === 'custom' && typeof rawContent === 'string' && rawContent.trim().startsWith('<')) {
      // Raw HTML — treat as custom, no template wrapping needed
      rawContent = rawContent;
    }

    // Build HTML page (mermaid path doesn't produce HTML — skips this entirely)
    let htmlPath: string | null = null;
    if (type === 'html') {
      const html = buildHtmlPage({
        template,
        content: rawContent,
        title,
        subtitle,
        caption,
        theme,
        customCss: args.customCss as string | undefined,
      });
      htmlPath = `/tmp/diag-${id}.html`;
      fs.writeFileSync(htmlPath, html);
    } else if (type === 'svg') {
      const svgContent = typeof rawContent === 'string' ? rawContent : String(rawContent);
      const html = wrapHtml({
        title,
        subtitle,
        theme,
        content: `<div style="display:flex;align-items:center;justify-content:center;padding:20px">${svgContent}</div>`,
        caption,
      });
      htmlPath = `/tmp/diag-${id}.html`;
      fs.writeFileSync(htmlPath, html);
    } else {
      // mermaid
      if (!mmdcAvailable()) {
        return err('mmdc not installed in container. Use type="html" or "svg" instead, or ask to install @mermaid-js/mermaid-cli.');
      }
      const src = typeof rawContent === 'string' ? rawContent : String(rawContent);
      const tmpInput = `/tmp/mmd-${id}.mmd`;
      const tmpOut = `/tmp/out-${id}.png`;
      fs.writeFileSync(tmpInput, src);
      try {
        execFileSync('mmdc', [
          '-i', tmpInput,
          '-o', tmpOut,
          '-t', (args.mermaidTheme as string) || 'default',
          '-b', theme === 'dark' ? '#1e1e1e' : '#ffffff',
          '-w', String(width),
        ], { timeout: 30_000, stdio: 'pipe' });
      } finally {
        try { fs.unlinkSync(tmpInput); } catch {}
      }
      // Mermaid output is already a PNG — copy to outDir
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(tmpOut, outputPath);
      try { fs.unlinkSync(tmpOut); } catch {}
    }

    try {
      if (type !== 'mermaid') {
        fs.mkdirSync(outDir, { recursive: true });
        chromiumScreenshot(htmlPath!, outputPath, width, height);
      }

      const stat = fs.statSync(outputPath);
      if (stat.size === 0) return err('Render produced empty file.');
      if (stat.size > MAX_SIZE_BYTES) {
        try { fs.unlinkSync(outputPath); } catch {}
        return err(`Rendered PNG too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.`);
      }

      // Dedup
      const fileContent = fs.readFileSync(outputPath);
      const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
      if (sentHashes.has(hash)) {
        try { fs.unlinkSync(outputPath); } catch {}
        return ok(`Duplicate: same diagram already sent as "${sentHashes.get(hash)}". Skipped.`);
      }

      writeMessageOut({
        id,
        kind: 'chat',
        platform_id: routing.platform_id,
        channel_type: routing.channel_type,
        thread_id: routing.thread_id,
        content: JSON.stringify({ text: caption || title || '', files: [filename] }),
      });

      const ack = await awaitDeliveryAck(id, ACK_TIMEOUT_MS);
      if (ack?.status === 'delivered') {
        sentHashes.set(hash, filename);
        return ok(`Diagram sent (${(stat.size / 1024).toFixed(0)}KB)${ack.platformMessageId ? ` → ${ack.platformMessageId}` : ''}.`);
      }
      sentHashes.set(hash, filename);
      return ok(`Diagram sent (${(stat.size / 1024).toFixed(0)}KB) — delivery unconfirmed within ${ACK_TIMEOUT_MS / 1000}s.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`Render failed: ${msg}`);
    } finally {
      if (htmlPath) try { fs.unlinkSync(htmlPath); } catch {}
      // Do NOT unlink outputPath — the host reads it from outbox/<id>/ during
      // delivery and removes the whole dir itself (session-manager removeOutboxDir).
    }
  },
};

export const renderDiagramTools = [renderDiagramTool];
registerTools(renderDiagramTools);
