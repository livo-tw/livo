import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteKnowledgeFile, uploadKnowledgeFile, useKnowledgeBase } from '@/hooks/useKnowledgeBase';
import type { KnowledgeAttachment } from '@/types/knowledge';
import type { KnowledgePolicy } from '../../worker/src/knowledgeAccess';

const controls = vi.hoisted(() => ({ from: vi.fn(), upload: vi.fn(), remove: vi.fn() }));
vi.mock('@/integrations/supabase/knowledgeClient', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { knowledgeClient: {
    from: controls.from,
    channel: () => channel,
    removeChannel: (): Promise<void> => Promise.resolve(),
    storage: { from: () => ({ upload: controls.upload, remove: controls.remove }) },
  } };
});

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const actor = { id: 'member-example', role: 'member', is_active: true };
const page = (id: string) => ({ id, title: id, parent_id: null as null, project_id: null as null, is_archived: false, admin_only: false });
type Reply = { data: unknown[] | null; error: Error | null };

function mockDetails(directory: () => Reply, attachments: () => Reply) {
  controls.from.mockImplementation((table: string) => {
    const read = () => {
      if (table === 'kb_pages') return Promise.resolve(directory());
      if (table === 'kb_attachments') return Promise.resolve(attachments());
      return Promise.resolve<Reply>({ data: [], error: null });
    };
    const query = {
      select: () => query, eq: () => query, order: () => query,
      limit: () => read(),
      then: (resolve: (result: Reply) => void, reject: (error: unknown) => void) => read().then(resolve, reject),
    };
    return query;
  });
}

describe('recovering knowledge details', () => {
  it('retains the verified directory and retries only the selected document details', async () => {
    const directory = vi.fn((): Reply => ({ data: [page('first'), page('second')], error: null }));
    const files = vi.fn<() => Reply>()
      .mockReturnValueOnce({ data: null, error: new Error('Temporary attachment API failure') })
      .mockReturnValue({ data: [{ id: 'file-example', file_name: 'example.txt' }], error: null });
    mockDetails(directory, files);
    const { result } = renderHook(() => useKnowledgeBase('first', actor));
    await waitFor(() => expect(result.current.detailsError).toBe('kb_details_failed'));
    expect(result.current.pages.map(p => p.id)).toEqual(['first', 'second']);
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(directory).toHaveBeenCalledTimes(2));
    expect(files).toHaveBeenCalledOnce();

    act(() => result.current.retryDetails());
    await waitFor(() => expect(result.current.attachments.map(file => file.id)).toEqual(['file-example']));
    expect(result.current.detailsError).toBeNull();
    expect(directory).toHaveBeenCalledTimes(2);
  });

  it('reuses an authorized directory for unrelated renders and discards it when the actor position changes', async () => {
    const allowed = { ...actor, jobTitle: 'QA' };
    const noSubjects: string[] = [];
    const restricted = { ...page('first'), access_policy: {
      mode: 'custom',
      view: { roles: noSubjects, positions: ['QA'], member_ids: noSubjects },
      edit: { roles: noSubjects, positions: noSubjects, member_ids: noSubjects },
      comment: { roles: noSubjects, positions: noSubjects, member_ids: noSubjects },
    } satisfies KnowledgePolicy };
    mockDetails(() => ({ data: [restricted], error: null }),
      () => ({ data: [{ id: 'file-example' }], error: null }));
    const { result, rerender } = renderHook(({ member }) => useKnowledgeBase('first', member),
      { initialProps: { member: allowed } });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const directory = result.current.pages;
    expect(directory.map(row => row.id)).toEqual(['first']);

    rerender({ member: allowed });
    expect(result.current.pages).toBe(directory);

    rerender({ member: { ...allowed, jobTitle: 'Other' } });
    expect(result.current.pages).toEqual([]);
    expect(result.current.attachments).toEqual([]);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.pages).toEqual([]);
  });

  it('discards a document if the authoritative recheck no longer returns it', async () => {
    const directory = vi.fn<() => Reply>()
      .mockReturnValueOnce({ data: [page('first'), page('second')], error: null })
      .mockReturnValue({ data: [page('second')], error: null });
    mockDetails(directory, () => ({ data: null, error: new Error('Page not readable') }));
    const { result } = renderHook(() => useKnowledgeBase('first', actor));
    await waitFor(() => expect(result.current.pages.map(p => p.id)).toEqual(['second']));
    expect(result.current.attachments).toEqual([]);
    expect(result.current.detailsError).toBeNull();
  });
});

