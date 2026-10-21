# app

Cloudflare Worker (Hono + D1) with the static tracker in `public/`. Project overview: [../README.md](../README.md).

## Scripts

- `npm test` - vitest (Workers pool)
- `npm run typecheck` - `tsc --noEmit`
- `npm run dev` - `wrangler dev`
- `npm run deploy` - `wrangler deploy`
- `npm run db:migrate:local` / `db:migrate:remote` - apply D1 migrations

## Layout

- `src/domain` - pure planner logic, no I/O
- `src/store` - D1 persistence; `migrations/` - schema
- `src/http` - API and Access verification
- `src/telegram` - client, formatting, webhook; `src/scheduled.ts` - reminder cron
- `src/integrations` - intervals.icu client; `src/sync.ts` - hourly Activity sync
- `src/content` - mobility, warm-ups, lift extras
- `public/` - static tracker

## Tests

- `test/domain` - unit tests for the pure core
- `test/integration` - API, auth, store, webhook, cron and the Live Session Durable Object (alarms via `runDurableObjectAlarm`) against a test D1
- `test/static` - headers on the static tracker

## Environment

`ROLE` (`app` or `bot`) selects what a Worker serves: `app` is the tracker, API and cron; `bot` serves only `POST /telegram/webhook` ([ADR 0003](../docs/adr/0003-separate-bot-worker.md)). It is set in `wrangler.jsonc`.

Vars: `ROLE`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (blank on the bot). Blank on the app Worker too until you set up Access: then `/api/*` is open on localhost only and answers 403 on every deployed host (`src/http/auth.ts`).

Secrets (`wrangler secret put`, per Worker; add `--env bot` for the bot): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`. Never commit values. For `wrangler dev`, put them in `app/.dev.vars` (gitignored; see `.dev.vars.example`).

### Live Session Durable Object (ADR 0004)

`wrangler.jsonc` defines the `LiveSessionObject` class (SQLite-backed, migration tag `v1-live-session`) on the `training` Worker and binds it as `LIVE`; the `training-bot` env binds the same class with `script_name: "training"` and empties the inherited `migrations`. Deploy order matters the first time: `npx wrangler deploy --env=""` (creates the class), **then** `npx wrangler deploy --env bot` (its binding needs the class to exist). No D1 migration. The Durable Object uses the app Worker's `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` for the Live Session message and the "Rest over" ping. Locally, run `npx wrangler dev` and `npx wrangler dev --env bot` in two terminals; the bot's `script_name` binding finds the app's object through the local dev registry.

`INTERVALS_API_KEY` (optional, **app Worker only**) turns on the intervals.icu Activity sync: the cron credits watch-recorded runs, hikes and climbs at most hourly, and the Sync now button (Progress › Recent Activities) runs it on demand. Get the key from intervals.icu → Settings → Developer Settings → API key, then paste it at the hidden prompt of `npx wrangler secret put INTERVALS_API_KEY --env=""`. Without it the sync is off. The key is never logged or returned.

## Migrations

`migrations/0003_routes.sql` adds the `routes` and `route_assignments` tables. Apply it before deploying code that uses Routes:

```
npx wrangler d1 migrations apply training --remote   # production
npm run db:migrate:local                             # local dev
```

The tests apply migrations to their own test D1.

## Deploy wizard

`scripts/deploy-wizard.sh` walks through first-time setup (Cloudflare, D1, both Workers, Telegram, Access). It needs bash (Git Bash on Windows):

```
bash app/scripts/deploy-wizard.sh
```

The full guide, including the manual steps, is [docs/setup.md](../docs/setup.md).
