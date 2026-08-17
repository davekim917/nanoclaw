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
    } else if (kind === 'carpetWarm' || kind === 'carpetSlate') {
      /* nanoclaw: two more carpets. The call floor and mission control sat
       * two hex steps apart and read as the same room from above; a call floor
       * should feel warm and an ops floor should feel dark. */
      const warm = kind === 'carpetWarm';
      s += r(X, Y, W, H, warm ? '#c9b6a4' : '#8d939e');
      const dot = warm ? '#bda897' : '#828892';
      for (let j = 0; j < H; j += 3) for (let i = ((j / 3) % 2 ? 2 : 0); i < W; i += 4) s += r(X + i, Y + j, 1, 1, dot);
    } else if (kind === 'factory') {
      /* nanoclaw: oil-stained concrete with a painted walkway lane. The three east
       * wing rooms sampled within 4 hex points of each other — same slab, three
       * labels. The lane is what says "this is a shop floor". */
      s += r(X, Y, W, H, '#bab6ad');
      for (let i = 0; i < W; i += 48) s += r(X + i, Y, 1, H, '#aaa69d');
      for (let i = 0; i < 26; i++) {
        const ox = Math.floor(hash(i, x + y, 21) * (W - 10)), oy = Math.floor(hash(i, x - y, 23) * (H - 6));
        s += r(X + ox, Y + oy, 6 + Math.floor(hash(i, 3, 5) * 5), 3, '#a29d93') + r(X + ox + 2, Y + oy + 1, 4, 1, '#948f86');
      }
      // painted walkway, parked mid-room where the grid leaves a clear aisle
      const ly = Math.floor(H * 0.47);
      s += r(X, Y + ly, W, 2, '#d8c264') + r(X, Y + ly, W, 1, '#e8d67f');
      s += r(X, Y + ly + 7, W, 2, '#d8c264') + r(X, Y + ly + 7, W, 1, '#e8d67f');
    } else if (kind === 'raised') {
      // nanoclaw: raised access floor — big panels on visible seams (a data hall floor)
      s += r(X, Y, W, H, '#c2c4c1');
      for (let i = 0; i <= W; i += 32) s += r(X + i, Y, 2, H, '#a9aca8') + r(X + i, Y, 1, H, '#d2d4d1');
      for (let j = 0; j <= H; j += 32) s += r(X, Y + j, W, 2, '#a9aca8') + r(X, Y + j, W, 1, '#d2d4d1');
      for (let j = 0; j < H; j += 32) for (let i = 0; i < W; i += 32) {
        s += r(X + i + 4, Y + j + 4, 2, 2, '#9ea19d') + r(X + i + 26, Y + j + 26, 2, 2, '#9ea19d');
      }
    } else if (kind === 'epoxy') {
      // nanoclaw: pale epoxy — deliberately the lightest floor so scorch marks pop
      s += r(X, Y, W, H, '#dcd9cf');
      for (let i = 0; i < 30; i++) s += r(X + Math.floor(hash(i, x + y, 31) * (W - 6)), Y + Math.floor(hash(i, x - y, 37) * (H - 3)), 5, 2, '#d2cec3');
      for (let j = 0; j <= H; j += 64) s += r(X, Y + j, W, 1, '#cbc7bb');
    } else if (kind === 'noc') {
      // nanoclaw: dark anti-static tile — the NOC annex reads dim, not like a garage
      s += r(X, Y, W, H, '#8f918e');
      for (let i = 0; i <= W; i += 16) s += r(X + i, Y, 1, H, '#7f817e');
      for (let j = 0; j <= H; j += 16) s += r(X, Y + j, W, 1, '#7f817e');
      for (let j = 0; j < H; j += 32) for (let i = 0; i < W; i += 32) s += r(X + i + 6, Y + j + 6, 4, 4, '#989a97');
    } else if (kind === 'bays') {
      /* nanoclaw: concrete with faded painted parking bays. Floor paint only — the
       * garage is the designed dead room and gets no furniture. */
      s += floorFill('concrete', x, y, w, h);
      const bw = Math.floor(W / 2), pl = '#c8bd9f';
      for (let i = 0; i < 2; i++) {
        const bx = X + 6 + i * bw;
        s += r(bx, Y + 8, 1, H - 24, pl) + r(bx + bw - 12, Y + 8, 1, H - 24, pl) + r(bx, Y + 8, bw - 11, 1, pl);
      }
      return s;
    } else if (kind === 'quarry') {
      /* nanoclaw: quarry tile — the BBQ room's floor. `tile` is so pale that pale
       * counters and steel vanish into it; this is dark and warm, so the room's
       * own material carries the identity and everything standing on it reads. */
      s += r(X, Y, W, H, '#ad8a6f');
      for (let i = 0; i <= W; i += 16) s += r(X + i, Y, 1, H, '#8f6e58');
      for (let j = 0; j <= H; j += 16) s += r(X, Y + j, W, 1, '#8f6e58');
      for (let j = 0; j < H; j += 16) for (let i = 0; i < W; i += 16) {
        if (hash(i, j + x + y, 17) > 0.7) s += r(X + i + 1, Y + j + 1, 15, 15, '#a17f66');
      }
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

  function rugFill(x, y, w, h, base, accent, flat) {
    const X = x * T, Y = y * T, W = w * T, H = h * T;
    let s = r(X, Y, W, H, base);
    // nanoclaw: `flat` skips the stripes — on a wood floor they read as decking
    if (!flat) for (let i = 4; i < W - 4; i += 10) s += r(X + i, Y + 4, 5, H - 8, accent);
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

      /* nanoclaw: themed-floor sprite vocabulary. Same rules as the set above —
       * no black outlines (edges are darker shades of the sprite's own fill),
       * integer coordinates only, origin = tile top-left. */

      case 'P': { // nanoclaw: call-centre desk run — fabric partition at the back, desk phone, headset parked
        let s = r(X, Y + 4, 16, 10, P.deskTop) + r(X, Y + 4, 16, 2, P.deskHi) + r(X, Y + 13, 16, 1, P.deskEdge);
        if (capL) s += r(X, Y + 4, 1, 10, P.deskEdge) + r(X + 1, Y + 14, 2, 2, P.deskLeg);
        if (capR) s += r(X + 15, Y + 4, 1, 10, P.deskEdge) + r(X + 13, Y + 14, 2, 2, P.deskLeg);
        s += r(X, Y, 16, 4, '#c3cdd4') + r(X, Y, 16, 1, '#dae1e6') + r(X, Y + 3, 16, 1, '#a2adb5'); // partition
        /* nanoclaw: the HEADSET is the one prop that says "call floor", so it hangs on the
         * partition at full size rather than lying flat on the desk where it was 3px of grey:
         * arched headband, two dark earcups, and a boom mic swinging off the near cup. */
        s += r(X + 3, Y + 1, 6, 1, '#3f454c') + r(X + 2, Y + 2, 1, 2, '#3f454c') + r(X + 9, Y + 2, 1, 2, '#3f454c'); // band
        s += r(X + 1, Y + 3, 3, 4, '#4d545c') + r(X + 1, Y + 3, 3, 1, '#6a727a'); // far earcup
        s += r(X + 8, Y + 3, 3, 4, '#4d545c') + r(X + 8, Y + 3, 3, 1, '#6a727a'); // near earcup
        s += r(X + 4, Y + 6, 4, 1, '#5f676f') + r(X + 3, Y + 7, 2, 1, '#8a929b'); // boom mic
        s += r(X + 12, Y + 1, 3, 2, k > 0.5 ? '#e7d7a8' : '#d9c8dd'); // pinned note
        s += r(X + 1, Y + 8, 5, 4, P.mon) + r(X + 2, Y + 9, 3, 2, k > 0.5 ? P.screen : P.screenDk); // small monitor
        s += r(X + 8, Y + 6, 6, 5, '#e4e0d5') + r(X + 8, Y + 6, 6, 1, '#f2efe6') + r(X + 8, Y + 10, 6, 1, '#c2bdb0'); // phone base
        s += r(X + 7, Y + 5, 8, 1, '#9aa2a9') + r(X + 9, Y + 8, 4, 1, '#8f979e'); // handset in its cradle
        s += r(X + 12, Y + 8, 2, 2, '#c8624f') + r(X + 12, Y + 8, 2, 1, '#e07f6c'); // lit line button
        return s;
      }
      case 'M': { // nanoclaw: the smoker (hero) — chunky barrel, firebox + chimney at the left cap, gauge at the right
        /* OFFSET smoker, drawn as an ELEVATION. Two shape rules keep it from
         * reading as another counter run: the barrel is ROUNDED (stepped ends
         * top and bottom, so the silhouette is never a rectangle) and it is
         * TALLER than the counters, overhanging into the row below, which the
         * grid keeps clear. The firebox is a separate squat drum bolted to the
         * left end, at a different height from the barrel — that offset is the
         * whole point of the form.
         * Deliberately drawn COLD: no ember, no glow. Heat is state, and state
         * belongs to the fx overlay, not the static world. */
        const lid = '#7c6c5d', bod = '#54493f', dk = '#332c27', rim = '#8d7c6c', brass = '#9a7f52', bolt = '#b09b83';
        /* Barrel body, y+2..y+22. The run is deliberately only THREE tiles wide:
         * at four it was 64x20, a 3:1 slab that read as exactly what the pale
         * counters beside it are. Ends are stepped in two steps so the silhouette
         * is a rounded drum from any distance, never a rectangle. */
        // crown steps in twice at the top so the roofline is a curve, not the flat
        // straight edge every counter run in this tileset has
        let s = r(X + 3, Y, 10, 1, rim) + r(X + 1, Y + 1, 14, 1, rim) + r(X, Y + 2, 16, 2, rim);
        s += r(X, Y + 4, 16, 6, lid) + r(X, Y + 4, 16, 1, '#9c8a78');
        s += r(X, Y + 9, 16, 1, '#6b5d4f') + r(X, Y + 10, 16, 1, brass); // lid seam, two-tone
        s += r(X, Y + 11, 16, 9, bod) + r(X, Y + 20, 16, 2, dk);
        for (let i = 2; i < 16; i += 5) s += r(X + i, Y + 5, 1, 1, bolt) + r(X + i, Y + 18, 1, 1, bolt); // rivets
        if (capL) {
          s += r(X, Y + 2, 4, 2, dk) + r(X, Y + 4, 2, 2, dk) + r(X, Y + 18, 2, 2, dk) + r(X, Y + 20, 4, 2, dk); // stepped end
          s += r(X + 2, Y + 6, 1, 12, dk);
          // chimney: base plate overlaps the lid so the stack visibly MEETS the body
          s += r(X + 3, Y + 1, 8, 4, bod) + r(X + 3, Y + 1, 8, 1, rim);
          s += r(X + 4, Y - 13, 6, 15, bod) + r(X + 4, Y - 13, 2, 15, lid) + r(X + 9, Y - 13, 1, 15, dk);
          s += r(X + 3, Y - 15, 8, 3, brass) + r(X + 3, Y - 15, 8, 1, bolt); // stack cap
          s += r(X + 3, Y + 22, 3, 5, dk); // leg
        } else if (capR) {
          s += r(X + 12, Y + 2, 4, 2, dk) + r(X + 14, Y + 4, 2, 2, dk) + r(X + 14, Y + 18, 2, 2, dk) + r(X + 12, Y + 20, 4, 2, dk);
          s += r(X + 13, Y + 6, 1, 12, dk);
          /* offset FIREBOX: a squat drum bolted to the end, hanging BELOW the
           * barrel line. That height difference is the offset-smoker read, and
           * it is what breaks the flat counter silhouette. Drawn COLD. */
          s += r(X + 8, Y + 13, 10, 13, '#463d36') + r(X + 8, Y + 13, 10, 2, '#5c5148') + r(X + 8, Y + 25, 10, 1, '#241f1b');
          s += r(X + 8, Y + 12, 10, 1, brass);
          s += r(X + 11, Y + 17, 5, 5, '#2b2522') + r(X + 11, Y + 17, 5, 1, '#3d3531'); // cold door
          s += r(X + 12, Y + 19, 3, 2, '#6d665e') + r(X + 12, Y + 19, 3, 1, '#857d73'); // grey ash, unlit
          s += r(X + 9, Y + 26, 2, 3, dk) + r(X + 15, Y + 26, 2, 3, dk); // firebox legs
          s += r(X + 9, Y + 5, 5, 5, P.steel) + r(X + 10, Y + 6, 3, 3, '#e6e2d7') + r(X + 11, Y + 7, 1, 1, '#b8574a'); // temp gauge
        } else {
          s += r(X + 3, Y + 6, 10, 3, rim) + r(X + 3, Y + 6, 10, 1, '#a08e7b'); // lid highlight
          s += r(X + 5, Y + 13, 6, 4, brass) + r(X + 5, Y + 13, 6, 1, bolt); // latch
          s += r(X + 6, Y + 22, 4, 5, dk); // leg
        }
        return s;
      }
      case 'm': { // nanoclaw: meat rack — a real rail on posts, S-hooks, slabs of differing length
        const meat = ['#7c3c2d', '#8e4834', '#6a3125'];
        // rail: two end posts plus a bar, so it hangs rather than standing on the floor
        let s = r(X, Y + 1, 16, 3, '#7d7163') + r(X, Y + 1, 16, 1, '#9c8d7b') + r(X, Y + 3, 16, 1, '#5f564b');
        if (capL) s += r(X, Y, 2, 7, '#6d6255');
        if (capR) s += r(X + 14, Y, 2, 7, '#6d6255');
        for (let i = 0; i < 3; i++) {
          const mx = X + 1 + i * 5, mh = 5 + Math.floor(hash(X + i * 7, Y, seed) * 7); // varied lengths
          s += r(mx + 1, Y + 4, 1, 3, '#c6bba6') + r(mx + 2, Y + 4, 1, 1, '#c6bba6'); // S-hook
          const col = meat[Math.floor(hash(X + i * 3, Y + 2, seed) * 3)];
          s += r(mx, Y + 7, 4, mh, col) + r(mx, Y + 7, 4, 1, '#a55f47') + r(mx + 3, Y + 8, 1, mh - 2, '#4f2419');
          s += r(mx + 1, Y + 6 + mh, 2, 1, '#4f2419'); // rounded tip
        }
        return s;
      }
      case 'u': { // nanoclaw: wooden stool — prep seating; a swivel chair has no business in the BBQ room
        return r(X + 3, Y + 4, 10, 5, P.wood) + r(X + 3, Y + 4, 10, 1, P.woodHi) + r(X + 3, Y + 8, 10, 1, P.woodDk) +
          r(X + 4, Y + 9, 2, 5, P.woodDk) + r(X + 10, Y + 9, 2, 5, P.woodDk) + r(X + 4, Y + 11, 8, 1, P.woodDk);
      }
      case 'h': { // nanoclaw: wood-top workbench run — tools, vise, NO monitor (that was the office kit leaking in)
        let s = r(X, Y + 4, 16, 10, '#9a7448') + r(X, Y + 4, 16, 2, '#b08a5c') + r(X, Y + 13, 16, 1, '#75542f');
        if (capL) s += r(X, Y + 4, 1, 10, '#75542f') + r(X + 1, Y + 14, 2, 3, '#5e4426');
        if (capR) s += r(X + 15, Y + 4, 1, 10, '#75542f') + r(X + 13, Y + 14, 2, 3, '#5e4426');
        s += r(X, Y, 16, 4, '#8b9198') + r(X, Y, 16, 1, '#a3a9b0'); // pegboard back
        for (let i = 1; i < 15; i += 4) { // hanging tools
          const t = hash(X + i, Y, seed);
          if (t > 0.66) s += r(X + i, Y + 1, 1, 3, '#5f666d') + r(X + i - 1, Y + 1, 3, 1, '#7d848b');
          else if (t > 0.33) s += r(X + i, Y + 1, 2, 2, '#b8574a') + r(X + i, Y + 3, 1, 1, '#8f4038');
          else s += r(X + i, Y + 1, 1, 2, '#c9a068') + r(X + i - 1, Y + 3, 3, 1, '#5f666d');
        }
        if (k > 0.6) s += r(X + 3, Y + 7, 6, 4, '#6f767c') + r(X + 3, Y + 7, 6, 1, '#8b9198'); // vise
        else if (k > 0.3) s += r(X + 4, Y + 8, 7, 3, '#c9a068') + r(X + 4, Y + 8, 7, 1, '#dcb87f'); // stock
        s += r(X + 11, Y + 9, 4, 2, '#7d848b'); // wrench
        return s;
      }
      case '&': { // nanoclaw: artist's worktable — paint tubes, brushes in a jar, spatter.
        // Same silhouette family as the factory bench `h`, but the surface says studio.
        let s = r(X, Y + 3, 16, 11, '#c9a877') + r(X, Y + 3, 16, 2, '#dcc094') + r(X, Y + 13, 16, 1, '#a1804f');
        if (capL) s += r(X, Y + 3, 1, 11, '#a1804f') + r(X + 1, Y + 14, 2, 3, '#7f6339');
        if (capR) s += r(X + 15, Y + 3, 1, 11, '#a1804f') + r(X + 13, Y + 14, 2, 3, '#7f6339');
        const inks = ['#c8624f', '#5b86ad', '#7f9c5c', '#c08a2e', '#8c6ea0'];
        for (let i = 0; i < 4; i++) { // paint spatter on the surface
          const sx = X + 1 + Math.floor(hash(X + i * 3, Y, seed) * 13), sy = Y + 5 + Math.floor(hash(X, Y + i * 3, seed) * 7);
          s += r(sx, sy, 2, 1, inks[Math.floor(hash(X + i, Y + i, seed) * inks.length)]);
        }
        if (k > 0.5) { // paint tubes
          for (let i = 0; i < 3; i++) s += r(X + 2 + i * 3, Y + 6, 2, 5, inks[Math.floor(hash(X + i * 7, Y, seed) * inks.length)]) + r(X + 2 + i * 3, Y + 6, 2, 1, '#e0dbcd');
        } else { // jar of brushes
          s += r(X + 4, Y + 7, 5, 5, '#cfd8dc') + r(X + 4, Y + 7, 5, 1, '#e6ecee');
          for (let i = 0; i < 3; i++) s += r(X + 5 + i, Y + 3, 1, 4, P.woodDk) + r(X + 5 + i, Y + 3, 1, 1, inks[Math.floor(hash(X + i * 5, Y + 2, seed) * inks.length)]);
        }
        s += r(X + 11, Y + 8, 4, 3, '#e8e2d2') + r(X + 11, Y + 8, 4, 1, P.white); // rag / palette paper
        return s;
      }
      case 'Y': { // nanoclaw: control console run — sloped desk of dials and readouts, not an office desk
        let s = r(X, Y + 6, 16, 9, '#8d939a') + r(X, Y + 6, 16, 1, '#a7adb4') + r(X, Y + 14, 16, 1, '#6d737a');
        if (capL) s += r(X, Y + 6, 1, 9, '#6d737a');
        if (capR) s += r(X + 15, Y + 6, 1, 9, '#6d737a');
        s += r(X, Y + 2, 16, 4, '#5f666d') + r(X, Y + 2, 16, 1, '#767d85'); // sloped readout panel
        for (let i = 0; i < 3; i++) {
          const gx = X + 1 + i * 5, kk = hash(gx, Y, seed);
          s += r(gx, Y + 3, 4, 2, kk > 0.5 ? '#5a9ab5' : '#57917d') + r(gx, Y + 3, 4, 1, kk > 0.5 ? '#8fc8de' : '#9ad8c0');
          s += r(gx + 1, Y + 8, 3, 3, '#e8e4d8') + r(gx + 2, Y + 9, 1, 1, '#b8574a'); // dial
        }
        s += r(X + 11, Y + 8, 4, 4, '#3f4a54') + r(X + 12, Y + 9, 2, 2, '#7fb2cf');
        return s;
      }
      case 'q': { // nanoclaw: wall queue board — the call floor's one unmistakable cue: waiting/handled counters
        let s = r(X, Y, 16, 13, '#2f343b') + r(X, Y, 16, 1, '#464d56') + r(X, Y + 12, 16, 1, '#23272c');
        s += r(X + 1, Y + 1, 14, 11, '#1f3a4a');
        for (let row = 0; row < 3; row++) {
          const ry = Y + 2 + row * 3;
          s += r(X + 2, ry, 5, 2, '#4d7f96'); // label bar
          const n = Math.floor(hash(X + row * 5, Y, seed) * 3);
          for (let d = 0; d <= n; d++) s += r(X + 9 + d * 2, ry, 1, 2, row === 0 ? '#e0b35a' : row === 1 ? '#6fd68f' : '#d97b6a');
        }
        return s;
      }
      case 'X': { // nanoclaw: credenza — low closed cabinet for the boardroom wall
        let s = r(X, Y + 3, 16, 10, '#8a6440') + r(X, Y + 3, 16, 2, '#a37d52') + r(X, Y + 12, 16, 1, '#67492c');
        s += r(X + 1, Y + 6, 6, 5, '#75542f') + r(X + 9, Y + 6, 6, 5, '#75542f');
        s += r(X + 3, Y + 8, 2, 1, '#c9b48f') + r(X + 11, Y + 8, 2, 1, '#c9b48f'); // handles
        return s;
      }
      case 'H': { // nanoclaw: wall chart — an actual bar-and-trend chart, not a blank whiteboard
        let s = r(X, Y, 16, 12, '#cfc9ba') + r(X + 1, Y + 1, 14, 9, P.white);
        s += r(X + 2, Y + 9, 12, 1, '#a8a294') + r(X + 2, Y + 2, 1, 8, '#a8a294'); // axes
        for (let i = 0; i < 5; i++) { // bars
          const bh = 1 + Math.floor(hash(X + i * 3, Y, seed) * 6);
          s += r(X + 4 + i * 2, Y + 9 - bh, 1, bh, i % 2 ? '#5b86ad' : '#7f9c5c');
        }
        for (let i = 0; i < 5; i++) s += r(X + 4 + i * 2, Y + 6 - Math.floor(hash(X + i, Y + 3, seed) * 3), 2, 1, '#c8624f'); // trend
        s += r(X, Y + 11, 16, 2, '#b9b2a2');
        return s;
      }
      case 'y': { // nanoclaw: print rack — leaning boards of work, the studio's working mass
        const inks = ['#c8624f', '#5b86ad', '#7f9c5c', '#c08a2e', '#8c6ea0'];
        let s = r(X + 1, Y + 12, 14, 2, P.woodDk) + r(X + 1, Y + 14, 2, 2, P.woodDk) + r(X + 12, Y + 14, 2, 2, P.woodDk);
        for (let i = 0; i < 4; i++) {
          const bx = X + 2 + i * 3;
          s += r(bx, Y + 2 + i, 3, 11 - i, inks[Math.floor(hash(bx, Y + i, seed) * inks.length)]);
          s += r(bx, Y + 2 + i, 3, 1, P.paper);
        }
        return s;
      }
      case ',': { // nanoclaw: poster stack leaning on the floor
        const inks = ['#c8624f', '#5b86ad', '#7f9c5c', '#c08a2e'];
        let s = '';
        for (let i = 0; i < 3; i++) {
          s += r(X + 2 + i, Y + 6 + i * 2, 11 - i * 2, 8 - i * 2, inks[Math.floor(hash(X + i * 5, Y, seed) * inks.length)]);
          s += r(X + 2 + i, Y + 6 + i * 2, 11 - i * 2, 1, P.paper);
        }
        return s;
      }
      case '!': { // nanoclaw: copier bank — gives the bare hallway one thing to be
        let s = r(X + 1, Y + 2, 14, 12, '#b6bbc0') + r(X + 1, Y + 2, 14, 2, '#ced3d7') + r(X + 1, Y + 13, 14, 1, '#8f959a');
        s += r(X + 2, Y + 5, 12, 3, '#6f767c') + r(X + 3, Y + 6, 10, 1, '#8f959a'); // output tray
        s += r(X + 3, Y + 9, 5, 3, '#e8e4d8') + r(X + 3, Y + 9, 5, 1, P.white); // paper
        s += r(X + 10, Y + 9, 3, 2, '#3f4a54') + r(X + 11, Y + 9, 1, 1, '#6fd68f');
        return s;
      }
      case '+': { // nanoclaw: pipe junction — flanged elbow box where a header meets a riser
        const pb = '#9fa8ae', ph = '#bec6cb', pd = '#7b838a';
        let s = r(X, Y + 4, 16, 7, pb) + r(X, Y + 4, 16, 2, ph) + r(X, Y + 10, 16, 1, pd); // through the header
        s += r(X + 4, Y, 7, 16, pb) + r(X + 4, Y, 2, 16, ph) + r(X + 10, Y, 1, 16, pd);   // through the riser
        s += r(X + 2, Y + 2, 11, 11, pb) + r(X + 2, Y + 2, 11, 1, ph) + r(X + 2, Y + 12, 11, 1, pd); // elbow body
        s += r(X + 1, Y + 1, 13, 2, pd) + r(X + 1, Y + 13, 13, 2, pd); // bolt flanges
        for (let i = 2; i < 13; i += 4) s += r(X + i, Y + 1, 1, 1, '#d6dbdf') + r(X + i, Y + 14, 1, 1, '#d6dbdf');
        return s;
      }
      case 'R': { // nanoclaw: shop robot — HUMAN-scale (matches the 20x22 agent sprite, drawn up out
        // of its tile) and warm-painted, so it reads as a character rather than a filing cabinet.
        const bd = '#c2814f', bh = '#d99c68', bk = '#96603a', st = '#8f959b';
        let s = r(X + 3, Y + 15, 10, 4, st) + r(X + 3, Y + 15, 10, 1, '#adb3b8') + r(X + 3, Y + 19, 10, 1, '#6d737a'); // tracked base
        s += r(X + 4, Y + 5, 8, 10, bd) + r(X + 4, Y + 5, 8, 1, bh) + r(X + 4, Y + 14, 8, 1, bk); // torso
        s += r(X + 1, Y + 6, 3, 7, bd) + r(X + 1, Y + 6, 3, 1, bh) + r(X + 12, Y + 6, 3, 7, bd) + r(X + 12, Y + 6, 3, 1, bh); // arms
        s += r(X + 1, Y + 12, 3, 2, st) + r(X + 12, Y + 12, 3, 2, st); // grippers
        s += r(X + 4, Y - 3, 8, 7, bd) + r(X + 4, Y - 3, 8, 1, bh) + r(X + 4, Y + 3, 8, 1, bk); // head
        s += r(X + 5, Y - 1, 6, 3, '#2f343b') + r(X + 6, Y, 2, 1, '#5fbfd6') + r(X + 9, Y, 1, 1, '#5fbfd6'); // visor
        s += r(X + 6, Y - 5, 4, 2, st) + r(X + 7, Y - 6, 2, 1, '#b8574a'); // antenna
        s += r(X + 6, Y + 8, 4, 3, '#4a5058') + r(X + 7, Y + 9, 2, 1, '#e8e4d8'); // chest panel
        return s;
      }
      case 'V': { // nanoclaw: mission-control monitor wall — one continuous bank, screen contents vary by hash
        const fr = '#2f343b', frHi = '#454c55';
        let s = r(X, Y, 16, 13, fr) + r(X, Y, 16, 1, frHi) + r(X, Y + 12, 16, 1, '#23272c');
        for (let row = 0; row < 2; row++) {
          const sy = Y + 1 + row * 6, gx = X + (capL ? 1 : 0), gw = 16 - (capL ? 1 : 0) - (capR ? 1 : 0);
          const kk = hash(X, Y + row * 7, seed);
          s += r(gx, sy, gw, 5, kk > 0.66 ? '#33506b' : kk > 0.33 ? '#2f5c5a' : '#3d4a63');
          if (kk > 0.66) {
            for (let i = 0; i < 4; i++) { const bh = 1 + Math.floor(hash(X + i, sy, seed) * 4); s += r(X + 1 + i * 4, sy + 5 - bh, 3, bh, '#79b6d8'); }
          } else if (kk > 0.33) {
            s += r(X + 2, sy + 1, 6, 3, '#57917d') + r(X + 9, sy + 2, 4, 2, '#57917d') + r(X + 4, sy + 2, 2, 1, '#9ad8c0');
          } else {
            s += r(gx, sy + 3, gw, 1, '#6f8fc4') + r(X + 3, sy + 2, 4, 1, '#9db6e0') + r(X + 10, sy + 1, 3, 1, '#9db6e0');
          }
        }
        if (capL) s += r(X, Y, 1, 13, frHi);
        if (capR) s += r(X + 15, Y, 1, 13, frHi);
        return s;
      }
      case 'z': { // nanoclaw: bean bag — blocky squashed square with a SIT-DENT; the dent is what says "seat"
        const pal = [['#b08a6f', '#c4a087', '#8f6d55'], ['#8a95a3', '#a1acb8', '#6f7987'], ['#9aa585', '#b1bc9c', '#7d876b']][Math.floor(k * 3) % 3];
        let s = r(X + 2, Y + 5, 12, 9, pal[0]) + r(X + 3, Y + 4, 10, 1, pal[0]) + r(X + 1, Y + 7, 1, 5, pal[0]) + r(X + 14, Y + 7, 1, 5, pal[0]);
        s += r(X + 3, Y + 5, 10, 1, pal[1]) + r(X + 2, Y + 6, 2, 4, pal[1]); // highlight
        s += r(X + 5, Y + 7, 6, 3, pal[2]) + r(X + 6, Y + 6, 4, 1, pal[2]); // sit-dent
        s += r(X + 2, Y + 13, 12, 1, pal[2]) + r(X + 4, Y + 14, 8, 1, pal[2]);
        return s;
      }
      case 'A': { // nanoclaw: conveyor run — belt over rollers, legs at the caps, parts riding it
        const fr = '#8d939a', frHi = '#a7adb4', frDk = '#6d737a', belt = '#4e545b';
        let s = r(X, Y + 3, 16, 11, fr) + r(X, Y + 3, 16, 1, frHi) + r(X, Y + 13, 16, 1, frDk);
        s += r(X, Y + 5, 16, 7, belt) + r(X, Y + 5, 16, 1, '#61686f');
        for (let i = 0; i < 4; i++) s += r(X + 1 + i * 4, Y + 5, 1, 7, '#3f454c');
        // nanoclaw: the line has to be driven by something — motor housing on each end
        if (capL) s += r(X, Y + 2, 4, 13, '#6a7078') + r(X, Y + 2, 4, 1, '#868d95') + r(X + 1, Y + 6, 2, 4, '#4a5058') + r(X + 1, Y + 15, 2, 2, frDk);
        if (capR) s += r(X + 12, Y + 2, 4, 13, '#6a7078') + r(X + 12, Y + 2, 4, 1, '#868d95') + r(X + 13, Y + 6, 2, 4, '#4a5058') + r(X + 13, Y + 15, 2, 2, frDk);
        if (k > 0.55) s += r(X + 5, Y + 6, 6, 5, P.box) + r(X + 5, Y + 6, 6, 1, P.boxHi) + r(X + 5, Y + 10, 6, 1, P.boxDk);
        else if (k > 0.28) s += r(X + 6, Y + 7, 4, 3, '#b08a52') + r(X + 6, Y + 7, 4, 1, '#c9a068');
        return s;
      }
      case 'I': { // nanoclaw: process pipe run along a top/bottom wall, flanged at each joint
        const pb = '#9fa8ae', ph = '#bec6cb', pd = '#7b838a';
        let s = r(X, Y + 4, 16, 7, pb) + r(X, Y + 4, 16, 2, ph) + r(X, Y + 10, 16, 1, pd);
        s += r(X + 7, Y + 3, 2, 9, pd) + r(X + 7, Y + 3, 2, 1, ph);
        // nanoclaw: a run has to END somewhere — cap it with a bolted blind flange, not a raw cut
        if (capL) s += r(X, Y + 2, 3, 11, pd) + r(X, Y + 2, 3, 1, ph) + r(X + 1, Y + 4, 1, 1, '#d6dbdf') + r(X + 1, Y + 9, 1, 1, '#d6dbdf');
        if (capR) s += r(X + 13, Y + 2, 3, 11, pd) + r(X + 13, Y + 2, 3, 1, ph) + r(X + 14, Y + 4, 1, 1, '#d6dbdf') + r(X + 14, Y + 9, 1, 1, '#d6dbdf');
        return s;
      }
      case 'i': { // nanoclaw: process pipe run down a side wall
        const pb = '#9fa8ae', ph = '#bec6cb', pd = '#7b838a';
        return r(X + 4, Y, 7, 16, pb) + r(X + 4, Y, 2, 16, ph) + r(X + 10, Y, 1, 16, pd) +
          r(X + 3, Y + 7, 9, 2, pd) + r(X + 3, Y + 7, 1, 2, ph);
      }
      case 'v': { // nanoclaw: inline valve — pipe segment with a red handwheel
        const pb = '#9fa8ae', ph = '#bec6cb', pd = '#7b838a';
        let s = r(X, Y + 4, 16, 7, pb) + r(X, Y + 4, 16, 2, ph) + r(X, Y + 10, 16, 1, pd);
        s += r(X + 5, Y + 2, 6, 9, pd) + r(X + 5, Y + 2, 6, 1, ph);
        s += r(X + 4, Y, 8, 3, '#b8574a') + r(X + 4, Y, 8, 1, '#cd6d5f') + r(X + 7, Y + 2, 2, 3, '#8f4038');
        return s;
      }
      case 'N': { // nanoclaw: process tank — WIDE banded cylinder, riveted seams, face gauge, on legs
        const tb = '#aeb4b9', th = '#cfd5d9', td = '#848b91', tk = '#6d747a';
        let s = r(X + 7, Y - 5, 2, 5, td) + r(X + 6, Y - 6, 4, 2, '#b8574a') + r(X + 6, Y - 6, 4, 1, '#cd6d5f'); // top valve
        s += r(X + 3, Y - 1, 10, 2, tb) + r(X + 3, Y - 1, 10, 1, th) + r(X + 1, Y + 1, 14, 2, tb) + r(X + 1, Y + 1, 4, 2, th); // wide dome
        s += r(X, Y + 3, 16, 11, tb) + r(X + 1, Y + 3, 4, 11, th) + r(X + 13, Y + 3, 3, 11, td); // full-width shell
        s += r(X, Y + 5, 16, 2, td) + r(X, Y + 6, 16, 1, tk) + r(X, Y + 10, 16, 2, td) + r(X, Y + 11, 16, 1, tk); // hoop bands
        for (let i = 1; i < 16; i += 3) s += r(X + i, Y + 5, 1, 1, '#dde2e5') + r(X + i, Y + 10, 1, 1, '#dde2e5'); // rivets
        s += r(X + 6, Y + 7, 4, 3, '#3f6d84') + r(X + 6, Y + 8, 4, 2, '#5a9ab5') + r(X + 6, Y + 8, 4, 1, '#8fc8de'); // sight glass
        s += r(X + 11, Y + 7, 4, 4, '#e8e4d8') + r(X + 11, Y + 7, 4, 1, '#f3f0e6') + r(X + 12, Y + 8, 2, 2, '#b8574a'); // face gauge
        s += r(X, Y + 14, 16, 1, tk) + r(X + 2, Y + 15, 3, 1, tk) + r(X + 11, Y + 15, 3, 1, tk); // legs
        return s;
      }
      case 'G': { // nanoclaw: gauge panel — three dials over a readout strip
        let s = r(X, Y, 16, 12, '#8b9095') + r(X, Y, 16, 1, '#a5aaaf') + r(X, Y + 11, 16, 1, '#6d7276');
        for (let i = 0; i < 3; i++) {
          const gx = X + 1 + i * 5;
          s += r(gx, Y + 2, 4, 4, '#e8e4d8') + r(gx, Y + 2, 4, 1, '#f3f0e6') + r(gx + 1, Y + 3, 2, 2, hash(gx, Y, seed) > 0.5 ? '#c8624f' : '#5b86ad');
        }
        s += r(X + 1, Y + 7, 14, 3, '#3f4a54') + r(X + 2, Y + 8, 5, 1, '#7fb2cf') + r(X + 9, Y + 8, 3, 1, '#6f9c5a');
        return s;
      }
      case 'Z': { // nanoclaw: test rig — OPEN gantry (the hollow middle is what keeps it from reading as a cabinet)
        const fb = '#8f959b', fh = '#b3b9be', fd = '#666c72';
        let s = r(X + 1, Y + 1, 14, 3, fb) + r(X + 1, Y + 1, 14, 1, fh) + r(X + 1, Y + 3, 14, 1, fd); // crossbeam
        s += r(X + 1, Y + 4, 3, 10, fb) + r(X + 1, Y + 4, 1, 10, fh) + r(X + 3, Y + 4, 1, 10, fd);
        s += r(X + 12, Y + 4, 3, 10, fb) + r(X + 12, Y + 4, 1, 10, fh) + r(X + 14, Y + 4, 1, 10, fd);
        s += r(X, Y + 14, 5, 2, fd) + r(X + 11, Y + 14, 5, 2, fd); // feet
        s += r(X + 7, Y + 4, 1, 4, '#7e848a'); // cable
        const pc = k > 0.5 ? ['#c08a2e', '#d7a44b', '#96691f'] : ['#b8574a', '#cd6d5f', '#8f4038'];
        s += r(X + 5, Y + 8, 6, 5, pc[0]) + r(X + 5, Y + 8, 6, 1, pc[1]) + r(X + 5, Y + 12, 6, 1, pc[2]);
        return s;
      }
      case 'Q': { // nanoclaw: crash-test dummy — hazard-striped body, blank head
        let s = r(X + 6, Y + 12, 4, 3, '#6f757b') + r(X + 5, Y + 15, 6, 1, '#5b6167');
        s += r(X + 5, Y + 5, 6, 8, '#e0c05a') + r(X + 5, Y + 5, 6, 1, '#f0d478') + r(X + 5, Y + 12, 6, 1, '#a98d34');
        for (let i = 0; i < 3; i++) s += r(X + 5, Y + 6 + i * 3, 6, 1, '#4a4237');
        s += r(X + 3, Y + 6, 2, 5, '#e0c05a') + r(X + 11, Y + 6, 2, 5, '#e0c05a');
        s += r(X + 6, Y + 1, 5, 5, '#ded8c8') + r(X + 6, Y + 1, 5, 1, '#efe9da') + r(X + 6, Y + 5, 5, 1, '#b8b2a0');
        s += r(X + 7, Y + 3, 1, 1, '#4a3a2e') + r(X + 9, Y + 3, 1, 1, '#4a3a2e');
        return s;
      }
      case '%': { // nanoclaw: scorch stain. Two flat dark tones only — an outline or a
        // lighter centre turned it into a rock/gear; a burn has no rim and no highlight.
        // Stepped and irregular per tile so no two burns are the same stamp.
        const a = '#b3aa9d', b2 = '#948b7f';
        const w1 = 6 + Math.floor(hash(X, Y, seed) * 4), w2 = 3 + Math.floor(hash(X + 5, Y, seed) * 3);
        const ox = Math.floor(hash(X, Y + 3, seed) * 3), oy = Math.floor(hash(X + 3, Y, seed) * 3);
        let s = r(X + 2 + ox, Y + 5 + oy, w1 + 3, 4, a) + r(X + 4 + ox, Y + 3 + oy, w1, 8, a) + r(X + 3 + ox, Y + 4 + oy, w1 + 1, 6, a);
        s += r(X + 4 + ox, Y + 6 + oy, w2 + 2, 3, b2) + r(X + 5 + ox, Y + 5 + oy, w2, 5, b2);
        for (let i = 0; i < 3; i++) s += r(X + 1 + Math.floor(hash(X + i, Y, seed) * 12), Y + 2 + Math.floor(hash(X, Y + i, seed) * 12), 2, 1, a);
        return s;
      }
      case 'E': { // nanoclaw: easel — splayed legs, canvas with a work in progress
        let s = r(X + 2, Y + 11, 2, 5, P.woodDk) + r(X + 12, Y + 11, 2, 5, P.woodDk) + r(X + 7, Y + 12, 2, 4, P.wood);
        s += r(X + 2, Y + 2, 12, 10, P.wood) + r(X + 2, Y + 2, 12, 1, P.woodHi) + r(X + 2, Y + 11, 12, 1, P.woodDk);
        s += r(X + 3, Y + 3, 10, 8, P.paper) + r(X + 3, Y + 3, 10, 1, P.white);
        const inks = ['#c8624f', '#5b86ad', '#7f9c5c', '#c08a2e', '#8c6ea0'];
        for (let i = 0; i < 3; i++) {
          s += r(X + 4 + Math.floor(hash(X + i, Y, seed) * 4), Y + 4 + i * 2, 3 + Math.floor(hash(X, Y + i, seed) * 4), 2, inks[Math.floor(hash(X + i * 5, Y + i, seed) * inks.length)]);
        }
        return s;
      }
      case 'U': { // nanoclaw: poster wall — a run of pinned prints, colours vary by hash
        const inks = ['#c8624f', '#5b86ad', '#7f9c5c', '#c08a2e', '#8c6ea0', '#4a8f8a'];
        let s = r(X, Y, 16, 12, '#cfc6b2') + r(X, Y, 16, 1, '#e0d8c6') + r(X, Y + 11, 16, 1, '#b5ab96');
        for (let i = 0; i < 2; i++) {
          const px0 = X + 1 + i * 8, kk = hash(X + i * 3, Y, seed);
          s += r(px0, Y + 1, 6, 9, inks[Math.floor(kk * inks.length)]);
          s += r(px0, Y + 1, 6, 1, P.paper) + r(px0 + 1, Y + 3, 4, 2, P.paper) + r(px0 + 1, Y + 7, 3, 1, P.paper);
        }
        return s;
      }
      case 'n': { // nanoclaw: raven on a perch
        const fe = '#2f333a', fh = '#474d57';
        let s = r(X + 6, Y + 11, 3, 5, P.woodDk) + r(X + 2, Y + 9, 12, 2, P.wood) + r(X + 2, Y + 9, 12, 1, P.woodHi);
        s += r(X + 5, Y + 4, 7, 5, fe) + r(X + 5, Y + 4, 7, 1, fh) + r(X + 10, Y + 5, 4, 4, fe) + r(X + 10, Y + 5, 4, 1, fh);
        s += r(X + 5, Y + 1, 4, 4, fe) + r(X + 5, Y + 1, 4, 1, fh);
        s += r(X + 2, Y + 3, 3, 2, '#8f8a7c') + r(X + 2, Y + 3, 3, 1, '#aaa496');
        s += r(X + 7, Y + 2, 1, 1, '#dcd6c7');
        s += r(X + 6, Y + 9, 1, 2, '#8a8378') + r(X + 9, Y + 9, 1, 2, '#8a8378');
        return s;
      }
      case 'J': { // nanoclaw: boardroom table run — dark wood top, papers and cups vary by hash
        let s = r(X, Y - 1, 16, 18, '#7d5738') + r(X, Y - 1, 16, 3, '#9c7149') + r(X, Y + 14, 16, 3, '#5f4029');
        if (capL) s += r(X, Y - 1, 2, 18, '#5f4029') + r(X + 1, Y + 17, 3, 1, '#4e3521');
        if (capR) s += r(X + 14, Y - 1, 2, 18, '#5f4029') + r(X + 12, Y + 17, 3, 1, '#4e3521');
        if (k > 0.6) s += r(X + 3, Y + 4, 6, 4, P.paper) + r(X + 3, Y + 4, 6, 1, P.white) + r(X + 4, Y + 6, 4, 1, '#cfcabb');
        if (k > 0.4) s += r(X + 11, Y + 5, 3, 3, P.white) + r(X + 11, Y + 5, 3, 1, '#e8e3d6');
        if (k < 0.3) s += r(X + 5, Y + 9, 5, 3, '#5b86ad') + r(X + 5, Y + 9, 5, 1, '#7099c0');
        return s;
      }
      case 'F': { // nanoclaw: server rack — slotted chassis with link LEDs
        const cb = '#3d434a', ch = '#555d65', cd = '#2b3036';
        let s = r(X + 1, Y, 14, 15, cb) + r(X + 1, Y, 14, 1, ch) + r(X + 1, Y + 14, 14, 1, cd);
        for (let j = 0; j < 5; j++) {
          const sy = Y + 1 + j * 3;
          s += r(X + 2, sy, 12, 2, '#4d545c') + r(X + 2, sy, 12, 1, '#5e666f');
          s += r(X + 3, sy, 1, 1, hash(X, sy, seed) > 0.4 ? '#6fd68f' : '#c08a2e');
          s += r(X + 5, sy, 1, 1, hash(X + 3, sy, seed) > 0.6 ? '#7fb2cf' : '#4d545c');
        }
        return s;
      }
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
    /* nanoclaw: THEMED — the call floor. Three runs of phone/headset desks,
     * whiteboards and queue displays on the top wall, carpet so it reads
     * soft against the factory/plant concrete. */
    westFront: {
      label: 'room one', floor: 'carpetWarm', open: 22, state: 'blocked', wall: '#9ab6c4',
      grid: [
        'qq.wwww.qq.ww.p',
        'PPPPPPPP.PPPPP.',
        '..1..2...c.c.c.',
        'W.PPPPPP.PPPP.B',
        'p.cccccc.cccc.p',
        'W.c..c...c..c.e',
        'PPPPPP.PPPPPP.p',
      ],
      agents: [
        { name: 'one', status: 'blocked', shirt: '#5b86ad', shirtHi: '#6f9bc2', hair: '#3a2e26', hairHi: '#4b3c31' },
        { name: 'two', status: 'working', shirt: '#7f9c5c', shirtHi: '#93b06d', hair: '#7a4f2c', hairHi: '#8f6038', skin: '#f0cfa8' },
      ],
    },
    /* nanoclaw: GENERIC — deliberately untouched. Unthemed and brand-new
     * channels land here, so it has to keep looking like the plain office the
     * whole floor used to be. */
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
    /* nanoclaw: THEMED — the BBQ room, played straight. The smoker is the
     * hero: a four-tile barrel on the top wall whose chimney pokes through the
     * roofline, with the meat rack next to it and prep counters either side.
     * `fx.at` is that chimney tile — the smoke plume hangs off it. */
    kitchen: {
      label: 'room three', floor: 'quarry', open: 31, state: 'blocked', wall: '#b08a6a',
      // nanoclaw: `at` = the chimney tile (run's left cap), `ember` = the firebox drum on the right cap
      fx: { kind: 'smoke', at: [0, 0], ember: [2, 0] },
      grid: [
        'MMM..mmm.kkk.',
        '...R..2....u.',
        'f.1.kkkk...xB',
        'f...uuuu...pB',
        'p...mmm....xs',
        'p.kkkkkk..ppx',
      ],
      agents: [
        { name: 'four', status: 'working', shirt: '#8c6ea0', shirtHi: '#a081b5', hair: '#241c17', skin: '#c68f63', skinDk: '#a87549' },
        { name: 'five', status: 'idle', shirt: '#4f5560', shirtHi: '#626875', hair: '#1f1a16' },
      ],
    },
    /* nanoclaw: THEMED — mission control. The whole top wall is one
     * continuous monitor bank, a console arc faces it, and the command desk sits
     * dead centre with its seat looking straight up at the wall. `fx.at` covers
     * the monitor run so the glow lights exactly those tiles. */
    westBack: {
      label: 'room four', floor: 'carpetSlate', open: 6, state: 'working', wall: '#8fa0bd',
      fx: { kind: 'glow', at: [0, 0, 13, 1] },
      grid: [
        'VVVVVVVVVVVVV.p',
        'YYYYY.YYYYY.YY.',
        'cc2cc.ccccc.cc.',
        'F.............F',
        '..YYYYYYYYYYY..',
        '..ccccc1ccccc..',
        'W.....H.......e',
      ],
      agents: [{ name: 'six', status: 'working', shirt: '#6f9b6a', shirtHi: '#82b07c', hair: '#241c17', skin: '#e8c091' }],
    },
    /* nanoclaw: THEMED — the intern library, a study room that softens into a
     * lounge: shelf wall and two study tables up top, then couches, bean bags
     * and lamps over a rug. Wood floor, warm parchment walls. */
    eastBack: {
      label: 'room five', floor: 'wood', open: 0, state: 'idle', wall: '#cbbfa2',
      /* nanoclaw: muted dusty blue. rugFill lays vertical accent stripes, so ANY
       * warm rug on a wood floor reads as more floorboards — clay failed for
       * exactly the reason the teal did. It has to be a cool tone to read as a
       * rug at all; this one sits with the carpet/steel end of the palette. */
      rug: [2, 4, 9, 2, '#93a0ad', '#7b8896', true],
      grid: [
        'bbbb.bbb.bb.p',
        '..JJ...JJ....',
        '..1.....2...B',
        'O.........L.B',
        'O...z.z.z...p',
        'O..z..z..z..B',
        'p.oo.bbb.oo.p',
      ],
      agents: [],
    },
    garage: {
      // nanoclaw: open 2 -> 0. Only the five SLOT rooms take live counts, so the
      // garage kept the authored demo number and rendered it as if it were real.
      label: 'garage', floor: 'bays', open: 0, state: 'idle', dead: true, wall: '#b3aea4',
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
    /* nanoclaw: THEMED — the factory floor, an actual factory interior. Two
     * conveyor runs cross the floor, workbenches sit between them, crates
     * stack in the corners, concrete underfoot. */
    eastWingN: {
      label: 'room six', floor: 'factory', open: 0, state: 'idle', wall: '#b6a37f',
      grid: [
        'hhhh..ee..hhhh.',
        'AAAAAAAAAAAAAAA',
        '..1......2...x.',
        'x...........xx.',
        'x..hhhh..hhhh.x',
        'p..AAAAAAAAAAAA',
        'xx.........xxxp',
      ],
      agents: [],
    },
    /* nanoclaw: THEMED — the plant room. Data pipelines drawn as literal
     * pipelines. The plumbing has to close: headers run the top and
     * bottom walls, a riser joins them down the left wall through `+` elbow
     * junctions at both corners, and the far ends are blind-flanged rather than
     * just stopping. Tank farm on the floor, gauge panel and console by the door. */
    eastWingM: {
      label: 'room seven', floor: 'raised', open: 0, state: 'idle', wall: '#9db3a4',
      grid: [
        '+IvIIIIvIIII.GG',
        'i.YYY.N...YYYY.',
        'i.2.......1.c..',
        'i...N...N...N..',
        'i.............x',
        'i...N...N.NNN..',
        '+IIvIIIIIIII.p.',
      ],
      agents: [],
    },
    /* nanoclaw: THEMED — the proving ground. Gantry rigs top and
     * bottom, crash dummies standing around between them, scorch marks burnt
     * into bare concrete, telemetry displays on the walls. */
    eastWingS: {
      label: 'room eight', floor: 'epoxy', open: 0, state: 'idle', wall: '#b3a2a8',
      grid: [
        'ee..ZZZZ..ee.x.',
        '...%1%.2%.....x',
        'W..%.%Q%......x',
        'W.ZZZ...ZZZ...x',
        'x.%%%Q.%%%%Q..e',
        'x..%..hhhh.%..x',
      ],
      agents: [],
    },
    /* nanoclaw: THEMED — the studio, a creative space. Poster walls top and
     * bottom, easels facing them with the seats at the easel, a worktable run
     * across the middle, and the raven on its perch by the right wall. */
    southWest: {
      // nanoclaw: no rug. The centre slab read as a swimming pool; the studio's own
      // working mass — worktable run, print rack, poster stacks — owns the middle instead.
      label: 'room nine', floor: 'wood', open: 0, state: 'idle', wall: '#b8a2bd',
      grid: [
        'UUUUU..UUUU..p.',
        '..E...E....E...',
        '..1...2......y.',
        'W..&&&&&&&...y.',
        'O..u.uu..u.u..n',
        'p.,.E.,,..E.,.x',
        'p..UUUU..UUU.pp',
      ],
      agents: [],
    },
    /* nanoclaw: THEMED — the boardroom. One long table run with chairs down
     * both sides, wall charts and displays above it, plants, and nothing
     * else: the emptiness is the point of a boardroom. */
    southMid: {
      label: 'room ten', floor: 'carpet', open: 0, state: 'idle', wall: '#a8aec2',
      grid: [
        'HH..ee..HH.p.',
        '.ccccccccc...',
        '.JJJJJJJJJ...',
        '.1cccc2cc....',
        'W..........pB',
        'p.XXX..XXX.pp',
      ],
      agents: [],
    },
    /* nanoclaw: THEMED — the NOC annex, a small ops room off the boardroom.
     * Wall of displays, two short desk runs, server racks down the left wall. */
    southEast: {
      label: 'room eleven', floor: 'noc', open: 0, state: 'idle', wall: '#9fa8ab',
      grid: [
        'eeee..eee.FF.',
        'YYYY..YYY....',
        'cc1c..cc2....',
        'F..........pW',
        'F.cccc.cccc.p',
        'p.YYYY.YYYY.p',
      ],
      agents: [],
    },
    hall: {
      label: 'hallway', floor: 'brick', open: 0, state: 'idle', quiet: true,
      // nanoclaw: a copier bank and a bench in the middle, so the corridor is a place
      // rather than a bare brick band the eye slides off.
      grid: ['p...x..!!.b...p', '..x....oo...p..', 'B....p.....x..B'],
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
      /* nanoclaw: TRUNK BUG. Doors are painted AFTER the room floors, so a door
       * rect that overlaps a room paints a brick slab across that room's floor.
       * `[43,26,2,3]` and `[51,24,4,1]` both reached into eastWingS and had been
       * doing so since the wing was added. Moved clear of the room rectangle;
       * both still land on the yard path they connect to. Path rects that
       * overlap rooms are harmless — paths are drawn BEFORE room floors — so
       * those are deliberately left alone. Verified by scripts/decorcheck. */
      doors: [
        [13, 11, 2, 1], [13, 16, 2, 1], [22, 12, 1, 2], [22, 6, 1, 2], [22, 19, 1, 2],
        [37, 8, 4, 1], [37, 16, 4, 1], [40, 11, 1, 2], [40, 20, 1, 2],
        [57, 8, 4, 1], [13, 26, 2, 3], [29, 26, 2, 3], [43, 28, 2, 2], [56, 24, 2, 2],
      ],
      /* nanoclaw: the two east-wing bridges stopped one tile short of the wall
       * they lead to, leaving a grass gap mid-crossing. Widened 3 -> 4. */
      paths: [
        [37, 8, 4, 1], [37, 16, 4, 1], [57, 8, 4, 1],
        [13, 26, 2, 3], [29, 26, 2, 3], [43, 26, 2, 3],
        [12, 27, 32, 2], [58, 12, 3, 16], [51, 24, 8, 2], [53, 28, 16, 2], [61, 13, 4, 2],
      ],
      pool: [58, 30, 11, 6],
      decor: [
        ['palm', 1, 5], ['palm', 2, 18], ['tree', 0, 25], ['bush', 4, 11], ['bush', 4, 22],
        ['tree', 77, 4], ['palm', 76, 15], ['palm', 77, 30], ['bush', 38, 40], ['bush', 16, 41],
        ['tree', 25, 0], ['bush', 46, 0], ['palm', 33, 0], ['palm', 59, 0],
        ['lounger', 58, 37], ['lounger', 61, 37], ['umbrella', 64, 36], ['table', 70, 31],
        ['bench', 16, 26], ['bench', 34, 26], ['car', 66, 14], ['hoop', 71, 24],
        ['bush', 74, 39], ['bush', 8, 0], ['bush', 52, 40], ['tree', 2, 40], ['bush', 20, 40],
        /* nanoclaw: TRUNK BUG. Four props were placed inside building footprints —
         * three palms and a bench growing through the factory, the testing bay and
         * the garage roof. Relocated to verified lawn, clear of buildings, pool and
         * paths. `bench` came out of the same sweep, not the original report. */
        ['palm', 63, 20], ['palm', 63, 26], ['tree', 71, 40], ['bush', 70, 20], ['bush', 30, 41],
        ['bush', 0, 33], ['palm', 2, 33], ['palm', 74, 16], ['tree', 59, 0], ['bush', 46, 41],
      ],
    },
    compound: {
      world: [60, 36],
      buildings: [[5, 3, 17, 11], [24, 3, 15, 16], [41, 3, 15, 10], [5, 17, 17, 10], [23, 24, 14, 10]],
      place: { westFront: [6, 4], eastFront: [25, 4], kitchen: [25, 12], eastBack: [42, 4], westBack: [6, 18], garage: [24, 25] },
      doors: [[13, 14, 2, 1], [31, 11, 2, 1], [31, 19, 2, 1], [48, 13, 2, 1], [13, 27, 2, 1], [29, 34, 2, 1], [22, 8, 1, 2]],
      paths: [[13, 14, 3, 4], [13, 17, 18, 2], [30, 19, 3, 6], [13, 27, 18, 2], [48, 13, 3, 10], [31, 21, 18, 2], [29, 34, 3, 2]],
      pool: [41, 24, 12, 7],
      decor: [['palm', 22, 3], ['palm', 22, 15], ['tree', 1, 8], ['bush', 3, 15], ['tree', 57, 16], ['palm', 39, 6], ['palm', 39, 31], ['bush', 20, 33], ['bush', 34, 21], ['lounger', 41, 32], ['lounger', 44, 32], ['umbrella', 47, 31], ['table', 34, 21], ['bench', 18, 30], ['car', 51, 25], ['bush', 56, 4], ['tree', 1, 30], ['palm', 56, 33], ['bush', 40, 22], ['hoop', 1, 3]],
      // nanoclaw: same sweep — the compound plan had a table and a hoop inside buildings too.
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
      if (R.rug) s += rugFill(rx + R.rug[0], ry + R.rug[1], R.rug[2], R.rug[3], R.rug[4], R.rug[5], R.rug[6]);
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
/* nanoclaw: keep every text chrome element on its own compositing layer. The
   overlay gains and loses layers as rooms start and stop working (fx divs
   appear, idle agents stop bobbing), and Blink was flipping ALL the labels
   between subpixel and greyscale antialiasing when that happened — one room
   starting to cook visibly re-rendered every room name in the building.
   Pinning the layer pins the AA mode. (-webkit-font-smoothing is a no-op
   outside macOS, so it cannot be used for this.) */
.room,.pill,.bub,.sign,.badge{backface-visibility:hidden}
.hit{position:absolute;cursor:pointer;border:0;padding:0;background:transparent}
.hit:focus-visible{outline:2px solid #3f68c9;outline-offset:2px}
/* nanoclaw: the PEOPLE are clickable too, not just the rooms. The visual is
   still the 20x22 sprite; only the hit target is padded, to a fixed 40px box
   centred on the sprite so a finger can land on it at any zoom. */
.ahit{position:absolute;cursor:pointer;border:0;padding:0;background:transparent}
.ahit:focus-visible{outline:2px solid #3f68c9;outline-offset:2px}
.ag{position:absolute;image-rendering:pixelated;background-repeat:no-repeat;background-size:100% 100%;pointer-events:none;animation:bob 3.2s ease-in-out infinite}
.ag.w{animation-duration:1.9s}
.ag.i{animation:none;filter:saturate(.55) brightness(1.02)}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6%)}}
.pill{position:absolute;transform:translate(-50%,-100%);}
.pill.below{transform:translate(-50%,0)}
.pill.below:after{top:-3px;bottom:auto}
.pill{display:flex;align-items:center;gap:5px;background:#2c2822;color:#fbf8f2;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:4px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 4px rgba(40,32,20,.28);pointer-events:none}
.pill:after{content:"";position:absolute;left:50%;bottom:-3px;width:6px;height:6px;background:#2c2822;transform:translateX(-50%) rotate(45deg)}
/* nanoclaw: the pill hangs INSIDE the room, off its BOTTOM-left. Hanging it over
   the TOP edge parked every label on the NEIGHBOUR's floor (the BBQ room's label
   covered a desk row in the room above). Anchoring it inside the top-left instead
   just traded that for covering the room's own agent pills, which cluster in the
   upper rows — so it goes to the bottom edge, where the grids only ever put wall
   furniture and never a seat. Same bottom-anchored trick the sign mode uses. */
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
/* nanoclaw: the two keyed effects. Both are pointer-transparent, both mute with
   everything else when another room is selected, and both stop dead under
   prefers-reduced-motion — the room still reads without them. */
.fx{position:absolute;pointer-events:none}
/* Hard-edged discs, NOT blurred blobs: a gaussian smudge over a crisp-edge
   pixel world reads as a rendering fault. Dense opaque core + a lighter ring
   (the ring is a lighter shade of the puff's own fill) keeps it in the
   tileset's shading language and makes it survive at 1:1 map scale, where the
   earlier translucent version measured ~2/255 against the floor. */
.fx.smoke i{position:absolute;left:50%;bottom:0;display:block;width:calc(11px * var(--s,1));height:calc(11px * var(--s,1));margin-left:calc(-5.5px * var(--s,1));border-radius:50%;background:#6f685c;box-shadow:0 0 0 calc(1.5px * var(--s,1)) #a8a091 inset;opacity:0;animation:puff 2.2s linear infinite}
/* negative delays: the three puffs start already spread across the loop, so the
   plume is continuous from the first painted frame instead of empty for a second */
.fx.smoke i:nth-child(1){animation-delay:-.2s}
.fx.smoke i:nth-child(2){animation-delay:-.93s}
.fx.smoke i:nth-child(3){animation-delay:-1.66s}
/* The small leftward drift is DELIBERATE, not slop: straight up would stack the
   plume on the room label, and drifting left carries it over the corridor and the
   corner of #general rather than across that room's desks. Kept to -1.5px so it
   still reads as leaving the stack mouth. */
@keyframes puff{
  0%{opacity:0;transform:translate(0,0) scale(.5)}
  12%{opacity:1}
  66%{opacity:.92}
  100%{opacity:0;transform:translate(calc(-1.5px * var(--s,1)),calc(-27px * var(--s,1))) scale(2.3)}
}
/* the lit firebox, and the warm light it throws on the floor around the pit */
.fx.ember{border-radius:1px;background:#f5b45e;box-shadow:0 0 0 2px #d97b28 inset;animation:emberpulse 1.7s ease-in-out infinite}
.fx.bounce{border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(240,160,66,.5),rgba(240,160,66,.2) 55%,rgba(240,160,66,0) 78%);animation:emberpulse 1.7s ease-in-out infinite}
@keyframes emberpulse{0%,100%{opacity:.72}50%{opacity:1}}
/* Screens only — the frame is a physical object and never changes.
   NO mix-blend-mode anywhere in here: a blended element forces its whole
   stacking context to re-rasterize, which silently flipped every room label
   from subpixel to greyscale antialiasing the moment any room started working.
   Plain alpha over a dark wall lifts it just as well and the diff stays clean. */
.fx.glow{overflow:hidden}
.fx.glow i{position:absolute;left:0;right:0;display:block;background:rgba(150,214,246,.62);animation:wallwake 3.6s ease-in-out -1.2s infinite}
.fx.bleed{background:linear-gradient(to bottom,rgba(150,214,246,.4),rgba(150,214,246,0));animation:wallwake 3.6s ease-in-out -1.2s infinite}
@keyframes wallwake{0%,100%{opacity:.6}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.ag,.bub i,.fx.smoke i,.fx.glow i,.fx.bleed,.fx.ember,.fx.bounce{animation:none}.fx.smoke i{opacity:.7}}
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
        /* nanoclaw: state-driven fx. A themed room declares an anchor in tile
         * coordinates; the overlay only exists while one of that room's LIVE
         * occupants is `working`. Asleep is not cooking, and decorative-by-
         * default is explicitly out — an empty floor has no smoke and no lit
         * wall. Lives in the DOM layer like the pills, so it can animate over
         * the static world SVG. `--s` carries the zoom into the keyframes so a
         * puff stays the same size on screen at any scale. */
        const fx = m.R.fx;
        if (fx && (m.R.agents || []).some((a) => a && a.status === 'working')) {
          const fxL = (m.rx + fx.at[0]) * T, fxT = (m.ry + fx.at[1]) * T, mu = selected && !isSel ? ' mute' : '';
          if (fx.kind === 'smoke') {
            /* Everything that says "this thing is COOKING" lives here, because all
             * of it is state. The world SVG draws the smoker cold — dark firebox,
             * grey ash — so with nobody working there is no ember, no bounce light
             * and no plume, and the room honestly reads as a cold pit.
             * Offsets follow the `M` sprite's own geometry: the stack mouth sits
             * 14px above the anchor tile, and the firebox drum is on the run's far
             * cap (`fx.ember`), 12px down from its tile top. */
            ov += `<div class="fx smoke${mu}" style="--s:${s};left:${px(fxL - 1)};top:${px(fxT - 42)};width:${px(14)};height:${px(29)}"><i></i><i></i><i></i></div>`;
            if (fx.ember) {
              const eL = (m.rx + fx.ember[0]) * T, eT = (m.ry + fx.ember[1]) * T;
              ov += `<div class="fx bounce${mu}" style="left:${px(eL - 4)};top:${px(eT + 10)};width:${px(32)};height:${px(30)}"></div>`;
              ov += `<div class="fx ember${mu}" style="left:${px(eL + 12)};top:${px(eT + 18)};width:${px(3)};height:${px(3)}"></div>`;
            }
          } else if (fx.kind === 'glow') {
            /* Only the SCREENS light. The frame, bezels and mullions are physical
             * objects and stay exactly as painted — a wash over the whole run just
             * reads as someone nudging a brightness slider. The two bands match the
             * screen rows the `V` sprite draws (y 1..6 and 7..12 of each 16px tile);
             * `bleed` is the light the wall throws onto the floor under it. */
            const gw = fx.at[2] * T, gh = fx.at[3] * T;
            ov += `<div class="fx glow${mu}" style="left:${px(fxL)};top:${px(fxT)};width:${px(gw)};height:${px(gh)}"><i style="top:${100 / 16}%;height:${500 / 16}%"></i><i style="top:${700 / 16}%;height:${500 / 16}%"></i></div>`;
            ov += `<div class="fx bleed${mu}" style="left:${px(fxL)};top:${px(fxT + gh - 2)};width:${px(gw)};height:${px(14)}"></div>`;
          }
        }
        if (!m.R.label) return; // nanoclaw: an unassigned slot draws furniture, no chrome
        if (labels === 'pill') {
          ov += `<div class="room${selected && !isSel ? ' mute' : ''}" style="left:${px(L + 8)};top:${px(Tp + Hr - 6)}"><span class="dot" style="background:${col}"></span>${m.R.label}${m.R.open ? `<span class="n">${m.R.open}</span>` : ''}</div>`;
        } else if (labels === 'badge') {
          ov += `<div class="badge" style="--bc:${col};left:${px(L + Wr / 2)};top:${px(Tp + Hr / 2)}">${m.R.open}</div>`;
          if (isSel) ov += `<div class="room" style="left:${px(L + 8)};top:${px(Tp + Hr - 6)}"><span class="dot" style="background:${col}"></span>${m.R.label}</div>`;
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
        /* nanoclaw: drawn LAST so it sits over the room's own hit area —
         * clicking a person picks the person, never the room under them. */
        ov += `<button class="ahit" data-agent="${p.a.name}" data-room="${p.room}" aria-label="${p.a.name}" style="left:calc(${px(p.x + 10)} - 20px);top:calc(${px(p.y + 11)} - 20px);width:40px;height:40px"></button>`;
      });
      this.shadowRoot.innerHTML = `<style>${css}</style><div class="vp"><div class="stage" style="width:${built.W * s}px;height:${built.H * s}px"><div class="world" style="width:${built.W}px;height:${built.H}px;transform:scale(${s})">${built.svg}</div><div class="ov">${ov}</div></div></div>`;
      const vp = this.shadowRoot.querySelector('.vp');
      this._vp = vp;
      let down = false, sx = 0, sy = 0, l = 0, t = 0, moved = 0;
      vp.addEventListener('click', (e) => {
        /* nanoclaw: a pan that happens to end over something is not a click.
         * The pointer handler below already measures the drag; 5px of travel
         * is the line between a tap and a grab. */
        if (moved > 5) return;
        const a = e.target.closest('.ahit');
        if (a) {
          e.stopPropagation();
          this.dispatchEvent(new CustomEvent('agent-select', { detail: { name: a.dataset.agent, room: a.dataset.room }, bubbles: true, composed: true }));
          return;
        }
        const b = e.target.closest('.hit');
        if (b) this.dispatchEvent(new CustomEvent('room-select', { detail: { key: b.dataset.room }, bubbles: true, composed: true }));
      });
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
