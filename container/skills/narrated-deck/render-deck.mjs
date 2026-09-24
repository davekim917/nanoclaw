#!/usr/bin/env node
/**
 * render-deck — turn a deck spec (slides + narration) into a narrated MP4 and
 * a self-contained HTML player with speed control.
 *
 *   node render-deck.mjs <deck.json> [--out DIR] [--silent] [--speed 1.5]
 *                        [--no-mp4] [--no-html]
 *
 * Pipeline: each slide's visual becomes a 1920x1080 image (HTML fragment via
 * headless Chromium, a json-render spec via the json-render plugin, or an
 * existing image); each slide's narration becomes speech via ElevenLabs
 * through the OneCLI gateway (curl — the gateway injects the key). The voice
 * leaves only ~0.25s between sentences, which sounds rushed, so each clip's
 * sentence and paragraph breaks are lengthened to `pauses` using ElevenLabs'
 * per-character timings (`planPauses`, `spliceSilence`). The clips are padded
 * and joined into ONE continuous track, so the player never has to
 * start a second audio element mid-deck (mobile browsers block that).
 *
 * No npm dependencies: node, curl, ffmpeg/ffprobe and chromium are all in the
 * agent image. Prints a JSON summary on stdout; progress goes to stderr.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VOICE = 'bIHbv24MWmeRgasZH58o'; // "Will" — premade, relaxed, American male (operator's pick)
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
export const MAX_SLIDES = 40;
const WIDTH = 1920;
const HEIGHT = 1080;
export const DEFAULT_PAUSES = { sentence: 0.6, paragraph: 0.9 };
const MAX_PAUSE_S = 2;
const SAMPLE_RATE = 44100;
const LEAD_IN_S = 0.25;
const TAIL_S = 0.6;
const SILENT_WPM = 160;
// Discord's default bot upload cap is 10 MB; stay under it with headroom.
export const CHAT_UPLOAD_LIMIT_BYTES = Math.floor(9.5 * 1024 * 1024);
const JSON_RENDER_CLI = process.env.NARRATED_DECK_JSON_RENDER || '/workspace/plugins/json-render/bin/render-spec.mjs';
const CHROMIUM = process.env.NARRATED_DECK_CHROMIUM || 'chromium';
const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

const log = (msg) => process.stderr.write(`[narrated-deck] ${msg}\n`);

// ---------------------------------------------------------------- pure helpers

export function words(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function slugify(title) {
  const slug = String(title || 'deck')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'deck';
}

export function slideLabel(slide, index) {
  if (typeof slide.label === 'string' && slide.label.trim()) return slide.label.trim();
  const first = String(slide.narration || '')
    .split(/(?<=[.!?])\s/)[0]
    .trim();
  const clipped = first.split(/\s+/).slice(0, 9).join(' ');
  return clipped ? (clipped.length < first.length ? `${clipped}…` : clipped) : `Slide ${index + 1}`;
}

/** Returns { errors, warnings }. A deck with errors must not be rendered. */
export function validateDeck(deck) {
  const errors = [];
  const warnings = [];
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
    return { errors: ['deck must be a JSON object'], warnings };
  }
  if (typeof deck.title !== 'string' || !deck.title.trim()) errors.push('title: required, non-empty string');
  if (deck.theme !== undefined && deck.theme !== 'dark' && deck.theme !== 'light') {
    errors.push('theme: must be "dark" or "light"');
  }
  if (deck.voice !== undefined && (typeof deck.voice !== 'string' || !deck.voice.trim())) {
    errors.push('voice: must be an ElevenLabs voice_id string');
  }
  if (deck.pauses !== undefined) {
    if (!deck.pauses || typeof deck.pauses !== 'object' || Array.isArray(deck.pauses)) {
      errors.push('pauses: must be an object like { "sentence": 0.6, "paragraph": 0.9 }');
    } else {
      for (const [k, v] of Object.entries(deck.pauses)) {
        if (!(k in DEFAULT_PAUSES)) errors.push(`pauses.${k}: unknown key (use sentence | paragraph)`);
        else if (typeof v !== 'number' || !(v >= 0 && v <= MAX_PAUSE_S)) {
          errors.push(`pauses.${k}: must be seconds between 0 and ${MAX_PAUSE_S}`);
        }
      }
    }
  }
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    errors.push('slides: required, non-empty array');
    return { errors, warnings };
  }
  if (deck.slides.length > MAX_SLIDES) errors.push(`slides: at most ${MAX_SLIDES} (got ${deck.slides.length})`);
  let totalWords = 0;
  deck.slides.forEach((slide, i) => {
    const at = `slides[${i}]`;
    if (!slide || typeof slide !== 'object') {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof slide.narration !== 'string' || !slide.narration.trim()) {
      errors.push(`${at}.narration: required, non-empty string`);
    } else {
      const n = words(slide.narration);
      totalWords += n;
      if (n > 150) warnings.push(`${at}: narration is ${n} words (~${Math.round((n / SILENT_WPM) * 60)}s) — split it`);
    }
    const kinds = ['html', 'image', 'jsonRender'].filter((k) => slide[k] !== undefined);
    if (kinds.length !== 1) {
      errors.push(`${at}: needs exactly one of html | image | jsonRender (got ${kinds.join(', ') || 'none'})`);
    } else if (kinds[0] === 'html' && (typeof slide.html !== 'string' || !slide.html.trim())) {
      errors.push(`${at}.html: must be a non-empty HTML fragment`);
    } else if (kinds[0] === 'image' && (typeof slide.image !== 'string' || !slide.image.trim())) {
      errors.push(`${at}.image: must be a file path`);
    } else if (kinds[0] === 'jsonRender' && (typeof slide.jsonRender !== 'object' || slide.jsonRender === null)) {
      errors.push(`${at}.jsonRender: must be a json-render spec object`);
    }
    if (slide.label !== undefined && typeof slide.label !== 'string') errors.push(`${at}.label: must be a string`);
  });
  if (totalWords > 1600) {
    warnings.push(`deck narration is ${totalWords} words (~${Math.round(totalWords / SILENT_WPM)} min) — tighten it`);
  }
  return { errors, warnings };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Full 1920x1080 page around an agent-written fragment. */
