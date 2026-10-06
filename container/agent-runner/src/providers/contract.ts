import { OPENCODE_MODEL_SLUG_RE } from './model-vocabulary.js';

/**
 * What the core needs to know about a provider without naming it. Code outside `providers/` reads these fields
 * instead of comparing provider names, so each provider-specific behaviour has one declaration here and the
 * conformance test (`contract.test.ts`) keeps the name comparisons out of the core.
 */
export interface ProviderRuntimeContract {
  /** Host channel defaults the provider reads as sticky `providerConfig` values at startup, by env var name. */
  channelDefaults: { modelEnv: string; effortEnv: string } | null;
  /** Honours the per-turn `fast` toggle; elsewhere a sticky fast value is preserved but never applied. */
  turnFast: boolean;
  /** Runs Codex as the primary agent (persistent, session-local `~/.codex`) or as a peer (synthesized home). */
  codexHome: 'primary' | 'peer';
  skills: {
    /** Loads plugin skills natively, so the skills mirror must not list them a second time. */
    nativePluginLoading: boolean;
    /** The mirror is the only skill delivery, so it also carries `user-invocable:false` helper skills. */
    mirrorIsSoleDelivery: boolean;
  };
  /** `list_models` inventories this provider's slugs; the pattern rejects malformed `change_model` slugs. */
  modelListing: { slugPattern: RegExp } | null;
}

const PROVIDER_CONTRACTS: Readonly<Record<string, ProviderRuntimeContract>> = {
  claude: {
    channelDefaults: null,
    turnFast: false,
    codexHome: 'peer',
    skills: { nativePluginLoading: false, mirrorIsSoleDelivery: false },
    modelListing: null,
  },
  codex: {
    channelDefaults: { modelEnv: 'NANOCLAW_CODEX_MODEL_OVERRIDE', effortEnv: 'NANOCLAW_CODEX_EFFORT_OVERRIDE' },
    turnFast: true,
    codexHome: 'primary',
    skills: { nativePluginLoading: true, mirrorIsSoleDelivery: false },
    modelListing: null,
  },
  opencode: {
    channelDefaults: null,
    turnFast: false,
    codexHome: 'peer',
    skills: { nativePluginLoading: false, mirrorIsSoleDelivery: true },
    modelListing: { slugPattern: OPENCODE_MODEL_SLUG_RE },
  },
  mock: {
    channelDefaults: null,
    turnFast: false,
    codexHome: 'peer',
    skills: { nativePluginLoading: false, mirrorIsSoleDelivery: false },
    modelListing: null,
  },
};

export function providerContract(name: string): ProviderRuntimeContract {
  const contract = PROVIDER_CONTRACTS[name];
  if (!contract) throw new Error(`No provider contract for: ${name}. Declared: ${Object.keys(PROVIDER_CONTRACTS).join(', ')}`);
  return contract;
}

export function declaredContractNames(): string[] {
  return Object.keys(PROVIDER_CONTRACTS);
}
