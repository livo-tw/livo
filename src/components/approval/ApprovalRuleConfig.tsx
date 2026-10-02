import { ProjectCheckboxList } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, Pencil, ChevronRight, ClipboardCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { toast } from 'sonner';
import { useApprovalRules } from '@/hooks/useApprovalRules';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';
import type { ApprovalRuleStep } from '@/lib/approvalQueries';
import ApprovalRuleDialog, { type StepDraft } from './ApprovalRuleDialog';

export default function ApprovalRuleConfig() {
  const { t } = useTranslation();

  const ROLE_OPTIONS = [
    { value: 'admin', label: t('role.admin') },
    { value: 'super_admin', label: t('role.superAdmin') },
    { value: 'member', label: t('role.member') },
  ];
  const { permissions, currentMemberId } = useAuthContext();
  const { allProjects, productLines } = useProjectContext();
  const { statuses } = useTaskContext();
  const { users } = useMemberContext();
  const { rules, stepsMap, loading, fetchRulesForProjects, createRule, updateRuleWithSteps, deleteRule } = useApprovalRules();

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addRuleProjectIds, setAddRuleProjectIds] = useState<string[]>([]);
  const [fromStatus, setFromStatus] = useState('');
  const [toStatus, setToStatus] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([
    { approver_type: 'role', approver_role: 'admin', approver_user_id: null, allow_delegate: false, timeout_hours: null, timeout_action: null, step_order: 1 },
  ]);
  const [saving, setSaving] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  const addDialogRef = useFocusTrap(showAddDialog);

  const activeProjects = useMemo(() => allProjects.filter(p => !p.isArchived), [allProjects]);

  // Initialize with all projects selected
  useEffect(() => {
    if (activeProjects.length > 0 && selectedProjectIds.length === 0) {
      setSelectedProjectIds(activeProjects.map(p => p.id));
    }
  }, [activeProjects, selectedProjectIds.length]);

  // Fetch rules for all selected projects
  useEffect(() => {
    fetchRulesForProjects(selectedProjectIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectIds.join(','), fetchRulesForProjects]);

  const isAllSelected = selectedProjectIds.length === activeProjects.length;

  const toggleProject = useCallback((projectId: string) => {
    setSelectedProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
    );
  }, []);

  const toggleAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedProjectIds([]);
    } else {
      setSelectedProjectIds(activeProjects.map(p => p.id));
    }
  }, [isAllSelected, activeProjects]);

  const projectNameMap = useMemo(() => new Map(allProjects.map(p => [p.id, p.name])), [allProjects]);

  // Filter rules by selected projects
  const filteredRules = useMemo(() =>
    rules.filter(r => selectedProjectIds.includes(r.project_id)),
    [rules, selectedProjectIds]
  );

  const resetDialog = () => {
    setFromStatus('');
    setToStatus('');
    setAddRuleProjectIds([]);
    setEditingRuleId(null);
    setSteps([{ approver_type: 'role', approver_role: 'admin', approver_user_id: null, allow_delegate: false, timeout_hours: null, timeout_action: null, step_order: 1 }]);
    setShowAddDialog(false);
  };

  const openEditDialog = (ruleId: string) => {
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) return;
    setEditingRuleId(ruleId);
    setAddRuleProjectIds([rule.project_id]);
    setFromStatus(rule.from_status);
    setToStatus(rule.to_status);
    const ruleSteps = stepsMap[ruleId] ?? [];
    if (ruleSteps.length > 0) {
      setSteps(ruleSteps.map(s => ({
        approver_type: s.approver_type,
        approver_role: s.approver_role,
        approver_user_id: s.approver_user_id,
        allow_delegate: s.allow_delegate,
        timeout_hours: s.timeout_hours,
        timeout_action: s.timeout_action,
        step_order: s.step_order,
      })));
    } else {
      setSteps([{ approver_type: 'role', approver_role: 'admin', approver_user_id: null, allow_delegate: false, timeout_hours: null, timeout_action: null, step_order: 1 }]);
    }
    setShowAddDialog(true);
  };


  const handleSave = async () => {
    if (addRuleProjectIds.length === 0 || !fromStatus || !toStatus || fromStatus === toStatus) return;
    const invalidStep = steps.find(s => s.approver_type === 'user' && !s.approver_user_id);
    if (invalidStep) {
      toast.error(t('approval.ruleConfig.invalidStep', { step: invalidStep.step_order }));
      return;
    }
    setSaving(true);
    try {
      const stepsToSave: Omit<ApprovalRuleStep, 'id' | 'created_at' | 'rule_id'>[] = steps.map(s => ({
        step_order: s.step_order,
        approver_type: s.approver_type,
        approver_role: s.approver_type === 'role' ? s.approver_role : null,
        approver_user_id: s.approver_type === 'user' ? s.approver_user_id : null,
        allow_delegate: s.allow_delegate,
        timeout_hours: s.timeout_hours,
        timeout_action: s.timeout_action,
      }));

      if (editingRuleId) {
        // Edit mode: single project
        await updateRuleWithSteps(editingRuleId, {
          project_id: addRuleProjectIds[0],
          from_status: fromStatus,
          to_status: toStatus,
        }, stepsToSave);
        if (currentMemberId) {
          logActivity(currentMemberId, 'approval_rule_updated', t('activityLog.approvalRuleUpdated', { from: getStatusName(fromStatus), to: getStatusName(toStatus) }), undefined, undefined, 'system');
        }
      } else {
        // Create mode: one rule per selected project
        for (const pid of addRuleProjectIds) {
          await createRule(pid, fromStatus, toStatus, stepsToSave);
          if (!selectedProjectIds.includes(pid)) {
            setSelectedProjectIds(prev => [...prev, pid]);
          }
        }
        if (currentMemberId) {
          const projectNames = addRuleProjectIds.map(id => projectNameMap.get(id) ?? id).join(', ');
          logActivity(currentMemberId, 'approval_rule_created', t('activityLog.approvalRuleCreated', { projects: projectNames, from: getStatusName(fromStatus), to: getStatusName(toStatus) }), undefined, undefined, 'system');
        }
      }
      resetDialog();
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const getStatusName = (id: string) => statuses.find(s => s.id === id)?.name ?? id;
  const getUserName = (id: string | null) => id ? (users.find(u => u.id === id)?.name ?? id) : '—';

  const canManage = permissions.canEditProject;

  // Close dropdown on outside click
  useEffect(() => {
    if (!showProjectDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-project-dropdown]')) {
        setShowProjectDropdown(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [showProjectDropdown]);

  return (
    <div className="space-y-5">
      {/* Project filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm font-medium text-foreground flex-shrink-0">{t('approval.ruleConfig.project')}</label>
        <div className="relative" data-project-dropdown>
          <button
            onClick={() => setShowProjectDropdown(!showProjectDropdown)}
            className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground min-w-[220px] text-left flex items-center justify-between gap-2 hover:border-primary/40 transition-colors"
          >
            <span className="truncate">
              {selectedProjectIds.length === 0
                ? t('approval.ruleConfig.selectProject')
                : isAllSelected
                  ? t('approval.ruleConfig.allProjects')
                  : t('approval.ruleConfig.projectCount', { count: selectedProjectIds.length })}
            </span>
            <ChevronRight size={12} className={`text-muted-foreground transition-transform ${showProjectDropdown ? 'rotate-90' : ''}`} />
          </button>
          {showProjectDropdown && (
            <div className="absolute left-0 top-full mt-1 w-72 bg-card rounded-lg border border-border shadow-lg z-50 py-1 max-h-60 overflow-y-auto">
              <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors border-b border-border">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleAll}
                  className="rounded border-border accent-primary"
                />
                <span className="font-medium text-foreground">{t('approval.ruleConfig.selectAll')}</span>
              </label>
              <ProjectCheckboxList groups={groupProjectsByLine(productLines, activeProjects)} selected={selectedProjectIds} onToggle={toggleProject} />
            </div>
          )}
        </div>
        {canManage && (
          <button
            onClick={() => setShowAddDialog(true)}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Plus size={14} />
            {t('approval.ruleConfig.addRule')}
          </button>
        )}
      </div>

      {/* Rules list */}
      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">{t('common.loading')}</div>
      ) : filteredRules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-border rounded-lg bg-muted/20">
          <ClipboardCheck size={32} className="text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('approval.ruleConfig.noRules')}</p>
          {canManage && (
            <button
              onClick={() => setShowAddDialog(true)}
              className="mt-3 text-sm text-primary hover:text-primary/80 font-medium"
            >
              {t('approval.ruleConfig.addRule')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRules.map(rule => {
            const ruleSteps = stepsMap[rule.id] ?? [];
            return (
              <div key={rule.id} className="flex items-start justify-between gap-3 bg-muted/30 border border-border rounded-lg px-4 py-3 hover:border-primary/30 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary font-semibold">{projectNameMap.get(rule.project_id) ?? '—'}</span>
                    <span className="text-muted-foreground">{getStatusName(rule.from_status)}</span>
                    <ChevronRight size={12} className="text-muted-foreground flex-shrink-0" />
                    <span className="text-foreground font-semibold">{getStatusName(rule.to_status)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {ruleSteps.map((step, i) => (
                      <span key={step.id} className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                        {i + 1}. {step.approver_type === 'role'
                          ? ROLE_OPTIONS.find(r => r.value === step.approver_role)?.label ?? step.approver_role
                          : getUserName(step.approver_user_id)}
                      </span>
                    ))}
                    {ruleSteps.length === 0 && (
                      <span className="text-xs text-muted-foreground/50 italic">{t('approval.ruleConfig.noLayers')}</span>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEditDialog(rule.id)}
                      className="text-muted-foreground hover:text-primary p-1.5 rounded-md hover:bg-accent transition-colors"
                      aria-label={t('approval.ruleConfig.editRule')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(t('approval.ruleConfig.deleteConfirm'))) {
                          deleteRule(rule.id);
                          if (currentMemberId) {
                            logActivity(currentMemberId, 'approval_rule_deleted', t('activityLog.approvalRuleDeleted', { from: getStatusName(rule.from_status), to: getStatusName(rule.to_status) }), undefined, undefined, 'system');
                          }
                        }
                      }}
                      className="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-accent transition-colors"
                      aria-label={t('approval.ruleConfig.deleteRule')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit rule dialog */}
      <ApprovalRuleDialog
        show={showAddDialog}
        editingRuleId={editingRuleId}
        addRuleProjectIds={addRuleProjectIds}
        setAddRuleProjectIds={setAddRuleProjectIds}
        fromStatus={fromStatus}
        setFromStatus={setFromStatus}
        toStatus={toStatus}
        setToStatus={setToStatus}
        steps={steps}
        setSteps={setSteps}
        saving={saving}
        activeProjects={activeProjects}
        statuses={statuses}
        users={users}
        onSave={handleSave}
        onClose={resetDialog}
        addDialogRef={addDialogRef}
      />
    </div>
  );
}