export function slideDocument(fragment, { css, theme, deckTitle, index, count }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body class="theme-${theme}">
<main class="slide">${fragment}</main>
<footer><span>${escapeHtml(deckTitle)}</span><span>${index + 1} / ${count}</span></footer>
<script>
  // Content that does not fit is clipped silently in a screenshot; flag it so
  // the renderer can warn instead.
  addEventListener('load', function () {
    var s = document.querySelector('.slide');
    var over = s.scrollHeight > s.clientHeight + 2 || s.scrollWidth > s.clientWidth + 2;
    document.body.setAttribute('data-overflow', over ? 'yes' : 'no');
  });
</script>
</body></html>`;
}

/** Inline the deck data into the player template. */
export function buildPlayerHtml(template, data) {
  // JSON inside <script> must not contain "</script" or "<!--"; escaping every
  // "<" is the standard safe form and JSON.parse reads it back unchanged.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template.replace('__TITLE__', () => escapeHtml(data.title)).replace('__DECK_JSON__', () => json);
}

export function ttsCacheKey(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32);
}

// A period after these is not a sentence end ("vs. last year").
const ABBREVIATION = /(?:^|[^A-Za-z])(?:vs|e\.g|i\.e|approx|mr|mrs|ms|dr|jr|sr)\.$/i;
const INITIAL = /(?:^|[\s.])[A-Z]\.$/; // "U.S." or "J." — a letter, not a sentence end

/**
 * Where to lengthen the silence in one voiced clip. `alignment` is ElevenLabs'
 * per-character timing for the text it was sent; a sentence end is `.?!`
 * (plus any closing quote or bracket) followed by whitespace, and a blank
 * line after it makes it a paragraph end. Returns [{ from, to, add, kind }]:
 * the silence the voice left (`from`–`to`, seconds into the clip) and how much
 * to add to reach the target. Boundaries already at or past the target are
 * left alone, and a target of 0 turns that kind off.
 */
export function planPauses(alignment, pauses = DEFAULT_PAUSES) {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return [];
  if (starts.length !== chars.length || ends.length !== chars.length) return [];
  const target = { ...DEFAULT_PAUSES, ...pauses };
  const plan = [];
  for (let i = 0; i < chars.length; i++) {
    if (!/^[.!?]$/.test(chars[i])) continue;
    let j = i + 1;
    while (j < chars.length && /^["'”’)\]]$/.test(chars[j])) j++;
    if (j >= chars.length || !/^\s$/.test(chars[j])) continue; // "4.2", or the end of the clip
    let k = j;
    let newlines = 0;
    while (k < chars.length && /^\s$/.test(chars[k])) {
      if (chars[k] === '\n') newlines++;
      k++;
    }
    if (k >= chars.length) continue;
    if (chars[i] === '.') {
      const before = chars.slice(Math.max(0, i - 8), i + 1).join('');
      if (ABBREVIATION.test(before) || INITIAL.test(before)) continue;
    }
    const kind = newlines >= 2 ? 'paragraph' : 'sentence';
    const from = ends[j - 1];
    const to = Math.max(from, starts[k]);
    const add = target[kind] - (to - from);
    if (target[kind] > 0 && add > 0.02) plan.push({ from, to, add, kind });
    i = k - 1;
  }
  return plan;
}

/** Sample index of the quietest 10 ms in [lo, hi] seconds — where a cut is inaudible. */
function quietestPoint(pcm, rate, lo, hi) {
  const win = Math.max(1, Math.round(rate * 0.01));
  const first = Math.max(0, Math.round(lo * rate));
  const last = Math.min(pcm.length - win, Math.round(hi * rate));
  if (last <= first) return Math.min(pcm.length, Math.max(0, Math.round(((lo + hi) / 2) * rate)));
  let best = first;
  let bestEnergy = Infinity;
  for (let s = first; s <= last; s += Math.max(1, win >> 1)) {
    let e = 0;
    for (let x = s; x < s + win; x++) e += Math.abs(pcm[x]);
    if (e < bestEnergy) {
      bestEnergy = e;
      best = s;
    }
  }
  return best + (win >> 1);
}

/**
 * Inserts digital silence into mono 16-bit PCM for each planned pause. The cut
 * goes at the quietest point in the gap, widened by 40 ms each side because
 * the character timings are approximate and mp3 decoding shifts audio by a
 * few ms. Returns { pcm, added } (added = seconds of silence inserted).
 */
export function spliceSilence(pcm, rate, plan) {
  if (!plan.length) return { pcm, added: 0 };
  const cuts = plan
    .map((p) => ({ at: quietestPoint(pcm, rate, p.from - 0.04, p.to + 0.04), n: Math.round(p.add * rate) }))
    .sort((a, b) => a.at - b.at);
  const total = cuts.reduce((a, c) => a + c.n, 0);
  const out = new Int16Array(pcm.length + total); // zero-filled = silence
  let src = 0;
  let dst = 0;
  for (const { at, n } of cuts) {
    out.set(pcm.subarray(src, at), dst);
    dst += at - src + n;
    src = at;
  }
  out.set(pcm.subarray(src), dst);
  return { pcm: out, added: total / rate };
}

/** Slide start/end times on the joined track, from per-slide clip durations. */
export function timeline(durations) {
  let t = 0;
  return durations.map((d) => {
    const start = t;
    t += d;
    return { start: Number(start.toFixed(3)), end: Number(t.toFixed(3)) };
  });
}

export function concatList(entries) {
  // ffconcat: the last image must be repeated or its duration is ignored.
  const q = (p) => `'${p.replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  for (const { file, duration } of entries) {
    lines.push(`file ${q(file)}`);
    if (duration !== undefined) lines.push(`duration ${duration.toFixed(3)}`);
  }
  if (entries.length && entries[entries.length - 1].duration !== undefined) {
    lines.push(`file ${q(entries[entries.length - 1].file)}`);
  }
  return lines.join('\n') + '\n';
}

