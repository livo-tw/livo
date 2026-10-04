import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeBaseView from '@/components/KnowledgeBaseView';
import { supabase } from '@/integrations/supabase/client';
import { knowledgeClient } from '@/integrations/supabase/knowledgeClient';
import en from '@/i18n/locales/en.json';

const state = vi.hoisted(() => ({ projectId: null as string | null, projects: [] as { id: string; name: string; isArchived: boolean }[],
  acquire: vi.fn(async () => ({ acquired: true })), role: 'super_admin' }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createMockClient } = await import('@/integrations/supabase/mockClient');
  return { supabase: createMockClient(), USING_MOCK_BACKEND: true };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm-001', currentMember: { role: state.role } }) }));
vi.mock('@/context/ProjectContext', async () => ({ ...(await vi.importActual<typeof import('@/context/ProjectContext')>('@/context/ProjectContext')), useProjectContext: () => ({ allProjects: state.projects, productLines: [] as {id:string;name:string}[], selectedProjectId: state.projectId }) }));
vi.mock('@/context/MemberContext', async () => ({ ...(await vi.importActual<typeof import('@/context/MemberContext')>('@/context/MemberContext')), useMemberContext: () => ({ users: [{ id: 'm-001', name: 'Example Member' }] }) }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ acquireLock: state.acquire, releaseLock: vi.fn(), isLockedBy: (): null => null }) }));
vi.mock('@/components/RichTextEditorLazy', () => ({ default: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => <textarea aria-label="Body" value={content} onChange={e => onChange(e.target.value)} /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
  let value: unknown = en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  return String(value || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] || ''));
} }) }));

beforeEach(async () => {
  await supabase.auth.signInWithPassword({email:'admin@livo.test',password:'test1234'});
  window.history.replaceState({}, '', window.location.pathname);
  state.role = 'super_admin'; state.projectId = null; state.acquire.mockResolvedValue({ acquired: true });
  const result = await supabase.from('projects').select('id');
  state.projects = (result.data || []).map((p, i) => ({ id: p.id, name: `Project ${i + 1}`, isArchived: false }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Demo must not access a backend'); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('knowledge base user flow', () => {
  it('edits and restores a body in demo mode with no network calls', async () => {
    render(<KnowledgeBaseView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Team handbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Body' }), { target: { value: '<p>Updated guide</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Body' })).not.toBeInTheDocument());
    expect(screen.getByText('Updated guide')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revision history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await screen.findByText(/Keep useful team notes here/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('searches outside the project filter and does not open the editor when acquiring a lock fails', async () => {
    state.projectId = state.projects[0].id;
    state.acquire.mockResolvedValue({ acquired: false });
    render(<KnowledgeBaseView />);
    await screen.findByRole('button', { name: 'Project reference' });
    expect(screen.queryByRole('button', { name: 'Team handbook' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search titles and content' }), { target: { value: 'Team handbook' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Team handbook/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(state.acquire).toHaveBeenCalled());
    expect(screen.queryByRole('textbox', { name: 'Body' })).not.toBeInTheDocument();
  });
  it('creates a shared page through the form', async () => {
    render(<KnowledgeBaseView />);
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page title' }), { target: { value: 'Example new guide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('heading', { name: 'Example new guide' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('opens an authorized archived source through a deep link without enabling editing', async () => {
    state.role = 'member';
    const id = 'kb-archived-example';
    const inserted = await knowledgeClient.from('kb_pages').insert({ id, title: 'Archived example meeting', body: '<p>Historical source remains available.</p>', project_id: null, parent_id: null,
      is_archived: true, admin_only: false, category: 'meeting', access_policy: { mode: 'inherit' }, sort_order: 0,
      created_by: 'm-001', updated_by: 'm-001', created_at: '2026-01-01', updated_at: '2026-01-01', version: 1 });
    expect(inserted.error).toBeNull();
    window.history.replaceState({}, '', `${window.location.pathname}?kb=${id}&anchor=example-anchor`);
    render(<KnowledgeBaseView />);
    await screen.findByRole('heading', { name: 'Archived example meeting' });
    expect(screen.getByText('Historical source remains available.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.kb.navigation.filters }));
    expect(screen.getByRole('checkbox', { name: en.kb.showArchived })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    await knowledgeClient.from('kb_pages').delete().eq('id', id);
  });
});
