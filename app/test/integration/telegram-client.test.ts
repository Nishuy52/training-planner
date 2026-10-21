import { it, expect } from 'vitest';
import { sendMessage, editMessageReplyMarkup, answerCallbackQuery } from '../../src/telegram/client';
import type { Env } from '../../src/index';

const env = { TELEGRAM_BOT_TOKEN: 'SECRET123', TELEGRAM_CHAT_ID: '42' } as Env;

function fake(status = 200, json: unknown = { ok: true }) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

it('sendMessage posts HTML text with keyboard to chat', async () => {
  const { f, calls } = fake();
  const kb = [[{ text: 'x', callback_data: 'a|d|2026-10-05|T' }]];
  await sendMessage(env, 'hi', kb, f);
  expect(calls[0].url).toBe('https://api.telegram.org/botSECRET123/sendMessage');
  expect(calls[0].body).toEqual({ chat_id: '42', text: 'hi', parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});
it('sendMessage omits reply_markup without keyboard', async () => {
  const { f, calls } = fake();
  await sendMessage(env, 'hi', undefined, f);
  expect(calls[0].body.reply_markup).toBeUndefined();
});
it('editMessageReplyMarkup and answerCallbackQuery shape', async () => {
  const { f, calls } = fake();
  const kb = [[{ text: 'done', callback_data: 'n' }]];
  await editMessageReplyMarkup(env, 7, kb, f);
  await answerCallbackQuery(env, 'cb1', 'ok', f);
  expect(calls[0].url.endsWith('/editMessageReplyMarkup')).toBe(true);
  expect(calls[0].body).toEqual({ chat_id: '42', message_id: 7, reply_markup: { inline_keyboard: kb } });
  expect(calls[1].url.endsWith('/answerCallbackQuery')).toBe(true);
  expect(calls[1].body).toEqual({ callback_query_id: 'cb1', text: 'ok' });
});
it('throws without leaking token on non-ok or ok:false', async () => {
  const e1 = (await sendMessage(env, 'x', undefined, fake(401, { ok: false }).f).catch((e) => e)) as Error;
  expect(e1.message).toContain('sendMessage');
  expect(e1.message).toContain('401');
  expect(e1.message).not.toContain('SECRET123');
  const e2 = (await answerCallbackQuery(env, 'c', undefined, fake(200, { ok: false }).f).catch((e) => e)) as Error;
  expect(e2.message).toContain('answerCallbackQuery');
  expect(e2.message).not.toContain('SECRET123');
});
