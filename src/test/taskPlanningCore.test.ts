// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calendarDate, deadlineChange, pauseThroughDay, reminderPaused, reminderUntil } from '../lib/taskPlanning/core';
const old: {dueDate:string;kind:null;version:number} = { dueDate: '2026-10-03', kind: null, version: 0 } as const;
describe('task planning rules', () => {
  it('rejects year zero on every backend',()=>expect(()=>calendarDate('0000-01-01')).toThrow('planning_invalid_date'));
  it('preserves unknown and estimated legacy edits with an explicitly missing reason', () => {
    expect(deadlineChange(old, '2026-10-10', null, null).reason).toBeNull();
    expect(deadlineChange({ ...old, kind: 'estimated' }, null, null, '').reason).toBeNull();
  });
  it('requires a reason when postponing or removing an existing commitment even when downgrading its kind', () => {
    for (const [date, kind] of [['2026-10-10', 'estimated'], [null, null]] as const)
      expect(() => deadlineChange({ ...old, kind: 'committed' }, date, kind, ' ')).toThrow('planning_reason_required');
    expect(deadlineChange({ ...old, kind: 'committed' }, '2026-10-02', 'committed', null).reason).toBeNull();
  });
  it('does not silently invent a date or retain a commitment without a date', () => {
    expect(() => calendarDate('2026-02-30')).toThrow();
    expect(() => deadlineChange(old, null, 'committed', 'Example')).toThrow('planning_date_required');
  });
  it('converts the selected inclusive local day using actual timezone boundaries', () => {
    expect(pauseThroughDay('2026-10-03', 'Asia/Taipei')).toBe('2026-10-03T16:00:00.000Z');
    expect(pauseThroughDay('2026-03-08', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z');
    expect(pauseThroughDay('2026-11-01', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
    expect(pauseThroughDay('2026-10-03', 'Asia/Kathmandu')).toBe('2026-10-03T18:15:00.000Z');
  });
  it('resumes exactly at the UTC boundary and refuses invalid or indefinite pauses', () => {
    const now = new Date('2026-10-03T16:00:00.000Z');
    expect(reminderPaused(now.toISOString(), now)).toBe(false);
    expect(reminderPaused('2026-10-03T16:00:00.001Z', now)).toBe(true);
    expect(reminderUntil(null, now)).toBeNull();
    for (const value of ['2026-10-03T16:00:00.000Z', 'forever', '2028-10-03T16:00:00.000Z']) expect(() => reminderUntil(value, now)).toThrow();
  });
});
