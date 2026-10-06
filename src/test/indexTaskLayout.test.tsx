import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Task } from '@/types';
import { useUIState } from '@/context/hooks/useUIState';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/demoMode', () => ({ IS_DEMO_PRO: false }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => window.innerWidth <= 1023 }));
vi.mock('@/hooks/useTaskHistory', () => ({ useTaskHistory: () => {} }));
vi.mock('@/hooks/useProjectScope', () => ({ SCOPED_VIEWS: [] as string[] }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ permissions: { canManageMembers: false } }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [exampleTask] }) }));
vi.mock('@/context/UIContext', async importOriginal => {
  const actual = await importOriginal<typeof import('@/context/UIContext')>();
  return { ...actual, useUIContext: () => ({ ...useUIState('example-member'), selectedTask: exampleTask,
    featureTogglesReady: true, featureToggles: { qa: false, releases: false, deploymentQueue: false } }) };
});
vi.mock('@/context/AppContext', () => ({ AppProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }),
  LicenseProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/UndoStackProvider', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/notifications/NotificationToastProvider', () => ({ NotificationToastProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/context/MyAssignmentsContext', () => ({ MyAssignmentsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/ErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/AppSidebar', () => ({ default: () => <nav aria-label="Example sidebar" /> }));
vi.mock('@/components/TopBar', () => ({ default: () => <header>Example header</header> }));
vi.mock('@/components/BoardView', () => ({ default: () => <main>Example board</main> }));
vi.mock('@/components/TaskDetailContent', () => ({ default: () => <button>Example task content</button> }));
vi.mock('@/components/project/ProjectScopeBar', () => ({ default: (): null => null }));
vi.mock('@/components/StandupPanel', () => ({ default: (): null => null }));
vi.mock('@/components/CreateProjectModal', () => ({ default: (): null => null }));
vi.mock('@/components/CreateTaskModal', () => ({ default: (): null => null }));
vi.mock('@/components/ActivityLogView', () => ({ default: (): null => null }));
vi.mock('@/components/MyAssignments', () => ({ default: (): null => null }));
vi.mock('@/components/MySettingsView', () => ({ default: (): null => null }));
vi.mock('@/components/TeamManageView', () => ({ default: (): null => null }));
vi.mock('@/components/approval/PendingApprovalList', () => ({ default: (): null => null }));
vi.mock('@/components/CommandPalette', () => ({ default: (): null => null }));
vi.mock('@/components/OnboardingGuide', () => ({ default: (): null => null }));

import Index from '@/pages/Index';

const exampleTask: Task = { id: 'example-task', taskKey: 'EX-1', projectId: 'example-project', title: 'Example task',
  priority: 'medium', statusId: 'example-status', creatorId: 'example-member', createdAt: '2026-10-06T00:00:00Z',
  sortOrder: 0, commentCount: 0, attachmentCount: 0, deployments: [] };
const width = (value: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });

beforeEach(() => { localStorage.setItem('livo.taskDisplayMode', 'side'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); localStorage.clear(); width(1280); });

describe('Index task detail across device widths', () => {
  it.each([768, 800, 1023])('mounts the actual modal at %ipx for a saved side-panel preference', value => {
    width(value);
    render(<Index />);
    expect(screen.getByRole('dialog', { name: 'Example task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Example task content' })).toBeInTheDocument();
    expect(localStorage.getItem('livo.taskDisplayMode')).toBe('side');
  });

  it('retains a desktop side panel without an extra modal or changing the preference', () => {
    width(1280);
    render(<Index />);
    expect(screen.getByText('Example board')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Example task content' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('livo.taskDisplayMode')).toBe('side');
  });

  it('uses the phone full-page detail while retaining the saved desktop preference', () => {
    width(390);
    render(<Index />);
    expect(screen.getByRole('button', { name: 'Example task content' })).toBeInTheDocument();
    expect(screen.queryByText('Example board')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('livo.taskDisplayMode')).toBe('side');
  });
});
