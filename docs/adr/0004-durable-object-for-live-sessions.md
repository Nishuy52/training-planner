# Live Sessions and rest timers run in a Durable Object

A Live Session's rest timer has to ping Telegram when the rest ends (60 s to 3 min after a Logged Set), even when the app is closed. The 5-minute reminder cron is far too coarse for that, and D1 has no way to wake anything up at a given time. So the single Live Session lives in one SQLite-backed Durable Object. It holds the current step and the rest timer, and an alarm sends the "Rest over" message and deletes it again once the set is logged. Durable Objects with alarms are on the Workers Free plan.

Logged Sets are still written to D1 (`lift_log`) as they are logged, so history, Progress and the "Last time" hints never need to read from the Durable Object.

## Considered Options

- **D1 + the 5-minute cron**: the ping could be up to 5 minutes late, which makes it useless for rest.
- **A Queue message with a delivery delay**: it can fire on time, but it can't be moved or cancelled when a set is logged early or rest is extended (+30 s). It would need a stale-message check on every delivery, and the Live Session state would still need a home.

## Consequences

- Both Workers (`training` and `training-bot`, ADR 0003) must reach the same Durable Object. One Worker defines the class and the other binds to it by `script_name`.
- A wrong or lost alarm must never change the Sequence. Finishing (including the midnight auto-finish) goes through the same `performAction` path as Done.
