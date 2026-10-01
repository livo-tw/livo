import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamIntroView from '@/components/TeamIntroView';
import { getDepartment } from '@/lib/department';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';
import type { ProductLine, Project, Task, User } from '@/types';

const stores = vi.hoisted(() => ({
  users: [] as User[],
  allTasks: [] as Task[],
  allProjects: [] as Project[],
  productLines: [] as ProductLine[],
}));

vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: stores.users }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: stores.allTasks }) }));
vi.mock('@/context/ProjectContext', () => ({
  useProjectContext: () => ({ allProjects: stores.allProjects, productLines: stores.productLines }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuthContext: () => ({ currentMemberId: 'member-1', currentMember: stores.users[0] }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        data: null as null,
        eq: () => ({ maybeSingle: async () => ({ data: null as null }) }),
      }),
    }),
  },
}));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/components/RichTextEditor', () => ({ default: (): null => null }));

const member = (id: string, sortOrder: number): User => ({
  id, name: id, avatar: '', role: 'member', jobTitle: 'PM', color: '#8B5CF6',
  email: `${id}@example.com`, isActive: true, sortOrder,
});
const project = (id: string, name: string, isArchived = false): Project => ({
  id, name, lineId: 'line-1', key: id, color: '#8B5CF6', isArchived,
});
const task = (id: string, projectId: string, assigneeId?: string, extra: Partial<Task> = {}): Task => ({
  id, projectId, assigneeId, taskKey: id, title: id, statusId: 'open', priority: 'medium',
  creatorId: 'creator', sortOrder: 0, createdAt: '2026-10-01T00:00:00Z',
  commentCount: 0, attachmentCount: 0, deployments: [], ...extra,
});

let i18n: ReturnType<typeof createInstance>;
const projectSections = (label = '負責過的專案') => screen.getAllByRole('region', { name: label });
const projectNames = (section: HTMLElement) => within(section).getAllByRole('listitem').map(item => item.textContent);
const renderManuals = () => render(<TeamIntroView />, {
  wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
});

