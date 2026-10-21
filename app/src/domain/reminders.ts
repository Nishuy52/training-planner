export type ReminderKind = 'morning' | 'preview' | 'mobility';

export type ReminderNow = { date: string; hhmm: string; weekday: number };

const SCHEDULE: { kind: ReminderKind; time: string; weekday?: number }[] = [
  { kind: 'morning', time: '07:00' },
  { kind: 'preview', time: '19:00', weekday: 6 },
  { kind: 'mobility', time: '21:30' },
];

export function dueReminders(
  now: ReminderNow,
  sent: (kind: ReminderKind, date: string) => boolean,
): ReminderKind[] {
  return SCHEDULE.filter(
    (s) =>
      (s.weekday === undefined || s.weekday === now.weekday) &&
      now.hhmm >= s.time &&
      !sent(s.kind, now.date),
  ).map((s) => s.kind);
}
