import { AgentAvatar } from './AgentAvatar.js';
import { SmokeMark } from './SmokeMark.js';
import type { OfficeData } from './office-data.js';

/**
 * The floor on a phone: one card per room, scrolled sideways.
 *
 * ALL rooms, slotted or not. The floor plan has eleven fixed zones and can run
 * out of them; a strip of cards has no plan to run out of, so a channel that
 * the desktop plan pushes into its overflow list still gets an ordinary card
 * here. Every room stays reachable on both form factors — that is the rule the
 * two components exist to keep.
 *
 * This is the only horizontally scrolling element in the product.
 */
export function RoomStrip({
  data,
  selected,
  onSelect,
  onAgentSelect,
  alertRooms,
  vignettes,
}: {
  data: OfficeData;
  selected: string;
  onSelect: (key: string) => void;
  onAgentSelect: (name: string, roomKey: string) => void;
  alertRooms: Set<string>;
  /** Room keys whose bound signal is live right now. Unknown keys are ignored. */
  vignettes?: Set<string> | undefined;
}) {
  // A slotted room is picked by its SLOT (what the plan and the page filter
  // use); an overflow room has none, so it is picked by its own key.
  const cards = [
    ...data.rooms.map((r) => ({ ...r, tileKey: r.slot as string })),
    ...data.overflowRooms.map((r) => ({ ...r, tileKey: r.key })),
  ];

  return (
    <div className="tm-strip" data-testid="room-strip">
      {cards.map((r) => (
        <div
          key={r.key}
          className={`tm-room ${selected === r.tileKey ? 'is-selected' : ''}`}
          data-room={r.key}
          data-alert={alertRooms.has(r.key) ? 'true' : 'false'}
        >
          {/* The card is a plain container and the room is a real <button>
              inside it, NOT the other way round. A role="button" wrapper around
              the occupant buttons is invalid nesting, and Enter on an occupant
              bubbled to the wrapper — opening the room sheet AND the agent
              drawer from one keypress. The button owns the label and the empty
              state, so it is still most of the card to tap. */}
          <button
            type="button"
            className="tm-room-pick tm-tap"
            data-room-pick={r.key}
            onClick={() => onSelect(r.tileKey)}
          >
            <span className="tm-room-label">{r.label.replace(/^#/, '')}</span>
            {r.agents.length === 0 && <span className="tm-room-empty">Empty</span>}
          </button>
          {vignettes?.has(r.key) && <SmokeMark />}
          {r.agents.length > 0 && (
            <div className="tm-room-avatars">
              {r.agents.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  className="tm-room-occupant tm-tap"
                  data-occupant={a.name}
                  title={a.name}
                  aria-label={a.name}
                  onClick={() => onAgentSelect(a.name, r.key)}
                >
                  <AgentAvatar name={a.name} avatarUrl={a.avatarUrl} status={a.status} size={30} />
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
