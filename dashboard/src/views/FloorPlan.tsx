import { SLOTS, faceSrc, type Slot, type OfficeData, type OfficeAgent } from './office-data.js';

/**
 * The floor, as a schematic.
 *
 * Plain React SVG — no shadow DOM, no pan, no zoom, no pixel art. The previous
 * renderer was a vendored custom element whose world lived in a data-URI SVG,
 * which is why an agent's real avatar had to be a separate DOM overlay: a
 * data-URI SVG cannot load an external image. Inline SVG can, so a face is just
 * an `<image>` in the room it belongs to.
 *
 * The geometry below is HAND-AUTHORED AND FIXED — the same eleven zones, in the
 * same places, on every render, whatever the data does. That is the entire
 * point: a plan generated from data reshuffles whenever the data moves, and a
 * room you cannot find twice is worse than a list. Only occupancy comes from
 * `buildOfficeData`, which is the same transform the old renderer used and is
 * untouched by this rewrite.
 */

export const FLOOR_WIDTH = 1000;
export const FLOOR_HEIGHT = 620;

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every slot `office-data.ts` can assign, and where it sits. Exported so a test
 * can assert the floor draws all of them and so nothing else has to guess at
 * the layout. Keyed by Slot, so adding a slot upstream fails the typecheck here
 * rather than silently dropping a room off the plan.
 */
export const ZONES: Record<Slot, Zone> = {
  // Top band, west to east.
  westFront: { x: 50, y: 50, w: 250, h: 170 },
  eastFront: { x: 310, y: 50, w: 190, h: 170 },
  kitchen: { x: 510, y: 50, w: 180, h: 170 },
  // Middle band.
  westBack: { x: 50, y: 230, w: 310, h: 160 },
  eastBack: { x: 370, y: 230, w: 320, h: 160 },
  // The east wing, north to south.
  eastWingN: { x: 700, y: 50, w: 250, h: 170 },
  eastWingM: { x: 700, y: 230, w: 250, h: 160 },
  eastWingS: { x: 700, y: 400, w: 250, h: 170 },
  // South band.
  southWest: { x: 50, y: 400, w: 200, h: 170 },
  southMid: { x: 260, y: 400, w: 210, h: 170 },
  southEast: { x: 480, y: 400, w: 210, h: 170 },
};

const CHIP = 34;
const CHIP_GAP = 6;
const PAD = 18;
const LABEL_BASELINE = 26;
const CHIPS_TOP = 38;

/** Where an occupant's chip sits inside its zone. Row-major, capped by the room. */
function chipPosition(zone: Zone, index: number): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((zone.w - PAD * 2 + CHIP_GAP) / (CHIP + CHIP_GAP)));
  const row = Math.floor(index / perRow);
  const col = index % perRow;
  return {
    x: zone.x + PAD + col * (CHIP + CHIP_GAP),
    y: zone.y + CHIPS_TOP + row * (CHIP + CHIP_GAP + 8),
  };
}

function OccupantChip({
  agent,
  x,
  y,
  onSelect,
}: {
  agent: OfficeAgent;
  x: number;
  y: number;
  onSelect: () => void;
}) {
  const src = faceSrc(agent.avatarUrl);
  return (
    <g
      className="tm-zone-chip"
      data-occupant={agent.name}
      role="button"
      tabIndex={0}
      aria-label={agent.name}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
        }
      }}
    >
      <title>{agent.name}</title>
      {src ? (
        <image href={src} x={x} y={y} width={CHIP} height={CHIP} preserveAspectRatio="xMidYMid slice" />
      ) : (
        <>
          <rect x={x} y={y} width={CHIP} height={CHIP} className="tm-zone-chip-mark" />
          <text x={x + CHIP / 2} y={y + CHIP / 2 + 4} textAnchor="middle" className="tm-zone-chip-initial">
            {agent.name.trim().charAt(0).toUpperCase() || '·'}
          </text>
        </>
      )}
      <rect x={x + CHIP - 5} y={y + CHIP - 5} width={10} height={10} className={`tm-zone-dot ${agent.status}`} />
    </g>
  );
}

