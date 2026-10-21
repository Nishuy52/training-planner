# Training Spec

The rules the app implements. The vocabulary is defined in [CONTEXT.md](../CONTEXT.md). This is the source of truth for *what* the plan does. The implementation plans say *how*.

## 1. The Sequence

- **Lifts roll fully.** The lift queue's head is placed in the next lift Slot (the Default Week's, the am Slot before a climb, or the other Slot on the Easy-run day: see below). A missed day drops nothing: the head simply lands in the next lift Slot.
- **Runs roll within a week.** Each week has 3 runs (Easy, Quality, Long, where Long may be a Hill Ruck). A run not done moves to the next run Slot in the same week. Long / Ruck only goes in a `run-long` Slot unless no `run-long` Slot is left that week. Runs still not done when the week ends are dropped (the weekly km just isn't met).
- **Climbs are event-driven:** see §4.
- **Done** → advance. **Skip** → advance, recorded as skipped. **Tomorrow** → the item gets `not_before = tomorrow`, and the rest of its queue waits behind it.
- At most one lift Session per day. Two Sessions on one day must be in different Slots (AM / PM).

### Default Week (editable in Settings)

| Day | AM | PM |
|---|---|---|
| Mon | lift | climb *(only if a Club Event, e.g. Wall C)* |
| Tue | run (easy / quality) | *(lift after the Easy run)* |
| Wed | run (easy / quality) | *(lift after the Easy run, if it rolls here)* |
| Thu | lift | |
| Fri | *(lift before the climb)* | climb *(Club Event: Wall A 18:00)* |
| Sat | run-long (long run / Hill Ruck) | |
| Sun | lift | climb *(only if a Club Event: Wall B 16:00)* |

- **A lift before a climb:** any day with a climb in pm (a Club Event or a Boulder Fallback, planned or done) gets a lift in am if am is free, on top of the Default Week's lift Slots. If a day's Default Week lift Slot is taken by a climb, the lift goes in the other Slot if it is free.
- **A lift on the Easy-run day:** any day with an Easy run (planned or done) gets a lift in the day's other Slot if it is free, on top of the Default Week's lift Slots: pm after an am Easy run, am before a pm one. It follows the Easy run wherever it lands that week (runs roll, so it may be Tuesday or Wednesday); a Quality, Long, Hill Ruck or Benchmark day gets none. The leg block below applies, so after an am Easy run the lift is usually Bench or OHP.
- **Usual lift rules** for both: at most one lift a day, none on mountain or Travel Days or in a Test Week, none before a Tomorrow's `not_before`, Travel Strength on `no_gym` days.
- **Legs after runs:** Squat or Deadlift is not placed (a) in a Slot that comes after a run the same day (an am run blocks a pm leg lift), or (b) on the day after a hard run (Quality, Long, Hill Ruck or Benchmark; not Easy), whether that run is planned or done. Legs *before* a run are fine: a pm run the same day, or a hard run the next day. When the head is a leg lift and the Slot blocks legs, the next upper-body lift (Bench or OHP) of the current round goes in instead, and the leg lift stays the head for the next Slot that allows it. With no upper-body lift left in the round (stuck), a block by an Easy run earlier that day yields and the leg lift goes in pm after it, so a Default Week like the seed one never stalls into a Re-entry Week. A block by a hard run, the same day or the day before, never yields: then the Slot stays empty. The plan never reaches into the next round.
- **Slot choice:** a run goes in its Default Slot. If a done Session already occupies that Slot, the run uses the day's other Slot.
- **Mountain days and Constraints:** no lift, run or climb is placed on a mountain day. On `no_gym` days, see Travel Strength.
- **Travel Days:** the first and last day of a *trip* Constraint (one that sets `timezone` or `no_gym`) are Travel Days unless it sets `travelDays: false`. A Constraint that only marks mountain days inside a trip has no Travel Days unless it sets `travelDays: true`. Mountain days take precedence over Travel Days.
  - **Departure Day** (first day): runs as normal, *including Long*. No lifts, no Travel Strength, no Hill Ruck, no Boulder Fallback. If a Hill Ruck is due, that day's long-run Slot gets a plain Long run, and the ruck stays due.
  - **Arrival Day** (last day): nothing except mobility. Club Events are still shown.
  - **What happens to the rest:** lifts wait (rolling). Runs not placed roll within the week as usual.

## 2. Strength (5/3/1)

- **Lift rotation:** Squat → Bench → Deadlift → OHP, one main lift per Session, 3 lift Slots a week (Default Days Mon / Thu / Sun) plus one on the Easy-run day and one before each climb, so about 5 Sessions a week with two Club Events.
- **Cycle:** 16 lift Sessions = 4 Cycle weeks × 4 lifts. The rotation pointer `(cycleWeek ∈ {1,2,3,4}, liftIndex ∈ 0..3)` advances on Done or Skip. A Bench or OHP swapped in ahead of a blocked leg lift (§1 Legs after runs) is recorded as done ahead in the round (`ahead`); the pointer stays on the leg lift and skips the swapped lift when it gets there. Wrapping into the next Cycle week clears it. A Re-entry Week keeps its own record (`phase.ahead`, dropped when it ends) and leaves the Cycle week's untouched, so when the Cycle resumes a lift already done in that Cycle week is not planned again.

| Cycle week | Set 1 | Set 2 | Set 3 |
|---|---|---|---|
| 1 (5s) | 65% × 5 | 75% × 5 | 85% × 5+ |
| 2 (3s) | 70% × 3 | 80% × 3 | 90% × 3+ |
| 3 (5/3/1) | 75% × 5 | 85% × 3 | 95% × 1+ |
| 4 (deload) | 40% × 5 | 50% × 5 | 60% × 5 |

- **"+" = AMRAP** (as many reps as possible). The rep count is logged.
- **Training Max progression:** applied after a lift's week-3 Session when the logged AMRAP reps meet the target (5 for week 1, 3 for week 2, 1 for week 3). Lower body +5 kg, upper body +2.5 kg. If a week's AMRAP fell short, that lift's TM stays the same.
- **Rounding:** to the active Gym Profile's plate step. Travel gym profile: Bench and OHP are on a machine in lb, rounded to 10 lb, capped at 200 lb and flagged `*` when capped.
- **FSL slot:** a dumbbell single-sided variation of the main lift, 4 × 8 per side, RPE 7–8. The weight is logged, and the last logged weight is shown next time.

| Main lift | FSL variation |
|---|---|
| Squat | DB Bulgarian split squat |
| Bench | 1-arm DB bench press, plus weighted chin-up 3 × 5 |
| Deadlift | DB single-leg RDL |
| OHP | half-kneeling 1-arm DB press, plus 1-arm DB row 3 × 8 |

- **Finisher:** 2 isolation exercises × 2 × 12–15.
  - Lower days: Cossack squat (kneecap forward) + Nordic / hamstring curl. Side plank with top-leg raise, or Copenhagen plank, on alternate Sessions.
  - Upper days: bicep curl + lateral raise / reverse fly.
- **Warm-up:** see §6.
- **Test Week:** a dated block with one **TM Test** Session per lift (e.g. Sat Squat, Sun Bench, Mon Deadlift, Tue OHP), placed in the AM Slot.
  - **Content:** the lift's warm-up, then a ramp (bar × 10, about 40% × 5, 60% × 3, 75% × 2), then sets of 5 in 2.5–5 kg jumps to a hard 5-rep max (1 rep in reserve, at most 3 heavy sets).
  - **Done** asks for weight and reps (4–8 reps is fine). Each result sets that lift's TM straight away (TM = round_down_to_plate_step(0.9 × e1RM), e1RM = weight × (1 + reps/30), plate step of the default Gym Profile). When all four lifts have one, the Test Week ends, the pointer resets to Cycle 1 week 1, `lastLiftDate` = the last test date, and `lift.notBefore` = the next day.
  - **Skip:** the TM Test moves to the next day (it is rolling).
  - **While a Test Week is active:** no regular lift Sessions are placed. Runs and climbs plan as usual.
  - **Entering results directly** under More › Test Week still works and ends the Test Week.
- **Re-entry Week:** when the next lift Session would be placed and ≥ 7 days have passed since the last lift (Travel Strength counts as a lift), insert 4 deload-percentage Sessions (one per lift) before resuming the pointer. Under 7 days: resume.
- **Travel Strength:** when the day's Constraint says `no_gym` (and it isn't a mountain day), the lift Slot becomes Travel Strength (calisthenics). It does **not** advance the pointer. It **does** reset the Re-entry clock.
  - Content: Bulgarian split squat (bodyweight) 3 × 12/side, pistol progression 3 × 5/side, single-leg RDL 3 × 10/side, push-up variation 3 × max−2, pull-ups 3 × max−2 *(if a bar exists)*, side plank 2 × 45 s/side.

