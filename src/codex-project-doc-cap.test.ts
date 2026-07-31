import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from './log.js';
import { warnIfOversized } from './codex-project-doc-cap.js';

describe('warnIfOversized', () => {
  it('is silent when content is under the limit', () => {
    vi.mocked(log.error).mockClear();
    warnIfOversized('label', 'short', 1000);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs an error with label, bytes, and limit when content exceeds the limit', () => {
    vi.mocked(log.error).mockClear();
    const content = 'x'.repeat(100);
    warnIfOversized('my-label', content, 10);
    expect(log.error).toHaveBeenCalledWith(
      'Project doc exceeded size limit',
      expect.objectContaining({ label: 'my-label', bytes: 100, limitBytes: 10 }),
    );
  });
});
