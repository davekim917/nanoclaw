import { getDeliveryAdapter } from './delivery.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';
import type { StorageReport } from './storage-manager.js';

const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

let pressureEpisodeActive = false;
let lastAlertMs = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function alertText(report: StorageReport): string {
  const usage = report.filesystem.after ?? report.filesystem.before;
  const protectedImages = report.images.dispositions.filter((image) => image.disposition === 'protected');
  const blockers = protectedImages.length
    ? protectedImages
        .map((image) => {
          const name = image.repoTags.join(', ') || image.id;
          const owner = image.owner ? ` owner=${image.owner}` : '';
          const expiry = image.leaseExpiresAt ? ` expires=${image.leaseExpiresAt}` : '';
          return `${name} (${image.protectionReason}, ${formatBytes(image.sizeBytes)}${owner}${expiry})`;
        })
        .join('; ')
    : 'none reported';

  return [
    'Storage pressure remains critical after safe cleanup; new container admission is blocked.',
    `Usage: ${usage?.usagePct ?? 'unknown'}% (target ${report.policy.cleanupTargetPct}%, refusal ${report.policy.admissionRefusePct}%).`,
    `Free: ${usage ? formatBytes(usage.availableBytes) : 'unknown'}. Reclaimed: ${formatBytes(report.filesystem.actualReclaimedBytes)}.`,
    `Protected blockers: ${blockers}.`,
    `Next emergency retry: ${report.pressure.nextEmergencyRetryAt ?? 'next maintenance sweep'}.`,
  ].join('\n');
}

export async function handleStoragePressureAlert(report: StorageReport, now = Date.now()): Promise<void> {
  const usagePct = (report.filesystem.after ?? report.filesystem.before)?.usagePct;
  if (usagePct === undefined || usagePct < report.policy.admissionRefusePct) {
    pressureEpisodeActive = false;
    lastAlertMs = 0;
    return;
  }

  log.warn('storage-manager: critical pressure unresolved after safe cleanup', { report });
  const repeatDue = !pressureEpisodeActive || lastAlertMs === 0 || now - lastAlertMs >= ALERT_REPEAT_MS;
  pressureEpisodeActive = true;
  if (!repeatDue) return;

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('storage-manager: cannot deliver pressure alert; delivery adapter unavailable');
    return;
  }

  let recipients: Array<{ user_id: string }>;
  try {
    recipients = getDb()
      .prepare(
        `SELECT user_id, MIN(CASE role WHEN 'owner' THEN 0 ELSE 1 END) AS priority
           FROM user_roles
          WHERE role = 'owner'
             OR (role = 'admin' AND agent_group_id IS NULL)
          GROUP BY user_id
          ORDER BY priority, user_id`,
      )
      .all() as Array<{ user_id: string }>;
  } catch (err) {
    log.warn('storage-manager: cannot resolve pressure alert recipients', { err });
    return;
  }

  const text = alertText(report);
  let delivered = 0;
  for (const recipient of recipients) {
    try {
      const dm = await ensureUserDm(recipient.user_id);
      if (!dm) {
        log.warn('storage-manager: pressure alert administrator is unreachable', { userId: recipient.user_id });
        continue;
      }
      await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat', JSON.stringify({ text }));
      delivered += 1;
    } catch (err) {
      log.warn('storage-manager: pressure alert delivery failed', { userId: recipient.user_id, err });
    }
  }
  if (delivered > 0) lastAlertMs = now;
  if (recipients.length === 0) {
    log.warn('storage-manager: no owner or global administrator available for pressure alert');
  }
}

export function _resetStoragePressureAlertForTesting(): void {
  pressureEpisodeActive = false;
  lastAlertMs = 0;
}
