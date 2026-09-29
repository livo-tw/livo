import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { generateId } from '@/lib/generateId';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useProjectContext } from '@/context/ProjectContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { logActivity } from '@/lib/activityLog';
import { Plus, Trash2, GripVertical, Pencil, Check, X, Lock, Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { useStatusTransitionRules } from '@/hooks/useStatusTransitionRules';
import { useApprovalRules } from '@/hooks/useApprovalRules';
import { useMemberContext } from '@/context/MemberContext';
import StatusTransitionRuleEditor from '@/components/StatusTransitionRuleEditor';

const StatusManageView = ({ embedded }: { embedded?: boolean }) => {
  const { t } = useTranslation();
  const { statuses, refreshStatuses } = useTaskContext();
  const { permissions, currentMemberId } = useAuthContext();
  const { hasFeature } = useLicense();
  const { allProjects } = useProjectContext();
  const isMobile = useIsMobile();
  const { viewers, trackEditing, isLockedBy, acquireLock, releaseLock } = usePresenceLock('status-manage-presence', !hasFeature('realtime-collab'));
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { rules, addRule, removeRule } = useStatusTransitionRules();
  const { rules: approvalRules, stepsMap: approvalStepsMap, fetchRulesForProjects, createRule: createApprovalRule, updateRuleWithSteps: updateApprovalRule, deleteRule: deleteApprovalRule } = useApprovalRules();
  const { users } = useMemberContext();

  // Fetch approval rules for all active projects
  const activeProjects = useMemo(() => allProjects.filter(p => !p.isArchived), [allProjects]);
  const activeProjectIds = useMemo(() => activeProjects.map(p => p.id), [activeProjects]);
  useEffect(() => {
    if (activeProjectIds.length > 0) fetchRulesForProjects(activeProjectIds);
  }, [activeProjectIds.join(','), fetchRulesForProjects]);

  const projectNameMap = useMemo(() => new Map(allProjects.map(p => [p.id, p.name])), [allProjects]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#6B778C');
  const [showAdd, setShowAdd] = useState(false);

  if (!permissions.canManageStatuses) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">{t('error.noPermission')}</div>;
  }

  const COLORS = ['#0065FF', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#E774BB', '#6B778C', '#97A0AF', '#172B4D'];

  const handleSave = async (id: string) => {
    if (!editName.trim()) {
      // Validation failed — still release the lock and exit edit mode
      const prevId = editingId;
      setEditingId(null);
      releaseLock(prevId ? `status-${prevId}` : undefined);
      return;
    }
    const oldStatus = statuses.find(s => s.id === id);
    const { error } = await supabase.from('statuses').update({ name: editName.trim(), color: editColor }).eq('id', id);
    if (error) toast.error(t('error.updateFailed') + error.message);
    else {
      toast.success(t('statusManage.updated'));
      if (currentMemberId && oldStatus && oldStatus.name !== editName.trim()) {
        await logActivity(currentMemberId, 'update_status', t('statusManage.activityUpdated', { oldName: oldStatus.name, newName: editName.trim() }), undefined, undefined, 'status');
      }
      await refreshStatuses();
    }
    setEditingId(null);
    releaseLock(editingId ? `status-${editingId}` : undefined);
  };

  const startEditStatus = async (id: string) => {
    const { acquired, lockerName } = await acquireLock(`status-${id}`);
    if (!acquired) { toast.error(t('error.userEditing', { name: lockerName || t('common.other') })); return; }
    const s = statuses.find(s => s.id === id);
    if (!s) { await releaseLock(`status-${id}`); return; }
    setEditingId(id);
    setEditName(s.name);
    setEditColor(s.color);
  };

  const cancelEdit = () => {
    const prevId = editingId;
    setEditingId(null);
    releaseLock(prevId ? `status-${prevId}` : undefined);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm({ description: t('statusManage.deleteConfirm', { name }), title: t('project.deleteTitle'), destructive: true }))) return;
    const { error } = await supabase.from('statuses').delete().eq('id', id);
    if (error) toast.error(t('error.deleteFailed') + error.message);
    else {
      toast.success(t('statusManage.deleted'));
      if (currentMemberId) await logActivity(currentMemberId, 'delete_status', t('statusManage.activityDeleted', { name }), undefined, undefined, 'status');
      await refreshStatuses();
    }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    const maxOrder = Math.max(...statuses.map(s => s.sortOrder), 0);
    const { error } = await supabase.from('statuses').insert({
      id: generateId('s'),
      name: newName.trim(),
      color: newColor,
      sort_order: maxOrder + 1,
      is_done: false,
      auto_start: false,
      auto_done: false,
    });
    if (error) toast.error(t('error.createFailed') + error.message);
    else {
      toast.success(t('statusManage.added'));
      if (currentMemberId) await logActivity(currentMemberId, 'add_status', t('statusManage.activityCreated', { name: newName.trim() }), undefined, undefined, 'status');
      setNewName(''); setShowAdd(false); await refreshStatuses();
    }
  };

  const toggleBool = async (id: string, field: 'is_done' | 'auto_start' | 'auto_done', current: boolean) => {
    const { error } = await supabase.from('statuses').update({ [field]: !current }).eq('id', id);
    if (error) toast.error(t('error.updateFailed'));
    else await refreshStatuses();
  };

  return (
    <>
    <div className={embedded ? '' : 'flex-1 overflow-y-auto'}>
      <div className={embedded ? '' : 'px-4 py-6 md:px-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <div className="flex items-center gap-2">
            <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('statusManage.title')}</h1>
            {viewers.length > 0 && (
              <div className="flex items-center gap-1">
                {viewers.map(v => (
                  <div key={v.memberId} className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold text-white border-2 border-card -ml-1 first:ml-0" style={{ backgroundColor: v.color }} title={t('presence.viewing', { name: v.name })}>
                    {v.avatar}
                  </div>
                ))}
                <span className="text-xs text-muted-foreground ml-1">{t('statusManage.viewing')}</span>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs md:text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus size={14} />
            {t('common.add')}
          </button>
        </div>

        {showAdd && (
          <div className="mb-4 p-3 md:p-4 border border-border rounded-lg bg-card space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">{t('statusManage.nameLabel')}</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('statusManage.namePlaceholder')}
                className="w-full border border-border rounded px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">{t('statusManage.colorLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {COLORS.map(c => (
                  <button key={c} onClick={() => setNewColor(c)} className="w-7 h-7 rounded-md transition-all"
                    style={{ backgroundColor: c, border: newColor === c ? '3px solid hsl(var(--foreground))' : '2px solid transparent' }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAdd} className="px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground">{t('common.add')}</button>
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded text-xs font-medium text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="mb-4 p-3 border border-border rounded-lg bg-muted/30 space-y-1.5">
          <p className="text-sm font-semibold text-foreground mb-1">{t('statusManage.optionsLabel')}</p>
          <p className="text-[13px] text-muted-foreground"><strong>{t('statusManage.isDone')}</strong> — {t('statusManage.isDoneHint')}</p>
          <p className="text-[13px] text-muted-foreground"><strong>{t('statusManage.autoStart')}</strong> — {t('statusManage.autoStartHint')}</p>
          <p className="text-[13px] text-muted-foreground"><strong>{t('statusManage.autoDone')}</strong> — {t('statusManage.autoDoneHint')}</p>
        </div>

        <div className="space-y-1">
          {statuses.map((s, i) => (
            <div key={s.id} className="p-2.5 md:p-3 border border-border rounded-lg bg-card group hover:border-primary/30 transition-colors">
              {isMobile ? (
                // Mobile: stacked layout
                editingId === s.id ? (
                  <div className="space-y-2">
                    <input value={editName} onChange={e => setEditName(e.target.value)}
                      className="w-full border border-border rounded px-2 py-1 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" autoFocus />
                    <div className="flex gap-1 flex-wrap">
                      {COLORS.map(c => (
                        <button key={c} onClick={() => setEditColor(c)} className="w-5 h-5 rounded"
                          style={{ backgroundColor: c, border: editColor === c ? '2px solid hsl(var(--foreground))' : '1px solid transparent' }} />
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleSave(s.id)} className="p-1 text-status-done hover:bg-status-done/10 rounded"><Check size={14} /></button>
                      <button onClick={cancelEdit} className="p-1 text-muted-foreground hover:bg-accent rounded"><X size={14} /></button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{i + 1}</span>
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: s.color }}>{s.name}</span>
                        {(() => { const locker = isLockedBy(`status-${s.id}`); return locker ? <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1"><Lock size={12} /> {t('statusManage.editingStatus', { name: locker.name })}</span> : null; })()}
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEditStatus(s.id)} className="p-1 text-muted-foreground hover:text-primary rounded">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleDelete(s.id, s.name)} className="p-1 text-muted-foreground hover:text-destructive rounded">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                        <input type="checkbox" checked={s.isDone} onChange={() => toggleBool(s.id, 'is_done', s.isDone)} className="rounded" />
                        {t('statusManage.isDone')}
                      </label>
                      <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                        <input type="checkbox" checked={s.autoStart} onChange={() => toggleBool(s.id, 'auto_start', s.autoStart)} className="rounded" />
                        {t('statusManage.autoStart')}
                      </label>
                      <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                        <input type="checkbox" checked={s.autoDone} onChange={() => toggleBool(s.id, 'auto_done', s.autoDone)} className="rounded" />
                        {t('statusManage.autoDone')}
                      </label>
                    </div>
                    <StatusTransitionRuleEditor
                      targetStatus={s}
                      allStatuses={statuses}
                      rules={rules}
                      onAddRule={addRule}
                      onRemoveRule={removeRule}
                      approvalRules={approvalRules.filter(ar => ar.to_status === s.id)}
                      approvalStepsMap={approvalStepsMap}
                      projectNameMap={projectNameMap}
                      onCreateApprovalRule={createApprovalRule}
                      onUpdateApprovalRule={updateApprovalRule}
                      onDeleteApprovalRule={deleteApprovalRule}
                      activeProjects={activeProjects}
                      users={users}
                    />
                  </div>
                )
              ) : (
                // Desktop: row layout
                <>
                  <div className="flex items-center gap-3">
                    <GripVertical size={14} className="text-muted-foreground/40" />
                    <span className="text-xs text-muted-foreground w-5">{i + 1}</span>
                    {editingId === s.id ? (
                      <>
                        <input value={editName} onChange={e => setEditName(e.target.value)}
                          className="flex-1 border border-border rounded px-2 py-1 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" autoFocus />
                        <div className="flex gap-1">
                          {COLORS.map(c => (
                            <button key={c} onClick={() => setEditColor(c)} className="w-5 h-5 rounded"
                              style={{ backgroundColor: c, border: editColor === c ? '2px solid hsl(var(--foreground))' : '1px solid transparent' }} />
                          ))}
                        </div>
                        <button onClick={() => handleSave(s.id)} className="p-1 text-status-done hover:bg-status-done/10 rounded"><Check size={14} /></button>
                        <button onClick={cancelEdit} className="p-1 text-muted-foreground hover:bg-accent rounded"><X size={14} /></button>
                      </>
                    ) : (
                      <>
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium text-white min-w-[60px] text-center" style={{ backgroundColor: s.color }}>{s.name}</span>
                        {(() => { const locker = isLockedBy(`status-${s.id}`); return locker ? <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse ml-2 flex items-center gap-1"><Lock size={12} /> {t('statusManage.editingStatus', { name: locker.name })}</span> : null; })()}
                        <div className="flex-1" />
                        <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                          <input type="checkbox" checked={s.isDone} onChange={() => toggleBool(s.id, 'is_done', s.isDone)} className="rounded" /> {t('statusManage.isDone')}
                          <Tooltip><TooltipTrigger asChild><Info size={12} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="top"><p className="text-xs max-w-[200px]">{t('statusManage.isDoneHint')}</p></TooltipContent></Tooltip>
                        </label>
                        <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                          <input type="checkbox" checked={s.autoStart} onChange={() => toggleBool(s.id, 'auto_start', s.autoStart)} className="rounded" /> {t('statusManage.autoStart')}
                          <Tooltip><TooltipTrigger asChild><Info size={12} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="top"><p className="text-xs max-w-[200px]">{t('statusManage.autoStartHint')}</p></TooltipContent></Tooltip>
                        </label>
                        <label className="flex items-center gap-1 text-[13px] text-muted-foreground">
                          <input type="checkbox" checked={s.autoDone} onChange={() => toggleBool(s.id, 'auto_done', s.autoDone)} className="rounded" /> {t('statusManage.autoDone')}
                          <Tooltip><TooltipTrigger asChild><Info size={12} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="top"><p className="text-xs max-w-[200px]">{t('statusManage.autoDoneHint')}</p></TooltipContent></Tooltip>
                        </label>
                        <button onClick={() => startEditStatus(s.id)}
                          className="p-1 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-all rounded">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleDelete(s.id, s.name)}
                          className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all rounded">
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  {editingId !== s.id && (
                    <StatusTransitionRuleEditor
                      targetStatus={s}
                      allStatuses={statuses}
                      rules={rules}
                      onAddRule={addRule}
                      onRemoveRule={removeRule}
                      approvalRules={approvalRules.filter(ar => ar.to_status === s.id)}
                      approvalStepsMap={approvalStepsMap}
                      projectNameMap={projectNameMap}
                      onCreateApprovalRule={createApprovalRule}
                      onUpdateApprovalRule={updateApprovalRule}
                      onDeleteApprovalRule={deleteApprovalRule}
                      activeProjects={activeProjects}
                      users={users}
                    />
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
    {ConfirmDialog}
    </>
  );
};

export default StatusManageView;