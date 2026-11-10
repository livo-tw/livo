import { describe, expect, it } from 'vitest';
import { qaPersonDisplay, qaScopedProfile } from '@/lib/qa/peopleDisplay';
import { qaRepairAssigneeOptions } from '@/lib/qa/assignmentPeople';
import type { QaAssignmentUser } from '@/lib/qa/assignmentPeople';

describe('QA person presentation defaults', () => {
  it('uses the first Unicode codepoint and QA subtitle only for a positively identified external person', () => {
    const person = { name: ' 🧪 Example tester', avatar: '', color: ' ', jobTitle: '', isExternal: true };
    expect(qaPersonDisplay(person)).toEqual({ name: person.name, avatar: '🧪', color: '#64748b', jobTitle: 'QA' });
    expect(person).toEqual({ name: ' 🧪 Example tester', avatar: '', color: ' ', jobTitle: '', isExternal: true });
    for (const isExternal of [false, undefined]) {
      expect(qaPersonDisplay({ name: 'eqa-internal-engineer', isExternal }).jobTitle).toBe('');
    }
    expect(qaPersonDisplay({ name: 'Unknown kind', isExternal: 'true' as never }).jobTitle).toBe('');
  });

  it('preserves supplied profile values without granting an unknown identity a repair option', () => {
    expect(qaPersonDisplay({ name: 'Example', avatar: 'E!', color: '#123456', jobTitle: 'Test lead', isExternal: true }))
      .toEqual({ name: 'Example', avatar: 'E!', color: '#123456', jobTitle: 'Test lead' });
    const unknown = { id: 'unknown', name: 'Example', qaExternal: true } as QaAssignmentUser;
    expect(qaPersonDisplay(unknown).jobTitle).toBe('');
    expect(qaRepairAssigneeOptions([unknown])).toEqual([]);
  });

  it('does not treat record prototype keys as a profile', () => {
    expect(qaScopedProfile({}, 'constructor')).toBeUndefined();
    expect(qaScopedProfile({}, '__proto__')).toBeUndefined();
    const own = { name: 'Historical tester', isExternal: true };
    expect(qaScopedProfile(Object.fromEntries([['constructor', own]]), 'constructor')).toBe(own);
  });
});
