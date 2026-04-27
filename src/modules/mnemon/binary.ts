import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export async function mnemonBinaryAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileP('mnemon', ['--version']);
    return /^mnemon version/.test(stdout.trim());
  } catch {
    return false;
  }
}
