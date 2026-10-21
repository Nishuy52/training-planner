import { env, runInDurableObject } from 'cloudflare:test';
import initSql from '../../migrations/0001_init.sql?raw';
import commentsSql from '../../migrations/0002_comments.sql?raw';
import routesSql from '../../migrations/0003_routes.sql?raw';
import progressSql from '../../migrations/0004_progress.sql?raw';
import type { Env } from '../../src/index';

export const db = env.DB;
const TABLES = ['state', 'constraints', 'club_events', 'action_log', 'lift_log', 'activities', 'mobility_log', 'sent_reminders', 'kv', 'comments', 'routes', 'route_assignments', 'tm_history', 'benchmark_results'];

/** Each migration with a table it creates, so a partly migrated database gets only the missing ones. */
const MIGRATIONS: Array<{ sql: string; table: string }> = [
  { sql: initSql, table: 'state' },
  { sql: commentsSql, table: 'comments' },
  { sql: routesSql, table: 'routes' },
  { sql: progressSql, table: 'tm_history' },
];

export async function migrate(): Promise<void> {
  for (const m of MIGRATIONS) {
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(m.table).first();
    if (existing) continue;
    const stmts = m.sql.split(';').map((s) => s.trim()).filter(Boolean);
    await db.batch(stmts.map((s) => db.prepare(s)));
  }
}

export async function resetDb(): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

export const BOT_TOKEN = '123456:TEST-TOKEN-never-real';
export const CHAT_ID = '4242';
export const SECRET = 'webhook-secret-for-tests';

/** Worker env with Telegram configured (the wrangler.jsonc test env has no secrets). ROLE is 'bot': the webhook is only served by that role (ADR 0003); the cron ignores ROLE except 'bot', so tests override it where it matters. */
export const tgEnv = (): Env => ({
  ...(env as unknown as Env),
  ROLE: 'bot',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
});

export type TgCall = { method: string; body: Record<string, unknown> };

/** A fake Telegram Bot API: records calls, answers ok (or with `status` when set). */
export type FakeTelegram = { calls: TgCall[]; status: number; fetch: typeof fetch };

export function fakeTelegram(): FakeTelegram {
  const calls: TgCall[] = [];
  const fake: FakeTelegram = {
    calls,
    status: 200,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.telegram.org/bot')) throw new Error(`unexpected fetch ${url}`);
      const method = url.split('/').at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      // sendMessage answers with a Message (its message_id is the call's position, from 1001).
      return fake.status === 200
        ? Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 1000 + calls.length } : true })
        : Response.json({ ok: false, description: 'boom' }, { status: fake.status });
    }) as typeof fetch,
  };
  return fake;
}

/** The Live Session Durable Object's stub. */
export const liveStub = () => env.LIVE.get(env.LIVE.idFromName('live'));

/** Clears the Live Session (storage and alarm). */
export async function resetLive(): Promise<void> {
  await runInDurableObject(liveStub(), async (_o, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
}
