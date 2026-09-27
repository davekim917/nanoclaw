/**
 * Accepts `--flag value` and `--flag=value`; `value()` returns the inline value or consumes the
 * next argument, which may itself begin with a dash.
 */
export function walkArgs(
  argv: readonly string[],
  fail: (message: string) => never,
  onArg: (name: string, arg: string, value: () => string) => void,
): void {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    onArg(name, arg, () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} needs a value`);
      i += 1;
      return next;
    });
  }
}
