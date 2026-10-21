import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../index';

/**
 * Cloudflare Access verification for `/api/*`.
 *
 * Access sits in front of the Worker and, for every request it lets through,
 * adds a signed JWT in `Cf-Access-Jwt-Assertion`. We re-verify that JWT here so
 * the Worker is not reachable by bypassing Access (e.g. via the workers.dev
 * hostname or a misconfigured Access application).
 *
 * NOT applied to `/telegram/webhook`: Telegram cannot authenticate to Access,
 * so that route gets an Access "Bypass" policy and is protected by its own
 * shared-secret check (`X-Telegram-Bot-Api-Secret-Token`) in the webhook
 * handler. Mount this middleware on `/api/*` only.
 *
 * Service tokens (used by automation) also pass Access and present the same
 * JWT, so they need no separate code path.
 */

const FORBIDDEN = { error: 'forbidden' } as const;

// Hostnames treated as local development. Compared against the parsed URL
// hostname (port stripped), exact match only.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

// One remote JWKS per team domain, cached at module (isolate) level so keys are
// fetched once and reused; jose handles refetch on unknown `kid` with a cooldown.
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

// TEST-ONLY key source. Production code must never call the setter below.
let jwksTestOverride: JWTVerifyGetKey | null = null;

/**
 * TEST ONLY: replace the remote Access JWKS with a local key set so tests can
 * sign tokens with a throwaway key. Pass `null` to restore normal behaviour.
 * Only the key source changes; audience/issuer/expiry checks still apply.
 */
export function __setAccessJwksForTesting(jwks: JWTVerifyGetKey | null): void {
  jwksTestOverride = jwks;
}

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  if (jwksTestOverride) return jwksTestOverride;
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Local dev escape hatch. Requires BOTH Access vars to be empty (an
 * unconfigured deployment, i.e. `wrangler dev`) AND a localhost hostname.
 * A half-configured environment (only one var set) never takes this path.
 * Cloudflare's edge routes by Host/SNI to the zone that owns the hostname, so
 * an Internet request cannot reach this Worker with a `localhost` hostname.
 */
function isLocalDev(env: Env, url: string): boolean {
  if (env.ACCESS_AUD || env.ACCESS_TEAM_DOMAIN) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const env = c.env;
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ACCESS_AUD ?? '';

  if (isLocalDev(env, c.req.url)) {
    await next();
    return;
  }

  // Fail closed on any missing configuration outside local dev.
  if (!teamDomain || !aud) return c.json(FORBIDDEN, 403);

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return c.json(FORBIDDEN, 403);

  try {
    await jwtVerify(token, jwksFor(teamDomain), {
      audience: aud,
      issuer: `https://${teamDomain}`,
      algorithms: ['RS256'], // Access signs with RS256; pin it to rule out alg confusion.
      requiredClaims: ['exp'],
    });
  } catch {
    // Invalid signature, wrong aud/iss, expired, malformed, or JWKS fetch
    // failure: all deny. Details are not echoed back to the client.
    return c.json(FORBIDDEN, 403);
  }

  await next();
};
