/* office-map — dense top-down office, Gather-grade tileset.
 * One crisp-edge SVG for the world + an HTML layer for agents and labels
 * (so characters can move and text stays modern-UI crisp at any zoom).
 *
 * VENDORED from the Claude Design project "The Observatory"
 * (931bb635-7991-484e-bf13-9b52848f0255, file `office-map.js`).
 *
 * Local changes are confined to the DATA seam, marked `nanoclaw:` below —
 * the tileset, sprites, plans and rendering are upstream's and should stay
 * byte-identical so a refreshed export can be dropped back in. The room
 * GEOMETRY (grids, plans, placement) is hand-authored and stays fixed; only
 * the label, open count, state and occupants are supplied by live data.
 */
(function () {
  const T = 16; // art px per tile

  const P = {
    grass: '#a8c47f', grass2: '#9dba73', grass3: '#b5cf8c',
    brick: '#efdcbd', brickLine: '#e0c9a3', brickEdge: '#d8bd93',
    parquet: '#e6c89c', parquetSeam: '#d5b183', parquetDk: '#cfa876',
    tileF: '#e7eaeb', tileGrout: '#d3d9db',
    carpet: '#b8bdc5', carpetDot: '#aeb4bd',
    concrete: '#c9c6bf', concreteDk: '#bdb9b1',
    wallCap: '#efece4', wallSh: '#c9c3b6',
    deskTop: '#f4f2ec', deskHi: '#fbfaf6', deskEdge: '#dcd7cb', deskLeg: '#b6afa1',
    mon: '#3b414a', monHi: '#525a64', screen: '#6fb2d6', screenDk: '#46596b',
    chair: '#565d66', chairHi: '#6b727c', chairDk: '#3f454d',
    wood: '#8a5f3c', woodHi: '#a3764c', woodDk: '#6d4a2e',
    couch: '#e0b28e', couchHi: '#eec5a4', couchDk: '#c0906c',
    leafA: '#4f8b46', leafB: '#68a85a', leafC: '#3f7038', pot: '#454b53', potHi: '#585f68',
    white: '#fbfaf6', paper: '#f2efe6',
    box: '#d3a96e', boxHi: '#e3bd83', boxDk: '#b0874f',
    water: '#7fbcd8', water2: '#9ed2e8', water3: '#68a6c4',
    glass: '#bcd9e6', glassHi: '#d8ecf3',
    steel: '#c3c8ce', steelDk: '#a8aeb5',
  };
  const STATUS = { blocked: '#c1554a', waiting: '#c08a2e', working: '#4a7c59', idle: '#8f8b82' };

  const r = (x, y, w, h, f) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
  function hash(a, b, s) {
    let h = 2166136261 ^ (s || 0);
    h = Math.imul(h ^ a, 16777619); h = Math.imul(h ^ b, 16777619); h = Math.imul(h ^ (a + b), 16777619);
    return (h >>> 0) / 4294967296;
  }

  /* ── floors ─────────────────────────────────────────────────────────── */
  function floorFill(kind, x, y, w, h) {
    const X = x * T, Y = y * T, W = w * T, H = h * T;
    let s = '';
    if (kind === 'wood') {
      s += r(X, Y, W, H, P.parquet);
      for (let j = 0; j < H; j += 8) {
        s += r(X, Y + j, W, 1, P.parquetSeam);
        for (let i = (j / 8) % 2 ? 24 : 0; i < W; i += 48) s += r(X + i, Y + j, 1, 8, P.parquetSeam);
        for (let i = (j / 8) % 2 ? 8 : 32; i < W; i += 96) s += r(X + i, Y + j + 1, 22, 7, P.parquetDk);
      }
    } else if (kind === 'tile') {
      s += r(X, Y, W, H, P.tileF);
      for (let i = 0; i <= W; i += 16) s += r(X + i, Y, 1, H, P.tileGrout);
      for (let j = 0; j <= H; j += 16) s += r(X, Y + j, W, 1, P.tileGrout);
      for (let j = 0; j < H; j += 32) for (let i = 0; i < W; i += 32) s += r(X + i + 6, Y + j + 6, 4, 4, '#dbe2e4');
    } else if (kind === 'carpet') {
      s += r(X, Y, W, H, P.carpet);
      for (let j = 0; j < H; j += 3) for (let i = ((j / 3) % 2 ? 2 : 0); i < W; i += 4) s += r(X + i, Y + j, 1, 1, P.carpetDot);
    } else if (kind === 'brick') {
      s += r(X, Y, W, H, P.brick);
      for (let j = 0; j < H; j += 8) {
        s += r(X, Y + j, W, 1, P.brickLine);
        for (let i = (j / 8) % 2 ? 16 : 0; i < W; i += 32) s += r(X + i, Y + j, 1, 8, P.brickLine);
      }
    } else {
      s += r(X, Y, W, H, P.concrete);
      for (let i = 0; i < W; i += 48) s += r(X + i, Y, 1, H, P.concreteDk);
      for (let i = 0; i < 40; i++) s += r(X + Math.floor(hash(i, x + y, 7) * (W - 4)), Y + Math.floor(hash(i, x - y, 11) * (H - 3)), 3, 1, P.concreteDk);
    }
    return s;
  }

  function rugFill(x, y, w, h, base, accent) {
    const X = x * T, Y = y * T, W = w * T, H = h * T;
    let s = r(X, Y, W, H, base);
    for (let i = 4; i < W - 4; i += 10) s += r(X + i, Y + 4, 5, H - 8, accent);
    s += r(X, Y, W, 3, accent) + r(X, Y + H - 3, W, 3, accent) + r(X, Y, 3, H, accent) + r(X + W - 3, Y, 3, H, accent);
    s += r(X + 4, Y + 4, W - 8, 1, base) + r(X + 4, Y + H - 5, W - 8, 1, base);
    return s;
  }

  /* ── objects (origin = tile top-left) ───────────────────────────────── */
  function sprite(ch, X, Y, L, R, seed) {
    const capL = L !== ch, capR = R !== ch, k = hash(X, Y, seed);
    switch (ch) {
      case 'T': { // desk run: surface, monitor at back, keyboard, props
        let s = r(X, Y + 3, 16, 11, P.deskTop) + r(X, Y + 3, 16, 2, P.deskHi) + r(X, Y + 13, 16, 1, P.deskEdge);
        if (capL) s += r(X, Y + 3, 1, 11, P.deskEdge) + r(X + 1, Y + 14, 2, 2, P.deskLeg);
        if (capR) s += r(X + 15, Y + 3, 1, 11, P.deskEdge) + r(X + 13, Y + 14, 2, 2, P.deskLeg);
        s += r(X + 3, Y, 10, 6, P.mon) + r(X + 3, Y, 10, 1, P.monHi) + r(X + 4, Y + 1, 8, 4, k > 0.5 ? P.screen : P.screenDk);
        if (k > 0.5) { s += r(X + 5, Y + 2, 4, 1, '#cbe8f5') + r(X + 5, Y + 3, 6, 1, '#a8d6ec'); }
        s += r(X + 7, Y + 6, 2, 1, P.monHi) + r(X + 6, Y + 7, 4, 1, P.mon);
        s += r(X + 4, Y + 9, 8, 3, '#d8dade') + r(X + 4, Y + 9, 8, 1, '#e8eaed');
        s += r(X + 13, Y + 10, 2, 2, '#c8ccd1');
        if (k > 0.72) s += r(X + 1, Y + 8, 3, 3, '#c8624f') + r(X + 4, Y + 9, 1, 1, '#c8624f');
        else if (k > 0.45) s += r(X + 1, Y + 8, 3, 4, P.paper) + r(X + 1, Y + 9, 3, 1, '#cfcabb');
        return s;
      }
      case 'c': { // empty swivel chair
        return r(X + 3, Y + 2, 10, 4, P.chairDk) + r(X + 3, Y + 2, 10, 1, P.chairHi) +
          r(X + 2, Y + 6, 12, 6, P.chair) + r(X + 2, Y + 6, 12, 1, P.chairHi) + r(X + 2, Y + 11, 12, 1, P.chairDk) +
          r(X + 7, Y + 12, 2, 2, P.chairDk) + r(X + 4, Y + 13, 8, 1, P.chairDk) + r(X + 3, Y + 14, 2, 1, P.chairDk) + r(X + 11, Y + 14, 2, 1, P.chairDk);
      }
      case 'b': { // bookshelf against a top wall
        let s = r(X, Y, 16, 12, P.wood) + r(X, Y, 16, 2, P.woodHi) + r(X, Y + 11, 16, 1, P.woodDk) + r(X + 1, Y + 2, 14, 4, '#5c3f27') + r(X + 1, Y + 7, 14, 4, '#5c3f27');
        const books = ['#c05a4a', '#d69a3c', '#5b86ad', '#6f9c5a', '#9a6aa0', '#d9c98f'];
        for (let row = 0; row < 2; row++) for (let i = 0; i < 6; i++) {
          const bw = 2 + Math.floor(hash(X + i, Y + row, seed) * 2);
          s += r(X + 1 + i * 2.4, Y + 2 + row * 5 + (row ? 0 : 0), bw, 4, books[Math.floor(hash(X + i * 3, Y + row * 7, seed) * books.length)]);
        }
        return s;
      }
      case 'B': { // bookshelf against a side wall
        let s = r(X + 2, Y, 12, 16, P.wood) + r(X + 2, Y, 12, 2, P.woodHi) + r(X + 2, Y + 15, 12, 1, P.woodDk);
        s += r(X + 4, Y + 2, 9, 13, '#5c3f27') + r(X + 4, Y + 8, 9, 1, P.woodHi);
        const books = ['#c05a4a', '#d69a3c', '#5b86ad', '#6f9c5a', '#9a6aa0', '#d9c98f'];
        for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
          const bw = 1 + Math.floor(hash(X + i * 5, Y + row * 3, seed) * 2);
          s += r(X + 4 + i * 2.2, Y + 2 + row * 7, bw, 6, books[Math.floor(hash(X + i, Y + row * 9, seed) * books.length)]);
        }
        return s;
      }
      case 'w': // whiteboard
        return r(X, Y, 16, 10, '#cfc9ba') + r(X + 1, Y + 1, 14, 7, P.white) + r(X + 2, Y + 2, 7, 1, '#5b86ad') + r(X + 2, Y + 4, 9, 1, '#c8624f') + r(X + 2, Y + 6, 5, 1, '#7d8a76') + r(X + 11, Y + 3, 3, 3, '#d69a3c') + r(X, Y + 9, 16, 2, '#b9b2a2');
      case 'W': // side-wall whiteboard
        return r(X + 2, Y, 10, 16, '#cfc9ba') + r(X + 3, Y + 1, 8, 14, P.white) + r(X + 4, Y + 2, 1, 7, '#5b86ad') + r(X + 6, Y + 3, 1, 9, '#c8624f') + r(X + 8, Y + 2, 1, 5, '#7d8a76');
      case 'O': { // couch, side wall (back on the left, arms top and bottom)
        let s = r(X + 1, Y + 1, 5, 14, P.couchDk) + r(X + 1, Y + 1, 5, 1, P.couchHi);
        s += r(X + 6, Y + 1, 9, 3, P.couchDk) + r(X + 6, Y + 12, 9, 3, P.couchDk);
        s += r(X + 6, Y + 4, 9, 8, P.couch) + r(X + 6, Y + 4, 9, 1, P.couchHi) + r(X + 6, Y + 8, 9, 1, P.couchDk);
        s += r(X + 8, Y + 5, 5, 3, '#c9756a') + r(X + 1, Y + 15, 14, 1, '#a67d5c');
        return s;
      }
      case 'o': { // couch, top wall (back at the top, arms left and right)
        let s = r(X + 1, Y + 1, 14, 5, P.couchDk) + r(X + 1, Y + 1, 14, 1, P.couchHi);
        s += r(X + 1, Y + 6, 3, 9, P.couchDk) + r(X + 12, Y + 6, 3, 9, P.couchDk);
        s += r(X + 4, Y + 6, 8, 9, P.couch) + r(X + 4, Y + 6, 8, 1, P.couchHi) + r(X + 8, Y + 6, 1, 9, P.couchDk);
        s += r(X + 5, Y + 8, 3, 4, '#c9756a') + r(X + 1, Y + 15, 14, 1, '#a67d5c');
        return s;
      }
      case 'p': { // leafy plant in a dark pot
        let s = r(X + 5, Y + 10, 6, 5, P.pot) + r(X + 5, Y + 10, 6, 1, P.potHi) + r(X + 6, Y + 15, 4, 1, '#33383f');
        s += r(X + 6, Y + 6, 4, 5, P.leafC);
        s += r(X + 2, Y + 4, 5, 3, P.leafA) + r(X + 9, Y + 4, 5, 3, P.leafA) + r(X + 1, Y + 7, 5, 2, P.leafC) + r(X + 10, Y + 7, 5, 2, P.leafC);
        s += r(X + 5, Y + 1, 6, 4, P.leafB) + r(X + 4, Y + 2, 2, 3, P.leafA) + r(X + 10, Y + 2, 2, 3, P.leafA) + r(X + 6, Y, 4, 2, P.leafB);
        return s;
      }
      case 'x': { // stacked boxes
        let s = r(X + 1, Y + 5, 14, 10, P.box) + r(X + 1, Y + 5, 14, 2, P.boxHi) + r(X + 7, Y + 5, 2, 10, P.boxDk) + r(X + 1, Y + 14, 14, 1, P.boxDk);
        if (k > 0.45) s += r(X + 3, Y, 10, 6, P.box) + r(X + 3, Y, 10, 1, P.boxHi) + r(X + 3, Y + 5, 10, 1, P.boxDk) + r(X + 7, Y, 2, 6, P.boxDk);
        return s;
      }
      case 'k': { // counter run
        let s = r(X, Y + 2, 16, 12, '#e9e6de') + r(X, Y + 2, 16, 3, '#f4f2ec') + r(X, Y + 12, 16, 2, '#c9c4b8');
        s += r(X, Y + 6, 16, 1, '#d6d1c5');
        if (capL) s += r(X, Y + 2, 1, 12, '#c9c4b8');
        if (capR) s += r(X + 15, Y + 2, 1, 12, '#c9c4b8');
        if (k > 0.6) s += r(X + 4, Y + 7, 6, 4, '#b98a5f') + r(X + 4, Y + 7, 6, 1, '#cfa073');
        return s;
      }
      case 's': return sprite('k', X, Y, 'k', 'k', seed) + r(X + 3, Y + 4, 10, 8, P.steel) + r(X + 4, Y + 5, 8, 6, '#9aa1a8') + r(X + 7, Y + 2, 2, 4, P.steelDk);
      case 'f': return r(X + 1, Y, 14, 16, P.steel) + r(X + 1, Y, 14, 2, '#d6dade') + r(X + 1, Y + 7, 14, 1, P.steelDk) + r(X + 11, Y + 3, 2, 3, P.steelDk) + r(X + 11, Y + 9, 2, 3, P.steelDk) + r(X + 1, Y + 15, 14, 1, '#9aa1a8');
      case 'e': // wall display
        return r(X, Y, 16, 10, '#3b414a') + r(X + 1, Y + 1, 14, 7, '#4d6478') + r(X + 2, Y + 2, 6, 2, '#7fb2cf') + r(X + 2, Y + 5, 9, 1, '#6a90a8') + r(X + 6, Y + 10, 4, 2, '#2f343b');
      case 'L': return r(X + 6, Y + 5, 3, 9, '#c9c2b2') + r(X + 4, Y + 1, 8, 5, '#f0e6cb') + r(X + 4, Y + 1, 8, 1, '#fbf6e6') + r(X + 5, Y + 14, 5, 2, '#a89f8c');
      case 'g': // workbench with tools
        return sprite('T', X, Y, 'T', 'T', seed).replace(P.screen, P.screenDk) + r(X + 1, Y + 1, 4, 2, '#9a6a4a') + r(X + 12, Y + 1, 3, 2, '#5b86ad');
      case 'K': // bike
        return r(X + 1, Y + 6, 14, 2, '#6a7079') + r(X + 2, Y + 3, 2, 9, '#3f454c') + r(X + 12, Y + 3, 2, 9, '#3f454c') + r(X + 6, Y + 3, 5, 2, '#a3564a') + r(X + 7, Y + 8, 3, 2, '#4a5058');
      case 'C': { // cobweb
        let s = r(X, Y, 13, 1, '#e8e3d6') + r(X, Y, 1, 13, '#e8e3d6');
        for (let i = 1; i < 12; i++) s += r(X + i, Y + i, 1, 1, '#e8e3d6');
        s += r(X + 6, Y + 2, 1, 1, '#ded8c8') + r(X + 2, Y + 6, 1, 1, '#ded8c8') + r(X + 9, Y + 4, 1, 1, '#ded8c8') + r(X + 4, Y + 9, 1, 1, '#ded8c8');
        return s;
      }
      case 'd': { let s = ''; for (let i = 0; i < 9; i++) s += r(X + Math.floor(hash(X + i, Y, 3) * 13), Y + Math.floor(hash(X, Y + i, 6) * 13), 3, 2, '#b6b1a6'); return s; }
      case 'S': // dust-sheeted furniture
        return r(X, Y + 2, 16, 12, '#ded9cb') + r(X, Y + 2, 16, 2, '#ece8dc') + r(X, Y + 13, 16, 1, '#c4bead') + r(X + 3, Y + 14, 2, 2, '#b8b2a0') + r(X + 11, Y + 14, 2, 2, '#b8b2a0');
      default: return '';
    }
  }

  /* ── agents (own SVG so the HTML layer can animate them) ────────────── */
  function agentSvg(a) {
    const sk = a.skin || '#e4b98f', skDk = a.skinDk || '#c99a72';
    let s = '';
    s += `<ellipse cx="10" cy="21" rx="6" ry="2" fill="#000" opacity="0.13"/>`;
    s += r(4, 15, 12, 5, P.chairDk) + r(4, 15, 12, 1, P.chairHi); // chair back behind
    s += r(6, 16, 8, 4, a.pants || '#4a5058');
    s += r(5, 8, 10, 8, a.shirt) + r(5, 8, 10, 1, a.shirtHi || a.shirt);
    s += r(3, 9, 2, 5, a.shirt) + r(15, 9, 2, 5, a.shirt) + r(3, 13, 2, 2, sk) + r(15, 13, 2, 2, sk);
    s += r(6, 3, 8, 6, sk) + r(6, 8, 8, 1, skDk);
    s += r(5, 1, 10, 4, a.hair) + r(5, 1, 10, 1, a.hairHi || a.hair) + r(5, 4, 2, 4, a.hair) + r(13, 4, 2, 4, a.hair);
    s += r(8, 6, 1, 1, '#4a3a2e') + r(11, 6, 1, 1, '#4a3a2e');
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="22" shape-rendering="crispEdges">${s}</svg>`);
  }

  /* nanoclaw: the agent's REAL platform avatar, as a pixel token.
   *
   * It lives in the HTML overlay, never in the world SVG — that SVG is served
   * as a data URI and a data-URI SVG may not load an external image, so a face
   * referenced from inside it would silently never appear.
   *
   * Slack serves each avatar at a fixed set of sizes (`…_192.png`); asking for
   * the 48px original instead of downscaling a 192px one is what keeps the
   * face a real pixel grid rather than a smudged thumbnail. A URL that is not
   * that shape is used as-is. Anything that is not a plain https/data image
   * URL is dropped rather than interpolated into markup. */
  function faceSrc(u) {
    if (typeof u !== 'string' || !/^(https:\/\/|data:image\/)[^"'<>\s]+$/.test(u)) return '';
    return u.replace(/_\d+\.(png|jpe?g|gif|webp)$/i, '_48.$1');
  }

  /* ── outdoor ────────────────────────────────────────────────────────── */
  function outdoor(kind, x, y) {
    const X = x * T, Y = y * T;
    switch (kind) {
      case 'tree':
        return r(X + 13, Y + 20, 6, 12, '#7a5636') + r(X + 13, Y + 20, 2, 12, '#8f6844') +
          r(X + 4, Y + 4, 24, 18, '#4f8b46') + r(X, Y + 9, 32, 9, '#4f8b46') + r(X + 8, Y, 16, 8, '#5d9c51') +
          r(X + 7, Y + 3, 12, 8, '#68a85a') + r(X + 4, Y + 18, 24, 5, '#3f7038') + r(X + 10, Y + 22, 12, 3, '#3f7038');
      case 'palm':
        return r(X + 14, Y + 12, 5, 20, '#8f6844') + r(X + 14, Y + 12, 2, 20, '#a37c53') +
          r(X + 2, Y + 4, 12, 4, '#4f8b46') + r(X + 18, Y + 4, 12, 4, '#4f8b46') +
          r(X, Y + 9, 14, 4, '#3f7038') + r(X + 18, Y + 9, 14, 4, '#68a85a') +
          r(X + 8, Y, 16, 5, '#5d9c51') + r(X + 12, Y + 5, 8, 8, '#3f7038');
      case 'bush':
        return r(X + 1, Y + 4, 14, 10, '#5d9c51') + r(X + 1, Y + 4, 10, 3, '#6fb35f') + r(X + 1, Y + 12, 14, 2, '#417540') + r(X + 5, Y + 2, 7, 3, '#5d9c51');
      case 'lounger':
        return r(X, Y + 2, 30, 12, '#efe7d4') + r(X, Y + 2, 30, 2, '#f8f3e6') + r(X, Y + 13, 30, 2, '#cfc5ac') + r(X + 2, Y + 4, 9, 8, '#9dc3d4') + r(X + 26, Y + 5, 3, 6, '#cfc5ac');
      case 'bench':
        return r(X, Y + 4, 30, 8, '#a3764c') + r(X, Y + 4, 30, 2, '#bb8b5d') + r(X, Y + 11, 30, 1, '#7a5636') + r(X + 2, Y + 12, 4, 4, '#6d4a2e') + r(X + 24, Y + 12, 4, 4, '#6d4a2e');
      case 'car':
        return r(X + 2, Y, 26, 44, '#b8635a') + r(X + 2, Y, 26, 3, '#cf7c72') + r(X + 4, Y + 5, 22, 12, '#9a544c') + r(X + 5, Y + 6, 20, 10, '#7f4740') +
          r(X + 4, Y + 24, 22, 12, '#bcd6e0') + r(X + 5, Y + 25, 20, 10, '#9dc0cf') + r(X + 2, Y + 41, 26, 3, '#8f4b45') +
          r(X, Y + 8, 2, 8, '#6f3d38') + r(X + 28, Y + 8, 2, 8, '#6f3d38') + r(X, Y + 30, 2, 8, '#6f3d38') + r(X + 28, Y + 30, 2, 8, '#6f3d38');
      case 'table':
        return r(X + 1, Y + 1, 20, 16, '#d9cdb0') + r(X + 1, Y + 1, 20, 2, '#eae0c8') + r(X + 1, Y + 15, 20, 2, '#bdb094') + r(X + 8, Y + 6, 6, 6, '#c9756a');
      case 'hoop':
        return r(X + 6, Y, 16, 10, P.white) + r(X + 6, Y, 16, 2, '#e2ddd0') + r(X + 10, Y + 10, 8, 2, '#c8563f') + r(X + 12, Y + 12, 4, 20, '#9aa0a6');
      case 'umbrella':
        return r(X + 2, Y, 26, 4, '#c9756a') + r(X, Y + 4, 30, 4, '#d98a7e') + r(X + 4, Y + 8, 22, 3, '#b3625a') + r(X + 13, Y + 11, 4, 14, '#a89f8c');
      default: return '';
    }
  }

  /* ── rooms ──────────────────────────────────────────────────────────── */
  /* GEOMETRY ONLY. `label`, `open`, `state` and `agents` here are defaults
   * for a standalone render; live data overrides them via `.data` below. They
   * are deliberately anonymous — the upstream export carried this install's
   * real channel and persona names, which must not live in trunk.
   * The grids are hand-authored and must NOT be generated per-poll — a plan
   * that reshuffles destroys the spatial memory that is the whole point. */
  const ROOMS = {
    westFront: {
      label: 'room one', floor: 'wood', open: 22, state: 'blocked', wall: '#a9b79a',
      grid: [
        'wwww.bb..wwww.p',
        'TTTT.TT..TTTT..',
        '..1....2...c...',
        'B.............B',
        'O............x.',
        'p..c...c...c..e',
        'TTTT..TTTTT..pp',
      ],
      agents: [
        { name: 'one', status: 'blocked', shirt: '#5b86ad', shirtHi: '#6f9bc2', hair: '#3a2e26', hairHi: '#4b3c31' },
        { name: 'two', status: 'working', shirt: '#7f9c5c', shirtHi: '#93b06d', hair: '#7a4f2c', hairHi: '#8f6038', skin: '#f0cfa8' },
      ],
    },
    eastFront: {
      label: 'room two', floor: 'wood', open: 9, state: 'waiting', wall: '#a6a9cd',
      grid: [
        'ww.bbb..ww.p.',
        'TTT.TT.TTTT..',
        '..1...c...c..',
        'O...........B',
        'O.....c.c...B',
        'p..TTTTTT..px',
      ],
      agents: [{ name: 'three', status: 'waiting', shirt: '#c39a4e', shirtHi: '#d6ad60', hair: '#4a3728', skin: '#d9a97e' }],
    },
    kitchen: {
      label: 'room three', floor: 'tile', open: 31, state: 'blocked', wall: '#92a7b3',
      grid: [
        'kkksfkk..ww.p',
        '.....1....2..',
        '......c....xB',
        'O.....c.c...B',
        'O...........e',
        'p.kkkkkk..ppx',
      ],
      agents: [
        { name: 'four', status: 'working', shirt: '#8c6ea0', shirtHi: '#a081b5', hair: '#241c17', skin: '#c68f63', skinDk: '#a87549' },
        { name: 'five', status: 'idle', shirt: '#4f5560', shirtHi: '#626875', hair: '#1f1a16' },
      ],
    },
    westBack: {
      label: 'room four', floor: 'carpet', open: 6, state: 'working', wall: '#c49a86',
      grid: [
        'ww.bb..ww..bb.p',
        'TTT.TT.TTT.TT..',
        '..1...c...c....',
        'B.............B',
        'O............x.',
        'p..c...c...c..e',
        'TTTT..TTTT..TT.',
      ],
      agents: [{ name: 'six', status: 'working', shirt: '#6f9b6a', shirtHi: '#82b07c', hair: '#241c17', skin: '#e8c091' }],
    },
    eastBack: {
      label: 'room five', floor: 'wood', open: 0, state: 'idle', wall: '#cbbfa2',
      grid: [
        'wwww.bbb..ww.',
        'TTTT.TTT.TTT.',
        '.c..c..c..c..',
        'B...........B',
        'O...........e',
        'p..c....c...p',
        'pTTTT..TTTT.p',
      ],
      agents: [],
    },
    garage: {
      // nanoclaw: open 2 -> 0. Only the five SLOT rooms take live counts, so the
      // garage kept the authored demo number and rendered it as if it were real.
      label: 'garage', floor: 'concrete', open: 0, state: 'idle', dead: true, wall: '#b3aea4',
      grid: [
        'CbbbS..ww.xC',
        'gg.S...d...x',
        '....d.....xx',
        'B......d....',
        'B.d.......xx',
        'S.....d....x',
        '..d.......d.',
        'CxxS.SS...xC',
      ],
      agents: [],
    },
    /* nanoclaw: east wing + south annex. The floor had five live slots against
     * ten live channels, so half the workgroup — including its busiest rooms —
     * had nowhere to stand and fell into the overflow line. Geometry stays
     * hand-authored and fixed; only the count grew. */
    eastWingN: {
      label: 'room six', floor: 'wood', open: 0, state: 'idle', wall: '#b0a98f',
      grid: [
        'ww.bb..ww..bb.p',
        'TTT.TT.TTT.TT..',
        '..1...c...c....',
        'B.............B',
        'O............x.',
        'p..c...c...c..e',
        'TTTT..TTTT..TT.',
      ],
      agents: [],
    },
    eastWingM: {
      label: 'room seven', floor: 'carpet', open: 0, state: 'idle', wall: '#9db3a4',
      grid: [
        'wwww.bbb..ww..p',
        'TTTT.TTT.TTT...',
        '..1....2...c...',
        'B.............B',
        'O.............e',
        'p..c...c...c..x',
        'TTTT..TTTTT..pp',
      ],
      agents: [],
    },
    eastWingS: {
      label: 'room eight', floor: 'tile', open: 0, state: 'idle', wall: '#b3a2a8',
      grid: [
        'kkksfk..ww..bb.',
        '.....1....2....',
        'B.....c....c..B',
        'O.............e',
        'O............x.',
        'p.kkkk..TTTT.pp',
      ],
      agents: [],
    },
    southWest: {
      label: 'room nine', floor: 'wood', open: 0, state: 'idle', wall: '#c0b394',
      grid: [
        'ww.bb..wwww.bb.',
        'TTT.TT.TTTT.TT.',
        '..1...c....c...',
        'B.............B',
        'O............x.',
        'p..c...c...c..e',
        'TTTT..TTTT..TT.',
      ],
      agents: [],
    },
    southMid: {
      label: 'room ten', floor: 'carpet', open: 0, state: 'idle', wall: '#a8aec2',
      grid: [
        'ww.bbb..ww.p.',
        'TTT.TT.TTTT..',
        '..1...c...c..',
        'O...........B',
        'O.....c.c...B',
        'p..TTTTTT..px',
      ],
      agents: [],
    },
    southEast: {
      label: 'room eleven', floor: 'concrete', open: 0, state: 'idle', wall: '#aeb0ab',
      grid: [
        'ww..bb..ww.p.',
        'TTT.TT.TTTT..',
        '..1...c...c..',
        'B...........B',
        'O.....c.c...e',
        'p..TTTTTT..xp',
      ],
      agents: [],
    },
    hall: {
      label: 'hallway', floor: 'brick', open: 0, state: 'idle', quiet: true,
      grid: ['p...x.....b...p', '...............', 'B....p.....x..B'],
      agents: [],
    },
  };

  /* ── plans ──────────────────────────────────────────────────────────── */
  const PLANS = {
    /* nanoclaw: grown from five live rooms to eleven. The five original rooms
     * keep their exact coordinates — a plan that moves rooms destroys the
     * spatial memory the floor exists for — and the new ones are an east wing
     * and a south annex around the same yard. */
    house: {
      world: [76, 43],
      buildings: [[6, 3, 31, 22], [40, 3, 18, 29], [61, 3, 13, 10], [6, 29, 46, 10]],
      place: {
        westFront: [7, 4], eastFront: [23, 4], kitchen: [23, 11], eastBack: [23, 18],
        hall: [7, 12], westBack: [7, 17],
        eastWingN: [41, 4], eastWingM: [41, 13], eastWingS: [41, 22],
        southWest: [7, 30], southMid: [23, 30], southEast: [37, 30],
        garage: [62, 4],
      },
      doors: [
        [13, 11, 2, 1], [13, 16, 2, 1], [22, 12, 1, 2], [22, 6, 1, 2], [22, 19, 1, 2],
        [37, 8, 3, 1], [37, 16, 3, 1], [40, 11, 1, 2], [40, 20, 1, 2],
        [57, 8, 4, 1], [13, 26, 2, 3], [29, 26, 2, 3], [43, 26, 2, 3], [51, 24, 4, 1],
      ],
      paths: [
        [37, 8, 3, 1], [37, 16, 3, 1], [57, 8, 4, 1],
        [13, 26, 2, 3], [29, 26, 2, 3], [43, 26, 2, 3],
        [12, 27, 32, 2], [58, 12, 3, 16], [51, 24, 8, 2], [53, 28, 16, 2], [61, 13, 4, 2],
      ],
      pool: [58, 30, 11, 6],
      decor: [
        ['palm', 1, 5], ['palm', 2, 18], ['tree', 0, 25], ['bush', 4, 11], ['bush', 4, 22],
        ['tree', 77, 4], ['palm', 76, 15], ['palm', 77, 30], ['bush', 38, 40], ['bush', 16, 41],
        ['tree', 25, 0], ['bush', 46, 0], ['palm', 33, 0], ['palm', 59, 0],
        ['lounger', 58, 37], ['lounger', 61, 37], ['umbrella', 64, 36], ['table', 70, 31],
        ['bench', 16, 26], ['bench', 44, 26], ['car', 66, 14], ['hoop', 71, 24],
        ['bush', 74, 39], ['bush', 8, 0], ['bush', 52, 40], ['tree', 2, 40], ['bush', 20, 40],
        ['palm', 53, 5], ['palm', 55, 27], ['tree', 71, 40], ['bush', 70, 20], ['bush', 30, 41],
        ['bush', 0, 33], ['palm', 2, 33], ['palm', 72, 6], ['tree', 59, 0], ['bush', 46, 41],
      ],
    },
    compound: {
      world: [60, 36],
      buildings: [[5, 3, 17, 11], [24, 3, 15, 16], [41, 3, 15, 10], [5, 17, 17, 10], [23, 24, 14, 10]],
      place: { westFront: [6, 4], eastFront: [25, 4], kitchen: [25, 12], eastBack: [42, 4], westBack: [6, 18], garage: [24, 25] },
      doors: [[13, 14, 2, 1], [31, 11, 2, 1], [31, 19, 2, 1], [48, 13, 2, 1], [13, 27, 2, 1], [29, 34, 2, 1], [22, 8, 1, 2]],
      paths: [[13, 14, 3, 4], [13, 17, 18, 2], [30, 19, 3, 6], [13, 27, 18, 2], [48, 13, 3, 10], [31, 21, 18, 2], [29, 34, 3, 2]],
      pool: [41, 24, 12, 7],
      decor: [['palm', 22, 3], ['palm', 22, 15], ['tree', 1, 8], ['bush', 3, 15], ['tree', 57, 16], ['palm', 39, 6], ['palm', 39, 31], ['bush', 20, 33], ['bush', 34, 21], ['lounger', 41, 32], ['lounger', 44, 32], ['umbrella', 47, 31], ['table', 34, 15], ['bench', 18, 30], ['car', 51, 25], ['bush', 56, 4], ['tree', 1, 30], ['palm', 56, 33], ['bush', 40, 22], ['hoop', 19, 5]],
    },
  };

  /* nanoclaw: slot keys are GEOMETRY names, never channel names — the
   * upstream export keyed them by this install's channels, which would put
   * install identity in trunk. A live channel is assigned to a slot at
   * runtime.
   * The slots a live workgroup's channels are assigned to, in the
   * order they are filled. `hall` is circulation and `garage` is where quiet
   * channels go, so neither takes a live channel from the front of the list. */
  const SLOTS = [
    'westFront', 'eastFront', 'kitchen', 'westBack', 'eastBack',
    'eastWingN', 'eastWingM', 'eastWingS',
    'southWest', 'southMid', 'southEast',
  ];

  /* ── build ──────────────────────────────────────────────────────────── */
  const CACHE = {};
  function build(planKey, dataKey, data) {
    const ck = planKey + '|' + (dataKey || '');
    if (CACHE[ck]) return CACHE[ck];
    const out = buildWorld(planKey, data);
    CACHE[ck] = out;
    return out;
  }
  function buildWorld(planKey, data) {
    const PL = PLANS[planKey] || PLANS.house;
    /* nanoclaw: overlay live label/open/state/agents onto the fixed geometry.
     * Geometry is never taken from data — see the note on ROOMS. */
    const RM = {};
    Object.keys(ROOMS).forEach((k) => { RM[k] = Object.assign({}, ROOMS[k]); });
    if (data && data.rooms) {
      SLOTS.forEach((slot) => { RM[slot] = Object.assign({}, RM[slot], { label: '', open: 0, state: 'idle', agents: [], vacant: true }); });
      data.rooms.forEach((d) => {
        const slot = d.slot;
        if (!RM[slot]) return;
        RM[slot] = Object.assign({}, RM[slot], d, { grid: RM[slot].grid, floor: RM[slot].floor, wall: RM[slot].wall, vacant: false });
      });
    }
    const [WT, HT] = PL.world, W = WT * T, H = HT * T;
    let s = r(0, 0, W, H, P.grass);
    for (let i = 0; i < 700; i++) {
      const x = Math.floor(hash(i, 3, 5) * W), y = Math.floor(hash(i, 9, 13) * H);
      s += r(x, y, 3, 2, hash(i, 1, 2) > 0.5 ? P.grass2 : P.grass3);
    }
    (PL.paths || []).forEach(([x, y, w, h]) => { s += floorFill('brick', x, y, w, h); });
    if (PL.pool) {
      const [x, y, w, h] = PL.pool;
      s += r(x * T - 12, y * T - 12, w * T + 24, h * T + 24, '#e4dcc6') + r(x * T - 12, y * T - 12, w * T + 24, 3, '#f0e9d8');
      s += r(x * T - 3, y * T - 3, w * T + 6, h * T + 6, '#cfd8d3');
      s += r(x * T, y * T, w * T, h * T, P.water);
      for (let i = 6; i < h * T; i += 12) s += r(x * T, y * T + i, w * T, 3, P.water2);
      s += r(x * T, y * T, w * T, 3, P.water3) + r(x * T, y * T + h * T - 3, w * T, 3, P.water3);
    }
    PL.buildings.forEach(([x, y, w, h]) => {
      s += r(x * T - 6, y * T - 6, w * T + 12, h * T + 12, P.wallSh) + r(x * T - 5, y * T - 6, w * T + 10, h * T + 10, P.wallCap);
      s += r(x * T, y * T, w * T, h * T, '#e2ddd2');
      for (let i = 3; i < w - 3; i += 7) s += r((x + i) * T, y * T - 6, 4 * T, 4, P.glass) + r((x + i) * T, y * T - 6, 4 * T, 2, P.glassHi);
    });
    const rooms = [];
    Object.keys(PL.place).forEach((key) => {
      const R = RM[key], [rx, ry] = PL.place[key];
      const w = R.grid[0].length, h = R.grid.length;
      rooms.push({ key, R, rx, ry, w, h });
      s += floorFill(R.floor, rx, ry, w, h);
      if (R.rug) s += rugFill(rx + R.rug[0], ry + R.rug[1], R.rug[2], R.rug[3], R.rug[4], R.rug[5]);
      const wc = R.wall || '#c6c1b6', X = rx * T, Y = ry * T, WW = w * T, HH = h * T;
      s += r(X - 5, Y - 5, WW + 10, 5, wc) + r(X - 5, Y + HH, WW + 10, 5, wc) + r(X - 5, Y - 5, 5, HH + 10, wc) + r(X + WW, Y - 5, 5, HH + 10, wc);
      s += r(X - 5, Y - 5, WW + 10, 2, '#ffffff') + r(X - 5, Y - 5, 2, HH + 10, 'rgba(255,255,255,.45)');
      s += r(X - 1, Y, 1, HH, 'rgba(0,0,0,.10)') + r(X, Y - 1, WW, 1, 'rgba(0,0,0,.13)');
    });
    (PL.doors || []).forEach(([x, y, w, h]) => { s += floorFill('brick', x, y, w, h); });
    let agentPins = [];
    rooms.forEach(({ key, R, rx, ry }) => {
      R.grid.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '.' || ch === ' ') continue;
          const X = (rx + i) * T, Y = (ry + j) * T;
          if (ch >= '1' && ch <= '9') {
            const a = R.agents[+ch - 1];
            if (a) { s += sprite('c', X, Y, '', '', i + j); agentPins.push({ room: key, a, x: X - 2, y: Y - 8, nearTop: j <= 1 }); }
            continue;
          }
          s += sprite(ch, X, Y, row[i - 1], row[i + 1], i + j);
        }
      });
    });
    (PL.decor || []).forEach(([k, x, y]) => { s += outdoor(k, x, y); });
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${s}</svg>`);
    return { svg: `<img class="art" alt="" draggable="false" src="${uri}" width="${W}" height="${H}" style="display:block;width:${W}px;height:${H}px">`, rooms, agentPins, W, H, PL };
  }

  const css = `
:host{display:block;position:relative;height:100%;min-height:240px;overflow:hidden;background:#a8c47f}
.vp{position:absolute;inset:0;overflow:auto;cursor:grab;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.vp::-webkit-scrollbar{display:none}
.vp.drag{cursor:grabbing}
.stage{position:relative}
.world{position:absolute;left:0;top:0;transform-origin:0 0}
.art{image-rendering:pixelated;user-select:none;-webkit-user-drag:none;pointer-events:none}
.ov{position:absolute;inset:0}
.hit{position:absolute;cursor:pointer;border:0;padding:0;background:transparent}
.hit:focus-visible{outline:2px solid #3f68c9;outline-offset:2px}
.ag{position:absolute;image-rendering:pixelated;background-repeat:no-repeat;background-size:100% 100%;pointer-events:none;animation:bob 3.2s ease-in-out infinite}
.ag.w{animation-duration:1.9s}
.ag.i{animation:none;filter:saturate(.55) brightness(1.02)}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6%)}}
.pill{position:absolute;transform:translate(-50%,-100%);}
.pill.below{transform:translate(-50%,0)}
.pill.below:after{top:-3px;bottom:auto}
.pill{display:flex;align-items:center;gap:5px;background:#2c2822;color:#fbf8f2;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:4px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 4px rgba(40,32,20,.28);pointer-events:none}
.pill:after{content:"";position:absolute;left:50%;bottom:-3px;width:6px;height:6px;background:#2c2822;transform:translateX(-50%) rotate(45deg)}
.room{position:absolute;transform:translate(0,-100%);display:flex;align-items:center;gap:6px;background:#2c2822;color:#fbf8f2;font:500 11.5px/1 ui-sans-serif,system-ui,sans-serif;padding:5px 8px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 4px rgba(40,32,20,.25);pointer-events:none}
.room .n{font-variant-numeric:tabular-nums;font-weight:600;background:rgba(255,255,255,.16);border-radius:4px;padding:1px 5px}
.bub{position:absolute;transform:translate(-50%,-100%);background:#fbfaf6;border-radius:8px;padding:4px 6px;display:flex;gap:3px;align-items:center;box-shadow:0 2px 4px rgba(40,32,20,.25);pointer-events:none}
.bub i{width:4px;height:4px;border-radius:50%;background:#8a857c;animation:blink 1.4s infinite}
.bub i:nth-child(2){animation-delay:.2s}.bub i:nth-child(3){animation-delay:.4s}
.bub.z{font:600 10px/1 ui-sans-serif,system-ui,sans-serif;color:#8a857c;padding:3px 6px}
/* nanoclaw: the real avatar, kept chunky — same crisp-edge read as the floor.
   Asleep goes grey so the awake/asleep contrast survives the photo. */
.face{display:block;flex:none;image-rendering:pixelated;border-radius:2px;background:#d9d4c8;box-shadow:0 0 0 1px rgba(44,40,34,.18)}
.face.i{filter:grayscale(1)}
.pill .face{border-radius:3px;box-shadow:none}
@keyframes blink{0%,60%,100%{opacity:.35}30%{opacity:1}}
.dot{width:6px;height:6px;border-radius:50%;flex:none}
.badge{position:absolute;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:12px;background:#fdfbf6;color:#2c2822;font:600 12.5px/1 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:0 2px 5px rgba(40,32,20,.28);border:2px solid var(--bc,#8f8b82);pointer-events:none}
.sign{position:absolute;transform:translate(0,-100%);background:rgba(253,251,246,.95);border-radius:5px;padding:4px 8px;font:500 11px/1 ui-sans-serif,system-ui,sans-serif;color:#453e33;box-shadow:0 2px 4px rgba(40,32,20,.22);display:flex;align-items:center;gap:6px;white-space:nowrap;pointer-events:none}
.sel{position:absolute;border:2px solid #2f2a24;border-radius:4px;box-shadow:0 0 0 4px rgba(255,255,255,.45);pointer-events:none}
.mute{opacity:.5}
@media (prefers-reduced-motion:reduce){.ag,.bub i{animation:none}}
`;

  class OfficeMap extends HTMLElement {
    static get observedAttributes() { return ['plan', 'scale', 'labels', 'agents', 'selected']; }
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      if (this._seen) { this.render(); return; }
      this.shadowRoot.innerHTML = '<style>:host{display:block;height:100%;background:#a8c47f}</style>';
      const go = () => { if (this._seen) return; this._seen = true; this.render(); };
      let io = null;
      try {
        io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '400px' });
        io.observe(this);
      } catch (e) { /* no IO support */ }
      const later = () => { if (io) io.disconnect(); go(); };
      if (typeof requestIdleCallback === 'function') this._idle = requestIdleCallback(later, { timeout: 2000 });
      else this._fallback = setTimeout(later, 600);
      document.addEventListener('visibilitychange', later, { once: true });
    }
    attributeChangedCallback() { if (this.shadowRoot && this._seen) this.render(); }
    disconnectedCallback() { clearTimeout(this._fallback); if (this._idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(this._idle); }
    get scale() { return parseFloat(this.getAttribute('scale') || '1.2'); }
    /* nanoclaw: React 19 assigns unknown props to a custom element as
     * PROPERTIES, so a getter-only `scale` throws on first render. Mirror it
     * back to the attribute, which is where the renderer already reads it. */
    set scale(v) { this.setAttribute('scale', String(v)); }
    setScale(v) { this.setAttribute('scale', String(Math.max(0.6, Math.min(3, v)))); }
    /* nanoclaw: live data seam. Set as a PROPERTY (not an attribute) so React
     * can hand over structured rooms/agents without serialising them. */
    get data() { return this._data; }
    set data(v) {
      this._data = v;
      this._dataKey = v ? JSON.stringify(v) : '';
      if (this.shadowRoot && this._seen) this.render();
    }
    /* nanoclaw: the fixed slot list, so a caller can assign channels to slots
     * without reaching into module internals. */
    static get slots() { return SLOTS.slice(); }
    teleport(key) {
      const m = this._rooms && this._rooms.find((x) => x.key === key || x.R.label === key);
      const vp = this._vp;
      if (!m || !vp) { this._pending = key; return; }
      this._pending = null;
      const s = this.scale;
      vp.scrollLeft = Math.max(0, (m.rx + m.w / 2) * T * s - vp.clientWidth / 2);
      vp.scrollTop = Math.max(0, (m.ry + m.h / 2) * T * s - vp.clientHeight / 2);
    }
    render() {
      const plan = this.getAttribute('plan') || 'house';
      const labels = this.getAttribute('labels') || 'pill';
      const agentMode = this.getAttribute('agents') || 'pill';
      const selected = this.getAttribute('selected') || '';
      const s = this.scale;
      const built = build(plan, this._dataKey, this._data);
      this._rooms = built.rooms;
      const px = (v) => v * s + 'px';
      let ov = '';
      built.rooms.forEach((m) => {
        if (m.R.quiet) return;
        const L = m.rx * T, Tp = m.ry * T, Wr = m.w * T, Hr = m.h * T;
        const isSel = selected === m.key, col = STATUS[m.R.state];
        ov += `<button class="hit" data-room="${m.key}" aria-label="${m.R.label}" style="left:${px(L)};top:${px(Tp)};width:${px(Wr)};height:${px(Hr)}"></button>`;
        if (isSel) ov += `<div class="sel" style="left:${px(L)};top:${px(Tp)};width:${px(Wr)};height:${px(Hr)}"></div>`;
        if (!m.R.label) return; // nanoclaw: an unassigned slot draws furniture, no chrome
        if (labels === 'pill') {
          ov += `<div class="room${selected && !isSel ? ' mute' : ''}" style="left:${px(L + 8)};top:${px(Tp - 3)}"><span class="dot" style="background:${col}"></span>${m.R.label}${m.R.open ? `<span class="n">${m.R.open}</span>` : ''}</div>`;
        } else if (labels === 'badge') {
          ov += `<div class="badge" style="--bc:${col};left:${px(L + Wr / 2)};top:${px(Tp + Hr / 2)}">${m.R.open}</div>`;
          if (isSel) ov += `<div class="room" style="left:${px(L + 8)};top:${px(Tp - 3)}"><span class="dot" style="background:${col}"></span>${m.R.label}</div>`;
        } else {
          ov += `<div class="sign" style="left:${px(L + 8)};top:${px(Tp + Hr - 6)}"><span class="dot" style="background:${col}"></span>${m.R.label}${m.R.open ? `<b style="font-variant-numeric:tabular-nums">${m.R.open}</b>` : ''}</div>`;
        }
      });
      built.agentPins.forEach((p, pi) => {
        const mute = selected && selected !== p.room, st = p.a.status;
        const lift = pi % 2 ? -15 : 6;
        /* nanoclaw: the face rides in the label that already hovers over the
         * agent's head, so it needs no placement of its own and can never sit
         * on top of the name. No avatar → the label is exactly what it was. */
        const src = faceSrc(p.a.avatarUrl);
        const face = src ? `<img class="face${st === 'idle' ? ' i' : ''}" src="${src}" alt="" style="width:${px(20)};height:${px(20)}">` : '';
        ov += `<div class="ag ${st === 'working' ? 'w' : st === 'idle' ? 'i' : ''}${mute ? ' mute' : ''}" style="left:${px(p.x)};top:${px(p.y)};width:${px(20)};height:${px(22)};background-image:url('${agentSvg(p.a)}')"></div>`;
        if (agentMode === 'pill') ov += `<div class="pill${p.nearTop ? ' below' : ''}${mute ? ' mute' : ''}" style="left:${px(p.x + 10)};top:${px(p.y + (p.nearTop ? 24 : 0))};margin-top:${p.nearTop ? 0 : -lift}px">${face}<span class="dot" style="width:5px;height:5px;background:${STATUS[st]}"></span>${p.a.name}</div>`;
        else if (!mute) {
          if (st === 'working') ov += `<div class="bub" style="left:${px(p.x + 10)};top:${px(p.y - 4)}">${face}<i></i><i></i><i></i></div>`;
          else if (st === 'idle') ov += `<div class="bub z" style="left:${px(p.x + 10)};top:${px(p.y - 4)}">${face}z z</div>`;
          else ov += `<div class="bub" style="left:${px(p.x + 10)};top:${px(p.y - 4)}">${face}<span class="dot" style="background:${STATUS[st]}"></span></div>`;
        }
      });
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="vp"><div class="stage" style="width:${built.W * s}px;height:${built.H * s}px"><div class="world" style="width:${built.W}px;height:${built.H}px;transform:scale(${s})">${built.svg}</div><div class="ov">${ov}</div></div></div>`;
      const vp = this.shadowRoot.querySelector('.vp');
      this._vp = vp;
      vp.addEventListener('click', (e) => {
        const b = e.target.closest('.hit');
        if (b) this.dispatchEvent(new CustomEvent('room-select', { detail: { key: b.dataset.room }, bubbles: true, composed: true }));
      });
      let down = false, sx = 0, sy = 0, l = 0, t = 0, moved = 0;
      vp.addEventListener('pointerdown', (e) => { down = true; moved = 0; sx = e.clientX; sy = e.clientY; l = vp.scrollLeft; t = vp.scrollTop; vp.classList.add('drag'); });
      vp.addEventListener('pointermove', (e) => {
        if (!down) return;
        moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        vp.scrollLeft = l - (e.clientX - sx); vp.scrollTop = t - (e.clientY - sy);
        if (moved > 6) e.preventDefault();
      });
      const up = () => { down = false; vp.classList.remove('drag'); };
      vp.addEventListener('pointerup', up); vp.addEventListener('pointerleave', up); vp.addEventListener('pointercancel', up);
      if (this._pending) { const k = this._pending; this._pending = null; requestAnimationFrame(() => this.teleport(k)); }
      else if (this._restore) { vp.scrollLeft = this._restore.l; vp.scrollTop = this._restore.t; }
      vp.addEventListener('scroll', () => { this._restore = { l: vp.scrollLeft, t: vp.scrollTop }; });
      if (!this._restore && !this._pending && this.hasAttribute('start')) requestAnimationFrame(() => this.teleport(this.getAttribute('start')));
    }
  }
  if (!customElements.get('office-map')) customElements.define('office-map', OfficeMap);
})();
