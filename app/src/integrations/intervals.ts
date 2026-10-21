// intervals.icu API client (ADR 0002). Errors never carry the API key.
import type { Env } from '../index';
import type { ISODate } from '../domain/types';
import type { IcuActivity } from '../domain/activityMap';

const BASE = 'https://intervals.icu/api/v1';
const TIMEOUT_MS = 10_000;

let fetchOverride: typeof fetch | null = null;

/** TEST ONLY: route intervals.icu calls to a fake. Pass `null` to restore the real fetch. */
export function __setIntervalsFetchForTesting(f: typeof fetch | null): void {
  fetchOverride = f;
}

/** The fetch the sync uses for intervals.icu (overridable in tests). */
export const intervalsFetch: typeof fetch = (input, init) => (fetchOverride ?? fetch)(input, init);

/** Error text with the key (and its Basic-auth form) masked. */
function scrub(env: Env, msg: string): string {
  const key = env.INTERVALS_API_KEY;
  if (!key) return msg;
  return msg.split(btoa(`API_KEY:${key}`)).join('***').split(key).join('***');
}

/** Activities between `oldest` and `newest` (inclusive, local dates) for the key's owner (athlete 0). */
export async function fetchActivities(env: Env, oldest: ISODate, newest: ISODate, fetchImpl: typeof fetch = fetch): Promise<IcuActivity[]> {
  const url = `${BASE}/athlete/0/activities?${new URLSearchParams({ oldest, newest })}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${btoa(`API_KEY:${env.INTERVALS_API_KEY ?? ''}`)}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
  } catch (err) {
    throw new Error(`intervals.icu request failed: ${scrub(env, err instanceof Error ? err.message : String(err))}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`intervals.icu activities failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('intervals.icu activities: unexpected response');
  return body as IcuActivity[];
}
