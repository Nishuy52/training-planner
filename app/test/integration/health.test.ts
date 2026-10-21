import { SELF } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('health (local dev host, Access vars empty)', async () => {
  const r = await SELF.fetch('http://localhost/api/health');
  expect(await r.json()).toEqual({ ok: true });
});
