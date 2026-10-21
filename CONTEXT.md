# Training Planner

One person's integrated training plan (strength, running, climbing, mobility) built for mountain fitness, kept flexible around travel and nudged along by Telegram reminders.

## Language

### Planning structure

**Session**:
One planned workout (a strength day, a run, a climb, a mobility routine).
_Avoid_: Workout, block, day

**Sequence**:
The ordered rotation of Sessions. The next Session comes up when the previous one is done or skipped. A missed day delays the Sequence; it does not drop the Session.
_Avoid_: Schedule, calendar

**Default Day**:
The weekday a Session normally lands on, so weeks look alike when life allows. The Default Day is a preference, not a commitment.
_Avoid_: Fixed day, slot

**Slot**:
Morning or evening half of a day. Two Sessions may share a day only in different Slots.
_Avoid_: Double, AM/PM session

**Daily Routine**:
The nightly mobility routine. It sits outside the Sequence, happens every day including on trips, and is ticked off rather than advanced.
_Avoid_: Mobility session, stretching

**Cycle**:
One 5/3/1 wave: the 5s week, the 3s week and the 5/3/1 week, plus a deload. Training Maxes only rise after a completed Cycle.
_Avoid_: Block, mesocycle, wave

**Block**:
A run of weeks with a single training focus (e.g. base building before a trip).
_Avoid_: Phase, cycle

**Re-entry Week**:
A deload-style week inserted before resuming a Cycle after 7 or more days without lifting. Gaps shorter than that resume where they left off.
_Avoid_: Reset, restart

### Strength

**Training Max**:
The working max that 5/3/1 percentages are calculated from, per main lift.
_Avoid_: 1RM, max, TM (in prose)

**TM Test**:
A Session during Test Week that works up to a hard 5-rep max for one lift. Each result sets that lift's Training Max straight away; Cycle 1 starts once all four lifts are tested.
_Avoid_: Max test, 1RM test

**FSL**:
"First Set Last": supplemental volume after the main 5/3/1 sets. Here it is done as a single-sided dumbbell variation of the main lift (e.g. Bulgarian split squat after Squat), because single-sided strength matters more than barbell numbers.
_Avoid_: Back-off sets, BBB

**Prescription**:
The load and reps the plan calls for in one set of a lift Session.
_Avoid_: Recommended, target, planned set

**Logged Set**:
The load and reps actually done in one set, compared against its Prescription: met, over or under (the AMRAP set reports its reps instead).
_Avoid_: Actual, result, entry

**Live Session**:
A lift Session or TM Test in progress, logged set by set from the app or Telegram until it is finished or abandoned. There is at most one at a time.
_Avoid_: Workout, active session, in-progress

**Finisher**:
Short isolation work at the end of a lift Session (e.g. curls, lateral raises, Cossack squats, hamstring curls) for muscles the compound lifts miss.
_Avoid_: Accessories, pump work

### Running

**Benchmark**:
A repeatable test that measures progress: the 2.4 km run, a fixed hill-climb loop, and continuous minutes on an auto-belay.
_Avoid_: Time trial, race, test

**Benchmark Result**:
The measured outcome of a Benchmark Session: a time for the 2.4 km or the hill loop, or a grade and continuous minutes on the auto-belay.
_Avoid_: Score, PB, test result

**Route**:
A named, repeatable run course (distance and climbing) kept in a library and attached to run and Hill Ruck Sessions automatically at the start of each week, chosen near the current location. A Route is either a loop or a Repeat (laps of one climb to build up metres climbed), e.g. the Benchmark hill loop.
_Avoid_: Course, loop, segment

**Route Assignment**:
The link between one run Session (a date and a run kind) and a Route from the library. The weekly routine sets it; the athlete can change it.
_Avoid_: Route plan, mapping

**Hill Ruck**:
A hike with a loaded pack on a hilly Route, meant to train carrying weight uphill for mountain trips. It is an occasional Session, not a weekly one, and can be switched off; while it's off, the Long run is a trail run. A mountain-hike Activity with about 600 m+ of climbing counts as a Hill Ruck and resets the clock.
_Avoid_: Ruck march, weighted hike, loaded carry

**Leg block**:
A lift Slot where Squat and Deadlift are not placed: after a run the same day, or the day after a hard run. The next Bench or OHP of the round goes in instead and the leg lift waits for the next Slot. With neither left, a block by an Easy run alone yields.
_Avoid_: Hard-leg guard, leg rest day

**Travel Strength**:
A pure-calisthenics Session that replaces a lift when a Constraint rules out the gym. It holds the Cycle in place and counts as lifting for the Re-entry clock, but does not advance the Cycle.
_Avoid_: Bodyweight day, hotel workout

### Climbing

**Endurance Climb**:
Route climbing aimed at being able to climb longer routes: back-to-back laps, not bouldering. It is done as a Partner Climb's last 30 minutes and as the monthly auto-belay Benchmark at Wall C (club open days).
_Avoid_: ARC, laps, bouldering

**Partner Climb**:
A climb Session (indoor or outdoor) that depends on a partner. It records intent and what happened, with no set prescription.
_Avoid_: Social climb, lead day

**Club Event**:
A scheduled climbing-club session, such as Friday at Wall A, Sunday training at Wall B, or Monday at Wall C. It is where Partner Climbs usually happen. Club Events come from the club calendar and set the climb Sessions' days.
_Avoid_: Meetup, club night

**Boulder Fallback**:
A bouldering session at the bouldering gym that replaces a rope climb after 7 days without one. Ropes are preferred; bouldering keeps the climbing going.
_Avoid_: Conditioning, hangboard day

### Places

**Gym Profile**:
The equipment and loading rules of one gym: units, plate step, max load and what is available. Every lift Session is calculated against the active Gym Profile, which a Constraint can switch. Examples: Home Gym (kg, 2.5 kg steps) and the Travel gym (machine presses in lb, 10 lb pins, 200 lb cap).
_Avoid_: Gym, location, equipment set

### Priority

**Protected Session**:
A Session that is kept when the week gets squeezed. Climbing and runs are protected. Strength gives way first.
_Avoid_: Key session, must-do

**Adherence**:
Sessions done in a week against what the Default Week and Club Events expected, after Constraints. A day with no Check-in counts as a miss even though the Sequence simply waits.
_Avoid_: Compliance, consistency, completion rate

### Travel and reality

**Constraint**:
A dated condition that limits what Sessions are possible (no gym, mountain days, bodyweight only). It can carry the location where it applies.
_Avoid_: Blocker, exception

**Travel Day**:
The first day (Departure Day: runs only, Long allowed, no rucks or lifts) or last day (Arrival Day: mobility only) of a trip Constraint. Each trip can turn it off.
_Avoid_: Transit day, flight day

**Replan**:
A run-by-hand rewrite of upcoming Sessions to fit Constraints while keeping the week's training intent. Shown as a diff before it is applied.
_Avoid_: Reschedule, adjust

**Plan Comment**:
A note left on a future day or Session (e.g. "knee felt off, go easier", "in Riverton this day"). Open Plan Comments are input for the next Replan, which marks them addressed with what it changed.
_Avoid_: Note, annotation

**Activity**:
Something that actually happened, as recorded by a device or service (e.g. a Strava hike). It is distinct from a planned Session. An Activity can count toward a Session's intent based on its actual load, not just its type.
_Avoid_: Log, workout

**Check-in**:
A Done / Skip / Tomorrow response to a Telegram reminder that advances or holds the Sequence.
_Avoid_: Ack, reply
