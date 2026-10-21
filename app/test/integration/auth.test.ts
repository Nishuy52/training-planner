import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import type { Env } from '../../src/index';
import { requireAccess, __setAccessJwksForTesting } from '../../src/http/auth';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'test-aud-0123456789abcdef';
const ISS = `https://${TEAM}`;

const prodEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as Env;
const devEnv = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' } as Env;

const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', requireAccess);
app.get('/api/ping', (c) => c.json({ ok: true }));

let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-kid', alg: 'RS256' };
  __setAccessJwksForTesting(createLocalJWKSet({ keys: [jwk] }));
});
afterAll(() => __setAccessJwksForTesting(null));

type Claims = { aud?: string; iss?: string; exp?: number | string; signer?: CryptoKey };
function token({ aud = AUD, iss = ISS, exp = '5m', signer }: Claims = {}) {
  return new SignJWT({ email: 'me@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuedAt()
    .setAudience(aud)
    .setIssuer(iss)
    .setSubject('user-1')
    .setExpirationTime(exp)
    .sign(signer ?? key);
}

function call(env: Env, opts: { host?: string; jwt?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.jwt !== undefined) headers['Cf-Access-Jwt-Assertion'] = opts.jwt;
  return app.request(`https://${opts.host ?? 'training.example.com'}/api/ping`, { headers }, env);
}

async function expectForbidden(r: Response) {
  expect(r.status).toBe(403);
  const body = (await r.json()) as { error?: unknown };
  expect(typeof body.error).toBe('string');
}

describe('requireAccess (configured)', () => {
  it('no header -> 403', async () => {
    await expectForbidden(await call(prodEnv));
  });

  it('empty header -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: '' }));
  });

  it('garbage token -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: 'not.a.jwt' }));
  });

  it('valid token with right aud/iss -> 200', async () => {
    const r = await call(prodEnv, { jwt: await token() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('wrong aud -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: await token({ aud: 'someone-else' }) }));
  });

  it('wrong iss -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: await token({ iss: 'https://evil.cloudflareaccess.com' }) }));
  });

  it('expired -> 403', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expectForbidden(await call(prodEnv, { jwt: await token({ exp: past }) }));
  });

  it('signed by an unknown key -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: await token({ signer: otherKey }) }));
  });

  it('alg=none token -> 403', async () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 300;
    const unsigned = `${b64({ alg: 'none' })}.${b64({ aud: AUD, iss: ISS, exp })}.`;
    await expectForbidden(await call(prodEnv, { jwt: unsigned }));
  });

  it('localhost does not bypass verification once AUD is configured', async () => {
    await expectForbidden(await call(prodEnv, { host: 'localhost:8787' }));
    await expectForbidden(await call(prodEnv, { host: '127.0.0.1' }));
  });
});

describe('requireAccess (local dev escape)', () => {
  it('localhost + empty AUD -> 200', async () => {
    expect((await call(devEnv, { host: 'localhost:8787' })).status).toBe(200);
    expect((await call(devEnv, { host: '127.0.0.1:8787' })).status).toBe(200);
  });

  it('non-localhost + empty AUD -> 403', async () => {
    await expectForbidden(await call(devEnv, { host: 'training.example.workers.dev' }));
    await expectForbidden(await call(devEnv, { host: 'localhost.evil.com' }));
  });

  it('non-localhost + empty AUD -> 403 even with a validly signed token', async () => {
    await expectForbidden(await call(devEnv, { host: 'training.example.workers.dev', jwt: await token() }));
  });

  it('localhost + empty AUD but team domain set (half-configured) -> 403', async () => {
    const half = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' } as Env;
    await expectForbidden(await call(half, { host: 'localhost:8787' }));
  });

  it('AUD set but team domain empty (half-configured) -> 403', async () => {
    const half = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD } as Env;
    await expectForbidden(await call(half, { jwt: await token() }));
  });
});

describe('requireAccess (service token)', () => {
  // Access forwards a JWT for service-token requests too: same aud/iss, but `common_name` (the
  // token's client ID) and `type: 'app'` instead of an `email`. requireAccess must accept it.
  function serviceToken(aud: string) {
    return new SignJWT({ common_name: 'abc123.access', type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuedAt()
      .setAudience([aud])
      .setIssuer(ISS)
      .setSubject('')
      .setExpirationTime('5m')
      .sign(key);
  }

  it('service-token-shaped JWT (common_name, type app, no email) with right aud/iss -> 200', async () => {
    const r = await call(prodEnv, { jwt: await serviceToken(AUD) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('service-token-shaped JWT for another application (wrong aud) -> 403', async () => {
    await expectForbidden(await call(prodEnv, { jwt: await serviceToken('some-other-app') }));
  });
});
