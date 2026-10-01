import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamIntroView from '@/components/TeamIntroView';
import { defaultTeamIntroTemplate, type TeamIntroTemplate } from '@/lib/teamIntroTemplate';
import zhTW from '@/i18n/locales/zh-TW.json';
import type { Project, ProductLine, Task, User } from '@/types';

const state = vi.hoisted(() => ({
  user: null as User | null,
  setting: null as { value: TeamIntroTemplate; updated_at: string } | null,
  manuals: [] as Record<string, unknown>[],
  callbacks: [] as (() => void)[],
  writes: [] as { table: string; values: Record<string, unknown> }[],
  failSave: false,
}));

vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [state.user] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: state.user?.id, currentMember: state.user }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as Project[], productLines: [] as ProductLine[] }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/components/RichTextEditor', () => ({ default: (): null => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: () => ({
      on(_event: string, _filter: unknown, callback: () => void) { state.callbacks.push(callback); return this; },
      subscribe() { return this; },
    }),
    removeChannel: vi.fn(),
    from: (table: string) => {
      let operation = 'select';
      let values: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const execute = (): { data: unknown; error: { code: string; message?: string } | null } => {
        if (operation === 'select') {
          return { data: table === 'system_settings' ? structuredClone(state.setting)
            : table === 'member_manuals' ? structuredClone(state.manuals) : null, error: null };
        }
        state.writes.push({ table, values: structuredClone(values) });
        if (state.failSave) return { data: null, error: { code: '500', message: 'Save failed' } };
        if (table === 'system_settings') {
          if (operation === 'insert' && state.setting) return { data: null, error: { code: '23505' } };
          if (operation === 'update' && filters.updated_at !== state.setting?.updated_at) return { data: null, error: null };
          state.setting = { value: structuredClone(values.value) as TeamIntroTemplate, updated_at: values.updated_at as string };
          return { data: structuredClone(state.setting), error: null };
        }
        if (table === 'member_manuals') {
          const existing = state.manuals.find(manual => manual.member_id === filters.member_id);
          if (existing) Object.assign(existing, structuredClone(values));
          else state.manuals.push({ id: 'new-manual', ...structuredClone(values) });
          return { data: { id: existing?.id ?? 'new-manual' }, error: null };
        }
        return { data: null, error: null };
      };
      return {
        select() { return this; },
        eq(key: string, value: unknown) { filters[key] = value; return this; },
        insert(row: Record<string, unknown>) { operation = 'insert'; values = row; return this; },
        update(row: Record<string, unknown>) { operation = 'update'; values = row; return this; },
        single: async () => execute(),
        maybeSingle: async () => execute(),
        then(resolve: (value: ReturnType<typeof execute>) => unknown) { return Promise.resolve(execute()).then(resolve); },
      };
    },
  },
}));

let i18n: ReturnType<typeof createInstance>;
beforeEach(async () => {
  vi.clearAllMocks();
  state.user = { id: 'member-1', name: 'Example', avatar: 'EX', color: '#336699', role: 'super_admin', jobTitle: 'PM', isActive: true, sortOrder: 0, email: 'example@example.com' };
  state.setting = null;
  state.manuals = [{ id: 'manual-1', member_id: 'member-1', best_state: 'Existing focus answer', communication: '', difficulty: '', landmine: 'Preserved private answer', bonus: '', custom_fields: {} }];
  state.callbacks = [];
  state.writes = [];
  state.failSave = false;
  i18n = createInstance();
  await i18n.init({ lng: 'zh-TW', resources: { 'zh-TW': { translation: zhTW } }, interpolation: { escapeValue: false } });
});
afterEach(cleanup);

