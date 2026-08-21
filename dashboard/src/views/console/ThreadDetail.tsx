import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { getThreadDetail, type ThreadSummary, type ThreadTranscriptEntry } from '../../lib/api.js';
import { relAge } from '../../lib/derive.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { AgentAvatar } from '../AgentAvatar.js';
import { prefillChips, type PrefillChip } from '../ship-prefill.js';
import { actionError } from './action-error.js';
import { sendToAgent } from './actions.js';
import { STATE_PRESENTATION, initials, replyTarget } from './thread-state.js';

/**
 * The thread detail pane — merged transcript (§10.1) plus the composer that
 * carries the console's ONE action.
 *
 * **The composer always names an agent.** A thread is N inbound queues and a
 * send writes into exactly one, so "reply to this thread" is not a well-formed
 * request: the selector is not decoration, it is the request. The default is the
 * agent whose state drove the row's urgency — the one that asked the question,
 * or the one whose container stalled — which the server computes as
 * `reply_target_session_id`.
 *
 * **The selector spans every wired agent, not just the ones already here.**
 * Participants first, then the rest of the agents wired to this thread's
 * channel, in a separate group. Choosing from the lower group is Assign: the
 * server resolves a session for that agent on this thread and delivers. It is
 * the same send — the only difference is that a queue had to be opened first.
 *
 * There is deliberately NO broadcast-to-every-participant option. Six agents
 * each receiving "yes, go ahead" in their own queue is six agents acting on it.
 */

export interface ThreadDetailProps {
  thread: ThreadSummary | null;
  /**
   * Bumped by the caller to move focus into the composer — what the row's
   * verb and triage's `A` key do. `0` means "leave focus alone", which is what
   * a plain row selection passes.
   */
  focusComposer?: number;
  /**
   * The release item's `nextAction`, when this row IS a release item — the
   * source of the ship prefill chip (see `ship-prefill.ts`). Threads do not
   * carry release items yet (DESIGN §10's board join is unbuilt), so nothing
   * passes this today and the composer offers the three decision chips alone.
   */
  nextAction?: string;
  /** Fired after a send lands, so the caller can revalidate and (in triage) advance. */
  onSent?: (thread: ThreadSummary) => void;
}

/**
 * How far from the bottom still counts as being AT the bottom, in px.
 *
 * Not zero. A fractional `scrollHeight`, a sub-pixel line box, a trackpad's
 * rubber-band overscroll — any of them leaves a pixel or two of slack, and
 * reading that as "the operator scrolled up" would silently stop a live thread
 * from following.
 */
const BOTTOM_SLACK = 48;

/**
 * The transcript opens at its newest message, and keeps following — but only
 * while the operator is actually reading the bottom of it.
 *
 * Three things this has to survive, each of which breaks the naive version:
 *
 * 1. **Height is not known at commit time.** The bodies are rendered markdown;
 *    images and the two web faces settle AFTER paint and every one of them makes
 *    the transcript taller. Scrolling once on mount therefore lands short, which
 *    is why a ResizeObserver on the content box re-anchors as it settles. The
 *    observer watches `.ncc-transcript-inner`, not the scroller: the scroller's
 *    own border box is pinned by the shell and never resizes at all.
 * 2. **Switching threads is an open, not a refresh** — it re-anchors from
 *    scratch regardless of where the previous thread was left.
 * 3. **Do not yank.** An operator who has scrolled up to read history keeps
 *    their place when the next message lands. That rule is the whole difference
 *    between a chat pane and an annoying one, so `stick` is driven by the
 *    operator's own scrolling and by nothing else.
 */
function useBottomAnchor(threadId: string, transcript: ThreadTranscriptEntry[] | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Declared BEFORE the pin below so that on the render which changes the
  // thread, the reset has already run by the time the anchor fires.
  useLayoutEffect(() => {
    stick.current = true;
  }, [threadId]);

  useLayoutEffect(pin, [pin, threadId, transcript]);

  useEffect(() => {
    const box = content.current;
    // jsdom has no ResizeObserver, and the effect is a progressive improvement
    // on the layout-effect anchor rather than a replacement for it.
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(pin);
    ro.observe(box);
    return () => ro.disconnect();
  }, [pin]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  }, []);

  return { scroller, content, onScroll };
}

