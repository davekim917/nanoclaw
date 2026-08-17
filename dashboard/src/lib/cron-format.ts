/**
 * Minimal plain-English rendering for the common 5-field cron shapes the
 * Scheduled drawer needs to describe (every-N-minutes/hours, daily, weekly,
 * monthly, plus comma-lists and hour ranges in the fleet's actual crons).
 * Anything outside those shapes — steps combined with lists, ranges other
 * than an hour range, multiple weekday ranges, 6-field cron — returns null
 * rather than guessing; a wrong sentence is worse than no subtext. Not a
 * general cron parser — the host's cron-parser dep owns actual scheduling.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function everyN(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  return m ? Number(m[1]) : null;
}

function isNum(field: string): boolean {
  return /^\d+$/.test(field);
}

/** Comma list of plain numbers, e.g. "15,45" → [15, 45]. Not a range, not a step. */
function numList(field: string): number[] | null {
  if (!/^\d+(,\d+)+$/.test(field)) return null;
  return field.split(',').map(Number);
}

/** "X" / "X and Y" / "X, Y, and Z" — Oxford comma, no library needed for 2-4 items. */
function joinEnglish(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function hourLabel(h: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

function clockTimeNum(h: number, m: number): string | null {
  if (h > 23 || m > 59) return null;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function clockTime(hour: string, minute: string): string | null {
  if (!isNum(hour) || !isNum(minute)) return null;
  return clockTimeNum(Number(hour), Number(minute));
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

  // "15,45 * * * *" → every hour at :15 and :45
  const minList = numList(minute);
  if (minList && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    if (!minList.every((m) => m <= 59)) return null;
    return `every hour at ${joinEnglish(minList.map((m) => `:${String(m).padStart(2, '0')}`))}`;
  }

  // "0 9,17 * * *" → daily at 9:00 AM and 5:00 PM
  const hourList = numList(hour);
  if (hourList && isNum(minute) && dom === '*' && month === '*' && dow === '*') {
    const m = Number(minute);
    const times = hourList.map((h) => clockTimeNum(h, m));
    if (times.some((t) => t == null)) return null;
    return `daily at ${joinEnglish(times as string[])}`;
  }

  // "0 12 * * 1,4" → Mondays and Thursdays at 12:00 PM
  const dowList = numList(dow);
  if (dowList && dom === '*' && month === '*') {
    if (!dowList.every((d) => d <= 6)) return null;
    const t = clockTime(hour, minute);
    if (!t) return null;
    return `${joinEnglish(dowList.map((d) => `${DAY_NAMES[d]}s`))} at ${t}`;
  }

  // "*/10 8-18 * * *" → every 10 minutes, 8 AM-6 PM
  const minStep = everyN(minute);
  const hourRange = /^(\d{1,2})-(\d{1,2})$/.exec(hour);
  if (minStep && hourRange && dom === '*' && month === '*' && dow === '*') {
    const h1 = Number(hourRange[1]);
    const h2 = Number(hourRange[2]);
    if (h1 > 23 || h2 > 23 || h1 > h2) return null;
    return `every ${minStep} minute${minStep === 1 ? '' : 's'}, ${hourLabel(h1)}–${hourLabel(h2)}`;
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
