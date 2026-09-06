export type SignalPage = 'overview' | 'projects' | 'decisions' | 'agents' | 'threads' | 'schedule';
export function signalRoute(hash: string): { page: SignalPage; id: string | null } {
  const [raw, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const page = raw === 'console' ? 'threads' : raw === 'scheduled' ? 'schedule' : raw;
  const known: SignalPage[] = ['overview', 'projects', 'decisions', 'agents', 'threads', 'schedule'];
  let id: string | null = null;
  try {
    id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  } catch {
    /* malformed bookmark remains navigable */
  }
  return { page: known.includes(page as SignalPage) ? (page as SignalPage) : 'overview', id };
}
export const threadHref = (id: string) => `#/threads/${encodeURIComponent(id)}`;
