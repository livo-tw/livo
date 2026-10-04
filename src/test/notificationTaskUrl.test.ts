import { describe, expect, it } from 'vitest';
import { buildNotificationContext } from '@/lib/notificationQueries';
import type { Task } from '@/types';

describe('notification template {task_url}', () => {
  it('opens the task through the routed ?task= deep link, like "copy link"', () => {
    const task = { id: 'task-uuid', taskKey: 'EX-12', title: 'Example', priority: 'medium' } as Task;
    expect(buildNotificationContext(task).task_url).toBe(`${window.location.origin}${import.meta.env.BASE_URL}?task=EX-12`);
  });
});