describe('recovering an attachment upload response', () => {
  type SavedAttachment = { id: string; page_id: string; storage_path: string; storage_bucket: string; uploaded_by: string };
  const file = () => new File(['example'], 'example.txt');

  function storage() {
    controls.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
    controls.remove.mockResolvedValue({ data: [], error: null });
  }

  it('accepts an exact committed attachment after a lost response and keeps the file', async () => {
    storage();
    let saved: SavedAttachment | null = null;
    const byId = vi.fn((_: string, id: string) => ({
      maybeSingle: async (): Promise<{ data: SavedAttachment | null; error: null }> => ({ data: saved?.id === id ? saved : null, error: null }),
    }));
    controls.from.mockReturnValue({
      insert: async (row: SavedAttachment) => {
        saved = row;
        return { error: { message: 'Failed to fetch' } };
      },
      select: () => ({ eq: byId }),
    });
    await expect(uploadKnowledgeFile('page-example', actor.id, file())).resolves.toBeUndefined();
    expect(byId).toHaveBeenCalledWith('id', saved!.id);
    expect(controls.remove).not.toHaveBeenCalled();
  });

  it.each([null, new Error('Read timed out')])('keeps the file if an ambiguous write cannot be verified', async readError => {
    storage();
    controls.from.mockReturnValue({
      insert: async (): Promise<never> => { throw new Error('Connection dropped'); },
      select: () => ({ eq: () => ({ maybeSingle: async (): Promise<{ data: null; error: Error | null }> => ({ data: null, error: readError }) }) }),
    });
    await expect(uploadKnowledgeFile('page-example', actor.id, file())).rejects.toThrow('kb_attachment_unconfirmed');
    expect(controls.remove).not.toHaveBeenCalled();
  });

  it('cleans up after a confirmed database rejection with an empty exact read', async () => {
    storage();
    const error = { code: '23514', message: 'CHECK constraint failed' };
    controls.from.mockReturnValue({
      insert: async () => ({ error }),
      select: () => ({ eq: () => ({ maybeSingle: async (): Promise<{ data: null; error: null }> => ({ data: null, error: null }) }) }),
    });
    await expect(uploadKnowledgeFile('page-example', actor.id, file())).rejects.toEqual(error);
    expect(controls.remove).toHaveBeenCalledWith([controls.upload.mock.calls[0][0]]);
  });
});

describe('removing a knowledge attachment', () => {
  const file: KnowledgeAttachment = {
    id: 'file-example', page_id: 'page-example', file_name: 'example.txt', file_size: 7,
    file_type: 'text/plain', storage_path: 'kb/page-example/example.txt', storage_bucket: 'kb-files',
    uploaded_by: 'member-example', created_at: '2026-11-04T00:00:00Z',
  };
  type DeleteReply = { data: KnowledgeAttachment | null; error: { message: string } | null };
  function mockDelete(resolve: () => Promise<DeleteReply>) {
    const single = vi.fn(resolve);
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn();
    const query = { eq, select };
    eq.mockReturnValue(query);
    controls.from.mockReturnValue({ delete: () => query });
    return { single, eq };
  }

  it.each(['cloud', 'self-host'] as const)('cleans up the %s object after exact metadata deletion', async mode => {
    let committed = false;
    const { eq } = mockDelete(async () => {
      committed = true;
      return { data: file, error: null };
    });
    controls.remove.mockImplementation(async (paths: string[]) => {
      expect(committed).toBe(true);
      return { data: mode === 'cloud' ? paths : paths.map(name => ({ name })), error: null };
    });
    await expect(deleteKnowledgeFile(file)).resolves.toBeUndefined();
    expect(eq.mock.calls).toEqual([['id', file.id], ['page_id', file.page_id], ['storage_path', file.storage_path]]);
    expect(controls.remove).toHaveBeenCalledExactlyOnceWith([file.storage_path]);
  });

  it('retains bytes when metadata deletion is rejected', async () => {
    mockDelete(async () => ({ data: null, error: { message: 'Permission denied' } }));
    await expect(deleteKnowledgeFile(file)).rejects.toThrow('kb_attachment_delete_unconfirmed');
    expect(controls.remove).not.toHaveBeenCalled();
  });

  it('retains bytes after a lost DELETE response, without treating a missing row as proof', async () => {
    mockDelete(async () => { throw new Error('Connection closed'); });
    await expect(deleteKnowledgeFile(file)).rejects.toThrow('kb_attachment_delete_unconfirmed');
    expect(controls.from).toHaveBeenCalledOnce();
    expect(controls.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong path', { ...file, storage_path: 'kb/page-example/another.txt' }],
  ] as const)('retains bytes on a %s deletion acknowledgement', async (_, data) => {
    mockDelete(async () => ({ data, error: null }));
    await expect(deleteKnowledgeFile(file)).rejects.toThrow('kb_attachment_delete_unconfirmed');
    expect(controls.remove).not.toHaveBeenCalled();
  });

  it('reports unconfirmed object cleanup after metadata deletion succeeds', async () => {
    mockDelete(async () => ({ data: file, error: null }));
    controls.remove.mockResolvedValue({ data: [], error: null });
    await expect(deleteKnowledgeFile(file)).rejects.toThrow('kb_attachment_cleanup_unconfirmed');
  });
});
