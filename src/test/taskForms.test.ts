import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { hasRichTextContent } from '@/lib/richTextContent';
import { taskDepartment } from '@/lib/department';
import { monthDayLabel, monthLabel, weekdayLabel } from '@/lib/dateLabels';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { defaultTaskProject } from '@/components/create-task/defaultProject';
import { periodTitle } from '@/components/work-report/types';

afterEach(async () => { await i18n.changeLanguage('zh-TW'); });

describe('required rich text', () => {
  it('treats an emptied editor as empty and an image as content', () => {
    for (const empty of ['', '<p></p>', '<p><br></p>', '<p>&nbsp; </p>', '<ul><li></li></ul>']) expect(hasRichTextContent(empty)).toBe(false);
    expect(hasRichTextContent('<p>Checkout</p>')).toBe(true);
    expect(hasRichTextContent('<p><img src="x.png"></p>')).toBe(true);
  });
});

describe('a new task starts in an open project', () => {
  const lines = [{ id: 'line-a', name: 'A' }, { id: 'line-b', name: 'B' }];
  const projects = [
    { id: 'archived', name: 'Old', lineId: 'line-a', isArchived: true },
    { id: 'a1', name: 'A1', lineId: 'line-a' },
    { id: 'b1', name: 'B1', lineId: 'line-b' },
  ];
  const groups = groupProjectsByLine(lines, projects);
  it('uses the project in view, then the selected line, never an archived project', () => {
    expect(defaultTaskProject(groups, 'b1', null)).toBe('b1');
    expect(defaultTaskProject(groups, null, 'line-b')).toBe('b1');
    expect(defaultTaskProject(groups, null, null)).toBe('a1');
    // An archived project in view is not offered for new tasks.
    expect(defaultTaskProject(groups, 'archived', null)).toBe('a1');
    expect(defaultTaskProject([], null, null)).toBe('');
  });
});

describe('one department per task everywhere', () => {
  const members = [{ id: 'be', name: 'Be', jobTitle: 'Backend engineer' }, { id: 'qa', name: 'Qa', jobTitle: 'QA' }];
  it('uses the department set on the task, otherwise the assignee’s', () => {
    expect(taskDepartment({ department: 'PM', assigneeId: 'be' }, members)).toBe('PM');
    expect(taskDepartment({ assigneeId: 'be' }, members)).toBe('BE');
    expect(taskDepartment({ assigneeId: 'qa' }, new Map(members.map(m => [m.id, m])))).toBe('QA');
    expect(taskDepartment({ department: 'unknown', assigneeId: 'qa' }, members)).toBe('QA');
    expect(taskDepartment({}, members)).toBeNull();
  });
});

describe('dates in the interface language', () => {
  const date = new Date(2026, 2, 31);
  it('follows the language instead of always writing Chinese', async () => {
    await i18n.changeLanguage('en');
    expect(monthDayLabel(date)).toBe('Mar 31');
    expect(monthLabel(date)).toBe('Mar');
    expect(weekdayLabel(date)).toBe('T');
    await i18n.changeLanguage('zh-TW');
    expect(monthDayLabel(date)).toBe('3月31日');
    expect(monthLabel(date)).toBe('3月');
    expect(weekdayLabel(date)).toBe('二');
  });
  it('writes the work report period in the interface language', async () => {
    await i18n.changeLanguage('en');
    expect(periodTitle('daily', date, date)).toBe('2026/03/31 (Tue)');
    await i18n.changeLanguage('zh-TW');
    expect(periodTitle('daily', date, date)).toBe('2026/03/31 (週二)');
  });
});
