# HTTP API Contract

The web tracker (`app/public/app.js`) and the mock (`app/public/mock/mock-api.js`) already use exactly these shapes. The backend must match them. Types are in `app/src/domain/types.ts`; `Exercise` / `Dose` are in `app/src/content/mobility.ts`.

All routes are under `/api` and behind `requireAccess` (`app.use('/api/*', requireAccess)`, which covers `/api/health` too). They return JSON. Bad input gets 400 `{ error }`. Writes (any method but GET/HEAD/OPTIONS) also pass a CSRF guard: a `Sec-Fetch-Site` other than `same-origin`/`none` gets 403, and a POST/PUT without `Content-Type: application/json` gets 415 `{ error }`. Bodies over 64 KB get 413 `{ error }`.

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | – | `{ ok: true }` |
| `GET /api/plan?days=14[&from=YYYY-MM-DD]` | `days` is 1–100. `from` defaults to today in the timezone that applies today (`dayContext(state, todayInDefaultTz).timezone`) | `{ days: DayPlan[], details: { [date]: Array<SessionDetail | null> }, routes }`. `details[date]` is index-aligned with `days[i].sessions`; `routes` is the Route library used to fill run details. |\| null> } }`. `details[date]` is index-aligned with `days[i].sessions`. |
| `GET /api/state` | – | `PlannerState`, including `constraints` and `clubEvents`, plus `amrapLog` and `restSeconds` |
| `POST /api/action` | `Action` (`app/src/domain/actions.ts`) | `{ state, events: string[] }`. A done lift may carry `amrapReps` (integer 0–30, feeds the TM progression) and `sets: SetLog[]` (1–60 entries, `[]` is 400 "sets must not be empty"; only for `ref.kind: 'lift'`, else 400). `SetLog = { group: 'main' \| 'fsl' \| 'finisher', exercise (1–80 chars; the lift name for main sets), n (set number, integer 1–20), rxLoad? (0–1000), rxReps? (integer 0–100), rxRepsMax? (top of a rep range), load? (0–1000), reps? (integer 0–100), unit: 'kg' \| 'lb', amrap?, rpe? (integer 1–10), skipped? }`: the Prescription (`rx*`) next to the Logged Set; unknown keys are dropped. When either is present the done also writes one `lift_log {date, lift, week, amrapReps?, sets?, fslWeightKg?}` row; `fslWeightKg` is the heaviest kg `load` among the sets of the lift's first FSL exercise (the DB variation, e.g. `1-arm DB bench press`; bench's `Weighted chin-up` and OHP's `1-arm DB row` never count), omitted when none or above 500, and becomes the next Session's FSL Prescription (`lastFslWeightKg`). The AMRAP set is the first main set with `amrap: true` and whole-number `reps`: when `amrapReps` is omitted the server derives it from that set (400 if those reps exceed 30), so it feeds `amrapLog` and the `lift_log` row; when both are given and disagree, 400. An AMRAP set logged with `load` only (reps unknown) derives nothing. The web app sends blank reps as the Prescription's, except on the AMRAP set, where it omits `reps`; the Telegram bot sends `amrapReps` only. `{ type: 'set-history', lastClimbDate?, ruckLastCredit?, lastLiftDate?, ruckStep? }` is the one-time Starting point: dates are real `YYYY-MM-DD` or `null` to clear (omitted = unchanged); `ruckStep` is an integer 0–20. Test Week: `{ type: 'start-test-week', dates: { squat, bench, deadlift, ohp } }` (all four real dates) starts one; `{ type: 'test-result', date, lift, weight, reps }` (weight 0 < kg ≤ 500, reps integer 1–15) logs a TM Test result, 409 when no Test Week is active or that lift already has a result (the double-tap guard); each result sets that lift's TM straight away (event `Squat 110 × 5 → Training Max 115 kg (1 of 4 tested)`), and the fourth also ends the Test Week and starts Cycle 1. A correction is explicit: `{ type: 'test-result', date, lift, weight, reps, correct: true }` (same validation; `correct` must be a boolean, `false` is the plain result) replaces that lift's result and recomputes its TM while the Test Week is active and the lift has a result (409 otherwise; after the Test Week the 409 says to use More › Training Max). It is not a new result: the "n of 4" count is unchanged and it never ends the Test Week, adds no Done entry and no Adherence Check-in (event `Deadlift corrected: 20 × 5 → 120 × 5 · Training Max 20 → 125 kg`). After the commit it replaces the lift's `'test'` TM snapshot on the original test date (its Done entry's date, else `date`) with the new TM, and updates that day's TM Test `lift_log` row: `result` becomes the corrected one and `corrected: { from: { weight, reps }, at }` is added (`testSets` stay as logged). A lift with a result in the active Test Week whose TM is still 0 (logged before results set TMs) is healed on the next state load or action, with a `'test'` TM snapshot. A TM Test (`ref.kind: 'lift-test'`) takes `skip` / `tomorrow` (moves it to the next day) but not `done` (400). An `activity` dated before today (local, active timezone) is late (spec §5): it only moves the climb and Hill Ruck clocks forward and never credits a run Session. A done Benchmark Session may carry `benchmark`: `{ timeS }` (whole seconds, 60–14400) for `benchmark-2k4` / `benchmark-hill`, or `{ grade, minutes }` (French grade `^[3-9][abc]\+?$`, stored lowercase; whole minutes 1–240) for a climb at an `endurance_benchmark` Club Event; any other Session, the wrong shape for the kind, or both shapes at once is 400. Every Benchmark Session done (by Done, or by an Activity that completes it) gets a Benchmark Results row, with the result when given; one without waits for `POST /api/benchmark-results` or Telegram `/bench`. When an Activity completes a run Benchmark and looks like it (2.4 km: a run of 2.2–2.8 km; hill loop: any run), its time fills the result with `auto: true` (elapsed time, else moving time, else `hours`), and the sync notice names it (`· 2.4 km Benchmark: 10:42 (from watch) · /bench mm:ss to correct`). Any action that changes a Training Max (week 3 closing a Cycle, each `test-result`, `test-results`, `set-tm`) records a TM snapshot (`reason` `'cycle'` / `'test'` / `'manual'`; unchanged TMs record nothing). An `activity` that completes planned Sessions also appends `{ type: 'activity-credit', date, refs }` to the action log (Adherence counts it). |
| `GET /api/lift-log` | – | `{ entries: [{ date, lift, week?, amrapReps?, sets?, fslWeightKg?, notes?, live?, autoFinished?, abandoned?, notCounted?, duplicateOf?, test?, testSets?, result? }] }`, newest first, at most 200. Live Session rows: see [Live Session](#live-session). |
| `POST /api/lift-log` | `{ date, lift, fslWeightKg?, notes? }` | `{ ok: true }` |
| `GET /api/activities?days=60` | `days` is 1–400; the window ends today (local) | `{ entries: [{ date, name, sport: 'run' \| 'hike' \| 'climb', km?, vertM?, hours?, load?, source: 'intervals' \| 'telegram' }] }`, newest first, at most 500. Rows come from the intervals.icu sync (id `icu:<id>`) and Telegram `/log` (id `log:<date>:<random>`). A `/log` hike on a date that also has an intervals.icu hike is left out, so the weekly totals count that hike once. Synced rows may also carry `movingS` / `elapsedS` (whole seconds, from the sync onward). |
| `GET /api/progress?weeks=12` | `weeks` is 1–104 (default 12); the window is the last `weeks` ISO weeks up to this one (today local) | `{ tmHistory: TmSnapshot[], benchmarks: BenchmarkEntry[], weeklyRuns: WeeklyRun[], adherence: WeekAdherence[] }` (below). `tmHistory` and `benchmarks` (only entries with a result) are oldest first and dated within the window (first Monday to today, never later); `weeklyRuns` and `adherence` have one entry per week, oldest first. |
| `GET /api/benchmark-results?days=365` | `days` is 1–1000; the window ends today (local) | `{ entries: BenchmarkEntry[] }` dated within the window (never after today), newest first, at most 500, including Sessions still without a result |
| `POST /api/benchmark-results` | `{ id?, timeS }` or `{ id?, grade, minutes }` (same rules as `benchmark` on a done) | Sets (or corrects) the result of entry `id`, else of the most recent Benchmark Session whose kind fits and that has no result or one taken from the watch (`auto`; a manual result replaces it and clears `auto`) (`timeS`: 2.4 km / hill loop; `grade`: auto-belay). Returns the saved `BenchmarkEntry`. 409 when nothing waits for a result, 404 for an unknown `id`, 400 when the result does not fit the entry's kind. |
| `POST /api/sync` | `{}` (any JSON body; CSRF guard applies) | Runs the intervals.icu sync now, ignoring the hourly gate: `{ synced: number, notices: string[], skipped?: 'off' }` (`'off'` = no `INTERVALS_API_KEY`). 502 `{ error }` when intervals.icu fails. |
| `POST /api/constraints` | full `Constraint` with an `id` from the client (upsert). Omitted `gymProfileId` = no override; `null` = no gym profile. | the saved `Constraint` |
| `DELETE /api/constraints/:id` | – | `{ ok: true }` |
| `GET /api/routes` | – | `{ routes: Route[] }`, the Route library |
| `POST /api/routes` | full `Route` (upsert by `id`); unknown keys are dropped | the saved `Route`. 400 on an invalid body; 409 when another Route already holds the same `benchmark` (a Benchmark stays fixed). |
| `DELETE /api/routes/:id` | – | `{ ok: true }`; also removes the Route's assignments |
| `PUT /api/route-assignments` | `{ assignments: [{ date, runKind, routeId | null }] }`, at most 30. `null` clears. `ruck` is stored as `long` (the two share the long-run key). | `{ assignments }` as stored. 400 when a `routeId` is not in the library. |
| `GET /api/routing-context?days=8` | `days` 1–14. Planned from **today** and sliced (planning from a later date restarts the rotation) | `{ days: [{ date, location, timezone, mountain, travel, runs: [{ runKind, km, vertM, detail, routeId | null }] }], library: Route[] }`. `runs` lists only planned run Sessions. `location` is the latest-starting matching Constraint's `location`, else `homeLocation`. |
| `POST /api/club-events` | full `ClubEvent` with an `id` from the client (upsert) | the saved `ClubEvent` |
| `DELETE /api/club-events/:id` | – | `{ ok: true }` |
| `GET /api/comments[?from=&to=&status=open\|addressed]` | all filters optional; `from`/`to` are an inclusive date range | `{ comments: PlanComment[] }`, by `date` then `createdAt`, at most 500 |
| `POST /api/comments` | `{ id, date, text, session?, status?, resolution? }` with an `id` from the client (upsert); other fields are ignored. `status` defaults to `'open'` on create and is kept on update when omitted; `createdAt` is kept on update. | the saved `PlanComment` |
| `DELETE /api/comments/:id` | – | `{ ok: true }` |
| `GET /api/mobility?days=30` | – | `{ log: [{ date, status }], streak }` |
| `POST /api/mobility` | `{ date, status: 'done' \| 'skipped' }` | `{ log, streak }` |
| `GET /api/self-checks` | – | `{ [name]: ISODate }` (kv key `selfChecks`) |
| `POST /api/self-checks` | `{ name, date }` | `{ [name]: ISODate }` |
| `PUT /api/settings` | `{ defaultWeek, defaultTimezone, defaultGymProfileId, gymProfiles, rucksEnabled?, homeLocation? }`. `homeLocation` (string, 1–100 chars, default `Hometown`) is the location when no Constraint applies. `defaultWeek` keys are `"0"`–`"6"`; empty Slots are omitted. `rucksEnabled` (boolean, default `false`): when off, the Long run is a trail long run and no Hill Ruck is planned. `restSeconds?: { main?, fsl?, finisher? }` (whole seconds 15–900, merged into the saved values; kv key `restSeconds`, default `{ main: 180, fsl: 90, finisher: 60 }`): the rest timer after a Logged Set, for Live Sessions started afterwards. | `PlannerState` plus `restSeconds` |
| `GET /api/live` | – | `{ live: LiveSession \| null }` |
| `POST /api/live/start` | `{ date, ref, mode? }`: `ref.kind` `lift` or `lift-test` (else 400); `mode` `'resume'` \| `'fresh'` | `{ live }`. 409 when a Live Session is already running, `date` is not today (local), or the Session is not planned. 409 `{ error, resumable: true }` when an attempt at the same date + ref was abandoned earlier with Logged Sets and no `mode` was given: `resume` continues it (its sets, the same `lift_log` row, un-abandoned), `fresh` starts over (the old row stays abandoned). `resume` with nothing to resume is 409. |
| `POST /api/live/log` | `{ step, load?, reps?, rpe?, skip?, top? }`: `step` integer ≥ 1 (a set step), `load` 0–1000, `reps` integer 0–100, `rpe` integer 1–10; `skip` takes none of the others | `{ live }`, or for `top: true` (TM Test only) `{ live: null, events, outcome }`. Logs, skips or corrects one set; see below. 404 with no Live Session; 409 while paused. |
| `POST /api/live/rest` | `{ addSeconds }` (integer 1–900) or `{ stop: true }` | `{ live }`. `addSeconds` extends a running rest, or starts one from now; `stop` ends it (no "Rest over" ping). |
| `POST /api/live/pause` · `POST /api/live/resume` | `{}` | `{ live }`. Pause stops the rest timer and refuses set input (log, rest, warm-up, RPE: 409) until resumed; local midnight still applies. |
| `POST /api/live/warmup-done` | `{}` | `{ live }` |
| `POST /api/live/finish` | `{}` | `{ live: null, events, outcome: 'finished' \| 'not-counted' }`. 409 for a TM Test (it finishes with its top set) or when no set is logged. |
| `POST /api/live/cancel` | `{}` | `{ live: null, outcome: 'cancelled' }`: an accidental start, no trace (no `lift_log` row, no action-log entry). 409 once a set is logged. |
| `POST /api/live/abandon` | `{}` | `{ live: null, outcome: 'abandoned' }` |
| `GET /api/content` | – | `{ alignmentRule, dailyRoutine, morningDrills, morningDrillsNote, selfChecks, warmups, fsl, finishers, travelStrength }` |

Constraint, Club Event, comment and Route writes are also appended to the action log (`{ type: 'comment-upsert', comment }`, `{ type: 'comment-delete', id }`, `{ type: 'route-upsert', route }`, `{ type: 'route-delete', id }`, `{ type: 'route-assignments', assignments }`).

`Constraint` has an optional `location` (string, up to 100 chars, e.g. `Sunny Crag, Southland`).

## Live Session

A lift Session or TM Test in progress, logged set by set from the app or Telegram ([ADR 0004](adr/0004-durable-object-for-live-sessions.md)). There is at most one; it is held by the `LIVE` Durable Object, and the app and the bot see the same state.

```ts
type LiveSession = {
  id: string;                       // 32 hex chars
  date: ISODate;                    // today (local) when started
  ref: { kind: 'lift'; lift; week } | { kind: 'lift-test'; lift };
  title: string;                    // "Squat — Week 1 (5s)", "OHP — 5-rep max test"
  steps: LiveStep[];                // steps[0] is the Warm-up
  current: number;                  // step to log next: 0 until the Warm-up is done; steps.length when a lift has every set
                                    // logged, and for a TM Test the next work-up set (it has no prescribed sets)
  next: { load?, reps?, unit, loadStep } | null; // what "✓ As prescribed" logs on the current set, Reps/Load −/+ applied
  restEndsAt: string | null;        // ISO; set when the next set is logged (not a skip or a correction)
  startedAt: string; autoFinishAt: string; // ISO; autoFinishAt = the start of the next local day
  loggedSets: number;               // logged and not skipped
  paused: boolean;
};
type LiveStep =
  | { kind: 'warmup'; items: string[]; done: boolean }
  | { kind: 'set'; group: 'main' | 'fsl' | 'finisher' | 'test'; exercise; n; of?; unit: 'kg' | 'lb';
      rxLoad?; rxReps?; rxRepsMax?; amrap?; dose?;  // dose: a non-"N x M" dose (e.g. "2 x 30 s/side"), ticked off
      restSeconds; loadStep;                         // loadStep: Gym Profile plate step, or the machine lb step
      load?; reps?; rpe?; skipped?; top?; loggedAt?; // what was logged
      status: 'met' | 'over' | 'under' | 'amrap' | 'skipped' | 'done' | null };
