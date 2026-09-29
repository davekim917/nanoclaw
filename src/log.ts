import { inspect } from 'node:util';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

const INSPECT_OPTS = { breakLength: Infinity, depth: 6 };

function safeStringify(v: unknown): string {
  // JSON.stringify throws on cycles and BigInt; inspect handles both. Anything
  // inspect cannot handle falls through to the catch in emit.
  let root: { value: unknown } | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw */
  try {
    // The first replacer call sees the root after toJSON ran, so the fallback
    // honors a redacting toJSON without calling it twice.
    return JSON.stringify(v, (_key, value: unknown) => {
      root ??= { value };
      return value;
    });
  } catch {
    // No root means reading or running toJSON threw; never print the raw value.
    return root ? inspect(root.value, INSPECT_OPTS) : '[unserializable]';
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return safeStringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : safeStringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** `+HH:MM`; `getTimezoneOffset()` counts minutes BEHIND UTC, so its sign is inverted (EDT +240 → `-04:00`). */
function offsetMarker(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Local wall-clock plus an explicit UTC offset. The offset is load-bearing: the process zone (`TZ`, else
 * /etc/localtime) need not match the reader's, so parse with `parseLogStamp`, never by re-deriving the parts.
 */
function ts(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${ms}${offsetMarker(d)}`;
}

/** The offset group is optional: rotated logs keep lines written before it existed. */
export const LOG_STAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})([+-]\d{2}:\d{2})?\]/;

/**
 * Epoch ms for a `LOG_STAMP_RE` stamp. Without an offset there is no recoverable instant: the reader's local zone is
 * a best effort, flagged `exact: false`.
 */
export function parseLogStamp(stamp: string, offset?: string): { ms: number; exact: boolean } | null {
  if (offset) {
    const ms = Date.parse(`${stamp.replace(' ', 'T')}${offset}`);
    return Number.isFinite(ms) ? { ms, exact: true } : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, sec, msec] = m.slice(1, 8).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dt = new Date(y, mo - 1, d, h, mi, sec, msec);
  // `new Date` normalises overflow instead of throwing; a corrupted line must not parse to a plausible date.
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi ||
    dt.getSeconds() !== sec ||
    dt.getMilliseconds() !== msec
  ) {
    return null;
  }
  const ms = dt.getTime();
  return Number.isFinite(ms) ? { ms, exact: false } : null;
}

// Set by secret-scrubber on load (it logs via this module, so it cannot be imported here).
let scrubber: ((s: string) => string) | null = null;
export function setLogScrubber(fn: (s: string) => string): void {
  scrubber = fn;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw: a throw here reaches uncaughtException, which exits the host */
  try {
    const raw = `[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`;
    stream.write(scrubber ? scrubber(raw) : raw);
  } catch {
    // e.g. a throwing getter on the data bag itself, read before safeStringify sees it.
    try {
      const raw = `[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET} [log data unserializable]\n`;
      process.stderr.write(scrubber ? scrubber(raw) : raw);
    } catch {
      /* nowhere left to report it */
    }
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

/**
 * EPIPE/ECONNRESET on a stream write with no 'error' listener escapes as an uncaught exception, mostly from inside
 * dependencies; a dead peer is no reason to take the host down mid-turn.
 */
export function isSurvivableIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ECONNRESET';
}

// One diagnostic report per process: enough to find the owning handle without filling the disk.
let ioReportWritten = false;

process.on('uncaughtException', (err) => {
  if (isSurvivableIoError(err)) {
    let report: string | undefined;
    if (!ioReportWritten) {
      ioReportWritten = true;
      try {
        // Lists libuv handles at failure: the only way to attribute an async write error.
        report = process.report.writeReport(`logs/io-error-report-${Date.now()}.json`);
      } catch {
        // best-effort diagnostics
      }
    }
    log.error('Survivable I/O error reached uncaughtException — continuing', { err, report });
    return;
  }
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
