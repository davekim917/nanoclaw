import { describe, it, expect } from 'vitest';
import { signalStamp, resolveDependency } from './source-display.js';
import type { SignalProject } from '../../../../src/dashboard/observatory-v2/types.js';
const project = (id: string, workgroup: string, itemId: string) =>
  ({ id, workgroup_id: workgroup, items: [{ id: itemId, title: `${id} exact source` }] }) as SignalProject;
describe('source display fidelity', () => {
  it('renders the declared install zone regardless of browser zone', () => {
    expect(signalStamp('2026-09-05T01:00:00Z', 'America/Los_Angeles')).toBe('Sep 4, 2026, 6:00 PM');
    expect(signalStamp('2026-09-05T01:00:00Z', 'Asia/Tokyo')).toBe('Sep 5, 2026, 10:00 AM');
    expect(signalStamp('2026-09-05T01:00:00Z', null)).toBe('Install timezone unavailable');
  });
  it('resolves exact dependency IDs only in the originating workgroup', () => {
    const projects = [project('one', 'wg', 'item-7'), project('two', 'other', 'item-7')];
    expect(resolveDependency(projects, 'wg', 'item-7')?.project.id).toBe('one');
    expect(resolveDependency(projects, 'wg', 'item')).toBeNull();
    expect(resolveDependency([...projects, project('three', 'wg', 'item-7')], 'wg', 'item-7')).toBeNull();
  });
});
