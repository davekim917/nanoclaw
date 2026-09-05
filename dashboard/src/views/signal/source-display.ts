import type { SignalProject, SignalWorkItem } from '../../../../src/dashboard/observatory-v2/types.js';

export function signalStamp(value: string | null, timezone: string | null): string {
  if (!value) return 'Timestamp not supplied';
  if (!timezone) return 'Install timezone unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Source timestamp invalid';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );
  } catch {
    return 'Install timezone unavailable';
  }
}

/** Source IDs are workgroup-scoped. Ambiguous matches are never guessed. */
export function resolveDependency(
  projects: SignalProject[],
  workgroup: string,
  id: string,
): { project: SignalProject; item: SignalWorkItem } | null {
  const matches = projects
    .filter((p) => p.workgroup_id === workgroup)
    .flatMap((project) => project.items.filter((item) => item.id === id).map((item) => ({ project, item })));
  return matches.length === 1 ? matches[0]! : null;
}
