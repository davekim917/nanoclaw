/**
 * Scoped tool and credential env helpers. A container.json `tools` entry is bare (`snowflake`) or scoped
 * (`snowflake:archive-one`); a scope limits which credentials the agent's mounts expose. `scopedEnvKey` fallback
 * modes: 'bare' (unscoped → `${PREFIX}`) or 'group' (unscoped → `${PREFIX}_${GROUP}`); scoped is always
 * `${PREFIX}_${SCOPE}`.
 */
import { log } from './log.js';

/** Scopes name credential files, so anything that could traverse (separators, `..`, metachars) is dropped. */
const SAFE_SCOPE_RE = /^[a-zA-Z0-9_-]+$/;

/** True when `tools` is undefined: no filter configured means every tool is on. */
export function isToolEnabled(tools: string[] | undefined, name: string): boolean {
  if (!tools) return true;
  return tools.some((t) => t === name || t.startsWith(name + ':'));
}

/**
 * `gmail:example-labs` contributes the scope `example-labs`; unsafe scopes are dropped with a warning. `isScoped` is
 * true when only scoped forms are listed, i.e. the agent lacks access to every scope.
 */
export function extractToolScopes(
  tools: string[] | undefined,
  toolName: string,
): { scopes: string[]; isScoped: boolean } {
  const scopes =
    tools
      ?.filter((t) => t.startsWith(`${toolName}:`))
      .map((t) => t.split(':')[1])
      .filter((scope) => {
        if (!SAFE_SCOPE_RE.test(scope)) {
          log.warn('Rejecting unsafe tool scope value', { scope, toolName });
          return false;
        }
        return true;
      }) ?? [];
  return {
    scopes,
    isScoped: scopes.length > 0 && !tools?.includes(toolName),
  };
}

export type ScopeFallback = 'bare' | 'group';

export function scopedEnvKey(
  prefix: string,
  opts: {
    scopes: string[];
    isScoped: boolean;
    fallback: ScopeFallback;
    groupScope?: string;
  },
): string {
  if (opts.isScoped) {
    return `${prefix}_${opts.scopes[0].toUpperCase()}`;
  }
  if (opts.fallback === 'bare') {
    return prefix;
  }
  if (!opts.groupScope) {
    throw new Error(`scopedEnvKey: groupScope required when fallback='group' (prefix=${prefix})`);
  }
  return `${prefix}_${opts.groupScope.toUpperCase()}`;
}

export function normalizeScopedSecret(secrets: Record<string, string>, scopedKey: string, genericKey: string): void {
  if (scopedKey !== genericKey && secrets[scopedKey]) {
    secrets[genericKey] = secrets[scopedKey];
    delete secrets[scopedKey];
  }
}

/**
 * Keep only allowed `[name]` sections of an INI/TOML config (AWS credentials/config, Snowflake connections.toml).
 * `headerTransform` maps `[profile foo]` to `foo`; `alwaysInclude` keeps sections like `[default]` the CLI needs.
 */
export function filterConfigSections(
  content: string,
  allowed: string[],
  opts?: {
    headerTransform?: (header: string) => string;
    alwaysInclude?: Set<string>;
  },
): string {
  const sections = content.split(/^(?=\[)/m);
  return sections
    .filter((section) => {
      const match = section.match(/^\[([^\]]+)\]/);
      if (!match) return !section.trim(); // keep blank preamble only
      const header = match[1].trim();
      if (opts?.alwaysInclude?.has(header)) return true;
      const name = opts?.headerTransform?.(header) ?? header;
      return allowed.includes(name);
    })
    .join('');
}