## 3. Running

- **Run queue order:** Easy → Quality → Long. Quality alternates Vert ↔ Speed.
  - **Vert:** hill repeats, or one sustained climb.
  - **Speed:** 2.4 km-pace intervals, e.g. 6 × 400 m with 90 s jog, progressing to 5 × 600 m / 4 × 800 m.
- **Weekly targets:** start at **15 km / 300 m** climbed. Each week is ~10% more than the previous non-deload week, capped at **35 km / 1000 m**. Every 4th week is a deload at 70%.
  - Split: Easy 30%, Quality 25%, Long 45% of the km. The metres climbed go mostly to Quality-Vert and Long.
- **Benchmarks** happen in run-deload weeks, replacing that week's Quality run and alternating:
  - **2.4 km time trial**, flat.
  - **Hill loop** (a fixed Route near home), timed.
- **Hill Rucks can be switched off** (Setting `rucksEnabled`, currently **off**). While they're off, the Long run is always a trail long run. Mountain hikes are still credited as the Long run and toward the weekly metres climbed, and they still update the ruck clock, so turning rucks back on starts from the real date.
- **Hill Ruck:** replaces the Long run when ≥ 21 days have passed since the last Hill Ruck credit.
  - Load starts at 10 kg, 2–2.5 h, 600 m+. Each ruck adds +2 kg **or** +150 m (alternating), capped at 20 kg / 1200 m.
  - Any mountain-hike Activity with ≥ 600 m climbed is credited as a Hill Ruck (resets the 21-day clock). If a pack weight is logged, it also advances the load.
  - Not protected: when a day is over-full it gives way like a lift does.
