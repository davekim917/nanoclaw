/**
 * Office sprites — hand-authored pixel art as inline SVG data URIs.
 *
 * Every sprite is a tiny integer grid drawn with `shape-rendering="crispEdges"`
 * and rendered with `image-rendering: pixelated` at 3-4x, so the browser's
 * nearest-neighbour upscale IS the pixel-art filter. No images, no fonts, no
 * canvas, no dependencies — a few hundred bytes each.
 *
 * Light source is top-left throughout: highlight on the top row, shadow on the
 * bottom. Palette matches the --of-* vars in styles.css.
 */

const svg = (w: number, h: number, body: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" shape-rendering="crispEdges">${body}</svg>`,
  );

/** Desk seen from the front: monitor lit, keyboard, two legs. */
export const DESK_ON = svg(
  16,
  12,
  '<rect x="5" y="0" width="6" height="5" fill="#2b2b33"/>' +
    '<rect x="6" y="1" width="4" height="3" fill="#6fd3ff"/>' +
    '<rect x="6" y="1" width="4" height="1" fill="#a8e6ff"/>' +
    '<rect x="7" y="5" width="2" height="1" fill="#4a5568"/>' +
    '<rect x="1" y="6" width="14" height="4" fill="#a9743f"/>' +
    '<rect x="1" y="6" width="14" height="1" fill="#c99a5f"/>' +
    '<rect x="4" y="8" width="6" height="1" fill="#8a5f33"/>' +
    '<rect x="2" y="10" width="2" height="2" fill="#6b5335"/>' +
    '<rect x="12" y="10" width="2" height="2" fill="#6b5335"/>',
);

/** Same desk, screen dark — nobody sitting here. */
export const DESK_OFF = svg(
  16,
  12,
  '<rect x="5" y="0" width="6" height="5" fill="#2b2b33"/>' +
    '<rect x="6" y="1" width="4" height="3" fill="#4a5568"/>' +
    '<rect x="7" y="5" width="2" height="1" fill="#3a4250"/>' +
    '<rect x="1" y="6" width="14" height="4" fill="#96683a"/>' +
    '<rect x="1" y="6" width="14" height="1" fill="#b08a54"/>' +
    '<rect x="4" y="8" width="6" height="1" fill="#7d5530"/>' +
    '<rect x="2" y="10" width="2" height="2" fill="#5c4830"/>' +
    '<rect x="12" y="10" width="2" height="2" fill="#5c4830"/>',
);

/** Potted plant. */
export const PLANT = svg(
  12,
  16,
  '<rect x="5" y="2" width="2" height="9" fill="#3a6330"/>' +
    '<rect x="4" y="0" width="4" height="2" fill="#6aa35a"/>' +
    '<rect x="2" y="2" width="3" height="2" fill="#4a7c3f"/>' +
    '<rect x="7" y="2" width="3" height="2" fill="#4a7c3f"/>' +
    '<rect x="1" y="4" width="4" height="2" fill="#4a7c3f"/>' +
    '<rect x="7" y="4" width="4" height="2" fill="#3a6330"/>' +
    '<rect x="2" y="6" width="3" height="2" fill="#3a6330"/>' +
    '<rect x="7" y="6" width="3" height="2" fill="#4a7c3f"/>' +
    '<rect x="3" y="8" width="6" height="2" fill="#3a6330"/>' +
    '<rect x="3" y="11" width="6" height="1" fill="#a8703f"/>' +
    '<rect x="3" y="12" width="6" height="4" fill="#8a5a34"/>' +
    '<rect x="4" y="15" width="4" height="1" fill="#6b4526"/>',
);

/** Wall whiteboard with a marker tray. */
export const WHITEBOARD = svg(
  16,
  12,
  '<rect x="0" y="0" width="16" height="10" fill="#6b5335"/>' +
    '<rect x="1" y="1" width="14" height="8" fill="#f5f2e8"/>' +
    '<rect x="1" y="1" width="14" height="1" fill="#ffffff"/>' +
    '<rect x="3" y="3" width="8" height="1" fill="#4a90c2"/>' +
    '<rect x="3" y="5" width="6" height="1" fill="#c8503c"/>' +
    '<rect x="3" y="7" width="9" height="1" fill="#6b5f4a"/>' +
    '<rect x="0" y="10" width="16" height="2" fill="#8b6f47"/>' +
    '<rect x="0" y="10" width="16" height="1" fill="#a68a5f"/>',
);

