# Telegram webhook runs on a separate Worker

Cloudflare's one-click Access protects a whole Worker (all of its hostnames). It has no documented way to leave one path public, but Telegram must reach `/telegram/webhook` without signing in. So the same code is deployed twice, with both Workers bound to the same D1 database:

- `training`: the web tracker, API and reminder cron, behind Access.
- `training-bot` (`ROLE=bot`): serves only `/telegram/webhook` and checks Telegram's secret header. Everything else returns 404. It has no cron.

The API still checks the Access JWT itself, so a misrouted request to either Worker fails closed.