- **Routes:** the weekly routine attaches a Route (a loop, or a Repeat = laps of one climb) to each run / ruck Session near the current location. It prefers the saved library. If no Route is attached, the Session simply shows its targets.

## 4. Climbing

- **Club Events** are entered by hand: date, time, venue, title, and a type of either `partner` or `endurance_benchmark`. Each upcoming Club Event becomes a climb Session in that day's PM Slot.
- **Partner Climb** (usually lead): intent and what happened are logged. The prescription is only the **endurance finisher**: the last 30 min is back-to-back route laps, progressing from continuous laps to 4×4s on routes.
- **Endurance Benchmark** (monthly, Wall C auto-belays): continuous minutes climbed at a fixed grade. The grade and minutes are logged.
- **Club Events** always go in the PM Slot. If PM is already taken (two events in one day, or a climb already done), the extra event is shown as a note rather than a second Session. On a mountain day no Club Event is planned: it is shown as a note ("Skipped: Wall A 18:00 (mountain day)").
- **Boulder Fallback:** if no climb has been done for 7 days and no Club Event is in the next 2 days (an event on a mountain day doesn't count, since it won't be planned), place a bouldering Session at the bouldering gym in the next free PM Slot. It is only placed **at home**: not on `no_gym` days, not on mountain days, and not when the day's timezone differs from the default timezone. Mountain days reset the climb clock.

## 5. Constraints and Activities

- **Constraint** = a date range plus any of:
  - `timezone` (IANA)
  - `gym_profile_id` (or none)
  - `no_gym`
  - `mountain` (mountain days)
  - `travelDays` (default: true for trip Constraints that set `timezone` or `no_gym`, false otherwise)
  - `note`
- Constraints can be added in the app, or by a Replan (for example an automation using the API) after the user approves the diff.
- **Mountain day:**
  - No runs, lifts or climbs (Club Events or Boulder Fallback) are placed; the day still resets the climb clock.
  - The morning reminder is replaced by "Mountain day — check in tonight".
  - Mobility still runs.
- **Activity crediting** (intervals.icu, or a manual Check-in `/log <hours>h <metres>m <effort 1-10>`):

| Activity | Counts as |
|---|---|
| Rock climbing | the next climb Session that day, or a standalone climb (resets the Boulder Fallback clock) |
| Run | the matching run Session that day; km and metres climbed go to the weekly totals |
| Hike, ≥ 600 m climbed | Hill Ruck credit **and** the week's Long run |
| Hike, load ≥ 60 *(intervals.icu training load)* or ≥ 2 h, < 600 m | Long run |
| Hike, load 25–60 | Easy run |
| Hike, smaller | nothing (still counts toward weekly km and metres climbed) |

  Strength is never credited by an Activity. Thresholds are editable settings.
- **Strength Activities** (WeightTraining from the watch) never credit a lift: the app needs the lift and the AMRAP reps. If one syncs **today** while a lift Session or TM Test is still planned and not done, Telegram sends **one nudge** for that Activity: "⌚ Strength session synced. Log your <lift> <week>?" with that Session's usual buttons, or the `/test` hint during Test Week. No nudge is sent if the lift was already done (e.g. via Telegram), if the Activity is late, or if no lift is planned. Strength Activities are always listed with the athlete's Activities.
- **Late Activities** (dated before today in the active timezone, e.g. synced after a trip):
  - They update the climb clock and the Hill Ruck clock **only forwards** (never earlier than the stored date).
  - They count toward weekly km and metres climbed.
  - They **never** credit run Sessions or advance the run queue. The athlete may already have tapped Done, and one physical run must not count twice.
