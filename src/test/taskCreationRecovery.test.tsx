import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, CustomField } from '@/types';
import type { RequiredFieldsConfig } from '@/context/UIContext';

const state = vi.hoisted(() => ({
  seed: null as { parentTaskId: string; title: string } | null, tasks: [] as Task[],
  required: { title: true, project: true } as Partial<RequiredFieldsConfig>, childCreate: vi.fn(), info: vi.fn(),
  holdRefresh: false, resolveRefresh: null as null | (() => void),
  templates: [] as Array<{ id: string; defaultTagIds: string[]; defaultSpecRequirement: string }>,
  actor: 'member-example', holdCreate: false, resolveCreate: null as null | (() => void), fields: [] as CustomField[], fieldStored: true,
  open: true, deniedTable: 'task_specs', created: [] as Task[], close: vi.fn(), openTask: vi.fn(),
  success: vi.fn(), error: vi.fn(), confirm: vi.fn(), writes: [] as string[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: state.success, error: state.error, info: state.info } }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: [] as string[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: state.actor, currentMember: { id: state.actor, name: 'Example Member' } }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateTask: state.open, setShowCreateTask: state.close, setSelectedTask: state.openTask, createTaskSeed: state.seed, requiredFields: state.required, currentView: 'board' }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: 'p', selectedLineId: null as string | null, allProjects: [{ id: 'p', name: 'Example Project', lineId: 'line' }], productLines: [{ id: 'line', name: 'Example Line' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  allTasks: state.tasks, setAllTasks: vi.fn(), statuses: [{ id: 'todo', name: 'Todo' }], tags: [] as unknown[], refreshTags: vi.fn(), refreshTasks: vi.fn(),
  createTaskInDb: async (task: Task) => { state.created.push(task); if (state.holdCreate) return new Promise<Task>(resolve => { state.resolveCreate = () => resolve(task); }); return task; }, createSubtask: state.childCreate,
  refreshTaskSpecs: () => state.holdRefresh ? new Promise<void>(resolve => { state.resolveRefresh = resolve; }) : Promise.resolve(), refreshCustomFieldValues: vi.fn(), refreshTaskChecks: vi.fn(), refreshTaskTodos: vi.fn(), refreshStatusLogs: vi.fn(),
  taskTemplates: state.templates, customFields: state.fields, upsertCustomFieldValue: vi.fn(),
}) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: null as { id: string; name: string } | null }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: state.confirm, ConfirmDialog: null as null }) }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: state.fieldStored ? { id: 'stored-custom-value' } : null, error: null as null }),
    insert: () => {
      state.writes.push(table);
      return Promise.resolve({ data: null as null, error: table === state.deniedTable ? { message: 'Simulated write failure' } : null });
    },
  };
  return chain;
} } }));
import { useCreateTaskForm } from '@/components/create-task/useCreateTaskForm';

beforeEach(() => { vi.clearAllMocks(); state.seed = null; state.tasks = []; state.required = { title: true, project: true }; state.childCreate.mockReset(); state.templates = []; state.holdRefresh = false; state.resolveRefresh = null; state.actor = 'member-example'; state.holdCreate = false; state.resolveCreate = null; state.fields = []; state.fieldStored = true; state.open = true; state.deniedTable = 'task_specs'; state.created = []; state.writes = []; state.confirm.mockResolvedValue(false); });
afterEach(cleanup);
const prepare = () => {
  const hook = renderHook(() => useCreateTaskForm());
  act(() => { hook.result.current.setTitle('Example task'); hook.result.current.setBackground('<p>Original background</p>'); hook.result.current.setRequirement('<p>Original requirement</p>'); hook.result.current.setNotes('<p>Original notes</p>'); });
  return hook;
};

