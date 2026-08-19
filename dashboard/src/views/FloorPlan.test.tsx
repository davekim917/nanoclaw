import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FloorPlan, ZONES } from './FloorPlan.js';
import { RoomStrip } from './RoomStrip.js';
import { buildOfficeData, SLOTS } from './office-data.js';
import { sortRooms } from './Observatory.js';
import type { ObservatoryAgent, ObservatoryRoom } from '../lib/api.js';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');

function room(over: Partial<ObservatoryRoom> = {}): ObservatoryRoom {
  return { key: 'r1', name: 'one', platform: 'slack', memberAgentIds: [], lastActivityAt: null, permalink: null, ...over };
}
function agent(over: Partial<ObservatoryAgent> = {}): ObservatoryAgent {
  return {
    id: 'ag-1', name: 'Nova', canonicalName: 'group-one', folder: 'group-one', provider: 'claude',
    awake: true, active: true, location: 'r1', lastSeenAt: null, lastSessionId: null,
    holding: [], nextTask: null, avatarUrl: null, liveSession: null, ...over,
  };
}
/** n rooms named #room-1..#room-n, each seating its own agent. */
function floor(n: number) {
  const rooms = Array.from({ length: n }, (_, i) =>
    room({ key: `r${i + 1}`, name: `room-${i + 1}`, memberAgentIds: [`ag-${i + 1}`] }),
  );
  const agents = Array.from({ length: n }, (_, i) =>
    agent({ id: `ag-${i + 1}`, name: `Agent${i + 1}`, location: `r${i + 1}` }),
  );
  return { rooms, agents };
}

const noop = () => {};
const plan = (props: Partial<Parameters<typeof FloorPlan>[0]> = {}) => {
  const { rooms, agents } = floor(3);
  return render(
    <FloorPlan
      data={buildOfficeData(rooms, agents, [], {}, NOW)}
      selected=""
      onSelect={noop}
      onAgentSelect={noop}
      alertRooms={new Set()}
      {...props}
    />,
  );
};

afterEach(() => vi.clearAllMocks());

