// Pre-lift warm-ups (~10 min, gym), docs/training-spec.md section 6.
// Restored from the v1 tracker plus the spec additions; cue fixes applied
// (kneecap over 2nd toe; kneecap forward on lunges/squats; knees track, no forcing).
import type { Lift } from '../domain/types';
import type { Exercise } from './mobility';

export const WARMUPS: Record<Lift, Exercise[]> = {
  squat: [
    { name: 'Ankle dorsiflexion (knee-to-wall)', dose: '2 x 10 each', cue: 'Foot ~5 cm from wall, drive the kneecap toward the wall over the 2nd toe. Extra dorsiflexion adds squat depth; key for supination correction.' },
    { name: 'Hip CARs', dose: '5/side', cue: 'Standing, hands on a wall. Lift one knee and draw the largest circle possible. Slow and deliberate, full active range.' },
    { name: 'Short-lever Copenhagen', dose: '20 s/side', cue: 'Short-lever side plank with the top knee supported on a bench; adductors engaged, hips level.' },
    { name: 'Banded clamshell', dose: '2 x 15', cue: 'Lying on side, band above knees, feet together. Open the top knee, pelvis still. Knees track, no forcing. Activates glute medius.' },
    { name: 'Deep squat hold', dose: '45 s', cue: 'Hold a pole or doorframe for balance, lower into the deepest squat possible. Kneecaps forward, tracking over the toes; upright torso at depth.' },
    { name: 'Banded tib-post inversion', dose: '2 x 15', cue: 'Seated, band around the forefoot, turn the sole inward against the band. Slow, ankle does the work.' },
  ],
  deadlift: [
    { name: 'Inchworm with hip-flexor pause', dose: 'x 5', cue: 'From standing, walk hands out to plank, step one foot forward to a lunge with kneecap forward, hold 3 s. Walk hands back. Wakes up the full kinetic chain.' },
    { name: '90/90 transitions', dose: '10/side', cue: 'Sit with both knees at 90 degrees, rotate side to side keeping the pelvis grounded. Knees track, no forcing.' },
    { name: '90/90 internal-rotation lift', dose: '10/side', cue: 'In 90/90, lift the back-leg foot by rotating the hip internally, knee stays down. Slow. Knees track, no forcing.' },
    { name: 'Paused glute bridge', dose: '2 x 10', cue: 'Drive hips up, squeeze hard at the top, hold 2 s. Activates glutes so the lumbar does not compensate.' },
    { name: 'Ankle circle + calf raise', dose: '10/side', cue: '10 slow circles each direction, then 10 slow calf raises through full range. Ankle prep and supination counterwork.' },
    { name: 'Banded tib-post inversion', dose: '2 x 15', cue: 'Seated, band around the forefoot, turn the sole inward against the band. Slow, ankle does the work.' },
  ],
  bench: [
    { name: 'Band pull-apart', dose: '2 x 15', cue: 'Light band, arms straight in front. Pull apart to chest level, squeeze the shoulder blades. Activates rear delt and rhomboids.' },
    { name: 'Band face pull', dose: '2 x 15', cue: 'Band anchored at face height. Pull to the forehead, elbows high and wide. Warms the rotator cuff stabilisers.' },
    { name: 'Side-lying shoulder external rotation', dose: '2 x 12', cue: 'Lie on side, elbow at 90 degrees, rotate the forearm up against gravity. Loads infraspinatus and teres minor.' },
    { name: 'Floor pec-minor stretch', dose: '2 x 30 s', cue: 'Lie face down, one arm out at 90 degrees, gently roll onto that shoulder until you feel the stretch.' },
    { name: 'Prone Y-T-W', dose: '1 x 10', cue: 'Face down. Lift into Y (thumbs up), then T (arms out), then W (elbows bent, hands near ears). Activates lower trap and serratus.' },
  ],
  ohp: [
    { name: 'Foam-roller thoracic extension', dose: '8-10 reps', cue: 'Roller at mid-back, arms crossed or behind head. Gently extend at each vertebral level working up the spine, not the lower back.' },
    { name: 'Prone Y-T-W', dose: '2 x 8', cue: 'Face down. Lift into Y (thumbs up), hold 2 s. Then T (arms out), then W (elbows bent, hands near ears). Activates lower trap and serratus.' },
    { name: 'Band dislocates', dose: '10 reps', cue: 'Light band, wide grip. Slowly pass overhead and behind, arms straight; widen the grip if the shoulder pinches.' },
    { name: 'Thread the needle', dose: '2 x 8/side', cue: 'On hands and knees, slide one arm under the body until the shoulder touches the floor. Hold 20 s. Opens thoracic rotation.' },
    { name: 'Side-lying 90/90 external rotation', dose: '2 x 12', cue: 'Lie on side, elbow at 90 degrees, rotate the forearm up against gravity. Warms the rotator cuff before heavy overhead pressing.' },
    { name: 'Wall slides', dose: '10 reps', cue: 'Back, forearms and wrists on the wall. Slide the arms up and down without the ribs flaring or the lower back arching.' },
  ],
};
