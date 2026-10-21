// Travel Strength (calisthenics) for no_gym days, docs/training-spec.md section 2.
// Does not advance the lift pointer; does reset the Re-entry clock.
import type { Exercise } from './mobility';

export const TRAVEL_STRENGTH: Exercise[] = [
  { name: 'Bulgarian split squat (bodyweight)', dose: '3 x 12/side', cue: 'Kneecap forward.' },
  { name: 'Pistol progression', dose: '3 x 5/side', cue: 'Kneecap forward.' },
  { name: 'Single-leg RDL', dose: '3 x 10/side' },
  { name: 'Push-up variation', dose: '3 x max-2' },
  { name: 'Pull-ups', dose: '3 x max-2', cue: 'Only if a bar exists.' },
  { name: 'Side plank', dose: '2 x 45 s/side' },
];
