import type { Env } from '../index';

export type InlineKeyboard = { text: string; callback_data: string }[][];
/** A reply keyboard (buttons that send their text), or its removal. */
export type ReplyKeyboard = { keyboard: { text: string }[][]; resize_keyboard?: boolean; is_persistent?: boolean } | { remove_keyboard: true };

type FetchImpl = typeof fetch;

async function call(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<unknown> {
  const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram ${method} failed: HTTP ${res.status}`);
  let parsed: { ok?: boolean; result?: unknown } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    /* treated as failure below */
  }
  if (parsed.ok !== true) throw new Error(`Telegram ${method} failed: HTTP ${res.status}, ok=false`);
  return parsed.result;
}

const messageIdOf = (result: unknown): number | undefined => {
  const id = (result as { message_id?: unknown } | null | undefined)?.message_id;
  return typeof id === 'number' ? id : undefined;
};

/** Sends an HTML message; resolves to its message_id (when Telegram returns one). */
export function sendMessage(env: Env, text: string, keyboard?: InlineKeyboard, fetchImpl: FetchImpl = fetch): Promise<number | undefined> {
  return sendMessageWithMarkup(env, text, keyboard ? { inline_keyboard: keyboard } : undefined, fetchImpl);
}

/** sendMessage with any reply_markup: an inline keyboard, a reply keyboard or its removal. */
export async function sendMessageWithMarkup(
  env: Env,
  text: string,
  replyMarkup: { inline_keyboard: InlineKeyboard } | ReplyKeyboard | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<number | undefined> {
  const result = await call(
    env,
    'sendMessage',
    { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) },
    fetchImpl,
  );
  return messageIdOf(result);
}

export async function editMessageReplyMarkup(
  env: Env,
  messageId: number,
  keyboard?: InlineKeyboard,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  await call(
    env,
    'editMessageReplyMarkup',
    {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard ?? [] },
    },
    fetchImpl,
  );
}

/** Replaces a message's text (HTML) and its inline keyboard (none when omitted). */
export async function editMessageText(env: Env, messageId: number, text: string, keyboard?: InlineKeyboard, fetchImpl: FetchImpl = fetch): Promise<void> {
  await call(
    env,
    'editMessageText',
    { chat_id: env.TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard ?? [] } },
    fetchImpl,
  );
}

export async function deleteMessage(env: Env, messageId: number, fetchImpl: FetchImpl = fetch): Promise<void> {
  await call(env, 'deleteMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_id: messageId }, fetchImpl);
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  await call(
    env,
    'answerCallbackQuery',
    { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
    fetchImpl,
  );
}