- **Today's Activities** credit as in the table above. A run Activity on a day whose run Session is already done credits nothing more.

## 6. Mobility

### Daily Routine (nightly)

Doses: **HOLD** = 45 s per side. **REPS** = 10 slow reps per side with a 3 s pause.

*Standing at wall*

| # | Exercise | Dose |
|---|---|---|
| 1 | Short foot (arch up, toes long, big-toe base down) | REPS |
| 2 | Big toe press (other four toes lifted) | REPS |
| 3 | Wall tibialis raise (heels down, kneecaps forward), both feet | REPS |
| 4 | Wall calf stretch: (a) straight knee, (b) bent knee | HOLD each |
| 5 | Standing outer hip stretch (leg crossed behind, hip out, arm over) | HOLD |
| 6 | Chin tucks | REPS |
| 7 | Neck stretch: (a) ear to shoulder, (b) nose to armpit | HOLD each |

*Kneeling at bed*

| # | Exercise | Dose |
|---|---|---|
| 8 | Bed chest stretch (forearm on bed, elbow at shoulder height, rotate away) | HOLD |
| 9 | Kneeling thoracic extension (elbows on bed edge, hips back, lower back flat) | HOLD × 2 |
| 10 | Half-kneeling hip flexor (glute squeezed) | HOLD |
| 11 | Thread the needle | REPS |

*Floor*

| # | Exercise | Dose |
|---|---|---|
| 12 | 90/90 switches (lead with the back knee) | REPS |
| 13 | Side-lying hip internal rotation (knees together, top foot lifts) | REPS |
| 14 | Knee-to-opposite-shoulder | HOLD |
| 15 | Hand-assisted hamstring: (a) kneecap to ceiling, (b) across the body with hips flat, (c) leg turned in | HOLD each |

**Alignment rule** (shown on every standing or kneeling item): kneecap forward first and the foot follows. Tripod foot (big-toe base, little-toe base, heel). A 10–15° toe-out is normal.

**Optional morning drills** (a tick, not reminded):
- Seated hip CARs 5/side
- Frog hip internal rotation 6/side
- Standing hip circles 5/direction/leg

Do 1 set of each, building to 3.

**Monthly self-checks** (tasks):
- Shin rotation check: seated on a high chair, compare foot angles.
- Ober test, both sides.

### Pre-lift warm-up (~10 min, gym; bands available at the home gym)

The old tracker's warm-ups are restored in full, plus the additions below. Applied cue fixes:
- Knee-to-wall: "kneecap over 2nd toe" (not "little toe").
- All lunges and squats: kneecap forward.
- Clamshells and 90/90: knees track, no forcing.

| Lift | Warm-up |
|---|---|
| Squat | knee-to-wall dorsiflexion 2 × 10, hip CARs 5/side, short-lever Copenhagen 20 s/side, banded clamshell 2 × 15, deep squat hold 45 s (kneecaps forward), banded tib-post inversion 2 × 15 |
| Deadlift | inchworm with hip-flexor pause × 5, 90/90 transitions 10/side, 90/90 internal-rotation lift 10/side, paused glute bridge 2 × 10, ankle circle + calf raise 10/side, banded tib-post inversion 2 × 15 |
| Bench | band pull-apart 2 × 15, band face pull 2 × 15, side-lying shoulder ER 2 × 12, floor pec-minor stretch 2 × 30 s, prone Y-T-W 1 × 10 |
| OHP | foam-roller thoracic extension 8–10, prone Y-T-W 2 × 8, band dislocates 10, thread the needle 2 × 8/side, side-lying 90/90 ER 2 × 12, wall slides 10 |

**Removed for good:** figure-4 / pigeon / piriformis-ball release (it loads the knee).

## 7. Reminders (Telegram)

All times are local, using the timezone of the active Constraint (default Europe/Berlin).

| When | Message |
|---|---|
| 07:00 | Today's Sessions with weights / targets / Route, plus [Done] [Skip] [Tomorrow] buttons per Session. Mountain day: "Mountain day — check in tonight" plus a Check-in hint. Nothing planned: a one-line rest note. |
| 21:30 | Daily Routine nudge with [Done] [Skipped]. On mountain days also: "How was today? `/log 6h 900m 7`". |
| Sunday 19:00 | Preview of the coming 7 days, plus the week's km / metres-climbed targets. |

Messages are sent once per local date per kind, even if the cron runs late.
