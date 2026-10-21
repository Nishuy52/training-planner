# Weekly Routes routine

A cloud routine that runs every Sunday evening and attaches a **Route** to each run Session of the coming week, near where the athlete will be. Vocabulary in `CONTEXT.md` (Route, Route Assignment, Benchmark, Hill Ruck).

The prompt below is self-contained: copy everything between the two `PROMPT` rules into the routine. The setup is at the end.

---
<!-- PROMPT START -->

You attach Routes to the athlete's run Sessions for the next 8 days. You work only through the training API below, plus the AllTrails connector (or your own map knowledge) to find routes. If the routine has a trip-notes repo attached as context, read it only for local hints about a trip, and leave it unchanged.

## API

The base URL is in the environment as `$APP_URL` (your `training` Worker, e.g. `https://training.<your-subdomain>.workers.dev`). The service token is in the environment as `$CF_ACCESS_CLIENT_ID` and `$CF_ACCESS_CLIENT_SECRET`. Refer to it only through those variables: keep shell tracing off and keep their values out of every file, command line you print, and message.

```bash
api() { # api METHOD PATH [BODY_FILE]
  curl -sS --fail-with-body -X "$1" "${APP_URL%/}$2" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    ${3:+--data-binary @"$3"}
}
```

| Call | Use |
|---|---|
| `api GET '/api/routing-context?days=8'` | `{ days: [{ date, location, timezone, mountain, travel, runs: [{ runKind, km, vertM, detail, routeId }] }], library: Route[] }` |
| `api POST /api/routes route.json` | upsert one Route |
| `api PUT /api/route-assignments assign.json` | `{ "assignments": [{ "date", "runKind", "routeId" }] }`, at most 30; `routeId: null` clears |

A **Route** is `{ id, name, area, km, vertM, kind: "loop" | "repeat", repeats?, url?, suits: RunKind[], benchmark?: "hill" | "2k4", notes? }`:
- `id` matches `^[A-Za-z0-9_-]{1,40}$`: a lowercase slug of the name, plus `-x<reps>` for a Repeat (`hill-repeats-x3`).
- `km` and `vertM` are the whole session as run: approach plus all laps for a Repeat.
- `url` is https: the AllTrails page, or a maps link.
- `suits` lists the run kinds it fits: `easy`, `quality-vert`, `quality-speed`, `long`, `ruck`, `benchmark-2k4`, `benchmark-hill`.
- `area` is "Place, Region", in the same words as the `location` it was found for.

If `routing-context` fails (non-2xx, or a login page instead of JSON), stop and report the status: the week simply has no Routes.

## Steps

### 1. Read the week

`api GET '/api/routing-context?days=8'`. Make a worklist of every run with `routeId: null`, skipping:
- days with `mountain: true`, days with `travel: "arrival"`, and days with no runs;
- `benchmark-hill` / `benchmark-2k4` runs when the library already has a Route with that `benchmark` (the app uses it automatically).

On a `travel: "departure"` day the run usually happens before leaving, so look for its Route near the previous day's `location`.

**Done when** each run is either on the worklist or skipped with its reason noted for the summary.

### 2. Match the library first

For each worklist run, a library Route **fits** when:
- `suits` includes the run's `runKind`;
- `km` is within ±20% of the run's `km`;
- `vertM` is at least 70% of the run's `vertM`;
- its `area` is the run's `location` (same town or valley).

Among fits, take the closest `km`; for `quality-vert`, `long` and `ruck` prefer more `vertM`. Use one Route at most twice in the week unless nothing else fits.

### 3. Find new Routes for the rest

Search near `location` with the AllTrails connector (trails near a place, then trail details for distance, elevation gain and the page URL). Without the connector, use map knowledge and give a maps link instead. Check each candidate against the same km / vert test.

- `easy`, `quality-speed`: flat loops (the Lake loop at home).
- `quality-vert`, `long`, `ruck`: climbs. When no loop has enough vert, build a **Repeat** of one climb:
  - `lap_km` = up and down once; `lap_vert` = gain per lap; `approach_km` / `approach_vert` = from the start to the foot of the climb and back.
  - `repeats` = ceil((target vertM − approach_vert) / lap_vert), at least 1.
  - `km` = approach_km + repeats × lap_km; `vertM` = approach_vert + repeats × lap_vert.
  - Keep `km` within +20% of the target: if it overshoots, choose a steeper climb or one rep fewer (still ≥ 70% vert).

`POST` each new Route (one file per Route), then use it like a library Route.

**Done when** every worklist run has a Route, or a one-line reason why none fits.

### 4. Propose the hill Benchmark (only while none exists)

Do this only when no library Route has `benchmark: "hill"` and none has notes starting "PROPOSED BENCHMARK". Find one fixed hill loop starting near the athlete's home location (the `location` of a day with no trip; `homeLocation` in Settings): 4–8 km, 200–400 m of climbing, runnable all year, one unambiguous line. Save it **without** a `benchmark` field, with `suits: ["benchmark-hill", "quality-vert"]` and `notes: "PROPOSED BENCHMARK — confirm in tracker"`. The athlete promotes it with the tracker's "Make this the Benchmark" button; the Benchmark must stay fixed, so propose once and let it stand.

### 5. Assign

One `PUT /api/route-assignments` with every match from steps 2–4: `{ date, runKind, routeId }`. A `ruck` run uses `runKind: "long"` (long and ruck share one assignment). Leave everything not on the worklist out of the body.

**Done when** the PUT returns 2xx, or its error is recorded for the summary.

### 6. Summary

End with one paragraph: how many runs got a Route (library vs new), each new Route as `name (km · vert ↑)`, the runs left without one and why, whether a Benchmark was proposed, and any API error with its status. The Sunday 19:00 Telegram preview shows the Routes to the athlete.

<!-- PROMPT END -->
---

## How to create the routine

1. **Prerequisites.** The app is deployed (see [setup](../setup.md)), and the `claude-replan` service token has a Service Auth rule on the `training` Access application (`app/scripts/store-service-token.sh` walks through it and smoke-tests the token).
2. **Create it with the `schedule` skill** (`/schedule` in Claude Code): a recurring cloud routine named `weekly-routes`, with this repo (and, optionally, a repo of your own trip notes) as context and the prompt above as its instructions. Enable the AllTrails connector for it if it is available.
3. **Schedule:** Sunday 18:00 in your home timezone (the example below uses Europe/Berlin).
   - If the scheduler takes a timezone, use cron `0 18 * * 0` with `Europe/Berlin`.
   - If it takes UTC only, use `0 16 * * 0`: that is 18:00 in summer (CEST, UTC+2) and 17:00 in winter (CET, UTC+1). Central Europe changes clocks on the last Sunday of March and October. 16:00 UTC keeps the run before the 19:00 Telegram preview all year; `0 17 * * 0` would land at 19:00 in summer, racing the preview.
4. **Secrets:** the athlete enters `APP_URL`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the routine's environment settings (values from the service token, or `app/.env.replan`). They are typed there by the athlete only, never pasted into a chat or the prompt.
5. **Network:** if the cloud environment restricts outbound traffic, allow your `training` Worker host (e.g. `training.<your-subdomain>.workers.dev`).
6. **Test:** run it once by hand from the routine page and check the summary, then the tracker's run cards. If a run fails, runs simply have no Route that week; nothing else depends on it.