export function ThreadDetail({ thread, focusComposer = 0, nextAction, onSent }: ThreadDetailProps) {
  const { data } = useSWR(
    thread ? ['thread-detail', thread.thread_id, thread.last_activity_at] : null,
    () => getThreadDetail(thread!.thread_id),
    { refreshInterval: 0 },
  );
  const anchor = useBottomAnchor(thread?.thread_id ?? '', data?.transcript);

  if (!thread) {
    return (
      <section className="ncc-detail" aria-label="Thread detail">
        <div className="ncc-empty">select a thread</div>
      </section>
    );
  }

  const presentation = STATE_PRESENTATION[thread.state];
  const sessionCount = thread.session_ids.length;

  return (
    <section className="ncc-detail" aria-label="Thread detail">
      <div className="ncc-detail-head">
        <span className="ncc-faces">
          {thread.participants.slice(0, 3).map((p) => (
            <span className="ncc-face" key={p.agent_group_id} title={p.name}>
              <AgentAvatar name={p.name} initials={initials(p.name)} avatarUrl={p.avatarUrl} size={25} />
            </span>
          ))}
        </span>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <h2 className="ncc-detail-title">{thread.title ?? 'Untitled thread'}</h2>
          <div className="ncc-detail-meta">
            <span>{thread.channel_name}</span>
            <span aria-hidden="true">·</span>
            <span>{thread.participants.map((p) => p.name).join(', ') || 'no owner'}</span>
            <span aria-hidden="true">·</span>
            <span>{thread.last_activity_at ? `${relAge(thread.last_activity_at)} ago` : 'no activity'}</span>
          </div>
        </div>
        <span className={`ncc-state ${presentation.tone}`}>{presentation.label}</span>
      </div>

      {/* §10.1: a thread's messages are split across one DB pair per agent, so
          the merge is a real transformation the operator should know about. */}
      <div className="ncc-detail-note">
        Merged from {sessionCount} agent session{sessionCount === 1 ? '' : 's'} on this thread, in timestamp order.
      </div>

      <div className="ncc-transcript" ref={anchor.scroller} onScroll={anchor.onScroll}>
        <div className="ncc-transcript-inner" ref={anchor.content}>
          {(data?.transcript ?? []).map((m) => (
            <div className={`ncc-msg ${m.direction}`} key={`${m.session_id}:${m.seq}`}>
              <span className="ncc-face">
                <AgentAvatar name={m.agent_name} initials={initials(m.agent_name)} avatarUrl={null} size={24} />
              </span>
              <div className="ncc-msg-body">
                <div className="ncc-msg-who">
                  <span className="name">{m.direction === 'out' ? m.agent_name : 'Inbound'}</span>
                  <span className="at">{relAge(m.timestamp)} ago</span>
                </div>
                <MessageText text={m.text} />
              </div>
            </div>
          ))}
          {data && data.transcript.length === 0 && <div className="ncc-empty">no messages on this thread</div>}
        </div>
      </div>

      <ReplyComposer
        key={thread.thread_id}
        thread={thread}
        focusNonce={focusComposer}
        {...(nextAction ? { nextAction } : {})}
        {...(onSent ? { onSent } : {})}
      />
    </section>
  );
}

/* ─── Message body ─────────────────────────────────────────────────────────── */

/**
 * How long a message gets before it collapses behind a `<details>`.
 * Inherited from the retired session page's transcript list — one transcript's
 * reading rhythm should not depend on which surface renders it.
 */
const TRUNCATE_AT = 800;

/**
 * One message, as formatted markdown.
 *
 * `dangerouslySetInnerHTML` is acceptable here for ONE reason: `renderMarkdown`
 * runs `marked` with its default HTML escaping, so agent-authored text — which
 * is effectively untrusted — cannot inject raw HTML through the markdown
 * source. Do not enable `sanitize: false`, `mangle`, or any raw-HTML
 * passthrough, and do not swap the renderer for one that permits inline HTML.
 *
 * The SOURCE is sliced and parsed twice, never the rendered HTML — slicing HTML
 * shreds tags and leaves unclosed elements.
 */
