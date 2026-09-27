/**
 * Decodes chat-sdk-bridge's base64 `data` attachments to
 * `data/v2-sessions/<ag>/<sess>/attachments/<msgId>/<filename>` and replaces `data` with a relative `localPath`,
 * which the runner's formatter resolves to `/workspace/<localPath>`, so the agent can read the file.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { sessionDir } from './session-manager.js';
import { log } from './log.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per file — Slack's own limit

function sanitizeSegment(segment: string, fallback: string): string {
  const cleaned = segment
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
  return cleaned || fallback;
}

interface AttachmentEntry {
  type?: string;
  name?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  data?: string; // base64
  url?: string;
  localPath?: string;
}

/** Mutates `content` in place and returns the new string; idempotent (skips entries that have a localPath). */
export function persistInboundAttachments(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  rawContent: string,
): string {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  const attachments = content.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return rawContent;

  const safeMessageId = sanitizeSegment(messageId, 'msg');
  const baseDir = path.join(sessionDir(agentGroupId, sessionId), 'attachments', safeMessageId);
  let anyPersisted = false;

  for (const raw of attachments as AttachmentEntry[]) {
    if (raw.localPath || !raw.data) continue;
    try {
      const buffer = Buffer.from(raw.data, 'base64');
      if (buffer.length === 0) continue;
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        log.warn('Attachment exceeds size limit, skipping', {
          messageId,
          name: raw.name,
          bytes: buffer.length,
        });
        delete raw.data;
        continue;
      }
      fs.mkdirSync(baseDir, { recursive: true });
      // Content-hashed so same-named attachments (every pasted clipboard image is "image.png") don't collide.
      const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
      const rawName = sanitizeSegment(raw.name || raw.filename || 'file', 'file');
      const ext = path.extname(rawName);
      const base = ext ? rawName.slice(0, -ext.length) : rawName;
      const filename = `${base}-${sha}${ext}`;
      const absPath = path.join(baseDir, filename);
      fs.writeFileSync(absPath, buffer);

      // Relative to the session root (which the container mounts as /workspace)
      raw.localPath = path.posix.join('attachments', safeMessageId, filename);
      delete raw.data;
      anyPersisted = true;
    } catch (err) {
      log.warn('Failed to persist attachment', { messageId, name: raw.name, err });
    }
  }

  if (!anyPersisted) return rawContent;
  log.info('Persisted attachments', {
    sessionId,
    messageId,
    count: attachments.filter((a: AttachmentEntry) => a.localPath).length,
  });
  return JSON.stringify(content);
}
