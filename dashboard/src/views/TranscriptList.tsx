import { renderMarkdown } from '../lib/markdown.js';
import { relAge, textOfEntry } from '../lib/derive.js';
import type { SessionTranscriptEntry, TranscriptEntry } from '../lib/api.js';

/**
 * Shared transcript renderer for both TaskDetail and SessionDetail.
 *
 * Why a single component:
 *   - Markdown rendering, expand-on-truncation, and the contiguous-status
 *     coalesce (thinking groups) used to live only in SessionDetail; TaskDetail
 *     used its own `TranscriptBubble` that did markdown but neither of the
 *     other two. Operator feedback flagged the asymmetry.
 *   - The two API endpoints return different entry shapes (TaskDetail's
 *     `TranscriptEntry` has `.id/.seq/.content/.source/.direction='inbound'|
 *     'outbound'`; SessionDetail's `SessionTranscriptEntry` has
 *     `.seq/.kind/.text/.direction='in'|'out'`). The `normalize*` helpers
 *     adapt each into a single internal shape; the rendering doesn't care
 *     which side fed it.
 */

interface NormalizedEntry {
  key: string;
  direction: 'in' | 'out';
  kind: string;
  source?: string;
  timestamp: string;
  text: string;
}

export function normalizeSessionEntry(e: SessionTranscriptEntry): NormalizedEntry {
  return {
    key: `${e.direction}-${e.seq}`,
    direction: e.direction,
    kind: e.kind,
    timestamp: e.timestamp,
    text: e.text,
  };
}

export function normalizeTaskEntry(e: TranscriptEntry): NormalizedEntry {
  return {
    key: e.id,
    direction: e.direction === 'inbound' ? 'in' : 'out',
    kind: e.kind,
    source: e.source,
    timestamp: e.timestamp,
    text: textOfEntry(e),
  };
}

const TRUNCATE_AT = 800;

/**
 * Any outbound `kind=status` entry counts as "agent internal work" and
 * gets coalesced with adjacent ones into a single collapsed group. This
 * captures Claude Code's `> 💭` thinking lines AND its `> ✅` tool-result
 * checkpoints (and any future glyph), without hard-coding the prefix.
 */
function isThinking(entry: NormalizedEntry): boolean {
  if (entry.direction !== 'out') return false;
  return entry.kind === 'status';
}

type TranscriptGroup =
  | { kind: 'entry'; entry: NormalizedEntry }
  | { kind: 'thinking'; entries: NormalizedEntry[] };

function groupTranscript(entries: NormalizedEntry[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = [];
  for (const e of entries) {
    if (isThinking(e)) {
      const last = out[out.length - 1];
      if (last && last.kind === 'thinking') {
        last.entries.push(e);
        continue;
      }
      out.push({ kind: 'thinking', entries: [e] });
    } else {
      out.push({ kind: 'entry', entry: e });
    }
  }
  return out;
}

export function TranscriptList({ entries }: { entries: NormalizedEntry[] }) {
  if (entries.length === 0) {
    return <div className="nc-empty">no messages yet</div>;
  }
  const groups = groupTranscript(entries);
  return (
    <ul className="nc-transcript">
      {groups.map((g, idx) =>
        g.kind === 'thinking' ? (
          <ThinkingGroupRow key={`thinking-${g.entries[0]!.key}-${idx}`} entries={g.entries} />
        ) : (
          <TranscriptRow key={g.entry.key} entry={g.entry} />
        ),
      )}
    </ul>
  );
}

function TranscriptRow({ entry }: { entry: NormalizedEntry }) {
  const isInbound = entry.direction === 'in';
  const isLong = entry.text.length > TRUNCATE_AT;
  const previewSrc = isLong ? entry.text.slice(0, TRUNCATE_AT) : entry.text;
  const previewHtml = renderMarkdown(previewSrc);
  const fullHtml = isLong ? renderMarkdown(entry.text) : null;

  return (
    <li className={`nc-transcript-row ${isInbound ? 'inbound' : 'outbound'}`}>
      <div className="nc-transcript-meta">
        <span className="nc-pill">{isInbound ? '→ in' : '← out'}</span>
        {entry.source && (
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{entry.source}</span>
        )}
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{entry.kind}</span>
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{relAge(entry.timestamp)} ago</span>
      </div>
      {isLong ? (
        <details className="nc-transcript-expand">
          <summary>
            <div
              className="nc-transcript-text nc-md"
              dangerouslySetInnerHTML={{ __html: previewHtml + '<span class="nc-truncate-ellipsis">…</span>' }}
            />
            <span className="nc-transcript-more">show full message ({entry.text.length} chars)</span>
          </summary>
          <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: fullHtml ?? '' }} />
        </details>
      ) : (
        <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      )}
    </li>
  );
}

function ThinkingGroupRow({ entries }: { entries: NormalizedEntry[] }) {
  const label = entries.length === 1 ? '1 agent step' : `${entries.length} agent steps`;
  return (
    <li className="nc-transcript-row outbound nc-transcript-thinking">
      <details>
        <summary>
          <span className="nc-pill">💭 {label}</span>
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>
            {relAge(entries[entries.length - 1]!.timestamp)} → {relAge(entries[0]!.timestamp)} ago
          </span>
        </summary>
        <div className="nc-thinking-list">
          {entries.map((e) => (
            <div key={e.key} className="nc-thinking-entry">
              <div style={{ color: 'var(--fg-3)', fontSize: 11, marginBottom: 4 }}>
                {relAge(e.timestamp)} ago
              </div>
              <div className="nc-transcript-text nc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }} />
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}
