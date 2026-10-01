import { useUIContext } from '@/context/UIContext';
import { useState } from 'react';
import { ChevronDown, ChevronRight, ShieldCheck, Plus, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { Status } from '@/types';
import type { StatusTransitionRule } from '@/hooks/useStatusTransitionRules';
import type { ApprovalRule, ApprovalRuleStep } from '@/lib/approvalQueries';
import ApprovalRuleDialog, { type StepDraft } from '@/components/approval/ApprovalRuleDialog';

const DEFAULT_STEP: StepDraft = {
  approver_type: 'role', approver_role: 'admin', approver_user_id: null,
  allow_delegate: false, timeout_hours: null, timeout_action: null, step_order: 1,
};

interface StatusTransitionRuleEditorProps {
  targetStatus: Status;
  allStatuses: Status[];
  rules: StatusTransitionRule[];
  onAddRule: (targetStatusId: string, requiredStatusId: string) => Promise<boolean>;
  onRemoveRule: (ruleId: string) => Promise<boolean>;
  // Approval data (read)
  approvalRules?: ApprovalRule[];
  approvalStepsMap?: Record<string, ApprovalRuleStep[]>;
  projectNameMap?: Map<string, string>;
  // Approval CRUD
  onCreateApprovalRule?: (projectId: string, fromStatus: string, toStatus: string, steps: Omit<ApprovalRuleStep, 'id' | 'created_at' | 'rule_id'>[]) => Promise<ApprovalRule | null>;
  onUpdateApprovalRule?: (ruleId: string, ruleData: Partial<ApprovalRule>, newSteps: Omit<ApprovalRuleStep, 'id' | 'created_at' | 'rule_id'>[]) => Promise<ApprovalRule | null>;
  onDeleteApprovalRule?: (ruleId: string) => Promise<boolean>;
  activeProjects?: { id: string; name: string }[];
  users?: { id: string; name: string; isActive: boolean }[];
}

const StatusTransitionRuleEditor = ({
  targetStatus,
  allStatuses,
  rules,
  onAddRule,
  onRemoveRule,
  approvalRules,
  approvalStepsMap,
  projectNameMap,
  onCreateApprovalRule,
  onUpdateApprovalRule,
  onDeleteApprovalRule,
  activeProjects,
  users,
}: StatusTransitionRuleEditorProps) => {
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // Approval dialog state
  const [showDialog, setShowDialog] = useState(false);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [dialogProjectIds, setDialogProjectIds] = useState<string[]>([]);
  const [dialogFromStatus, setDialogFromStatus] = useState('');
  const [dialogToStatus, setDialogToStatus] = useState('');
  const [dialogSteps, setDialogSteps] = useState<StepDraft[]>([{ ...DEFAULT_STEP }]);
  const [savingApproval, setSavingApproval] = useState(false);
  const dialogRef = useFocusTrap(showDialog);

  const otherStatuses = allStatuses.filter(s => s.id !== targetStatus.id);
  const targetRules = rules.filter(r => r.targetStatusId === targetStatus.id);
  const requiredIds = new Set(targetRules.map(r => r.requiredStatusId));

  const approvalCount = approvalsEnabled ? approvalRules?.length ?? 0 : 0;
  const totalBadge = targetRules.length + approvalCount;
  const hasCrud = approvalsEnabled && onCreateApprovalRule && onUpdateApprovalRule && onDeleteApprovalRule && activeProjects && users;

  const handleToggle = async (statusId: string) => {
    if (saving) return;
    setSaving(statusId);
    if (requiredIds.has(statusId)) {
      const rule = targetRules.find(r => r.requiredStatusId === statusId);
      if (rule) await onRemoveRule(rule.id);
    } else {
      await onAddRule(targetStatus.id, statusId);
    }
    setSaving(null);
  };

  // ── Approval dialog handlers ──────────────────────────────────────────────

  const openAddDialog = () => {
    setEditingApprovalId(null);
    setDialogProjectIds([]);
    setDialogFromStatus('');
    setDialogToStatus(targetStatus.id);
    setDialogSteps([{ ...DEFAULT_STEP }]);
    setShowDialog(true);
  };

  const openEditDialog = (rule: ApprovalRule) => {
    setEditingApprovalId(rule.id);
    setDialogProjectIds([rule.project_id]);
    setDialogFromStatus(rule.from_status);
    setDialogToStatus(rule.to_status);
    const steps = approvalStepsMap?.[rule.id] ?? [];
    if (steps.length > 0) {
      setDialogSteps(steps.map(s => ({
        approver_type: s.approver_type,
        approver_role: s.approver_role,
        approver_user_id: s.approver_user_id,
        allow_delegate: s.allow_delegate,
        timeout_hours: s.timeout_hours,
        timeout_action: s.timeout_action,
        step_order: s.step_order,
      })));
    } else {
      setDialogSteps([{ ...DEFAULT_STEP }]);
    }
    setShowDialog(true);
  };

  const resetDialog = () => {
    setShowDialog(false);
    setEditingApprovalId(null);
    setDialogProjectIds([]);
    setDialogFromStatus('');
    setDialogToStatus('');
    setDialogSteps([{ ...DEFAULT_STEP }]);
  };

  const handleSaveApproval = async () => {
    if (!hasCrud) return;
    if (dialogProjectIds.length === 0 || !dialogFromStatus || !dialogToStatus || dialogFromStatus === dialogToStatus) return;

    const invalidStep = dialogSteps.find(s => s.approver_type === 'user' && !s.approver_user_id);
    if (invalidStep) {
      toast.error(t('approval.ruleConfig.invalidStep', { step: invalidStep.step_order }));
      return;
    }

    setSavingApproval(true);
    try {
      const stepsToSave = dialogSteps.map(s => ({
        step_order: s.step_order,
        approver_type: s.approver_type,
        approver_role: s.approver_type === 'role' ? s.approver_role : null,
        approver_user_id: s.approver_type === 'user' ? s.approver_user_id : null,
        allow_delegate: s.allow_delegate,
        timeout_hours: s.timeout_hours,
        timeout_action: s.timeout_action,
      }));

      if (editingApprovalId) {
        await onUpdateApprovalRule(editingApprovalId, {
          project_id: dialogProjectIds[0],
          from_status: dialogFromStatus,
          to_status: dialogToStatus,
        }, stepsToSave);
      } else {
        for (const pid of dialogProjectIds) {
          await onCreateApprovalRule(pid, dialogFromStatus, dialogToStatus, stepsToSave);
        }
      }
      resetDialog();
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    } finally {
      setSavingApproval(false);
    }
  };

  const handleDeleteApproval = async (ruleId: string) => {
    if (!onDeleteApprovalRule) return;
    if (!window.confirm(t('approval.ruleConfig.deleteConfirm'))) return;
    await onDeleteApprovalRule(ruleId);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('statusTransition.title')}
        {totalBadge > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium">
            {totalBadge}
          </span>
        )}
        {approvalCount > 0 && (
          <ShieldCheck size={12} className="ml-0.5 text-amber-600" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 p-3 border border-border rounded-lg bg-muted/20 space-y-3">
          {/* Transition prerequisite rules */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">{t('statusTransition.prerequisiteDesc')}</p>
            {otherStatuses.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">{t('statusTransition.noOtherStatuses')}</p>
            ) : (
              <div className="space-y-1.5">
                {otherStatuses.map(s => (
                  <label key={s.id} className="flex items-center gap-2 cursor-pointer group/row">
                    <input
                      type="checkbox"
                      checked={requiredIds.has(s.id)}
                      disabled={saving === s.id}
                      onChange={() => handleToggle(s.id)}
                      className="rounded"
                    />
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[11px] font-medium text-white"
                      style={{ backgroundColor: s.color }}
                    >
                      {s.name}
                    </span>
                    {saving === s.id && (
                      <span className="text-[10px] text-muted-foreground animate-pulse">{t('common.saving')}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            {targetRules.length === 0 && otherStatuses.length > 0 && (
              <p className="text-[11px] text-muted-foreground/60 mt-1">{t('statusTransition.noPrerequisites')}</p>
            )}
          </div>

          {/* Approval rules section — always show when CRUD available */}
          {hasCrud && (
            <div className="pt-2 border-t border-border/50">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <ShieldCheck size={12} className="text-amber-600" />
                  {t('statusTransition.approvalSection')}
                </p>
                <button
                  onClick={openAddDialog}
                  className="text-[11px] text-primary hover:text-primary/80 flex items-center gap-0.5 font-medium"
                >
                  <Plus size={11} />
                  {t('statusTransition.addApprovalRule')}
                </button>
              </div>

              {approvalRules && approvalRules.length > 0 ? (
                <div className="space-y-1.5">
                  {approvalRules.map(ar => {
                    const steps = approvalStepsMap?.[ar.id] ?? [];
                    const fromName = allStatuses.find(s => s.id === ar.from_status)?.name ?? ar.from_status;
                    const projName = projectNameMap?.get(ar.project_id);
                    return (
                      <div key={ar.id} className="flex items-center justify-between gap-2 py-1 group/rule">
                        <div className="flex items-center gap-1.5 flex-wrap text-[11px] min-w-0">
                          {projName && (
                            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium flex-shrink-0">
                              {projName}
                            </span>
                          )}
                          <span className="text-muted-foreground">{t('statusTransition.approvalFrom')}</span>
                          <span className="font-medium text-foreground">{fromName}</span>
                          <ChevronRight size={10} className="text-muted-foreground flex-shrink-0" />
                          <span className="font-medium text-foreground">{targetStatus.name}</span>
                          {steps.length > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium flex-shrink-0">
                              {t('statusTransition.approvalSteps', { count: steps.length })}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/rule:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEditDialog(ar)}
                            className="p-1 text-muted-foreground hover:text-primary rounded transition-colors"
                            title={t('common.edit')}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={() => handleDeleteApproval(ar.id)}
                            className="p-1 text-muted-foreground hover:text-destructive rounded transition-colors"
                            title={t('common.delete')}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/60">{t('statusTransition.noApprovalRules')}</p>
              )}
            </div>
          )}

          {/* Read-only fallback when no CRUD available */}
          {approvalsEnabled && !hasCrud && approvalRules && approvalRules.length > 0 && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <ShieldCheck size={12} className="text-amber-600" />
                {t('statusTransition.approvalSection')}
              </p>
              <div className="space-y-1.5">
                {approvalRules.map(ar => {
                  const steps = approvalStepsMap?.[ar.id] ?? [];
                  const fromName = allStatuses.find(s => s.id === ar.from_status)?.name ?? ar.from_status;
                  const projName = projectNameMap?.get(ar.project_id);
                  return (
                    <div key={ar.id} className="flex items-center gap-1.5 flex-wrap text-[11px]">
                      {projName && (
                        <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{projName}</span>
                      )}
                      <span className="text-muted-foreground">{t('statusTransition.approvalFrom')}</span>
                      <span className="font-medium text-foreground">{fromName}</span>
                      <ChevronRight size={10} className="text-muted-foreground" />
                      <span className="font-medium text-foreground">{targetStatus.name}</span>
                      {steps.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
                          {t('statusTransition.approvalSteps', { count: steps.length })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Approval rule add/edit dialog */}
      {hasCrud && (
        <ApprovalRuleDialog
          show={showDialog}
          editingRuleId={editingApprovalId}
          addRuleProjectIds={dialogProjectIds}
          setAddRuleProjectIds={setDialogProjectIds}
          fromStatus={dialogFromStatus}
          setFromStatus={setDialogFromStatus}
          toStatus={dialogToStatus}
          setToStatus={setDialogToStatus}
          steps={dialogSteps}
          setSteps={setDialogSteps}
          saving={savingApproval}
          activeProjects={activeProjects}
          statuses={allStatuses.map(s => ({ id: s.id, name: s.name }))}
          users={users}
          onSave={handleSaveApproval}
          onClose={resetDialog}
          addDialogRef={dialogRef}
        />
      )}
    </div>
  );
};

export default StatusTransitionRuleEditor;