const view = () => render(<TeamIntroView />, { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> });
const openEditor = async () => {
  const button = await screen.findByRole('button', { name: '調整模板' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return within(screen.getByRole('dialog', { name: '團隊介紹模板' }));
};

describe('team introduction template workflow', () => {
  it.each(['member', 'admin'] as const)('does not offer template editing to %s', async role => {
    state.user!.role = role;
    view();
    await screen.findByText('Existing focus answer');
    expect(screen.queryByRole('button', { name: '調整模板' })).not.toBeInTheDocument();
  });

  it('persists rename, prompt, order, added fields and disable without altering existing answers', async () => {
    const initialManual = structuredClone(state.manuals[0]);
    const rendered = view();
    const editor = await openEditor();
    const focus = within(editor.getByRole('group', { name: '最佳狀態' }));
    fireEvent.change(focus.getByLabelText('欄位名稱'), { target: { value: '專注習慣' } });
    fireEvent.change(focus.getByLabelText('填寫提示'), { target: { value: '何時適合深度工作？' } });
    fireEvent.click(editor.getByRole('button', { name: '將「專注習慣」往下移' }));
    fireEvent.click(within(editor.getByRole('group', { name: '地雷' })).getByRole('checkbox'));
    fireEvent.click(editor.getByRole('button', { name: '新增欄位' }));
    fireEvent.change(within(editor.getByRole('group', { name: '新欄位' })).getByLabelText('欄位名稱'), { target: { value: '協作時段' } });
    fireEvent.click(editor.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.setting!.value.fields[0].key).toBe('communication');
    expect(state.setting!.value.fields[1]).toMatchObject({ key: 'best_state', label: '專注習慣', hint: '何時適合深度工作？' });
    expect(state.setting!.value.fields.find(field => field.label === '協作時段')?.key).toMatch(/^custom_/);
    expect(state.manuals[0]).toEqual(initialManual);
    expect(screen.queryByText('Preserved private answer')).not.toBeInTheDocument();
    rendered.unmount();
    state.user!.role = 'member';
    view();
    await screen.findByRole('region', { name: '協作時段' });
    expect(within(screen.getByRole('region', { name: '專注習慣' })).getByText('Existing focus answer')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('編輯我的說明書'));
    expect(screen.getByRole('textbox', { name: '專注習慣' })).toHaveAttribute('placeholder', '何時適合深度工作？');
  });

  it('preserves disabled and unknown answers when a member saves new answers', async () => {
    const template = defaultTeamIntroTemplate();
    template.fields.find(field => field.key === 'landmine')!.enabled = false;
    template.fields.push({ key: 'custom_hours', label: '協作時段', hint: '請填時區', enabled: true });
    state.setting = { value: template, updated_at: '2026-10-01T00:00:00.000Z' };
    state.manuals[0].custom_fields = { custom_hours: 'Morning', custom_hidden: 'Keep me' };
    state.user!.role = 'member';
    view();
    await screen.findByRole('region', { name: '協作時段' });
    fireEvent.click(screen.getByTitle('編輯我的說明書'));
    fireEvent.change(screen.getByRole('textbox', { name: '協作時段' }), { target: { value: 'Afternoon' } });
    fireEvent.click(screen.getByTitle('儲存'));
    await screen.findByText('Afternoon');
    expect(state.manuals[0]).toMatchObject({ best_state: 'Existing focus answer', landmine: 'Preserved private answer', custom_fields: { custom_hours: 'Afternoon', custom_hidden: 'Keep me' } });
    expect(state.writes.map(write => write.table)).toEqual(['member_manuals']);
  });

  it('restores an existing answer after its field is re-enabled', async () => {
    const template = defaultTeamIntroTemplate();
    template.fields.find(field => field.key === 'landmine')!.enabled = false;
    state.setting = { value: template, updated_at: '2026-10-01T00:00:00.000Z' };
    view();
    const editor = await openEditor();
    fireEvent.click(within(editor.getByRole('group', { name: '地雷' })).getByRole('checkbox'));
    fireEvent.click(editor.getByRole('button', { name: '儲存' }));
    await screen.findByText('Preserved private answer');
  });

  it('retains the draft and leaves the live template unchanged on a save failure', async () => {
    view();
    const editor = await openEditor();
    fireEvent.change(within(editor.getByRole('group', { name: '最佳狀態' })).getByLabelText('欄位名稱'), { target: { value: 'Unsaved name' } });
    state.failSave = true;
    fireEvent.click(editor.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(editor.getByRole('button', { name: '儲存' })).toBeEnabled());
    expect(editor.getByDisplayValue('Unsaved name')).toBeInTheDocument();
    expect(state.setting).toBeNull();
  });

  it('receives template updates without replacing an open draft or overwriting another administrator', async () => {
    state.setting = { value: defaultTeamIntroTemplate(), updated_at: '2026-10-01T00:00:00.000Z' };
    view();
    const editor = await openEditor();
    fireEvent.change(within(editor.getByRole('group', { name: '最佳狀態' })).getByLabelText('欄位名稱'), { target: { value: 'My draft' } });
    const newer = defaultTeamIntroTemplate();
    newer.fields.push({ key: 'custom_newer', label: 'Another field', hint: '', enabled: true });
    state.setting = { value: newer, updated_at: '2026-10-02T00:00:00.000Z' };
    await act(async () => { state.callbacks.forEach(callback => callback()); });
    expect(editor.getByDisplayValue('My draft')).toBeInTheDocument();
    fireEvent.click(editor.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(editor.getByRole('button', { name: '儲存' })).toBeEnabled());
    expect(state.setting.value).toEqual(newer);
    expect(editor.getByDisplayValue('My draft')).toBeInTheDocument();
  });
});