describe('partially created task recovery', () => {
  it('keeps input and the persisted card identity, and never creates a second card on another submit', async () => {
    state.templates = [{ id: 'template-example', defaultTagIds: [], defaultSpecRequirement: '<p>Different template</p>' }];
    const { result } = prepare();
    await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation?.task.id).toBe(state.created[0].id));
    expect(result.current.partialCreation?.sections).toContain('spec');
    expect(result.current.background).toBe('<p>Original background</p>');
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    expect(result.current.notes).toBe('<p>Original notes</p>');
    act(() => result.current.applyTemplate('template-example'));
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    act(() => result.current.handleDrop({ preventDefault: vi.fn(), dataTransfer: { files: [new File(['example'], 'example.txt')] } } as unknown as React.DragEvent));
    expect(result.current.pendingFiles).toHaveLength(0);
    expect(state.close).not.toHaveBeenCalledWith(false); expect(state.success).not.toHaveBeenCalled();
    await act(async () => result.current.handleSubmitAttempt());
    expect(state.created).toHaveLength(1);
  });

  it.each(['task_checks', 'task_todos', 'status_logs'])('preserves a draft when %s fails after the main card was saved', async table => {
    state.deniedTable = table; const { result } = prepare();
    act(() => { result.current.setNewCheckText('Example acceptance check'); result.current.setNewTodoText('Example todo'); });
    act(() => { result.current.addCheck(); result.current.addTodo(); });
    await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation).not.toBeNull());
    expect(state.created).toHaveLength(1); expect(state.writes).toContain(table);
    expect(state.success).not.toHaveBeenCalled(); expect(result.current.checkItems).toEqual(['Example acceptance check']);
    expect(result.current.todoItems).toEqual(['Example todo']);
  });

  it('opens the saved card without discarding the retained input and restores it when the form reopens', async () => {
    const { result, rerender } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    act(() => result.current.openCreatedTask());
    expect(state.openTask).toHaveBeenCalledWith(state.created[0]);
    state.open = false; rerender(); state.open = true; rerender();
    expect(result.current.partialCreation?.task.id).toBe(state.created[0].id);
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    await act(async () => result.current.handleSubmitAttempt()); expect(state.created).toHaveLength(1);
  });

  it('clears a recovery draft only after explicit confirmation, leaving the created card intact', async () => {
    const { result, rerender } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await act(async () => result.current.discardPartialDraft()); expect(result.current.partialCreation).not.toBeNull();
    state.confirm.mockResolvedValue(true); await act(async () => result.current.discardPartialDraft());
    expect(result.current.partialCreation).toBeNull(); expect(state.created).toHaveLength(1);
    state.open = false; rerender(); state.open = true; rerender();
    expect(result.current.title).toBe(''); expect(result.current.requirement).toBe('');
  });

  it('requires persisted custom-field readback before dropping the creation draft', async () => {
    state.deniedTable = ''; state.fieldStored = false;
    state.fields = [{ id: 'field-example', projectId: 'p', fieldName: 'Example detail', fieldType: 'text', isRequired: false, defaultValue: 'Retain me', sortOrder: 0, createdAt: '' }];
    const { result } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation?.sections).toContain('custom'));
    expect(result.current.customFieldsProps.values['field-example']).toEqual({ valueText: 'Retain me' });
    expect(state.success).not.toHaveBeenCalled(); expect(state.created).toHaveLength(1);
  });

  it('does not resume an old creation after the same actor returns in a new login session', async () => {
    state.holdCreate = true;
    const { result, rerender } = prepare();
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.resolveCreate).not.toBeNull());
    state.actor = 'member-other'; state.open = false; rerender();
    state.actor = 'member-example'; state.open = true; rerender();
    act(() => result.current.setTitle('New session draft'));
    const trace = vi.spyOn(console, 'info').mockImplementation(() => {});
    await act(async () => state.resolveCreate?.());
    expect(trace).toHaveBeenCalledWith('[LIVO] Task created for a previous form session', { taskId: state.created[0].id });
    trace.mockRestore();
    expect(state.writes).toEqual([]); expect(state.created).toHaveLength(1);
    expect(result.current.title).toBe('New session draft');
    expect(result.current.partialCreation).toBeNull(); expect(result.current.isSubmitting).toBe(false);
  });

  it('ignores a completed old refresh instead of closing a new session draft', async () => {
    state.deniedTable = ''; state.holdRefresh = true;
    const { result, rerender } = prepare();
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.resolveRefresh).not.toBeNull());
    state.actor = 'member-other'; state.open = false; rerender();
    state.actor = 'member-example'; state.open = true; rerender();
    act(() => result.current.setTitle('New draft after refresh started'));
    state.close.mockClear();
    await act(async () => state.resolveRefresh?.());
    expect(result.current.title).toBe('New draft after refresh started');
    expect(result.current.partialCreation).toBeNull(); expect(state.close).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled(); expect(state.created).toHaveLength(1);
  });

  it('closes normally only when all content writes have succeeded', async () => {
    state.deniedTable = ''; const { result } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.success).toHaveBeenCalledWith('task.created'));
    expect(state.close).toHaveBeenCalledWith(false); expect(result.current.partialCreation).toBeNull();
  });
});