describe('FloorPlan', () => {
  it('draws every one of the eleven zones, empty ones included', () => {
    const { container } = plan();
    const drawn = Array.from(container.querySelectorAll('[data-zone]')).map((g) => g.getAttribute('data-zone'));
    expect(drawn).toEqual([...SLOTS]);
    expect(drawn).toHaveLength(11);
    // Eight of them have no room on a three-channel floor, and still render.
    expect(container.querySelectorAll('.tm-zone.is-vacant')).toHaveLength(8);
    expect(Object.keys(ZONES)).toHaveLength(11);
  });

  it('seats each occupant in its own room', () => {
    const { container } = plan();
    const first = container.querySelector('[data-zone="westFront"]')!;
    expect(first.getAttribute('data-room')).toBe('r1');
    expect(Array.from(first.querySelectorAll('[data-occupant]')).map((c) => c.getAttribute('data-occupant'))).toEqual([
      'Agent1',
    ]);
    expect(container.querySelector('[data-zone="eastFront"]')!.querySelector('[data-occupant="Agent2"]')).toBeTruthy();
  });

  it('keeps a room in the same zone however the snapshot orders its rooms', () => {
    const { rooms, agents } = floor(4);
    const zoneOf = (c: HTMLElement) =>
      Object.fromEntries(
        Array.from(c.querySelectorAll('[data-zone][data-room]')).map((g) => [
          g.getAttribute('data-room'),
          g.getAttribute('data-zone'),
        ]),
      );
    // The page always sorts before it seats (sortRooms: platform, then name),
    // and THAT is what makes a room findable twice — the plan is only as stable
    // as the order it is handed, so the guarantee is asserted end to end.
    const draw = (input: ObservatoryRoom[]) =>
      render(
        <FloorPlan
          data={buildOfficeData(sortRooms(input), agents, [], {}, NOW)}
          selected=""
          onSelect={noop}
          onAgentSelect={noop}
          alertRooms={new Set()}
        />,
      );

    const forward = draw(rooms);
    const before = zoneOf(forward.container);
    expect(Object.keys(before)).toHaveLength(4);
    forward.unmount();

    const shuffled = draw([rooms[2]!, rooms[0]!, rooms[3]!, rooms[1]!]);
    expect(zoneOf(shuffled.container)).toEqual(before);
    shuffled.unmount();

    const reversed = draw([...rooms].reverse());
    expect(zoneOf(reversed.container)).toEqual(before);
  });

  it('outlines a room the feed says something is wrong in, and stops when it clears', () => {
    const { rooms, agents } = floor(3);
    const data = buildOfficeData(rooms, agents, [], {}, NOW);
    const alerted = render(
      <FloorPlan data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set(['r2'])} />,
    );
    expect(alerted.container.querySelector('[data-room="r2"]')!.getAttribute('data-alert')).toBe('true');
    expect(alerted.container.querySelector('[data-room="r1"]')!.getAttribute('data-alert')).toBe('false');
    alerted.unmount();

    const cleared = render(
      <FloorPlan data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} />,
    );
    expect(cleared.container.querySelector('[data-room="r2"]')!.getAttribute('data-alert')).toBe('false');
  });

  it('draws smoke only in a room whose signal is live, and ignores a key no room has', () => {
    const { rooms, agents } = floor(3);
    const data = buildOfficeData(rooms, agents, [], {}, NOW);
    const live = render(
      <FloorPlan data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} vignettes={new Set(['r2'])} />,
    );
    expect(live.container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(1);
    expect(live.container.querySelector('[data-room="r2"] [data-vignette="smoke"]')).toBeTruthy();
    live.unmount();

    const unknown = render(
      <FloorPlan data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} vignettes={new Set(['not-a-room'])} />,
    );
    expect(unknown.container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(0);
  });

  it('picks a room by its zone and a person without also picking the room', async () => {
    const onSelect = vi.fn();
    const onAgentSelect = vi.fn();
    const { container } = plan({ onSelect, onAgentSelect });

    await userEvent.click(container.querySelector('[data-zone="eastFront"]')!);
    expect(onSelect).toHaveBeenCalledWith('eastFront');

    onSelect.mockClear();
    await userEvent.click(container.querySelector('[data-occupant="Agent1"]')!);
    expect(onAgentSelect).toHaveBeenCalledWith('Agent1', 'r1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says a room is empty rather than drawing nothing at all', () => {
    const { container } = render(
      <FloorPlan
        data={buildOfficeData([room({ key: 'r1', name: 'quiet' })], [], [], {}, NOW)}
        selected=""
        onSelect={noop}
        onAgentSelect={noop}
        alertRooms={new Set()}
      />,
    );
    const zone = container.querySelector('[data-room="r1"]')!;
    expect(zone.querySelector('.tm-zone-empty')!.textContent).toBe('EMPTY');
    expect(zone.querySelector('.tm-zone-label')!.textContent).toBe('QUIET');
  });

  it('uses the real avatar as an inline image, and the neutral mark when there is none', () => {
    const rooms = [room({ key: 'r1', name: 'one', memberAgentIds: ['a', 'b'] })];
    const agents = [
      agent({ id: 'a', name: 'Withface', location: 'r1', avatarUrl: 'https://example.invalid/x_72.png' }),
      agent({ id: 'b', name: 'Noface', location: 'r1', avatarUrl: null }),
    ];
    const { container } = render(
      <FloorPlan data={buildOfficeData(rooms, agents, [], {}, NOW)} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} />,
    );
    expect(container.querySelector('[data-occupant="Withface"] image')!.getAttribute('href')).toBe(
      'https://example.invalid/x_48.png',
    );
    expect(container.querySelector('[data-occupant="Noface"] image')).toBeNull();
    expect(container.querySelector('[data-occupant="Noface"] .tm-zone-chip-initial')!.textContent).toBe('N');
  });
});

