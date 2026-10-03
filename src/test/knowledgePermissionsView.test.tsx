import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import KnowledgeBaseView from '@/components/KnowledgeBaseView';
import { knowledgeClient as client } from '@/integrations/supabase/knowledgeClient';
import { downloadKnowledgeFile, uploadKnowledgeFile } from '@/hooks/useKnowledgeBase';
import type { KnowledgePolicy, KnowledgeRule } from '@/types/knowledge';
import en from '@/i18n/locales/en.json';
import { toast } from 'sonner';

const state = vi.hoisted(() => ({ role: 'member', jobTitle: 'Engineer', active: true }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createMockClient } = await import('@/integrations/supabase/mockClient');
  return { supabase: createMockClient(), USING_MOCK_BACKEND: true };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm-001', currentMember: { id: 'm-001', role: state.role, jobTitle: 'Stale position' } }) }));
vi.mock('@/context/MemberContext', async () => ({ ...(await vi.importActual<typeof import('@/context/MemberContext')>('@/context/MemberContext')), useMemberContext: () => ({ users: [
  { id: 'm-001', name: 'Example Editor', role: state.role, jobTitle: state.jobTitle, isActive: state.active },
  { id: 'm-002', name: 'Example Reviewer', role: 'member', jobTitle: 'PM', isActive: true },
] }) }));
vi.mock('@/context/ProjectContext', async () => ({ ...(await vi.importActual<typeof import('@/context/ProjectContext')>('@/context/ProjectContext')), useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[], selectedProjectId: null as string | null }) }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ acquireLock: vi.fn(async () => ({ acquired: true })), releaseLock: vi.fn(), isLockedBy: (): null => null }) }));
vi.mock('@/components/RichTextEditorLazy', () => ({ default: ({ content }: { content: string }) => <textarea aria-label="Body" value={content} readOnly /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
  let value: unknown = en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  return String(value || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] || ''));
} }) }));

const empty = (): KnowledgeRule => ({ roles: [], positions: [], member_ids: [] });
const pmPolicy = (): KnowledgePolicy => ({ mode: 'custom', view: { ...empty(), positions: ['PM'] }, edit: { ...empty(), positions: ['PM'] }, comment: { ...empty(), positions: ['PM'] } });
const ids = ['kb-test-private', 'kb-test-child', 'kb-test-discussion'];
async function liveActor() { await client.from('members' as never).update({role:state.role,job_title:state.jobTitle,is_active:state.active} as never).eq('id','m-001'); }
async function page(id: string, title: string, policy: KnowledgePolicy, parent_id: string | null = null) {
  await client.from('members' as never).update({role:'super_admin',job_title:'PM',is_active:true} as never).eq('id','m-001');
  await client.from('kb_pages').insert({ id, title, body: '<p>Confidential planning detail</p>', parent_id, access_policy: policy, created_by: 'm-001', updated_by: 'm-001' });
  await liveActor();
}