/** Two-cushion couch. */
export const COUCH = svg(
  16,
  10,
  '<rect x="0" y="1" width="16" height="3" fill="#9a6b52"/>' +
    '<rect x="0" y="1" width="16" height="1" fill="#b8825f"/>' +
    '<rect x="0" y="4" width="2" height="4" fill="#9a6b52"/>' +
    '<rect x="14" y="4" width="2" height="4" fill="#9a6b52"/>' +
    '<rect x="2" y="4" width="12" height="4" fill="#b8825f"/>' +
    '<rect x="8" y="4" width="1" height="4" fill="#8a5a44"/>' +
    '<rect x="2" y="7" width="12" height="1" fill="#7d543f"/>' +
    '<rect x="1" y="8" width="2" height="2" fill="#6b5335"/>' +
    '<rect x="13" y="8" width="2" height="2" fill="#6b5335"/>',
);

/** Water cooler. */
export const COOLER = svg(
  10,
  16,
  '<rect x="2" y="0" width="6" height="6" fill="#7ec8e8"/>' +
    '<rect x="2" y="0" width="6" height="1" fill="#a8e6ff"/>' +
    '<rect x="3" y="6" width="4" height="1" fill="#cfd6de"/>' +
    '<rect x="1" y="7" width="8" height="8" fill="#e8eaee"/>' +
    '<rect x="1" y="7" width="8" height="1" fill="#ffffff"/>' +
    '<rect x="3" y="10" width="4" height="2" fill="#4a5568"/>' +
    '<rect x="1" y="15" width="8" height="1" fill="#9aa2ae"/>',
);

/** Corner cobweb — spokes plus two arcs, anchored at the top-left. */
export const COBWEB = svg(
  12,
  12,
  '<g fill="#efe9dc">' +
    '<rect x="0" y="0" width="11" height="1"/>' +
    '<rect x="0" y="0" width="1" height="11"/>' +
    '<rect x="1" y="1" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/>' +
    '<rect x="3" y="3" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/>' +
    '<rect x="5" y="5" width="1" height="1"/><rect x="6" y="6" width="1" height="1"/>' +
    '<rect x="7" y="7" width="1" height="1"/>' +
    '<rect x="4" y="1" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/>' +
    '<rect x="2" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/>' +
    '<rect x="9" y="2" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/>' +
    '<rect x="4" y="8" width="1" height="1"/><rect x="2" y="9" width="1" height="1"/>' +
    '</g>',
);

/** Stand-in bust for an agent with no avatar URL — initials go over it. */
export const BLANK_AVATAR = svg(
  12,
  12,
  '<rect x="0" y="0" width="12" height="12" fill="#d9c9a8"/>' +
    '<rect x="4" y="2" width="4" height="4" fill="#a68a5f"/>' +
    '<rect x="4" y="2" width="4" height="1" fill="#c0a377"/>' +
    '<rect x="3" y="7" width="6" height="5" fill="#8b6f47"/>' +
    '<rect x="3" y="7" width="6" height="1" fill="#a68a5f"/>',
);

/* ─── Deterministic room decoration ──────────────────────────────────────── */

export interface Decor {
  name: string;
  src: string;
  /** Sprite aspect, so CSS can size without a layout shift. */
  w: number;
  h: number;
}

const DECOR_SET: Decor[] = [
  { name: 'plant', src: PLANT, w: 12, h: 16 },
  { name: 'whiteboard', src: WHITEBOARD, w: 16, h: 12 },
  { name: 'couch', src: COUCH, w: 16, h: 10 },
  { name: 'cooler', src: COOLER, w: 10, h: 16 },
];

/** FNV-1a — stable across renders and reloads, which is the whole point. */
export function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 1-2 pieces of furniture for a room, derived from its key alone — a room
 * always looks the same, so the floor stays a place you can remember.
 */
export function roomDecor(key: string): Decor[] {
  const h = hashKey(key);
  const first = DECOR_SET[h % DECOR_SET.length]!;
  if (((h >>> 8) & 1) === 0) return [first];
  const offset = 1 + ((h >>> 16) % (DECOR_SET.length - 1));
  return [first, DECOR_SET[(h % DECOR_SET.length + offset) % DECOR_SET.length]!];
}
