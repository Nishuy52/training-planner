# Training Planner

A single-athlete training planner that runs on Cloudflare's free tier. It combines a rolling 5/3/1 strength Sequence, running toward a 2.4 km time trial and mountain running, climbing (built around your club's sessions) and a nightly mobility Daily Routine. It is travel-aware: Constraints and Travel Days bend the plan around trips, timezones and gym changes. Two-way Telegram reminders let you mark Sessions done, skipped or moved without opening the tracker.

Each deployment serves one person: one Telegram chat and one Cloudflare Access login.

## What it does

**Tracker**: a static web app behind Cloudflare Access. Tabs: Today, Plan, Progress and More (Trips, Club Events, Test Week, Training Max, Routes, Daily Routine, Settings, Starting point). Lift Sessions can be logged set by set as a Live Session, with a rest timer.

**Telegram**: reminders at 07:00 (the day's Sessions, with buttons), 21:30 (the Daily Routine nudge, plus a check-in prompt on mountain days) and Sunday 19:00 (week preview). They follow the local time of the current Constraint.

Commands:

- `/today` - today's Sessions with buttons
- `/week` - the next 7 days
- `/log 6h 900m 7` - log a hike: hours, metres climbed, effort 1-10
- `/amrap squat 8` - add AMRAP reps to a lift marked done without reps
- `/test squat 102.5 5` - log a TM Test result (weight in kg, reps 1-15)
- `/bench 10:42` - save a time to the latest run Benchmark (2.4 km or hill loop) that is still waiting for one, or overwrite a time the watch sync filled in automatically; `/bench 6a+ 15` does the same for the auto-belay Benchmark (grade and minutes)
- `/help` - the command list

Each Session has three buttons: Done, Skip and Tomorrow. Each asks you to confirm first: in Telegram with a ✓ / ↩︎ Cancel row (e.g. "✓ Skip Squat 5s"), in the web app with a confirm dialog. Marking a week 1-3 lift Done in Telegram shows the AMRAP reps picker instead, and tapping a rep count is the confirmation.

Other features:

- **Test Week**: start one from the UI, and each lift gets a TM Test Session. Each result sets that lift's Training Max straight away. Cycle 1 starts once all four are tested.
- **Starting point**: a one-time entry of your last climb, last Hill Ruck, last lift and Hill Ruck step, so the Sequence picks up where you are.
- **Gym Profiles**: plate steps, and machine lifts in lb with pin steps and a cap. A trip can switch the Gym Profile.
- **Hill Rucks toggle** (Settings): off by default. While it's off, the Long run is a trail run.
- **Club Events and Trips**: add Club Events by hand, and Trips (Constraints with Travel Days) in the Trips page.
- **Routes**: a library of run courses, attached to run Sessions near where you will be.
- **intervals.icu sync** (optional): watch-recorded runs, hikes and climbs are credited automatically.

## Architecture

```
            Cloudflare Access (email one-time code)
                         │
 browser ──────► training Worker (ROLE=app) ────────┐
                 • static tracker (app/public)      │
                 • /api/* (verifies the Access JWT) ├──► D1 database "training"
                 • cron */5: reminders + sync       │
                 • LiveSessionObject (Durable Obj.) │
                         ▲ script_name binding      │
 Telegram ─────► training-bot Worker (ROLE=bot) ────┘
                 • POST /telegram/webhook only
                 • checks X-Telegram-Bot-Api-Secret-Token
```

- **Two Workers, one codebase, one D1 database** ([ADR 0003](docs/adr/0003-separate-bot-worker.md)). One-click Access protects a whole Worker, but Telegram must reach the webhook without signing in. So the same code is deployed twice: `training` (tracker, API, cron) behind Access, and `training-bot` (`ROLE=bot`), which serves only the webhook and returns 404 for everything else.
- **Defence in depth**: the API re-verifies the Access JWT itself (`app/src/http/auth.ts`). An unconfigured deployment fails closed. The webhook checks Telegram's secret header and answers only your chat ID.
- **Durable Object** ([ADR 0004](docs/adr/0004-durable-object-for-live-sessions.md)): the single Live Session and its rest-timer alarm live in a SQLite-backed Durable Object. The alarm sends the "Rest over" ping on time. The app Worker defines the class and the bot Worker binds to it by `script_name`.
- **Cron**: every 5 minutes on the app Worker. It sends whichever reminders are due in the current local time, then runs the intervals.icu sync (at most hourly).
- **intervals.icu** ([ADR 0002](docs/adr/0002-intervals-icu-not-strava-or-garmin-direct.md)): optional. With `INTERVALS_API_KEY` set, the app pulls Activities from intervals.icu and credits them against planned Sessions.
- **Pure domain core**: the planner in `app/src/domain` has no I/O (Sequence, 5/3/1 math, running targets, Constraints). `app/src/store` persists state in D1, and Hono serves the API.

## Setup

You need Node.js 22+, a Cloudflare account (Free plan), a Telegram account and bash (Git Bash on Windows).

```bash
cd app && npm install && cd ..
bash app/scripts/deploy-wizard.sh
```

The wizard handles the whole first deploy: Wrangler login, the D1 database and migrations, both Workers, a BotFather bot with its token, chat ID and webhook, and Cloudflare Access.

**[docs/setup.md](docs/setup.md)** has the full guide: what the wizard does, the manual equivalent step by step, Access, the optional intervals.icu sync and service token, and local development.

Routine redeploys:

```bash
cd app
npx wrangler d1 migrations apply training --remote   # when migrations/ changed
npx wrangler deploy --env=""
npx wrangler deploy --env bot
```

## Development

```bash
cd app
npm install
npm test               # vitest in the Workers pool
npm run typecheck
npm run db:migrate:local
npm run dev            # http://localhost:8787 (add ?mock=1 for demo data)
```

## Repo layout

- `app/` - the Worker app (source, tests, migrations, static tracker, scripts)
- `docs/` - setup guide, training spec, API contract, ADRs, the weekly Routes routine
- `CONTEXT.md` - glossary of domain terms

## Docs

- [Setup](docs/setup.md)
- [CONTEXT.md](CONTEXT.md) - glossary
- [Training spec](docs/training-spec.md) - the rules
- [API contract](docs/api-contract.md)
- ADRs: [0001 Workers over Vercel](docs/adr/0001-cloudflare-workers-over-vercel.md), [0002 intervals.icu](docs/adr/0002-intervals-icu-not-strava-or-garmin-direct.md), [0003 separate bot Worker](docs/adr/0003-separate-bot-worker.md), [0004 Durable Object for Live Sessions](docs/adr/0004-durable-object-for-live-sessions.md)
- [Weekly Routes routine](docs/routines/weekly-routes.md)
- [Developer notes](app/README.md)
