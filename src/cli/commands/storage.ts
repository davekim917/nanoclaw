import { isContainerRunning } from '../../container-runner.js';
import { getStorageReport } from '../../storage-manager.js';
import { register } from '../registry.js';

function parseApply(raw: Record<string, unknown>): { apply: boolean } {
  return { apply: raw.apply === true || raw.apply === 'true' || raw.apply === '1' };
}

register({
  name: 'storage-report',
  description: 'Show reclaimable host storage without deleting anything.',
  access: 'approval',
  parseArgs: () => ({}),
  handler: async () => getStorageReport({ mode: 'dry-run', isContainerRunning }),
});

register({
  name: 'storage-cleanup',
  description: 'Clean reclaimable host storage; pass --apply to delete.',
  access: 'approval',
  parseArgs: parseApply,
  handler: async ({ apply }) =>
    getStorageReport({
      mode: apply ? 'apply' : 'dry-run',
      isContainerRunning,
      force: apply,
    }),
});
