import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { BIG_PICTURE_FILES, STEP_FILES } from './claude-assist.js';

describe('Claude setup-assist file inventory', () => {
  it('references only files that exist in the current setup architecture', () => {
    const referenced = [...BIG_PICTURE_FILES, ...Object.values(STEP_FILES).flat()];
    const missing = referenced.filter((relativePath) => !fs.existsSync(path.join(process.cwd(), relativePath)));

    expect(missing).toEqual([]);
  });
});