beforeEach(async () => {
  stores.users = [member('member-1', 0), member('member-2', 1)];
  stores.allTasks = [];
  stores.allProjects = [];
  stores.productLines = [{ id: 'line-1', name: '產線', icon: '', color: '#8B5CF6', sortOrder: 0 }];
  i18n = createInstance();
  await i18n.init({
    lng: 'zh-TW', fallbackLng: false,
    resources: { 'zh-TW': { translation: zhTW }, 'zh-CN': { translation: zhCN }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});

afterEach(cleanup);

describe('member manual projects', () => {
  it('lists unique project names for the assignee, including completed tasks and archived projects', () => {
    stores.allProjects = [
      project('p2', '專案 10', true), project('p1', '專案 2'),
      project('p3', '僅建立'), project('p4', '僅審查'), project('p5', ' 專案 2 '),
    ];
    stores.allTasks = [
      task('t1', 'p2', 'member-1', { statusId: 'done', completedAt: '2026-10-01T01:00:00Z' }),
      task('t2', 'p1', 'member-1'), task('t3', 'p1', 'member-1'),
      task('t4', 'p1', 'member-2'), task('t5', 'p3', 'member-2', { creatorId: 'member-1' }),
      task('t6', 'p4', 'member-2', { reviewerId: 'member-1' }), task('t7', 'p5', 'member-1'),
    ];

    renderManuals();
    const [first, second] = projectSections();
    expect(projectNames(first)).toEqual(['專案 10', '專案 2']);
    expect(projectNames(second)).toEqual(expect.arrayContaining(['專案 2', '僅建立', '僅審查']));
    expect(projectNames(second)).toHaveLength(3);
  });

  it('follows sidebar line and project order and reacts to reordering', () => {
    stores.productLines = ['line-z', 'line-a', 'line-m'].map((id, sortOrder) => ({
      id, name: id, icon: '', color: '#8B5CF6', sortOrder,
    }));
    stores.allProjects = [
      { ...project('platform-a', 'Platform A'), lineId: 'line-m' },
      { ...project('p-c', 'Project C'), lineId: 'line-a' },
      { ...project('p-y', 'Project Y'), lineId: 'line-z' },
      { ...project('p-z', 'Project Z'), lineId: 'line-z' },
      { ...project('p-b', 'Project B'), lineId: 'line-a' },
      { ...project('platform-b', 'Platform B'), lineId: 'line-m' },
      { ...project('history', 'Archived project', true), lineId: 'removed-line' },
    ];
    stores.allTasks = [...stores.allProjects].reverse().map(p => task(`t-${p.id}`, p.id, 'member-1'));
    const view = renderManuals();
    expect(projectNames(projectSections()[0])).toEqual([
      'Project Y', 'Project Z', 'Project C', 'Project B', 'Platform A', 'Platform B', 'Archived project',
    ]);

    stores.productLines = [...stores.productLines].reverse();
    stores.allProjects = [...stores.allProjects].reverse();
    view.rerender(<TeamIntroView />);
    expect(projectNames(projectSections()[0])).toEqual([
      'Platform B', 'Platform A', 'Project B', 'Project C', 'Project Z', 'Project Y', 'Archived project',
    ]);
  });

  it('ignores missing projects, blank names and unassigned tasks instead of listing invalid names', () => {
    stores.allProjects = [project('p1', '無人經辦'), project('p2', '   ')];
    stores.allTasks = [task('t1', 'missing', 'member-1'), task('t2', 'p1'), task('t3', 'p2', 'member-1')];

    renderManuals();
    for (const section of projectSections()) {
      expect(within(section).getByText('尚無經辦專案')).toBeInTheDocument();
      expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    }
  });

  it('updates the list when a card is reassigned, moved, removed or its project is renamed', () => {
    stores.allProjects = [project('p1', '原專案'), project('p2', '另一專案')];
    stores.allTasks = [task('t1', 'p1', 'member-1')];
    const view = renderManuals();
    expect(projectNames(projectSections()[0])).toEqual(['原專案']);

    stores.allTasks = [task('t1', 'p2', 'member-2')];
    view.rerender(<TeamIntroView />);
    expect(within(projectSections()[0]).getByText('尚無經辦專案')).toBeInTheDocument();
    expect(projectNames(projectSections()[1])).toEqual(['另一專案']);

    stores.allProjects = [project('p1', '原專案'), project('p2', '重新命名')];
    view.rerender(<TeamIntroView />);
    expect(projectNames(projectSections()[1])).toEqual(['重新命名']);

    stores.allTasks = [];
    view.rerender(<TeamIntroView />);
    expect(within(projectSections()[1]).getByText('尚無經辦專案')).toBeInTheDocument();
  });

  it('keeps each full project name as plain text in a read-only list while editing the manual', () => {
    const longName = `<em>新產品</em> / ${'LongProjectName'.repeat(15)}`;
    stores.allProjects = [project('p1', longName)];
    stores.allTasks = [task('t1', 'p1', 'member-1')];
    renderManuals();

    fireEvent.click(screen.getByTitle('編輯我的說明書'));
    const section = projectSections()[0];
    expect(projectNames(section)).toEqual([longName]);
    expect(section.querySelector('em')).toBeNull();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(5);
  });

  it.each([
    ['zh-TW', '負責過的專案', '尚無經辦專案'],
    ['zh-CN', '负责过的项目', '暂无经办项目'],
    ['en', 'Projects Worked On', 'No assigned projects yet'],
  ])('translates the field and empty state in %s', async (language, label, empty) => {
    renderManuals();
    await act(async () => { await i18n.changeLanguage(language); });
    expect(projectSections(label)).toHaveLength(2);
    expect(within(projectSections(label)[0]).getByText(empty)).toBeInTheDocument();
  });
});

describe('member manual department order', () => {
  it('follows managed member order across departments and within each group', () => {
    stores.users = [
      { ...member('Backend Member', 6), jobTitle: 'GS BE' },
      { ...member('Ops Beta', 5), jobTitle: 'SRE' },
      { ...member('Product Member', 1), jobTitle: 'PM' },
      { ...member('Leader', 0), jobTitle: '老大' },
      { ...member('Ops Alpha', 4), jobTitle: 'SRE' },
      { ...member('Inactive', -1), jobTitle: 'QA', isActive: false },
    ];
    const view = renderManuals();
    const departmentLabels = () => screen.getAllByRole('heading', { level: 2 })
      .slice(1).map(heading => heading.textContent?.replace(/\s+/g, ' ').trim());
    expect(departmentLabels()).toEqual(['主管(1)', '產品 PM(1)', 'SRE(2)', '後端 Backend(1)']);
    expect(screen.getByText('Leader').compareDocumentPosition(screen.getByText('Product Member')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText('Ops Alpha').compareDocumentPosition(screen.getByText('Ops Beta')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();

    stores.users = stores.users.map(user => user.name === 'Backend Member' ? { ...user, sortOrder: -1 } : user);
    view.rerender(<TeamIntroView />);
    expect(departmentLabels()).toEqual(['後端 Backend(1)', '主管(1)', '產品 PM(1)', 'SRE(2)']);
  });

  it('updates department labels when the interface language changes', async () => {
    stores.users = [{ ...member('Leader', 0), jobTitle: '老大' }];
    renderManuals();
    expect(screen.getByRole('heading', { name: '主管 (1)' })).toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(screen.getByRole('heading', { name: `${en.teamIntro.departments.manager} (1)` })).toBeInTheDocument();
  });

  it('keeps introduction-only title classification out of shared task department inference', () => {
    const leader = { ...member('Leader', 0), jobTitle: '老大' };
    stores.users = [leader];
    renderManuals();
    expect(screen.getByRole('heading', { name: '主管 (1)' })).toBeInTheDocument();
    expect(getDepartment(leader)).toBeNull();
  });
});
