# Setup

This guide deploys your own copy of the planner: two Cloudflare Workers that share one D1 database, a Telegram bot, and Cloudflare Access in front of the tracker. Everything fits in the Cloudflare Workers Free plan.

You can let the wizard do it (Option A) or do it by hand (Option B). Both end in the same place.

## Prerequisites

- **Node.js 22 or newer.** Wrangler 4 requires Node 22 or later. `package.json` sets no `engines` field of its own.
- **A Cloudflare account** (the Free plan is fine). You sign in once with `npx wrangler login`.
- **A Telegram account**, to create the bot and receive reminders.
- **bash**, for the scripts in `app/scripts/`. On Windows, use Git Bash.
- **curl**, used by the wizard and in the Telegram steps below.

Install the dependencies first:

```bash
cd app
npm install
```

All `npx wrangler …` commands below run from `app/`.

## Option A: the deploy wizard

```bash
bash app/scripts/deploy-wizard.sh          # macOS / Linux / Git Bash
```

On Windows from PowerShell: `& "C:\Program Files\Git\bin\bash.exe" app/scripts/deploy-wizard.sh`.

The wizard runs from `app/` wherever you start it, and walks through eight stages:

1. `wrangler login`, then shows `wrangler whoami` so you can check the account.
2. Creates the `training` D1 database (or reuses it), writes its id into both `REPLACE_AFTER_d1_create` placeholders in `app/wrangler.jsonc`, and applies the migrations remotely.
3. Deploys `training` (`--env=""`), then `training-bot` (`--env bot`), and asks for the two `workers.dev` URLs they print.
4. Asks you to create a bot with @BotFather (`/newbot`), then asks for its username and token. It checks the token with `getMe` and stores it as `TELEGRAM_BOT_TOKEN` on both Workers.
5. Finds your chat ID from the message you send the bot (`getUpdates`) and stores it as `TELEGRAM_CHAT_ID` on both Workers.
6. Generates a webhook secret, stores it as `TELEGRAM_WEBHOOK_SECRET` on the bot Worker, and calls `setWebhook`.
7. Walks you through enabling Cloudflare Access on the `training` Worker, writes `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` into `wrangler.jsonc`, and redeploys.
8. Smoke test: open the tracker, sign in, and send `/today` to the bot.

Secrets go straight to Cloudflare through `wrangler secret put`. They are never written to disk. Non-secret values (D1 id, URLs, bot username, chat ID, Access values) are saved in `app/.env.deploy` so that a re-run offers them as defaults. That file is gitignored by the root `.env.*` rule. Re-running the wizard is safe.

The wizard edits `app/wrangler.jsonc` (D1 id and Access vars). Those values identify your account, so think twice before you commit them to a public fork.