beforeEach(async () => {
  await client.auth.signInWithPassword({email:'admin@livo.test',password:'test1234'});
  await client.from('members' as never).update({role:'super_admin',job_title:'PM',is_active:true} as never).eq('id','m-001');
  state.role = 'member'; state.jobTitle = 'Engineer'; state.active = true;
  window.history.replaceState({}, '', '/');
  await client.from('kb_pages').delete().in('id', ids);
  await client.from('kb_comments').delete().in('page_id', ids);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in demo'); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('knowledge permissions and meeting notes', () => {
  it('opens an accessible document from the Slack link after permission data is ready', async () => {
    state.jobTitle = 'PM';
    await page(ids[0], 'Linked planning', pmPolicy());
    window.history.replaceState({}, '', '/?knowledge=' + ids[0]);
    render(<KnowledgeBaseView />);
    await screen.findByText('Confidential planning detail');
    await waitFor(() => expect(window.location.search).not.toContain('knowledge='));
  });
  it('does not open an administrator-restricted document from a forged Slack link', async () => {
    state.role = 'super_admin';
    await page(ids[0], 'Private linked planning', pmPolicy());
    window.history.replaceState({}, '', '/?knowledge=' + ids[0]);
    render(<KnowledgeBaseView />);
    await waitFor(() => expect(window.location.search).not.toContain('knowledge='));
    expect(screen.queryByText('Confidential planning detail')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Private linked planning' })).toBeNull();
  });
  it('hides restricted parent and inherited child from search, including from administrators', async () => {
    await page(ids[0], 'Private planning', pmPolicy());
    await page(ids[1], 'Private follow-up', { mode: 'inherit' }, ids[0]);
    const { rerender } = render(<KnowledgeBaseView />);
    await screen.findByRole('button', { name: 'Team handbook' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search titles and content' }), { target: { value: 'Confidential' } });
    expect(screen.queryByRole('button', { name: /Private/ })).not.toBeInTheDocument();
    expect(screen.getByText(en.kb.noResults)).toBeInTheDocument();
    state.role = 'super_admin'; await liveActor(); rerender(<KnowledgeBaseView />);
    await waitFor(() => expect(screen.getByText(en.kb.noResults)).toBeInTheDocument());
    expect(screen.queryByText('Confidential planning detail')).not.toBeInTheDocument();
  });

  it('grants commenting independently of editing and renders comments as plain text', async () => {
    await page(ids[2], 'Discussion only', { mode: 'custom', view: { ...empty(), roles: ['member'] }, edit: empty(), comment: { ...empty(), member_ids: ['m-001'] } });
    render(<KnowledgeBaseView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discussion only' }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    const literal = '<img src=x onerror=alert(1)> Needs review';
    fireEvent.change(await screen.findByRole('textbox', { name: 'Leave a comment' }), { target: { value: literal } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByText(literal);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit comment' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), { target: { value: 'Updated comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Updated comment');
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(screen.queryByText('Updated comment')).not.toBeInTheDocument());
  });

  it('clears selected body, revision preview and comment controls after a live job title change', async () => {
    state.jobTitle = 'PM';
    await page(ids[0], 'Restricted minutes', pmPolicy());
    const { rerender } = render(<KnowledgeBaseView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restricted minutes' }));
    await screen.findByText('Confidential planning detail');
    fireEvent.click(screen.getByRole('button', { name: 'Revision history' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Leave a comment' }), { target: { value: 'Unsent private note' } });
    state.jobTitle = 'Engineer'; await liveActor(); rerender(<KnowledgeBaseView />);
    expect(screen.queryByText('Confidential planning detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Leave a comment' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restricted minutes' })).not.toBeInTheDocument());
  });

  it('creates meeting notes with their restriction in the initial insert', async () => {
    state.role = 'super_admin'; state.jobTitle = 'PM'; await liveActor();
    render(<KnowledgeBaseView />);
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const form = within(screen.getByRole('dialog', { name: 'New page' }));
    fireEvent.change(form.getByRole('textbox', { name: 'Page title' }), { target: { value: 'Example planning minutes' } });
    fireEvent.change(form.getByRole('combobox', { name: 'Category' }), { target: { value: 'meeting' } });
    fireEvent.click(form.getByRole('button', { name: 'Page permissions' }));
    const permissions = within(screen.getByRole('dialog', { name: 'Page permissions' }));
    fireEvent.click(permissions.getByRole('radio', { name: /Custom permissions/ }));
    for (const action of ['Can view', 'Can edit', 'Can comment']) {
      fireEvent.click(within(permissions.getByRole('group', { name: action })).getByRole('checkbox', { name: 'PM' }));
    }
    fireEvent.click(permissions.getByRole('button', { name: 'Save' }));
    fireEvent.click(form.getByRole('button', { name: 'Create' }));
    await screen.findByRole('heading', { name: 'Example planning minutes' });
    const { data } = await client.from('kb_pages').select('*').eq('title', 'Example planning minutes').single();
    expect(data?.category).toBe('meeting');
    expect(data?.access_policy).toEqual(pmPolicy());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a visible administrator manage permissions without content editing and prevents self lockout', async () => {
    state.role = 'admin'; state.jobTitle = 'PM';
    await page(ids[0], 'Managed minutes', { mode: 'custom', view: { ...empty(), positions: ['PM'] }, edit: empty(), comment: empty() });
    const error = vi.spyOn(toast, 'error');
    render(<KnowledgeBaseView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Managed minutes' }));
    await screen.findByRole('button', { name: 'Page permissions' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Page permissions' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Page permissions' }));
    fireEvent.click(within(dialog.getByRole('group', { name: 'Can comment' })).getByRole('checkbox', { name: 'PM' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const { data } = await client.from('kb_pages').select('*').eq('id', ids[0]).single();
    expect(data?.body).toBe('<p>Confidential planning detail</p>');
    expect(data?.access_policy).toMatchObject({ comment: { positions: ['PM'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Page permissions' }));
    dialog = within(screen.getByRole('dialog', { name: 'Page permissions' }));
    fireEvent.click(within(dialog.getByRole('group', { name: 'Can view' })).getByRole('checkbox', { name: 'PM' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(error).toHaveBeenCalledWith(en.kb.errors.kb_self_lockout);
    expect(screen.getByRole('dialog', { name: 'Page permissions' })).toBeInTheDocument();
  });

  it('rechecks backend permissions on focus and removes revoked content without an event payload', async () => {
    state.jobTitle = 'PM';
    await page(ids[0], 'Revocable minutes', pmPolicy());
    render(<KnowledgeBaseView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revocable minutes' }));
    await screen.findByText('Confidential planning detail');
    await client.from('members' as never).update({role:'super_admin'} as never).eq('id','m-001');
    await client.from('kb_pages').update({ access_policy: { mode: 'custom', view: { ...empty(), positions: ['Engineer'] }, edit: empty(), comment: empty() } }).eq('id', ids[0]);
    await liveActor();
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText('Confidential planning detail')).not.toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Leave a comment' })).not.toBeInTheDocument();
  });

  it('uses a private bucket and an authenticated blob download without a public URL', async () => {
    const create = vi.fn(() => 'blob:private-download');
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn(); });
    const file = new File(['private note'], 'meeting.txt', { type: 'text/plain' });
    state.jobTitle='PM'; await page(ids[0],'File parent',pmPolicy());
    await uploadKnowledgeFile(ids[0], 'm-001', file);
    const { data } = await client.from('kb_attachments').select('*').eq('page_id', ids[0]).single();
    expect(data?.storage_bucket).toBe('kb-files');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloadKnowledgeFile(data!);
    expect(create).toHaveBeenCalledWith(file);
    expect(click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
