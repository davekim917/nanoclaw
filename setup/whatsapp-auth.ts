/**
 * Step: whatsapp-auth — standalone WhatsApp (Baileys) authentication.
 *
 * Forked from the channels-branch version so setup:auto's driver can render
 * the terminal UX itself (inside clack) instead of the step dumping a raw QR
 * to stdout. The browser method has been dropped — one less moving part and
 * it kept biting headless/SSH users.
 *
 * Methods:
 *   --method qr (default)          Emit each rotating QR as a status block
 *                                  with the raw QR string. Driver renders.
 *   --method pairing-code --phone  Request a pairing code. Emitted in a
 *                                  status block once the Baileys call returns.
 *
 * Block schema (parent parses these):
 *   WHATSAPP_AUTH_QR             { QR: "<raw>" }              — repeats
 *   WHATSAPP_AUTH_PAIRING_CODE   { CODE: "XXXX-XXXX" }        — one-shot
 *   WHATSAPP_AUTH                { STATUS: success }          — terminal
 *                                { STATUS: skipped, AUTH_DIR, REASON }
 *                                { STATUS: failed, ERROR: <reason> }
 *
 * STATUS values are kept in the runner's vocabulary (success/skipped/failed)
 * so `spawnStep` recognises them and sets `ok` correctly; WhatsApp-specific
 * UI text (e.g. "WhatsApp linked") lives in the driver's block handler.
 *
 * On success, credentials land in store/auth/ and the process exits 0.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { emitStatus } from './status.js';

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'store', 'pairing-code.txt');
const BAILEYS_PACKAGE = '@whiskeysockets/baileys';
const PINO_PACKAGE = 'pino';
const QRCODE_PACKAGE = 'qrcode';

type WaVersion = [number, number, number];
type BrowserDescription = [string, string, string];

type BaileysLogger = {
  level: string;
  child: (bindings: Record<string, unknown>) => BaileysLogger;
  trace: (value: unknown, message?: string) => unknown;
  debug: (value: unknown, message?: string) => unknown;
  info: (value: unknown, message?: string) => unknown;
  warn: (value: unknown, message?: string) => unknown;
  error: (value: unknown, message?: string) => unknown;
};

type WhatsAppAuthState = {
  creds: { registered: boolean; me?: { id?: string } };
  keys: Record<string, unknown>;
};

type ConnectionUpdate = {
  connection?: string;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
  qr?: string;
};

type WhatsAppSocket = {
  user?: { id?: string };
  end: (error: Error | undefined) => void;
  requestPairingCode: (phone: string) => Promise<string>;
  ev: {
    on: {
      (event: 'connection.update', listener: (update: ConnectionUpdate) => void): void;
      (event: 'creds.update', listener: () => void | Promise<void>): void;
    };
  };
};

type BaileysModule = {
  makeWASocket: (config: {
    version?: WaVersion;
    auth: {
      creds: WhatsAppAuthState['creds'];
      keys: WhatsAppAuthState['keys'];
    };
    printQRInTerminal: boolean;
    logger: BaileysLogger;
    browser: BrowserDescription;
  }) => WhatsAppSocket;
  Browsers: { macOS: (browser: string) => BrowserDescription };
  DisconnectReason: { loggedOut: number; timedOut: number };
  fetchLatestWaWebVersion: (options: Record<string, never>) => Promise<{ version: WaVersion }>;
  makeCacheableSignalKeyStore: (
    keys: Record<string, unknown>,
    logger: BaileysLogger,
  ) => Record<string, unknown>;
  useMultiFileAuthState: (folder: string) => Promise<{
    state: WhatsAppAuthState;
    saveCreds: () => Promise<void>;
  }>;
};

type PinoModule = {
  pino: (options: { level: 'silent' }) => BaileysLogger;
};

type QrCodeModule = {
  toString: (text: string, options: { type: 'terminal'; small: boolean }) => Promise<string>;
};

type LegacyBaileysModule = {
  proto: {
    DeviceProps: {
      PlatformType: Record<string, string | number | undefined>;
    };
  };
};

type LegacyBaileysGenerics = {
  getPlatformId: (browser: string) => string;
};

async function loadOptionalModule<T>(modulePath: string): Promise<T> {
  return import(modulePath);
}

async function loadQrCode(): Promise<QrCodeModule> {
  return loadOptionalModule<QrCodeModule>(QRCODE_PACKAGE);
}

// Baileys v6 bug: getPlatformId sends charCode (49) instead of enum value (1).
// Fixed in Baileys 7.x but not backported. Without this patch pairing codes
// fail with "couldn't link device" because WhatsApp receives an invalid
// platform id. createRequire is needed because proto is not a named ESM export.
function patchLegacyBaileysPlatformId(): void {
  try {
    const require = createRequire(import.meta.url);
    const baileys: LegacyBaileysModule = require(BAILEYS_PACKAGE);
    const generics: LegacyBaileysGenerics = require(`${BAILEYS_PACKAGE}/lib/Utils/generics`);
    generics.getPlatformId = (browser: string): string => {
      const platformType = baileys.proto.DeviceProps.PlatformType[browser.toUpperCase()];
      return platformType ? platformType.toString() : '1';
    };
  } catch {
    // If CJS require fails, QR auth still works; only pairing code may be affected.
  }
}

async function loadWhatsAppDependencies(): Promise<BaileysModule & { logger: BaileysLogger }> {
  const [baileysModule, pinoModule] = await Promise.all([
    loadOptionalModule<BaileysModule>(BAILEYS_PACKAGE),
    loadOptionalModule<PinoModule>(PINO_PACKAGE),
  ]);
  patchLegacyBaileysPlatformId();
  return { ...baileysModule, logger: pinoModule.pino({ level: 'silent' }) };
}

type AuthMethod = 'qr' | 'pairing-code';

/** Extract the bare phone digits from a WhatsApp JID like `14155551234:12@s.whatsapp.net`. */
function phoneFromId(id?: string | null): string {
  if (!id) return '';
  return id.split(':')[0].split('@')[0];
}