export function MessageText({ text }: { text: string }) {
  const { previewHtml, fullHtml } = useMemo(() => {
    const isLong = text.length > TRUNCATE_AT;
    return {
      previewHtml: renderMarkdown(isLong ? text.slice(0, TRUNCATE_AT) : text),
      fullHtml: isLong ? renderMarkdown(text) : null,
    };
  }, [text]);

  if (!fullHtml) {
    return <div className="ncc-msg-text ncc-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />;
  }
  return (
    <details className="ncc-msg-expand">
      <summary>
        <div className="ncc-msg-text ncc-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        <span className="ncc-msg-more">show full message ({text.length} chars)</span>
      </summary>
      <div className="ncc-msg-text ncc-md" dangerouslySetInnerHTML={{ __html: fullHtml }} />
    </details>
  );
}

/* ─── Composer ─────────────────────────────────────────────────────────────── */

export function ReplyComposer({
  thread,
  focusNonce = 0,
  nextAction,
  onSent,
}: {
  thread: ThreadSummary;
  focusNonce?: number;
  nextAction?: string;
  onSent?: (thread: ThreadSummary) => void;
}) {
  const fallback = useMemo(() => replyTarget(thread), [thread]);
  // The server's default is a PARTICIPANT. A thread nobody has spoken in has
  // none, and leaving the selector empty there showed the first wired agent
  // while the send silently refused — so an assignable is the honest default
  // when there is nothing else to aim at. This is the initial value only; a
  // choice that later goes stale falls to nobody, not back to the first row.
  const [rawAgentId, setAgentId] = useState<string>(
    fallback?.agent_group_id ?? thread.assignable_agents[0]?.agent_group_id ?? '',
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  const box = useRef<HTMLTextAreaElement>(null);

  // Chips resolve their addressee against every agent the selector can reach,
  // participants and assignable alike — a ship instruction naming an agent that
  // has not spoken here yet is exactly the case Assign exists for.
  const reachable = useMemo(
    () => [
      ...thread.participants.map((p) => ({ id: p.agent_group_id, name: p.name })),
      ...thread.assignable_agents.map((a) => ({ id: a.agent_group_id, name: a.name })),
    ],
    [thread],
  );
  const chips = useMemo(() => prefillChips(nextAction, reachable), [nextAction, reachable]);

  // Zero means "do not touch focus" — a plain row selection. Any other value is
  // an explicit request from a verb or from triage's `A`, and it must fire on
  // MOUNT as well as on change: pressing a verb on a row that was not selected
  // yet mounts this composer for the first time, and a change-only effect would
  // land the operator's cursor nowhere.
  useEffect(() => {
    if (focusNonce === 0) return;
    box.current?.focus();
  }, [focusNonce]);

  if (reachable.length === 0) {
    return (
      <div className="ncc-composer">
        <div className="ncc-composer-note">
          No agent is wired to this thread’s channel — there is no queue to send into.
        </div>
      </div>
    );
  }

  /**
   * The chosen agent, re-validated against the agents this thread STILL offers.
   *
   * `reachable` is derived from a live thread row: an agent can leave the
   * participants list (its session archived), and a chip can preset an
   * assignable that the next refresh no longer wires to this channel. The select
   * would render blank while the state still held them, and the send would then
   * go to somebody the operator can no longer see. Nobody is the honest reading
   * of that — same guard `use-workgroup-filter.ts` puts on a stored workgroup, and
   * the same one the legacy composer put on its room-narrowed addressee.
   */
  const agentId = reachable.some((a) => a.id === rawAgentId) ? rawAgentId : '';

  const assigning = thread.assignable_agents.some((a) => a.agent_group_id === agentId);
  const chosen = reachable.find((a) => a.id === agentId);

  /** A chip SETS the box, and presets the selector when it names someone. It never sends. */
  const tap = (chip: PrefillChip): void => {
    setText(chip.text);
    if (chip.addressee) setAgentId(chip.addressee);
    box.current?.focus();
  };

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy || !agentId) return;
    setBusy(true);
    setStatus('');
    try {
      const res = await sendToAgent(thread.thread_id, agentId, body);
      setText('');
      // Say what actually happened, not "sent". An assign opened a queue and a
      // hand-over asked a second agent to let go of a claim; both are things the
      // operator did and neither is visible anywhere else on this screen.
      const who = chosen?.name ?? 'the agent';
      const parts = [res.created_session ? `Assigned to ${who} — opened its queue on this thread.` : `Sent to ${who}.`];
      if (res.handoff) {
        parts.push(
          res.handoff.notified
            ? `${res.handoff.claim_owner} was asked to park or release \`${res.handoff.claim_slug}\`.`
            : `Could not notify ${res.handoff.claim_owner}, who still holds \`${res.handoff.claim_slug}\` — tell them yourself.`,
        );
      }
      setStatus(parts.join(' '));
      onSent?.(thread);
    } catch (err) {
      setStatus(`Could not send — ${actionError(err, chosen?.name)}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ncc-composer">
      <div className="ncc-composer-target">
        {/* Not decoration — this select IS the request. See the file header. */}
        <label htmlFor={`ncc-target-${thread.thread_id}`}>Send to</label>
        <select
          id={`ncc-target-${thread.thread_id}`}
          className="ncc-select"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          {/* `optgroup` rather than a styled divider: the split — already here
              vs. would be handed the thread — has to survive a screen reader,
              and the platform already announces group labels. */}
          {/* Only while nothing valid is chosen — an addressee that aged out of
              `reachable` leaves the select genuinely empty, and it must SAY so
              rather than silently showing whichever option happens to be first. */}
          {!agentId && <option value="">— pick an agent —</option>}
          {thread.participants.length > 0 && (
            <optgroup label="On this thread">
              {thread.participants.map((p) => (
                <option key={p.agent_group_id} value={p.agent_group_id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {thread.assignable_agents.length > 0 && (
            <optgroup label="Hand it to — not on this thread yet">
              {thread.assignable_agents.map((a) => (
                <option key={a.agent_group_id} value={a.agent_group_id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="ncc-composer-hint">
          {!agentId
            ? 'pick who this goes to'
            : assigning
              ? 'this opens its queue on the thread'
              : 'only this agent receives it'}
        </span>

        {/*
         * The quick replies (item 3). Both controls below act on the same
         * `tap`, so there is one mechanism, two presentations, and CSS picks
         * which is on screen — never a JS breakpoint branch (matches the nav
         * sheet's own rule). NESTED here, inside the target row, rather than
         * a sibling below it: that is what puts them on the SAME row as the
         * agent selector on desktop, and what leaves the mobile row with no
         * dedicated row of its own to occupy.
         *
         * Chips set the box and nothing else — the send is still the operator
         * reading what is about to go out. See ship-prefill.ts.
         */}
        <div className="ncc-composer-chips" role="group" aria-label="One-tap answers">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className="ncc-chip"
              data-chip={c.label}
              disabled={busy}
              onClick={() => tap(c)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {/* The mobile stand-in: a menu rather than a row of buttons. Its value
            always resets to the placeholder after a pick, so the SAME reply
            can be chosen twice in a row — a real "change" event has to fire
            each time, which only happens if the select visibly returns to
            "quick reply…" between taps. */}
        <select
          className="ncc-select ncc-composer-quickmenu"
          aria-label="Quick reply"
          value=""
          disabled={busy}
          onChange={(e) => {
            const chip = chips.find((c) => c.label === e.target.value);
            if (chip) tap(chip);
          }}
        >
          <option value="">quick reply…</option>
          {chips.map((c) => (
            <option key={c.label} value={c.label}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ncc-composer-row">
        <textarea
          ref={box}
          className="ncc-composer-box"
          rows={2}
          placeholder={assigning ? 'Hand this thread over…' : "Send into this agent's queue…"}
          aria-label="Message text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline. Ctrl/Cmd are left alone so
            // the browser keeps its own bindings.
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="ncc-solid-btn"
          disabled={busy || !text.trim() || !agentId}
          onClick={() => void send()}
        >
          {busy ? 'sending' : 'send'}
        </button>
      </div>
      <div className="ncc-composer-status" role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}