```

- **Steps.** A lift: Warm-up, the main sets, FSL, then Finisher; an FSL or Finisher dose `N x M` (or `N x M-K`) becomes N sets, as `parseDose` in `public/sets.js`. The first FSL exercise is prescribed the last FSL weight. A TM Test: Warm-up, then any number of work-up sets (`group: 'test'`), the last logged with `top: true`. A TM Test has no Prescription: until a work-up set is logged `next` has no `load` (never the bar), and logging without one is 400 "type the weight, e.g. 100x5"; later sets carry the previous set's load and reps over. The app confirms the top set before sending `top: true` ("Top set 20 kg × 5 → Training Max 20 kg. Save?", plus "That's much lower than your other lifts — check the weight" when the TM is under half the median TM of the other lifts tested this Test Week).
- **Logging** `step` = 1 + index in `steps`. Fields left out take the set's Prescription, else the load of the previous set of the same exercise (a TM Test: the previous work-up set, first 20 kg × 5). Logging any set marks the Warm-up done. Newly logging the current set starts its rest (`restSeconds` of its group) and deletes the Telegram "Rest over" ping; a skip, a correction (re-logging a step) or an RPE does neither.
- **Status**: `under` if the load or the reps fall short of the Prescription; `met` if equal (a rep range is met up to its top); `over` if both are at least the Prescription and one is above; the AMRAP set reports `amrap` (its reps) unless its load fell short; a set with no Prescription is `done`.
- **D1.** The first Logged Set inserts one `lift_log` row (`{ date, lift, week, live: true, sets, fslWeightKg? }`; a TM Test: `{ date, lift, test: true, live: true, testSets }`), rewritten as each set is logged. Finish rewrites the same row through the Done path (`performAction`): `{ date, lift, week, amrapReps?, sets, fslWeightKg?, autoFinished? }`; the AMRAP reps derive from the sets and the Sequence advances. The state write also commits kv `liveDone:<id>`, so a retried finish whose follow-up writes failed is recognised as counted. A TM Test's top set logs a `test-result` (it sets that lift's TM; the fourth also ends the Test Week) and the row gets `result: { weight, reps }`. Abandon leaves the Sequence alone and marks the row `abandoned: true`; Cancel deletes it.
- **Done elsewhere meanwhile** (e.g. a Done tap): finish leaves the Sequence alone (`outcome: 'not-counted'`). The Logged Sets join that Session's `lift_log` row when it has no sets of its own (the Live row goes); with no such row the Live row becomes the Session's row; if that row already has sets the Live row is kept as `notCounted: true, duplicateOf: <id>`.
- `lastFslWeight` (the next FSL Prescription) ignores `live`, `abandoned` and `notCounted` rows.
- **Local midnight** (an alarm, also checked on every request; paused or not): a lift Live Session with at least one Logged Set finishes as Done with `autoFinished: true` (also on the action log entry); one with none, or a TM Test without its top set, is discarded. No Telegram message is sent then; the next reply-keyboard press gets the outcome line and the keyboard removal.
- **Telegram** (same state): the 07:00 message and `/today` have a full-width "▶ Start Squat" row above each lift's and TM Test's Check-in row. A Live Session shows one message edited in place, with [✓ As prescribed] [Reps −/+] [Load −/+] [⏭ Skip set] [🏁 Finish] and [✕ Cancel] (no confirmation) until a set is logged, then [✖ Abandon] (asks first); a TM Test has [✓ Work-up …] [🏁 Top set] once a weight is known (before the first work-up set the message says "Type the weight, e.g. 100x5" and has no set buttons); 🏁 Top set (or typed `top 102.5x5`) does not log at once: the same message asks "Top set 102.5 kg × 5 → Training Max 105 kg. Save?" (with the low-result warning when it applies) with [✓ Save top set] [↩︎ Back] (callback ops `tpy` / `tpn`), and any other change drops the question; paused it shows "⏸ Paused" and [▶ Resume]. A reply keyboard `✓ Set done` · `+30 s rest` · `Pause` · `Finish` stays until it ends (`Pause` toggles; a second `✓ Set done` within 3 s of a log is ignored). `/test <lift> <kg> <reps>` asks first: a lift without a result gets "Deadlift 120 kg × 5 → Training Max 125 kg. Save?" (plus the low-result warning) with [✓ Save] [✕ Cancel] (`a|ts|…` / `a|tx|<date>|<lift>|<kg>|<reps>`); a tested lift gets the replace question with [✓ Replace] [✕ Keep] (`a|tc|…` / `a|tk|…`); the answer edits that message. Typed: `67.5x4`, `x4`, `67.5`, `skip`, `… rpe 8`, `rpe 8` (the last Logged Set), `top 102.5x5`, `resume`. ▶ Start on a Session abandoned earlier today with Logged Sets asks [▶ Resume] / [Start fresh]. When a rest ends the bot sends a new "⏰ Rest over — Set 3: 70 kg × 5+" message. The app gets no alert.

## Route

```ts
Route = { id: string;            // /^[A-Za-z0-9_-]{1,40}$/
  name: string; area: string;    // area: "Place, Region"
  km: number; vertM: number;     // the whole session as run (approach plus all laps)
  kind: 'loop' | 'repeat'; repeats?: number;  // integer 1-50, laps of the climb
  url?: string;                  // https only; rendered escaped
  suits: RunKind[];
  benchmark?: 'hill' | '2k4';    // at most one Route per Benchmark
  notes?: string }               // up to 500 chars; "PROPOSED BENCHMARK ..." marks a proposal
