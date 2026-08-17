import React, { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import {
  cancelScheduled,
  editScheduled,
  getScheduledDetail,
  listGroups,
  listMessagingGroups,
  moveScheduled,
  moveScheduledPreview,
  pauseScheduled,
  resumeScheduled,
  runNowScheduled,
  type MovePreviewResult,
  type ScheduledDetail,
  type ScheduledVerb,
} from '../lib/api.js';
import { useIsMobile } from './BoardShell.js';

/**
 * Right-side detail drawer for a scheduled series. Shows the full prompt +
 * script, per-fire overrides (quietStatus, flagIntent), an edit form, the
 * last-5 fire history, the audit tail (mutation-tier only), and the verb
 * buttons.
 *
 * THE load-bearing rule (E4 / the [NEEDS SPEC] single-source resolution):
 * every verb button's enabled/disabled state comes SOLELY from the row's
 * `available_verbs` array — the server's verb×state matrix output. The drawer
 * NEVER re-derives the guard logic client-side; doing so was the cycle-2
 * failure mode. We render the full verb set always (so the affordance is
 * discoverable) and disable any verb the API didn't authorize.
 *
 * Confirms gate the irreversible/expensive verbs:
 *   - module-owned edit → reseed-overwrite warning naming the owning module (D2)
 *   - move             → credential-delta confirm (gains/losses NAMES + the
 *                        unattended-script caveat D8 + the environmentDeltaChecked
 *                        static caveat W2), echoing deltaHash to /move (SEC-2)
 *   - run-now          → the F3 "next occurrence may still fire" residual confirm,
 *                        sending force:true only on explicit confirm
 *   - cancel           → end-series confirm
 *
 * On mobile the drawer is read-only (v1, §5 OUT): the edit form is omitted but
 * the verb buttons remain.
 */

interface ScheduledDrawerProps {
  rowKey: string;
  /** The persona name for this row's agent group, when the caller knows one —
   *  the fetched row carries the group's code name, which is not what the
   *  operator calls it. Null falls back to that code name. */
  groupName?: string | null;
  onClose: () => void;
  onMutated: () => void;
}

const ALL_VERBS: ScheduledVerb[] = ['edit', 'pause', 'resume', 'run_now', 'cancel', 'move'];

const VERB_LABEL: Record<ScheduledVerb, string> = {
  edit: 'Edit',
  pause: 'Pause',
  resume: 'Resume',
  run_now: 'Run now',
  cancel: 'Cancel',
  move: 'Move',
};

type Pane =
  | { kind: 'none' }
  | { kind: 'edit' }
  | { kind: 'cancel-confirm' }
  | { kind: 'runnow-confirm' }
  | { kind: 'move-form' }
  | { kind: 'move-confirm'; preview: MovePreviewResult; targetAgentGroupId: string; targetMessagingGroupId: string };

export const ScheduledDrawer: React.FC<ScheduledDrawerProps> = ({ rowKey, groupName = null, onClose, onMutated }) => {
  const isMobile = useIsMobile();
  const { data, mutate } = useSWR<ScheduledDetail>(
    ['/dashboard/api/scheduled', rowKey],
    () => getScheduledDetail(rowKey),
    { refreshInterval: 0 },
  );
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc closes the drawer (parity with GroupTitle's menu / overlay convention).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const afterMutation = useCallback(() => {
    setPane({ kind: 'none' });
    setBusy(false);
    void mutate();
    onMutated();
  }, [mutate, onMutated]);

  // A single guarded runner for the no-extra-input verbs (pause/resume).
  const runVerb = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        afterMutation();
      } catch (e) {
        setBusy(false);
        setError(reasonOf(e));
      }
    },
    [afterMutation],
  );

  if (!data) {
    return (
      <aside className="nc-sched-drawer" role="dialog" aria-label="Scheduled series detail">
        <DrawerHeader title="Loading…" onClose={onClose} />
      </aside>
    );
  }

  const { row, prompt, script, history, audit_tail } = data;
  const allowed = (verb: ScheduledVerb): boolean => row.available_verbs.includes(verb);

  const onVerbClick = (verb: ScheduledVerb) => {
    if (!allowed(verb)) return; // defensive — the button is already disabled
    setError(null);
    switch (verb) {
      case 'pause':
        void runVerb(() => pauseScheduled(row.key));
        break;
      case 'resume':
        void runVerb(() => resumeScheduled(row.key));
        break;
      case 'edit':
        setPane({ kind: 'edit' });
        break;
      case 'cancel':
        setPane({ kind: 'cancel-confirm' });
        break;
      case 'run_now':
        setPane({ kind: 'runnow-confirm' });
        break;
      case 'move':
        setPane({ kind: 'move-form' });
        break;
    }
  };

  return (
    <aside className="nc-sched-drawer" role="dialog" aria-label="Scheduled series detail" data-testid="sched-drawer">
      <DrawerHeader title={row.series_id} onClose={onClose} />

      <div className="nc-sched-drawer-body">
        <div className="nc-sched-drawer-meta">
          <Field label="Group" value={groupName ?? row.agent_group_name} />
          <Field label="Channel" value={`${row.channel_name ?? '—'}${row.thread_id ? ` · ${row.thread_id}` : ''}`} />
          <Field label="Cron" value={row.cron ?? '—'} />
          <Field label="Next (UTC)" value={row.next_fire_utc ?? '—'} />
          <Field label="Next (local)" value={row.next_fire_local ?? '—'} />
          <Field label="Health" value={row.health} />
          {row.module_owner != null && <Field label="Owner" value={row.module_owner} />}
        </div>

        {/* Per-fire overrides — brief-required metadata, rendered read-only. */}
        {(row.quiet_status || row.flag_intent != null) && (
          <div className="nc-sched-overrides">
            <h4>Per-fire overrides</h4>
            {row.quiet_status && <div className="ovr">quietStatus: on</div>}
            {row.flag_intent != null && (
              <div className="ovr">flagIntent: {JSON.stringify(row.flag_intent)}</div>
            )}
          </div>
        )}

        <section className="nc-sched-prompt">
          <h4>Prompt</h4>
          <pre>{prompt}</pre>
          {script != null && (
            <>
              <h4>Pre-task script</h4>
              <pre>{script}</pre>
            </>
          )}
        </section>

        <section className="nc-sched-history">
          <h4>Recent fires</h4>
          {history.length === 0 ? (
            <div className="nc-empty">no fire history</div>
          ) : (
            <ul>
              {history.map((f, i) => (
                <li key={f.id ?? i}>
                  <span className="ts">{f.ts ?? '—'}</span>
                  <span className={`outcome ${outcomeTone(f.outcome)}`}>{f.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {audit_tail != null && audit_tail.length > 0 && (
          <section className="nc-sched-audit" data-testid="sched-audit-tail">
            <h4>Audit</h4>
            <ul>
              {audit_tail.map((a) => (
                <li key={a.id}>
                  <span className="ts">{a.ts}</span>
                  <span className="actor">{a.actor}</span>
                  <span className="action">{a.action}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && <div className="nc-sched-drawer-error" role="alert">{error}</div>}

        {/* ─── Verb buttons — enabled SOLELY from available_verbs ─── */}
        <div className="nc-sched-verbs" role="group" aria-label="Series actions">
          {ALL_VERBS.map((verb) => (
            <button
              key={verb}
              type="button"
              data-verb={verb}
              className={`nc-sched-verb ${verb}`}
              disabled={!allowed(verb) || busy}
              onClick={() => onVerbClick(verb)}
            >
              {VERB_LABEL[verb]}
            </button>
          ))}
        </div>

        {/* ─── Confirm / form panes ─── */}
        {pane.kind === 'edit' && !isMobile && (
          <EditForm
            detail={data}
            busy={busy}
            onCancel={() => setPane({ kind: 'none' })}
            onSubmit={(body) => void runVerb(() => editScheduled(row.key, body))}
          />
        )}

        {pane.kind === 'cancel-confirm' && (
          <ConfirmBox
            testId="cancel-confirm"
            title="End this series?"
            body="This ends the series — the next occurrence will not fire, and this cannot be undone."
            confirmLabel="End series"
            danger
            busy={busy}
            onConfirm={() => void runVerb(() => cancelScheduled(row.key))}
            onCancel={() => setPane({ kind: 'none' })}
          />
        )}

        {pane.kind === 'runnow-confirm' && (
          <ConfirmBox
            testId="runnow-confirm"
            title="Run now?"
            body="This fires the series immediately. The next occurrence may still fire on its normal slot — this is a deliberate extra run."
            confirmLabel="Run anyway"
            busy={busy}
            onConfirm={() => void runVerb(() => runNowScheduled(row.key, { force: true }))}
            onCancel={() => setPane({ kind: 'none' })}
          />
        )}

        {pane.kind === 'move-form' && (
          <MoveForm
            busy={busy}
            error={error}
            onCancel={() => setPane({ kind: 'none' })}
            onPreview={async (targetAgentGroupId, targetMessagingGroupId) => {
              setBusy(true);
              setError(null);
              try {
                const preview = await moveScheduledPreview(row.key, {
                  targetAgentGroupId,
                  targetMessagingGroupId,
                });
                setBusy(false);
                setPane({ kind: 'move-confirm', preview, targetAgentGroupId, targetMessagingGroupId });
              } catch (e) {
                setBusy(false);
                setError(reasonOf(e));
              }
            }}
          />
        )}

        {pane.kind === 'move-confirm' && (
          <MoveConfirm
            pane={pane}
            moduleOwner={row.module_owner}
            busy={busy}
            onCancel={() => setPane({ kind: 'none' })}
            onConfirm={() =>
              void runVerb(() =>
                moveScheduled(row.key, {
                  targetAgentGroupId: pane.targetAgentGroupId,
                  targetMessagingGroupId: pane.targetMessagingGroupId,
                  confirmedDeltaHash: pane.preview.deltaHash,
                }),
              )
            }
          />
        )}
      </div>
    </aside>
  );
};

/* ─── Subcomponents ─── */

function DrawerHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="nc-sched-drawer-head">
      <h3>{title}</h3>
      <button type="button" className="nc-sched-drawer-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </header>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="nc-sched-field">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

function EditForm({
  detail,
  busy,
  onCancel,
  onSubmit,
}: {
  detail: ScheduledDetail;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: { prompt?: string; script?: string; cron?: string }) => void;
}) {
  const { row, prompt, script } = detail;
  const [p, setP] = useState(prompt);
  const [s, setS] = useState(script ?? '');
  const [c, setC] = useState(row.cron ?? '');
  const isModule = row.module_owner != null;

  return (
    <form
      className="nc-sched-edit-form"
      data-testid="sched-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Only submit `cron` when the user actually has one. A one-off row has
        // row.cron === null → c === '' → submitting cron:'' would 400 (bad_cron)
        // and block prompt/script edits. Omitting it leaves the schedule unchanged.
        const body: { prompt?: string; script?: string; cron?: string } = { prompt: p, script: s };
        if (c.trim() !== '') body.cron = c.trim();
        onSubmit(body);
      }}
    >
      {isModule && (
        <div className="nc-sched-reseed-warning" data-testid="reseed-warning" role="alert">
          This series is owned by the <strong>{row.module_owner}</strong> module. The module will
          reseed it and overwrite your edits on its next run. Edit anyway only if you understand the
          change is temporary.
        </div>
      )}
      <label>
        Prompt
        <textarea value={p} onChange={(e) => setP(e.target.value)} rows={4} />
      </label>
      <label>
        Pre-task script
        <textarea value={s} onChange={(e) => setS(e.target.value)} rows={3} />
      </label>
      <label>
        Cron
        <input value={c} onChange={(e) => setC(e.target.value)} />
      </label>
      <div className="nc-sched-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Discard
        </button>
        <button type="submit" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

function MoveForm({
  busy,
  error,
  onCancel,
  onPreview,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onPreview: (targetAgentGroupId: string, targetMessagingGroupId: string) => void;
}) {
  const [ag, setAg] = useState('');
  const [mg, setMg] = useState('');
  // The move target must be a REAL agent group / messaging group id (§4.5 —
  // the API 404s on an unknown one), so the SPA offers the actual options
  // instead of free text.
  const { data: groups } = useSWR('/dashboard/api/groups', () => listGroups());
  const { data: messagingGroups } = useSWR('/dashboard/api/messaging-groups', () => listMessagingGroups());
  return (
    <form
      className="nc-sched-move-form"
      onSubmit={(e) => {
        e.preventDefault();
        onPreview(ag, mg);
      }}
    >
      <label>
        Target agent group
        <select value={ag} onChange={(e) => setAg(e.target.value)} aria-label="Target agent group">
          <option value="">Select an agent group…</option>
          {groups?.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target messaging group
        <select value={mg} onChange={(e) => setMg(e.target.value)} aria-label="Target messaging group">
          <option value="">Select a messaging group…</option>
          {messagingGroups?.messaging_groups.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="nc-sched-drawer-error" role="alert">{error}</div>}
      <div className="nc-sched-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !ag || !mg}>
          Preview
        </button>
      </div>
    </form>
  );
}

function MoveConfirm({
  pane,
  moduleOwner,
  busy,
  onCancel,
  onConfirm,
}: {
  pane: Extract<Pane, { kind: 'move-confirm' }>;
  moduleOwner: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { preview } = pane;
  return (
    <div className="nc-sched-move-confirm" data-testid="move-confirm" role="alertdialog" aria-label="Confirm move">
      <h4>Confirm move</h4>
      {!preview.wiringOk && (
        <div className="nc-sched-drawer-error" role="alert">
          Target is not wired to that channel — the move would strand the series. Fix the wiring
          first.
        </div>
      )}
      {moduleOwner != null && (
        <div className="nc-sched-reseed-warning" role="alert">
          Owned by the <strong>{moduleOwner}</strong> module — it may reseed the series back to its
          original group.
        </div>
      )}
      <div className="nc-sched-delta">
        <div className="gains">
          <span className="lbl">Gains</span>
          {preview.gains.length === 0 ? (
            <span className="none">none</span>
          ) : (
            <ul>{preview.gains.map((g) => <li key={g}>{g}</li>)}</ul>
          )}
        </div>
        <div className="losses">
          <span className="lbl">Loses</span>
          {preview.losses.length === 0 ? (
            <span className="none">none</span>
          ) : (
            <ul>{preview.losses.map((l) => <li key={l}>{l}</li>)}</ul>
          )}
        </div>
      </div>
      {preview.crossWorkgroup && (
        <div className="nc-sched-caveat">This move crosses workgroup boundaries.</div>
      )}
      <div className="nc-sched-caveat">
        ⚠ This series runs <strong>unattended</strong> at the target. The pre-task script and prompt
        will execute with the target's credentials without you present — make sure the credential
        change above is intended.
      </div>
      {/* environmentDeltaChecked:false static caveat (W2) */}
      <div className="nc-sched-caveat">
        Only the credential (secret) delta was checked. The target's wider <strong>environment</strong>{' '}
        (packages, MCP servers, mounts, provider) is <strong>not</strong> compared in v1.
      </div>
      <div className="nc-sched-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button type="button" onClick={onConfirm} disabled={busy || !preview.wiringOk}>
          Confirm move
        </button>
      </div>
    </div>
  );
}

function ConfirmBox({
  testId,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  testId: string;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="nc-sched-confirm" data-testid={testId} role="alertdialog" aria-label={title}>
      <h4>{title}</h4>
      <p>{body}</p>
      <div className="nc-sched-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className={danger ? 'danger' : ''}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/* ─── helpers ─── */

function outcomeTone(outcome: string): string {
  if (outcome === 'failed' || outcome === 'missed') return 'bad';
  if (outcome === 'cancelled') return 'muted';
  return 'ok';
}

function reasonOf(e: unknown): string {
  if (e && typeof e === 'object' && 'error' in e && typeof (e as { error: unknown }).error === 'string') {
    return (e as { error: string }).error;
  }
  return 'request failed';
}
