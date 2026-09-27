/**
 * First-match route table with `:param` segments and a terminal `*tail` splat. requireAuth verifies the session
 * cookie through a registered verifier and enforces a CSRF origin check on mutating methods.
 */
import http from 'http';

import type { User } from '../types.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Handler = (req: Request, params: Record<string, string>, ctx: RequestContext) => Promise<Response | null>;
export type AuthHandler = (
  req: Request,
  params: Record<string, string>,
  ctx: AuthedRequestContext,
) => Promise<Response | null>;

interface RequestContext {
  rawNodeReq: http.IncomingMessage;
  rawNodeRes?: http.ServerResponse;
}

export interface GroupScope {
  agent_group_id: string;
  role: 'owner' | 'global_admin' | 'admin_of_group' | 'member';
}

export interface AuthedRequestContext extends RequestContext {
  user: User;
  scopes: { role: GroupScope['role']; allowed_group_ids: string[]; no_filter: boolean };
}

// Returns null on an invalid or missing cookie.
export type CookieVerifier = (cookieHeader: string | null) => { user_id: string; expires_at: string } | null;

let cookieVerifier: CookieVerifier | null = null;

export function registerCookieVerifier(fn: CookieVerifier): void {
  cookieVerifier = fn;
}

export function clearCookieVerifier(): void {
  cookieVerifier = null;
}

export interface Route {
  method: Method;
  pattern: string;
  handler: Handler;
}

const routes: Route[] = [];

export function register(method: Method, pattern: string, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

/** Read-only snapshot for tests. */
export function getRoutes(): ReadonlyArray<Readonly<Route>> {
  return routes;
}

/** `:name` captures one segment; `*tail` is terminal and captures the rest. Null on mismatch. */
export function pathMatch(pattern: string, urlPath: string): Record<string, string> | null {
  const patternSegments = pattern.split('/');
  const urlSegments = urlPath.split('/');

  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i];

    if (ps !== undefined && ps.startsWith('*')) {
      const name = ps.slice(1);
      params[name] = urlSegments.slice(i).join('/');
      return params;
    }

    if (i >= urlSegments.length) return null;

    const us = urlSegments[i];

    if (ps !== undefined && ps.startsWith(':')) {
      params[ps.slice(1)] = us ?? '';
    } else if (ps !== us) {
      return null;
    }
  }

  if (urlSegments.length !== patternSegments.length) return null;

  return params;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return LOCALHOST_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/** CSRF: POST/PUT/DELETE whose Origin does not match Host is refused; localhost origins always pass. */
export function checkOrigin(req: Request): Response | null {
  const method = req.method;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const origin = req.headers.get('origin') ?? undefined;
    const host = req.headers.get('host') ?? '';
    if (origin !== undefined) {
      if (!isLocalhostOrigin(origin)) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          return new Response(JSON.stringify({ error: 'origin_mismatch' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (originHost !== host) {
          return new Response(JSON.stringify({ error: 'origin_mismatch' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }
  }
  return null;
}

/** Verifies the cookie, enforces the origin check, and populates ctx.user and ctx.scopes. */
export function requireAuth(handler: AuthHandler): Handler {
  return async (req, params, ctx) => {
    const originDeny = checkOrigin(req);
    if (originDeny) return originDeny;

    const cookieHeader = req.headers.get('cookie');
    const payload = cookieVerifier ? cookieVerifier(cookieHeader) : null;
    if (!payload) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Scopes must enumerate real user_roles groups; a hardcoded empty allow-list locks scoped admins out of every
    // scope-filtered query. Lazy import because compute-scopes depends on db/connection, which cannot load before
    // initDb.
    const { computeScopes } = await import('./auth/compute-scopes.js');
    const scopes = await computeScopes(payload.user_id);

    // Lazy for the same reason. Resolves the real display name; null only for a never-provisioned user.
    const { getUser } = await import('../modules/permissions/db/users.js');
    const user: User = {
      id: payload.user_id,
      kind: 'dashboard',
      display_name: (await getUser(payload.user_id))?.display_name ?? null,
      created_at: new Date().toISOString(),
    };

    const authedCtx: AuthedRequestContext = {
      ...ctx,
      user,
      scopes,
    };

    return handler(req, params, authedCtx);
  };
}

/** Returns the Response to write, or null when the handler wrote to nodeRes itself. */
export async function dispatch(
  req: Request,
  nodeReq: http.IncomingMessage,
  nodeRes: http.ServerResponse,
): Promise<Response | null> {
  const url = new URL(req.url);
  const urlPath = url.pathname;
  const method = req.method as Method;

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = pathMatch(route.pattern, urlPath);
    if (params === null) continue;

    const ctx: RequestContext = { rawNodeReq: nodeReq, rawNodeRes: nodeRes };
    return route.handler(req, params, ctx);
  }

  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