export function parseArgs(argv) {
  const opts = { deck: null, out: null, silent: false, speeds: [], mp4: true, html: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--silent') opts.silent = true;
    else if (a === '--speed') {
      for (const s of String(argv[++i] || '').split(',')) {
        const n = Number(s);
        if (!(n > 1 && n <= 2.5)) throw new Error(`--speed: expected a number in (1, 2.5], got "${s}"`);
        opts.speeds.push(n);
      }
    } else if (a === '--no-mp4') opts.mp4 = false;
    else if (a === '--no-html') opts.html = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else if (!opts.deck) opts.deck = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

// ------------------------------------------------------------------- processes

function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed or not on PATH`) : e));
    child.on('close', (code) => {
      const result = { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} exited ${code}: ${result.stderr.trim().split('\n').slice(-6).join('\n')}`));
      } else resolve(result);
    });
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function durationOf(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(stdout.trim());
  if (!(d > 0)) throw new Error(`could not read duration of ${file}`);
  return d;
}

// -------------------------------------------------------------------- visuals

async function screenshotHtml(htmlFile, pngFile, profileDir) {
  const common = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3000',
  ];
  const url = pathToFileURL(htmlFile).href;
  await run(CHROMIUM, [...common, `--screenshot=${pngFile}`, url]);
  if (!fs.existsSync(pngFile)) throw new Error(`chromium produced no screenshot for ${htmlFile}`);
  const dom = await run(CHROMIUM, [...common, '--dump-dom', url], { allowFail: true });
  return /data-overflow="yes"/.test(dom.stdout);
}

