import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectContext } from '@/context/ProjectContext';
import { TaskContext } from '@/context/TaskContext';
import { MemberContext } from '@/context/MemberContext';
import type { KnowledgeWorkflowData } from '@/lib/knowledgeWorkflowDomain';

const mutate = vi.hoisted(() => vi.fn());
const workflowData: KnowledgeWorkflowData = { pageVersion: 3, checklist: [], links: [], snapshots: [] };
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useKnowledgeWorkflow', () => ({ useKnowledgeWorkflow: () => ({ data: workflowData, loading: false, error: null as string | null, refresh: vi.fn(), mutate, contextKey: 'page|me' }) }));
vi.mock('@/hooks/useQa', () => ({ useQa: () => ({ enabled: false, client: {} }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
import { KnowledgeWorkflowPanel } from '@/components/knowledge/KnowledgeWorkflowPanel';

const projects = [{ id: 'p-open', name: 'Open project', isArchived: false }, { id: 'p-old', name: 'Old project', isArchived: true }];
const statuses = [{ id: 'done', name: 'Done', isDone: true, sortOrder: 0 }, { id: 'doing', name: 'Doing', isDone: false, sortOrder: 2 }, { id: 'todo', name: 'To do', isDone: false, sortOrder: 1 }];
const Providers = ({ children }: { children: ReactNode }) => (
  <ProjectContext.Provider value={{ allProjects: projects, productLines: [] } as never}>
    <TaskContext.Provider value={{ statuses, refreshTasks: vi.fn() } as never}>
      <MemberContext.Provider value={{ users: [] } as never}>{children}</MemberContext.Provider>
    </TaskContext.Provider>
  </ProjectContext.Provider>
);
const openTaskForm = () => {
  fireEvent.click(screen.getByRole('button', { name: 'kbWorkflow.addLink' }));
  fireEvent.click(screen.getByRole('button', { name: 'kbWorkflow.createTask' }));
};

beforeEach(() => { mutate.mockReset(); mutate.mockResolvedValue({}); });

describe('creating a task from a knowledge page', () => {
  it('starts in the page project and the first open status, and links a meeting note as a meeting action', async () => {
    render(<KnowledgeWorkflowPanel pageId="page" canEdit category="meeting" pageProjectId="p-open" />, { wrapper: Providers });
    openTaskForm();
    expect(screen.getByLabelText('kbWorkflow.project')).toHaveValue('p-open');
    expect(screen.getByLabelText('kbWorkflow.status')).toHaveValue('todo');
    fireEvent.change(screen.getByLabelText('kbWorkflow.title'), { target: { value: 'Follow up' } });
    fireEvent.click(screen.getByRole('button', { name: 'kbWorkflow.confirmCreate' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({ action: 'create_task', relation: 'meeting', input: { title: 'Follow up', projectId: 'p-open', statusId: 'todo' } });
  });

  it('links a task from an ordinary page as a reference and leaves an archived project for the person to choose', async () => {
    render(<KnowledgeWorkflowPanel pageId="page" canEdit category="general" pageProjectId="p-old" />, { wrapper: Providers });
    openTaskForm();
    expect(screen.getByLabelText('kbWorkflow.project')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('kbWorkflow.project'), { target: { value: 'p-open' } });
    fireEvent.change(screen.getByLabelText('kbWorkflow.title'), { target: { value: 'Check' } });
    fireEvent.click(screen.getByRole('button', { name: 'kbWorkflow.confirmCreate' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({ relation: 'reference', input: { projectId: 'p-open', statusId: 'todo' } });
  });
});
