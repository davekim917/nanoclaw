import fs from 'fs';

const ROLLOUT_PATH = '/workspace/agent/.mnemon-rollout.json';
type Phase = 'shadow' | 'live' | 'unhealthy';

export function readPhase(store: string): Phase {
  try {
    const raw = fs.readFileSync(ROLLOUT_PATH, 'utf8');
    const data = JSON.parse(raw) as Record<string, { phase?: Phase }>;
    const phase = data[store]?.phase;
    if (phase === 'shadow' || phase === 'live' || phase === 'unhealthy') return phase;
    return 'shadow'; // fail closed (cycle 3 F3)
  } catch {
    return 'shadow';
  }
}
