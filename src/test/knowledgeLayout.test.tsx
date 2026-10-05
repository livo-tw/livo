import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/knowledgeWorkflowClient', () => ({ knowledgeWorkflowRequest: request }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { KnowledgeWorkTargetPicker } from '@/components/knowledge/KnowledgeWorkTargetPicker';
import KnowledgeSidebar from '@/components/knowledge/KnowledgeSidebar';

afterEach(() => { cleanup(); vi.useRealTimers(); request.mockReset(); localStorage.clear(); });

describe('knowledge work target picker', () => {
  it('lists items without typing, narrows as you type and picks with the keyboard', async () => {
    request.mockImplementation(async ({ query, targetKind }: { query: string; targetKind: string }) => ({
      items: targetKind === 'qa' ? [{ id: '7d469669-aaaa-bbbb-cccc-000000000000', title: 'Crash on save', key: '7d469669-aaaa-bbbb-cccc-000000000000' }]
        : [{ id: 't1', title: 'Payment page', key: 'TW-1' }, { id: 't2', title: 'Login flow', key: 'TW-2' }].filter(item => item.title.toLowerCase().includes(query.toLowerCase())),
    }));
    const pick = vi.fn();
    render(<KnowledgeWorkTargetPicker pageId="page-1" disabled={false} onPick={pick} />);
    const box = screen.getByRole('combobox', { name: 'kbWorkflow.search' });
    fireEvent.focus(box);
    expect(await screen.findByRole('option', { name: 'TW-1 · Payment page' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'TW-2 · Login flow' })).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith({ action: 'search_targets', pageId: 'page-1', targetKind: 'task', query: '' });
    fireEvent.change(box, { target: { value: 'login' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(pick).not.toHaveBeenCalled();
    expect(await screen.findByRole('option', { name: 'TW-2 · Login flow' }, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'TW-1 · Payment page' })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(pick).toHaveBeenCalledWith('task', { id: 't2', title: 'Login flow', key: 'TW-2' });
    fireEvent.click(screen.getByRole('button', { name: 'kbWorkflow.bug' }));
    // Bugs show the same short id as the QA board instead of a full UUID.
    expect(await screen.findByRole('option', { name: '#00000000 · Crash on save' })).toBeInTheDocument();
  });
});

describe('knowledge sidebar layout', () => {
  const sidebar = () => render(<KnowledgeSidebar selected={false} query="" onQuery={vi.fn()} scope="all" onScope={vi.fn()} scopeOptions={null} scopeLabel="All"
    category="all" onCategory={vi.fn()} archived={false} onArchived={vi.fn()}><p>Directory</p></KnowledgeSidebar>);
  it('collapses to a rail, expands again and remembers it', () => {
    sidebar();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'kb.navigation.collapseSidebar' })); });
    expect(screen.getByRole('button', { name: 'kb.navigation.expandSidebar' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('livo.kb.sidebar') || '{}')).toMatchObject({ collapsed: true });
    cleanup(); sidebar();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'kb.navigation.expandSidebar' })); });
    expect(screen.getByRole('button', { name: 'kb.navigation.collapseSidebar' })).toBeInTheDocument();
  });
  it('resizes with the keyboard within its limits', () => {
    sidebar();
    const handle = screen.getByRole('separator', { name: 'kb.navigation.resizeSidebar' });
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '336');
    for (let index = 0; index < 40; index++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    expect(JSON.parse(localStorage.getItem('livo.kb.sidebar') || '{}')).toMatchObject({ width: 320 });
  });
});