```

A run's `route` comes from the assignment for (date, run kind). A Benchmark run (`benchmark-hill` / `benchmark-2k4`) always uses the Route flagged with that `benchmark`, whatever the assignments say.

## PlanComment

A note on a future day or Session ("my knee felt off, go easier on this run", "I'll be in Riverton this day"). Open comments are input for a Replan, which adapts the plan and then saves the comment back with `status: 'addressed'` and a `resolution`.

```ts
type PlanComment = {
  id: string;            // client-generated, /^[A-Za-z0-9_-]{1,64}$/
  date: ISODate;         // the day the comment is about
  session?: { key: string; label: string }; // key /^[a-z0-9:-]{1,40}$/, e.g. "lift:squat", "run:quality-vert", "climb", "lift-test:bench", "travel-strength"; label ≤ 80 chars, e.g. "Squat — Week 1 (5s)"
  text: string;          // trimmed, 1–1000 chars
  status: 'open' | 'addressed';
  createdAt: string;     // ISO timestamp, server-set on first save, kept on update
  updatedAt: string;     // ISO timestamp, server-set on every save
  resolution?: string;   // ≤ 1000 chars: what the Replan did about it
};
```

## Progress

```ts
type TmSnapshot = { date: ISODate; lift: Lift; tm: number; reason: 'cycle' | 'test' | 'manual' }; // kg; from now on (no backfill)

