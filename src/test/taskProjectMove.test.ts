import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { applyTaskUpdate } from '@/lib/taskWork/projectMove';

const card = (id: string, projectId: string, parentTaskId?: string) => ({ id, projectId, parentTaskId, title: id }) as Task;

describe('optimistic task update mirrors the parent move rule', () => {
  const tasks = [card('parent', 'p'), card('child', 'p', 'parent'), card('other', 'p'), card('other-child', 'p', 'other')];
  it('moves the subtasks of a parent that changes project', () => {
    const next = applyTaskUpdate(tasks, { ...tasks[0], projectId: 'q' }, 'p');
    expect(next.map(task => [task.id, task.projectId])).toEqual([['parent', 'q'], ['child', 'q'], ['other', 'p'], ['other-child', 'p']]);
  });
  it('leaves siblings alone for ordinary edits and for a subtask edit', () => {
    expect(applyTaskUpdate(tasks, { ...tasks[0], title: 'Renamed' }, 'p').map(task => task.projectId)).toEqual(['p', 'p', 'p', 'p']);
    expect(applyTaskUpdate(tasks, { ...tasks[1], projectId: 'q' }, 'p').map(task => task.projectId)).toEqual(['p', 'q', 'p', 'p']);
  });
});
