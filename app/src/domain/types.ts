export type ISODate = string; // 'YYYY-MM-DD'
export type Lift = 'squat' | 'bench' | 'deadlift' | 'ohp';
export const LIFT_ORDER: Lift[] = ['squat', 'bench', 'deadlift', 'ohp'];
export const LOWER: Lift[] = ['squat', 'deadlift'];
export type CycleWeek = 1 | 2 | 3 | 4;
export type Slot = 'am' | 'pm';
export type DefaultSlotKind = 'lift' | 'run' | 'run-long';
/** 0 = Monday ... 6 = Sunday */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type DefaultWeek = Record<Weekday, Partial<Record<Slot, DefaultSlotKind>>>;

export type GymProfile = {
  id: string; name: string;
  plateStepKg: number;                     // 2.5 at the Home Gym
  machineLifts: Lift[];                    // travel gym: ['bench','ohp']
  machineStepLb?: number; machineMaxLb?: number; // travel gym: 10, 200
  hasBands: boolean;
};

export type Constraint = {
  id: string; start: ISODate; end: ISODate; // inclusive
  timezone?: string; gymProfileId?: string | null;
  noGym?: boolean; mountain?: boolean; note?: string;
  /** Where the athlete is on these days, "Place, Region" (e.g. "Sunny Crag, Southland"). Routes are chosen near it. */
  location?: string;
  /** First / last day are Travel Days. Default: true for a trip (sets `timezone` or `noGym`), false otherwise. */
  travelDays?: boolean;
};

export type TravelDay = 'departure' | 'arrival';

export type ClubEvent = {
  id: string; date: ISODate; time: string; // 'HH:MM'
  title: string; venue: string; type: 'partner' | 'endurance_benchmark';
};

export type RunKind = 'easy' | 'quality-vert' | 'quality-speed' | 'long' | 'ruck' | 'benchmark-2k4' | 'benchmark-hill';

export type LiftPhase =
  | { kind: 'normal' }
  /** `done`: 0..3 deload sessions completed; `ahead`: this Re-entry Week's lifts done ahead of its head (a leg-block swap). */
  | { kind: 'reentry'; done: number; ahead?: Lift[] };

/** Spec §2 Test Week: one TM Test per lift; each result sets that lift's TM, and Cycle 1 starts once all four are in. */
export type TestWeek = {
  /** Planned date per lift (Skip moves it to the next day). */
  dates: Record<Lift, ISODate>;
  results: Partial<Record<Lift, { weight: number; reps: number }>>;
};

export type PlannerState = {
  tms: Record<Lift, number>;                      // kg
  /**
   * The lift queue pointer. The head is `phase.done` in a Re-entry Week, else `index`. `ahead`: lifts of the current
   * normal round (Cycle week) already done or skipped ahead of the head (a leg-block swap); never holds the head.
   * Missing reads as []. A Re-entry Week keeps its own record in `phase.ahead` and leaves this one alone.
   */
  lift: { week: CycleWeek; index: number; phase: LiftPhase; notBefore?: ISODate; ahead?: Lift[] };
  lastLiftDate?: ISODate;                         // includes Travel Strength
  run: { nextQuality: 'vert' | 'speed'; nextBenchmark: '2k4' | 'hill'; runStartMonday: ISODate };
  ruck: { lastCredit?: ISODate; step: number };   // step 0 = 10 kg / 600 m
  /** Plan Hill Rucks every ~3 weeks. Off: the Long run is a trail run. Missing in stored state reads as false. */
  rucksEnabled: boolean;
  lastClimbDate?: ISODate;
  /** Runs done / credited / skipped, keyed by ISO Monday of their week */
  runsThisWeek: Record<ISODate, Array<'easy' | 'quality' | 'long'>>;
  runNotBefore?: ISODate;
  /** Sessions already completed per date (keeps today's plan stable after Done) */
  doneByDate: Record<ISODate, SessionRef[]>;
  defaultWeek: DefaultWeek;
  gymProfiles: GymProfile[];
  defaultGymProfileId: string;
  defaultTimezone: string;
  /** Where the athlete is when no Constraint gives a `location`. Missing in stored state reads as "Hometown". */
  homeLocation: string;
  constraints: Constraint[];
  clubEvents: ClubEvent[];
  /** Set while a Test Week is active: no regular lift Sessions are placed. */
  testWeek?: TestWeek;
};

export type SessionRef =
  | { kind: 'lift'; lift: Lift; week: CycleWeek | 'reentry' }
  | { kind: 'lift-test'; lift: Lift }
  | { kind: 'travel-strength' }
  | { kind: 'run'; run: RunKind }
  | { kind: 'climb'; eventId?: string; fallback?: boolean };

export type PlannedSession = SessionRef & { slot: Slot; status: 'planned' | 'done' };

export type DayPlan = {
  date: ISODate; timezone: string; gymProfileId: string | null;
  mountain: boolean; noGym: boolean; note?: string;
  travel?: TravelDay;
  /** Extra lines for the day, e.g. a second Club Event that found the PM Slot taken ("Also: Wall B 20:00"). */
  notes?: string[];
  sessions: PlannedSession[];
};

/**
 * A note on a future day or Session ("knee felt off, go easier", "in Riverton this day"). Open comments are
 * input for a Replan, which marks them addressed with a `resolution`.
 */
export type PlanComment = {
  id: string;                                // client-generated, /^[A-Za-z0-9_-]{1,64}$/
  date: ISODate;                             // the day the comment is about
  session?: { key: string; label: string };  // which Session, e.g. { key: 'lift:squat', label: 'Squat — Week 1 (5s)' }
  text: string;                              // trimmed, 1..1000 chars
  status: 'open' | 'addressed';
  createdAt: string;                         // ISO timestamp, set on first save
  updatedAt: string;                         // ISO timestamp, set on every save
  resolution?: string;                       // what the Replan did about it
};
