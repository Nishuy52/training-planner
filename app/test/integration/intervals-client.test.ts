import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fetchActivities } from '../../src/integrations/intervals';
import type { Env } from '../../src/index';

const KEY = 'icu-key-never-real-123';
const icuEnv = (): Env => ({ ...(env as unknown as Env), INTERVALS_API_KEY: KEY });

describe('intervals.icu client', () => {
  it('GETs the athlete\'s activities in the window with Basic auth', async () => {
    const seen: Request[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json([{ id: 'i1', type: 'Run' }]);
    }) as typeof fetch;

    const got = await fetchActivities(icuEnv(), '2026-09-20', '2026-10-04', fake);
    expect(got).toEqual([{ id: 'i1', type: 'Run' }]);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe('https://intervals.icu/api/v1/athlete/0/activities');
    expect(url.searchParams.get('oldest')).toBe('2026-09-20');
    expect(url.searchParams.get('newest')).toBe('2026-10-04');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('Authorization')).toBe(`Basic ${btoa(`API_KEY:${KEY}`)}`);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-OK response with the status only, never the key', async () => {
    const fake = (async () => new Response(`bad key ${KEY}`, { status: 401 })) as typeof fetch;
    const err = await fetchActivities(icuEnv(), '2026-09-20', '2026-10-04', fake).then(() => new Error('no error'), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(btoa(`API_KEY:${KEY}`));
  });

  it('a body that is not an array is an error', async () => {
    const fake = (async () => Response.json({ error: 'nope' })) as typeof fetch;
    await expect(fetchActivities(icuEnv(), '2026-09-20', '2026-10-04', fake)).rejects.toThrow(/unexpected/);
  });

  it('a network error that echoes the key is scrubbed', async () => {
    const fake = (async () => { throw new Error(`connect failed for ${KEY}`); }) as typeof fetch;
    const err = await fetchActivities(icuEnv(), '2026-09-20', '2026-10-04', fake).then(() => new Error('no error'), (e: unknown) => e as Error);
    expect(err.message).not.toContain(KEY);
  });
});
