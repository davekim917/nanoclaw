import { describe, expect, it } from 'bun:test';

import { buildCompactInstructions } from './compact-instructions.js';

describe('compaction delivery reminder', () => {
  it('preserves final-output addressing in chat sessions', () => {
    const instructions = buildCompactInstructions(['family'], null, false);

    expect(instructions).toContain('<message to="name">');
    expect(instructions).toContain('`family`');
  });

  it('preserves structured-tool delivery without reviving legacy XML wrappers', () => {
    const instructions = buildCompactInstructions(['family'], null, true);

    expect(instructions).toContain('send_message with an explicit purpose');
    expect(instructions).toContain('internal work record');
    expect(instructions).not.toContain('<message to="name">');
  });

  it('preserves explicit-tool delivery in task sessions without teaching final-output blocks', () => {
    const instructions = buildCompactInstructions(['family'], 'daily-digest-a1b2');

    expect(instructions).toContain('send_message');
    expect(instructions).toContain('explicit to destination');
    expect(instructions).toContain('tasks/daily-digest-a1b2.md');
    expect(instructions).not.toContain('<message to="name">');
  });
});
