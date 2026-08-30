import fs from 'fs';

import { writeMemoryFile } from './memory-write.js';

interface ProcessWriteRequest {
  rootDir: string;
  relativePath: string;
  content: string;
  expectedSha256: string | null;
  lockWaitMs?: number;
  retryDelayMs?: number;
  pauseSignalPath?: string;
  resumeSignalPath?: string;
}

// Bounds the whole JSON request, not just the content: 16 MiB of document plus
// HELPER_REQUEST_OVERHEAD_BYTES (16 KiB) of envelope. The host no longer has a
// matching read cap to stay in step with — the generated-fact reader that owned
// it is gone — so this is now the single authority on how large one memory
// write may be.
const MAX_MEMORY_WRITE_REQUEST_BYTES = 16400 * 1024;

if (import.meta.main) {
  const encoded = process.argv[2];
  const raw = encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : await Bun.stdin.text();
  if (!raw || Buffer.byteLength(raw) > MAX_MEMORY_WRITE_REQUEST_BYTES) {
    throw new Error('bounded write request is required');
  }
  const request = JSON.parse(raw) as ProcessWriteRequest;

  const result = await writeMemoryFile(
    {
      relative_path: request.relativePath,
      content: request.content,
      expected_sha256: request.expectedSha256,
    },
    {
      rootDir: request.rootDir,
      lockWaitMs: request.lockWaitMs,
      retryDelayMs: request.retryDelayMs,
      beforeAtomicRename:
        request.pauseSignalPath && request.resumeSignalPath
          ? () => {
              fs.writeFileSync(request.pauseSignalPath!, 'paused', { flag: 'wx' });
              while (!fs.existsSync(request.resumeSignalPath!)) Bun.sleepSync(2);
            }
          : undefined,
    },
  );

  process.stdout.write(`${JSON.stringify(result)}\n`);
}