The wizard does not set up the optional intervals.icu sync. See [Optional: intervals.icu sync](#optional-intervalsicu-sync).

## Option B: by hand

### 1. Sign in and create the database

```bash
npx wrangler login
npx wrangler d1 create training
```

Copy the `database_id` it prints into **both** `"database_id": "REPLACE_AFTER_d1_create"` entries in `app/wrangler.jsonc`: the top-level one (app Worker) and the one under `env.bot`.

Apply the schema:

```bash
npx wrangler d1 migrations apply training --remote
```

### 2. Deploy both Workers

The order matters the first time. The app Worker defines the Live Session Durable Object class. The bot Worker binds to it by `script_name`, so the class must exist first ([ADR 0004](adr/0004-durable-object-for-live-sessions.md)).

```bash
npx wrangler deploy --env=""      # "training": tracker, API, cron, Durable Object
npx wrangler deploy --env bot     # "training-bot": POST /telegram/webhook only
```

Each deploy prints its URL, e.g. `https://training.<your-subdomain>.workers.dev` and `https://training-bot.<your-subdomain>.workers.dev`. If Wrangler asks you to register a `workers.dev` subdomain, pick any name.

Until Access is configured (step 4), the deployed API answers `403` to everything. See [What the Access vars do](#what-the-access-vars-do).

### 3. Telegram

**Create the bot.** In Telegram, open @BotFather and send `/newbot`. Choose a display name and a username that ends in `bot`. BotFather replies with the bot's HTTP API token.

**Find your chat ID.** Send your new bot any message (e.g. `hi`), then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Your chat ID is `result[].message.chat.id` on a message whose `chat.type` is `"private"`. The bot answers only this chat. Updates from any other chat are ignored.

**Generate a webhook secret**, for example:

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

**Store the secrets.** Each command prompts for the value. The app Worker uses the token and chat ID for reminders and Live Session messages. The bot Worker needs all three.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN --env=""
npx wrangler secret put TELEGRAM_CHAT_ID   --env=""

npx wrangler secret put TELEGRAM_BOT_TOKEN      --env bot
npx wrangler secret put TELEGRAM_CHAT_ID        --env bot
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env bot
```

**Register the webhook** on the bot Worker. Telegram then sends the secret in the `X-Telegram-Bot-Api-Secret-Token` header on every update, and the bot Worker rejects any request without it.

```bash
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://training-bot.<your-subdomain>.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=<WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

You should get `{"ok":true,...}`.

### 4. Cloudflare Access on the app Worker

Access puts a login (an emailed one-time code) in front of the tracker. The API also verifies the Access JWT itself ([`app/src/http/auth.ts`](../app/src/http/auth.ts)).

1. In the Cloudflare dashboard, open **Workers & Pages → training → Settings → Domains & Routes**.
2. On the `workers.dev` row (and Preview URLs), click **Enable Cloudflare Access**. If you are asked to create a Zero Trust team, pick a team name. The Free plan is fine.
3. The dialog shows **POLICY_AUD** and **TEAM_DOMAIN**. Click **Manage Cloudflare Access** and check that the policy allows your email. If the application's cookie settings offer it, set SameSite to Lax.
4. Put both values into the **top-level** `vars` in `app/wrangler.jsonc`. `ACCESS_TEAM_DOMAIN` is the bare host, without `https://`:

   ```jsonc
   "vars": { "ROLE": "app", "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com", "ACCESS_AUD": "<POLICY_AUD>" },
   ```

5. Redeploy the app Worker: `npx wrangler deploy --env=""`.

**Leave Access off on `training-bot`.** Telegram cannot sign in to Access, so the webhook must stay reachable. The webhook secret header protects it instead. The bot Worker serves nothing except `POST /telegram/webhook`, and every other path returns 404 ([ADR 0003](adr/0003-separate-bot-worker.md)). Its Access vars stay empty.

#### What the Access vars do

`requireAccess` in `app/src/http/auth.ts` guards every `/api/*` route:

- **Both vars empty and the host is `localhost` or `127.0.0.1`** (i.e. `wrangler dev`): the request is let through without a token. This is the local-dev escape hatch.
- **Either var empty on any other host**: `403`. An unconfigured deployment fails closed. That is why the API answers 403 between the first deploy and step 4.
- **Both set**: the `Cf-Access-Jwt-Assertion` header must be a valid RS256 JWT from `https://<ACCESS_TEAM_DOMAIN>`, with audience `ACCESS_AUD`. Otherwise `403`.

### 5. Smoke test

- Open `https://training.<your-subdomain>.workers.dev`, sign in with the emailed code, and check that the Today tab loads with no red banner.
- Send `/today` to your bot. It should answer with today's plan and buttons.

## After deploying

Everything else is set in the tracker, under **More**:

- **Settings**: the default timezone (an IANA name such as `Europe/Berlin`; new installs start on `Europe/Berlin`), your home location (used to pick Routes when no trip applies; default `Hometown`), Gym Profiles (new installs get a `Home Gym` and a `Travel gym` to edit), the Default Week and the Hill Rucks toggle.
- **Test Week** / **Training Max**: start a Test Week (each result sets that lift's Training Max), or edit the Training Maxes directly.
- **Starting point**: your last climb, lift and Hill Ruck dates, so the Sequence picks up where you are.
- **Club Events**: your club's sessions, added by hand. They set the climb days.
- **Trips**: Constraints (dates, timezone, location, no-gym or mountain days, Travel Days).
- **Routes**: the run Route library (or let the [weekly routine](routines/weekly-routes.md) fill it).

Reminders go out at 07:00 (the day's Sessions), 21:30 (mobility) and Sunday 19:00 (week preview). All three use the local time of the current Constraint, or the default timezone when no Constraint applies. The cron runs every 5 minutes on the app Worker only.

Routine redeploys:

```bash
cd app
npx wrangler d1 migrations apply training --remote   # only when migrations/ changed
npx wrangler deploy --env=""
npx wrangler deploy --env bot
```

## Optional: intervals.icu sync

With an intervals.icu API key, the app Worker credits watch-recorded runs, hikes and climbs (at most hourly, after the reminders), and the **Sync now** button runs it on demand. Get the key from intervals.icu → Settings → Developer Settings → API key, then:

```bash
npx wrangler secret put INTERVALS_API_KEY --env=""
```

The key belongs on the app Worker only. Without it, the sync is off.

## Optional: service token for scripts and routines

`app/scripts/api.mjs` is a small CLI for the API behind Access. The weekly Routes routine ([docs/routines/weekly-routes.md](routines/weekly-routes.md)) uses the same token to reach the API. Both authenticate with a Cloudflare Access service token instead of your email login.

```bash
bash app/scripts/store-service-token.sh
```

The script needs a **git checkout**. It runs `git check-ignore` to make sure `app/.env.replan` will never be committed, and it stops if that check fails. If you downloaded a ZIP, run `git init` in the repo root first, or clone the repo instead.

The script walks you through these steps:

1. Create a service token in Zero Trust → Access → Service credentials → Service Tokens.
2. Add a policy with the **Service Auth** action to the `training` Access application. With "Allow" instead, Access redirects the token to the login page.
3. Paste the Client ID and Secret (hidden input).
4. Run a smoke test against `/api/health`.

The script stores `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `APP_URL` in `app/.env.replan`, which is gitignored. It refuses to write the file if git does not ignore it. `APP_URL` is taken from the environment or the existing file. Failing that, it uses the `APP_URL` the deploy wizard saved in `app/.env.deploy`, and otherwise it asks you.

Then:

```bash
node app/scripts/api.mjs GET /api/health
node app/scripts/api.mjs GET '/api/routing-context?days=8'
```

`api.mjs` reads `APP_URL`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the environment, falling back to `app/.env.replan`. It refuses to run without `APP_URL`, and refuses any URL that is not `https`.

## Local development

```bash
cd app
npm run db:migrate:local      # local D1 under app/.wrangler/ (gitignored)
npm run dev                   # wrangler dev → http://localhost:8787
```

- On `localhost` with the Access vars empty, the API needs no login (see above).
- Secrets for local runs go in `app/.dev.vars` (gitignored). Copy [`app/.dev.vars.example`](../app/.dev.vars.example). None are needed just to use the tracker.
- To exercise the bot Worker and the Live Session Durable Object together, run `npx wrangler dev` and `npx wrangler dev --env bot` in two terminals. The bot's `script_name` binding finds the app's object through the local dev registry.
- **Demo data:** add `?mock=1` to the tracker URL (e.g. `http://localhost:8787/?mock=1`). Every request then goes to an in-memory mock built from `app/public/mock/*.json`, and nothing is saved.
- Tests: `npm test` (vitest in the Workers pool, against its own test D1) and `npm run typecheck`.
