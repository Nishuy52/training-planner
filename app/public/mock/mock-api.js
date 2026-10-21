// In-memory stand-in for /api/* used by ?mock=1 (or when /api/health fails).
// Loads the hand-written fixtures in this folder and answers the same routes and
// shapes as the real API contract. Mutations live only until the page reloads.

import { liftRows, setStatus } from '../sets.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const addDaysIso = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function refCode(r) {
  if (r.kind === 'lift') return `L.${r.lift}.${r.week}`;
  if (r.kind === 'lift-test') return `X.${r.lift}`;
  if (r.kind === 'run') return `R.${r.run}`;
  if (r.kind === 'climb') return `C.${r.eventId || 'fb'}`;
  return 'T';
}

function streakOf(log) {
  const byDate = new Map(log.map((e) => [e.date, e.status]));
  const sorted = [...byDate.keys()].sort();
  if (!sorted.length) return 0;
  let n = 0;
  let d = new Date(sorted[sorted.length - 1] + 'T00:00:00Z');
  while (byDate.get(d.toISOString().slice(0, 10)) === 'done') {
    n++;
    d = new Date(d.getTime() - 86400000);
  }
  return n;
}

export async function createMockApi(base = './mock/') {
  const load = async (f) => (await fetch(base + f)).json();
  const [plan, state, content, mobility, liftLog, commentsFx, progress] = await Promise.all(
    ['plan.json', 'state.json', 'content.json', 'mobility.json', 'lift-log.json', 'comments.json', 'progress.json'].map(load),
  );
  let comments = commentsFx.comments;
  // Benchmark Sessions done (with or without a result), newest first, as GET /api/benchmark-results.
  const benchmarks = progress.benchmarks.slice().reverse();
  let nextBenchmarkId = 100;

  // Benchmark Results: same rules as the real API (docs/api-contract.md).
  const GRADE = /^[3-9][abc]\+?$/;
  function checkBenchmark(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('benchmark must be an object');
    if (b.timeS !== undefined) {
      if (b.grade !== undefined || b.minutes !== undefined) throw bad('give timeS, or grade and minutes, not both');
      if (!Number.isInteger(b.timeS) || b.timeS < 60 || b.timeS > 14400) throw bad('timeS must be between 60 and 14400');
      return { timeS: b.timeS };
    }
    const grade = typeof b.grade === 'string' ? b.grade.trim().toLowerCase() : '';
    if (!GRADE.test(grade)) throw bad('grade must be a French grade such as 6a+ (or give timeS)');
    if (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > 240) throw bad('minutes must be between 1 and 240');
    return { grade, minutes: b.minutes };
  }
  function benchmarkKindOf(ref) {
    if (ref.kind === 'run') return ref.run === 'benchmark-2k4' ? '2k4' : ref.run === 'benchmark-hill' ? 'hill' : null;
    if (ref.kind === 'climb' && ref.eventId) {
      const ev = state.clubEvents.find((e) => e.id === ref.eventId);
      return ev && ev.type === 'endurance_benchmark' ? 'autobelay' : null;
    }
    return null;
  }
  function saveBenchmarkResult(b) {
    const r = checkBenchmark(b);
    const timeKind = (k) => k !== 'autobelay';
    const e = b.id !== undefined
      ? benchmarks.find((x) => x.id === b.id)
      : benchmarks.find((x) => ((x.timeS === undefined && x.grade === undefined) || x.auto) && timeKind(x.kind) === ('timeS' in r));
    if (!e) throw Object.assign(new Error(b.id !== undefined ? 'not found' : 'no Benchmark Session is waiting for a result'), { status: b.id !== undefined ? 404 : 409 });
    if (timeKind(e.kind) !== ('timeS' in r)) throw bad(timeKind(e.kind) ? 'a run Benchmark takes timeS' : 'the auto-belay Benchmark takes grade and minutes');
    delete e.timeS; delete e.grade; delete e.minutes; delete e.auto;
    Object.assign(e, r);
    return clone(e);
  }

  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  // Same rules as the real API. POST replaces the whole comment: only status and
  // createdAt carry over when omitted; session and resolution go if left out.
  function saveComment(b) {
    if (!b || typeof b !== 'object') throw bad('body must be an object');
    if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.id)) throw bad('invalid id');
    if (typeof b.date !== 'string' || !ISO_DATE.test(b.date)) throw bad('invalid date');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length < 1 || text.length > 1000) throw bad('text must be 1–1000 characters');
    if (b.status !== undefined && b.status !== 'open' && b.status !== 'addressed') throw bad('invalid status');
    if (b.session !== undefined) {
      const s = b.session;
      if (!s || typeof s.key !== 'string' || !/^[a-z0-9:-]{1,40}$/.test(s.key)) throw bad('invalid session.key');
      if (s.label !== undefined && (typeof s.label !== 'string' || s.label.length > 80)) throw bad('invalid session.label');
    }
    if (b.resolution !== undefined && typeof b.resolution !== 'string') throw bad('invalid resolution');
    const prev = comments.find((c) => c.id === b.id);
    const now = new Date().toISOString();
    const c = { id: b.id, date: b.date, text, status: b.status || (prev && prev.status) || 'open', createdAt: (prev && prev.createdAt) || now, updatedAt: now };
    if (b.session) c.session = { key: b.session.key, ...(b.session.label !== undefined ? { label: b.session.label } : {}) };
    if (b.resolution) c.resolution = b.resolution;
    comments = comments.filter((x) => x.id !== c.id).concat([c]);
    return clone(c);
  }

  // The real API's `sets` rules (docs/api-contract.md), so ?mock=1 rejects what the server would.
  function checkSets(a) {
    if (a.type !== 'done' || !a.ref || a.ref.kind !== 'lift') throw bad('sets only applies to a lift');
    if (!Array.isArray(a.sets) || a.sets.length > 60) throw bad('sets must be an array of at most 60');
    if (a.sets.length === 0) throw bad('sets must not be empty');
    const n = (v, min, max, int) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v)));
    for (const x of a.sets) {
      const ok = x && ['main', 'fsl', 'finisher'].includes(x.group) && typeof x.exercise === 'string' && x.exercise.trim() && x.exercise.length <= 80
        && typeof x.n === 'number' && n(x.n, 1, 20, true) && ['kg', 'lb'].includes(x.unit)
        && n(x.rxLoad, 0, 1000) && n(x.rxReps, 0, 100, true) && n(x.rxRepsMax, 0, 100, true) && n(x.load, 0, 1000) && n(x.reps, 0, 100, true)
        && (x.amrap === undefined || typeof x.amrap === 'boolean') && n(x.rpe, 1, 10, true);
      if (!ok) throw bad('invalid sets entry');
    }
    const derived = amrapFromSets(a.sets);
    if (derived !== undefined) {
      if (a.amrapReps == null && derived > 30) throw bad("the AMRAP set's reps must be between 0 and 30");
      if (a.amrapReps != null && a.amrapReps !== derived) throw bad("amrapReps does not match the AMRAP set's reps");
    }
  }

  const amrapFromSets = (sets) => {
    const s = sets.find((x) => x.group === 'main' && x.amrap === true && Number.isInteger(x.reps));
    return s ? s.reps : undefined;
  };
  // As the real API: the heaviest kg load on the lift's first FSL exercise, at most 500.
  const fslWeightFromSets = (lift, sets) => {
    const name = content.fsl[lift] && content.fsl[lift][0] && content.fsl[lift][0].name;
    const loads = sets.filter((x) => x.group === 'fsl' && x.exercise === name && x.unit === 'kg' && x.load != null).map((x) => x.load);
    const w = loads.length ? Math.max(...loads) : undefined;
    return w !== undefined && w <= 500 ? w : undefined;
  };

  function findSession(date, ref) {
    const day = plan.days.find((d) => d.date === date);
    if (!day) return null;
    const i = day.sessions.findIndex((s) => refCode(s) === refCode(ref));
    return i < 0 ? null : { day, i };
  }

  const TEST_PROTOCOL = 'Ramp: bar × 10, ~40% × 5, ~60% × 3, ~75% × 2. Then sets of 5 in 2.5–5 kg jumps to a hard 5-rep max (1 rep in reserve, at most 3 heavy sets). 4–8 reps on the top set is fine: log its weight and reps.';
  const tmFromTest = (w, r, step) => Math.floor((0.9 * w * (1 + r / 30)) / step + 1e-9) * step;

  // Mock simplification: a Test Week puts each TM Test in the AM Slot of its date (if that day is in the
  // fixture plan) and drops the regular lifts from the plan; no rolling.
  function startTestWeek(dates) {
    state.testWeek = { dates, results: {} };
    for (const day of plan.days) {
      const keep = day.sessions.map((s, i) => [s, plan.details[day.date][i]]).filter(([s]) => s.kind !== 'lift' && s.kind !== 'lift-test');
      const lift = Object.keys(dates).find((l) => dates[l] === day.date);
      if (lift) keep.unshift([{ kind: 'lift-test', lift, slot: 'am', status: 'planned' }, { kind: 'lift-test', lift, warmup: content.warmups[lift] || [], protocol: TEST_PROTOCOL }]);
      day.sessions = keep.map(([s]) => s);
      plan.details[day.date] = keep.map(([, d]) => d);
    }
  }

  function applyAction(a) {
    const events = [];
    if (a.type === 'start-test-week') {
      startTestWeek(a.dates);
      return { state: clone(state), events };
    }
    if (a.type === 'test-result') {
      if (!(a.weight > 0 && a.weight <= 500)) throw Object.assign(new Error('weight must be a number in (0, 500]'), { status: 400 });
      if (!(Number.isInteger(a.reps) && a.reps >= 1 && a.reps <= 15)) throw Object.assign(new Error('reps must be a whole number in [1, 15]'), { status: 400 });
      if (a.correct !== undefined && typeof a.correct !== 'boolean') throw Object.assign(new Error('correct must be true or false'), { status: 400 });
      const name = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' }[a.lift];
      const g = state.gymProfiles.find((x) => x.id === state.defaultGymProfileId);
      if (a.correct) {
        // As the real API: replaces the result and its Training Max; not a new result, never ends the Test Week.
        if (!state.testWeek) throw Object.assign(new Error('the Test Week is over: change the Training Max in More › Training Max'), { status: 409 });
        const prev = state.testWeek.results[a.lift];
        if (!prev) throw Object.assign(new Error(`${a.lift} has no TM Test result to correct yet`), { status: 409 });
        const from = state.tms[a.lift];
        state.testWeek.results[a.lift] = { weight: a.weight, reps: a.reps };
        state.tms[a.lift] = tmFromTest(a.weight, a.reps, (g && g.plateStepKg) || 2.5);
        events.push(`${name} corrected: ${prev.weight} × ${prev.reps} → ${a.weight} × ${a.reps} · Training Max ${from} → ${state.tms[a.lift]} kg`);
        return { state: clone(state), events };
      }
      if (!state.testWeek || state.testWeek.results[a.lift]) throw Object.assign(new Error('session is not planned for that date (already handled?)'), { status: 409 });
      state.testWeek.results[a.lift] = { weight: a.weight, reps: a.reps };
      (state.doneByDate[a.date] ||= []).push({ kind: 'lift-test', lift: a.lift });
      const hit = findSession(a.date, { kind: 'lift-test', lift: a.lift });
      if (hit) { hit.day.sessions[hit.i].status = 'done'; plan.details[a.date][hit.i] = null; }
      // As the real API: each result sets that lift's Training Max; the fourth also starts Cycle 1.
      state.tms[a.lift] = tmFromTest(a.weight, a.reps, (g && g.plateStepKg) || 2.5);
      const tested = Object.keys(state.testWeek.results).length;
      events.push(`${name} ${a.weight} × ${a.reps} → Training Max ${state.tms[a.lift]} kg (${tested} of 4 tested)`);
      if (tested === 4) {
        events.push('All four tested: Cycle 1 starts at the next lift Slot');
        state.lift = { week: 1, index: 0, phase: { kind: 'normal' } };
        state.lastLiftDate = a.date;
        delete state.testWeek;
      }
      return { state: clone(state), events };
    }
    if (a.type === 'done' || a.type === 'skip' || a.type === 'tomorrow') {
      if (a.sets !== undefined) checkSets(a);
      const benchKind = a.type === 'done' ? benchmarkKindOf(a.ref) : null;
      const benchResult = a.type === 'done' && a.benchmark !== undefined ? checkBenchmark(a.benchmark) : undefined;
      if (benchResult && (!benchKind || (benchKind !== 'autobelay') !== ('timeS' in benchResult))) throw bad('benchmark does not fit this Session');
      const hit = findSession(a.date, a.ref);
      if (!hit) throw Object.assign(new Error('session not found'), { status: 400 });
      if (a.type === 'done') {
        hit.day.sessions[hit.i].status = 'done';
        plan.details[a.date][hit.i] = null; // as GET /api/plan: a done Session has no SessionDetail
        (state.doneByDate[a.date] ||= []).push(a.ref);
        if (a.ref.kind === 'lift') {
          state.lastLiftDate = a.date;
          if (a.amrapReps != null || a.sets) {
            // Same row as the real API: amrapReps (else derived from the AMRAP set) and sets; FSL weight as fslWeightKg.
            const e = { date: a.date, lift: a.ref.lift, week: a.ref.week };
            const amrap = a.amrapReps != null ? a.amrapReps : a.sets ? amrapFromSets(a.sets) : undefined;
            if (amrap != null) e.amrapReps = amrap;
            if (a.sets) {
              e.sets = a.sets;
              const w = fslWeightFromSets(a.ref.lift, a.sets);
              if (w !== undefined) e.fslWeightKg = w;
            }
            liftLog.entries.unshift(e);
          }
        }
        if (a.ref.kind === 'climb') state.lastClimbDate = a.date;
        if (benchKind) {
          benchmarks.unshift({ id: nextBenchmarkId++, date: a.date, kind: benchKind, ...(a.ref.eventId ? { eventId: a.ref.eventId } : {}), ...(benchResult || {}) });
        }
      } else {
        // Mock simplification: skipped / deferred sessions just leave the day.
        hit.day.sessions.splice(hit.i, 1);
        plan.details[a.date].splice(hit.i, 1);
      }
      events.push(`${a.type} ${refCode(a.ref)}`);
    } else if (a.type === 'test-results') {
      for (const [lift, r] of Object.entries(a.results)) {
        const tm = Math.floor((0.9 * r.weight * (1 + r.reps / 30)) / a.plateStepKg + 1e-9) * a.plateStepKg;
        events.push(`TM ${lift} ${state.tms[lift]}→${tm}`);
        state.tms[lift] = tm;
      }
      state.lift = { week: 1, index: 0, phase: { kind: 'normal' } };
      delete state.testWeek;
    } else if (a.type === 'set-tm') {
      events.push(`TM ${a.lift} ${state.tms[a.lift]}→${a.tm}`);
      state.tms[a.lift] = a.tm;
    } else if (a.type === 'set-history') {
      const put = (o, k, v) => { if (v === null) delete o[k]; else if (v !== undefined) o[k] = v; };
      put(state, 'lastClimbDate', a.lastClimbDate);
      put(state, 'lastLiftDate', a.lastLiftDate);
      put(state.ruck, 'lastCredit', a.ruckLastCredit);
      if (a.ruckStep !== undefined) state.ruck.step = a.ruckStep;
    } else {
      throw Object.assign(new Error('unsupported action in mock'), { status: 400 });
    }
    return { state: clone(state), events };
  }

  const upsert = (list, item) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
    return item;
  };

  // Activities as the intervals.icu sync and /log would record them (the fixture plan starts Mon 26 Oct 2026).
  const MOCK_ACTIVITIES = [
    { date: '2026-10-26', name: 'Ridge loop', sport: 'run', km: 8, vertM: 300, hours: 0.8, load: 50, source: 'intervals' },
    { date: '2026-10-25', name: 'Ridge hike', sport: 'hike', km: 8, vertM: 600, hours: 3.5, load: 80, source: 'intervals' },
    { date: '2026-10-23', name: 'Hike (/log)', sport: 'hike', hours: 2, vertM: 300, load: 50, source: 'telegram' },
    { date: '2026-10-23', name: 'Wall A', sport: 'climb', hours: 2, load: 40, source: 'intervals' },
  ];

  // Live Session (docs/api-contract.md): one at a time, no timers beyond restEndsAt and no Telegram.
  const LIFT_LABEL = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' };
  let restSeconds = { main: 180, fsl: 90, finisher: 60 };
  let live = null;
  // Abandoned attempts with Logged Sets, by date|ref, for Start's resume / fresh choice.
  const abandoned = new Map();
  const liveKey = (date, ref) => `${date}|${refCode(ref)}`;
  const loggedCount = (l) => l.steps.filter((s) => s.kind === 'set' && s.loggedAt && !s.skipped).length;
  const pausedErr = () => conflict('Paused — tap ▶ Resume (or send Resume) to log sets again.');
  const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
  const noLive = () => Object.assign(new Error('no Live Session is running'), { status: 404 });
  const liveCurrent = () => {
    if (!live.steps[0].done) return 0;
    if (live.ref.kind === 'lift-test') return live.steps.length;
    const i = live.steps.findIndex((s, k) => k > 0 && !s.loggedAt);
    return i < 0 ? live.steps.length : i;
  };
  const liveOut = () => {
    if (!live) return { live: null };
    const current = liveCurrent();
    const set = live.steps[current === 0 ? live.steps.findIndex((x, k) => k > 0 && !x.loggedAt) : current]; // before the Warm-up is done: the first set
    const prev = live.steps.slice(1, current).reverse().find((s) => s.loggedAt && !s.skipped);
    let next = null;
    // A TM Test has no Prescription: no weight until one is logged (never the bar).
    if (live.ref.kind === 'lift-test') next = prev ? { load: prev.load, reps: prev.reps, unit: 'kg', loadStep: 2.5 } : { reps: 5, unit: 'kg', loadStep: 2.5 };
    else if (set && set.kind === 'set') next = { load: set.rxLoad, reps: set.rxReps, unit: set.unit, loadStep: set.loadStep };
    return { live: clone({ ...live, paused: !!live.paused, current, next, loggedSets: loggedCount(live) }) };
  };
  function liveStart(b) {
    if (live) throw conflict(`a Live Session is already running: ${live.title}`);
    if (b && b.mode !== undefined && b.mode !== 'resume' && b.mode !== 'fresh') throw bad('mode must be one of resume, fresh');
    const prior = b && b.ref ? abandoned.get(liveKey(b.date, b.ref)) : undefined;
    if (prior && !b.mode) throw Object.assign(conflict(`${prior.title} was abandoned earlier today with ${loggedCount(prior)} Logged Sets: resume it or start fresh`), { resumable: true });
    if (b && b.mode === 'resume') {
      if (!prior) throw conflict('there is no abandoned attempt today to resume');
      abandoned.delete(liveKey(b.date, b.ref));
      live = { ...prior, restEndsAt: null, paused: false };
      return liveOut();
    }
    if (!b || !b.ref || (b.ref.kind !== 'lift' && b.ref.kind !== 'lift-test')) throw bad('ref must be a lift Session or a TM Test');
    const hit = findSession(b.date, b.ref);
    if (!hit || hit.day.sessions[hit.i].status === 'done') throw conflict('session is not planned for that date (already handled?)');
    const det = plan.details[b.date][hit.i];
    const name = LIFT_LABEL[b.ref.lift];
    const steps = [{ kind: 'warmup', items: (det.warmup || []).map((w) => `${w.name} ${typeof w.dose === 'string' ? w.dose : ''}`.trim()), done: false }];
    if (b.ref.kind === 'lift') {
      const rows = liftRows(det, name);
      const add = (r, group) => steps.push({
        kind: 'set', group, exercise: r.exercise, n: r.n, unit: r.unit, rxLoad: r.rxLoad, rxReps: r.rxReps, rxRepsMax: r.rxRepsMax,
        amrap: r.amrap || undefined, dose: r.doseText, loadStep: 2.5, restSeconds: restSeconds[group], status: null,
      });
      rows.main.forEach((r) => add(r, 'main'));
      for (const g of ['fsl', 'finisher']) rows[g].forEach((ex) => ex.rows.forEach((r) => add({ ...r, exercise: ex.name }, g)));
    }
    const title = b.ref.kind === 'lift' ? `${name} — Week ${b.ref.week}` : `${name} — 5-rep max test`;
    live = {
      id: Math.random().toString(16).slice(2).padEnd(32, '0'), date: b.date, ref: b.ref, title, steps, restEndsAt: null,
      startedAt: new Date().toISOString(), autoFinishAt: new Date(Date.parse(addDaysIso(b.date, 1) + 'T00:00:00Z')).toISOString(),
    };
    return liveOut();
  }
  function liveLog(b) {
    if (!live) throw noLive();
    if (live.paused) throw pausedErr();
    if (!b || !Number.isInteger(b.step) || b.step < 1) throw bad('step must be a whole number from 1');
    const isTest = live.ref.kind === 'lift-test';
    if (b.top && !isTest) throw bad('top only applies to a TM Test');
    if (isTest && b.step === live.steps.length) {
      live.steps.push({ kind: 'set', group: 'test', exercise: LIFT_LABEL[live.ref.lift], n: b.step, unit: 'kg', loadStep: 2.5, restSeconds: restSeconds.main, status: null });
    }
    const s = live.steps[b.step];
    if (!s) throw bad(`step ${b.step} is not a set of this Live Session`);
    if (isTest && !b.skip && b.load === undefined && s.load === undefined && (liveOut().live.next || {}).load === undefined) {
      if (!s.loggedAt) live.steps.pop();
      throw bad('type the weight, e.g. 100x5');
    }
    const newly = !s.loggedAt;
    if (b.skip) {
      delete s.load; delete s.reps; s.skipped = true; s.status = 'skipped';
    } else {
      const nx = liveOut().live.next || {};
      s.load = b.load !== undefined ? b.load : s.rxLoad !== undefined ? s.rxLoad : nx.load;
      s.reps = b.reps !== undefined ? b.reps : s.rxReps !== undefined ? s.rxReps : nx.reps;
      if (b.rpe !== undefined) s.rpe = b.rpe;
      delete s.skipped;
      const st = setStatus(s);
      s.status = s.amrap && st !== 'below' ? 'amrap' : st === 'below' ? 'under' : st === 'above' ? 'over' : s.rxReps === undefined && s.rxLoad === undefined ? 'done' : 'met';
      if (b.top) s.top = true;
    }
    if (newly) s.loggedAt = new Date().toISOString();
    live.steps[0].done = true;
    if (newly && !b.skip) live.restEndsAt = new Date(Date.now() + s.restSeconds * 1000).toISOString();
    if (b.top) {
      const r = applyAction({ type: 'test-result', date: live.date, lift: live.ref.lift, weight: s.load, reps: s.reps });
      live = null;
      return { live: null, events: r.events, outcome: 'finished' };
    }
    return liveOut();
  }
  function liveFinish() {
    if (!live) throw noLive();
    if (live.ref.kind === 'lift-test') throw conflict('a TM Test finishes with its top set (log it with top: true)');
    const sets = live.steps.filter((s) => s.kind === 'set' && s.loggedAt).map((s) => {
      const o = { group: s.group, exercise: s.exercise, n: s.n, unit: s.unit };
      for (const k of ['rxLoad', 'rxReps', 'rxRepsMax', 'load', 'reps', 'amrap', 'rpe', 'skipped']) if (s[k] !== undefined) o[k] = s[k];
      return o;
    });
    if (!live.steps.some((s) => s.kind === 'set' && s.loggedAt && !s.skipped)) throw conflict('nothing logged yet: log a set, or abandon');
    const r = applyAction({ type: 'done', date: live.date, ref: live.ref, sets });
    live = null;
    return { live: null, events: r.events, outcome: 'finished' };
  }

  // Route library as the real API keeps it (docs/api-contract.md); one proposal waits for "Make this the Benchmark".
  const RUN_KINDS = ["easy", "quality-vert", "quality-speed", "long", "ruck", "benchmark-2k4", "benchmark-hill"];
  let routes = [
    { id: "lake-loop", name: "Lake loop", area: "Hometown", km: 3.3, vertM: 40, kind: "loop", suits: ["easy"], url: "https://example.com/routes/lake-loop" },
    { id: "hill-repeats-x3", name: "Hill repeats", area: "Hometown", km: 6, vertM: 450, kind: "repeat", repeats: 3, suits: ["quality-vert", "long"] },
    { id: "ridge-hill", name: "Ridge hill loop", area: "Hometown", km: 5, vertM: 250, kind: "loop", suits: ["benchmark-hill"], notes: "PROPOSED BENCHMARK — confirm in tracker" },
  ];
  const routeBad = (r) => {
    if (!r || typeof r !== "object") return "body must be an object";
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return "id must be 1-40 letters, digits, _ or -";
    if (typeof r.name !== "string" || !r.name.trim()) return "name is required";
    if (!Array.isArray(r.suits) || r.suits.some((k) => !RUN_KINDS.includes(k))) return "suits must be an array of run kinds";
    if (r.url !== undefined && !r.url.startsWith("https://")) return "url must be an https:// URL";
    if (r.benchmark !== undefined && !["hill", "2k4"].includes(r.benchmark)) return "invalid benchmark";
    return null;
  };
  // Re-point the fixture plan's run details at a Route (the real API derives this on every GET /api/plan).
  const routeSummary = (r) => ({ id: r.id, name: r.name, km: r.km, vertM: r.vertM, kind: r.kind, ...(r.repeats ? { repeats: r.repeats } : {}), ...(r.url ? { url: r.url } : {}) });
  function setPlanRoute(date, runKind, route) {
    const day = plan.days.find((d) => d.date === date);
    if (!day) return;
    day.sessions.forEach((s, i) => {
      const d = plan.details[date][i];
      if (s.kind === "run" && d && d.kind === "run" && (s.run === runKind || (runKind === "long" && s.run === "ruck"))) d.route = route ? routeSummary(route) : null;
    });
  }

  async function handle(method, path, body) {
    const url = new URL(path, 'http://mock');
    const p = url.pathname;
    const seg = p.split('/').filter(Boolean); // ['api', 'constraints', ':id']
    switch (`${method} ${seg.slice(0, 2).join('/')}`) {
      case 'GET api/health': return { ok: true, mock: true };
      case 'GET api/plan': {
        const days = Number(url.searchParams.get('days') || 14);
        if (!(Number.isInteger(days) && days >= 1 && days <= 100)) throw bad('days must be 1–100');
        const from = url.searchParams.get('from');
        // The fixture only covers 14 days: a range past its end returns no days.
        const start = from ? plan.days.findIndex((d) => d.date >= from) : 0;
        const end = from ? addDaysIso(from, days) : null;
        const sel = start < 0 ? [] : plan.days.slice(start, start + days).filter((d) => !end || d.date < end);
        const details = Object.fromEntries(sel.map((d) => [d.date, plan.details[d.date]]));
        return clone({ days: sel, details });
      }
      case 'GET api/state': return clone({ ...state, restSeconds });
      case 'GET api/activities': return clone({ entries: MOCK_ACTIVITIES });
      case 'GET api/progress': {
        // Seeded 6-week history (progress.json); weeks beyond it return what there is.
        const w = url.searchParams.get('weeks');
        const weeks = w === null ? 12 : Number(w);
        if (!(/^\d+$/.test(w ?? '12') && weeks >= 1 && weeks <= 104)) throw bad('weeks must be between 1 and 104');
        const from = progress.weeklyRuns.slice(-weeks)[0].monday;
        // ?mock=1&progress=empty: a fresh install (no history yet), to see the charts' empty states.
        if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('progress') === 'empty') {
          const zero = { expected: 0, done: 0, skipped: 0 };
          return clone({
            tmHistory: [], benchmarks: [],
            weeklyRuns: progress.weeklyRuns.slice(-weeks).map((w) => ({ ...w, km: 0, vertM: 0, targetKm: null, targetVertM: null, deload: false })),
            adherence: progress.adherence.slice(-weeks).map((w) => ({ monday: w.monday, ...zero, byKind: { lift: zero, run: zero, climb: zero } })),
          });
        }
        return clone({
          tmHistory: progress.tmHistory.filter((s) => s.date >= from),
          benchmarks: benchmarks.filter((b) => b.date >= from && (b.timeS !== undefined || b.grade !== undefined)).reverse(),
          weeklyRuns: progress.weeklyRuns.slice(-weeks),
          adherence: progress.adherence.slice(-weeks),
        });
      }
      case 'GET api/benchmark-results':
        if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('progress') === 'empty') return { entries: [] };
        return clone({ entries: benchmarks });
      case 'POST api/benchmark-results': return saveBenchmarkResult(body);
      case 'POST api/sync': return { synced: 0, notices: [], skipped: 'off' };
      case 'POST api/action': return applyAction(body);
      case 'POST api/lift-log': liftLog.entries.unshift({ ...body }); return { ok: true };
      case 'GET api/lift-log': return clone(liftLog);
      case 'GET api/constraints': return clone(state.constraints);
      case 'POST api/constraints': return upsert(state.constraints, body);
      case 'DELETE api/constraints': state.constraints = state.constraints.filter((c) => c.id !== seg[2]); return { ok: true };
      case 'GET api/club-events': return clone(state.clubEvents);
      case 'POST api/club-events': return upsert(state.clubEvents, body);
      case 'DELETE api/club-events': state.clubEvents = state.clubEvents.filter((c) => c.id !== seg[2]); return { ok: true };
      case 'GET api/mobility': return clone({ log: mobility.log, streak: streakOf(mobility.log) });
      case 'POST api/mobility': {
        mobility.log = mobility.log.filter((e) => e.date !== body.date).concat([{ date: body.date, status: body.status }]);
        return { log: clone(mobility.log), streak: streakOf(mobility.log) };
      }
      case 'GET api/self-checks': return clone(mobility.selfChecks);
      case 'POST api/self-checks': mobility.selfChecks[body.name] = body.date; return clone(mobility.selfChecks);
      case 'PUT api/settings':
        for (const k of ['defaultWeek', 'defaultTimezone', 'defaultGymProfileId', 'gymProfiles', 'rucksEnabled', 'homeLocation']) if (body[k] !== undefined) state[k] = body[k];
        if (body.restSeconds !== undefined) restSeconds = { ...restSeconds, ...body.restSeconds };
        return clone({ ...state, restSeconds });
      case 'GET api/live': return liveOut();
      case 'POST api/live':
        switch (seg[2]) {
          case 'start': return liveStart(body);
          case 'log': return liveLog(body);
          case 'rest': {
            if (!live) throw noLive();
            if (body && body.stop === true) {
              live.restEndsAt = null;
              return liveOut();
            }
            if (!body || !Number.isInteger(body.addSeconds) || body.addSeconds < 1 || body.addSeconds > 900) throw bad('addSeconds must be 1–900');
            const base = live.restEndsAt && Date.parse(live.restEndsAt) > Date.now() ? Date.parse(live.restEndsAt) : Date.now();
            live.restEndsAt = new Date(base + body.addSeconds * 1000).toISOString();
            return liveOut();
          }
          case 'warmup-done':
            if (!live) throw noLive();
            live.steps[0].done = true;
            return liveOut();
          case 'finish': return liveFinish();
          case 'cancel':
            if (!live) throw noLive();
            if (loggedCount(live)) throw conflict('sets are logged: abandon instead');
            live = null;
            return { live: null, outcome: 'cancelled' };
          case 'pause':
          case 'resume':
            if (!live) throw noLive();
            live.paused = seg[2] === 'pause';
            if (live.paused) live.restEndsAt = null;
            return liveOut();
          case 'abandon':
            if (!live) throw noLive();
            if (loggedCount(live)) abandoned.set(liveKey(live.date, live.ref), live);
            live = null;
            return { live: null, outcome: 'abandoned' };
          default: throw Object.assign(new Error(`mock: no route ${method} ${p}`), { status: 404 });
        }
      case 'GET api/routes': return { routes: clone(routes) };
      case 'POST api/routes': {
        const err = routeBad(body);
        if (err) throw bad(err);
        const holder = body.benchmark && routes.find((r) => r.benchmark === body.benchmark && r.id !== body.id);
        if (holder) throw Object.assign(new Error(`"${holder.name}" is already the ${body.benchmark} Benchmark Route; a Benchmark stays fixed`), { status: 409 });
        upsert(routes, clone(body));
        return clone(body);
      }
      case 'DELETE api/routes': routes = routes.filter((r) => r.id !== seg[2]); return { ok: true };
      case 'PUT api/route-assignments': {
        if (!body || !Array.isArray(body.assignments) || body.assignments.length > 30) throw bad("assignments must be an array of at most 30");
        for (const a of body.assignments) {
          if (!ISO_DATE.test(a.date) || !RUN_KINDS.includes(a.runKind)) throw bad("invalid assignment");
          const route = a.routeId === null ? null : routes.find((r) => r.id === a.routeId);
          if (a.routeId !== null && !route) throw bad("routeId does not match a Route");
          setPlanRoute(a.date, a.runKind === "ruck" ? "long" : a.runKind, route);
        }
        return { assignments: clone(body.assignments) };
      }
      case 'GET api/content': return clone(content);
      case 'GET api/comments': {
        const q = (k) => url.searchParams.get(k);
        return { comments: clone(comments.filter((c) => (!q('from') || c.date >= q('from')) && (!q('to') || c.date <= q('to')) && (!q('status') || c.status === q('status')))) };
      }
      case 'POST api/comments': return saveComment(body);
      case 'DELETE api/comments': comments = comments.filter((c) => c.id !== seg[2]); return { ok: true };
      default: throw Object.assign(new Error(`mock: no route ${method} ${p}`), { status: 404 });
    }
  }

  return { handle };
}
