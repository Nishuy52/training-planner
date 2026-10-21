// Training tracker frontend. Vanilla JS, no build step.
// Sections: API access · helpers · data loading · renderers (one per tab) · mobility timer · events.

import { lastSessionSets, liftRows, setKey, setStatus } from './sets.js';
import { GRADES, fmtMmss, parseMmss, secondsUntil } from './format.js';
import { bigTmChange, focusStep, isLiveFor, liveTally, loggedLine, rxLine, setOfText, testResultConfirmText, testResultPreview, tmFromTest, topSetConfirmText } from './live.js';
import { TIME_STEPS, adherenceRows, chartWidth, dataTable, fmtTimeTick, pointChart, stepLineChart, weeklyBarChart } from './charts.js';

/* ═══════════════════════════ API access ═══════════════════════════
 * Everything that talks to the backend lives here. Only ?mock=1 switches
 * requests to an in-memory mock built from ./mock/*.json. A failing
 * /api/health never falls back to demo data: boot shows an error banner. */

let mockApi = null;

async function initApi() {
  if (new URLSearchParams(location.search).get('mock') === '1') {
    const { createMockApi } = await import('./mock/mock-api.js');
    mockApi = await createMockApi('./mock/');
    return true;
  }
  let r;
  try {
    r = await fetch('/api/health', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  } catch {
    throw new Error('Cannot reach the server. Check your connection, or reload to sign in via Cloudflare Access.');
  }
  if (r.status === 403) throw Object.assign(new Error('Not signed in — reload to log in via Cloudflare Access.'), { status: 403 });
  if (!r.ok) throw Object.assign(new Error(`The server returned an error (HTTP ${r.status}).`), { status: r.status });
  return false;
}

async function call(method, path, body) {
  if (mockApi) {
    try {
      return await mockApi.handle(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    } catch (e) { throw Object.assign(new Error(e.message), { status: e.status || 500, resumable: !!e.resumable }); }
  }
  const r = await fetch(path, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) throw Object.assign(new Error((data && data.error) || `${method} ${path} → ${r.status}`), { status: r.status, resumable: !!(data && data.resumable) });
  return data;
}

const api = {
  plan: (days = 14, from) => call('GET', `/api/plan?days=${days}${from ? `&from=${from}` : ''}`),
  state: () => call('GET', '/api/state'),
  action: (a) => call('POST', '/api/action', a),
  liftLog: () => call('GET', '/api/lift-log'),
  logLift: (entry) => call('POST', '/api/lift-log', entry),
  saveConstraint: (c) => call('POST', '/api/constraints', c),
  deleteConstraint: (id) => call('DELETE', `/api/constraints/${encodeURIComponent(id)}`),
  saveClubEvent: (e) => call('POST', '/api/club-events', e),
  deleteClubEvent: (id) => call('DELETE', `/api/club-events/${encodeURIComponent(id)}`),
  mobility: (days = 30) => call('GET', `/api/mobility?days=${days}`),
  markMobility: (date, status) => call('POST', '/api/mobility', { date, status }),
  selfChecks: () => call('GET', '/api/self-checks'),
  markSelfCheck: (name, date) => call('POST', '/api/self-checks', { name, date }),
  settings: (patch) => call('PUT', '/api/settings', patch),
  content: () => call('GET', '/api/content'),
  activities: (days = 60) => call('GET', `/api/activities?days=${days}`),
  sync: () => call('POST', '/api/sync', {}),
  comments: (q = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    return call('GET', `/api/comments${qs ? `?${qs}` : ''}`);
  },
  saveComment: (c) => call('POST', '/api/comments', c),
  deleteComment: (id) => call('DELETE', `/api/comments/${encodeURIComponent(id)}`),
  routes: () => call('GET', '/api/routes'),
  saveRoute: (r) => call('POST', '/api/routes', r),
  deleteRoute: (id) => call('DELETE', `/api/routes/${encodeURIComponent(id)}`),
  assignRoute: (date, runKind, routeId) => call('PUT', '/api/route-assignments', { assignments: [{ date, runKind, routeId }] }),
  progress: (weeks = 12) => call('GET', `/api/progress?weeks=${weeks}`),
  benchmarkResults: (days = 365) => call('GET', `/api/benchmark-results?days=${days}`),
  saveBenchmarkResult: (b) => call('POST', '/api/benchmark-results', b),
  live: () => call('GET', '/api/live'),
  liveStart: (date, ref, mode) => call('POST', '/api/live/start', mode ? { date, ref, mode } : { date, ref }),
  liveLog: (b) => call('POST', '/api/live/log', b),
  liveRest: (b) => call('POST', '/api/live/rest', b),
  liveDo: (what) => call('POST', `/api/live/${what}`, {}), // warmup-done, pause, resume, finish, cancel, abandon
};

/* ═══════════════════════════ helpers ═══════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LIFTS = ['squat', 'bench', 'deadlift', 'ohp'];
const LIFT_NAME = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' };
const WEEK_LABEL = { 1: '5s', 2: '3s', 3: '5/3/1', 4: 'Deload', reentry: 'Re-entry' };
const RUN_NAME = {
  easy: 'Easy run', 'quality-vert': 'Quality — Vert', 'quality-speed': 'Quality — Speed',
  long: 'Long run', ruck: 'Hill Ruck', 'benchmark-2k4': 'Benchmark — 2.4 km', 'benchmark-hill': 'Benchmark — Hill loop',
};
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COMMON_ZONES = ['Europe/London', 'Europe/Berlin', 'Europe/Rome', 'America/New_York', 'Asia/Tokyo'];
const SLOT_KINDS = ['', 'lift', 'run', 'run-long'];

// ISO dates are handled as UTC midnights so arithmetic never drifts across DST.
const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toIso = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(new Date(toDate(iso).getTime() + n * 86400000));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const weekday = (iso) => (toDate(iso).getUTCDay() + 6) % 7; // 0 = Monday
const mondayOf = (iso) => addDays(iso, -weekday(iso));
const fmtDay = (iso) => `${DOW[weekday(iso)]} ${toDate(iso).getUTCDate()} ${MONTHS[toDate(iso).getUTCMonth()]}`;
const fmtShort = (iso) => `${toDate(iso).getUTCDate()} ${MONTHS[toDate(iso).getUTCMonth()]}`;
const localToday = () => { const d = new Date(); return toIso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); };
const newId = (prefix) => `${prefix}-${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 8)}`;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtKg = (n) => (n == null || n === '' ? '—' : `${+n} kg`);

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: per-viewer conveniences only */ }
  return null;
}

/** SessionRef = the PlannedSession without slot/status. */
const toRef = (s) => { const { slot, status, ...ref } = s; return ref; };

function kindClass(s) {
  if (s.kind === 'lift' || s.kind === 'lift-test' || s.kind === 'travel-strength') return 'k-strength';
  if (s.kind === 'climb') return 'k-climb';
  if (s.run === 'easy') return 'k-easy';
  if (s.run === 'long') return 'k-long';
  if (s.run === 'ruck') return 'k-ruck';
  if (s.run.startsWith('benchmark')) return 'k-benchmark';
  return 'k-quality';
}
const KIND_COLOR = { 'k-strength': 'var(--strength)', 'k-climb': 'var(--climb)', 'k-easy': 'var(--easy)', 'k-long': 'var(--long)', 'k-ruck': 'var(--steady)', 'k-benchmark': 'var(--benchmark)', 'k-quality': 'var(--quality)' };

function sessionTitle(s, det) {
  if (s.kind === 'lift') return `${LIFT_NAME[s.lift]} — ${s.week === 'reentry' ? 'Re-entry' : `Week ${s.week} (${WEEK_LABEL[s.week]})`}`;
  if (s.kind === 'lift-test') return `${LIFT_NAME[s.lift]} — 5-rep max test`;
  if (s.kind === 'travel-strength') return 'Travel Strength';
  if (s.kind === 'run') return RUN_NAME[s.run] || s.run;
  if (s.fallback) return 'Boulder Fallback';
  const ev = (det && det.event) || clubEventById(s.eventId);
  return ev ? `${ev.venue} ${ev.time}` : 'Climb';
}

function sessionSummary(s, det) {
  if (!det) return '';
  if (s.kind === 'lift' && det.mainSets) return det.mainSets.map((x) => `${x.load}${x.capped ? '*' : ''} × ${x.reps}${x.amrap ? '+' : ''}`).join(' · ') + ` ${det.mainSets[0]?.unit || 'kg'}`;
  if (s.kind === 'run' && s.run === 'ruck' && det.ruckLoad) return `${det.ruckLoad.packKg} kg · ${det.ruckLoad.vertM} m ↑ · 2–2.5 h`;
  if (s.kind === 'run' && det.rx) return [`${det.rx.km} km`, det.rx.vertM ? `${det.rx.vertM} m ↑` : '', det.route ? det.route.name : ''].filter(Boolean).join(' · ');
  if (s.kind === 'climb') return s.fallback ? 'Bouldering gym' : (det.event ? det.event.title : '');
  if (s.kind === 'travel-strength') return 'Calisthenics';
  if (s.kind === 'lift-test') return 'TM Test: work up to a hard 5-rep max';
  return '';
}

/** Stable per-day key for a session, used to attach comments: "lift:squat", "run:easy", "climb", … */
function sessionKey(s) {
  if (s.kind === 'lift' || s.kind === 'lift-test') return `${s.kind}:${s.lift}`;
  if (s.kind === 'run') return `run:${s.run}`;
  return s.kind;
}

const RUN_SHORT = { easy: 'Easy', 'quality-vert': 'Q Vert', 'quality-speed': 'Q Speed', long: 'Long', ruck: 'Ruck', 'benchmark-2k4': '2.4 km', 'benchmark-hill': 'Hill BM' };
/** Calendar-cell label: a word or two. */
function sessionShort(s) {
  if (s.kind === 'lift') return LIFT_NAME[s.lift];
  if (s.kind === 'lift-test') return `${LIFT_NAME[s.lift]} test`;
  if (s.kind === 'travel-strength') return 'Travel';
  if (s.kind === 'run') return RUN_SHORT[s.run] || s.run;
  return s.fallback ? 'Boulder' : 'Climb';
}

function fmtDose(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d.type === 'hold') {
    return `HOLD ${d.seconds} s${d.perSide ? '/side' : ''}${d.positions ? ` · ${d.positions.length} positions` : ''}${d.times > 1 ? ` × ${d.times}` : ''}`;
  }
  return `REPS ${d.reps}${d.perSide ? '/side' : ''}${d.pauseS ? ` · ${d.pauseS} s pause` : ''}${d.sets > 1 ? ` × ${d.sets}` : ''}`;
}
const repsText = (d) => `${d.reps} slow reps${d.perSide ? ' / side' : ''}${d.pauseS ? `, ${d.pauseS} s pause` : ''}`;

function exList(list, { numbered = false, checks = null } = {}) {
  if (!list || !list.length) return '<div class="muted small">—</div>';
  // A checklist row is one <label>, so the whole row (not just the 18px box) is the tap target.
  const tag = checks ? 'label' : 'div';
  return list.map((e, i) => `
    <${tag} class="ex${checks ? ' ex-check' : ''}">
      ${checks ? `<input type="checkbox" id="${checks}-${i}" aria-label="${esc(e.name)} done">` : numbered ? `<span class="ex-num">${i + 1}</span>` : ''}
      <span class="ex-body"><span class="ex-name">${esc(e.name)}</span>${e.cue ? `<span class="ex-cue">${esc(e.cue)}</span>` : ''}</span>
      <span class="ex-dose">${esc(fmtDose(e.dose))}</span>
    </${tag}>`).join('');
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2800);
}

/* ═══════════════════════════ data ═══════════════════════════ */

const S = { plan: { days: [], details: {} }, state: null, content: null, mobility: { log: [], streak: 0 }, liftLog: null, selfChecks: {}, selfChecksLocal: false, comments: [], commentsOk: true, live: null };

const today = () => (S.plan.days[0] && S.plan.days[0].date) || localToday();
const detailFor = (date, i) => ((PC.details[date] || (S.plan.details && S.plan.details[date]) || [])[i]) || null;
const clubEventById = (id) => (S.state && S.state.clubEvents || []).find((e) => e.id === id);
const gymProfiles = () => (S.state && S.state.gymProfiles) || [];
const constraintsOn = (date) => ((S.state && S.state.constraints) || []).filter((c) => c.start <= date && date <= c.end);

/* Plan horizon cache. S.plan holds the first LIST_DAYS days (days[0] = today);
 * PC holds every day fetched so far, for the Plan tab and the day sheet. A range
 * is fetched once per loadCore (which resets the cache after any mutation). */
const LIST_DAYS = 42;
const HORIZON_DAYS = 100;
const PC = { gen: 0, days: {}, details: {}, covered: new Set(), pending: new Set(), error: null };
const horizonEnd = () => addDays(today(), HORIZON_DAYS - 1);

function absorbPlan(plan, from, n) {
  for (const d of (plan && plan.days) || []) { PC.days[d.date] = d; PC.details[d.date] = (plan.details && plan.details[d.date]) || []; }
  for (let k = 0; k < n; k++) PC.covered.add(addDays(from, k));
}

/** Make sure [from, to] (clamped to today..horizon) is loaded. Returns 'ready' | 'loading' | 'error'. */
function requestPlanRange(from, to) {
  const t = today();
  const end = horizonEnd();
  const a = from < t ? t : from;
  const b = to > end ? end : to;
  if (a > b) return 'ready';
  let missing = false;
  for (let d = a; d <= b && !missing; d = addDays(d, 1)) if (!PC.covered.has(d)) missing = true;
  if (!missing) return 'ready';
  if (PC.error) return 'error';
  // The projection only holds when it starts from today: the server restarts the lift/run
  // rotation at `from`, so a later chunk would show the wrong sessions. Fetch the whole horizon once.
  const first = t;
  const key = 'horizon';
  if (!PC.pending.has(key)) {
    PC.pending.add(key);
    const gen = PC.gen;
    const n = HORIZON_DAYS;
    api.plan(n, first)
      .then((plan) => { if (gen === PC.gen) absorbPlan(plan, first, n); },
        (e) => { if (gen === PC.gen) PC.error = e.message || 'Could not load the plan'; })
      .finally(() => {
        if (gen !== PC.gen) return;
        PC.pending.delete(key);
        try { renderPlan(); if (SH.date) renderSheet(); } catch (e) { console.error(e); }
      });
  }
  return 'loading';
}

async function loadCore() {
  const [plan, state, routesRes] = await Promise.all([api.plan(LIST_DAYS), api.state(), api.routes().catch(() => null)]);
  S.plan = plan || { days: [], details: {} };
  S.state = state;
  S.routes = (routesRes && routesRes.routes) || []; // optional: without it the Route library just stays empty
  Object.assign(PC, { gen: PC.gen + 1, days: {}, details: {}, covered: new Set(), pending: new Set(), error: null });
  absorbPlan(S.plan, today(), LIST_DAYS);
}

async function loadComments() {
  const res = await api.comments();
  S.comments = (res && res.comments) || [];
  S.commentsOk = true;
}

async function loadAll() {
  const acts = api.activities(60).catch(() => null); // Running tab totals; optional, so a failure only hides them
  await loadCore();
  S.activities = await acts;
  const results = await Promise.allSettled([api.content(), api.mobility(30), api.liftLog(), api.selfChecks(), loadComments(), api.live()]);
  if (results[5].status === 'fulfilled') setLive(results[5].value && results[5].value.live, { render: false });
  if (results[0].status === 'fulfilled') S.content = results[0].value;
  if (results[1].status === 'fulfilled') S.mobility = results[1].value;
  S.liftLog = results[2].status === 'fulfilled' ? results[2].value : null;
  if (results[3].status === 'fulfilled') { S.selfChecks = results[3].value || {}; S.selfChecksLocal = false; }
  else { S.selfChecks = store('selfChecks') || {}; S.selfChecksLocal = true; }
  if (results[4].status === 'rejected') { S.comments = []; S.commentsOk = false; console.warn('comments', results[4].reason); }
}

/** Run a mutation, then reload what it may have changed and redraw. */
async function mutate(fn, { reload = 'core', okMsg } = {}) {
  try {
    const res = await fn();
    invalidateProgress(); // the Progress charts reload on their next showing
    if (reload === 'core') await loadCore();
    if (reload === 'mobility') S.mobility = await api.mobility(30);
    if (reload === 'comments') await loadComments();
    renderAll();
    const events = res && Array.isArray(res.events) && res.events.length ? res.events.join(' · ') : '';
    if (okMsg || events) toast([okMsg, events].filter(Boolean).join(' — '));
    return res;
  } catch (e) {
    toast(e.message || 'Something went wrong', true);
    return null;
  }
}

/* ═══════════════════════════ header ═══════════════════════════ */

function renderHeader() {
  const st = S.state;
  let badge = '';
  if (st) {
    const ph = st.lift.phase;
    badge = st.testWeek ? `Test Week ${Object.keys(st.testWeek.results || {}).length}/4`
      : ph.kind === 'reentry' ? `Re-entry ${ph.done}/4` : `Cycle wk ${st.lift.week} · ${WEEK_LABEL[st.lift.week]}`;
  }
  $('#phaseBadge').textContent = badge;
  const t = today();
  $('#weekStrip').innerHTML = S.plan.days.slice(0, 7).map((d) => `
    <button class="wk-day${d.date === t ? ' today' : ''}${d.mountain ? ' mountain' : ''}" data-act="open-day" data-date="${d.date}" aria-label="${esc(fmtDay(d.date))}: ${d.sessions.length ? esc(d.sessions.map((s) => sessionTitle(s, null)).join(', ')) : d.mountain ? 'mountain day' : 'rest'}. Show details">
      <span>${DOW[weekday(d.date)].slice(0, 2)}</span>
      <span class="num">${toDate(d.date).getUTCDate()}</span>
      <span class="wk-dots">${d.sessions.map((s) => `<i style="background:${KIND_COLOR[kindClass(s)]}${s.status === 'done' ? ';opacity:.35' : ''}"></i>`).join('')}${d.mountain ? '<i style="background:var(--easy)"></i>' : ''}</span>
    </button>`).join('');
}

/* ═══════════════════════════ Today ═══════════════════════════ */

/** The planner's notes for a day ("Also: …", "Skipped: …") as one muted line. */
function dayNotesLine(day, tag = 'div') {
  const n = (day && day.notes) || [];
  return n.length ? `<${tag} class="day-notes small muted">${n.map(esc).join(' · ')}</${tag}>` : '';
}

function dayBadges(day) {
  const b = [];
  for (const c of constraintsOn(day.date)) if (c.note) b.push(`<span class="badge trip">${esc(c.note)}</span>`);
  if (day.mountain) b.push('<span class="badge mountain">Mountain</span>');
  if (day.noGym && !day.mountain) b.push('<span class="badge">No gym</span>');
  if (S.state && day.timezone && day.timezone !== S.state.defaultTimezone) b.push(`<span class="badge">${esc(day.timezone)}</span>`);
  if (!constraintsOn(day.date).length && day.note) b.push(`<span class="badge trip">${esc(day.note)}</span>`);
  return b.join('');
}

/* ═══════════════════════════ Set logging (lift Sessions) ═══════════════════════════
 * One collapsible row per set: the Prescription in the summary, and once logged the Logged Set
 * with Met ✓ / Over ↑ / Under ↓. Typed values are a per-session draft in localStorage
 * (setDraft:<date>:<lift>) until Done sends them as `sets`. Pure helpers live in sets.js. */

const fmtNum = (n) => String(+(+n).toFixed(2));
const draftKey = (date, lift) => `setDraft:${date}:${lift}`;
const STATUS_TEXT = { match: ['✓', 'Met'], above: ['↑', 'Over'], below: ['↓', 'Under'] };

function rxText(r) {
  if (r.doseText !== undefined) return esc(r.doseText || '—');
  const reps = `${r.rxReps}${r.rxRepsMax ? `–${r.rxRepsMax}` : ''}${r.amrap ? '+' : ''}`;
  if (r.group === 'main') return `${esc(r.pct)}% · ${esc(fmtNum(r.rxLoad))}${r.capped ? '*' : ''} ${esc(r.unit)} × ${esc(reps)}`;
  return r.rxLoad != null ? `${esc(fmtNum(r.rxLoad))} ${esc(r.unit)} × ${esc(reps)}` : `× ${esc(reps)}`;
}

/** "60 kg × 7"; either part may be missing. */
function loggedText(s) {
  const w = s.load != null ? `${fmtNum(s.load)} ${s.unit || 'kg'}` : '';
  const r = s.reps != null ? `× ${s.reps}` : '';
  return [w, r].filter(Boolean).join(' ');
}

/** Status chip for a Logged Set. The AMRAP set shows its rep count instead of ↑. */
function loggedHtml(s) {
  const st = setStatus(s);
  if (!st) return '';
  const [mark, word] = STATUS_TEXT[st];
  const amrapOver = s.amrap && st === 'above' && s.reps != null; // weight-only AMRAP: reps unknown, plain ↑
  const text = amrapOver ? (s.load != null ? `· ${fmtNum(s.load)} ${s.unit || 'kg'}` : '') : loggedText(s);
  return `<span class="set-logged st-${amrapOver ? 'amrap' : st}"><span class="sr-only">Logged Set, ${amrapOver ? 'AMRAP' : word}: </span><span${amrapOver ? '' : ' aria-hidden="true"'}>${amrapOver ? esc(`${s.reps} reps`) : mark}</span> ${esc(text)}</span>${rpeHtml(s.rpe)}`;
}

/** "@8" next to a Logged Set (RPE 1–10); read out as "RPE 8". */
const rpeHtml = (rpe) => (rpe ? ` <span class="set-rpe"><span class="sr-only">RPE </span><span aria-hidden="true">@</span>${esc(rpe)}</span>` : '');
const RPE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const isBlank = (v) => v === '' || v == null;

/** A row's Logged Set from its draft strings; empty parts fall back to the Prescription (AMRAP reps stay unknown).
 *  An RPE alone counts as the set done as prescribed. null if nothing entered. */
function draftToLogged(r, d) {
  if (!d || (isBlank(d.load) && isBlank(d.reps) && isBlank(d.rpe))) return null;
  const load = !isBlank(d.load) ? parseFloat(d.load) : r.rxLoad;
  const reps = !isBlank(d.reps) ? Number(d.reps) : r.amrap ? undefined : r.rxReps;
  const rpe = !isBlank(d.rpe) ? Number(d.rpe) : undefined;
  return { ...r, load: Number.isFinite(load) ? load : undefined, reps: Number.isFinite(reps) ? reps : undefined, rpe };
}

/** Optional RPE picker for one set: ten chips, tap the chosen one again to clear. */
function rpePicker(r, value) {
  const v = isBlank(value) ? '' : String(value);
  return `<div class="rpe" role="group" aria-label="Set ${esc(r.n)} RPE, optional">
      <span class="set-field-lbl">RPE <span class="muted">(optional)</span></span>
      <div class="rpe-chips" data-rpe="${esc(v)}">${RPE_VALUES.map((n) => `<button type="button" class="rpe-chip" data-act="set-rpe" data-v="${n}" aria-pressed="${String(v === String(n))}" aria-label="RPE ${n}">${n}</button>`).join('')}</div>
    </div>`;
}

function setRow(r, { draft, last, logged, ro }) {
  const lastHtml = last && (last.load != null || last.reps != null) ? `<div class="small muted">Last time: ${esc(loggedText(last))}${last.rpe ? ` · RPE ${esc(last.rpe)}` : ''}</div>` : '';
  const head = `<span class="set-n" aria-label="Set ${r.n}">${r.n}</span>
      <span class="set-rx"><span class="sr-only">Prescription: </span>${rxText(r)}${r.lastUsed ? ' <span class="muted small">last used</span>' : ''}</span>`;
  if (ro) {
    const body = (logged ? `<div class="small">Prescription: ${rxText(r)}</div>` : '') + lastHtml;
    if (!body && !logged) return `<div class="set-row static">${head}</div>`;
    return `<details class="set-row"><summary>${head}<span class="set-out">${logged ? loggedHtml(logged) : ''}</span></summary><div class="set-edit">${body}</div></details>`;
  }
  const d = draft || {};
  const cur = draftToLogged(r, d);
  const canRx = r.rxReps != null;
  const loadPh = r.rxLoad != null ? fmtNum(r.rxLoad) : last && last.load != null ? fmtNum(last.load) : '';
  return `
    <details class="set-row" data-row="${esc(r.id)}">
      <summary>${head}<span class="set-out">${cur ? loggedHtml(cur) : ''}</span></summary>
      <div class="set-edit">
        <div class="set-fields">
          <label class="set-field">Weight <span class="set-input"><input type="number" inputmode="decimal" min="0" max="1000" step="0.5" data-set-load value="${esc(d.load ?? '')}" placeholder="${esc(loadPh)}" aria-label="Set ${r.n} weight in ${esc(r.unit)}"><span class="muted">${esc(r.unit)}</span></span></label>
          <label class="set-field">Reps <span class="set-input"><input type="number" inputmode="numeric" min="0" max="100" step="1" data-set-reps value="${esc(d.reps ?? '')}" placeholder="${esc(r.rxReps ?? '')}" aria-label="Set ${r.n} reps"></span></label>
          ${canRx ? `<button type="button" class="btn small" data-act="set-rx">As prescribed</button>` : ''}
        </div>
        ${rpePicker(r, d.rpe)}
        ${lastHtml}
      </div>
    </details>`;
}