describe('RoomStrip', () => {
  it('carries every room, including the ones the plan has no zone for', () => {
    const { rooms, agents } = floor(13);
    const data = buildOfficeData(rooms, agents, [], {}, NOW);
    expect(data.rooms).toHaveLength(11);
    expect(data.overflowRooms).toHaveLength(2);

    const { container } = render(
      <RoomStrip data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} />,
    );
    expect(container.querySelectorAll('.tm-room')).toHaveLength(13);
    expect(container.querySelector('[data-room="r13"]')).toBeTruthy();
    expect(container.querySelector('[data-room="r13"] [data-occupant="Agent13"]')).toBeTruthy();
  });

  it('marks the rooms the feed flagged, and says when a room is empty', () => {
    const data = buildOfficeData([room({ key: 'r1', name: 'one' }), room({ key: 'r2', name: 'two' })], [], [], {}, NOW);
    const { container } = render(
      <RoomStrip data={data} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set(['r2'])} />,
    );
    expect(container.querySelector('[data-room="r2"]')!.getAttribute('data-alert')).toBe('true');
    expect(container.querySelector('[data-room="r1"]')!.getAttribute('data-alert')).toBe('false');
    expect(container.querySelector('[data-room="r1"] .tm-room-empty')!.textContent).toBe('Empty');
  });

  it('picks a person without picking the room out from under them', async () => {
    const onSelect = vi.fn();
    const onAgentSelect = vi.fn();
    const { rooms, agents } = floor(2);
    const { container } = render(
      <RoomStrip
        data={buildOfficeData(rooms, agents, [], {}, NOW)}
        selected=""
        onSelect={onSelect}
        onAgentSelect={onAgentSelect}
        alertRooms={new Set()}
      />,
    );
    await userEvent.click(container.querySelector('[data-room="r2"] [data-occupant="Agent2"]')!);
    expect(onAgentSelect).toHaveBeenCalledWith('Agent2', 'r2');
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('[data-room="r2"]')!);
    // Slotted rooms are picked by their SLOT, the same key the page filters on.
    expect(onSelect).toHaveBeenCalledWith('eastFront');
  });

  it('picks an overflow room by its own key, since it has no slot', async () => {
    const onSelect = vi.fn();
    const { rooms, agents } = floor(12);
    const { container } = render(
      <RoomStrip
        data={buildOfficeData(rooms, agents, [], {}, NOW)}
        selected=""
        onSelect={onSelect}
        onAgentSelect={noop}
        alertRooms={new Set()}
      />,
    );
    await userEvent.click(container.querySelector('[data-room="r12"]')!);
    expect(onSelect).toHaveBeenCalledWith('r12');
  });

  it('gives every occupant chip a 44px hit floor', () => {
    const { rooms, agents } = floor(2);
    const { container } = render(
      <RoomStrip data={buildOfficeData(rooms, agents, [], {}, NOW)} selected="" onSelect={noop} onAgentSelect={noop} alertRooms={new Set()} />,
    );
    const chips = Array.from(container.querySelectorAll('.tm-room-occupant'));
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip.className).toContain('tm-tap');
  });
});

describe('the vignette, under reduced motion', () => {
  /**
   * R6's rule, and the one thing about this component that is easy to get
   * backwards: the smoke is INFORMATION and the drift is only its
   * presentation. Under `reduce` the wisps must stay exactly where they are —
   * removing them would delete a fact from the screen to honour a preference
   * about movement.
   *
   * jsdom applies no stylesheet, so the media query itself cannot be asserted
   * here; what is asserted is that the component takes no part in the decision
   * (it renders the same DOM either way), which is what makes the CSS the
   * single place the rule lives. The resolved `animation-name: none` is
   * measured for real in the browser gate.
   */
  const withMotionPreference = (reduce: boolean) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  };

  const draw = (vignettes: Set<string>) => {
    const { rooms, agents } = floor(3);
    return render(
      <FloorPlan
        data={buildOfficeData(rooms, agents, [], {}, NOW)}
        selected=""
        onSelect={noop}
        onAgentSelect={noop}
        alertRooms={new Set()}
        vignettes={vignettes}
      />,
    );
  };

  afterEach(() => vi.unstubAllGlobals());

  it('keeps an ACTIVE vignette present, with all three wisps, when motion is reduced', () => {
    withMotionPreference(true);
    const { container } = draw(new Set(['r2']));
    const vignette = container.querySelector('[data-room="r2"] [data-vignette="smoke"]')!;
    expect(vignette).toBeTruthy();
    expect(vignette.querySelectorAll('.tm-smoke-wisp')).toHaveLength(3);
    // No JS-side motion gate: the wisps carry exactly the class the stylesheet
    // keys its `prefers-reduced-motion: no-preference` animation off, so the
    // preference is honoured in CSS and nowhere else.
    expect(container.querySelector('.tm-smoke-wisp')!.getAttribute('class')).toBe('tm-smoke-wisp');
  });

  it('draws nothing at all in an INACTIVE room, reduced motion or not', () => {
    for (const reduce of [true, false]) {
      withMotionPreference(reduce);
      const { container, unmount } = draw(new Set());
      expect(container.querySelectorAll('[data-vignette="smoke"]')).toHaveLength(0);
      expect(container.querySelectorAll('.tm-smoke-wisp')).toHaveLength(0);
      unmount();
    }
  });
});