const parentExample: Task = { id:'parent-example',taskKey:'EX-1',projectId:'p',title:'Example parent',statusId:'todo',priority:'medium',creatorId:'member-example',sortOrder:0,createdAt:'2026-10-27',commentCount:0,attachmentCount:0,deployments:[] };
const createdChild: Task = {...parentExample,id:'child-example',taskKey:'EX-2',title:'Example child',parentTaskId:parentExample.id};
const requiredField = (id: string, fieldType: CustomField['fieldType']): CustomField => ({id,projectId:'p',fieldName:id,fieldType,isRequired:true,sortOrder:0,createdAt:''});
const prepareChild = () => {
  state.tasks = [parentExample]; state.seed = {parentTaskId:parentExample.id,title:'Example child'};
  return renderHook(() => useCreateTaskForm());
};

describe('complete subtask form uses one atomic task work command', () => {
  it('collects the child own rich text and required custom values, preserving false and zero', async () => {
    state.required = {...state.required,background:true,requirement:true};
    state.fields = [requiredField('field-text','text'),requiredField('field-number','number'),requiredField('field-bool','boolean')];
    state.childCreate.mockResolvedValue(createdChild);
    const {result} = prepareChild();
    act(() => { result.current.setBackground('<p><br></p>'); result.current.setRequirement('<p>&nbsp;</p>'); result.current.handleSubmitAttempt(); });
    expect(state.childCreate).not.toHaveBeenCalled(); expect(result.current.showValidationErrors).toBe(true);
    act(() => {
      result.current.setBackground('<p>Child background</p>'); result.current.setRequirement('<p>Child requirement</p>');
      result.current.customFieldsProps.onChange('field-text',{valueText:'Child answer'});
      result.current.customFieldsProps.onChange('field-number',{valueNumber:0});
      result.current.customFieldsProps.onChange('field-bool',{valueBoolean:false});
    });
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.close).toHaveBeenCalledWith(false));
    expect(state.childCreate).toHaveBeenCalledExactlyOnceWith(parentExample.id,'Example child','p','todo',undefined,expect.objectContaining({
      details:expect.objectContaining({background:'<p>Child background</p>',requirement:'<p>Child requirement</p>',customFields:[
        {fieldId:'field-text',valueText:'Child answer'}, {fieldId:'field-number',valueNumber:0}, {fieldId:'field-bool',valueBoolean:false},
      ]}),
    }));
    expect(state.created).toEqual([]); expect(state.writes).toEqual([]);
    expect(state.openTask).toHaveBeenCalledExactlyOnceWith(createdChild);
  });

  it('keeps a failed atomic submission editable and retries the same complete values without a main-card fallback', async () => {
    state.childCreate.mockResolvedValueOnce(null).mockResolvedValueOnce(createdChild);
    const {result} = prepareChild(); act(() => result.current.setRequirement('<p>Retain child requirement</p>'));
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.childCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isSubmitting).toBe(false));
    expect(result.current.requirement).toBe('<p>Retain child requirement</p>'); expect(state.close).not.toHaveBeenCalled();
    act(() => result.current.handleSubmitAttempt()); await waitFor(() => expect(state.close).toHaveBeenCalledWith(false));
    expect(state.childCreate.mock.calls[1]).toEqual(state.childCreate.mock.calls[0]);
    expect(state.created).toEqual([]); expect(state.writes).toEqual([]);
  });

  it('locks the child project and refuses unsupported attachments instead of silently discarding them', () => {
    const {result} = prepareChild(); act(() => result.current.fieldsProps.setProjectId('other-project'));
    expect(result.current.projectId).toBe('p'); expect(result.current.fieldsProps.projectLocked).toBe(true);
    act(() => result.current.handleDrop({preventDefault:vi.fn(),dataTransfer:{files:[new File(['example'],'example.txt')]}} as unknown as React.DragEvent));
    expect(result.current.pendingFiles).toEqual([]); expect(state.info).toHaveBeenCalledWith('taskCreate.subtaskAttachmentsAfterCreation');
    expect(state.created).toEqual([]); expect(state.writes).toEqual([]);
  });

  it('ignores a completed child request after a different parent form has opened', async () => {
    let complete!: (task: Task) => void;
    state.childCreate.mockImplementation(() => new Promise<Task>(resolve => { complete = resolve; }));
    const {result,rerender} = prepareChild(); act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.childCreate).toHaveBeenCalledTimes(1));
    state.tasks = [parentExample,{...parentExample,id:'parent-other',title:'Other parent'}]; state.seed = {parentTaskId:'parent-other',title:'New child draft'}; rerender();
    await act(async () => complete(createdChild));
    expect(result.current.title).toBe('New child draft'); expect(result.current.parentTask?.id).toBe('parent-other');
    expect(result.current.isSubmitting).toBe(false); expect(state.close).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
  });

  it('does not submit title-only bulk children when required extras need a separate child form', () => {
    state.required = {...state.required,requirement:true};
    const {result} = prepare(); act(() => result.current.setSubtaskItems(['Child needing its own details']));
    act(() => result.current.handleSubmitAttempt());
    expect(result.current.subtasksRequireFullForm).toBe(true); expect(state.info).toHaveBeenCalledWith('taskCreate.subtasksNeedFullForm');
    expect(state.created).toEqual([]); expect(state.childCreate).not.toHaveBeenCalled();
  });

  it('preserves an edited custom recovery draft when reopened through a child-create entry', async () => {
    state.fields = [{...requiredField('field-recovery','text'),isRequired:false,defaultValue:'Original default'}];
    const {result,rerender} = prepare();
    act(() => result.current.customFieldsProps.onChange('field-recovery',{valueText:'Edited retained value'}));
    act(() => result.current.handleSubmitAttempt()); await waitFor(() => expect(result.current.partialCreation).not.toBeNull());
    state.open = false; rerender(); state.tasks = [parentExample]; state.seed = {parentTaskId:parentExample.id,title:'Child intent'}; state.open = true; rerender();
    expect(result.current.isSubtask).toBe(false); expect(result.current.title).toBe('Example task');
    expect(result.current.customFieldsProps.values['field-recovery']).toEqual({valueText:'Edited retained value'});
    expect(state.info).toHaveBeenCalledWith('taskCreate.recovery.resolveFirst');
  });
});