/** locked: done or read-only, so the set rows take no input. */
function liftBody(s, det, key, date, locked, ro = false) {
  if (!det) {
    if (s.status !== 'done') return '<div class="muted small">No details.</div>';
    // A done Session has no SessionDetail: show its Logged Sets from the lift log, read-only.
    const e = ((S.liftLog && S.liftLog.entries) || []).find((x) => x.date === date && x.lift === s.lift && Array.isArray(x.sets) && x.sets.length);
    if (!e) return '<div class="muted small">Done.</div>';
    return `<div class="set-log">${e.amrapReps != null ? `<div class="small muted">AMRAP ${esc(e.amrapReps)} reps</div>` : ''}${loggedSetsHtml(e.sets)}</div>`;
  }
  const unit = det.mainSets && det.mainSets[0] ? det.mainSets[0].unit : 'kg';
  const capped = (det.mainSets || []).some((x) => x.capped);
  const done = s.status === 'done';
  const rows = liftRows(det, LIFT_NAME[s.lift]);
  const entries = (S.liftLog && S.liftLog.entries) || [];
  const last = lastSessionSets(entries, s.lift, date, s.week);
  // A done Session shows its Logged Sets from the lift log.
  const doneEntry = done ? entries.find((e) => e.date === date && e.lift === s.lift && Array.isArray(e.sets)) : null;
  const loggedMap = doneEntry ? new Map(doneEntry.sets.map((x) => [setKey(x), x])) : null;
  const draft = locked ? {} : store(draftKey(date, s.lift)) || {};
  const row = (r) => setRow(r, { draft: draft[r.id], last: last.get(setKey(r)), logged: loggedMap && loggedMap.get(setKey(r)), ro: locked });
  const exGroup = (list) => (list.length ? list.map((e) => `
      <div class="set-ex"><div class="set-ex-head"><span class="ex-name">${esc(e.name)}</span><span class="ex-dose">${esc(fmtDose(e.dose))}</span></div>
        ${e.cue ? `<div class="ex-cue">${esc(e.cue)}</div>` : ''}</div>
      ${e.rows.map(row).join('')}`).join('') : '<div class="muted small">—</div>');
  return `
    <details class="fold"><summary>Warm-up checklist</summary>${exList(det.warmup, ro ? { numbered: true } : { checks: `wu-${key}` })}</details>
    <div class="set-log"${locked ? '' : ` data-draft="${esc(draftKey(date, s.lift))}" data-date="${esc(date)}" data-i="${esc(key.split('-').pop())}"`}>
      <div class="sub-title">Main sets${det.tm ? ` · TM ${esc(det.tm)} kg` : ''}</div>
      ${rows.main.map(row).join('') || '<div class="muted small">—</div>'}
      ${capped ? `<div class="small muted" style="padding-top:6px">* capped at the machine max (${esc(unit)})</div>` : ''}
      <div class="sub-title">FSL</div>
      ${exGroup(rows.fsl)}
      <div class="sub-title">Finisher</div>
      ${exGroup(rows.finisher)}
    </div>`;
}

/** The set rows of the lift Session at (date, i), by row id. */
function rowsById(date, i) {
  const s = findSession(date, i);
  const det = detailFor(date, i);
  if (!s || s.kind !== 'lift' || !det) return new Map();
  const r = liftRows(det, LIFT_NAME[s.lift]);
  return new Map([...r.main, ...r.fsl.flatMap((e) => e.rows), ...r.finisher.flatMap((e) => e.rows)].map((x) => [x.id, x]));
}

/** Save one row's inputs to the draft, refresh its summary, and mirror it into the same Session's other card. */
function onSetInput(rowEl) {
  const log = rowEl.closest('.set-log');
  if (!log) return;
  const id = rowEl.dataset.row;
  const val = { load: rowEl.querySelector('[data-set-load]').value, reps: rowEl.querySelector('[data-set-reps]').value, rpe: rowEl.querySelector('.rpe-chips').dataset.rpe };
  const key = log.dataset.draft;
  const draft = store(key) || {};
  if (val.load === '' && val.reps === '' && val.rpe === '') delete draft[id]; else draft[id] = val;
  store(key, draft);
  const r = rowsById(log.dataset.date, Number(log.dataset.i)).get(id);
  for (const el of document.querySelectorAll(`.set-log[data-draft="${CSS.escape(key)}"] [data-row="${CSS.escape(id)}"]`)) {
    if (el !== rowEl) {
      el.querySelector('[data-set-load]').value = val.load;
      el.querySelector('[data-set-reps]').value = val.reps;
      setRpeChips(el.querySelector('.rpe-chips'), val.rpe);
    }
    const cur = r ? draftToLogged(r, val) : null;
    el.querySelector('.set-out').innerHTML = cur ? loggedHtml(cur) : '';
  }
}

function setRpeChips(box, v) {
  box.dataset.rpe = v;
  for (const b of box.querySelectorAll('.rpe-chip')) b.setAttribute('aria-pressed', String(b.dataset.v === v));
}

/** Tap an RPE chip: choose it, or clear it when it was already chosen. */
function onSetRpe(btn) {
  const box = btn.closest('.rpe-chips');
  setRpeChips(box, box.dataset.rpe === btn.dataset.v ? '' : btn.dataset.v);
  onSetInput(btn.closest('.set-row'));
}

/** "As prescribed": fill the Prescription, close the row, open the next one. */
function onSetRx(btn) {
  const rowEl = btn.closest('.set-row');
  const log = rowEl.closest('.set-log');
  const r = rowsById(log.dataset.date, Number(log.dataset.i)).get(rowEl.dataset.row);
  if (!r) return;
  const loadEl = rowEl.querySelector('[data-set-load]');
  if (r.rxLoad != null) loadEl.value = fmtNum(r.rxLoad);
  else if (loadEl.value === '' && loadEl.placeholder) loadEl.value = loadEl.placeholder; // last time's weight
  rowEl.querySelector('[data-set-reps]').value = r.rxReps;
  onSetInput(rowEl);
  rowEl.open = false;
  const rows = [...log.querySelectorAll('details.set-row[data-row]')];
  const next = rows[rows.indexOf(rowEl) + 1];
  if (next) {
    next.open = true;
    next.querySelector('summary').focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else rowEl.querySelector('summary').focus();
}

/** The card's Logged Sets for Done, or { error, el } for a bad value. */
function collectSets(card, date, i) {
  const log = card.querySelector('.set-log');
  if (!log) return { sets: [] };
  const byId = rowsById(date, i);
  const sets = [];
  for (const rowEl of log.querySelectorAll('[data-row]')) {
    const r = byId.get(rowEl.dataset.row);
    const lEl = rowEl.querySelector('[data-set-load]');
    const rEl = rowEl.querySelector('[data-set-reps]');
    const rpe = rowEl.querySelector('.rpe-chips').dataset.rpe;
    if (!r || (lEl.value === '' && rEl.value === '' && rpe === '')) continue;
    const fail = (msg, el) => { rowEl.open = true; return { error: `${r.exercise} set ${r.n}: ${msg}`, el }; };
    const load = lEl.value === '' ? r.rxLoad : parseFloat(lEl.value);
    // Blank reps = as prescribed, except on the AMRAP set: there it means unknown (sent without reps).
    const reps = rEl.value === '' ? (r.amrap ? null : r.rxReps) : Number(rEl.value);
    if (load != null && !(load >= 0 && load <= 1000)) return fail('weight must be 0–1000', lEl);
    if (reps != null && !(Number.isInteger(reps) && reps >= 0 && reps <= 100)) return fail('reps must be a whole number 0–100', rEl);
    const out = { group: r.group, exercise: r.exercise.slice(0, 80), n: r.n, unit: r.unit };
    if (r.rxLoad != null) out.rxLoad = r.rxLoad;
    if (r.rxReps != null) out.rxReps = r.rxReps;
    if (r.rxRepsMax != null) out.rxRepsMax = r.rxRepsMax;
    if (load != null) out.load = load;
    if (reps != null) out.reps = reps;
    if (r.amrap) out.amrap = true;
    if (rpe !== '') out.rpe = Number(rpe);
    sets.push(out);
  }
  return { sets };
}

/** "Ramp: a, b, c. Then x. y." → a "Ramp" list (one row per step) and a "Then" list, like the Telegram reminder. */
function protocolHtml(protocol) {
  const groups = [];
  for (const sentence of String(protocol || '').split(/(?<=\.)\s+/).filter(Boolean)) {
    const m = /^([A-Z][a-z]+): (.+?)\.?$/.exec(sentence);
    if (m) groups.push({ title: m[1], items: m[2].split(', ') });
    else if (sentence.startsWith('Then ')) groups.push({ title: 'Then', items: [sentence.charAt(5).toUpperCase() + sentence.slice(6)] });
    else if (groups.length) groups[groups.length - 1].items.push(sentence);
    else groups.push({ title: 'Protocol', items: [sentence] });
  }
  return groups.map((g) => `<div class="sub-title">${esc(g.title)}</div>
    ${g.items.map((it, i) => `<div class="ex"><span class="ex-num">${i + 1}</span><div class="ex-body"><div class="ex-name" style="font-weight:500">${esc(it)}</div></div></div>`).join('')}`).join('');
}

function liftTestBody(s, det, key, done, ro = false) {
  return `
    ${det ? `<details class="fold"><summary>Warm-up checklist</summary>${exList(det.warmup, ro ? { numbered: true } : { checks: `wu-${key}` })}</details>
    ${protocolHtml(det.protocol)}` : ''}
    ${ro && !done ? '<div class="small muted" style="margin-top:6px">Log the top set from the Today tab on the day.</div>' : ''}
    ${done || ro ? '' : `<div class="sub-title">Top set</div>
    <div class="btn-row" style="align-items:center">
      <label class="inline-input small">Weight <input type="number" inputmode="decimal" min="0" max="500" step="0.5" data-test-w="${key}" aria-label="${esc(LIFT_NAME[s.lift])} test weight in kg"> kg</label>
      <label class="inline-input small">Reps <input type="number" inputmode="numeric" min="1" max="15" step="1" data-test-r="${key}" aria-label="${esc(LIFT_NAME[s.lift])} test reps"></label>
    </div>
    <div class="small muted" style="margin-top:4px">Saving the result sets this lift's Training Max; Cycle 1 starts once all four lifts are tested.</div>`}`;
}

function runBody(s, det) {
  if (!det) return '<div class="muted small">No details.</div>';
  if (s.run === 'ruck') {
    const l = det.ruckLoad || {};
    return `<div class="stats"><span><b>${esc(l.packKg ?? '—')}</b> kg pack</span><span><b>${esc(l.vertM ?? '—')}</b> m ↑</span><span><b>2–2.5</b> h</span></div>
      ${det.route ? renderRouteLine(det.route) : '<div class="small muted">No Route attached. Pick a hilly loop with the target climb.</div>'}`;
  }
  const rx = det.rx || {};
  return `<div class="stats"><span><b>${esc(rx.km ?? '—')}</b> km</span>${rx.vertM ? `<span><b>${esc(rx.vertM)}</b> m ↑</span>` : ''}</div>
    ${rx.detail ? `<div class="small">${esc(rx.detail)}</div>` : ''}
    ${det.route ? renderRouteLine(det.route) : ''}
    ${det.target ? `<div class="small muted" style="margin-top:4px">Week target ${esc(det.target.km)} km · ${esc(det.target.vertM)} m ↑${det.target.deload ? ' (deload)' : ''}</div>` : ''}`;
}

function climbBody(s, det) {
  if (s.fallback) return '<div class="small">Bouldering at <strong>the bouldering gym</strong>. No rope climb for 7 days, so keep the climbing going.</div>';
  const ev = (det && det.event) || clubEventById(s.eventId);
  return `${ev ? `<div class="small"><strong>${esc(ev.title)}</strong> · ${esc(ev.venue)} ${esc(ev.time)} <span class="badge">${ev.type === 'endurance_benchmark' ? 'Endurance Benchmark' : 'Partner Climb'}</span></div>` : ''}
    <div class="small muted" style="margin-top:4px">${esc((det && det.finisher) || (ev && ev.type === 'endurance_benchmark' ? 'Continuous minutes at a fixed grade. Log the grade and minutes.' : 'Last 30 min: back-to-back route laps.'))}</div>`;
}

/** One session in full. readOnly (future days in the sheet): no actions, inputs disabled.
 *  idPrefix keeps element ids unique when the same day is rendered twice (Today tab + sheet). */
function sessionCard(day, s, i, { readOnly = false, idPrefix = '' } = {}) {
  const det = detailFor(day.date, i);
  // The running Live Session (also when the Session was marked done elsewhere meanwhile: Finish sorts that out).
  if (!readOnly && isLiveFor(S.live, day.date, s)) return liveCard(s, i, det, idPrefix);
  const key = `${idPrefix}${day.date}-${i}`;
  const done = s.status === 'done';
  const locked = done || readOnly;
  let body = '';
  if (s.kind === 'lift') body = liftBody(s, det, key, day.date, locked, readOnly);
  else if (s.kind === 'lift-test') body = liftTestBody(s, det, key, done, readOnly);
  else if (s.kind === 'run') body = runBody(s, det);
  else if (s.kind === 'climb') body = climbBody(s, det);
  else body = `<div class="sub-title">Calisthenics</div>${exList(det && det.exercises, { numbered: true })}`;
  const canDefer = s.kind === 'lift' || s.kind === 'run';
  const title = sessionTitle(s, det);
  const nNotes = openNoteCount(day.date, sessionKey(s));
  return `
    <article class="card${done ? ' done' : ''}">
      <div class="card-head">
        <span class="pill ${kindClass(s)}"><span class="dot"></span>${esc(title)}</span>
        <span class="slot grow">${esc(s.slot)}</span>
        ${done ? '<span class="badge done">Done</span>' : ''}
        ${nNotes ? `<span class="badge note">${nNotes} comment${nNotes === 1 ? '' : 's'}</span>` : ''}
        <button class="btn small ghost note-btn" data-act="note-add" data-date="${day.date}" data-key="${esc(sessionKey(s))}" aria-label="Add a Comment for Replan about ${esc(title)}">+ Comment</button>
      </div>
      <div class="card-body">${body}${locked ? '' : benchmarkFields(s, det, key)}</div>
      ${locked ? '' : resumePrompt(day.date, i)}
      ${locked ? '' : `<div class="actions btn-row">
        ${s.kind === 'lift' || s.kind === 'lift-test' ? startButton(day.date, i) : ''}
        ${s.kind === 'lift-test'
          ? `<button class="btn good" data-act="session" data-type="test-result" data-date="${day.date}" data-i="${i}">Save result</button>`
          : `<button class="btn good" data-act="session" data-type="done" data-date="${day.date}" data-i="${i}">Done</button>`}
        <button class="btn" data-act="session" data-type="skip" data-date="${day.date}" data-i="${i}">Skip</button>
        ${canDefer ? `<button class="btn" data-act="session" data-type="tomorrow" data-date="${day.date}" data-i="${i}">Tomorrow</button>` : ''}
      </div>`}
    </article>`;
}

/* ═══════════════════════════ Benchmark Result on Done ═══════════════════════════ */

const BENCH_RUN = { 'benchmark-2k4': '2.4 km', 'benchmark-hill': 'Hill loop' };
const isAutobelay = (s, det) => {
  if (s.kind !== 'climb' || s.fallback) return false;
  const ev = (det && det.event) || clubEventById(s.eventId);
  return !!ev && ev.type === 'endurance_benchmark';
};
const gradeOptions = (sel = '') => `<option value="">—</option>${GRADES.map((g) => `<option value="${g}" ${g === sel ? 'selected' : ''}>${g}</option>`).join('')}`;

/** The optional Benchmark Result inputs on today's Benchmark card, read by Done. */
function benchmarkFields(s, det, key) {
  if (s.kind === 'run' && BENCH_RUN[s.run]) {
    return `<div class="bench-fields"><label class="field">${esc(BENCH_RUN[s.run])} time <span class="muted">(optional, mm:ss)</span>
      <input type="text" inputmode="decimal" autocomplete="off" maxlength="8" placeholder="${s.run === 'benchmark-2k4' ? '10:42' : '25:30'}" id="bt-${esc(key)}" data-bench-time></label></div>`;
  }
  if (isAutobelay(s, det)) {
    return `<div class="bench-fields grid2"><label class="field">Grade <span class="muted">(optional)</span><select id="bg-${esc(key)}" data-bench-grade>${gradeOptions()}</select></label>
      <label class="field">Minutes<input type="number" inputmode="numeric" min="1" max="240" step="1" id="bm-${esc(key)}" data-bench-min></label></div>`;
  }
  return '';
}

/** The `benchmark` field for Done from the card's inputs: undefined when left blank, or { error, el }. */
function readBenchmark(card) {
  const tEl = card.querySelector('[data-bench-time]');
  if (tEl && tEl.value.trim()) {
    const timeS = parseMmss(tEl.value);
    if (timeS === null || timeS < 60 || timeS > 14400) return { error: 'Enter the time as mm:ss, e.g. 10:42 (1 min to 4 h)', el: tEl };
    return { benchmark: { timeS } };
  }
  const gEl = card.querySelector('[data-bench-grade]');
  const mEl = card.querySelector('[data-bench-min]');
  if (gEl && (gEl.value || mEl.value)) {
    const minutes = Number(mEl.value);
    if (!gEl.value) return { error: 'Pick the grade climbed', el: gEl };
    if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 240)) return { error: 'Minutes must be a whole number from 1 to 240', el: mEl };
    return { benchmark: { grade: gEl.value, minutes } };
  }
  return {};
}

/* ═══════════════════════════ Live Session ═══════════════════════════
 * A lift Session or TM Test logged set by set (docs/api-contract.md, LiveSession), the same state as Telegram.
 * S.live mirrors GET /api/live; it is polled every 5 s while one runs and the page is visible. Typed values
 * live in LV.draft until a set is logged; the app makes no sound when rest ends (Telegram alerts). */

const LV = { seq: 0, busy: false, poll: null, tick: null, draft: {}, open: {}, resume: null, summary: null, restOver: false, json: 'null' };
const GROUP_TITLE = { main: 'Main sets', fsl: 'FSL', finisher: 'Finisher', test: 'Work-up sets' };
const LIVE_STATUS = { met: ['✓', 'Met', 'st-match'], over: ['↑', 'Over', 'st-above'], under: ['↓', 'Under', 'st-below'], done: ['✓', 'Done', 'st-match'] };

/** Replace S.live (from a response or a poll) and redraw what shows it. */
function setLive(live, { render = true } = {}) {
  if (live && S.live && live.id !== S.live.id) { LV.draft = {}; LV.open = {}; }
  S.live = live || null;
  LV.json = JSON.stringify(S.live);
  if (S.live) LV.summary = null;
  syncLiveTimers();
  if (render) renderLive();
}