export function FloorPlan({
  data,
  selected,
  onSelect,
  onAgentSelect,
  alertRooms,
  vignettes,
}: {
  data: OfficeData;
  /** The picked slot, or '' for none. */
  selected: string;
  onSelect: (slot: string) => void;
  onAgentSelect: (name: string, roomKey: string) => void;
  /** Room KEYS the exception feed says something is wrong in. */
  alertRooms: Set<string>;
  /** Room keys whose bound signal is live right now. Unknown keys are ignored. */
  vignettes?: Set<string>;
}) {
  const bySlot = new Map(data.rooms.map((r) => [r.slot, r]));

  return (
    <svg
      className="tm-floorplan"
      viewBox={`0 0 ${FLOOR_WIDTH} ${FLOOR_HEIGHT}`}
      role="img"
      aria-label="Schematic floor plan of the office"
      data-testid="floor-plan"
    >
      <defs>
        <pattern id="tm-blueprint" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" className="tm-blueprint-line" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={FLOOR_WIDTH} height={FLOOR_HEIGHT} fill="url(#tm-blueprint)" />

      {/* The building, then the two corridors that give the plan its shape. */}
      <rect x="40" y="40" width="920" height="540" className="tm-floor-building" />
      <line x1="45" y1="225" x2="694" y2="225" className="tm-floor-corridor" />
      <line x1="695" y1="45" x2="695" y2="575" className="tm-floor-corridor" />

      {SLOTS.map((slot) => {
        const zone = ZONES[slot];
        const room = bySlot.get(slot);
        // An empty zone still draws. The floor must not reshuffle because a
        // channel went quiet, so a slot with nothing in it says so instead.
        const alert = Boolean(room && alertRooms.has(room.key));
        const smoking = Boolean(room && vignettes?.has(room.key));
        return (
          <g
            key={slot}
            className={`tm-zone ${room ? '' : 'is-vacant'} ${selected && room && selected === slot ? 'is-selected' : ''}`}
            data-zone={slot}
            {...(room ? { 'data-room': room.key } : {})}
            data-alert={alert ? 'true' : 'false'}
            role={room ? 'button' : undefined}
            tabIndex={room ? 0 : undefined}
            aria-label={room ? room.label : undefined}
            onClick={room ? () => onSelect(slot) : undefined}
            onKeyDown={
              room
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(slot);
                    }
                  }
                : undefined
            }
          >
            <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} className="tm-zone-shell" />
            <text x={zone.x + PAD} y={zone.y + LABEL_BASELINE} className="tm-zone-label">
              {(room?.label ?? '').replace(/^#/, '').toUpperCase()}
            </text>
            {room && room.agents.length === 0 && (
              <text x={zone.x + zone.w / 2} y={zone.y + zone.h / 2 + 4} textAnchor="middle" className="tm-zone-empty">
                EMPTY
              </text>
            )}
            {room?.agents.map((a, i) => {
              const at = chipPosition(zone, i);
              return (
                <OccupantChip
                  key={a.name}
                  agent={a}
                  x={at.x}
                  y={at.y}
                  onSelect={() => onAgentSelect(a.name, room.key)}
                />
              );
            })}
            {smoking && <SmokeVignette x={zone.x + zone.w - 62} y={zone.y + zone.h - 30} />}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Smoke, rising from a room, for exactly as long as that room's bound signal is
 * live. The only animated thing on the floor, and it animates because something
 * is genuinely happening — not as decoration.
 *
 * The wisps carry a visible steady stroke at rest, so a single-frame capture
 * always shows real smoke rather than catching the cycle at zero opacity. Under
 * `prefers-reduced-motion: reduce` they stay PRESENT and stop moving: the smoke
 * is the information, the drift is only its presentation.
 */
export function SmokeVignette({ x, y }: { x: number; y: number }) {
  return (
    <g className="tm-vignette" data-vignette="smoke" transform={`translate(${x} ${y})`} aria-hidden="true">
      <rect x="0" y="0" width="38" height="26" className="tm-vignette-body" />
      <line x1="0" y1="13" x2="38" y2="13" className="tm-vignette-seam" />
      <rect x="14" y="-22" width="8" height="24" className="tm-vignette-stack" />
      <path className="tm-smoke-wisp" d="M16,-22 C12,-33 22,-41 17,-52 C13,-61 20,-68 16,-77" />
      <path className="tm-smoke-wisp" d="M20,-22 C25,-35 15,-43 21,-54 C26,-64 17,-72 22,-81" />
      <path className="tm-smoke-wisp" d="M14,-22 C11,-31 18,-38 14,-47" />
    </g>
  );
}