async function fitImage(src, dst, background) {
  if (!fs.existsSync(src)) throw new Error(`image not found: ${src}`);
  await ffmpeg([
    '-i',
    src,
    '-vf',
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${background}`,
    '-frames:v',
    '1',
    dst,
  ]);
}

async function renderVisual(slide, i, ctx) {
  const n = String(i + 1).padStart(2, '0');
  const png = path.join(ctx.slidesDir, `${n}.png`);
  const background = ctx.theme === 'light' ? '0xfbfbfc' : '0x0e1116';
  if (slide.html !== undefined) {
    const htmlFile = path.join(ctx.slidesDir, `${n}.html`);
    fs.writeFileSync(
      htmlFile,
      slideDocument(slide.html, { css: ctx.css, theme: ctx.theme, deckTitle: ctx.title, index: i, count: ctx.count }),
    );
    const overflow = await screenshotHtml(htmlFile, png, path.join(ctx.tmpDir, `chrome-${n}`));
    if (overflow) ctx.warnings.push(`slides[${i}]: content overflows the slide and is clipped — cut it down`);
  } else if (slide.image !== undefined) {
    const src = path.isAbsolute(slide.image) ? slide.image : path.resolve(ctx.deckDir, slide.image);
    await fitImage(src, png, background);
  } else {
    if (!fs.existsSync(JSON_RENDER_CLI)) {
      throw new Error(`slides[${i}].jsonRender: json-render plugin not found at ${JSON_RENDER_CLI}`);
    }
    const spec = path.join(ctx.slidesDir, `${n}.spec.json`);
    const raw = path.join(ctx.tmpDir, `${n}-json-render.png`);
    fs.writeFileSync(spec, JSON.stringify(slide.jsonRender, null, 2));
    await run('node', [JSON_RENDER_CLI, 'validate', spec]);
    await run('node', [JSON_RENDER_CLI, 'render', spec, '-o', raw]);
    await fitImage(raw, png, background);
  }
  return png;
}

// ---------------------------------------------------------------------- audio

/**
 * Voices one request via the with-timestamps endpoint: writes the audio to
 * `dst` (mp3) and ElevenLabs' character alignment to `alignFile` (JSON).
 */
async function synthesize(request, dst, alignFile, attempt = 1) {
  const body = path.join(path.dirname(dst), `.${path.basename(dst)}.body.json`);
  const tmp = `${dst}.part`;
  fs.writeFileSync(body, JSON.stringify(request.body));
  const url = `${TTS_URL}/${encodeURIComponent(request.voice)}/with-timestamps?output_format=mp3_44100_128`;
  const { stdout } = await run('curl', [
    '-sS',
    '--max-time',
    '180',
    '-X',
    'POST',
    url,
    '-H',
    'Content-Type: application/json',
    '-H',
    'Accept: application/json',
    '--data-binary',
    `@${body}`,
    '-o',
    tmp,
    '-w',
    '%{http_code}',
  ]);
  fs.rmSync(body, { force: true });
  const status = Number(stdout.trim());
  if (status === 200) {
    const res = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.rmSync(tmp, { force: true });
    if (typeof res.audio_base64 !== 'string' || !res.audio_base64) throw new Error('ElevenLabs returned no audio');
    fs.writeFileSync(alignFile, JSON.stringify(res.alignment ?? null));
    fs.writeFileSync(dst, Buffer.from(res.audio_base64, 'base64'));
    return;
  }
  const detail = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8').slice(0, 400) : '';
  fs.rmSync(tmp, { force: true });
  if ((status === 429 || status >= 500 || status === 0) && attempt < 5) {
    const wait = 2 ** attempt * 1000;
    log(`ElevenLabs ${status}, retrying in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return synthesize(request, dst, alignFile, attempt + 1);
  }
  // ElevenLabs answers an exhausted quota with 401 too; don't blame the key for it.
  const hint = /quota_exceeded/.test(detail)
    ? ' — the ElevenLabs account is out of credits; render with --silent and tell the operator'
    : status === 401
      ? ' — this agent group is not granted the ElevenLabs secret (or the key lacks text_to_speech permission); report it to the operator'
      : '';
  throw new Error(`ElevenLabs TTS failed: HTTP ${status}${hint}. ${detail}`);
}

async function narrate(slide, i, ctx) {
  const n = String(i + 1).padStart(2, '0');
  const wav = path.join(ctx.audioDir, `${n}.wav`);
  const pad = `adelay=${Math.round(LEAD_IN_S * 1000)}:all=1,apad=pad_dur=${TAIL_S}`;
  if (ctx.silent) {
    const seconds = Math.max(2, (words(slide.narration) / SILENT_WPM) * 60);
    await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', seconds.toFixed(2), '-af', pad, wav]);
    return wav;
  }
  const slides = ctx.slides;
  const request = {
    voice: ctx.voice,
    body: {
      text: slide.narration.trim(),
      model_id: ctx.model,
      // Neighbouring text keeps intonation continuous across slide boundaries.
      ...(i > 0 ? { previous_text: slides[i - 1].narration.trim() } : {}),
      ...(i < slides.length - 1 ? { next_text: slides[i + 1].narration.trim() } : {}),
      ...(ctx.voiceSettings ? { voice_settings: ctx.voiceSettings } : {}),
    },
  };
  const key = ttsCacheKey(request);
  const cached = path.join(ctx.cacheDir, `${key}.mp3`);
  const alignFile = path.join(ctx.cacheDir, `${key}.align.json`);
  // The alignment is written first, so an mp3 without one predates timings.
  if (fs.existsSync(cached) && fs.existsSync(alignFile)) {
    ctx.cacheHits++;
  } else {
    log(`voicing slide ${i + 1}/${slides.length}`);
    await synthesize(request, cached, alignFile);
    ctx.charsBilled += request.body.text.length;
  }
  // Decode, lengthen sentence breaks, then pad: the timings are relative to
  // the raw clip, so the splice has to happen before the lead-in shifts it.
  const raw = path.join(ctx.tmpDir, `${n}.pcm`);
  await ffmpeg(['-i', cached, '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), raw]);
  const buf = fs.readFileSync(raw);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  const plan = planPauses(JSON.parse(fs.readFileSync(alignFile, 'utf8')), ctx.pauses);
  const spliced = spliceSilence(pcm, SAMPLE_RATE, plan);
  ctx.pausesLengthened += plan.length;
  ctx.pauseSecondsAdded += spliced.added;
  fs.writeFileSync(raw, Buffer.from(spliced.pcm.buffer, spliced.pcm.byteOffset, spliced.pcm.byteLength));
  await ffmpeg(['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', raw, '-af', pad, wav]);
  return wav;
}

// ---------------------------------------------------------------------- output

async function buildMp4({ images, wavs, durations, file, speed, tmpDir }) {
  const suffix = speed === 1 ? '1x' : `${speed}x`;
  const imgList = path.join(tmpDir, `images-${suffix}.ffconcat`);
  const audList = path.join(tmpDir, `audio-${suffix}.ffconcat`);
  fs.writeFileSync(imgList, concatList(images.map((f, i) => ({ file: f, duration: durations[i] / speed }))));
  fs.writeFileSync(audList, concatList(wavs.map((f) => ({ file: f }))));
  await ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    imgList,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    audList,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-vf',
    'fps=10,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-crf',
    '24',
    '-g',
    '50',
    ...(speed === 1 ? [] : ['-af', `atempo=${speed}`]),
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '1',
    '-movflags',
    '+faststart',
    '-shortest',
    file,
  ]);
}

async function buildHtml({ deck, images, wavs, durations, file, tmpDir }) {
  const audList = path.join(tmpDir, 'audio-html.ffconcat');
  const mp3 = path.join(tmpDir, 'full.mp3');
  fs.writeFileSync(audList, concatList(wavs.map((f) => ({ file: f }))));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', audList, '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', mp3]);
  const times = timeline(durations);
  const slides = [];
  for (let i = 0; i < images.length; i++) {
    const webp = path.join(tmpDir, `slide-${i + 1}.webp`);
    await ffmpeg(['-i', images[i], '-c:v', 'libwebp', '-quality', '88', '-frames:v', '1', webp]);
    slides.push({
      label: slideLabel(deck.slides[i], i),
      narration: deck.slides[i].narration.trim(),
      start: times[i].start,
      end: times[i].end,
      image: `data:image/webp;base64,${fs.readFileSync(webp).toString('base64')}`,
    });
  }
  const template = fs.readFileSync(path.join(HERE, 'player.html'), 'utf8');
  const html = buildPlayerHtml(template, {
    title: deck.title,
    subtitle: deck.subtitle || '',
    duration: times.length ? times[times.length - 1].end : 0,
    audio: `data:audio/mpeg;base64,${fs.readFileSync(mp3).toString('base64')}`,
    slides,
  });
  fs.writeFileSync(file, html);
}

// ------------------------------------------------------------------------ main

const USAGE = `usage: node render-deck.mjs <deck.json> [--out DIR] [--silent] [--speed 1.5[,2]] [--no-mp4] [--no-html]`;

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.deck) {
    process.stderr.write(`${USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  const deckPath = path.resolve(opts.deck);
  let deck;
  try {
    deck = JSON.parse(fs.readFileSync(deckPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`cannot read deck ${deckPath}: ${e.message}\n`);
    return 2;
  }
  const { errors, warnings } = validateDeck(deck);
  if (errors.length) {
    process.stderr.write(`deck is invalid:\n  - ${errors.join('\n  - ')}\n`);
    return 2;
  }

  const slug = slugify(deck.title);
  const outDir = path.resolve(opts.out || path.join(path.dirname(deckPath), `${slug}-deck`));
  const ctx = {
    title: deck.title,
    theme: deck.theme || 'dark',
    voice: deck.voice || process.env.NARRATED_DECK_VOICE || DEFAULT_VOICE,
    model: deck.model || DEFAULT_MODEL,
    voiceSettings: deck.voiceSettings,
    pauses: { ...DEFAULT_PAUSES, ...deck.pauses },
    silent: opts.silent,
    slides: deck.slides,
    count: deck.slides.length,
    deckDir: path.dirname(deckPath),
    css: fs.readFileSync(path.join(HERE, 'theme.css'), 'utf8'),
    slidesDir: path.join(outDir, 'slides'),
    audioDir: path.join(outDir, 'audio'),
    cacheDir: path.join(outDir, '.tts-cache'),
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'narrated-deck-')),
    warnings: [...warnings],
    cacheHits: 0,
    charsBilled: 0,
    pausesLengthened: 0,
    pauseSecondsAdded: 0,
  };
  for (const d of [ctx.slidesDir, ctx.audioDir, ctx.cacheDir]) fs.mkdirSync(d, { recursive: true });

  try {
    log(`rendering ${ctx.count} slides`);
    const images = await mapLimit(deck.slides, 2, (s, i) => renderVisual(s, i, ctx));
    const wavs = await mapLimit(deck.slides, 2, (s, i) => narrate(s, i, ctx));
    const durations = await Promise.all(wavs.map(durationOf));
    const summary = {
      title: deck.title,
      slides: ctx.count,
      durationSec: Number(durations.reduce((a, b) => a + b, 0).toFixed(1)),
      silent: ctx.silent,
      voice: ctx.silent ? null : ctx.voice,
      ttsCharsBilled: ctx.charsBilled,
      ttsCacheHits: ctx.cacheHits,
      pausesLengthened: ctx.pausesLengthened,
      pauseSecondsAdded: Number(ctx.pauseSecondsAdded.toFixed(1)),
      slideImages: images,
      files: [],
      warnings: ctx.warnings,
    };
    const addFile = (kind, file) => {
      const bytes = fs.statSync(file).size;
      summary.files.push({ kind, path: file, bytes });
      if (bytes > CHAT_UPLOAD_LIMIT_BYTES) {
        summary.warnings.push(
          `${path.basename(file)} is ${(bytes / 1048576).toFixed(1)} MB — over the ~10 MB chat upload cap; shorten the deck`,
        );
      }
    };
    if (opts.mp4) {
      for (const speed of [1, ...opts.speeds]) {
        const file = path.join(outDir, speed === 1 ? `${slug}.mp4` : `${slug}-${speed}x.mp4`);
        log(`encoding ${path.basename(file)}`);
        await buildMp4({ images, wavs, durations, file, speed, tmpDir: ctx.tmpDir });
        addFile(speed === 1 ? 'mp4' : `mp4@${speed}x`, file);
      }
    }
    if (opts.html) {
      const file = path.join(outDir, `${slug}.html`);
      log(`building ${path.basename(file)}`);
      await buildHtml({ deck, images, wavs, durations, file, tmpDir: ctx.tmpDir });
      addFile('html', file);
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`render failed: ${e.message}\n`);
    return 1;
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      process.exit(2);
    },
  );
}
