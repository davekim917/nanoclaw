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

// Bounds the whole JSON request (16 MiB of document plus 16 KiB envelope); the single authority on one memory write's size.
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