it('reconciles an uncertain child command with its exact original intent after the form reopens', async () => {
  state.childCreate.mockRejectedValueOnce({code:'work_transport_error'}).mockResolvedValueOnce(createdChild);
  const {result,rerender} = prepareChild();
  act(() => result.current.setRequirement('<p>Original intent</p>'));
  act(() => result.current.handleSubmitAttempt()); await waitFor(() => expect(result.current.uncertainSubtask).toBe(true));
  expect(state.close).not.toHaveBeenCalled(); expect(state.error).toHaveBeenCalledWith('taskCreate.subtaskResultUnknown');
  await act(async () => result.current.requestClose()); state.open=false; state.seed=null; rerender(); state.open=true; rerender();
  expect(result.current.title).toBe('Example child'); expect(result.current.isSubtask).toBe(true);
  // Even a programmatic change cannot alter the frozen command that must be reconciled.
  act(() => result.current.setTitle('Another intent must not be submitted'));
  act(() => result.current.handleSubmitAttempt()); await waitFor(() => expect(state.childCreate).toHaveBeenCalledTimes(2));
  expect(state.childCreate.mock.calls[1]).toEqual(state.childCreate.mock.calls[0]);
  await waitFor(() => expect(state.openTask).toHaveBeenCalledWith(createdChild));
  expect(state.created).toEqual([]); expect(state.writes).toEqual([]);
});

it('unlocks the same retained child draft after an uncertain retry receives a definitive rejection', async () => {
  state.fields=[requiredField('field-text','text')];
  state.childCreate.mockRejectedValueOnce({code:'work_transport_error'}).mockRejectedValueOnce({code:'work_required_fields'});
  const {result,rerender}=prepareChild();act(()=>result.current.customFieldsProps.onChange('field-text',{valueText:'Retained custom'}));
  act(()=>result.current.handleSubmitAttempt());await waitFor(()=>expect(result.current.uncertainSubtask).toBe(true));
  state.open=false; state.seed=null;rerender();state.open=true;rerender();
  act(()=>result.current.handleSubmitAttempt());await waitFor(()=>expect(result.current.uncertainSubtask).toBe(false));
  expect(result.current.isSubtask).toBe(true);expect(result.current.parentTask?.id).toBe(parentExample.id);expect(result.current.title).toBe('Example child');
  expect(result.current.customFieldsProps.values['field-text']).toEqual({valueText:'Retained custom'});expect(state.created).toEqual([]);
});


it('does not close a new child draft after returning to the same parent while an old creation is pending',async()=>{
  let complete!:(task:Task)=>void;state.childCreate.mockImplementation(()=>new Promise<Task>(resolve=>{complete=resolve;}));
  const {result,rerender}=prepareChild();act(()=>result.current.handleSubmitAttempt());await waitFor(()=>expect(state.childCreate).toHaveBeenCalledOnce());
  state.tasks=[parentExample,{...parentExample,id:'parent-other'}];state.seed={parentTaskId:'parent-other',title:'Other child'};rerender();
  state.seed={parentTaskId:parentExample.id,title:'New visit child'};rerender();
  await act(async()=>complete(createdChild));
  expect(result.current.title).toBe('New visit child');expect(result.current.parentTask?.id).toBe(parentExample.id);
  expect(state.close).not.toHaveBeenCalled();expect(state.success).not.toHaveBeenCalled();expect(result.current.isSubmitting).toBe(false);
});
