// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MockSupabaseClient } from '@/integrations/supabase/mockClient';
import { supabase } from '@/integrations/supabase/client';
import { useTaskCRUD } from '@/context/hooks/useTaskCRUD';
import type { Task } from '@/types';

vi.mock('@/integrations/supabase/client', async () => {
  const { createMockClient } = await import('@/integrations/supabase/mockClient');
  return { supabase: createMockClient() };
});

const task: Task = {
  id: 'undo-example', taskKey: 'UNDO-1', projectId: '', title: 'Example task', statusId: 's2',
  creatorId: 'm-001', startedAt: '2026-10-07', priority: 'medium', sortOrder: 0,
  createdAt: '2026-10-07', commentCount: 0, attachmentCount: 0, deployments: [],
};

async function fixture(laterChange: { status_id?: string; started_at?: string; completed_at?: string } = {}) {
  const { data: projects } = await supabase.from('projects').select('id').limit(1);
  const local = { ...task, projectId: projects![0].id };
  const inserted = await supabase.from('tasks').insert({
    id: local.id, task_key: local.taskKey, project_id: local.projectId, title: 'Later title edit',
    status_id: local.statusId, creator_id: local.creatorId, started_at: local.startedAt,
    completed_at: null, ...laterChange,
  });
  expect(inserted.error).toBeNull();
  const refreshTasks = vi.fn(async () => {});
  const appendStatusLog = vi.fn();
  const view = renderHook(() => {
    const [allTasks, setAllTasks] = useState([local]);
    const [selected, setSelected] = useState<Task | null>(local);
    const { createUpdateTaskInDb } = useTaskCRUD({ allTasks, statuses: [], setAllTasks, refreshTasks, appendStatusLog });
    return { allTasks, selected, update: createUpdateTaskInDb(local.creatorId, [], setSelected) };
  });
  const read = async () => (await supabase.from('tasks').select('*').eq('id', local.id).maybeSingle()).data;
  const undo = async () => {
    let confirmed: boolean | undefined;
    await act(async () => { confirmed = await view.result.current.update(local.id, { statusId: 's1', startedAt: undefined }, local); });
    return confirmed;
  };
  return { view, read, undo, refreshTasks, appendStatusLog };
}

beforeEach(async () => {
  MockSupabaseClient.resetMockData();
  await supabase.auth.signInWithPassword({ email: 'admin@livo.test', password: 'test1234' });
});

it.each([
  { status_id: 's3' },
  { started_at: '2026-10-08' },
  { completed_at: '2026-10-09T00:00:00Z' },
])('leaves the local and stored task unchanged when a later related edit no longer matches %o', async laterChange => {
  const { view, read, undo, refreshTasks, appendStatusLog } = await fixture(laterChange);
  expect(await undo()).toBe(false);
  expect(await read()).toMatchObject(laterChange);
  expect(view.result.current.selected?.statusId).toBe('s2');
  expect(view.result.current.allTasks[0].statusId).toBe('s2');
  expect(refreshTasks).toHaveBeenCalledOnce();
  expect(appendStatusLog).not.toHaveBeenCalled();
});

it('restores a matched task, preserves later unrelated changes, and confirms only one undo', async () => {
  const { view, read, undo, appendStatusLog } = await fixture();
  expect(await undo()).toBe(true);
  expect(await read()).toMatchObject({ status_id: 's1', started_at: null, title: 'Later title edit' });
  expect(view.result.current.selected?.statusId).toBe('s1');
  expect(view.result.current.allTasks[0]).toMatchObject({ statusId: 's1', startedAt: undefined });
  expect(await undo()).toBe(false);
  expect(appendStatusLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fromStatusId: 's2', toStatusId: 's1' }));
});
