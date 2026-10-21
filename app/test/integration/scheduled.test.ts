import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { loadPlannerState, upsertConstraint, wasSent } from '../../src/store/db';
import { BOT_TOKEN, CHAT_ID, db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

let tg: ReturnType<typeof fakeTelegram>;

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  await loadPlannerState(db); // seed defaults (Europe/Berlin)
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
});
afterEach(() => {
  __setTelegramFetchForTesting(null);
  vi.restoreAllMocks();
});

async function tick(iso: string) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: new Date(iso).getTime(), cron: '*/5 * * * *' }), { ...tgEnv(), ROLE: 'app' }, ctx);
  await waitOnExecutionContext(ctx);
}

describe('reminder cron', () => {
  it('07:00 Berlin sends the morning message once, not again on the next tick', async () => {
    await tick('2026-10-05T04:55:00Z'); // 06:55 CEST
    expect(tg.calls).toEqual([]);

    await tick('2026-10-05T05:00:00Z'); // 07:00 CEST
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.method).toBe('sendMessage');
    expect(tg.calls[0]!.body.chat_id).toBe(CHAT_ID);
    expect(tg.calls[0]!.body.text).toContain('Mon 5 Oct');
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(true);

    await tick('2026-10-05T05:05:00Z');
    expect(tg.calls).toHaveLength(1);
  });

  it('a failed send unmarks the reminder so the next tick retries; logs without the token', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    tg.status = 500;
    await tick('2026-10-05T05:00:00Z');
    expect(tg.calls).toHaveLength(1);
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(false);
    expect(errors.join('\n')).toContain('morning');
    expect(errors.join('\n')).not.toContain(BOT_TOKEN);

    tg.status = 200;
    await tick('2026-10-05T05:05:00Z');
    expect(tg.calls).toHaveLength(2);
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(true);
  });

  it('Sunday 19:00 sends the week preview; 21:30 the mobility nudge', async () => {
    await tick('2026-10-11T17:00:00Z'); // Sun 19:00 CEST: morning (late, once) + preview
    expect(tg.calls.map((c) => String(c.body.text).slice(0, 2))).toHaveLength(2);
    expect(String(tg.calls[1]!.body.text)).toMatch(/^📅 <b>Next 7 days<\/b>\n<b>Mon 12<\/b> · /);
    await tick('2026-10-11T19:30:00Z'); // 21:30 CEST
    expect(tg.calls).toHaveLength(3);
    expect(String(tg.calls[2]!.body.text)).toContain('Nightly routine');
    expect(tg.calls[2]!.body.reply_markup).toEqual({ inline_keyboard: [[
      { text: '🧘 Routine: Done', callback_data: 'm|d|2026-10-11' }, { text: '🧘 Skip', callback_data: 'm|s|2026-10-11' },
    ]] });
  });

  it('uses the active Constraint\'s timezone', async () => {
    await upsertConstraint(db, { id: 'east', start: '2026-10-01', end: '2026-10-20', timezone: 'Asia/Shanghai' });
    await tick('2026-10-04T23:00:00Z'); // 07:00 in Shanghai on Mon 5 Oct (01:00 in Berlin)
    expect(tg.calls).toHaveLength(1);
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(true);
  });
});

describe('reminder cron by role', () => {
  it('bot role does nothing on a tick; app role sends', async () => {
    const run = async (role: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date('2026-10-05T05:00:00Z').getTime(), cron: '*/5 * * * *' }), { ...tgEnv(), ROLE: role }, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run('bot');
    expect(tg.calls).toEqual([]);
    await run('app');
    expect(tg.calls).toHaveLength(1);
  });
});

describe('reminder cron outer failure', () => {
  it('logs a failure outside the per-reminder loop without the bot token', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const brokenDb = { prepare: () => { throw new Error(`db down for bot${BOT_TOKEN}/getMe`); } } as unknown as D1Database;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date('2026-10-05T05:00:00Z').getTime(), cron: '*/5 * * * *' }), { ...tgEnv(), ROLE: 'app', DB: brokenDb }, ctx);
    await waitOnExecutionContext(ctx);
    const log = errors.join(' | ');
    expect(log).toContain('scheduled run failed');
    expect(log).toContain('db down');
    expect(log).not.toContain(BOT_TOKEN);
  });
});
