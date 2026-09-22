/**
 * PreCompact hook script — outputs custom compaction instructions to stdout.
 *
 * Claude Code captures the stdout of PreCompact shell hooks and passes it
 * as `customInstructions` to the compaction prompt. This ensures the
 * compaction summary preserves message routing context that the agent needs
 * to correctly address responses.
 *
 * Invoked by the PreCompact hook in .claude-shared/settings.json:
 *   "command": "bun /app/src/compact-instructions.ts"
 */
import { getAllDestinations } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { outcomeReportingEnabled } from './outcome-reporting.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';

export function buildCompactInstructions(
  names: string[],
  taskId: string | null,
  structuredReporting = outcomeReportingEnabled(),
): string {
  const deliveryReminder = taskId
    ? [
        '   "This is an isolated task run. If you need to send the user a message, use send_message with an explicit to destination.',
        `   Final output is not delivered; it becomes the automatic summary in tasks/${taskId}.md.`,
        `   Available destinations: ${formatDestinationNames(names)}."`,
      ]
    : structuredReporting
      ? [
          '   "Public replies use send_message with an explicit purpose; omit to for the current conversation.',
          '   Final text is an internal work record under this runtime capability.',
          `   Available destinations: ${formatDestinationNames(names)}."`,
        ]
      : [
          '   "You MUST wrap all responses in <message to="name">...</message> blocks — use to="here" for the current conversation (the default).',
          `   Available destinations: ${formatDestinationNames(names)}."`,
        ];

  return [
    'Preserve the following in the compaction summary:',
    '',
    '1. For recent messages, keep the full XML structure including all attributes:',
    '   - <message from="..." sender="..." time="..."> for chat messages',
    '   - <task from="..." time="..." current_time="..."> for scheduled tasks',
    '   - <webhook from="..." source="..." event="..."> for webhooks',
    '   The message content can be summarized if long, but the XML tags and attributes must remain.',
    '',
    '2. Preserve the chronological message/reply sequence of recent exchanges.',
    '   The agent needs to see: who said what, in what order, and from which destination.',
    '',
    '3. At the END of the compaction summary, include this verbatim reminder:',
    ...deliveryReminder,
  ].join('\n');
}

function formatDestinationNames(names: string[]): string {
  return names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : '(none)';
}

if (import.meta.main) {
  // getTaskSeriesId reads through the mailbox, so this hook process has to
  // boot it the same way the runner and the MCP server do.
  await getAgentMailbox().start(await readMailboxContext());
  const names = getAllDestinations().map((destination) => destination.name);
  console.log(buildCompactInstructions(names, getTaskSeriesId()));
}