type BenchmarkEntry = {
  id: number; date: ISODate;
  kind: '2k4' | 'hill' | 'autobelay';
  eventId?: string;                 // the endurance_benchmark Club Event (auto-belay)
  timeS?: number;                   // 2k4 / hill
  grade?: string; minutes?: number; // autobelay
  auto?: true;                      // the time came from the synced Activity; a manual result replaces it
};                                  // no result fields = done without a result yet

type WeeklyRun = {
  monday: ISODate;
  km: number; vertM: number;        // run + hike Activities that week (as the Plan week header totals), late ones included
  targetKm: number | null; targetVertM: number | null; deload: boolean; // weeklyTarget(run week); null before runStartMonday
};

type KindCount = { expected: number; done: number; skipped: number };
type WeekAdherence = { monday: ISODate; expected: number; done: number; skipped: number;
                       byKind: { lift: KindCount; run: KindCount; climb: KindCount } };
```

**Adherence** (`src/domain/adherence.ts`): per day up to today, with the planner's rules and the Constraints / Club Events / Default Week as stored now: a Club Event day expects one climb (not on a mountain day, where the planner skips it); each run Slot expects a run unless a mountain or Arrival Day; the lift Slot, a Club Event day without one (the planner's am lift before a climb), or the week's first day with a `run` Slot that allows runs (where the Default Week puts the Easy run, which gets a lift in its other Slot) expects a lift unless a mountain or Travel Day (on a no-gym day it is Travel Strength, which counts as `lift`; TM Tests count as `lift` too). At most two a day (climb, then runs, then the lift gives way) and three runs a week. Done = Done, TM Test results and Sessions an Activity completed, from the action log (plus `doneByDate`); skipped = Skips. Both are counted per kind and capped at what was expected, so extra Sessions never push a kind past 100 %. A day with no Check-in is a miss: `expected - done - skipped`.

## SessionDetail (by `kind`)

```ts
type SessionDetail =
  | { kind: 'lift'; lift: Lift; week: CycleWeek | 'reentry'; tm: number; gymProfileId: string;
      mainSets: SetRx[];            // mainSets(lift, tm, week === 'reentry' ? 4 : week, gymProfile)
      warmup: Exercise[]; fsl: Exercise[]; lastFslWeightKg: number | null;
      finisher: Exercise[] }        // squat: FINISHERS.lower[0], deadlift: FINISHERS.lower[1] (consecutive lower sessions alternate); bench/ohp: FINISHERS.upper[0]
  | { kind: 'lift-test'; lift: Lift; warmup: Exercise[]; protocol: string }   // TM Test (Test Week)
  | { kind: 'travel-strength'; exercises: Exercise[] }
  | { kind: 'run'; run: RunKind; rx: { km: number; vertM: number; detail: string };
      target: { km: number; vertM: number; deload: boolean };   // weeklyTarget(week index of that date)
      route: { id, name, km, vertM, kind: 'loop' | 'repeat', repeats?, url? } | null; // the assigned Route (see Route), or the Benchmark Route on a Benchmark run
      ruckLoad?: { packKg: number; vertM: number } }             // only for 'ruck'; for rucks rx.vertM := ruckLoad.vertM
  | { kind: 'climb'; event: ClubEvent | null; fallback: boolean;
      finisher: string };           // partner: 'Last 30 min: endurance laps (climb, lower, straight back on)'; endurance_benchmark: 'Benchmark: continuous minutes on auto-belay at a fixed grade — log grade + minutes'; fallback: 'Boulder session @ the bouldering gym'
```

- **Done sessions:** `details` for a session with `status: 'done'` may be `null`.
- **Mock mode:** turned on only by `?mock=1`. A failed `/api/health` must **not** silently switch production to demo data. Show an error banner with a retry instead.
