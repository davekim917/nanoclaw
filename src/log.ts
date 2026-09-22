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

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/**
 * Numeric UTC offset for `d` as `+HH:MM` / `-HH:MM`.
 *
 * `getTimezoneOffset()` returns minutes the local zone is BEHIND UTC, so its
 * sign is inverted relative to the ISO-8601 marker: EDT is +240 and renders
 * as `-04:00`.
 */
function offsetMarker(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Host log stamp: local wall-clock plus an explicit numeric UTC offset.
 *
 * The offset is load-bearing, not decoration. The stamp is built from local
 * `Date` getters, so it renders in the host PROCESS's zone (`TZ` env, else
 * `/etc/localtime`) — which is not necessarily the zone of whatever later
 * reads the line. On this install the systemd unit sets
 * `TZ=America/New_York` while `/etc/localtime` is `Etc/UTC`, so a script
 * rebuilding the stamp with local getters lands 4h off and, because nothing
 * throws, the error surfaces as a confident zero rather than a failure.
 * Parse with `parseLogStamp` below rather than re-deriving the parts.
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

/**
 * Matches a host log line's leading `[<stamp>]`, with or without the offset.
 *
 * The offset group is OPTIONAL because rotated logs are kept 30 days and
 * every line written before this change lacks it — a required group would
 * silently stop matching all history.
 */
export const LOG_STAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})([+-]\d{2}:\d{2})?\]/;

/**
 * Absolute epoch ms for a stamp captured by `LOG_STAMP_RE`.
 *
 * With an offset the instant is unambiguous. WITHOUT one (pre-change lines)
 * there is no recoverable answer: the only reading available is the READER's
 * local zone, which is exactly the assumption that made these stamps
 * misparse. `legacyIsLocal` therefore returns that best-effort value and
 * callers that care can tell the two apart via the second return field.
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
  // `new Date(2026, 12, 99, 99, ...)` does not throw — it NORMALISES, rolling
  // overflow into a real instant. A corrupted line would then parse to a
  // plausible-looking date, and in host-health.ts's backward walk a value
  // below the cutoff ends the scan early, which is precisely the silent zero
  // this change exists to remove. Reject anything that did not round-trip.
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

// Pluggable scrubber — the secret-scrubber module wires this on load to
// avoid a circular import (secret-scrubber itself logs via this module).
let scrubber: ((s: string) => string) | null = null;
export function setLogScrubber(fn: (s: string) => string): void {
  scrubber = fn;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const raw = `[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`;
  stream.write(scrubber ? scrubber(raw) : raw);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

/**
 * A dead peer on a socket write is not a reason to kill the orchestrator.
 * These escape as uncaught exceptions whenever a stream write completes with
 * EPIPE/ECONNRESET and nothing listened for 'error' on that handle — most of
 * them come from inside dependencies, and the async completion stack names no
 * user frame, so there is nothing to fix at the call site. Exiting on them
 * took the whole host down mid-turn (systemd restarted it) and forced every
 * mid-work session to post a "host restarted" accounting note.
 */
export function isSurvivableIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ECONNRESET';
}

// One diagnostic report per process — enough to identify the owning handle,
// not enough to fill the disk when a peer flaps.
let ioReportWritten = false;

process.on('uncaughtException', (err) => {
  if (isSurvivableIoError(err)) {
    let report: string | undefined;
    if (!ioReportWritten) {
      ioReportWritten = true;
      try {
        // Names the libuv handle list (sockets, pipes, their fds) at the
        // moment of failure — the only way to attribute an async write error.
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
