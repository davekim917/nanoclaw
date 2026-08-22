/*
 * Client-side display helpers.
 */

/**
 * A span of time as one compact unit — `45s`, `12m`, `6h`, `3d`.
 *
 * The single formatter behind {@link relAge} and every "how long has this been
 * sitting" marker on the console, so an age never reads in two different
 * shapes depending on which field it came from.
 */
export function relDuration(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function relAge(iso: string, now = Date.now()): string {
  return relDuration(now - new Date(iso).getTime());
}
