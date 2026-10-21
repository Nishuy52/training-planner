// FSL variations and finishers, docs/training-spec.md section 2.
import type { Lift } from '../domain/types';
import type { Exercise } from './mobility';

const FSL_DOSE = '4 x 8 per side, RPE 7-8';

/** FSL slot: dumbbell single-sided variation (plus chin-up / row where the spec says). */
export const FSL: Record<Lift, Exercise[]> = {
  squat: [{ name: 'DB Bulgarian split squat', dose: FSL_DOSE, cue: 'Kneecap forward over the toes. Log the weight.' }],
  bench: [
    { name: '1-arm DB bench press', dose: FSL_DOSE, cue: 'Log the weight.' },
    { name: 'Weighted chin-up', dose: '3 x 5' },
  ],
  deadlift: [{ name: 'DB single-leg RDL', dose: FSL_DOSE, cue: 'Log the weight.' }],
  ohp: [
    { name: 'Half-kneeling 1-arm DB press', dose: FSL_DOSE, cue: 'Log the weight.' },
    { name: '1-arm DB row', dose: '3 x 8' },
  ],
};

/** Finisher: isolation exercises, 2 x 12-15 (lower adds an alternating plank). Each inner array is one variant; alternate between Sessions. */
const D = '2 x 12-15';
export const FINISHERS: { lower: Exercise[][]; upper: Exercise[][] } = {
  lower: [
    [
      { name: 'Cossack squat', dose: D, cue: 'Kneecap forward.' },
      { name: 'Nordic / hamstring curl', dose: D },
      { name: 'Side plank with top-leg raise', dose: '2 x 30 s/side' },
    ],
    [
      { name: 'Cossack squat', dose: D, cue: 'Kneecap forward.' },
      { name: 'Nordic / hamstring curl', dose: D },
      { name: 'Copenhagen plank', dose: '2 x 20 s/side (short lever if needed)' },
    ],
  ],
  upper: [
    [
      { name: 'Bicep curl', dose: D },
      { name: 'Lateral raise / reverse fly', dose: D },
    ],
  ],
};
