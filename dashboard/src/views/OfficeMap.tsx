import { useEffect, useRef } from 'react';
import './office-map.js';
import type { OfficeData } from './office-data.js';

/**
 * React wrapper for the `<office-map>` custom element.
 *
 * The element owns its own pan, zoom, teleport and shadow DOM; React's only
 * jobs are to hand it structured data (as a PROPERTY, so nothing is serialised
 * through an attribute) and to translate its `room-select` event back out.
 */
/* React 19 resolves intrinsic elements through the `React.JSX` namespace, so a
 * custom element is declared by augmenting the react module, not the global. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'office-map': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        plan?: string;
        scale?: string;
        labels?: string;
        agents?: string;
        selected?: string;
        start?: string;
      };
    }
  }
}

interface OfficeMapElement extends HTMLElement {
  data?: OfficeData;
  teleport(key: string): void;
}

export function OfficeMap({
  data,
  selected,
  onSelect,
  onAgentSelect,
  onScaleChange,
  start,
  scale = '1.15',
  labels = 'sign',
  agents = 'bubble',
  teleportTo,
}: {
  data: OfficeData;
  selected: string;
  onSelect: (key: string) => void;
  /** A seated agent was clicked. `room` is the slot key the pin belongs to. */
  onAgentSelect?: (detail: { name: string; room: string }) => void;
  /** ctrl/cmd+wheel on the viewport asked for a new zoom level. `scale` is a
      controlled prop, so the element can't just apply it — it asks up here,
      the same way room-select and agent-select do. */
  onScaleChange?: (scale: number) => void;
  /** Slot to centre on when the map first appears. Without it the viewport
      opens at the plan's top-left corner, which on a phone is all lawn. */
  start?: string;
  scale?: string;
  labels?: string;
  agents?: string;
  /** Slot key to centre the viewport on. Changing it re-centres. */
  teleportTo?: string | null;
}) {
  const ref = useRef<OfficeMapElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.data = data;
  }, [data]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const key = (e as CustomEvent<{ key: string }>).detail?.key;
      if (key) onSelect(key);
    };
    el.addEventListener('room-select', handler);
    return () => el.removeEventListener('room-select', handler);
  }, [onSelect]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onAgentSelect) return;
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; room: string }>).detail;
      if (d?.name && d.room) onAgentSelect(d);
    };
    el.addEventListener('agent-select', handler);
    return () => el.removeEventListener('agent-select', handler);
  }, [onAgentSelect]);

  useEffect(() => {
    if (teleportTo && ref.current?.teleport) ref.current.teleport(teleportTo);
  }, [teleportTo]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onScaleChange) return;
    const handler = (e: Event) => {
      const s = (e as CustomEvent<{ scale: number }>).detail?.scale;
      if (typeof s === 'number') onScaleChange(s);
    };
    el.addEventListener('scale-change', handler);
    return () => el.removeEventListener('scale-change', handler);
  }, [onScaleChange]);

  return (
    <office-map
      ref={ref as React.Ref<HTMLElement>}
      plan="house"
      scale={scale}
      labels={labels}
      agents={agents}
      selected={selected}
      {...(start ? { start } : {})}
    />
  );
}
