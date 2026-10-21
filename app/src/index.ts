import { Hono } from 'hono';
import { api } from './http/api';
import { safeError, webhook } from './telegram/webhook';
import { runReminders } from './scheduled';
import { runIntervalsSync } from './sync';
import type { LiveSessionObject } from './live/durable';

// The Live Session Durable Object class (ADR 0004). Defined by the `training` Worker; `training-bot` binds it by script_name.
export { LiveSessionObject } from './live/durable';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The one Live Session (ADR 0004). */
  LIVE: DurableObjectNamespace<LiveSessionObject>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** intervals.icu API key (secret, app Worker only). Empty or unset = Activity sync off. */
  INTERVALS_API_KEY?: string;
  /** 'bot' = Telegram webhook only (training-bot Worker); 'app' or unset = tracker, API and cron. See ADR 0003. */
  ROLE?: string;
};

const app = new Hono<{ Bindings: Env }>();
// Role gating (ADR 0003): the bot Worker serves only the webhook; the Access-protected app Worker never serves it.
app.use('*', async (c, next) => {
  const isWebhook = c.req.path === '/telegram/webhook';
  if (c.env.ROLE === 'bot' ? !(isWebhook && c.req.method === 'POST') : isWebhook) return c.text('not found', 404);
  await next();
});
app.route('/', webhook); // /telegram/webhook: own secret check, NOT behind Access
app.route('/', api); // /api/*: requireAccess is applied inside, before every route
// Anything else the Worker sees (assets normally bypass it) goes to the static assets.
app.notFound((c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('not found', 404)));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.ROLE === 'bot') return;
    const instant = new Date(controller.scheduledTime);
    ctx.waitUntil(
      runReminders(env, instant)
        .then(
          () => undefined,
          (err) => console.error('scheduled run failed:', safeError(env, err)),
        )
        // After the reminders, so a slow intervals.icu never delays them. Gated to at most hourly; never throws.
        .then(() => runIntervalsSync(env, instant))
        .then(() => undefined),
    );
  },
};
