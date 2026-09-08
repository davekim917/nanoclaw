import { log } from './log.js';
import { notifyOperators } from './operator-alert.js';
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

  // Recipient resolution, owner-first ordering and the one-bot rule live in
  // `operator-alert.ts` — the same seam the scheduled-task failure escalation
  // uses, so a change to how the host reaches a human happens in one place.
  if (await notifyOperators(alertText(report), { source: 'storage-manager' })) lastAlertMs = now;
}

export function _resetStoragePressureAlertForTesting(): void {
  pressureEpisodeActive = false;
  lastAlertMs = 0;
}
