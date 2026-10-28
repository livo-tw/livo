import { describe, expect, it } from 'vitest';
import { containsTaskWorkRestoreData } from '@/lib/taskWork/restoreGuard';

describe('retained sprint history requires full server recovery', () => {
  it.each(['sprint_task_history', 'sprint_command_receipts'])('blocks generic JSON replacement containing %s', table => {
    expect(containsTaskWorkRestoreData({ [table]: [{ id: 'example-record' }] })).toBe(true);
    expect(containsTaskWorkRestoreData({ [table]: { incomplete: true } })).toBe(true);
  });
  it('does not block an empty legacy backup without protected state', () => {
    expect(containsTaskWorkRestoreData({ tasks: [], sprint_task_history: [], sprint_command_receipts: [] })).toBe(false);
  });
});
