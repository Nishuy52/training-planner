import { it, expect } from 'vitest';
import { dueReminders } from '../../src/domain/reminders';
const none = () => false;
it('07:00 morning, 21:30 mobility, Sunday 19:00 preview', () => {
  expect(dueReminders({ date: '2026-10-05', hhmm: '07:00', weekday: 0 }, none)).toEqual(['morning']);
  expect(dueReminders({ date: '2026-10-05', hhmm: '06:55', weekday: 0 }, none)).toEqual([]);
  expect(dueReminders({ date: '2026-10-11', hhmm: '21:35', weekday: 6 }, none)).toEqual(['morning', 'preview', 'mobility']);
});
it('late cron still sends once; already-sent kinds are skipped', () => {
  const sent = (k: string) => k === 'morning';
  expect(dueReminders({ date: '2026-10-05', hhmm: '09:10', weekday: 0 }, sent)).toEqual([]);
});
it('does not send yesterday\'s morning after midnight', () => expect(dueReminders({ date: '2026-10-06', hhmm: '00:05', weekday: 1 }, none)).toEqual([]));
