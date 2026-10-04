// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createMockClient, MockSupabaseClient } from '@/integrations/supabase/mockClient';

type Row = Record<string, unknown>;
const supabase = createMockClient();
const placement = (rows: unknown) => ((rows ?? []) as Row[]).map(row => [row.id, row.project_id]).sort();
const base = { title: 'Synthetic', status_id: 's1', priority: 'medium', creator_id: 'm-001', sort_order: 0 };
const twoProjects = async () => {
  const { data } = await supabase.from('projects').select('*');
  const [from, to] = ((data ?? []) as Row[]).filter(project => !project.is_archived);
  return { from, to };
};

describe('demo backend keeps subtasks in their parent project', () => {
  beforeEach(async () => {
    MockSupabaseClient.resetMockData();
    await supabase.auth.signInWithPassword({ email: 'admin@livo.test', password: 'test1234' });
  });

  it('moves the subtasks with a moved parent and refuses moving a subtask alone', async () => {
    const { from, to } = await twoProjects();
    expect((await supabase.from('tasks').insert([
      { ...base, id: 'move-parent', task_key: 'MOVE-1', project_id: from.id },
      { ...base, id: 'move-child-1', task_key: 'MOVE-2', project_id: from.id, parent_task_id: 'move-parent' },
      { ...base, id: 'move-child-2', task_key: 'MOVE-3', project_id: from.id, parent_task_id: 'move-parent' },
    ])).error).toBeNull();

    expect((await supabase.from('tasks').update({ project_id: to.id }).eq('id', 'move-child-1')).error?.message).toBe('work_invalid_parent');
    expect((await supabase.from('tasks').update({ project_id: to.id }).eq('id', 'move-parent')).error).toBeNull();
    const { data: moved } = await supabase.from('tasks').select('*').in('id', ['move-parent', 'move-child-1', 'move-child-2']);
    expect(placement(moved)).toEqual([['move-child-1', to.id], ['move-child-2', to.id], ['move-parent', to.id]]);
    expect(((moved ?? []) as Row[]).filter(row => row.id !== 'move-parent').every(row => row.parent_task_id === 'move-parent')).toBe(true);
  });

  it('rolls the whole move back when a subtask key already exists in the target project', async () => {
    const { from, to } = await twoProjects();
    await supabase.from('tasks').insert([
      { ...base, id: 'clash-target', task_key: 'CLASH-9', project_id: to.id },
      { ...base, id: 'clash-parent', task_key: 'CLASH-1', project_id: from.id },
      { ...base, id: 'clash-child', task_key: 'CLASH-9', project_id: from.id, parent_task_id: 'clash-parent' },
    ]);
    expect((await supabase.from('tasks').update({ project_id: to.id }).eq('id', 'clash-parent')).error?.message).toBe('work_conflict');
    const { data: after } = await supabase.from('tasks').select('*').in('id', ['clash-parent', 'clash-child']);
    expect(placement(after)).toEqual([['clash-child', from.id], ['clash-parent', from.id]]);
  });
});
