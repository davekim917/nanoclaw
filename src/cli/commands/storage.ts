import { getActiveContainerSessionIds } from '../../container-runner.js';
import { getStorageReportInBackground } from '../../storage-maintenance-worker.js';
import { register } from '../registry.js';

function parseApply(raw: Record<string, unknown>): { apply: boolean } {
  return { apply: raw.apply === true || raw.apply === 'true' || raw.apply === '1' };
}

register({
  name: 'storage-report',
  description: 'Show reclaimable host storage without deleting anything.',
  access: 'approval',
  parseArgs: () => ({}),
  handler: async () => getStorageReportInBackground(getActiveContainerSessionIds(), { mode: 'dry-run' }),
});

register({
  name: 'storage-cleanup',
  description: 'Clean reclaimable host storage; pass --apply to delete.',
  access: 'approval',
  parseArgs: parseApply,
  handler: async ({ apply }) =>
    getStorageReportInBackground(getActiveContainerSessionIds(), {
      mode: apply ? 'apply' : 'dry-run',
      force: apply,
    }),
});
