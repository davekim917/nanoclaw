export type ParsedArgv = {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
  stdinJson: boolean;
};

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;
  let stdinJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--stdin-json') {
      stdinJson = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : next;
      if (value !== true) i++;
      const prior = args[key];
      args[key] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), value];
      continue;
    }
    positional.push(arg);
  }

  // Join all positionals with dashes to form the command name.
  // If the full name isn't a command, the dispatcher will try trimming
  // the last segment and using it as the target ID (e.g. `groups get abc`
  // → command "groups-get", id "abc").
  return { command: positional.join('-'), args, json, stdinJson };
}
