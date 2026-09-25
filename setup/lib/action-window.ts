/**
 * Fixed-height progress block redrawn in place: a spinner header above
 * WINDOW_SIZE gutter-prefixed lines holding the most recent actions.
 *
 * Clack's spinner only owns one line, so long progress lines wrap and blow
 * out the gutter. The block is drawn with raw ANSI (cursor up, clear line);
 * `openActionWindow` must run first so the cursor-up math in the redraw
 * lands on the block.
 */
import k from 'kleur';

import { fitToWidth, fmtDuration } from './theme.js';

const WINDOW_SIZE = 3;
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';

type Out = NodeJS.WriteStream;

/** Hide the cursor and reserve the block's lines below the current one. */
export function openActionWindow(out: Out): void {
  out.write(HIDE_CURSOR);
  for (let i = 0; i < WINDOW_SIZE + 1; i++) out.write('\n');
}

export function drawActionWindow(
  out: Out,
  label: string,
  startMs: number,
  frameIdx: number,
  actions: readonly string[],
  actionPrefix = '',
): void {
  out.write(`\x1b[${WINDOW_SIZE + 1}A`);
  const icon = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
  const suffix = ` (${fmtDuration(Date.now() - startMs)})`;
  const header = fitToWidth(label, suffix);
  out.write(`\x1b[2K${k.cyan(icon)}  ${header}${k.dim(suffix)}\n`);

  for (let i = 0; i < WINDOW_SIZE; i++) {
    const idx = actions.length - WINDOW_SIZE + i;
    const action = idx >= 0 ? actions[idx] : '';
    out.write('\x1b[2K');
    if (action) {
      out.write(`${k.gray('│')}  ${k.dim(`${actionPrefix}${fitToWidth(action, '')}`)}`);
    } else {
      out.write(k.gray('│'));
    }
    out.write('\n');
  }
}

/** Blank the block and leave the cursor at its top. */
export function clearActionWindow(out: Out): void {
  out.write(`\x1b[${WINDOW_SIZE + 1}A`);
  for (let i = 0; i < WINDOW_SIZE + 1; i++) {
    out.write('\x1b[2K\n');
  }
  out.write(`\x1b[${WINDOW_SIZE + 1}A`);
}
