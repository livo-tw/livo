import { approvalErrorText } from '@/lib/approval/feedback';
import { useState, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { createApprovalCommandRunner, approvalTaskPatch } from '@/lib/approvalCommands';
import { canSetApprovalRequirement } from '@/lib/approval/core';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import UserSelect from '@/components/UserSelect';
import CustomFieldManager from '@/components/CustomFieldManager';
import ApprovalProgress from '@/components/approval/ApprovalProgress';
import { getDepartment, DEPARTMENTS, type Department } from '@/lib/department';
import { supabase } from '@/integrations/supabase/client';
import { X, ChevronDown, ChevronRight, GripVertical, Settings2 } from 'lucide-react';
import { useUIContext } from '@/context/UIContext';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import { getPriorityOptions } from './utils';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { Priority } from '@/types';
import TaskDeploymentSection from './TaskDeploymentSection';
import { CustomFieldInput } from './fields/CustomFieldInput';
import DatePickerField from './fields/DatePickerField';
import TaskPlanningFields from './fields/TaskPlanningFields';
import TaskResponsibilityFields from './fields/TaskResponsibilityFields';
import { responsibilityTaskPatch, type TaskResponsibility } from '@/lib/taskWork/client';
import { deadlineTaskFields } from '@/lib/taskPlanning/client';
import ApprovalHistory from './ApprovalHistory';

type Props = { detail: TaskDetailState };

const TaskSidebarFields = ({ detail }: Props) => {
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  const [approvalSaving,setApprovalSaving] = useState(false);
  const {
    task, allProjects, productLines, users, statuses, tags, permissions,
    currentMemberId, currentMember, customFields, customFieldValues, upsertCustomFieldValue,
    hasFeature, getFieldLocker, trackPresence,

    // Status dropdown
    statusDropdownOpen, setStatusDropdownOpen, statusDropdownRef,
    handleStatusChange,

    // Tag dropdown
    tagDropdownOpen, tagDropdownRef,
    tagFieldLocker, isTagLocked,
    newTagName, setNewTagName, newTagColor, setNewTagColor,
    tagManageMode, setTagManageMode,
    openTagDropdown, closeTagDropdown,
    addTag, removeTag, createTag, deleteTag,

    // Sidebar layout
    sidebarFieldOrder, setSidebarFieldOrder,
    isLayoutMode, setIsLayoutMode,
    dragFieldIdx, dragOverFieldIdx,
    layoutSaving, SIDEBAR_DEFAULT_ORDER,
    saveSidebarFieldOrder,
    handleFieldDragStart, handleFieldDragOver, handleFieldDrop,

    // Task update
    updateTask,

    // Custom fields
    showCustomFieldManager, setShowCustomFieldManager,
    getCustomFieldValue, handleCustomFieldChange,

    setSelectedTask,
    setAllTasks,
  } = detail;

  const runApproval = useMemo(() => createApprovalCommandRunner(supabase), [currentMemberId]);
  const visibleTask = useRef(task); visibleTask.current = task;
  if (!task) return null;
  const saveResponsibility = (row: TaskResponsibility) => {
    const merge = (card: typeof task) => card.id !== row.id ? card : { ...card, ...responsibilityTaskPatch(row, card) };
    setAllTasks(previous => previous.map(merge));
    setSelectedTask(previous => previous ? merge(previous) : previous);
  };

  const project = allProjects.find(p => p.id === task.projectId);
  const creator = users.find(u => u.id === task.creatorId);
  const assignee = users.find(u => u.id === task.assigneeId);
  const status = statuses.find(s => s.id === task.statusId);
  const canLayout = permissions.canEditProject;
  const fieldOrder = sidebarFieldOrder.length > 0 ? sidebarFieldOrder : SIDEBAR_DEFAULT_ORDER;
  // Anyone who can edit the task may require approval; only administrators may remove the requirement.
  const requirementLocked = !!task.requiresApproval && !canSetApprovalRequirement(false, { role: currentMember?.role ?? '', active: currentMember?.isActive });

  // ── Custom field input renderer ─────────────────────────────────────────

  const renderCustomFieldInput = (field: import('@/types').CustomField) => {
    const cv = getCustomFieldValue(field.id);
    const lockKey = `cf_${field.id}`;
    const locker = getFieldLocker(lockKey);
    const isLocked = !!locker;
    return (
      <CustomFieldInput
        key={field.id}
        field={field}
        cv={cv}
        isLocked={isLocked}
        locker={locker}
        onChange={partial => handleCustomFieldChange(field.id, partial)}
        onFocus={() => !isLocked && trackPresence({ editingField: lockKey })}
        onBlur={() => trackPresence({ editingField: null })}
      />
    );
  };

  // ── Custom fields section ────────────────────────────────────────────────

  const renderCustomFields = () => {
    const projectCustomFields = customFields.filter(f => f.projectId === task.projectId).sort((a, b) => a.sortOrder - b.sortOrder);
    if (projectCustomFields.length === 0 && !permissions.canEditProject) return null;
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.customFields', '自訂欄位')}</label>
          {permissions.canEditProject && (
            <button onClick={() => setShowCustomFieldManager(true)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors" title={t('taskDetail.sidebar.manageFields', '管理自訂欄位')}>
              <Settings2 size={11} />{t('taskDetail.sidebar.manage', '管理')}
            </button>
          )}
        </div>
        {projectCustomFields.length === 0
          ? <p className="text-xs text-muted-foreground/60 italic">{t('taskDetail.sidebar.noCustomFields', '尚無自訂欄位')}</p>
          : <div className="space-y-3">{projectCustomFields.map(field => renderCustomFieldInput(field))}</div>
        }
      </div>
    );
  };

  // ── Build field JSX map ──────────────────────────────────────────────────

  const fieldJsx: Record<string, React.ReactNode> = {};

  fieldJsx['project'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.project', '專案')}</label>
      <SearchableSelect value={task.projectId} onChange={e => updateTask({ projectId: e.target.value })}
        className="w-full mt-1 text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground">
        <ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects, [task.projectId])} />
      </SearchableSelect>
    </div>
  );

  fieldJsx['status'] = (
    <div>
      <div className="relative" ref={statusDropdownRef}>
        {statuses.length > 5 ? <>
          <ColoredStatusSelect label={t('taskDetail.sidebar.status', '狀態')} value={task.statusId}
            options={statuses.map(item => ({ value: item.id, label: item.name, color: item.color }))}
            onValueChange={handleStatusChange}
            className="[&>label]:text-[11px] [&>label]:uppercase [&>label]:tracking-wider [&>label]:text-muted-foreground" />
          {task.approvalStatus === 'pending_approval' && <span className="mt-1 block text-[10px] text-purple-600 dark:text-purple-400">⏳ {t('taskDetail.sidebar.pendingApproval', '待簽核')}</span>}
        </> : <>
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.status', '狀態')}</label>
        <button type="button" onClick={() => setStatusDropdownOpen(v => !v)}
          className="w-full mt-1 text-sm font-semibold rounded px-2 py-1.5 outline-none border-0 cursor-pointer text-left"
          style={{ backgroundColor: status ? status.color + '2E' : undefined, color: status?.color }}>
          {status?.name || '—'}
          {task.approvalStatus === 'pending_approval' && (
            <span className="ml-2 text-[10px] font-normal text-purple-600 dark:text-purple-400">⏳ {t('taskDetail.sidebar.pendingApproval', '待簽核')}</span>
          )}
        </button>
        {statusDropdownOpen && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto">
            {statuses.map(s => (
              <button key={s.id} type="button"
                onClick={() => { handleStatusChange(s.id); setStatusDropdownOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 text-sm font-medium flex items-center gap-2 hover:bg-accent transition-colors ${s.id === task.statusId ? 'bg-accent' : ''}`}>
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                <span style={{ color: s.color }}>{s.name}</span>
              </button>
            ))}
          </div>
        )}
        </>}
      </div>
      {/* Requires Approval toggle */}
      {approvalsEnabled && <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.requiresApproval', '需要簽核')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={!!task.requiresApproval}
          aria-label={t('taskDetail.sidebar.requiresApproval', '需要簽核')}
          title={requirementLocked ? t('approvalCommand.requirementAdminOnly') : undefined}
          disabled={approvalSaving || task.approvalStatus === 'pending_approval' || !!task.currentApprovalId || requirementLocked}
          onClick={async () => {
            if (approvalSaving || requirementLocked) return;
            setApprovalSaving(true);
            try {
              const result = await runApproval({operation:'set_requirement',taskId:task.id,expectedRequiresApproval:!!task.requiresApproval,enabled:!task.requiresApproval});
              const patch = approvalTaskPatch(result.task);
              setAllTasks(prev => prev.map(card => card.id === task.id ? {...card,...patch} : card));
              if (visibleTask.current?.id === task.id) setSelectedTask({...visibleTask.current,...patch});
            } catch (error) {toast.error(approvalErrorText(error));}
            finally {setApprovalSaving(false);}
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${task.requiresApproval ? 'bg-purple-500' : 'bg-muted-foreground/30'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${task.requiresApproval ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
        </button>
      </div>}
      {approvalsEnabled && task.approvalStatus === 'pending_approval' && task.currentApprovalId && (
        <div className="mt-2 bg-purple-50 dark:bg-purple-900/10 rounded-lg p-2.5">
          <ApprovalProgress
            approvalRequestId={task.currentApprovalId}
            onAction={(result) => {
              if (result?.task) {
                const patch = approvalTaskPatch(result.task);
                setAllTasks(prev => prev.map(card => card.id === task.id ? {...card,...patch} : card));
                if (visibleTask.current?.id === task.id) setSelectedTask({...visibleTask.current,...patch});
              }
            }}
          />
        </div>
      )}
      {/* Approval History */}
      {approvalsEnabled && <ApprovalHistory key={`ah-${task.id}-${task.currentApprovalId ?? ''}`} taskId={task.id} requiresApproval={task.requiresApproval} users={users} statuses={statuses} />}
    </div>
  );

  fieldJsx['priority'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.priority', '優先級')}</label>
      <SearchableSelect value={task.priority} onChange={e => updateTask({ priority: e.target.value as Priority })}
        className="w-full mt-1 text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground">
        {getPriorityOptions().map(p => <option key={p.value} value={p.value}>{p.icon} {p.label}</option>)}
      </SearchableSelect>
    </div>
  );

  fieldJsx['assignee'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.assignee', '經辦人')}</label>
      <div className="mt-1">
        <UserSelect value={task.assigneeId || ''} onChange={v => {
          const newAssignee = users.find(u => u.id === v);
          const autoDept = getDepartment(newAssignee);
          const updates: Partial<import('@/types').Task> = { assigneeId: v || undefined };
          if (autoDept) updates.department = autoDept;
          updateTask(updates);
        }} allowEmpty emptyLabel={t('common.unassigned', '未指定')} />
        <TaskResponsibilityFields task={task} memberId={currentMemberId} role="assignee" onSaved={saveResponsibility} />
      </div>
    </div>
  );

  const derivedDept = (task.department as Department) || getDepartment(assignee);
  fieldJsx['department'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.department', '負責部門')}</label>
      <SearchableSelect value={derivedDept || ''} onChange={e => updateTask({ department: e.target.value || undefined })}
        className="w-full mt-1 text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground">
        <option value="">{t('common.unassigned', '未指定')}</option>
        {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
      </SearchableSelect>
    </div>
  );

  fieldJsx['reviewer'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.reviewer', '驗收人')}</label>
      <div className="mt-1">
        <UserSelect value={task.reviewerId || ''} onChange={v => updateTask({ reviewerId: v || undefined })} allowEmpty emptyLabel={t('common.unassigned', '未指定')} />
        <TaskResponsibilityFields task={task} memberId={currentMemberId} role="reviewer" onSaved={saveResponsibility} />
      </div>
    </div>
  );

  fieldJsx['tags'] = (
    <div className="relative" ref={tagDropdownRef}>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.tags', '標籤')}</label>
      {isTagLocked && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 rounded px-2 py-1">
          <span className="w-4 h-4 rounded-full flex-shrink-0 border-2" style={{ borderColor: tagFieldLocker!.color, background: tagFieldLocker!.avatar ? `url(${tagFieldLocker!.avatar}) center/cover` : tagFieldLocker!.color }} />
          <span>{tagFieldLocker!.name} {t('taskDetail.sidebar.editingTags', '正在編輯標籤')}</span>
        </div>
      )}
      <div className="mt-1.5">
        <div className="flex flex-wrap gap-1.5 mb-1.5 min-h-6">
          {(task.tagIds || []).map(tagId => {
            const tag = tags.find(t => t.id === tagId);
            if (!tag) return null;
            return (
              <span key={tag.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: tag.color }}>
                {tag.name}
                {!isTagLocked && (
                  <button onClick={() => removeTag(tag.id)} className="hover:opacity-80 transition-opacity flex-shrink-0"><X size={12} /></button>
                )}
              </span>
            );
          })}
        </div>
        <button type="button" onClick={() => tagDropdownOpen ? closeTagDropdown() : openTagDropdown()} disabled={isTagLocked}
          className={`w-full text-xs font-medium rounded px-2 py-1.5 flex items-center justify-between border border-border transition-colors text-foreground ${isTagLocked ? 'bg-muted/50 opacity-50 cursor-not-allowed' : 'bg-muted hover:bg-muted/80'}`}>
          <span>{t('taskDetail.sidebar.addTag', '新增標籤')}</span>
          <ChevronDown size={12} />
        </button>
        {tagDropdownOpen && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1 max-h-72 overflow-y-auto">
            <div className="flex items-center justify-between px-2.5 py-1 border-b border-border mb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{tagManageMode ? t('taskDetail.sidebar.manageTags', '管理標籤') : t('taskDetail.sidebar.selectTag', '選擇標籤')}</span>
              <button type="button" onClick={() => setTagManageMode(v => !v)} className="text-[10px] text-primary hover:underline">{tagManageMode ? t('taskDetail.sidebar.backToSelect', '返回選擇') : t('taskDetail.sidebar.manage', '管理')}</button>
            </div>
            {tagManageMode ? (
              <>
                {tags.map(tag => (
                  <div key={tag.id} className="flex items-center justify-between px-2.5 py-1.5 hover:bg-accent transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="text-xs font-medium" style={{ color: tag.color }}>{tag.name}</span>
                    </div>
                    <button type="button" onClick={() => deleteTag(tag.id)} className="text-muted-foreground hover:text-destructive transition-colors"><X size={12} /></button>
                  </div>
                ))}
                {tags.length === 0 && <p className="text-xs text-muted-foreground px-2.5 py-1.5">{t('taskDetail.sidebar.noTags', '尚無標籤')}</p>}
              </>
            ) : (
              <>
                {tags.filter(t => !task.tagIds?.includes(t.id)).map(tag => (
                  <button key={tag.id} type="button" onClick={() => addTag(tag.id)}
                    className="w-full text-left px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 hover:bg-accent transition-colors">
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                    <span style={{ color: tag.color }}>{tag.name}</span>
                  </button>
                ))}
                {tags.filter(t => !task.tagIds?.includes(t.id)).length === 0 && (
                  <p className="text-xs text-muted-foreground px-2.5 py-1.5">{t('taskDetail.sidebar.allTagsAdded', '所有標籤已添加')}</p>
                )}
              </>
            )}
            <div className="border-t border-border mt-1 px-2.5 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <input type="color" value={newTagColor} onChange={e => setNewTagColor(e.target.value)} className="w-5 h-5 rounded cursor-pointer border-0 p-0" />
                <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') createTag(); }}
                  placeholder={t('taskDetail.sidebar.newTagName', '新標籤名稱')}
                  className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary" />
                <button type="button" onClick={createTag} disabled={!newTagName.trim()}
                  className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors">
                  {t('taskDetail.sidebar.create', '建立')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Dependencies — displayed inline in main content area (TaskDependencyInline in TaskDetailContent)

  fieldJsx['creator'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.creator', '開卡人')}</label>
      <div className="flex items-center gap-1.5 mt-1">
        {creator && (
          <>
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white flex-shrink-0" style={{ backgroundColor: creator.color }}>{creator.avatar}</div>
            <span className="text-sm text-foreground">{creator.name}</span>
          </>
        )}
      </div>
    </div>
  );

  fieldJsx['startDate'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.startDate', '開始日')}</label>
      <DatePickerField
        value={task.startedAt}
        onChange={v => updateTask({ startedAt: v })}
        mode="start"
      />
    </div>
  );

  fieldJsx['dueDate'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.dueDate', '截止日')}</label>
      <TaskPlanningFields task={task} memberId={currentMemberId} users={users} onSaved={row => {
        const merge = (card: typeof task) => card.id !== row.id || (card.dueDateVersion ?? 0) > row.due_date_version ? card : { ...card, ...deadlineTaskFields(row) };
        setAllTasks(previous => previous.map(merge));
        setSelectedTask(previous => previous ? merge(previous) : previous);
      }} />
    </div>
  );

  fieldJsx['completedDate'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.sidebar.completedDate', '完成日')}</label>
      <div className="mt-1 text-sm">
        {task.completedAt
          ? <span style={{ color: '#36B37E' }} className="font-medium">{task.completedAt}</span>
          : <span className="text-muted-foreground/60 text-xs">{t('taskDetail.sidebar.completedAutoNote', '（改為完成時自動記錄）')}</span>}
      </div>
    </div>
  );

  fieldJsx['deployments'] = <TaskDeploymentSection detail={detail} />;

  fieldJsx['gitlabMR'] = (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">GitLab MR</label>
      <input type="url" value={task.gitlabUrl || ''} onChange={e => updateTask({ gitlabUrl: e.target.value || undefined })}
        placeholder={t('taskDetail.sidebar.pasteMrLink', '貼上 MR 連結')}
        className="w-full mt-1 text-xs rounded px-2 py-1.5 outline-none bg-muted text-foreground placeholder:text-muted-foreground/50" />
    </div>
  );

  const customFieldsContent = renderCustomFields();
  if (customFieldsContent) fieldJsx['customFields'] = customFieldsContent;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-3.5">
        {canLayout && (
          <div className="flex justify-end -mb-2">
            {isLayoutMode ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setIsLayoutMode(false);
                    supabase.from('team_settings').select('value').eq('key', 'sidebar_field_order').maybeSingle()
                      .then(({ data }) => detail.setSidebarFieldOrder(data?.value && Array.isArray(data.value) ? (data.value as string[]) : SIDEBAR_DEFAULT_ORDER));
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent transition-colors">
                  {t('taskDetail.sidebar.cancel', '取消')}
                </button>
                <button onClick={saveSidebarFieldOrder} disabled={layoutSaving}
                  className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors">
                  {layoutSaving ? t('taskDetail.sidebar.saving', '儲存中...') : t('taskDetail.sidebar.saveLayout', '儲存排版')}
                </button>
              </div>
            ) : (
              <button onClick={() => setIsLayoutMode(true)}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-primary transition-colors" title={t('taskDetail.sidebar.customLayout', '自訂欄位排版順序')}>
                <GripVertical size={10} />{t('taskDetail.sidebar.layout', '排版')}
              </button>
            )}
          </div>
        )}
        {fieldOrder.map((fieldId, idx) => {
          const content = fieldJsx[fieldId];
          if (!content) return null;
          if (isLayoutMode) {
            return (
              <div key={fieldId} draggable
                onDragStart={e => handleFieldDragStart(e, idx)}
                onDragOver={e => handleFieldDragOver(e, idx)}
                onDrop={handleFieldDrop}
                onDragEnd={() => { /* clear drag state via handleFieldDrop */ }}
                className={`relative rounded px-2 pt-3 pb-2 border-2 cursor-grab active:cursor-grabbing transition-colors ${dragOverFieldIdx === idx ? 'border-primary bg-primary/5' : 'border-dashed border-border/50 hover:border-border'}`}>
                <div className="absolute top-0.5 right-1 text-muted-foreground/40 pointer-events-none"><GripVertical size={12} /></div>
                <div className="pointer-events-none select-none">{content}</div>
              </div>
            );
          }
          return <div key={fieldId}>{content}</div>;
        })}
      </div>

      {showCustomFieldManager && (
        <CustomFieldManager projectId={task.projectId} onClose={() => setShowCustomFieldManager(false)} />
      )}
    </>
  );
};

export default TaskSidebarFields;
