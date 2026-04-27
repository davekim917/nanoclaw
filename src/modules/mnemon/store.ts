import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export async function ensureStore(storeName: string): Promise<void> {
  try {
    await execFileP('mnemon', ['store', 'create', storeName]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already|exists/i.test(msg)) return;
    throw err;
  }
}