/** Read the linked number from saved credentials (the skipped / already-authed path). */
function readAuthedPhoneFromFile(): string {
  try {
    const raw = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8');
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    return phoneFromId(creds.me?.id);
  } catch {
    return '';
  }
}

/**
 * Render a raw QR payload to terminal block-art lines (small mode keeps it short
 * on 24-row terminals) plus a one-line caption. Returned as plain lines the
 * caller console.logs, so a streaming parent (hostExecStream) tees the live QR
 * straight to the operator's terminal — no parent-side renderQr / in-place redraw.
 */
async function renderQrLines(qr: string): Promise<string[]> {
  try {
    const QRCode = await loadQrCode();
    const art = await QRCode.toString(qr, { type: 'terminal', small: true });
    return [
      ...art.trimEnd().split('\n'),
      '',
      '   Open WhatsApp -> Settings -> Linked Devices -> Link a Device, then scan.',
    ];
  } catch {
    return ['QR code (raw): ' + qr];
  }
}

/** Print the pairing code as a spaced terminal card on plain stdout (teed live). */
function printPairingCard(code: string): void {
  const spaced = code.split('').join('  ');
  console.log(
    [
      '',
      `   ${spaced}`,
      '',
      '   Open WhatsApp -> Settings -> Linked Devices -> Link a Device',
      '   -> "Link with phone number instead" -> enter this code.',
      '   It expires in ~60 seconds.',
      '',
    ].join('\n'),
  );
}

function parseArgs(args: string[]): { method: AuthMethod; phone?: string } {
  let method: AuthMethod = 'qr';
  let phone: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--method': {
        const raw = args[++i];
        if (raw === 'qr' || raw === 'pairing-code') {
          method = raw;
        } else {
          console.error(`Unknown --method: ${raw} (expected 'qr' or 'pairing-code')`);
          process.exit(1);
        }
        break;
      }
      case '--phone':
        phone = args[++i];
        break;
    }
  }

  if (method === 'pairing-code' && !phone) {
    console.error('--phone is required for pairing-code method');
    process.exit(1);
  }

  return { method, phone };
}

export async function run(args: string[]): Promise<void> {
  const { method, phone } = parseArgs(args);

  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'skipped',
      REASON: 'already-authenticated',
      AUTH_DIR,
      PHONE: readAuthedPhoneFromFile(),
    });
    return;
  }

  const dependencies = await loadWhatsAppDependencies();

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'timeout' });
      process.exit(1);
    }, 120_000);

    let succeeded = false;
    function succeed(phone?: string): void {
      if (succeeded) return;
      succeeded = true;
      clearTimeout(timeout);
      try {
        if (fs.existsSync(PAIRING_CODE_FILE)) fs.unlinkSync(PAIRING_CODE_FILE);
      } catch {
        // ignore — the pairing code file is best-effort cleanup
      }
      // Surface the linked number in the terminal block so the SKILL.md's
      // `nc:run effect:step capture:bot_phone=PHONE` binds it straight from the
      // block, instead of the caller reading it back out of store/auth/creds.json.
      emitStatus('WHATSAPP_AUTH', {
        STATUS: 'success',
        PHONE: phone || readAuthedPhoneFromFile(),
      });
      resolve();
      // Give a moment for creds to flush before exiting.
      setTimeout(() => process.exit(0), 1000);
    }

    async function connectSocket(isReconnect = false): Promise<void> {
      const { state, saveCreds } = await dependencies.useMultiFileAuthState(AUTH_DIR);
      const { version } = await dependencies.fetchLatestWaWebVersion({}).catch(() => ({
        version: undefined,
      }));

      const sock = dependencies.makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: dependencies.makeCacheableSignalKeyStore(state.keys, dependencies.logger),
        },
        printQRInTerminal: false,
        logger: dependencies.logger,
        browser: dependencies.Browsers.macOS('Chrome'),
      });

      // Request pairing code only on first connect (not reconnect after 515).
      if (
        !isReconnect &&
        method === 'pairing-code' &&
        phone &&
        !state.creds.registered
      ) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phone);
            fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
            // Render the code as a plain-stdout card so a streaming parent tees
            // it live to the operator; keep the block for block-parsing callers.
            emitStatus('WHATSAPP_AUTH_PAIRING_CODE', { CODE: code });
            printPairingCard(code);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: message });
            process.exit(1);
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR method: render each rotation as plain stdout lines so a streaming
        // parent (hostExecStream) tees the live QR straight to the operator's
        // terminal. The raw-QR status block is kept for any block-parsing caller.
        if (qr && method === 'qr') {
          emitStatus('WHATSAPP_AUTH_QR', { QR: qr });
          void renderQrLines(qr).then((lines) => {
            console.log('\n' + lines.join('\n'));
          });
        }

        if (connection === 'open') {
          succeed(phoneFromId(sock.user?.id ?? state.creds.me?.id));
          sock.end(undefined);
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === dependencies.DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'logged_out',
            });
            process.exit(1);
          } else if (reason === dependencies.DisconnectReason.timedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'qr_timeout',
            });
            process.exit(1);
          } else if (reason === 515) {
            // 515 = stream error after pairing succeeds but before registration
            // completes. Reconnect to finish the handshake.
            connectSocket(true);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);
    }

    connectSocket();
  });
}
