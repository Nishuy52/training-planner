// Mobility content, transcribed from docs/training-spec.md section 6.
// Daily Routine doses are uniform: HOLD = 45 s per side, REPS = 10 slow reps per side with a 3 s pause.

export type Dose =
  | { type: 'hold'; seconds: 45; perSide: boolean; positions?: string[]; times?: number }
  | { type: 'reps'; reps: number; pauseS?: number; perSide: boolean; sets?: number };
export type Exercise = { name: string; group?: string; dose: Dose | string; cue?: string };

const HOLD = (perSide = true, extra: { positions?: string[]; times?: number } = {}): Dose => ({ type: 'hold', seconds: 45, perSide, ...extra });
const REPS = (perSide = true): Dose => ({ type: 'reps', reps: 10, pauseS: 3, perSide });

const WALL = 'Standing at wall';
const BED = 'Kneeling at bed';
const FLOOR = 'Floor';

export const DAILY_ROUTINE: Exercise[] = [
  { group: WALL, name: 'Short foot', dose: REPS(), cue: 'Arch up, toes long, big-toe base down.' },
  { group: WALL, name: 'Big toe press', dose: REPS(), cue: 'Press the big toe down while the other four toes stay lifted.' },
  { group: WALL, name: 'Wall tibialis raise', dose: REPS(false), cue: 'Heels down, kneecaps forward. Both feet together.' },
  { group: WALL, name: 'Wall calf stretch', dose: HOLD(true, { positions: ['Straight knee', 'Bent knee'] }), cue: 'Hold each position. Kneecap forward first and the foot follows.' },
  { group: WALL, name: 'Standing outer hip stretch', dose: HOLD(), cue: 'Leg crossed behind, hip out, arm over.' },
  { group: WALL, name: 'Chin tucks', dose: REPS(false), cue: 'Draw the chin straight back, long neck. Counters tech neck.' },
  { group: WALL, name: 'Neck stretch', dose: HOLD(true, { positions: ['Ear to shoulder', 'Nose to armpit'] }), cue: 'Hold each position.' },
  { group: BED, name: 'Bed chest stretch', dose: HOLD(), cue: 'Forearm on the bed, elbow at shoulder height, rotate away.' },
  { group: BED, name: 'Kneeling thoracic extension', dose: HOLD(false, { times: 2 }), cue: 'Elbows on the bed edge, hips back, lower back flat.' },
  { group: BED, name: 'Half-kneeling hip flexor', dose: HOLD(), cue: 'Glute squeezed. Kneecap forward.' },
  { group: BED, name: 'Thread the needle', dose: REPS() },
  { group: FLOOR, name: '90/90 switches', dose: REPS(false), cue: 'Lead with the back knee. Knees track, no forcing.' },
  { group: FLOOR, name: 'Side-lying hip internal rotation', dose: REPS(), cue: 'Knees together, top foot lifts.' },
  { group: FLOOR, name: 'Knee-to-opposite-shoulder', dose: HOLD() },
  { group: FLOOR, name: 'Hand-assisted hamstring', dose: HOLD(true, { positions: ['Kneecap to ceiling', 'Across the body, hips flat', 'Leg turned in'] }), cue: 'Hold each position.' },
];

export const ALIGNMENT_RULE =
  'Kneecap forward first and the foot follows. Tripod foot (big-toe base, little-toe base, heel). A 10-15 degree toe-out is normal.';

export const MORNING_DRILLS: Exercise[] = [
  { name: 'Seated hip CARs', dose: '5/side' },
  { name: 'Frog hip internal rotation', dose: '6/side' },
  { name: 'Standing hip circles', dose: '5/direction/leg' },
];
export const MORNING_DRILLS_NOTE = 'Do 1 set of each, building to 3. A tick, not reminded.';

export const SELF_CHECKS: { name: string; how: string }[] = [
  { name: 'Shin rotation check', how: 'Seated on a high chair, compare foot angles.' },
  { name: 'Ober test', how: 'Test both sides.' },
];
