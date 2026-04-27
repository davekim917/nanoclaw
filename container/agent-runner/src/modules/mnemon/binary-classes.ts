export const READ_ONLY_COMMANDS = ['recall', 'search', 'related', 'status', 'viz', 'version', 'help', '--version', '--help', ''] as const;
export const WRITE_COMMANDS = ['remember', 'link', 'forget', 'embed', 'gc'] as const;
export const ADMIN_COMMANDS = ['store', 'setup'] as const;

export type CommandClass = 'read' | 'write' | 'admin' | 'unknown';

export function classifyCommand(subcmd: string): CommandClass {
  if ((READ_ONLY_COMMANDS as readonly string[]).includes(subcmd)) return 'read';
  if ((WRITE_COMMANDS as readonly string[]).includes(subcmd)) return 'write';
  if ((ADMIN_COMMANDS as readonly string[]).includes(subcmd)) return 'admin';
  return 'unknown';
}
