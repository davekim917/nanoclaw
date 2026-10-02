/**
 * Topic-checkout half of scripts/git-safety.sh's snapshot phase (src/topic-snapshot.ts). Exit 0: done; 1: one
 * or more failures, each printed as a `failure:` line on stderr for git-safety.sh to report; 2: bad usage.
 */
import { snapshotTopics } from '../src/topic-snapshot.js';

const USAGE =
  'usage: topic-snapshot.ts --data-root <dir> --out <dir> --manifest <file> --timeout-seconds <n> --max-untracked-bytes <n> -- <glob>...';

function parse(argv: string[]): Parameters<typeof snapshotTopics>[0] | null {
  const split = argv.indexOf('--');
  if (split < 0) return null;
  const flags = new Map<string, string>();
  const head = argv.slice(0, split);
  for (let i = 0; i < head.length; i += 2) {
    if (!head[i].startsWith('--') || head[i + 1] === undefined) return null;
    flags.set(head[i], head[i + 1]);
  }
  const timeoutSeconds = Number(flags.get('--timeout-seconds'));
  const maxUntrackedBytes = Number(flags.get('--max-untracked-bytes'));
  const dataRoot = flags.get('--data-root');
  const outDir = flags.get('--out');
  const manifestPath = flags.get('--manifest');
  if (!dataRoot || !outDir || !manifestPath || !(timeoutSeconds > 0) || !(maxUntrackedBytes > 0)) return null;
  return {
    dataRoot,
    outDir,
    manifestPath,
    timeoutMs: timeoutSeconds * 1000,
    maxUntrackedBytes,
    patterns: argv.slice(split + 1),
  };
}

const options = parse(process.argv.slice(2));
if (!options) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const result = await snapshotTopics(options);
  for (const failure of result.failures) console.error(`failure: ${JSON.stringify(failure)}`);
  console.log(
    `topics: ${result.captured} checkout(s) captured, ${result.bundled} repo(s) bundled, ${result.unreadable.length} git cannot open`,
  );
  process.exit(result.failures.length > 0 ? 1 : 0);
} catch (err) {
  console.error(
    `failure: ${JSON.stringify(`topic snapshot did not finish: ${err instanceof Error ? err.message : String(err)}`)}`,
  );
  process.exit(1);
}
