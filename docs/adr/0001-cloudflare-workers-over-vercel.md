# Host on Cloudflare Workers + D1, not Vercel

Two-way Telegram reminders need an always-on webhook, a small database, and scheduled jobs that fire at 07:00 and 21:30 in whatever timezone the athlete is currently in. Vercel's free plan only runs cron jobs once a day at loose times, so we moved the whole app (web tracker, bot, API) to Cloudflare Workers with D1 and a Cron Trigger every 5 minutes. The app is protected by Cloudflare Access (an emailed one-time code).

## Considered Options

- Vercel functions + hosted Postgres: kept the existing deploy, but daily-only cron can't follow timezone changes.
- GitHub Actions cron: free, but runs 15-60 min late and adds a third moving part.
