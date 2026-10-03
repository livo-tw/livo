import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminBackupSection from '@/components/system-admin/AdminBackupSection';
import { containsApprovalRestoreData } from '@/lib/approval/restoreGuard';

const mocks = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn(), mutation: vi.fn(), error: vi.fn(), confirm: vi.fn(), mode: '', mockBackend: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from, functions: { invoke: mocks.invoke } }, get USING_MOCK_BACKEND() { return mocks.mockBackend; } }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm, ConfirmDialog: (): null => null }) }));
vi.mock('@/components/UpgradePrompt', () => ({ default: (): null => null }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }));

describe('approval backup restore boundary', () => {
  it.each(['approval_requests', 'approval_actions', 'approval_rules', 'approval_steps', 'approval_events', 'approval_command_receipts'])('blocks nonempty %s', table => {
    expect(containsApprovalRestoreData({ [table]: [{ id: 'history-1' }] })).toBe(true);
  });
  it('rejects malformed approval sections and pointers even without history', () => {
    expect(containsApprovalRestoreData({ approval_requests: null })).toBe(true);
    expect(containsApprovalRestoreData({ approval_actions: {} })).toBe(true);
    expect(containsApprovalRestoreData({ tasks: [{ current_approval_id: 'request-1' }] })).toBe(true);
    expect(containsApprovalRestoreData({ tasks: [{ approval_status: 'pending_approval' }] })).toBe(true);
  });
  it('allows an ordinary requires-approval flag without approval state', () => {
    expect(containsApprovalRestoreData({ tasks: [{ requires_approval: true, current_approval_id: null, approval_status: null }], approval_requests: [], approval_actions: [] })).toBe(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mode = '';
    mocks.mockBackend = true;
    mocks.confirm.mockResolvedValue(true);
    mocks.invoke.mockImplementation(async () => ({ data: { available: !['knowledgePages','knowledgeRevisions'].includes(mocks.mode) }, error: mocks.mode==='knowledgeReadError' ? {message:'read denied'} : null }));
    mocks.from.mockImplementation((table: string) => {
      let approvalPointerQuery = false;
      const query = { select: vi.fn(), order: vi.fn(), or: vi.fn(), eq: vi.fn(), neq: vi.fn(),
        limit: vi.fn(async (): Promise<{data:unknown[];error:unknown}> => ({
          data: (table==='approval_requests' && mocks.mode==='history') || (approvalPointerQuery && mocks.mode==='pointer') || (table==='kb_pages' && mocks.mode==='knowledgePages') || (table==='kb_revisions' && mocks.mode==='knowledgeRevisions') ? [{id:'existing'}] : [],
          error: (table==='approval_requests' && mocks.mode==='historyError') || (approvalPointerQuery && mocks.mode==='pointerError') || (table==='kb_pages' && mocks.mode==='knowledgeReadError') ? {message:'read denied'} : null,
        })),
        maybeSingle: vi.fn().mockResolvedValue({data:{value:{version:1,values:['Stage','Prod']}},error:null}),
        delete: vi.fn(() => {mocks.mutation(table);return {neq:vi.fn().mockResolvedValue({error:{message:'deletion rejected'}})};}),
        insert: mocks.mutation, update: mocks.mutation, upsert: mocks.mutation };
      query.select.mockReturnValue(query); query.order.mockReturnValue(query); query.eq.mockReturnValue(query); query.neq.mockReturnValue(query);
      query.or.mockImplementation((filter: string) => { approvalPointerQuery = table === 'tasks' && filter.includes('current_approval_id'); return query; });
      return query;
    });
  });
  it.each([{ approval_actions: [{ id: 'action-1' }] }, { tasks: [{ current_approval_id: 'pending-1' }] }])('stops the actual upload flow before any database writes', async backup => {
    const { container } = render(<AdminBackupSection currentMemberId="admin-1" hasFeature={() => true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    const input = container.querySelector('input[type="file"][accept=".json"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [{ text: async () => JSON.stringify(backup) }] } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('approvalCommand.serverRestore')));
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(args => args[0])).toEqual(['backup_history']);
  });
  it('disables real-backend browser restore and rejects a synthetic file event before reading or writing anything',async()=>{
    mocks.mockBackend=false;const read=vi.fn(async()=>JSON.stringify({tasks:[]}));
    const {container,getByRole,getByText}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    expect(getByRole('button',{name:'adminBackup.restoreButton'})).toBeDisabled();
    expect(getByText('approvalCommand.serverRestore')).toBeVisible();
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:read}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith('approvalCommand.serverRestore'));
    expect(mocks.confirm).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(args=>args[0])).toEqual(['backup_history']);
  });
  it.each(['history','historyError','pointer','pointerError'])('blocks an old ordinary backup before child deletion when live state is %s', async mode => {
    mocks.mode=mode;
    const backup:Record<string,unknown[]>={tasks:[{id:'task-1',requires_approval:true}],members:[],projects:[],statuses:[],sprints:[],product_lines:[]};
    const {container}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify(backup)}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('approvalCommand.serverRestore')));
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(args=>args[0])).not.toContain('comments');
  });
  it('stops immediately on the first deletion failure instead of continuing restore writes',async()=>{
    const backup:Record<string,unknown[]>={tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]};
    const {container}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify(backup)}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('approvalCommand.serverRestore')));
    expect(mocks.mutation).toHaveBeenCalledExactlyOnceWith('comments');
    expect(mocks.mutation).not.toHaveBeenCalledWith('task_checks');
  });
  it.each(['knowledgePages','knowledgeRevisions','knowledgeReadError'])('protects knowledge data before an ordinary restore when %s', async mode => {
    mocks.mode=mode;
    const backup:Record<string,unknown[]>={tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]};
    const {container}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify(backup)}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('knowledgeWork.errors.knowledge_requires_server_restore')));
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it.each([{kb_pages:[{id:'private-page'}]},{kb_revisions:null},{kb_publications:{}},
    {knowledge_import_jobs:[{id:'staging-without-page'}]},{knowledge_import_sources:[{id:'source-only'}]},
    {knowledge_import_files:[{file_key:'private-staged-file'}]},{knowledge_import_usage_reconciliations:null},
    {knowledge_import_maintenance_state:{}},{knowledge_import_cleanup_cursors:[{id:'cursor'}]}])('rejects knowledge content and malformed knowledge sections before any database writes', async knowledge => {
    const {container}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify({tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[],...knowledge})}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('knowledgeWork.errors.knowledge_requires_server_restore')));
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it.each([{data:null,error:null},{data:{available:'true'},error:null}])('rejects an invalid knowledge restore availability response before deleting',async result=>{
    mocks.invoke.mockResolvedValueOnce(result);
    const {container}=render(<AdminBackupSection currentMemberId="admin-1" hasFeature={()=>true} backupSettings={null} setBackupSettings={vi.fn()} saveBackupSettings={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify({tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]})}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('knowledgeWork.errors.knowledge_requires_server_restore')));
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