/** Redraw Today, today's day sheet and the pinned bar, keeping focus on the same control. */
function renderLive() {
  const ae = document.activeElement;
  const focusId = ae && ae.id ? ae.id : null;
  try { renderToday(); } catch (e) { console.error(e); }
  if (SH.date === today()) { try { renderSheet(); } catch (e) { console.error(e); } }
  renderLiveBar();
  if (focusId && document.activeElement !== document.getElementById(focusId)) {
    const el = document.getElementById(focusId);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

function syncLiveTimers() {
  const poll = !!S.live && document.visibilityState === 'visible';
  if (poll && !LV.poll) LV.poll = setInterval(pollLive, 5000);
  if (!poll && LV.poll) { clearInterval(LV.poll); LV.poll = null; }
  if (S.live && !LV.tick) LV.tick = setInterval(tickRest, 1000);
  if (!S.live && LV.tick) { clearInterval(LV.tick); LV.tick = null; }
}

/** Pick up what Telegram (or another device) did. Skipped while an app request is in flight. */
async function pollLive() {
  if (LV.busy || !S.state) return;
  const seq = LV.seq;
  let res;
  try { res = await api.live(); } catch { return; }
  if (seq !== LV.seq || LV.busy) return;
  const live = (res && res.live) || null;
  if (JSON.stringify(live) === LV.json) return;
  const ended = !!S.live && (!live || live.id !== S.live.id);
  setLive(live);
  if (ended) { toast('The Live Session ended elsewhere'); await refreshAfterLive(); }
}

/** After a Live Session ends: the plan, the lift log and the charts change. */
async function refreshAfterLive() {
  invalidateProgress();
  try { await loadCore(); S.liftLog = await api.liftLog().catch(() => S.liftLog); } catch { /* offline: keep what is shown */ }
  renderAll();
}

/** Rest left, for the bar and the card: "Rest 1:23", "Rest over", "Paused" or ''. */
function restState(live) {
  if (!live) return { text: '', state: '' };
  if (live.paused) return { text: 'Paused', state: 'paused' };
  const left = secondsUntil(live.restEndsAt, Date.now());
  if (left === null) return { text: '', state: '' };
  return left > 0 ? { text: `Rest ${fmtMmss(left)}`, state: 'running' } : { text: 'Rest over', state: 'over' };
}

function tickRest() {
  const r = restState(S.live);
  for (const el of document.querySelectorAll('[data-lv-rest]')) {
    if (el.textContent !== r.text) el.textContent = r.text;
    el.dataset.state = r.state;
  }
  // Screen readers hear "Rest over" once; there is no sound or vibration (Telegram is the alert).
  if (r.state === 'over' && !LV.restOver) { LV.restOver = true; const a = $('#liveAnnounce'); if (a) a.textContent = 'Rest over'; }
  else if (r.state !== 'over') LV.restOver = false;
}

/** The Live Session's state for the API calls below; null (with a toast) when an action is already running. */
async function liveCall(fn) {
  if (LV.busy) return null;
  LV.busy = true;
  LV.seq++;
  document.body.classList.add('live-busy');
  try {
    return await fn();
  } catch (e) {
    toast(e.message || 'Something went wrong', true);
    // 404 / 409: the Live Session moved on elsewhere (finished, paused, ...): show what is true now.
    try { const r = await api.live(); setLive(r && r.live); } catch { /* keep what is shown */ }
    return null;
  } finally {
    LV.busy = false;
    document.body.classList.remove('live-busy');
  }
}

const liveStepKey = (k) => `${S.live ? S.live.id : ''}:${k}`;

/** Status chip of a set step once logged. */
function liveStatusHtml(st) {
  if (!st.loggedAt) return '';
  if (st.status === 'skipped') return '<span class="set-logged muted">Skipped</span>';
  if (st.status === 'amrap') return `<span class="set-logged st-amrap"><span class="sr-only">Logged Set, AMRAP: </span>${esc(`${st.reps ?? '?'} reps`)}${st.load != null ? ` · ${esc(fmtNum(st.load))} ${esc(st.unit)}` : ''}</span>${rpeHtml(st.rpe)}`;
  const [mark, word, cls] = LIVE_STATUS[st.status] || ['✓', 'Logged', 'st-match'];
  return `<span class="set-logged ${cls}"><span class="sr-only">Logged Set, ${word}: </span><span aria-hidden="true">${mark}</span> ${esc(loggedLine(st))}</span>${rpeHtml(st.rpe)}`;
}

/** Label of a set row's log button: what tapping it will do. */
function liveLogLabel(st, d) {
  if (st.loggedAt && !st.skipped) return 'Save correction';
  if (st.dose) return '✓ Done';
  const typed = d && (!isBlank(d.load) || !isBlank(d.reps));
  return typed || st.amrap || st.group === 'test' ? '✓ Log set' : '✓ As prescribed';
}

/** One set step as a collapsible row: the Prescription, the Logged Set, and inputs to log or correct it. */
function liveRow(st, k, { cur, paused, prefix }) {
  const live = S.live;
  const isCur = k === cur;
  const logged = !!st.loggedAt && !st.skipped;
  const open = LV.open[`${live.id}:${prefix}${k}`] ?? isCur;
  const d = LV.draft[liveStepKey(k)] || {};
  const nx = isCur && live.next ? live.next : {};
  const val = (f) => (d[f] !== undefined ? d[f] : logged && st[f] != null ? fmtNum(st[f]) : '');
  const ph = (f) => (nx[f] != null ? fmtNum(nx[f]) : st[`rx${f === 'load' ? 'Load' : 'Reps'}`] != null ? fmtNum(st[`rx${f === 'load' ? 'Load' : 'Reps'}`]) : '');
  const dis = paused ? ' disabled' : '';
  const id = `${prefix}lv-${k}`;
  const label = st.group === 'test' ? (logged || st.loggedAt ? `Work-up ${st.n}` : 'Next work-up set') : rxLine(st);
  const rpe = isBlank(d.rpe) ? (st.rpe != null ? String(st.rpe) : '') : String(d.rpe);
  const fields = st.dose ? `<div class="small muted">${esc(st.dose)}: tick it off when done.</div>` : `
        <div class="set-fields">
          <label class="set-field">Weight <span class="set-input"><input type="number" inputmode="decimal" min="0" max="1000" step="0.5" id="${id}-load" data-lv-load value="${esc(val('load'))}" placeholder="${esc(ph('load') || (st.group === 'test' ? 'kg' : ''))}" aria-label="${esc(st.exercise)} ${esc(setOfText(live, k) || `set ${st.n}`)} weight in ${esc(st.unit)}"${dis}><span class="muted">${esc(st.unit)}</span></span></label>
          <label class="set-field">Reps <span class="set-input"><input type="number" inputmode="numeric" min="0" max="100" step="1" id="${id}-reps" data-lv-reps value="${esc(val('reps'))}" placeholder="${esc(ph('reps') + (st.amrap ? '+' : ''))}" aria-label="${esc(st.exercise)} ${esc(setOfText(live, k) || `set ${st.n}`)} reps"${dis}></span></label>
        </div>
        <div class="rpe" role="group" aria-label="${esc(setOfText(live, k) || `Set ${st.n}`)} RPE, optional">
          <span class="set-field-lbl">RPE <span class="muted">(optional${logged ? ', saved on tap' : ''})</span></span>
          <div class="rpe-chips" data-rpe="${esc(rpe)}">${RPE_VALUES.map((n) => `<button type="button" class="rpe-chip" data-act="lv-rpe" data-v="${n}" aria-pressed="${String(rpe === String(n))}" aria-label="RPE ${n}"${dis}>${n}</button>`).join('')}</div>
        </div>`;
  const isTop = st.group === 'test' && !st.loggedAt;
  return `
    <details class="set-row live-row${isCur ? ' current' : ''}" data-lv-step="${k}" id="${id}"${open ? ' open' : ''}>
      <summary id="${id}-sum"><span class="set-n" aria-label="Set ${esc(st.n)}">${esc(st.n)}</span>
        <span class="set-rx"><span class="sr-only">${st.group === 'test' ? '' : 'Prescription: '}</span>${esc(label)}${isCur && !isTop ? ' <span class="badge note">Next</span>' : ''}</span>
        <span class="set-out">${liveStatusHtml(st)}</span></summary>
      <div class="set-edit">
        ${fields}
        ${st.amrap && !st.loggedAt ? '<div class="small muted">AMRAP: as many reps as you can, then enter them.</div>' : ''}
        <div class="btn-row live-set-btns">
          <button type="button" class="btn ${logged ? '' : 'good'}" data-act="lv-log" id="${id}-log"${dis}>${esc(liveLogLabel(st, d))}</button>
          ${isTop ? `<button type="button" class="btn primary" data-act="lv-top" id="${id}-top"${dis}>🏁 Log as top set</button>` : ''}
          ${st.loggedAt || st.group === 'test' ? '' : `<button type="button" class="btn" data-act="lv-skip" id="${id}-skip"${dis}>Skip</button>`}
        </div>
        ${isTop ? '<div class="small muted">The top set saves the TM Test result and ends the Live Session.</div>' : ''}
      </div>
    </details>`;
}

/** The Warm-up step: its checklist and a "Warm-up done" button until a set is logged. */
function liveWarmup(live, prefix, paused) {
  const wu = live.steps[0];
  const items = (wu.items || []).map((t, j) => `<label class="ex ex-check"><input type="checkbox" id="${prefix}lwu-${j}"><span class="ex-body"><span class="ex-name">${esc(t)}</span></span></label>`).join('');
  return `<details class="fold"><summary>Warm-up${wu.done ? ' <span class="badge done">Done</span>' : ''}</summary>${items || '<div class="muted small">—</div>'}
    ${wu.done ? '' : `<div class="btn-row" style="margin:6px 0 4px"><button type="button" class="btn" data-act="live-warmup" id="${prefix}lv-wu"${paused ? ' disabled' : ''}>Warm-up done</button></div>`}</details>`;
}

/** The card of the running Live Session: set rows to log one by one, and Finish / Pause / Cancel or Abandon. */
function liveCard(s, i, det, prefix) {
  const live = S.live;
  const cur = focusStep(live);
  const paused = !!live.paused;
  const isTest = live.ref.kind === 'lift-test';
  const opts = { cur, paused, prefix };
  let rows = '';
  let lastGroup = '';
  let lastEx = '';
  live.steps.forEach((st, k) => {
    if (k === 0 || st.kind !== 'set') return;
    if (st.group !== lastGroup) {
      rows += `<div class="sub-title">${esc(GROUP_TITLE[st.group] || st.group)}${st.group === 'main' && det && det.tm ? ` · TM ${esc(det.tm)} kg` : ''}</div>`;
      lastGroup = st.group; lastEx = '';
    }
    if (st.group !== 'main' && st.group !== 'test' && st.exercise !== lastEx) {
      const ex = det ? [...(det.fsl || []), ...(det.finisher || [])].find((e) => e.name === st.exercise) : null;
      rows += `<div class="set-ex"><div class="set-ex-head"><span class="ex-name">${esc(st.exercise)}</span>${ex ? `<span class="ex-dose">${esc(fmtDose(ex.dose))}</span>` : ''}</div>${ex && ex.cue ? `<div class="ex-cue">${esc(ex.cue)}</div>` : ''}</div>`;
      lastEx = st.exercise;
    }
    rows += liveRow(st, k, opts);
  });
  if (isTest) {
    if (live.steps.length === 1) rows += `<div class="sub-title">${GROUP_TITLE.test}</div>`;
    rows += liveRow({ kind: 'set', group: 'test', exercise: LIFT_NAME[live.ref.lift], n: live.steps.length, unit: (live.next && live.next.unit) || 'kg' }, live.steps.length, opts);
  }
  const t = liveTally(live);
  const sets = live.steps.filter((x) => x.kind === 'set').length;
  const progress = isTest ? `${t.logged} work-up set${t.logged === 1 ? '' : 's'} logged` : `${t.logged + t.skipped} of ${sets} sets logged`;
  const rest = restState(live);
  const title = live.title || sessionTitle(s, det);
  return `
    <article class="card live-card" id="${prefix}liveCard" aria-label="Live Session: ${esc(title)}">
      <div class="card-head">
        <span class="pill ${kindClass(s)}"><span class="dot"></span>${esc(title)}</span>
        <span class="slot grow">${esc(s.slot)}</span>
        <span class="badge live-badge"><span class="live-dot" aria-hidden="true"></span>Live</span>
      </div>
      <div class="live-status small"><span>${esc(progress)}</span><span class="lv-rest" data-lv-rest data-state="${rest.state}">${esc(rest.text)}</span></div>
      ${paused ? '<div class="notes live-paused" role="status"><strong>⏸ Paused.</strong> Set input is off until you resume.</div>' : ''}
      <div class="card-body">
        ${liveWarmup(live, prefix, paused)}
        ${isTest && det ? `<details class="fold"><summary>Protocol</summary>${protocolHtml(det.protocol)}</details>` : ''}
        <div class="set-log live-log">${rows}</div>
      </div>
      <div class="actions btn-row live-actions">
        ${isTest ? '' : `<button class="btn good" data-act="live-finish" id="${prefix}lv-finish" ${live.loggedSets ? '' : 'disabled'}>🏁 Finish</button>`}
        <button class="btn" data-act="${paused ? 'live-resume' : 'live-pause'}" id="${prefix}lv-pause">${paused ? '▶ Resume' : '⏸ Pause'}</button>
        ${live.loggedSets ? `<button class="btn danger" data-act="live-abandon" id="${prefix}lv-abandon">Abandon</button>` : `<button class="btn" data-act="live-cancel" id="${prefix}lv-cancel">✕ Cancel</button>`}
      </div>
    </article>`;
}

/** ▶ Start on a lift or TM Test card (off while another Live Session runs). */
function startButton(date, i) {
  if (S.live) return `<button class="btn primary" disabled title="Another Live Session is running: ${esc(S.live.title)}">▶ Start</button>`;
  return `<button class="btn primary" data-act="live-start" data-date="${esc(date)}" data-i="${i}" aria-label="Start a Live Session: log set by set">▶ Start</button>`;
}

/** After Start found an attempt abandoned earlier today: Resume it or Start fresh. */
function resumePrompt(date, i) {
  const r = LV.resume;
  if (!r || r.date !== date || r.i !== i || S.live) return '';
  return `<div class="notes live-resume" role="alert">${esc(r.msg)}
    <div class="btn-row" style="margin-top:8px">
      <button class="btn primary" data-act="live-start" data-mode="resume" data-date="${esc(date)}" data-i="${i}">▶ Resume</button>
      <button class="btn" data-act="live-start" data-mode="fresh" data-date="${esc(date)}" data-i="${i}">Start fresh</button>
      <button class="btn ghost" data-act="live-resume-dismiss">Not now</button>
    </div></div>`;
}

/** The finish summary, shown at the top of Today until closed. */
function liveSummaryCard() {
  const m = LV.summary;
  if (!m) return '';
  const t = m.tally;
  let line = '';
  if (m.test) line = m.events.length ? m.events.join(' · ') : `Top set ${fmtNum(m.test.load)} kg × ${m.test.reps}: TM Test result saved.`;
  else {
    const parts = [];
    if (t.met) parts.push(`<span class="st-match"><span aria-hidden="true">✓</span> ${t.met} met</span>`);
    if (t.over) parts.push(`<span class="st-above"><span aria-hidden="true">↑</span> ${t.over} over</span>`);
    if (t.under) parts.push(`<span class="st-below"><span aria-hidden="true">↓</span> ${t.under} under</span>`);
    if (t.done) parts.push(`${t.done} done`);
    if (t.skipped) parts.push(`${t.skipped} skipped`);
    if (t.amrap !== null) parts.push(`<span class="st-amrap">AMRAP ${t.amrap} reps</span>`);
    line = parts.join(' · ') || 'No sets logged.';
  }
  return `
    <article class="card live-summary" id="liveSummary" tabindex="-1" aria-labelledby="liveSummaryTitle">
      <div class="card-head"><strong class="grow" id="liveSummaryTitle">Finished: ${esc(m.title)}</strong>
        <button class="btn small ghost" data-act="live-summary-close" aria-label="Close the summary">Close</button></div>
      <div class="card-body">
        <div class="live-tally">${m.test ? esc(line) : line}</div>
        ${m.outcome === 'not-counted' ? '<div class="small muted" style="margin-top:6px">This Session was already marked done elsewhere, so it was not counted again. The Logged Sets are kept.</div>' : ''}
      </div>
    </article>`;
}

/** The pinned bar: current step, its Prescription, rest countdown, Pause / Resume, +30 s and a jump to the set. */
function renderLiveBar() {
  const bar = $('#liveBar');
  if (!bar) return;
  const live = S.live;
  document.body.classList.toggle('live-on', !!live);
  if (!live) { bar.hidden = true; bar.innerHTML = ''; return; }
  const k = focusStep(live);
  const st = live.steps[k];
  let step;
  if (live.ref.kind === 'lift-test') step = `Work-up set ${live.steps.length}${live.next && live.next.load != null ? ` · ${fmtNum(live.next.load)} ${live.next.unit} × ${live.next.reps ?? '?'}` : ''}`;
  else if (st && st.kind === 'set') step = `${setOfText(live, k)} · ${st.exercise} · ${live.next && k === live.current ? rxLine({ ...st, rxLoad: live.next.load ?? st.rxLoad, rxReps: live.next.reps ?? st.rxReps }) : rxLine(st)}`;
  else step = 'Every set logged: Finish';
  const rest = restState(live);
  const paused = !!live.paused;
  bar.hidden = false;
  bar.innerHTML = `
    <div class="lb-main">
      <div class="lb-title"><span class="live-dot" aria-hidden="true"></span><span class="sr-only">Live Session: </span>${esc(live.title)}</div>
      <div class="lb-step">${paused ? '⏸ Paused · ' : ''}${esc(step)}</div>
    </div>
    <div class="lb-rest" data-lv-rest data-state="${rest.state}">${esc(rest.text)}</div>
    <div class="lb-btns">
      <button class="btn" data-act="${paused ? 'live-resume' : 'live-pause'}" id="lbPause">${paused ? '▶ Resume' : '⏸ Pause'}</button>
      <button class="btn" data-act="live-rest30" id="lbRest" ${paused ? 'disabled' : ''} aria-label="Add 30 seconds of rest">+30 s</button>
      <button class="btn primary" data-act="live-jump" id="lbJump">Go to set</button>
    </div>`;
}

/** Open and show step k's row (in the sheet when `inSheet`, else on Today) and focus it. */
function focusLiveRow(k, inSheet) {
  const root = inSheet ? dayHostEl() : $('#tab-today');
  const row = root && root.querySelector(`[data-lv-step="${k}"]`);
  if (!row) { const card = root && root.querySelector('.live-card'); if (card) card.scrollIntoView({ block: 'nearest' }); return; }
  row.open = true;
  row.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  // The row, not its Weight input: on a phone that would pop the keyboard up for every "As prescribed".
  row.querySelector('summary').focus({ preventScroll: true });
}

async function onLiveStart(btn) {
  const { date, mode } = btn.dataset;
  const i = Number(btn.dataset.i);
  const s = findSession(date, i);
  if (!s || LV.busy) return;
  LV.busy = true; LV.seq++;
  btn.disabled = true;
  let res = null;
  try {
    res = await api.liveStart(date, toRef(s), mode);
    LV.resume = null;
  } catch (e) {
    if (e.status === 409 && e.resumable) {
      LV.resume = { date, i, msg: e.message };
      renderLive();
      $('[data-act="live-start"][data-mode="resume"]')?.focus();
    } else {
      toast(e.message || 'Could not start', true);
      LV.resume = null;
      try { const r = await api.live(); setLive(r && r.live); } catch { renderLive(); }
    }
    return;
  } finally { LV.busy = false; }
  const inSheet = !!btn.closest('#sheetPanel, #dayPanel');
  setLive(res.live);
  toast(mode === 'resume' ? 'Live Session resumed' : 'Live Session started');
  focusLiveRow(focusStep(S.live), inSheet);
}

/** Log, correct, skip or (TM Test) top a set from its row. */
async function onLiveLog(btn, how) {
  const live = S.live;
  const row = btn.closest('[data-lv-step]');
  if (!live || !row) return;
  const k = Number(row.dataset.lvStep);
  const st = live.steps[k] || { group: 'test', n: k, unit: 'kg' };
  const body = { step: k };
  if (how === 'skip') body.skip = true;
  else {
    const lEl = row.querySelector('[data-lv-load]');
    const rEl = row.querySelector('[data-lv-reps]');
    const rpe = row.querySelector('.rpe-chips') ? row.querySelector('.rpe-chips').dataset.rpe : '';
    if (lEl && lEl.value !== '') {
      const load = parseFloat(lEl.value);
      if (!(load >= 0 && load <= 1000)) { toast('Weight must be 0–1000', true); lEl.focus(); return; }
      body.load = load;
    }
    if (rEl && rEl.value !== '') {
      const reps = Number(rEl.value);
      if (!(Number.isInteger(reps) && reps >= 0 && reps <= 100)) { toast('Reps must be a whole number 0–100', true); rEl.focus(); return; }
      body.reps = reps;
    }
    if (st.amrap && !st.loggedAt && body.reps === undefined) { toast('Enter the AMRAP reps', true); rEl && rEl.focus(); return; }
    // A TM Test has no Prescription: with nothing logged yet, the weight is typed (never the bar by default).
    if (st.group === 'test' && !st.loggedAt && body.load === undefined && !(live.next && live.next.load != null)) { toast('Type the weight', true); lEl && lEl.focus(); return; }
    if (rpe !== '' && rpe != null) body.rpe = Number(rpe);
    if (how === 'top') {
      const load = body.load ?? (live.next && live.next.load);
      const reps = body.reps ?? (live.next && live.next.reps);
      if (!(load > 0 && load <= 500) || !(Number.isInteger(reps) && reps >= 1 && reps <= 15)) { toast('The top set needs a weight up to 500 kg and 1–15 reps', true); (lEl || btn).focus(); return; }
      if (!confirm(topSetConfirmText(S.state, live.ref.lift, load, reps, plateStep()))) return;
      body.load = load; body.reps = reps; body.top = true;
    }
  }
  const inSheet = !!btn.closest('#sheetPanel, #dayPanel');
  const res = await liveCall(() => api.liveLog(body));
  if (!res) return;
  delete LV.draft[liveStepKey(k)];
  delete LV.open[`${live.id}:${k}`];
  delete LV.open[`${live.id}:sh-${k}`];
  if (!res.live) { // the TM Test's top set: the result is saved and the Live Session is over
    LV.summary = { title: live.title, test: { load: body.load, reps: body.reps }, events: res.events || [], outcome: res.outcome, tally: liveTally(live) };
    setLive(null);
    await refreshAfterLive();
    $('#liveSummary')?.focus();
    return;
  }
  setLive(res.live);
  if (how !== 'skip' && st.loggedAt) { toast('Set corrected'); return; }
  focusLiveRow(focusStep(S.live), inSheet);
}

/** An RPE chip: on a logged set it is saved at once; otherwise it waits for the set to be logged. */
async function onLiveRpe(btn) {
  const row = btn.closest('[data-lv-step]');
  const box = btn.closest('.rpe-chips');
  const k = Number(row.dataset.lvStep);
  const st = S.live && S.live.steps[k];
  if (st && st.loggedAt && !st.skipped) {
    if (box.dataset.rpe === btn.dataset.v) return; // an RPE can be changed, not cleared
    setRpeChips(box, btn.dataset.v);
    const res = await liveCall(() => api.liveLog({ step: k, rpe: Number(btn.dataset.v) }));
    if (res && res.live) { setLive(res.live); toast(`RPE ${btn.dataset.v} saved`); }
    return;
  }
  setRpeChips(box, box.dataset.rpe === btn.dataset.v ? '' : btn.dataset.v);
  onLiveInput(row);
}

/** Keep a row's typed values (LV.draft), mirror them into the same row elsewhere, and relabel its button. */
function onLiveInput(row) {
  const k = row.dataset.lvStep;
  const val = { load: row.querySelector('[data-lv-load]')?.value ?? '', reps: row.querySelector('[data-lv-reps]')?.value ?? '', rpe: row.querySelector('.rpe-chips')?.dataset.rpe ?? '' };
  LV.draft[liveStepKey(k)] = val;
  const st = (S.live && S.live.steps[Number(k)]) || { group: 'test' };
  for (const el of document.querySelectorAll(`[data-lv-step="${CSS.escape(k)}"]`)) {
    if (el !== row) {
      const l = el.querySelector('[data-lv-load]'); if (l) l.value = val.load;
      const r = el.querySelector('[data-lv-reps]'); if (r) r.value = val.reps;
      const c = el.querySelector('.rpe-chips'); if (c) setRpeChips(c, val.rpe);
    }
    const b = el.querySelector('[data-act="lv-log"]');
    if (b) b.textContent = liveLogLabel(st, val);
  }
}

/** Finish, Cancel, Abandon, Pause, Resume, Warm-up done, +30 s. */
async function onLiveAction(act, btn) {
  const live = S.live;
  if (!live) return;
  if (act === 'live-finish') {
    const open = live.steps.filter((x) => x.kind === 'set' && !x.loggedAt).length;
    if (open && !confirm(`${open} set${open === 1 ? ' is' : 's are'} not logged. Finish anyway?`)) return;
    const res = await liveCall(() => api.liveDo('finish'));
    if (!res) return;
    LV.summary = { title: live.title, tally: liveTally(live), events: res.events || [], outcome: res.outcome };
    setLive(null);
    await refreshAfterLive();
    $('#liveSummary')?.focus();
    return;
  }
  if (act === 'live-abandon') {
    if (!confirm('Abandon this Live Session? The Logged Sets are kept but the Session is not counted. You can resume it later today.')) return;
    const res = await liveCall(() => api.liveDo('abandon'));
    if (!res) return;
    setLive(null);
    toast('Live Session abandoned');
    await refreshAfterLive();
    return;
  }
  if (act === 'live-cancel') {
    const res = await liveCall(() => api.liveDo('cancel'));
    if (!res) return;
    setLive(null);
    toast('Live Session cancelled');
    await refreshAfterLive();
    return;
  }
  const call = { 'live-pause': () => api.liveDo('pause'), 'live-resume': () => api.liveDo('resume'), 'live-warmup': () => api.liveDo('warmup-done'), 'live-rest30': () => api.liveRest({ addSeconds: 30 }) }[act];
  if (!call) return;
  const focusId = btn && btn.id;
  const inSheet = !!(btn && btn.closest('#sheetPanel, #dayPanel'));
  const res = await liveCall(call);
  if (!res) return;
  setLive(res.live);
  if (act === 'live-pause') toast('Paused');
  if (act === 'live-resume') toast('Resumed');
  // Pause and Resume swap the button: keep focus on its replacement. Warm-up done goes away: on to the first set.
  const again = focusId && document.getElementById(focusId);
  if (again && !again.disabled) again.focus({ preventScroll: true });
  else if (act === 'live-warmup' && S.live) focusLiveRow(focusStep(S.live), inSheet);
}

/** "Go to set": Today, the current set's row open and in view. */
function onLiveJump() {
  if (!S.live) return;
  if (NAV.current !== 'today') { setRoute(routeHash('today')); showTab('today'); }
  focusLiveRow(focusStep(S.live), false);
}

function mobilityStatus(date) {
  const e = (S.mobility.log || []).find((x) => x.date === date);
  return e ? e.status : null;
}

function routineCard(date) {
  const st = mobilityStatus(date);
  const n = S.content && S.content.dailyRoutine ? S.content.dailyRoutine.length : 15;
  return `
    <article class="card">
      <div class="card-head">
        <span class="pill k-easy" style="background:rgba(129,140,248,.12);color:var(--accent)"><span class="dot"></span>Daily Routine</span>
        <span class="grow small muted">${n} items · ~27 min</span>
        ${st ? `<span class="badge ${st === 'done' ? 'done' : ''}">${st === 'done' ? 'Done' : 'Skipped'}</span>` : ''}
      </div>
      <div class="actions btn-row">
        <button class="btn primary" data-act="timer-start">Follow along</button>
        ${st === 'done' ? '' : `<button class="btn good" data-act="mobility" data-status="done" data-date="${date}">Done</button>`}
        ${st ? '' : `<button class="btn" data-act="mobility" data-status="skipped" data-date="${date}">Skipped</button>`}
      </div>
    </article>`;
}

/** This run week: done run kinds, the week's target (from any run planned this week) and Activity totals. */
function runWeekInfo() {
  const st = S.state;
  if (!st) return null;
  const mon = mondayOf(today());
  const done = (st.runsThisWeek && st.runsThisWeek[mon]) || [];
  let target = null;
  for (const d of S.plan.days.slice(0, 14)) {
    if (mondayOf(d.date) !== mon) continue;
    d.sessions.forEach((s, i) => {
      const det = s.kind === 'run' ? detailFor(d.date, i) : null;
      if (!target && det && det.target) target = det.target;
    });
  }
  const weekIdx = Math.floor(daysBetween(st.run.runStartMonday, mon) / 7);
  let km = null; let vert = null;
  if (S.activities) {
    const week = (S.activities.entries || []).filter((a) => mondayOf(a.date) === mon && (a.sport === 'run' || a.sport === 'hike'));
    km = round1(week.reduce((n, a) => n + (a.km || 0), 0));
    vert = Math.round(week.reduce((n, a) => n + (a.vertM || 0), 0));
  }
  return { mon, done, target, weekIdx, km, vert, startMon: st.run.runStartMonday };
}

/** "Run week 3 (deload)", or "Runs start Mon 5 Oct" before the run block begins. */
const runWeekLabel = (rw) => (rw.weekIdx < 0 ? `Runs start ${fmtDay(rw.startMon)}`
  : `Run week ${rw.weekIdx + 1}${rw.target && rw.target.deload ? ' (deload)' : ''}`);

/** One line under Today's date: where the Cycle and the run week stand. */
function todayStatusLine() {
  const st = S.state;
  if (!st) return '';
  const ph = st.lift.phase;
  const cycle = st.testWeek ? `Test Week ${Object.keys(st.testWeek.results || {}).length}/4 tested`
    : ph.kind === 'reentry' ? `Re-entry Week ${ph.done}/4 · next ${LIFT_NAME[LIFTS[ph.done]]}`
    : `Cycle week ${st.lift.week} (${WEEK_LABEL[st.lift.week]}) · next ${LIFT_NAME[LIFTS[st.lift.index]]}`;
  const rw = runWeekInfo();
  const run = rw ? [runWeekLabel(rw), rw.weekIdx < 0 ? '' : `${rw.done.length}/3 runs`,
    rw.km != null ? `${rw.km}${rw.target ? ` of ${rw.target.km}` : ''} km` : ''].filter(Boolean).join(' · ') : '';
  return `<div class="status-line small"><span>${esc(cycle)}</span>${run ? `<span>${esc(run)}</span>` : ''}</div>`;
}

function renderToday() {
  const el = $('#tab-today');
  const day = S.plan.days[0];
  if (!day) { el.innerHTML = '<div class="empty">No plan loaded.</div>'; return; }
  let html = `<h2 class="section-title" id="h-today" tabindex="-1"><span class="sr-only">Today, </span>${esc(fmtDay(day.date))} <span class="day-badges" style="display:inline-flex;margin-left:6px;vertical-align:middle">${dayBadges(day)}</span></h2>
    ${todayStatusLine()}${dayNotesLine(day)}${liveSummaryCard()}`;
  if (S.live && S.live.date !== day.date) html += `<div class="notes">A Live Session from ${esc(fmtDay(S.live.date))} is still running: ${esc(S.live.title)}.</div>`;
  if (day.mountain) {
    html += `<div class="notes"><strong>⛰ Mountain day — check in tonight.</strong><br>Send <code>/log 6h 900m 7</code> to the bot (hours, metres climbed, effort 1–10). Mobility still runs.</div>`;
  }
  html += day.sessions.map((s, i) => sessionCard(day, s, i)).join('');
  if (!day.sessions.length && !day.mountain) html += '<div class="notes">Rest day. Nothing planned.</div>';
  html += routineCard(day.date);
  const tomorrow = S.plan.days[1];
  if (tomorrow) html += `<div class="section-title">Tomorrow</div>${dayRow(tomorrow)}`;
  el.innerHTML = html;
}

/* ═══════════════════════════ Comments for Replan ═══════════════════════════ */

const commentsOn = (date) => S.comments.filter((c) => c.date === date).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
const isOpen = (c) => c.status !== 'addressed';
/** Open notes on a date; with a key, only those about that session. */
const openNoteCount = (date, key) => S.comments.filter((c) => c.date === date && isOpen(c) && (key === undefined || (c.session && c.session.key) === key)).length;
const aboutText = (c) => (c.session ? c.session.label || c.session.key : 'Whole day');

/** "About" choices for a day's note form: one per session (by key). */
function sessionOptions(date) {
  const day = PC.days[date];
  const out = [];
  (day ? day.sessions : []).forEach((s, i) => {
    const key = sessionKey(s);
    if (!out.some((o) => o.key === key)) out.push({ key, label: sessionTitle(s, detailFor(date, i)).slice(0, 80) });
  });
  return out;
}

function noteMarker(date) {
  const n = openNoteCount(date);
  return n ? `<span class="note-count" title="${n} open comment${n === 1 ? '' : 's'}"><span aria-hidden="true">✎</span> ${n}<span class="sr-only"> open comment${n === 1 ? '' : 's'}</span></span>` : '';
}

/** "Comments for Replan": open Comments for today onward, addressed ones under a fold. */
function notesPanel() {
  const t = today();
  const open = S.comments.filter((c) => isOpen(c) && c.date >= t).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const addressed = S.comments.filter((c) => !isOpen(c)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const item = (c) => `
    <button class="cm-link" data-act="open-day" data-date="${esc(c.date)}">
      <span class="cm-link-date">${esc(fmtDay(c.date))}</span>
      <span class="cm-link-body"><span class="small muted">${esc(aboutText(c))}</span><span class="cm-link-text">${esc(c.text)}</span>
        ${c.resolution ? `<span class="small muted">→ ${esc(c.resolution)}</span>` : ''}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>`;
  const panelOpen = store('notesPanel') !== false;
  return `
    <details class="card notes-panel" id="notesPanel" ${panelOpen ? 'open' : ''}>
      <summary><span class="grow">Comments for Replan</span>${S.commentsOk ? `<span class="badge${open.length ? ' note' : ''}">${open.length} open</span>` : ''}</summary>
      <div class="notes-panel-body">
        ${!S.commentsOk ? '<div class="empty">Comments unavailable.</div>'
          : open.length ? open.map(item).join('')
          : '<div class="small muted" style="padding:4px 0 10px">No open Comments. Tap a day and add one (“knee sore, keep it flat”) so the next replan can adapt it.</div>'}
        ${addressed.length ? `<details class="fold"><summary>Addressed (${addressed.length})</summary>${addressed.map(item).join('')}</details>` : ''}
      </div>
    </details>`;
}

/* ═══════════════════════════ Plan (list | month) ═══════════════════════════ */

const PV = { mode: store('planView') === 'month' ? 'month' : 'list', month: null, listDays: LIST_DAYS };

/** A day as a tappable row (Plan list, Today's "Tomorrow" preview). */
function dayRow(d) {
  const t = today();
  const badges = dayBadges(d);
  return `
    <button class="day-card day-row${d.date === t ? ' today' : ''}" data-act="open-day" data-date="${d.date}" aria-label="${esc(fmtDay(d.date))}${d.date === t ? ' (today)' : ''}: show details">
      <span class="day-label"><span class="day-name">${DOW[weekday(d.date)]}</span><span class="day-num">${toDate(d.date).getUTCDate()}</span></span>
      <span class="day-body">
        ${badges ? `<span class="day-badges">${badges}</span>` : ''}
        ${dayNotesLine(d, 'span')}
        ${d.sessions.length ? d.sessions.map((s, i) => {
          const det = detailFor(d.date, i);
          const sum = sessionSummary(s, det);
          return `<span class="sess"><span class="sess-line"><span class="pill ${kindClass(s)}"><span class="dot"></span>${esc(sessionTitle(s, det))}</span><span class="slot">${esc(s.slot)}</span>${s.status === 'done' ? '<span class="badge done">Done</span>' : ''}</span>${sum ? `<span class="sess-detail">${esc(sum)}</span>` : ''}</span>`;
        }).join('') : `<span class="muted small">${d.mountain ? 'Mountain day — no runs or lifts' : 'Rest'}</span>`}
      </span>
      <span class="row-end">${noteMarker(d.date)}<span class="chev" aria-hidden="true">›</span></span>
    </button>`;
}

function weekSummary(days) {
  let target = null;
  let lifts = 0; let runs = 0; let climbs = 0; let mountain = 0;
  const trips = new Set();
  for (const d of days) {
    if (d.mountain) mountain++;
    for (const c of constraintsOn(d.date)) if (c.note && !c.mountain) trips.add(c.note);
    if (!constraintsOn(d.date).length && d.note) trips.add(d.note);
    d.sessions.forEach((s, i) => {
      if (s.kind === 'run') { runs++; const det = detailFor(d.date, i); if (!target && det && det.target) target = det.target; }
      else if (s.kind === 'climb') climbs++;
      else lifts++;
    });
  }
  const parts = [];
  if (target) parts.push(`${esc(target.km)} km · ${esc(target.vertM)} m ↑${target.deload ? ' (deload)' : ''}`);
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  parts.push([`${lifts} strength`, n(runs, 'run'), n(climbs, 'climb')].join(' · '));
  const badges = [...trips].map((x) => `<span class="badge trip">${esc(x)}</span>`).join('')
    + (mountain ? `<span class="badge mountain">Mountain × ${mountain}</span>` : '');
  return { text: parts.join(' — '), counts: parts[parts.length - 1], badges };
}

/** The current week's run target and progress (Easy / Quality / Long done, km and m climbed vs target). */
function runWeekBlock() {
  const rw = runWeekInfo();
  if (!rw) return '';
  const chk = (k, label) => `<span class="badge ${rw.done.includes(k) ? 'done' : ''}">${rw.done.includes(k) ? '<span aria-hidden="true">✓ </span><span class="sr-only">done: </span>' : ''}${label}</span>`;
  const pct = rw.target && rw.km != null && rw.target.km > 0 ? Math.min(100, Math.round((rw.km / rw.target.km) * 100)) : null;
  return `
    <div class="run-week">
      <div class="small"><strong>${esc(runWeekLabel(rw))}</strong>
        ${rw.target ? ` · target ${esc(rw.target.km)} km · ${esc(rw.target.vertM)} m ↑` : ' · <span class="muted">no run planned, so no target</span>'}</div>
      <div class="run-checks">${chk('easy', 'Easy')}${chk('quality', 'Quality')}${chk('long', 'Long')}<span class="small muted">${esc(rw.done.length)}/3 runs</span></div>
      ${rw.km != null ? `<div class="small">Done: <strong>${esc(rw.km)}</strong> km · <strong>${esc(rw.vert)}</strong> m ↑${rw.target ? ` of ${esc(rw.target.km)} km · ${esc(rw.target.vertM)} m` : ''}</div>` : ''}
      ${pct != null ? `<div class="meter" role="img" aria-label="${pct}% of the week's km"><i style="width:${pct}%"></i></div>` : ''}
      <div class="small muted">Runs not done by Sunday are dropped.</div>
    </div>`;
}

function planListView() {
  const t = today();
  const last = addDays(t, PV.listDays - 1);
  const status = requestPlanRange(t, last);
  const weeks = [];
  for (let d = t; d <= last; d = addDays(d, 1)) {
    const day = PC.days[d];
    if (!day) continue;
    const mon = mondayOf(d);
    let w = weeks[weeks.length - 1];
    if (!w || w.mon !== mon) weeks.push((w = { mon, days: [] }));
    w.days.push(day);
  }
  let html = weeks.map((w) => {
    const sum = weekSummary(w.days);
    const thisWeek = w.mon === mondayOf(t);
    return `
      <section class="week-grp" aria-label="Week of ${esc(fmtShort(w.mon))}">
        <div class="week-head">
          <div class="week-title"><strong>${thisWeek ? 'This week' : `Week of ${esc(fmtShort(w.mon))}`}</strong> <span class="muted small">${esc(fmtShort(w.mon))} – ${esc(fmtShort(addDays(w.mon, 6)))}</span></div>
          <div class="small muted">${thisWeek ? sum.counts : sum.text}</div>
          ${sum.badges ? `<div class="day-badges">${sum.badges}</div>` : ''}
          ${thisWeek ? runWeekBlock() : ''}
        </div>
        ${w.days.map(dayRow).join('')}
      </section>`;
  }).join('');
  if (status === 'loading') html += '<div class="loading" role="status">Loading the plan…</div>';
  else if (status === 'error') html += planErrorBlock();
  else if (!weeks.length) html += '<div class="empty">No plan loaded.</div>';
  if (status === 'ready' && PV.listDays < HORIZON_DAYS) {
    html += `<button class="btn more-btn" data-act="plan-more">Show more weeks (up to ${HORIZON_DAYS} days)</button>`;
  } else if (status === 'ready' && weeks.length) {
    html += `<div class="small muted center">The plan is projected ${HORIZON_DAYS} days ahead, to ${esc(fmtDay(horizonEnd()))}.</div>`;
  }
  return html;
}

function planErrorBlock() {
  return `<div class="notes" role="alert">Could not load more of the plan: ${esc(PC.error)} <button class="btn small" data-act="plan-retry">Retry</button></div>`;
}

function calCell(date, status) {
  const t = today();
  const num = `<span class="cal-num">${toDate(date).getUTCDate()}</span>`;
  const notes = openNoteCount(date);
  const marker = notes ? '<span class="cal-note" aria-hidden="true"></span>' : '';
  if (date < t) return `<div class="cal-cell past">${num}${marker}</div>`;
  if (date > horizonEnd()) return `<div class="cal-cell beyond">${num}</div>`;
  const day = PC.days[date];
  const cls = ['cal-cell'];
  if (date === t) cls.push('today');
  if (day && day.mountain) cls.push('mountain');
  else if (constraintsOn(date).length || (day && day.note)) cls.push('trip');
  if (!day && status !== 'loading') cls.push('no-plan');
  const sessions = day ? day.sessions : [];
  const desc = day ? (sessions.length ? sessions.map((s, i) => sessionTitle(s, detailFor(date, i))).join(', ') : day.mountain ? 'mountain day' : 'rest') : (status === 'loading' ? 'loading' : 'no plan');
  const dn = (day && day.notes) || [];
  const label = `${fmtDay(date)}${date === t ? ' (today)' : ''}: ${desc}${dn.length ? `. ${dn.join('. ')}` : ''}${notes ? `, ${notes} open comment${notes === 1 ? '' : 's'}` : ''}`;
  return `
    <button class="${cls.join(' ')}" data-act="open-day" data-date="${date}" aria-label="${esc(label)}">
      ${num}
      <span class="cal-sess">${sessions.map((s) => `<span class="cal-s${s.status === 'done' ? ' done' : ''}" style="--c:${KIND_COLOR[kindClass(s)]}"><i></i><span class="cal-lbl">${esc(sessionShort(s))}</span></span>`).join('')}</span>
      ${marker}${dn.length ? '<span class="cal-info" aria-hidden="true"></span>' : ''}
    </button>`;
}

function planMonthView() {
  const t = today();
  const end = horizonEnd();
  const [y, m] = PV.month.split('-').map(Number);
  const first = `${PV.month}-01`;
  const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = addDays(first, nDays - 1);
  const status = requestPlanRange(first, last);
  const lead = weekday(first);
  const cells = [];
  for (let k = 0; k < lead; k++) cells.push('<div class="cal-cell pad" aria-hidden="true"></div>');
  for (let k = 0; k < nDays; k++) cells.push(calCell(addDays(first, k), status));
  while (cells.length % 7) cells.push('<div class="cal-cell pad" aria-hidden="true"></div>');
  const canPrev = PV.month > t.slice(0, 7);
  const canNext = PV.month <= end.slice(0, 7);
  const legend = [['Strength', 'var(--strength)'], ['Easy', 'var(--easy)'], ['Quality', 'var(--quality)'], ['Long', 'var(--long)'], ['Ruck', 'var(--steady)'], ['Benchmark', 'var(--benchmark)'], ['Climb', 'var(--climb)']];
  let note = '';
  if (first > end) note = `<div class="notes">The plan isn't projected this far. It runs ${HORIZON_DAYS} days ahead, to ${esc(fmtDay(end))}.</div>`;
  else if (last > end) note = `<div class="small muted center">Plan projected to ${esc(fmtDay(end))}.</div>`;
  return `
    <div class="cal-nav">
      <button class="btn icon-btn" data-act="plan-month" data-delta="-1" aria-label="Previous month" ${canPrev ? '' : 'disabled'}>‹</button>
      <h2 class="cal-title" aria-live="polite">${MONTHS_FULL[m - 1]} ${y}</h2>
      <button class="btn icon-btn" data-act="plan-month" data-delta="1" aria-label="Next month" ${canNext ? '' : 'disabled'}>›</button>
      <button class="btn" data-act="plan-month" data-delta="0" ${PV.month === t.slice(0, 7) ? 'disabled' : ''}>Today</button>
    </div>
    ${status === 'loading' ? '<div class="loading" role="status">Loading the plan…</div>' : status === 'error' ? planErrorBlock() : ''}
    ${first > end ? note : ''}
    ${PV.month === t.slice(0, 7) ? `<div class="week-head"><div class="week-title"><strong>This week</strong> <span class="muted small">${esc(fmtShort(mondayOf(t)))} – ${esc(fmtShort(addDays(mondayOf(t), 6)))}</span></div>${runWeekBlock()}</div>` : ''}
    <div class="cal-grid" ${status === 'loading' ? 'aria-busy="true"' : ''}>
      ${DOW.map((d) => `<div class="cal-dow" aria-hidden="true">${d.slice(0, 2)}</div>`).join('')}
      ${cells.join('')}
    </div>
    ${first > end ? '' : note}
    <div class="cal-legend" aria-label="Legend">
      ${legend.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}
      <span><i class="sw mountain"></i>Mountain</span><span><i class="sw trip"></i>Trip</span><span><i class="sw note"></i>Open Comment</span>
    </div>`;
}

function renderPlan() {
  const el = $('#planMain');
  if (!el) return;
  if (!S.plan.days.length) { el.innerHTML = '<div class="empty">No plan loaded.</div>'; return; }
  if (!PV.month) PV.month = today().slice(0, 7);
  el.innerHTML = `
    <div class="plan-toolbar">
      <div class="seg" role="radiogroup" aria-label="Plan view">
        <button role="radio" aria-checked="${PV.mode === 'list'}" data-act="plan-view" data-view="list">List</button>
        <button role="radio" aria-checked="${PV.mode === 'month'}" data-act="plan-view" data-view="month">Month</button>
      </div>
    </div>
    ${notesPanel()}
    <div class="small muted projection">Future days are a projection: they shift as sessions are done, skipped or moved. Tap a day to see it in full or leave a Comment.</div>
    ${PV.mode === 'month' ? planMonthView() : planListView()}`;
  markSelected();
}

/** Highlight the day shown in the desktop day panel. */
function markSelected() {
  const sel = SH.host === 'panel' ? SH.date : null;
  for (const b of document.querySelectorAll('#planMain .cal-cell[data-date], #planMain .day-row[data-date]')) {
    const on = b.dataset.date === sel;
    b.classList.toggle('selected', on);
    if (on) b.setAttribute('aria-current', 'date'); else b.removeAttribute('aria-current');
  }
}

/* ═══════════════════════════ Day sheet ═══════════════════════════
 * One day in full, opened from the week strip, Plan list, calendar, notes and
 * Tomorrow preview. Bottom sheet on phones, centred dialog from 640px. On the
 * Plan section from 1100px it is a persistent side panel instead (SH.host).
 * Days other than today are read-only; today keeps its Done/Skip actions. */

const SH = { host: null, date: null, about: '', editId: null, clearForm: false, focusForm: false, returnFocus: null, returnSel: '' };
const DESKTOP_PLAN = window.matchMedia('(min-width: 1100px)');
const dayHostEl = () => (SH.host === 'panel' ? $('#dayPanel') : $('#sheetPanel'));

/** Use the side panel while the Plan section is on screen at desktop width; else the sheet. */
function syncDayHost() {
  const wantPanel = DESKTOP_PLAN.matches && NAV.current === 'plan';
  if (wantPanel && SH.host !== 'panel') {
    // Before the first load the plan's "today" is unknown: renderAll picks the date then.
    const date = SH.host === 'sheet' && SH.date ? SH.date : S.state ? PV.sel || today() : null;
    const wasSheet = SH.host === 'sheet';
    if (wasSheet) { $('#sheet').hidden = true; $('#sheetPanel').innerHTML = ''; if ($('#timer').hidden) document.body.style.overflow = ''; }
    Object.assign(SH, { host: 'panel', date, about: '', editId: null, clearForm: true, focusForm: false });
    if (S.state) renderSheet({ resetScroll: true });
    markSelected();
    // The sheet's own history entry has no meaning for the panel: go back over it, and
    // applyRoute then writes the panel's day into the base entry's URL.
    if (wasSheet && history.state && history.state.sheet) history.back();
  } else if (!wantPanel && SH.host === 'panel') {
    $('#dayPanel').innerHTML = '';
    Object.assign(SH, { host: null, date: null, editId: null });
    markSelected();
    const r = parseHash(location.hash);
    if (r && r.date) setRoute(routeHash(), { replace: true, sheet: false });
  }
}

function relDay(date) {
  const n = daysBetween(today(), date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

/** `fromRoute`: called while applying the URL, so the history entry already exists. */
function openSheet(date, { about = '', focusForm = false, fromRoute = false } = {}) {
  if (SH.host === 'panel') {
    Object.assign(SH, { date, about, editId: null, clearForm: true, focusForm });
    PV.sel = date;
    renderSheet({ resetScroll: true });
    markSelected();
    if (!fromRoute) setRoute(routeHash(NAV.current, date), { replace: true, sheet: false });
    return;
  }
  SH.host = 'sheet';
  const el = $('#sheet');
  // Opening pushes an entry (so Back closes the sheet); changing day while open replaces it.
  if (!fromRoute) setRoute(routeHash(NAV.current, date), el.hidden ? { sheet: true } : { replace: true });
  if (el.hidden) {
    const a = document.activeElement;
    SH.returnFocus = a && a !== document.body ? a : null;
    SH.returnSel = a && a.dataset && a.dataset.act ? `[data-act="${a.dataset.act}"][data-date="${a.dataset.date || ''}"]` : '';
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  SH.date = date;
  SH.about = about;
  SH.editId = null;
  SH.clearForm = true;
  SH.focusForm = focusForm;
  renderSheet({ resetScroll: true });
}

/** Close the sheet from the UI (close button, Escape, backdrop): go back over the entry that opened it. */
function dismissSheet() {
  if ($('#sheet').hidden || SH.host !== 'sheet') return;
  if (history.state && history.state.app && history.state.sheet) { history.back(); return; } // popstate closes it
  closeSheet();
  setRoute(routeHash(), { replace: true, sheet: false });
}

function closeSheet() {
  const el = $('#sheet');
  if (el.hidden || SH.host !== 'sheet') return;
  el.hidden = true;
  el.querySelector('#sheetPanel').innerHTML = '';
  SH.host = null;
  SH.date = null;
  SH.editId = null;
  if ($('#timer').hidden) document.body.style.overflow = '';
  // The opener may have been re-rendered while the sheet was open: find its replacement.
  let target = SH.returnFocus && SH.returnFocus.isConnected ? SH.returnFocus : null;
  if (!target && SH.returnSel) target = [...document.querySelectorAll(SH.returnSel)].find((x) => x.offsetParent !== null) || null;
  if (target) target.focus();
}

function sheetNotes(date) {
  const list = commentsOn(date);
  const opts = sessionOptions(date);
  const editing = SH.editId ? S.comments.find((c) => c.id === SH.editId) : null;
  const sel = editing ? (editing.session ? editing.session.key : '') : SH.about;
  if (editing && editing.session && !opts.some((o) => o.key === editing.session.key)) opts.push({ key: editing.session.key, label: aboutText(editing) });
  return `
    <section class="sheet-notes" aria-labelledby="sheetNotesTitle">
      <div class="section-title" id="sheetNotesTitle">Comments for Replan</div>
      ${!S.commentsOk ? '<div class="notes">Comments unavailable right now.</div>' : list.map((c) => `
        <div class="cm-item${isOpen(c) ? '' : ' addressed'}${editing && editing.id === c.id ? ' editing' : ''}">
          <div class="cm-meta"><span class="badge ${isOpen(c) ? 'note' : 'done'}">${isOpen(c) ? 'Open' : 'Addressed'}</span><span class="small muted">${esc(aboutText(c))}</span></div>
          <div class="cm-text">${esc(c.text)}</div>
          ${c.resolution ? `<div class="small muted cm-res"><strong>Resolution:</strong> ${esc(c.resolution)}</div>` : ''}
          <div class="btn-row cm-actions">
            <button class="btn small" data-act="note-edit" data-id="${esc(c.id)}" aria-label="Edit Comment: ${esc(c.text.slice(0, 40))}">Edit</button>
            <button class="btn small danger" data-act="note-del" data-id="${esc(c.id)}" aria-label="Delete Comment: ${esc(c.text.slice(0, 40))}">Delete</button>
          </div>
        </div>`).join('')}
      ${S.commentsOk ? `<form class="card note-form" id="noteForm" data-date="${date}" novalidate>
        <div class="form">
          <div class="small muted">${editing ? 'Editing a Comment.' : 'Anything the plan should take into account for this day. Comments are read at the next Replan.'}</div>
          <label class="field">About<select name="about" id="noteAbout">
            <option value="">Whole day</option>
            ${opts.map((o) => `<option value="${esc(o.key)}" ${o.key === sel ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select></label>
          <label class="field">Comment<textarea name="text" id="noteText" rows="3" maxlength="1000" required placeholder="e.g. Knee sore — keep this run flat. Read when the plan is next adjusted.">${editing ? esc(editing.text) : ''}</textarea></label>
          ${editing ? `<label class="field">Status<select name="status" id="noteStatus">
            <option value="open" ${isOpen(editing) ? 'selected' : ''}>Open</option>
            <option value="addressed" ${isOpen(editing) ? '' : 'selected'}>Addressed</option>
          </select></label>` : ''}
          <div class="btn-row">
            <button class="btn primary" type="submit">${editing ? 'Save changes' : 'Save Comment'}</button>
            ${editing ? '<button class="btn ghost" type="button" data-act="note-cancel">Cancel</button>' : ''}
          </div>
        </div>
      </form>` : ''}
    </section>`;
}

function renderSheet({ resetScroll = false } = {}) {
  const panel = dayHostEl();
  const isPanel = SH.host === 'panel';
  const date = SH.date;
  if (!date || !panel) return;
  // Keep what the user is typing (and focus) when a background load redraws the sheet.
  const oldBody = $('#sheetBody');
  const scroll = oldBody && !resetScroll ? oldBody.scrollTop : 0;
  const form = $('#noteForm');
  const draft = form && form.dataset.date === date && !SH.clearForm
    ? { about: form.elements.about.value, text: form.elements.text.value, status: form.elements.status ? form.elements.status.value : null } : null;
  SH.clearForm = false;
  const focusId = panel.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null;

  const t = today();
  const end = horizonEnd();
  const status = date >= t ? requestPlanRange(date, date) : 'ready';
  const day = PC.days[date];
  const readOnly = date !== t;
  let body = '';
  if (day && dayBadges(day)) body += `<div class="day-badges sheet-badges">${dayBadges(day)}</div>`;
  if (day) body += dayNotesLine(day);
  if (date < t) body += '<div class="notes">This day has passed. Past days are not shown in the plan.</div>';
  else if (date > end) body += `<div class="notes">The plan isn't projected this far (it runs to ${esc(fmtDay(end))}).</div>`;
  else if (status === 'loading') body += '<div class="loading" role="status">Loading this day…</div>';
  else if (status === 'error') body += planErrorBlock();
  else if (!day) body += '<div class="notes">No plan for this day.</div>';
  else {
    if (readOnly) body += '<div class="small muted projection">Preview: this day may still shift as the plan updates. Sessions are marked done from Today on the day.</div>';
    if (day.mountain) body += '<div class="notes"><strong>⛰ Mountain day.</strong> No runs or lifts. Log it with <code>/log</code> to the bot that evening.</div>';
    body += day.sessions.map((s, i) => sessionCard(day, s, i, { readOnly, idPrefix: 'sh-' })).join('');
    if (!day.sessions.length && !day.mountain) body += '<div class="notes">Rest day. Nothing planned.</div>';
  }
  body += sheetNotes(date);

  panel.innerHTML = `
    <div class="sheet-head">
      ${isPanel ? '' : '<span class="sheet-grab" aria-hidden="true"></span>'}
      <button class="btn icon-btn" id="sheetPrev" data-act="sheet-day" data-delta="-1" aria-label="Previous day" ${date <= t ? 'disabled' : ''}>‹</button>
      <div class="sheet-title"><h2 id="sheetTitle">${esc(fmtDay(date))}</h2><div class="small muted">${esc(relDay(date))}</div></div>
      <button class="btn icon-btn" id="sheetNext" data-act="sheet-day" data-delta="1" aria-label="Next day" ${date >= end ? 'disabled' : ''}>›</button>
      ${isPanel ? '' : '<button class="btn icon-btn" id="sheetClose" data-act="sheet-close" aria-label="Close day details">✕</button>'}
    </div>
    <div class="sheet-body" id="sheetBody">${body}</div>`;

  const nb = $('#sheetBody');
  const nf = $('#noteForm');
  if (draft && nf) {
    if ([...nf.elements.about.options].some((o) => o.value === draft.about)) nf.elements.about.value = draft.about;
    nf.elements.text.value = draft.text;
    if (draft.status && nf.elements.status) nf.elements.status.value = draft.status;
  }
  nb.scrollTop = scroll;
  if (SH.focusForm && nf) {
    SH.focusForm = false;
    nf.scrollIntoView({ block: 'nearest' });
    nf.elements.text.focus();
  } else if (focusId && document.getElementById(focusId) && !document.getElementById(focusId).disabled) {
    document.getElementById(focusId).focus({ preventScroll: true });
  } else if (!isPanel && !panel.contains(document.activeElement)) {
    panel.focus({ preventScroll: true });
  }
}

/** Keep Tab inside an open dialog (the day sheet or the timer). */
function trapSheetFocus(ev, panel = $('#sheetPanel')) {
  const f = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href]')]
    .filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (ev.shiftKey && (document.activeElement === first || document.activeElement === panel)) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

/* ═══════════════════════════ Lifts ═══════════════════════════ */

const plateStep = () => { const g = gymProfiles().find((p) => p.id === (S.state && S.state.defaultGymProfileId)); return (g && g.plateStepKg) || 2.5; };

/** Default Test Week dates: the next Saturday (today if Saturday) and the three days after, in lift order. */
function defaultTestDates() {
  const sat = addDays(today(), (5 - weekday(today()) + 7) % 7);
  return Object.fromEntries(LIFTS.map((l, i) => [l, addDays(sat, i)]));
}

/** More › Test Week: the lift whose result is being corrected inline (null: none). */
const TWE = { lift: null };

/** The inline correction of a tested lift's result: weight, reps, a live "→ Training Max" preview, Save / Cancel. */
function testEditRow(st, l) {
  const r = st.testWeek.results[l];
  return `<tr class="tw-edit"><td colspan="5"><div class="form" id="twEdit" data-lift="${l}">
      <div class="grid3" style="align-items:end">
        <label class="field">${LIFT_NAME[l]} kg<input type="number" inputmode="decimal" min="0" max="500" step="0.5" name="tw-w" value="${esc(r.weight)}" aria-label="${esc(LIFT_NAME[l])} corrected weight in kg"></label>
        <label class="field">Reps<input type="number" inputmode="numeric" min="1" max="15" step="1" name="tw-r" value="${esc(r.reps)}" aria-label="${esc(LIFT_NAME[l])} corrected reps"></label>
        <div class="small" aria-live="polite" id="twEditPrev">${esc(testEditPreview(st, l, r.weight, r.reps))}</div>
      </div>
      <div class="btn-row"><button type="button" class="btn primary" data-act="tw-save">Save</button><button type="button" class="btn" data-act="tw-cancel">Cancel</button></div>
      <div class="small muted">Replaces this result and its Training Max. It does not count as another test.</div>
    </div></td></tr>`;
}

const testEditPreview = (st, l, w, r) => (w > 0 && w <= 500 && Number.isInteger(r) && r >= 1 && r <= 15
  ? `→ Training Max ${fmtNum(testResultPreview(st, l, w, r, plateStep()).tm)} kg` : '→ Training Max —');

function updateTestEditPreview() {
  const box = $('#twEdit');
  if (!box || !S.state || !S.state.testWeek) return;
  const w = parseFloat(box.querySelector('[name="tw-w"]').value);
  const r = Number(box.querySelector('[name="tw-r"]').value);
  $('#twEditPrev').textContent = testEditPreview(S.state, box.dataset.lift, w, r);
}

async function onTestEditSave() {
  const box = $('#twEdit');
  const st = S.state;
  if (!box || !st || !st.testWeek) return;
  const lift = box.dataset.lift;
  const wEl = box.querySelector('[name="tw-w"]');
  const rEl = box.querySelector('[name="tw-r"]');
  const weight = parseFloat(wEl.value);
  const reps = Number(rEl.value);
  if (!(weight > 0 && weight <= 500)) { toast('Enter the top-set weight in kg (up to 500)', true); wEl.focus(); return; }
  if (!(Number.isInteger(reps) && reps >= 1 && reps <= 15)) { toast('Reps must be a whole number from 1 to 15', true); rEl.focus(); return; }
  const from = st.tms[lift];
  const to = testResultPreview(st, lift, weight, reps, plateStep()).tm;
  if (bigTmChange(from, to) && !confirm(`${LIFT_NAME[lift]} Training Max ${fmtNum(from)} → ${fmtNum(to)} kg is a change of more than 20%. Save?`)) return;
  const res = await mutate(() => api.action({ type: 'test-result', date: today(), lift, weight, reps, correct: true }), { okMsg: '' } /* the toast is the event */);
  if (res === null) return;
  TWE.lift = null;
  renderTestWeek();
  $(`[data-act="tw-edit"][data-lift="${lift}"]`)?.focus();
}

function testWeekSection(st) {
  const tw = st.testWeek;
  if (tw) {
    const results = tw.results || {};
    if (TWE.lift && !results[TWE.lift]) TWE.lift = null;
    return `
    <div class="section-title">Test Week · ${Object.keys(results).length}/4 tested</div>
    <div class="card"><table>
      <thead><tr><th>Lift</th><th>Date</th><th>Result</th><th>TM</th><th><span class="sr-only">Edit</span></th></tr></thead>
      <tbody>${LIFTS.map((l) => { const r = results[l]; return `<tr><td>${LIFT_NAME[l]}</td><td class="muted">${esc(fmtDay(tw.dates[l]))}</td>
        <td class="num">${r ? `${esc(r.weight)} kg × ${esc(r.reps)}` : '<span class="muted">to test</span>'}</td>
        <td class="num">${r ? `${esc(st.tms[l])} kg` : '—'}</td>
        <td>${r ? `<button type="button" class="btn" data-act="tw-edit" data-lift="${l}" aria-label="Edit the ${esc(LIFT_NAME[l])} result" aria-expanded="${String(TWE.lift === l)}">Edit</button>` : ''}</td></tr>${TWE.lift === l && r ? testEditRow(st, l) : ''}`; }).join('')}</tbody></table>
      <div class="small muted" style="padding:8px 0 4px">No regular lifts while the Test Week runs. A skipped test moves to the next day. Each result sets that lift's Training Max straight away; Cycle 1 starts once all four are in.</div>
    </div>`;
  }
  const d = defaultTestDates();
  return `
    <div class="section-title">Start a Test Week</div>
    <form class="card" id="testWeekForm" novalidate>
      <div class="form">
        <div class="small muted">One TM Test per lift (hard 5-rep max) in the AM Slot. Regular lifts pause until all four are logged.</div>
        <div class="grid2">${LIFTS.map((l) => `<label class="field">${LIFT_NAME[l]}<input type="date" name="tw-${l}" value="${esc(d[l])}" required></label>`).join('')}</div>
        <button class="btn primary" type="submit">Start test week</button>
      </div>
    </form>`;
}

const GROUP_NAME = { main: 'Main', fsl: 'FSL', finisher: 'Finisher' };

/** Logged Sets grouped by exercise, each read-only next to its Prescription. */
function loggedSetsHtml(sets) {
  const byEx = new Map();
  for (const x of sets) {
    const k = `${x.group}|${x.exercise}`;
    if (!byEx.has(k)) byEx.set(k, []);
    byEx.get(k).push(x);
  }
  const rx = (x) => {
    const reps = x.rxReps != null ? `× ${x.rxReps}${x.rxRepsMax ? `–${x.rxRepsMax}` : ''}${x.amrap ? '+' : ''}` : '';
    return [x.rxLoad != null ? `${fmtNum(x.rxLoad)} ${x.unit}` : '', reps].filter(Boolean).join(' ') || '—';
  };
  return [...byEx.values()].map((xs) => `
        <div class="set-ex"><div class="set-ex-head"><span class="ex-name">${esc(xs[0].exercise)}</span><span class="ex-dose muted">${esc(GROUP_NAME[xs[0].group] || '')}</span></div></div>
        ${xs.map((x) => `<div class="set-row static"><span class="set-n" aria-label="Set ${esc(x.n)}">${esc(x.n)}</span>
          <span class="set-rx"><span class="sr-only">Prescription: </span>${esc(rx(x))}</span>
          <span class="set-out">${x.skipped ? '<span class="muted small">Skipped</span>' : loggedHtml(x) || '<span class="muted small">not logged</span>'}</span></div>`).join('')}`).join('');
}

/** One logged Session: its sets grouped by exercise, Logged Set vs Prescription. */
function historySession(e, open) {
  const counts = { match: 0, above: 0, below: 0 };
  for (const x of e.sets) { const st = setStatus(x); if (st && !(x.amrap && st === 'above')) counts[st]++; }
  const tally = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${STATUS_TEXT[k][0]} ${n}`).join(' · ');
  return `
    <details class="fold hist"${open ? ' open' : ''}>
      <summary>${esc(fmtDay(e.date))}${e.week != null ? ` · ${esc(e.week === 'reentry' ? 'Re-entry' : `Wk ${e.week}`)}` : ''}${e.amrapReps != null ? ` · AMRAP ${esc(e.amrapReps)}` : ''}<span class="grow"></span><span class="muted" aria-label="${esc(Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${STATUS_TEXT[k][1]}`).join(', '))}">${esc(tally)}</span></summary>
      ${loggedSetsHtml(e.sets)}
    </details>`;
}

function recentSessions() {
  if (!S.liftLog || !S.liftLog.entries) return '<div class="card"><div class="empty">History unavailable.</div></div>';
  const withSets = S.liftLog.entries.filter((e) => Array.isArray(e.sets) && e.sets.length).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!withSets.length) return '<div class="card"><div class="empty">No sets logged yet. Log each set on a lift day, then tap Done.</div></div>';
  return LIFTS.map((l) => {
    const es = withSets.filter((e) => e.lift === l).slice(0, 5);
    return es.length ? `<div class="card hist-card"><div class="sub-title" style="margin-top:0">${esc(LIFT_NAME[l])}</div>${es.map((e, k) => historySession(e, k === 0)).join('')}</div>` : '';
  }).join('');
}

/** Heading row of a More sub-page, with a back button to the More list. */
const subHead = (id, title) => `
    <div class="sub-head">
      <button class="btn icon-btn" data-act="nav" data-to="more" data-from="${id}" aria-label="Back to More">‹</button>
      <h2 id="h-${id}" tabindex="-1">${esc(title)}</h2>
    </div>`;

function tmTiles(st) {
  return `<div class="tiles">${LIFTS.map((l) => `<div class="tile"><div class="lbl">${LIFT_NAME[l]}</div><div class="val">${esc(st.tms[l] || 0)} <small>kg</small></div></div>`).join('')}</div>`;
}

function cycleNotes(st) {
  const ph = st.lift.phase;
  const head = ph.kind === 'reentry' ? `${LIFT_NAME[LIFTS[ph.done]]} (Re-entry ${ph.done + 1}/4)` : `${LIFT_NAME[LIFTS[st.lift.index]]}, week ${st.lift.week} (${WEEK_LABEL[st.lift.week]})`;
  return `
    <div class="notes">
      Next lift: <strong>${esc(head)}</strong><br>
      Cycle week ${esc(st.lift.week)} · lift ${esc(st.lift.index + 1)}/4${ph.kind === 'reentry' ? ` · Re-entry Week (${ph.done}/4 done)` : ''}<br>
      Last lift: ${st.lastLiftDate ? esc(fmtDay(st.lastLiftDate)) : '—'}${st.lift.notBefore ? ` · waiting until ${esc(fmtDay(st.lift.notBefore))}` : ''}
    </div>`;
}

/** More › Test Week: start one, follow it, or enter TM Test results by hand. */
function renderTestWeek() {
  const st = S.state;
  if (!st) return;
  $('#tab-testweek').innerHTML = `
    ${subHead('testweek', 'Test Week')}
    ${testWeekSection(st)}

    <div class="section-title">Enter test results</div>
    <form class="card" id="testForm" novalidate>
      <div class="form">
        <div class="small muted">Hard 5-rep max per lift. TM = 90% of e1RM (weight × (1 + reps/30)), rounded down to ${plateStep()} kg. Leave a lift blank to keep its TM.</div>
        ${LIFTS.map((l) => `
          <div class="grid3" style="align-items:end">
            <label class="field">${LIFT_NAME[l]} kg<input type="number" inputmode="decimal" min="0" step="0.5" name="w-${l}"></label>
            <label class="field">Reps<input type="number" inputmode="numeric" min="1" max="15" step="1" name="r-${l}"></label>
            <div class="small" aria-live="polite">TM <strong id="tmprev-${l}">—</strong></div>
          </div>`).join('')}
        <button class="btn primary" type="submit">Save test results</button>
      </div>
    </form>`;
}

/** More › Training Max: the current Training Maxes and a by-hand edit. */
function renderTm() {
  const st = S.state;
  if (!st) return;
  $('#tab-tm').innerHTML = `
    ${subHead('tm', 'Training Max')}
    ${tmTiles(st)}
    <div class="section-title">Edit a Training Max</div>
    <form class="card" id="tmForm" novalidate>
      <div class="form grid2" style="align-items:end">
        <label class="field">Lift<select name="lift">${LIFTS.map((l) => `<option value="${l}">${LIFT_NAME[l]}</option>`).join('')}</select></label>
        <label class="field">TM kg<input type="number" inputmode="decimal" min="0" step="0.5" name="tm" value="${esc(st.tms.squat)}"></label>
        <button class="btn" type="submit" style="grid-column:1/-1">Set Training Max</button>
      </div>
    </form>
    <div class="small muted">Training Maxes normally rise only after a completed Cycle, or come from a Test Week.</div>`;
}

function amrapHistory() {
  const amraps = S.liftLog && S.liftLog.entries ? S.liftLog.entries.filter((e) => e.amrapReps != null).sort((a, b) => (a.date < b.date ? 1 : -1)) : null;
  return `<div class="card">${amraps === null ? '<div class="empty">History unavailable.</div>' : amraps.length ? `<table>
      <thead><tr><th>Date</th><th>Lift</th><th>Wk</th><th>Reps</th><th>FSL</th></tr></thead>
      <tbody>${amraps.map((e) => `<tr><td>${esc(fmtShort(e.date))}</td><td>${esc(LIFT_NAME[e.lift] || e.lift)}</td><td class="muted">${esc(e.week ?? '—')}</td><td class="num">${esc(e.amrapReps)}</td><td class="muted">${e.fslWeightKg != null ? esc(e.fslWeightKg) + ' kg' : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No AMRAP sets logged yet.</div>'}</div>`;
}

function updateTestPreview() {
  const f = $('#testForm');
  if (!f) return;
  for (const l of LIFTS) {
    const w = parseFloat(f.elements[`w-${l}`].value);
    const r = parseInt(f.elements[`r-${l}`].value, 10);
    $(`#tmprev-${l}`).textContent = w > 0 && r > 0 ? `${tmFromTest(w, r, plateStep())} kg` : '—';
  }
}

/* ═══════════════════════════ Running ═══════════════════════════ */

const ruckLoad = (step) => ({ packKg: Math.min(20, 10 + 2 * Math.ceil(step / 2)), vertM: Math.min(1200, 600 + 150 * Math.floor(step / 2)) });

/* ═══════════════════════════ Routes (self-contained renderers) ═══════════════════════════ */

const PROPOSED_RE = /^PROPOSED BENCHMARK\b[\s—–:.-]*(?:confirm in tracker\.?)?\s*/i;

/** One line for a Route: name (linked when it has an https url), ×N laps for a Repeat, km and ↑. */
function renderRouteLine(route) {
  if (!route) return '';
  const name = `<strong>${esc(route.name)}</strong>`;
  const link = typeof route.url === 'string' && /^https:\/\//i.test(route.url)
    ? `<a href="${esc(route.url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name;
  const laps = route.kind === 'repeat' && route.repeats ? ` · ×${esc(route.repeats)}` : '';
  return `<div class="small route-line" style="margin-top:4px">Route: ${link}${laps} · ${esc(route.km)} km · ${esc(route.vertM)} m ↑</div>`;
}

/** The Route library list. Delete is data-act="route-del"; a proposed Benchmark gets "Make this the Benchmark". */
function renderRouteLibrary(routes) {
  if (!routes || !routes.length) return '<div class="card"><div class="empty">No Routes yet. The Sunday routine adds them.</div></div>';
  return `<div class="card">${routes.map((r) => {
    const proposed = !r.benchmark && PROPOSED_RE.test(r.notes || '');
    return `<div class="ex route-row" style="padding:10px 14px">
      <div class="ex-body">
        ${renderRouteLine(r).replace('Route: ', '')}
        <div class="day-badges" style="margin-top:4px">
          ${r.benchmark ? `<span class="badge done">Benchmark: ${r.benchmark === 'hill' ? 'Hill loop' : '2.4 km'}</span>` : ''}
          ${proposed ? '<span class="badge">Proposed Benchmark</span>' : ''}
          ${(r.suits || []).map((k) => `<span class="badge">${esc(k)}</span>`).join('')}
        </div>
        <div class="small muted" style="margin-top:2px">${esc(r.area)}${r.notes && !proposed ? ` · ${esc(r.notes)}` : ''}</div>
      </div>
      <div class="btn-row" style="flex-wrap:nowrap">
        ${proposed ? `<button class="btn small good" data-act="route-benchmark" data-id="${esc(r.id)}">Make this the Benchmark</button>` : ''}
        <button class="btn danger small" data-act="route-del" data-id="${esc(r.id)}" aria-label="Delete Route ${esc(r.name)}">Delete</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/** A select to assign a library Route to an upcoming run. Benchmark runs with a Benchmark Route are fixed. */
function renderRoutePicker(date, runKind, routes, currentId) {
  const bm = { 'benchmark-hill': 'hill', 'benchmark-2k4': '2k4' }[runKind];
  if (bm && (routes || []).some((r) => r.benchmark === bm)) return '';
  const opts = (routes || []).filter((r) => r.id === currentId || (r.suits || []).includes(runKind));
  if (!opts.length && !currentId) return '';
  return `<label class="field route-pick" style="margin-top:6px">Route
    <select data-act="route-pick" data-date="${esc(date)}" data-kind="${esc(runKind)}" aria-label="Route for the ${esc(runKind)} run on ${esc(date)}">
      <option value="">No Route</option>
      ${opts.map((r) => `<option value="${esc(r.id)}" ${r.id === currentId ? 'selected' : ''}>${esc(r.name)} · ${esc(r.km)} km · ${esc(r.vertM)} m ↑</option>`).join('')}
    </select></label>`;
}

/** The Location input of the Trips form (`constraint` may be empty). */
function locationField(constraint) {
  const c = constraint || {};
  return `<label class="field">Location<input type="text" name="location" value="${esc(c.location || '')}" placeholder="Sunny Crag, Southland" maxlength="100" autocomplete="off"></label>`;
}

/** The "Make this the Benchmark" payload: the Route flagged hill, the proposal note stripped. */
function benchmarkRoute(r) {
  const out = { ...r, benchmark: 'hill' };
  if (!(out.suits || []).includes('benchmark-hill')) out.suits = [...(out.suits || []), 'benchmark-hill'];
  const notes = (r.notes || '').replace(PROPOSED_RE, '').trim();
  if (notes) out.notes = notes; else delete out.notes;
  return out;
}


/** More › Routes: the next 14 days' runs, each with its Route line and a picker, then the Route library. */
function renderRoutes() {
  const st = S.state;
  if (!st || !S.plan) return;
  const t = today();
  const upcomingRuns = [];
  for (const d of S.plan.days.slice(0, 14)) {
    d.sessions.forEach((s, i) => { if (s.kind === 'run') upcomingRuns.push({ d, s, det: detailFor(d.date, i) }); });
  }
  $('#tab-routes').innerHTML = `
    ${subHead('routes', 'Routes')}
    <div class="section-title">Planned runs</div>
    ${upcomingRuns.length ? upcomingRuns.map(({ d, s, det }) => `
      <div class="day-card"><div class="day-label"><div class="day-name">${DOW[weekday(d.date)]}</div><div class="day-num">${toDate(d.date).getUTCDate()}</div></div>
      <div class="day-body"><div class="sess-line"><span class="pill ${kindClass(s)}"><span class="dot"></span>${esc(sessionTitle(s, det))}</span>${s.status === 'done' ? '<span class="badge done">Done</span>' : ''}</div>
      <div class="sess-detail">${esc(sessionSummary(s, det))}${det && det.rx && det.rx.detail ? ` · ${esc(det.rx.detail)}` : ''}</div>
      ${det && det.route ? renderRouteLine(det.route) : ''}
      ${s.status === 'planned' && d.date >= t ? renderRoutePicker(d.date, s.run, S.routes || [], det && det.route ? det.route.id : null) : ''}</div></div>`).join('') : '<div class="empty">No runs in the next 14 days.</div>'}

    <div class="section-title">Route library</div>
    ${renderRouteLibrary(S.routes || [])}`;
}

/** Progress › Running: next Quality and Benchmark, Hill Ruck load and when one is due. */
function runningTiles() {
  const st = S.state;
  if (!st) return '';
  const t = today();
  const load = ruckLoad(st.ruck.step || 0);
  const ruckDueOn = st.ruck.lastCredit ? addDays(st.ruck.lastCredit, 21) : null;
  return `
    <div class="tiles">
      <div class="tile"><div class="lbl">Next Quality</div><div class="val" style="font-size:16px">${st.run.nextQuality === 'vert' ? 'Vert' : 'Speed'}</div></div>
      <div class="tile"><div class="lbl">Next Benchmark</div><div class="val" style="font-size:16px">${st.run.nextBenchmark === '2k4' ? '2.4 km' : 'Hill loop'}</div></div>
      <div class="tile"><div class="lbl">Ruck load</div><div class="val" style="font-size:16px">${load.packKg} kg · ${load.vertM} m</div></div>
      ${st.rucksEnabled ? `<div class="tile"><div class="lbl">Ruck due</div><div class="val" style="font-size:16px">${ruckDueOn ? (ruckDueOn <= t ? 'Now' : esc(fmtShort(ruckDueOn))) : 'Now'}</div></div>` : ''}
    </div>
    <div class="small muted" style="margin:6px 0 0">Last Hill Ruck credit: ${st.ruck.lastCredit ? esc(fmtDay(st.ruck.lastCredit)) : 'never'}.</div>`;
}

const SPORT_ICON = { run: '🏃', hike: '🥾', climb: '🧗', strength: '🏋️' };
const ACT_SOURCE = { intervals: 'intervals.icu', telegram: '/log' };
const round1 = (n) => Math.round(n * 10) / 10;

function recentActivities() {
  const syncRow = `<div class="ex" style="padding:10px 14px"><div class="ex-body"><div class="ex-cue">Watch Activities sync from intervals.icu every hour; /log hikes appear here too.</div></div>
    <button class="btn small" data-act="sync-now">Sync now</button></div>`;
  if (!S.activities) return `<div class="card"><div class="empty">Could not load Activities.</div>${syncRow}</div>`;
  const recent = (S.activities.entries || []).slice(0, 10);
  const row = (a) => {
    const parts = [a.km != null ? `${a.km} km` : '', a.vertM != null ? `${a.vertM} m ↑` : '', a.hours != null ? `${a.hours} h` : '', a.load != null ? `load ${a.load}` : ''].filter(Boolean);
    return `<div class="ex" style="padding:10px 14px"><div class="ex-body">
      <div class="ex-name">${SPORT_ICON[a.sport] || '•'} ${esc(fmtDay(a.date))} · ${esc(a.name)}</div>
      <div class="ex-cue">${esc(parts.join(' · '))}${parts.length ? ' · ' : ''}${esc(ACT_SOURCE[a.source] || a.source)}</div></div></div>`;
  };
  return `<div class="card">${recent.length ? recent.map(row).join('') : '<div class="empty">No Activities in the last 60 days.</div>'}${syncRow}</div>`;
}

/* ═══════════════════════════ Climbing ═══════════════════════════ */

function lastClimbNotes() {
  const st = S.state;
  if (!st) return '';
  const since = st.lastClimbDate ? daysBetween(st.lastClimbDate, today()) : null;
  return `<div class="notes">Last climb: <strong>${st.lastClimbDate ? esc(fmtDay(st.lastClimbDate)) : 'none logged'}</strong>${since != null ? ` (${since} day${since === 1 ? '' : 's'} ago)` : ''}.
      ${since != null && since >= 7 ? '<br>7+ days without a climb: a Boulder Fallback is placed unless a Club Event is within 2 days.' : ''}</div>`;
}

/** More › Club Events: the list and the add form. */
function renderEvents() {
  const st = S.state;
  if (!st) return;
  const t = today();
  const events = [...(st.clubEvents || [])].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  $('#tab-events').innerHTML = `
    ${subHead('events', 'Club Events')}
    <div class="card">${events.length ? events.map((e) => `
      <div class="ex" style="padding:10px 14px;${e.date < t ? 'opacity:.5' : ''}">
        <div class="ex-body"><div class="ex-name">${esc(fmtDay(e.date))} · ${esc(e.time)} · ${esc(e.venue)}</div>
          <div class="ex-cue">${esc(e.title)} · ${e.type === 'endurance_benchmark' ? 'Endurance Benchmark' : 'Partner Climb'}</div></div>
        <button class="btn danger small" data-act="del-event" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.title)} on ${esc(fmtDay(e.date))}">Delete</button>
      </div>`).join('') : '<div class="empty">No Club Events yet.</div>'}</div>

    <div class="section-title">Add a Club Event</div>
    <form class="card" id="eventForm" novalidate>
      <div class="form">
        <div class="grid2">
          <label class="field">Date<input type="date" name="date" required value="${esc(t)}"></label>
          <label class="field">Time<input type="time" name="time" required value="18:00"></label>
        </div>
        <label class="field">Venue<input type="text" name="venue" required placeholder="Wall A" autocomplete="off"></label>
        <label class="field">Title<input type="text" name="title" required placeholder="Friday climbing" autocomplete="off"></label>
        <label class="field">Type<select name="type"><option value="partner">Partner Climb</option><option value="endurance_benchmark">Endurance Benchmark</option></select></label>
        <button class="btn primary" type="submit">Add Club Event</button>
      </div>
    </form>`;
}

/* ═══════════════════════════ Mobility ═══════════════════════════ */

/** More › Daily Routine: the 30-day log, the routine reference, morning drills and monthly self-checks. */
function renderRoutine() {
  const c = S.content;
  const el = $('#tab-routine');
  if (!c) { el.innerHTML = `${subHead('routine', 'Daily Routine')}<div class="empty">Content unavailable.</div>`; return; }
  const t = today();
  const groups = [];
  (c.dailyRoutine || []).forEach((e, i) => {
    const g = e.group || 'Routine';
    let grp = groups.find((x) => x.name === g);
    if (!grp) groups.push((grp = { name: g, items: [] }));
    grp.items.push({ ...e, n: i + 1 });
  });
  const drillsDone = store(`drills:${t}`) || [];
  const month = t.slice(0, 7);
  const dots = Array.from({ length: 30 }, (_, k) => addDays(t, k - 29)).map((d) => {
    const s = mobilityStatus(d);
    return `<i class="${s || ''}${d === t ? ' today' : ''}" title="${esc(fmtDay(d))}: ${s || 'no entry'}"></i>`;
  }).join('');
  const st = mobilityStatus(t);
  el.innerHTML = `
    ${subHead('routine', 'Daily Routine')}
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn primary" data-act="timer-start">▶ Start follow-along</button>
    </div>
    <div class="section-title">30 days · streak ${esc(S.mobility.streak ?? 0)}</div>
    <div class="card">
      <div class="streak" aria-label="Daily Routine log, last 30 days">${dots}</div>
      <div class="actions btn-row">
        ${st === 'done' ? '<span class="badge done" style="align-self:center">Done today</span>' : `<button class="btn good" data-act="mobility" data-status="done" data-date="${t}">Mark today done</button>`}
        ${st ? '' : `<button class="btn" data-act="mobility" data-status="skipped" data-date="${t}">Skipped</button>`}
      </div>
    </div>

    <div class="section-title">Daily Routine</div>
    <div class="notes"><strong>Alignment rule</strong> (standing and kneeling items): ${esc(c.alignmentRule || '')}</div>
    ${groups.map((g) => `<div class="card"><div class="card-head"><strong class="small">${esc(g.name)}</strong></div><div class="card-body">
      ${g.items.map((e) => `<div class="ex"><span class="ex-num">${e.n}</span><div class="ex-body"><div class="ex-name">${esc(e.name)}</div>${e.cue ? `<div class="ex-cue">${esc(e.cue)}</div>` : ''}</div><span class="ex-dose">${esc(fmtDose(e.dose))}</span></div>`).join('')}
    </div></div>`).join('')}

    <div class="section-title">Optional morning drills</div>
    <div class="card"><div class="card-body" style="padding-top:8px">
      ${(c.morningDrills || []).map((e, i) => `<label class="ex ex-check"><input type="checkbox" id="drill-${i}" data-drill="${esc(e.name)}" aria-labelledby="drill-${i}-n" ${drillsDone.includes(e.name) ? 'checked' : ''}>
        <span class="ex-body"><span class="ex-name" id="drill-${i}-n">${esc(e.name)}</span></span><span class="ex-dose">${esc(fmtDose(e.dose))}</span></label>`).join('')}
      ${c.morningDrillsNote ? `<div class="small muted" style="padding-top:6px">${esc(c.morningDrillsNote)}</div>` : ''}
    </div></div>

    <div class="section-title">Monthly self-checks</div>
    <div class="card"><div class="card-body" style="padding-top:8px">
      ${(c.selfChecks || []).map((e, i) => {
        const last = S.selfChecks[e.name];
        const doneThisMonth = last && last.slice(0, 7) === month;
        return `<label class="ex ex-check"><input type="checkbox" id="sc-${i}" data-selfcheck="${esc(e.name)}" aria-labelledby="sc-${i}-n" aria-describedby="sc-${i}-d" ${doneThisMonth ? 'checked disabled' : ''}>
          <span class="ex-body"><span class="ex-name" id="sc-${i}-n">${esc(e.name)}</span><span class="ex-cue" id="sc-${i}-d">${esc(e.how)}${last ? ` · last ${esc(fmtShort(last))}` : ''}</span></span>
          <span class="ex-dose">${doneThisMonth ? 'Done this month' : ''}</span></label>`;
      }).join('')}
      ${S.selfChecksLocal ? '<div class="small muted" style="padding-top:6px">Saved on this device only.</div>' : ''}
    </div></div>`;
}

/* ═══════════════════════════ Trips (Constraints) ═══════════════════════════ */

let editingConstraint = null;

function renderTrips() {
  const st = S.state;
  if (!st) return;
  const list = [...(st.constraints || [])].sort((a, b) => (a.start < b.start ? -1 : 1));
  const c = editingConstraint || {};
  const tz = c.timezone || '';
  const tzIsCommon = !tz || COMMON_ZONES.includes(tz);
  const gp = c.gymProfileId === undefined ? '__keep' : c.gymProfileId === null ? '__none' : c.gymProfileId;
  $('#tab-trips').innerHTML = `
    ${subHead('trips', 'Trips')}
    <div class="section-title">Constraints</div>
    <div class="card">${list.length ? list.map((x) => `
      <div class="ex" style="padding:10px 14px">
        <div class="ex-body">
          <div class="ex-name">${esc(fmtShort(x.start))} – ${esc(fmtShort(x.end))}${x.note ? ` · ${esc(x.note)}` : ''}</div>
          <div class="day-badges" style="margin-top:4px">
            ${x.timezone ? `<span class="badge">${esc(x.timezone)}</span>` : ''}
            ${x.gymProfileId === null ? '<span class="badge">No Gym Profile</span>' : x.gymProfileId ? `<span class="badge">${esc((gymProfiles().find((g) => g.id === x.gymProfileId) || {}).name || x.gymProfileId)}</span>` : ''}
            ${x.location ? `<span class="badge">${esc(x.location)}</span>` : ''}
            ${x.noGym ? '<span class="badge">No gym</span>' : ''}${x.mountain ? '<span class="badge mountain">Mountain</span>' : ''}
          </div>
        </div>
        <div class="btn-row" style="flex-wrap:nowrap">
          <button class="btn small" data-act="edit-constraint" data-id="${esc(x.id)}" aria-label="Edit ${esc(x.note || x.start)}">Edit</button>
          <button class="btn danger small" data-act="del-constraint" data-id="${esc(x.id)}" aria-label="Delete ${esc(x.note || x.start)}">Delete</button>
        </div>
      </div>`).join('') : '<div class="empty">No Constraints.</div>'}</div>

    <div class="section-title">${editingConstraint ? 'Edit Constraint' : 'Add a Constraint'}</div>
    <form class="card" id="constraintForm" novalidate>
      <div class="form">
        <div class="grid2">
          <label class="field">Start<input type="date" name="start" required value="${esc(c.start || '')}"></label>
          <label class="field">End<input type="date" name="end" required value="${esc(c.end || '')}"></label>
        </div>
        <label class="field">Timezone<select name="tzSel">
          <option value="">Default (${esc(st.defaultTimezone)})</option>
          ${COMMON_ZONES.map((z) => `<option value="${z}" ${tz === z ? 'selected' : ''}>${z}</option>`).join('')}
          <option value="__other" ${tzIsCommon ? '' : 'selected'}>Other…</option>
        </select></label>
        <label class="field" ${tzIsCommon ? 'hidden' : ''} id="tzOtherWrap">Other timezone (IANA)<input type="text" name="tzOther" placeholder="America/Denver" value="${tzIsCommon ? '' : esc(tz)}" autocomplete="off"></label>
        <label class="field">Gym Profile<select name="gym">
          <option value="__keep" ${gp === '__keep' ? 'selected' : ''}>Unchanged</option>
          <option value="__none" ${gp === '__none' ? 'selected' : ''}>None</option>
          ${gymProfiles().map((g) => `<option value="${esc(g.id)}" ${gp === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select></label>
        <label class="check"><input type="checkbox" name="noGym" ${c.noGym ? 'checked' : ''}> No gym (lifts become Travel Strength)</label>
        <label class="check"><input type="checkbox" name="mountain" ${c.mountain ? 'checked' : ''}> Mountain days (no runs or lifts)</label>
        <label class="field">Travel days (departure/arrival)<select name="travelDays">
          <option value="" ${c.travelDays === undefined ? 'selected' : ''}>Auto</option>
          <option value="on" ${c.travelDays === true ? 'selected' : ''}>On</option>
          <option value="off" ${c.travelDays === false ? 'selected' : ''}>Off</option>
        </select></label>
        ${locationField(c)}
        <label class="field">Note<input type="text" name="note" value="${esc(c.note || '')}" placeholder="Crag trip" autocomplete="off"></label>
        <div class="btn-row">
          <button class="btn primary" type="submit">${editingConstraint ? 'Save changes' : 'Add Constraint'}</button>
          ${editingConstraint ? '<button class="btn ghost" type="button" data-act="cancel-constraint">Cancel</button>' : ''}
        </div>
      </div>
    </form>`;
}

/* ═══════════════════════════ Settings ═══════════════════════════ */

const REST_DEFAULT = { main: 180, fsl: 90, finisher: 60 };
const REST_FIELDS = [['main', 'Main sets'], ['fsl', 'FSL'], ['finisher', 'Finisher']];
const restSeconds = () => ({ ...REST_DEFAULT, ...((S.state && S.state.restSeconds) || {}) });

function renderSettings() {
  const st = S.state;
  if (!st) return;
  const tz = st.defaultTimezone;
  const slotSelect = (d, slot) => {
    const v = (st.defaultWeek[d] && st.defaultWeek[d][slot]) || '';
    return `<select name="dw-${d}-${slot}" aria-label="${DOW[d]} ${slot.toUpperCase()}">${SLOT_KINDS.map((k) => `<option value="${k}" ${k === v ? 'selected' : ''}>${k || '—'}</option>`).join('')}</select>`;
  };
  $('#tab-settings').innerHTML = `
    ${subHead('settings', 'Settings')}
    <form id="settingsForm" novalidate>
      <div class="section-title">Default Week</div>
      <div class="card"><table>
        <thead><tr><th>Day</th><th>AM</th><th>PM</th></tr></thead>
        <tbody>${DOW.map((n, d) => `<tr><td><strong>${n}</strong></td><td>${slotSelect(d, 'am')}</td><td>${slotSelect(d, 'pm')}</td></tr>`).join('')}</tbody>
      </table><div class="small muted" style="padding:8px 14px 12px">Climbs come from Club Events, so they are not set here.</div></div>

      <div class="section-title">Defaults</div>
      <div class="card"><div class="form">
        <label class="field">Default timezone<input type="text" name="defaultTimezone" list="tzList" value="${esc(tz)}" autocomplete="off"></label>
        <datalist id="tzList">${COMMON_ZONES.map((z) => `<option value="${z}">`).join('')}</datalist>
        <label class="field">Home location<input type="text" name="homeLocation" value="${esc(st.homeLocation || '')}" placeholder="Hometown" maxlength="100" autocomplete="off"></label>
        <label class="field">Default Gym Profile<select name="defaultGymProfileId">${gymProfiles().map((g) => `<option value="${esc(g.id)}" ${g.id === st.defaultGymProfileId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="rucksEnabled" ${st.rucksEnabled ? 'checked' : ''}> Plan Hill Rucks every ~3 weeks (off = trail long runs)</label>
      </div></div>

      <div class="section-title">Rest timer</div>
      <div class="card"><div class="form">
        <div class="small muted">Rest after each Logged Set in a Live Session, in seconds (15–900). Used by Live Sessions started after saving. When rest ends, Telegram sends the alert; the app stays silent.</div>
        <div class="grid3">${REST_FIELDS.map(([k, label]) => `<label class="field">${label}<input type="number" inputmode="numeric" min="15" max="900" step="1" name="rest-${k}" value="${esc(restSeconds()[k])}"></label>`).join('')}</div>
      </div></div>

      <div class="section-title">Gym Profiles</div>
      ${gymProfiles().map((g, gi) => `
        <fieldset class="card" style="border:1px solid var(--border)"><legend class="sr-only">${esc(g.name)}</legend><div class="form">
          <label class="field">Name<input type="text" name="gp-${gi}-name" value="${esc(g.name)}" autocomplete="off"></label>
          <div class="grid3">
            <label class="field">Plate step kg<input type="number" inputmode="decimal" min="0.5" step="0.25" name="gp-${gi}-plateStepKg" value="${esc(g.plateStepKg)}"></label>
            <label class="field">Machine step lb<input type="number" inputmode="numeric" min="1" step="1" name="gp-${gi}-machineStepLb" value="${esc(g.machineStepLb ?? '')}"></label>
            <label class="field">Machine max lb<input type="number" inputmode="numeric" min="1" step="1" name="gp-${gi}-machineMaxLb" value="${esc(g.machineMaxLb ?? '')}"></label>
          </div>
          <div class="small muted">Lifts done on a machine (lb):</div>
          <div class="btn-row" style="gap:12px">${LIFTS.map((l) => `<label class="check"><input type="checkbox" name="gp-${gi}-m-${l}" ${g.machineLifts.includes(l) ? 'checked' : ''}> ${LIFT_NAME[l]}</label>`).join('')}</div>
          <label class="check"><input type="checkbox" name="gp-${gi}-hasBands" ${g.hasBands ? 'checked' : ''}> Bands available</label>
          <div class="small muted">id: ${esc(g.id)}</div>
        </div></fieldset>`).join('')}
      <button class="btn primary" type="submit" style="width:100%">Save settings</button>
    </form>`;
}

/** More › Starting point: one-time history so the planner does not start from nothing. */
function renderStart() {
  const st = S.state;
  if (!st) return;
  $('#tab-start').innerHTML = `
    ${subHead('start', 'Starting point')}
    <form id="historyForm" novalidate>
      <div class="card"><div class="form">
        <div class="small muted">One-time history so the planner does not start from nothing. Leave a date empty to clear it.</div>
        <label class="field">Last climb<input type="date" name="lastClimbDate" value="${esc(st.lastClimbDate || '')}"></label>
        <label class="field">Last 600 m+ mountain day / Hill Ruck<input type="date" name="ruckLastCredit" value="${esc((st.ruck && st.ruck.lastCredit) || '')}"></label>
        <label class="field">Last lift session<input type="date" name="lastLiftDate" value="${esc(st.lastLiftDate || '')}"></label>
        <label class="field">Ruck load step<select name="ruckStep">${Array.from({ length: 21 }, (_, i) => { const l = ruckLoad(i); return `<option value="${i}" ${i === ((st.ruck && st.ruck.step) || 0) ? 'selected' : ''}>${i}: ${l.packKg} kg / ${l.vertM} m</option>`; }).join('')}</select></label>
      </div></div>
      <button class="btn primary" type="submit" style="width:100%">Save starting point</button>
    </form>`;
}

/* ═══════════════════════════ Progress ═══════════════════════════
 * One entry per section, rendered in order. A section's render returns HTML; a failing section shows an
 * error on its own. The charts come from GET /api/progress?weeks=12, fetched when Progress is shown and
 * kept until a mutation (PG). Charts are inline SVG built by charts.js at the column's pixel width. */

const PG = { data: null, bench: null, loading: false, error: null, gen: 0, width: 0, edit: null };
const PROGRESS_WEEKS = 12;
const TM_COLOR = { squat: 'var(--strength)', bench: 'var(--accent)', deadlift: 'var(--climb)', ohp: 'var(--benchmark)' };
const BENCH_NAME = { '2k4': '2.4 km', hill: 'Hill loop', autobelay: 'Auto-belay' };
const pgWidth = () => chartWidth(document.documentElement.clientWidth || window.innerWidth);
const pgHalf = (w) => (w >= 600 ? Math.floor((w - 12) / 2) : w);

function invalidateProgress() {
  PG.data = null; PG.bench = null; PG.error = null; PG.gen++;
}

/** Fetch the chart data once while Progress is showing; redraw Progress when it arrives. */
function ensureProgress() {
  if (PG.data || PG.loading || PG.error || NAV.current !== 'progress' || !S.state) return;
  PG.loading = true;
  const gen = PG.gen;
  Promise.all([api.progress(PROGRESS_WEEKS), api.benchmarkResults(365).catch(() => null)])
    .then(([p, b]) => { if (gen === PG.gen) { PG.data = p; PG.bench = b ? b.entries || [] : null; } },
      (e) => { if (gen === PG.gen) PG.error = e.message || 'Could not load the charts'; })
    .finally(() => {
      PG.loading = false;
      if (gen !== PG.gen) { ensureProgress(); return; } // invalidated meanwhile: fetch again
      try { renderProgress(); } catch (e) { console.error(e); }
    });
}

function progressPending() {
  if (PG.error) return `<div class="notes" role="alert">Could not load the charts: ${esc(PG.error)} <button class="btn small" data-act="progress-retry">Retry</button></div>`;
  return '<div class="chart-slot" aria-busy="true"><span class="small muted">Loading…</span></div>';
}

/** The charts' time window: the first Monday of the data to today. */
function pgRange() {
  const p = PG.data;
  const weeks = p.weeklyRuns && p.weeklyRuns.length ? p.weeklyRuns : p.adherence || [];
  return { start: weeks.length ? weeks[0].monday : addDays(mondayOf(today()), -7 * (PROGRESS_WEEKS - 1)), end: today() };
}

const chartEmpty = (text) => `<div class="chart-empty">${esc(text)}</div>`;

function tmHistorySection() {
  if (!PG.data) return progressPending();
  const hist = PG.data.tmHistory || [];
  const { start, end } = pgRange();
  const series = LIFTS.map((l) => ({ lift: l, name: LIFT_NAME[l], color: TM_COLOR[l], points: hist.filter((x) => x.lift === l).map((x) => ({ date: x.date, value: x.tm })) }));
  const svg = stepLineChart({ id: 'ch-tm', width: pgWidth(), start, end, series, title: `Training Max per lift, last ${PROGRESS_WEEKS} weeks` });
  if (!svg) return chartEmpty(`No Training Max changes in the last ${PROGRESS_WEEKS} weeks. They are recorded from now on: after each Cycle, Test Week or edit.`);
  const legend = series.map((s) => {
    const last = s.points.length ? s.points[s.points.length - 1].value : null;
    return `<span><i class="sw-line" style="--c:${s.color}"></i>${esc(s.name)} <strong>${last != null ? `${esc(fmtNum(last))} kg` : '—'}</strong></span>`;
  }).join('');
  const REASON = { cycle: 'Cycle', test: 'TM Test', manual: 'Edited' };
  const rows = [...hist].sort((a, b) => (a.date < b.date ? -1 : 1)).map((x) => [fmtDay(x.date), LIFT_NAME[x.lift] || x.lift, `${fmtNum(x.tm)} kg`, REASON[x.reason] || x.reason]);
  return `<figure class="chart-box">${svg}<figcaption class="ch-legend small">${legend}</figcaption></figure>
    ${dataTable('Training Max changes', ['Date', 'Lift', 'Training Max', 'Why'], rows)}`;
}

const benchResultText = (b) => (b.kind === 'autobelay'
  ? (b.grade ? `${b.grade} · ${b.minutes} min` : 'No result yet')
  : b.timeS != null ? `${fmtMmss(b.timeS)}${b.auto ? ' (from watch)' : ''}` : 'No result yet');

function benchmarksSection() {
  if (!PG.data) return progressPending();
  const res = PG.data.benchmarks || [];
  const { start, end } = pgRange();
  const w = pgWidth();
  const half = pgHalf(w);
  const pts = (kind) => res.filter((b) => b.kind === kind && b.timeS != null).map((b) => ({ date: b.date, value: b.timeS }));
  const timeChart = (kind, id) => {
    const p = pts(kind);
    const name = BENCH_NAME[kind];
    return `<figure class="chart-box"><figcaption class="ch-cap"><strong>${name}</strong> <span class="muted">time · lower is better</span></figcaption>
      ${p.length ? pointChart({ id, width: half, start, end, title: `${name} Benchmark time, lower is better`, color: 'var(--benchmark)', points: p, fmt: fmtTimeTick, steps: TIME_STEPS }) : chartEmpty(`No ${name} results yet.`)}</figure>`;
  };
  const ab = res.filter((b) => b.kind === 'autobelay' && b.minutes != null).map((b) => ({ date: b.date, value: b.minutes, grade: b.grade }));
  const abChart = `<figure class="chart-box"><figcaption class="ch-cap"><strong>Auto-belay</strong> <span class="muted">continuous minutes · labelled with the grade</span></figcaption>
    ${ab.length ? pointChart({ id: 'ch-ab', width: w, start, end, title: 'Auto-belay Benchmark: continuous minutes, labelled with the grade', color: 'var(--climb)', points: ab, labelOf: (p) => p.grade, fmt: (v) => `${fmtNum(v)}` }) : chartEmpty('No auto-belay results yet.')}</figure>`;
  const body = res.length
    ? `<div class="bench-charts">${timeChart('2k4', 'ch-2k4')}${timeChart('hill', 'ch-hill')}</div>${abChart}
      ${dataTable('Benchmark Results', ['Date', 'Benchmark', 'Result'], res.map((b) => [fmtDay(b.date), BENCH_NAME[b.kind] || b.kind, benchResultText(b)]))}`
    : chartEmpty('No Benchmark Results yet.');
  return body + benchWaiting();
}

/** Benchmark Sessions without a result ("Add result") or with one from the watch (Edit). */
function benchWaiting() {
  if (!PG.bench) return '';
  const list = PG.bench.filter((b) => (b.timeS == null && b.grade == null) || b.auto).slice(0, 8);
  if (!list.length) return '';
  return `<div class="sub-title">To add or check</div><div class="card bench-list">${list.map((b) => `
    <div class="bench-row">
      <div class="bench-what"><strong>${esc(BENCH_NAME[b.kind] || b.kind)}</strong> · ${esc(fmtDay(b.date))}
        <div class="small ${b.auto ? '' : 'muted'}">${esc(benchResultText(b))}</div></div>
      ${PG.edit === b.id ? '' : `<button class="btn small" data-act="bench-edit" data-id="${esc(b.id)}" aria-label="${b.auto ? 'Edit' : 'Add'} the ${esc(BENCH_NAME[b.kind] || b.kind)} result of ${esc(fmtDay(b.date))}">${b.auto ? 'Edit' : 'Add result'}</button>`}
    </div>
    ${PG.edit === b.id ? benchForm(b) : ''}`).join('')}</div>`;
}

function benchForm(b) {
  const fields = b.kind === 'autobelay'
    ? `<div class="grid2"><label class="field">Grade<select name="grade" required>${gradeOptions(b.grade || '')}</select></label>
       <label class="field">Minutes<input type="number" name="minutes" inputmode="numeric" min="1" max="240" step="1" value="${esc(b.minutes ?? '')}" required></label></div>`
    : `<label class="field">Time (mm:ss)<input type="text" name="time" inputmode="decimal" autocomplete="off" maxlength="8" placeholder="${b.kind === '2k4' ? '10:42' : '25:30'}" value="${b.timeS != null ? esc(fmtMmss(b.timeS)) : ''}" required></label>`;
  return `<form class="form bench-form" id="benchForm" data-id="${esc(b.id)}" data-kind="${esc(b.kind)}" novalidate>
    ${fields}
    <div class="btn-row"><button class="btn primary" type="submit">Save result</button><button class="btn ghost" type="button" data-act="bench-cancel">Cancel</button></div>
  </form>`;
}

function weeklyRunsSection() {
  if (!PG.data) return progressPending();
  const weeks = PG.data.weeklyRuns || [];
  const half = pgHalf(pgWidth());
  const km = weeklyBarChart({ id: 'ch-km', width: half, title: 'Weekly run and hike km against the target', color: 'var(--easy)', unit: 'km', weeks: weeks.map((x) => ({ monday: x.monday, value: x.km, target: x.targetKm, deload: x.deload })) });
  const vert = weeklyBarChart({ id: 'ch-vert', width: half, title: 'Weekly metres climbed against the target', color: 'var(--long)', unit: 'm', weeks: weeks.map((x) => ({ monday: x.monday, value: x.vertM, target: x.targetVertM, deload: x.deload })) });
  if (!km && !vert) {
    const start = S.state && S.state.run && S.state.run.runStartMonday;
    return chartEmpty(weeks.length && start ? `No run weeks yet: running starts ${fmtDay(start)}.` : 'No run weeks yet.');
  }
  const legend = `<div class="ch-legend small"><span><i class="sw" style="--c:var(--easy)"></i>km</span><span><i class="sw" style="--c:var(--long)"></i>m ↑</span>
    <span><i class="sw-target"></i>Target</span><span><i class="sw-deload"></i>Deload week</span><span><i class="sw-empty"></i>Before runs started</span></div>`;
  const rows = weeks.map((x) => [fmtShort(x.monday), fmtNum(x.km), x.targetKm == null ? '—' : fmtNum(x.targetKm), String(Math.round(x.vertM)), x.targetVertM == null ? '—' : String(x.targetVertM),
    x.targetKm == null ? 'Before runs started' : x.deload ? 'Deload' : '']);
  return `<div class="bench-charts">
      <figure class="chart-box"><figcaption class="ch-cap"><strong>km</strong> <span class="muted">runs + hikes per week</span></figcaption>${km}</figure>
      <figure class="chart-box"><figcaption class="ch-cap"><strong>m ↑</strong> <span class="muted">metres climbed per week</span></figcaption>${vert}</figure>
    </div>${legend}
    ${dataTable('Weekly run km and metres climbed against the target', ['Week of', 'km', 'Target km', 'm ↑', 'Target m', ''], rows)}`;
}

function adherenceSection() {
  if (!PG.data) return progressPending();
  const weeks = PG.data.adherence || [];
  const html = adherenceRows({ weeks });
  if (!html) return chartEmpty('Nothing was expected in these weeks yet.');
  const rows = weeks.map((w) => {
    const missed = Math.max(0, w.expected - w.done - w.skipped);
    return [fmtShort(w.monday), String(w.done), String(w.skipped), String(missed), String(w.expected), w.expected ? `${Math.round((w.done / w.expected) * 100)}%` : '—'];
  });
  return `<div class="small muted" style="margin:-4px 0 8px">Sessions done each week against what the Default Week and Club Events expected. Tap a week for lifts, runs and climbs.</div>
    ${html}${dataTable('Adherence per week', ['Week of', 'Done', 'Skipped', 'Missed', 'Expected', 'Done %'], rows)}`;
}

const PROGRESS_SECTIONS = [
  { id: 'tms', title: 'Training Maxes', render: () => (S.state ? tmTiles(S.state) + cycleNotes(S.state) : '') },
  { id: 'tm-history', title: 'Training Max history', render: tmHistorySection },
  { id: 'lift-sessions', title: 'Recent sessions', render: () => `<div class="small muted" style="margin:-4px 0 8px">Each set: Prescription, then the Logged Set. ✓ Met · ↑ Over · ↓ Under · @ RPE.</div>${recentSessions()}` },
  { id: 'amrap', title: 'AMRAP history', render: amrapHistory },
  { id: 'running', title: 'Running', render: runningTiles },
  { id: 'run-weekly', title: 'Weekly run km and vert vs target', render: weeklyRunsSection },
  { id: 'benchmarks', title: 'Benchmark Results', render: benchmarksSection },
  { id: 'activities', title: 'Recent Activities', render: recentActivities },
  { id: 'climbing', title: 'Climbing', render: lastClimbNotes },
  { id: 'adherence', title: 'Adherence', render: adherenceSection },
];

function renderProgress() {
  ensureProgress();
  PG.width = pgWidth();
  // Keep what is being typed in the Benchmark Result form across a redraw.
  const bf = $('#benchForm');
  const keep = bf ? { id: bf.dataset.id, vals: [...bf.elements].filter((x) => x.name).map((x) => [x.name, x.value]), focus: document.activeElement && bf.contains(document.activeElement) ? document.activeElement.name : null } : null;
  $('#tab-progress').innerHTML = '<h2 class="sr-only" id="h-progress" tabindex="-1">Progress</h2>' + PROGRESS_SECTIONS.map((sec) => {
    let body;
    try { body = sec.render(); } catch (e) { console.error('progress', sec.id, e); body = '<div class="empty">Could not show this section.</div>'; }
    return `<section class="prog-sec" id="prog-${sec.id}" aria-labelledby="progh-${sec.id}">
      <h2 class="section-title" id="progh-${sec.id}">${esc(sec.title)}</h2>${body}</section>`;
  }).join('');
  const nf = $('#benchForm');
  if (keep && nf && nf.dataset.id === keep.id) {
    for (const [n, v] of keep.vals) if (nf.elements[n]) nf.elements[n].value = v;
    if (keep.focus && nf.elements[keep.focus]) nf.elements[keep.focus].focus({ preventScroll: true });
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (NAV.current === 'progress' && PG.data && pgWidth() !== PG.width) renderProgress(); }, 150);
});

/* ═══════════════════════════ More ═══════════════════════════ */

const SUBPAGES = [
  { id: 'trips', title: 'Trips', desc: 'Constraints: travel, no gym, mountain days' },
  { id: 'events', title: 'Club Events', desc: 'Climbing-club sessions that set the climb days' },
  { id: 'testweek', title: 'Test Week', desc: 'Start a Test Week or enter TM Test results' },
  { id: 'tm', title: 'Training Max', desc: 'See and edit the Training Maxes' },
  { id: 'routes', title: 'Routes', desc: 'Route library and a Route for each planned run' },
  { id: 'routine', title: 'Daily Routine', desc: 'Reference, morning drills, monthly self-checks' },
  { id: 'settings', title: 'Settings', desc: 'Default Week, timezone, Gym Profiles' },
  { id: 'start', title: 'Starting point', desc: 'Last climb, lift and Hill Ruck dates' },
];

function renderMore() {
  $('#tab-more').innerHTML = `
    <h2 class="section-title" id="h-more" tabindex="-1">More</h2>
    <div class="card more-list">${SUBPAGES.map((p) => `
      <button class="more-item" data-act="nav" data-to="${p.id}">
        <span class="more-text"><span class="more-title">${esc(p.title)}</span><span class="small muted">${esc(p.desc)}</span></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>`).join('')}</div>`;
}

/* ═══════════════════════════ render all ═══════════════════════════ */

function renderAll() {
  renderHeader();
  renderLiveBar();
  for (const fn of [renderToday, renderPlan, renderProgress, renderMore, renderTrips, renderEvents, renderTestWeek, renderTm, renderRoutes, renderRoutine, renderSettings, renderStart]) {
    try { fn(); } catch (e) { console.error(fn.name, e); }
  }
  if (SH.host === 'panel' && !SH.date) { SH.date = PV.sel || today(); markSelected(); }
  if (SH.date) { try { renderSheet(); } catch (e) { console.error('renderSheet', e); } }
}

/* ═══════════════════════════ navigation ═══════════════════════════
 * Four sections (bottom bar on phones, left rail from 900px); More holds sub-pages.
 * The last place shown is remembered; tab names saved by older versions map onto it. */

const SECTIONS = ['today', 'plan', 'progress', 'more'];
const OLD_TABS = { upcoming: 'plan', lifts: 'progress', running: 'progress', climbing: 'progress', mobility: 'routine' };
const NAV = { current: 'today', depth: 0, hash: '', seen: '' };
const sectionOf = (name) => (SECTIONS.includes(name) ? name : 'more');

/** Show a section or More sub-page. `focus`: move focus to the new screen;
 * `from`: the sub-page we came back from, to refocus its More entry instead. */
function showTab(name, { focus = false, from = '' } = {}) {
  name = OLD_TABS[name] || name;
  if (!SECTIONS.includes(name) && !SUBPAGES.some((p) => p.id === name)) name = 'today';
  const changed = NAV.current !== name;
  NAV.current = name;
  const sec = sectionOf(name);
  document.querySelectorAll('.nav-btn').forEach((b) => {
    if (b.dataset.to === sec) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  document.body.dataset.section = sec;
  document.body.classList.toggle('wide-tab', name === 'plan');
  store('tab', name);
  syncDayHost();
  if (name === 'progress') ensureProgress();
  if (changed) window.scrollTo(0, 0);
  if (focus) {
    // Sub-pages focus their heading; sections focus their landmark (tabindex=-1 in index.html).
    const target = (from && $(`#tab-more [data-to="${CSS.escape(from)}"]`)) || $(`#h-${CSS.escape(name)}`) || $(`#tab-${CSS.escape(name)}`);
    if (target) target.focus({ preventScroll: true });
  }
}

/* ═══════════════════════════ routing ═══════════════════════════
 * The URL hash mirrors the screen so the phone's Back button moves between screens:
 * #today, #plan, #progress, #more, #more/<sub-page>, plus /<date> while a day is open
 * (#plan/2026-11-02). Navigating pushes an entry; the desktop day panel only replaces.
 * history.state = { app, depth, sheet }: depth > 0 means the previous entry is ours;
 * sheet marks the entry pushed by opening the day sheet. */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isKnownTab = (n) => SECTIONS.includes(n) || SUBPAGES.some((p) => p.id === n);

function routeHash(name = NAV.current, date = null) {
  return `#${SECTIONS.includes(name) ? name : `more/${name}`}${date ? `/${date}` : ''}`;
}

/** '#more/trips/2026-11-02' -> { name: 'trips', date: '2026-11-02' }; null if not a known screen. */
function parseHash(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const date = parts.length && ISO_RE.test(parts[parts.length - 1]) ? parts.pop() : null;
  let name = null;
  if (parts.length === 1) name = OLD_TABS[parts[0]] || parts[0];
  else if (parts.length === 2 && parts[0] === 'more' && !SECTIONS.includes(parts[1])) name = parts[1];
  return name && isKnownTab(name) ? { name, date } : null;
}

/** A real ISO date inside the loaded plan horizon. */
function validRouteDate(d) {
  if (!d || !ISO_RE.test(d) || !S.state) return false;
  const t = toDate(d);
  return !Number.isNaN(t.getTime()) && toIso(t) === d && d >= today() && d <= horizonEnd();
}

/** Push (or replace) the history entry for `hash`. `sheet` defaults to false on push, unchanged on replace. */
function setRoute(hash, { replace = false, sheet } = {}) {
  const cur = history.state && history.state.app ? history.state : { depth: NAV.depth, sheet: false, prev: '' };
  if (!replace && location.hash === hash) return;
  const st = {
    app: true,
    depth: replace ? cur.depth : cur.depth + 1,
    sheet: sheet === undefined ? (replace && !!cur.sheet) : sheet,
    prev: replace ? cur.prev || '' : location.hash, // the hash of the entry below this one
  };
  NAV.depth = st.depth;
  if (replace) history.replaceState(st, '', hash); else history.pushState(st, '', hash);
  NAV.hash = location.hash;
}

/** Render whatever the current hash names (Back/Forward, or a hand-edited URL). */
function applyRoute() {
  const prevHash = NAV.hash;
  NAV.seen = location.hash;
  NAV.hash = location.hash;
  // Back while the timer is open closes it and leaves the screen underneath alone.
  if (!$('#timer').hidden && !(history.state && history.state.timer)) {
    timerClose();
    if (history.state && history.state.app) NAV.depth = history.state.depth;
    return;
  }
  const fresh = !history.state || !history.state.app; // a hash typed or linked, not one of our entries
  const r = parseHash(location.hash);
  const date = r && validRouteDate(r.date) ? r.date : null;
  // Canonical form: old tab names mapped, invalid dates dropped; unknown screens stay where we are.
  const canon = r ? routeHash(r.name, date) : routeHash(NAV.current, SH.host === 'sheet' ? SH.date : null);
  if (fresh && canon === prevHash) {
    // The browser added an entry that names the screen already showing: step back over it so
    // Back never has a dead step.
    NAV.hash = prevHash;
    history.back();
    return;
  }
  if (fresh) history.replaceState({ app: true, depth: NAV.depth + 1, sheet: false, prev: prevHash }, '', canon);
  else if (location.hash !== canon) history.replaceState(history.state, '', canon);
  NAV.hash = location.hash;
  NAV.depth = history.state.depth;
  if (!r) return;
  const prev = NAV.current;
  if (r.name !== prev) {
    if (SH.host === 'sheet') closeSheet();
    const from = r.name === 'more' && !SECTIONS.includes(prev) ? prev : '';
    showTab(r.name, { focus: true, from });
  }
  if (date) { if (SH.date !== date) openSheet(date, { fromRoute: true }); }
  else if (SH.host === 'sheet') closeSheet();
  syncPanelHash();
}

/** The desktop panel always shows a day: keep the URL naming it (replace, never push). */
function syncPanelHash() {
  if (SH.host !== 'panel' || !SH.date) return;
  const h = routeHash('plan', SH.date);
  if (location.hash !== h) setRoute(h, { replace: true, sheet: false });
}
window.addEventListener('popstate', applyRoute);
// popstate covers Back/Forward and typed hashes; hashchange only matters if one slipped past it.
window.addEventListener('hashchange', () => { if (location.hash !== NAV.hash && location.hash !== NAV.seen) applyRoute(); });

/** A sub-page's own Back button: step back when the entry below is the More list, else go to More. */
function backToMore(from) {
  const st = history.state;
  if (st && st.app && st.depth > 0 && st.prev === '#more') { history.back(); return; }
  setRoute('#more', { replace: true, sheet: false });
  showTab('more', { focus: true, from });
}

DESKTOP_PLAN.addEventListener('change', () => { syncDayHost(); try { renderPlan(); } catch (e) { console.error(e); } });

/* ═══════════════════════════ mobility timer ═══════════════════════════
 * Steps through the Daily Routine. HOLD = 45 s per side (a short prep
 * countdown before each hold doubles as the side-switch prompt). REPS = a
 * card with the dose and a Next button. Keeps the screen on via Wake Lock. */

const PREP_S = 5;
const T = { returnFocus: null, steps: [], i: 0, phase: 'idle', endsAt: 0, remainingMs: 0, paused: false, tick: null, wake: null, audio: null, sound: store('timerSound') !== false };

function buildSteps(routine) {
  const steps = [];
  routine.forEach((item, idx) => {
    const d = item.dose;
    if (d && typeof d === 'object' && d.type === 'hold') {
      const positions = d.positions && d.positions.length ? d.positions : [null];
      const times = d.times || 1;
      const sides = d.perSide ? ['Left side', 'Right side'] : [null];
      positions.forEach((pos, pi) => {
        for (let t = 0; t < times; t++) {
          for (const side of sides) {
            const label = [pos ? `(${String.fromCharCode(97 + pi)}) ${pos}` : null, side, times > 1 ? `hold ${t + 1} of ${times}` : null].filter(Boolean).join(' · ');
            steps.push({ type: 'hold', idx, item, label, seconds: d.seconds || 45 });
          }
        }
      });
    } else {
      steps.push({ type: 'reps', idx, item, text: d && typeof d === 'object' ? repsText(d) : String(d || '') });
    }
  });
  return steps;
}

function beep(freq = 660, ms = 160) {
  if (!T.sound || !T.audio) return;
  try {
    const o = T.audio.createOscillator();
    const g = T.audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, T.audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, T.audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, T.audio.currentTime + ms / 1000);
    o.connect(g).connect(T.audio.destination);
    o.start();
    o.stop(T.audio.currentTime + ms / 1000 + 0.02);
  } catch { /* audio is optional */ }
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !T.wake) {
      T.wake = await navigator.wakeLock.request('screen');
      T.wake.addEventListener('release', () => { T.wake = null; renderTimer(); });
    }
  } catch { T.wake = null; }
  renderTimer();
}

function timerOpen() {
  const routine = (S.content && S.content.dailyRoutine) || [];
  if (!routine.length) { toast('Daily Routine content unavailable', true); return; }
  T.steps = buildSteps(routine);
  T.i = 0;
  T.paused = false;
  if (!T.audio) { try { T.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { T.audio = null; } }
  const a = document.activeElement;
  T.returnFocus = a && a !== document.body ? a : null;
  $('#timer').hidden = false;
  document.body.style.overflow = 'hidden';
  // Same URL, own entry: the phone's Back closes the timer (see applyRoute).
  const cur = history.state && history.state.app ? history.state : { depth: NAV.depth };
  history.pushState({ app: true, depth: cur.depth + 1, sheet: false, timer: true, prev: location.hash }, '', location.hash);
  NAV.depth = cur.depth + 1;
  enterStep();
  focusTimer();
  acquireWakeLock();
  clearInterval(T.tick);
  T.tick = setInterval(timerTick, 200);
}

/** Put focus inside the timer dialog: its main control, else the dialog itself. */
function focusTimer() {
  const el = $('#timer');
  const btn = el.querySelector('[data-act="timer-toggle"], [data-act="timer-next"], [data-act="timer-done"]');
  (btn || el).focus({ preventScroll: true });
}

/** Close the timer from the UI (close, Done, Escape) and drop the entry it pushed. */
function dismissTimer() {
  timerClose();
  if (history.state && history.state.app && history.state.timer) history.back();
}

function timerClose() {
  clearInterval(T.tick);
  T.tick = null;
  T.phase = 'idle';
  $('#timer').hidden = true;
  $('#timer').innerHTML = '';
  if (SH.host !== 'sheet') document.body.style.overflow = '';
  if (T.wake) { T.wake.release().catch(() => {}); T.wake = null; }
  // The opener may have been re-rendered meanwhile (e.g. Done reloads the Routine page).
  let target = T.returnFocus && T.returnFocus.isConnected ? T.returnFocus : null;
  if (!target) target = [...document.querySelectorAll('[data-act="timer-start"]')].find((x) => x.offsetParent !== null) || null;
  T.returnFocus = null;
  if (target) target.focus({ preventScroll: true });
}

function enterStep() {
  const step = T.steps[T.i];
  if (!step) { T.phase = 'finished'; beep(880, 400); renderTimer(); return; }
  if (step.type === 'hold') { T.phase = 'prep'; T.endsAt = Date.now() + PREP_S * 1000; }
  else T.phase = 'reps';
  T.paused = false;
  renderTimer();
}

function timerTick() {
  if (T.paused || (T.phase !== 'prep' && T.phase !== 'hold')) return;
  if (Date.now() < T.endsAt) { updateClock(); return; }
  if (T.phase === 'prep') {
    T.phase = 'hold';
    T.endsAt = Date.now() + T.steps[T.i].seconds * 1000;
    beep(880, 120);
    renderTimer();
  } else {
    beep(520, 260); // soft cue at each switch / end of hold
    T.i++;
    enterStep();
  }
}

function updateClock() {
  const c = $('#timerClock');
  if (c) c.textContent = String(Math.max(0, Math.ceil((T.endsAt - Date.now()) / 1000)));
}

function timerToggle() {
  if (T.phase !== 'prep' && T.phase !== 'hold') return;
  if (T.paused) { T.endsAt = Date.now() + T.remainingMs; T.paused = false; }
  else { T.remainingMs = T.endsAt - Date.now(); T.paused = true; }
  renderTimer();
}

function timerGo(delta) {
  T.i = Math.min(T.steps.length, Math.max(0, T.i + delta));
  enterStep();
}

function renderTimer() {
  const el = $('#timer');
  if (el.hidden) return;
  // innerHTML is replaced below: keep focus on the same control (or the dialog) across steps.
  const hadFocus = el.contains(document.activeElement);
  const focusAct = hadFocus && document.activeElement.dataset ? document.activeElement.dataset.act : '';
  const total = T.steps.length;
  const step = T.steps[T.i];
  const align = S.content && S.content.alignmentRule;
  let main = '';
  if (T.phase === 'finished') {
    main = `<div class="timer-name" id="timerName">Routine complete</div>
      <div class="timer-cue">Nice. Log it so the streak counts.</div>
      <button class="btn good" data-act="timer-done" style="min-width:200px;min-height:52px">Mark today done</button>`;
  } else if (step) {
    const it = step.item;
    const prev = T.steps[T.i - 1];
    const switching = step.type === 'hold' && prev && prev.idx === step.idx;
    const showAlign = align && it.group && /standing|kneeling/i.test(it.group);
    main = `<div class="timer-group">${esc(it.group || '')} · item ${step.idx + 1} of ${(S.content.dailyRoutine || []).length}</div>
      <div class="timer-name" id="timerName">${esc(it.name)}</div>
      ${step.type === 'hold' ? `<div class="timer-sub">${esc(step.label || 'Hold')}</div>
        <div class="timer-clock${T.phase === 'prep' ? ' prep' : ''}" id="timerClock" aria-live="off">${Math.max(0, Math.ceil(((T.paused ? T.remainingMs : T.endsAt - Date.now())) / 1000))}</div>
        <div class="timer-sub" style="color:var(--muted)">${T.phase === 'prep' ? (switching ? 'Switch → get into position' : 'Get ready') : 'Hold'}${T.paused ? ' · paused' : ''}</div>`
      : `<div class="timer-reps">${esc(step.text)}</div>`}
      ${it.cue ? `<div class="timer-cue">${esc(it.cue)}</div>` : ''}
      ${showAlign ? `<div class="timer-align">${esc(align)}</div>` : ''}`;
  }
  const isReps = step && T.phase === 'reps';
  el.innerHTML = `
    <div class="timer-top">
      <span class="small muted">${T.phase === 'finished' ? `All ${total} steps` : `Step ${T.i + 1} / ${total}`}${T.wake ? ' · screen stays on' : ''}</span>
      <div class="btn-row" style="flex-wrap:nowrap">
        <label class="check small"><input type="checkbox" data-act="timer-sound" ${T.sound ? 'checked' : ''}> Beep</label>
        <button class="btn small ghost" data-act="timer-close" aria-label="Close timer">Close</button>
      </div>
    </div>
    <div class="timer-progress" aria-hidden="true"><i style="width:${total ? (Math.min(T.i, total) / total) * 100 : 0}%"></i></div>
    <div class="timer-main">${main}</div>
    ${T.phase === 'finished' ? '' : `<div class="timer-controls">
      <button class="btn" data-act="timer-prev" ${T.i === 0 ? 'disabled' : ''}>Back</button>
      ${isReps ? '<button class="btn primary" data-act="timer-next">Next</button>' : `<button class="btn primary" data-act="timer-toggle">${T.paused ? 'Resume' : 'Pause'}</button>`}
      <button class="btn" data-act="timer-skip-item">Skip item</button>
    </div>`}`;
  if (hadFocus) {
    const same = focusAct && el.querySelector(`[data-act="${focusAct}"]:not([disabled])`);
    if (same) same.focus({ preventScroll: true }); else focusTimer();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#timer').hidden) acquireWakeLock();
});

/* ═══════════════════════════ events ═══════════════════════════ */

function findSession(date, i) {
  const day = S.plan.days.find((d) => d.date === date);
  return day ? day.sessions[i] : null;
}

/** The confirm() text for Done / Skip / Tomorrow: a Skip is not undoable and moves the lift queue on. */
function sessionConfirmText(s, type) {
  const name = s.kind === 'lift' ? `${LIFT_NAME[s.lift]} ${WEEK_LABEL[s.week]}` : sessionTitle(s);
  if (type === 'done') return `Mark ${name} done?`;
  if (type === 'tomorrow') return `Move ${name} to tomorrow?`;
  return s.kind === 'lift' ? `Skip ${name}? This moves the lift queue on.` : `Skip ${name}?`;
}

async function onSessionAction(btn) {
  const { type, date } = btn.dataset;
  const i = Number(btn.dataset.i);
  const s = findSession(date, i);
  if (!s) return;
  const card = btn.closest('.card'); // the same day can be on screen twice (Today tab + sheet)
  if (type === 'test-result') {
    const wEl = card.querySelector('[data-test-w]');
    const rEl = card.querySelector('[data-test-r]');
    const weight = parseFloat(wEl && wEl.value);
    const reps = Number(rEl && rEl.value);
    if (!(weight > 0 && weight <= 500)) { toast('Enter the top-set weight in kg (up to 500)', true); wEl && wEl.focus(); return; }
    if (!(Number.isInteger(reps) && reps >= 1 && reps <= 15)) { toast('Reps must be a whole number from 1 to 15', true); rEl && rEl.focus(); return; }
    if (!confirm(testResultConfirmText(S.state, s.lift, LIFT_NAME[s.lift], weight, reps, plateStep()))) return;
    btn.closest('.actions').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const res = await mutate(() => api.action({ type: 'test-result', date, lift: s.lift, weight, reps }), { okMsg: '' } /* the toast is the event: "Squat 110 × 5 → Training Max 115 kg (1 of 4 tested)" */);
    if (res === null) { try { await loadCore(); renderAll(); } catch (e) { /* offline: keep the toast */ } }
    return;
  }
  const action = { type, date, ref: toRef(s) };
  if (type === 'done') {
    const b = readBenchmark(card);
    if (b.error) { toast(b.error, true); b.el.focus(); return; }
    if (b.benchmark) action.benchmark = b.benchmark;
  }
  if (type === 'done' && s.kind === 'lift') {
    const { sets, error, el } = collectSets(card, date, i);
    if (error) { toast(error, true); el.focus(); return; }
    const amrap = sets.find((x) => x.group === 'main' && x.amrap && x.reps != null);
    if (amrap) {
      if (amrap.reps > 30) { toast('AMRAP reps must be a whole number from 0 to 30', true); return; }
      action.amrapReps = amrap.reps;
    }
    if (sets.length) action.sets = sets;
  }
  // Done has no prompt of its own (the AMRAP reps and Benchmark Result are inline inputs), so all three confirm.
  if (!confirm(sessionConfirmText(s, type))) return;
  btn.closest('.actions').querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const out = await mutate(async () => {
    const res = await api.action(action);
    if (type === 'done' && s.kind === 'lift') store(draftKey(date, s.lift), null);
    if (action.sets || action.amrapReps != null) {
      S.liftLog = await api.liftLog().catch(() => S.liftLog);
    }
    return res;
  }, { okMsg: type === 'done' ? (action.benchmark ? `Done · Benchmark Result ${action.benchmark.timeS ? fmtMmss(action.benchmark.timeS) : `${action.benchmark.grade}, ${action.benchmark.minutes} min`} saved` : 'Done') : type === 'skip' ? 'Skipped' : 'Moved to tomorrow' });
  // e.g. 409 already handled elsewhere: the error toast is up; refresh so stale buttons go away
  if (out === null) { try { await loadCore(); renderAll(); } catch (e) { /* offline: keep the toast */ } }
}

document.addEventListener('click', async (ev) => {
  if (ev.target.id === 'sheet') { dismissSheet(); return; } // backdrop
  // A Live Session set row opened or closed by hand stays that way across redraws.
  const lvSum = ev.target.closest('details[data-lv-step] > summary');
  if (lvSum && S.live) {
    const row = lvSum.parentElement;
    const prefix = row.closest('#sheetPanel, #dayPanel') ? 'sh-' : '';
    LV.open[`${S.live.id}:${prefix}${row.dataset.lvStep}`] = !row.open;
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'nav': {
      if (el.dataset.from) { backToMore(el.dataset.from); break; }
      const to = el.dataset.to;
      if (to === NAV.current) break;
      setRoute(routeHash(to));
      showTab(to, { focus: true });
      syncPanelHash();
      break;
    }
    case 'open-day': openSheet(el.dataset.date); break;
    case 'sheet-close': dismissSheet(); break;
    case 'sheet-day':
      SH.date = addDays(SH.date, Number(el.dataset.delta));
      SH.editId = null; SH.about = ''; SH.clearForm = true;
      if (SH.host === 'panel') { PV.sel = SH.date; markSelected(); }
      setRoute(routeHash(NAV.current, SH.date), { replace: true });
      renderSheet({ resetScroll: true });
      break;
    case 'note-add':
      if (SH.date === el.dataset.date) {
        SH.editId = null; SH.about = el.dataset.key || ''; SH.clearForm = true; SH.focusForm = true;
        renderSheet();
      } else openSheet(el.dataset.date, { about: el.dataset.key || '', focusForm: true });
      break;
    case 'note-edit':
      SH.editId = el.dataset.id; SH.clearForm = true; SH.focusForm = true;
      renderSheet();
      break;
    case 'note-cancel': SH.editId = null; SH.about = ''; SH.clearForm = true; renderSheet(); break;
    case 'note-del':
      if (confirm('Delete this Comment?')) {
        await mutate(async () => {
          const r = await api.deleteComment(el.dataset.id);
          if (SH.editId === el.dataset.id) { SH.editId = null; SH.clearForm = true; }
          return r;
        }, { reload: 'comments', okMsg: 'Comment deleted' });
      }
      break;
    case 'plan-view':
      PV.mode = el.dataset.view === 'month' ? 'month' : 'list';
      store('planView', PV.mode);
      renderPlan();
      $(`[data-act="plan-view"][data-view="${PV.mode}"]`)?.focus();
      break;
    case 'plan-month': {
      const d = Number(el.dataset.delta);
      if (d === 0) PV.month = today().slice(0, 7);
      else {
        const [y, m] = PV.month.split('-').map(Number);
        PV.month = toIso(new Date(Date.UTC(y, m - 1 + d, 1))).slice(0, 7);
      }
      renderPlan();
      const again = $(`[data-act="plan-month"][data-delta="${d}"]`);
      if (again && !again.disabled) again.focus();
      break;
    }
    case 'plan-more': PV.listDays = HORIZON_DAYS; renderPlan(); break;
    case 'plan-retry': PC.error = null; renderPlan(); if (SH.date) renderSheet(); break;
    case 'session': onSessionAction(el); break;
    case 'live-start': onLiveStart(el); break;
    case 'live-resume-dismiss': LV.resume = null; renderLive(); break;
    case 'lv-log': onLiveLog(el, 'log'); break;
    case 'lv-top': onLiveLog(el, 'top'); break;
    case 'lv-skip': onLiveLog(el, 'skip'); break;
    case 'lv-rpe': onLiveRpe(el); break;
    case 'live-finish': case 'live-abandon': case 'live-cancel': case 'live-pause': case 'live-resume': case 'live-warmup': case 'live-rest30':
      onLiveAction(act, el); break;
    case 'live-jump': onLiveJump(); break;
    case 'tw-edit': {
      TWE.lift = TWE.lift === el.dataset.lift ? null : el.dataset.lift;
      renderTestWeek();
      if (TWE.lift) $('#twEdit [name="tw-w"]')?.focus();
      else $(`[data-act="tw-edit"][data-lift="${el.dataset.lift}"]`)?.focus();
      break;
    }
    case 'tw-cancel': {
      const lift = TWE.lift;
      TWE.lift = null;
      renderTestWeek();
      $(`[data-act="tw-edit"][data-lift="${lift}"]`)?.focus();
      break;
    }
    case 'tw-save': onTestEditSave(); break;
    case 'live-summary-close': {
      LV.summary = null;
      renderToday();
      $('#h-today')?.focus();
      break;
    }
    case 'progress-retry': PG.error = null; renderProgress(); break;
    case 'bench-edit': PG.edit = Number(el.dataset.id); renderProgress(); $('#benchForm')?.elements[0]?.focus(); break;
    case 'bench-cancel': {
      const id = PG.edit;
      PG.edit = null;
      renderProgress();
      $(`[data-act="bench-edit"][data-id="${id}"]`)?.focus();
      break;
    }
    case 'set-rx': onSetRx(el); break;
    case 'set-rpe': onSetRpe(el); break;
    case 'mobility':
      await mutate(() => api.markMobility(el.dataset.date, el.dataset.status), { reload: 'mobility', okMsg: el.dataset.status === 'done' ? 'Daily Routine done' : 'Daily Routine skipped' });
      break;
    case 'sync-now': {
      el.disabled = true;
      const r = await mutate(async () => {
        const res = await api.sync();
        S.activities = await api.activities(60).catch(() => S.activities);
        return res;
      });
      if (!r) { el.disabled = false; break; }
      toast(r.skipped === 'off' ? 'Sync is off: no intervals.icu API key is set'
        : r.synced ? `Synced ${r.synced} new ${r.synced === 1 ? 'Activity' : 'Activities'}` : 'Up to date: nothing new');
      break;
    }
    case 'del-event':
      if (confirm('Delete this Club Event?')) await mutate(() => api.deleteClubEvent(el.dataset.id), { okMsg: 'Club Event deleted' });
      break;
    case 'edit-constraint':
      editingConstraint = (S.state.constraints || []).find((c) => c.id === el.dataset.id) || null;
      renderTrips();
      $('#constraintForm')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
      break;
    case 'cancel-constraint': editingConstraint = null; renderTrips(); break;
    case 'del-constraint':
      if (confirm('Delete this Constraint?')) {
        if (editingConstraint && editingConstraint.id === el.dataset.id) editingConstraint = null;
        await mutate(() => api.deleteConstraint(el.dataset.id), { okMsg: 'Constraint deleted' });
      }
      break;
    case 'route-del': {
      const r = (S.routes || []).find((x) => x.id === el.dataset.id);
      if (confirm(`Delete the Route "${r ? r.name : el.dataset.id}"? Its assignments go too.`)) await mutate(() => api.deleteRoute(el.dataset.id), { okMsg: 'Route deleted' });
      break;
    }
    case 'route-benchmark': {
      const r = (S.routes || []).find((x) => x.id === el.dataset.id);
      if (r) await mutate(() => api.saveRoute(benchmarkRoute(r)), { okMsg: 'Hill Benchmark set' });
      break;
    }
    case 'timer-start': timerOpen(); break;
    case 'timer-close': dismissTimer(); break;
    case 'timer-toggle': timerToggle(); break;
    case 'timer-next': timerGo(1); break;
    case 'timer-prev': timerGo(-1); break;
    case 'timer-skip-item': {
      const cur = T.steps[T.i];
      let j = T.i + 1;
      while (cur && j < T.steps.length && T.steps[j].idx === cur.idx) j++;
      timerGo(j - T.i);
      break;
    }
    case 'timer-sound': T.sound = el.checked; store('timerSound', T.sound); break;
    case 'timer-done':
      dismissTimer();
      await mutate(() => api.markMobility(today(), 'done'), { reload: 'mobility', okMsg: 'Daily Routine done' });
      break;
    default: break;
  }
});

document.addEventListener('keydown', (ev) => {
  // Enter in a Live Session set's Weight or Reps logs that set.
  if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-lv-load], [data-lv-reps]')) {
    ev.preventDefault();
    ev.target.closest('[data-lv-step]')?.querySelector('[data-act="lv-log"]')?.click();
    return;
  }
  if (!$('#timer').hidden) {
    if (ev.key === 'Escape') dismissTimer();
    else if (ev.key === 'Tab') trapSheetFocus(ev, $('#timer'));
    return;
  }
  if (!$('#sheet').hidden) {
    if (ev.key === 'Escape') { ev.preventDefault(); dismissSheet(); }
    else if (ev.key === 'Tab') trapSheetFocus(ev);
  }
});

document.addEventListener('toggle', (ev) => {
  if (ev.target.id === 'notesPanel') store('notesPanel', ev.target.open);
}, true);

document.addEventListener('input', (ev) => {
  if (ev.target.closest('#testForm')) updateTestPreview();
  if (ev.target.closest('#twEdit')) updateTestEditPreview();
  if (ev.target.matches('[data-set-load], [data-set-reps]')) onSetInput(ev.target.closest('.set-row'));
  if (ev.target.matches('[data-lv-load], [data-lv-reps]')) onLiveInput(ev.target.closest('[data-lv-step]'));
});

// Polling runs only while the page is visible; coming back picks up what Telegram did meanwhile
// (including a Live Session started there).
document.addEventListener('visibilitychange', () => {
  syncLiveTimers();
  if (document.visibilityState === 'visible' && S.state) pollLive();
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.act === 'route-pick') {
    await mutate(() => api.assignRoute(t.dataset.date, t.dataset.kind, t.value || null), { okMsg: t.value ? 'Route assigned' : 'Route cleared' });
    return;
  }
  if (t.name === 'tzSel') { const w = $('#tzOtherWrap'); if (w) w.hidden = t.value !== '__other'; return; }
  if (t.dataset.drill) {
    const key = `drills:${today()}`;
    const set = new Set(store(key) || []);
    if (t.checked) set.add(t.dataset.drill); else set.delete(t.dataset.drill);
    store(key, [...set]);
    return;
  }
  if (t.dataset.selfcheck && t.checked) {
    const name = t.dataset.selfcheck;
    if (S.selfChecksLocal) {
      S.selfChecks = { ...S.selfChecks, [name]: today() };
      store('selfChecks', S.selfChecks);
      renderRoutine();
    } else {
      await mutate(async () => { S.selfChecks = await api.markSelfCheck(name, today()); }, { reload: 'none', okMsg: `${name} ticked` });
    }
  }
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target;
  ev.preventDefault();
  const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : '');
  if (f.id === 'testForm') {
    const results = {};
    for (const l of LIFTS) {
      const w = parseFloat(v(`w-${l}`)); const r = parseInt(v(`r-${l}`), 10);
      if (v(`w-${l}`) === '' && v(`r-${l}`) === '') continue;
      if (!(w > 0 && r >= 1 && r <= 15)) { toast(`${LIFT_NAME[l]}: enter both weight and reps (1–15)`, true); return; }
      results[l] = { weight: w, reps: r };
    }
    if (!Object.keys(results).length) { toast('Enter at least one lift', true); return; }
    const summary = Object.entries(results).map(([l, r]) => `${LIFT_NAME[l]} ${tmFromTest(r.weight, r.reps, plateStep())}`).join(', ');
    if (!confirm(`Set Training Maxes: ${summary} kg, and restart the Cycle at week 1?`)) return;
    await mutate(() => api.action({ type: 'test-results', date: today(), results, plateStepKg: plateStep() }), { okMsg: 'Training Maxes set' });
  } else if (f.id === 'testWeekForm') {
    const dates = {};
    for (const l of LIFTS) {
      dates[l] = v(`tw-${l}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dates[l])) { toast(`${LIFT_NAME[l]}: pick a date`, true); return; }
    }
    await mutate(() => api.action({ type: 'start-test-week', dates }), { okMsg: 'Test Week started' });
  } else if (f.id === 'tmForm') {
    const tm = parseFloat(v('tm'));
    if (!(tm > 0)) { toast('Enter a Training Max in kg', true); return; }
    await mutate(() => api.action({ type: 'set-tm', lift: v('lift'), tm }), { okMsg: 'Training Max saved' });
  } else if (f.id === 'eventForm') {
    const e = { id: newId('ev'), date: v('date'), time: v('time'), venue: v('venue'), title: v('title'), type: v('type') };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !/^\d{2}:\d{2}$/.test(e.time) || !e.venue || !e.title) { toast('Fill in date, time, venue and title', true); return; }
    await mutate(() => api.saveClubEvent(e), { okMsg: 'Club Event added' });
  } else if (f.id === 'constraintForm') {
    const c = { id: editingConstraint ? editingConstraint.id : newId('c'), start: v('start'), end: v('end') };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start) || !/^\d{4}-\d{2}-\d{2}$/.test(c.end)) { toast('Enter a start and end date', true); return; }
    if (c.end < c.start) { toast('End must be on or after start', true); return; }
    const tzSel = v('tzSel');
    const tz = tzSel === '__other' ? v('tzOther') : tzSel;
    if (tz) c.timezone = tz;
    const gym = v('gym');
    if (gym === '__none') c.gymProfileId = null; else if (gym !== '__keep') c.gymProfileId = gym;
    if (f.elements.noGym.checked) c.noGym = true;
    if (f.elements.mountain.checked) c.mountain = true;
    if (v('travelDays') === 'on') c.travelDays = true; else if (v('travelDays') === 'off') c.travelDays = false;
    if (v('location')) c.location = v('location');
    if (v('note')) c.note = v('note');
    const wasEditing = !!editingConstraint;
    editingConstraint = null;
    await mutate(() => api.saveConstraint(c), { okMsg: wasEditing ? 'Constraint updated' : 'Constraint added' });
  } else if (f.id === 'noteForm') {
    const text = f.elements.text.value.trim();
    if (!text) { toast('Write the Comment first', true); f.elements.text.focus(); return; }
    if (text.length > 1000) { toast('Keep Comments under 1000 characters', true); return; }
    const date = f.dataset.date;
    const existing = SH.editId ? S.comments.find((c) => c.id === SH.editId) : null;
    // POST replaces the whole comment: send every field, changing only what was edited.
    const c = existing ? { ...existing, text } : { id: newId('cm'), date, text, status: 'open' };
    delete c.createdAt; delete c.updatedAt;
    const key = v('about');
    if (key) {
      const o = sessionOptions(date).find((x) => x.key === key) || (existing && existing.session && existing.session.key === key ? existing.session : null);
      c.session = { key, label: ((o && o.label) || key).slice(0, 80) };
    } else delete c.session;
    if (existing && f.elements.status) c.status = v('status') === 'addressed' ? 'addressed' : 'open';
    f.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const res = await mutate(async () => {
      const r = await api.saveComment(c);
      SH.editId = null; SH.about = ''; SH.clearForm = true;
      return r;
    }, { reload: 'comments', okMsg: existing ? 'Comment updated' : 'Comment saved for the next Replan' });
    if (res === null) f.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  } else if (f.id === 'historyForm') {
    const d = (n) => v(n) || null;
    await mutate(() => api.action({ type: 'set-history', lastClimbDate: d('lastClimbDate'), ruckLastCredit: d('ruckLastCredit'), lastLiftDate: d('lastLiftDate'), ruckStep: parseInt(v('ruckStep'), 10) || 0 }), { okMsg: 'Starting point saved' });
  } else if (f.id === 'settingsForm') {
    const defaultWeek = {};
    for (let d = 0; d < 7; d++) {
      defaultWeek[d] = {};
      for (const slot of ['am', 'pm']) { const k = v(`dw-${d}-${slot}`); if (k) defaultWeek[d][slot] = k; }
    }
    const profiles = gymProfiles().map((g, gi) => {
      const num = (n) => { const x = parseFloat(v(`gp-${gi}-${n}`)); return Number.isFinite(x) && x > 0 ? x : undefined; };
      const p = { id: g.id, name: v(`gp-${gi}-name`) || g.name, plateStepKg: num('plateStepKg') || g.plateStepKg,
        machineLifts: LIFTS.filter((l) => f.elements[`gp-${gi}-m-${l}`].checked), hasBands: f.elements[`gp-${gi}-hasBands`].checked };
      const ms = num('machineStepLb'); const mm = num('machineMaxLb');
      if (ms !== undefined) p.machineStepLb = ms;
      if (mm !== undefined) p.machineMaxLb = mm;
      return p;
    });
    const defaultTimezone = v('defaultTimezone');
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(defaultTimezone) && defaultTimezone !== 'UTC') { toast('Timezone must be an IANA name, e.g. Europe/Berlin', true); return; }
    const rest = {};
    for (const [k, label] of REST_FIELDS) {
      const n = Number(v(`rest-${k}`));
      if (!(Number.isInteger(n) && n >= 15 && n <= 900)) { toast(`${label} rest must be a whole number of seconds from 15 to 900`, true); f.elements[`rest-${k}`].focus(); return; }
      rest[k] = n;
    }
    await mutate(() => api.settings({ defaultWeek, defaultTimezone, defaultGymProfileId: v('defaultGymProfileId'), gymProfiles: profiles, rucksEnabled: f.elements.rucksEnabled.checked, restSeconds: rest, ...(v('homeLocation') ? { homeLocation: v('homeLocation') } : {}) }), { okMsg: 'Settings saved' });
  } else if (f.id === 'benchForm') {
    const id = Number(f.dataset.id);
    let body;
    if (f.dataset.kind === 'autobelay') {
      const minutes = Number(v('minutes'));
      if (!v('grade')) { toast('Pick the grade climbed', true); f.elements.grade.focus(); return; }
      if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 240)) { toast('Minutes must be a whole number from 1 to 240', true); f.elements.minutes.focus(); return; }
      body = { id, grade: v('grade'), minutes };
    } else {
      const timeS = parseMmss(v('time'));
      if (timeS === null || timeS < 60 || timeS > 14400) { toast('Enter the time as mm:ss, e.g. 10:42 (1 min to 4 h)', true); f.elements.time.focus(); return; }
      body = { id, timeS };
    }
    f.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const res = await mutate(async () => { const r = await api.saveBenchmarkResult(body); PG.edit = null; return r; }, { reload: 'none', okMsg: 'Benchmark Result saved' });
    if (res === null) f.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
});

/* ═══════════════════════════ boot ═══════════════════════════ */

/** Error banner with a Retry button, shown under the header when the backend can't be used. */
function showErrorBanner(message) {
  let b = $('#errorBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'errorBanner';
    b.className = 'mock-banner';
    b.setAttribute('role', 'alert');
    b.style.cssText = 'align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.35);color:inherit';
    $('#mockBanner').after(b);
  }
  b.innerHTML = `<span>${esc(message)}</span><button type="button" class="btn">Retry</button>`;
  b.querySelector('button').onclick = () => { b.style.display = 'none'; boot(); };
  b.style.display = 'flex';
}

async function boot() {
  // The URL wins over the remembered section; an unknown hash falls back to it, then Today.
  const route = parseHash(location.hash);
  showTab(route ? route.name : store('tab') || 'today');
  NAV.depth = 0;
  history.replaceState({ app: true, depth: 0, sheet: false, prev: '' }, '', routeHash());
  NAV.hash = location.hash;
  try {
    const isMock = await initApi();
    $('#mockBanner').hidden = !isMock;
    await loadAll();
    renderAll();
    syncPanelHash();
    // A day in the URL opens over the base entry, so Back closes it (the desktop panel just shows it).
    if (route && validRouteDate(route.date)) openSheet(route.date);
  } catch (e) {
    console.error(e);
    showErrorBanner(e.status === 403 ? 'Not signed in — reload to log in via Cloudflare Access.' : e.message);
    $('#tab-today').innerHTML = `<div class="empty">Could not load the plan: ${esc(e.message)}</div>`;
  }
}
boot();
