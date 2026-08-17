/**
 * Minimal plain-English rendering for the common 5-field cron shapes the
 * Scheduled drawer needs to describe (every-N-minutes/hours, daily, weekly,
 * monthly). Anything outside those shapes — lists, ranges, steps combined
 * with lists, multiple weekdays, 6-field cron — returns null rather than
 * guessing; a wrong sentence is worse than no subtext. Not a general cron
 * parser — the host's cron-parser dep owns actual scheduling.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function everyN(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  return m ? Number(m[1]) : null;
}

function isNum(field: string): boolean {
  return /^\d+$/.test(field);
}

function clockTime(hour: string, minute: string): string | null {
  if (!isNum(hour) || !isNum(minute)) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function cronToEnglish(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;

  const minEvery = everyN(minute);
  if (minEvery && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `every ${minEvery} minute${minEvery === 1 ? '' : 's'}`;
  }

  const hourEvery = everyN(hour);
  if (hourEvery && (minute === '*' || isNum(minute)) && dom === '*' && month === '*' && dow === '*') {
    return `every ${hourEvery} hour${hourEvery === 1 ? '' : 's'}`;
  }

  const time = clockTime(hour, minute);
  if (!time) return null;

  if (dom === '*' && month === '*' && dow === '*') {
    return `daily at ${time}`;
  }
  if (dom === '*' && month === '*' && /^[0-6]$/.test(dow)) {
    return `weekly on ${DAY_NAMES[Number(dow)]} at ${time}`;
  }
  if (/^([1-9]|[12]\d|3[01])$/.test(dom) && month === '*' && dow === '*') {
    return `monthly on day ${dom} at ${time}`;
  }
  return null;
}

/**
 * The install's cron fields run in whatever TIMEZONE it's configured with
 * (see src/config.ts on the host), not necessarily America/New_York — so
 * this reads the Eastern wall-clock time off the row's already-computed
 * `next_fire_utc` (a real UTC instant) instead of reinterpreting the cron
 * string, which gets DST right for free via Intl.
 */
export function formatEasternTime(nextFireUtc: string | null): string | null {
  if (!nextFireUtc) return null;
  const d = new Date(nextFireUtc);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
    return `${time} ET`;
  } catch {
    return null;
  }
}
