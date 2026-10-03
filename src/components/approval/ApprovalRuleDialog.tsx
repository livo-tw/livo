import { SearchableSelect } from '@/components/ui/searchable-select';
import { ProjectCheckboxList } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useProjectContext } from '@/context/ProjectContext';
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type StepDraft = {
  approver_type: 'role' | 'user';
  approver_role: string | null;
  approver_user_id: string | null;
  allow_delegate: boolean;
  timeout_hours: number | null;
  timeout_action: 'remind' | 'auto_approve' | 'escalate' | null;
  step_order: number;
};

export function addStep(setSteps: React.Dispatch<React.SetStateAction<StepDraft[]>>) {
  setSteps(prev => [...prev, {
    approver_type: 'role', approver_role: 'admin', approver_user_id: null,
    allow_delegate: false, timeout_hours: null, timeout_action: null,
    step_order: prev.length + 1,
  }]);
}

export function removeStep(setSteps: React.Dispatch<React.SetStateAction<StepDraft[]>>, idx: number) {
  setSteps(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_order: i + 1 })));
}

export function updateStep(setSteps: React.Dispatch<React.SetStateAction<StepDraft[]>>, idx: number, patch: Partial<StepDraft>) {
  setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
}

interface ApprovalRuleDialogProps {
  show: boolean;
  editingRuleId: string | null;
  addRuleProjectIds: string[];
  setAddRuleProjectIds: React.Dispatch<React.SetStateAction<string[]>>;
  fromStatus: string;
  setFromStatus: React.Dispatch<React.SetStateAction<string>>;
  toStatus: string;
  setToStatus: React.Dispatch<React.SetStateAction<string>>;
  steps: StepDraft[];
  setSteps: React.Dispatch<React.SetStateAction<StepDraft[]>>;
  saving: boolean;
  activeProjects: { id: string; name: string }[];
  statuses: { id: string; name: string }[];
  users: { id: string; name: string; isActive: boolean }[];
  onSave: () => void;
  onClose: () => void;
  addDialogRef: React.RefObject<HTMLDivElement | null>;
}

export default function ApprovalRuleDialog({
  show,
  editingRuleId,
  addRuleProjectIds,
  setAddRuleProjectIds,
  fromStatus,
  setFromStatus,
  toStatus,
  setToStatus,
  steps,
  setSteps,
  saving,
  activeProjects,
  statuses,
  users,
  onSave,
  onClose,
  addDialogRef,
}: ApprovalRuleDialogProps) {
  const { t } = useTranslation();
  const { productLines } = useProjectContext();

  const ROLE_OPTIONS = [
    { value: 'admin', label: t('role.admin') },
    { value: 'super_admin', label: t('role.superAdmin') },
    { value: 'member', label: t('role.member') },
  ];

  const projectNameMap = new Map(activeProjects.map(p => [p.id, p.name]));

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div ref={addDialogRef} role="dialog" aria-modal="true" aria-labelledby="approval-rule-config-title" className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-4 p-5 space-y-4">
        <h3 id="approval-rule-config-title" className="text-base font-semibold text-foreground">{editingRuleId ? t('approval.ruleConfig.editRuleTitle') : t('approval.ruleConfig.addRuleTitle')}</h3>

        {/* Project multi-select for new rule */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('approval.ruleConfig.project')}</label>
          {/* Selected tags */}
          {addRuleProjectIds.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {addRuleProjectIds.map(pid => {
                const pName = projectNameMap.get(pid) ?? pid;
                return (
                  <span key={pid} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2 py-0.5">
                    {pName}
                    <button type="button" onClick={() => setAddRuleProjectIds(prev => prev.filter(id => id !== pid))} className="hover:text-destructive">×</button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="border border-border rounded bg-muted max-h-36 overflow-y-auto">
            {/* Select All */}
            <label className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent cursor-pointer border-b border-border/50">
              <input
                type="checkbox"
                checked={addRuleProjectIds.length === activeProjects.length && activeProjects.length > 0}
                onChange={() => {
                  if (addRuleProjectIds.length === activeProjects.length) {
                    setAddRuleProjectIds([]);
                  } else {
                    setAddRuleProjectIds(activeProjects.map(p => p.id));
                  }
                }}
                className="rounded border-border accent-primary"
              />
              <span className="font-medium text-foreground">{t('approval.ruleConfig.selectAll')}</span>
            </label>
            <ProjectCheckboxList groups={groupProjectsByLine(productLines, activeProjects)} selected={addRuleProjectIds} onToggle={id => setAddRuleProjectIds(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id])} />
          </div>
        </div>

        {/* From / To status */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('approval.ruleConfig.fromStatus')}</label>
            <SearchableSelect
              value={fromStatus}
              onChange={e => setFromStatus(e.target.value)}
              aria-label={t('approval.ruleConfig.fromStatus')}
              className="w-full text-sm bg-muted border border-border rounded px-2 py-1.5 text-foreground"
            >
              <option value="">{t('approval.ruleConfig.selectStatus')}</option>
              {statuses.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </SearchableSelect>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('approval.ruleConfig.toStatus')}</label>
            <SearchableSelect
              value={toStatus}
              onChange={e => setToStatus(e.target.value)}
              aria-label={t('approval.ruleConfig.toStatus')}
              className="w-full text-sm bg-muted border border-border rounded px-2 py-1.5 text-foreground"
            >
              <option value="">{t('approval.ruleConfig.selectStatus')}</option>
              {statuses.filter(s => s.id !== fromStatus).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </SearchableSelect>
          </div>
        </div>

        {/* Steps */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('approval.ruleConfig.approvalLayers')}</label>
            <button onClick={() => addStep(setSteps)} className="text-xs text-primary hover:text-primary/80 flex items-center gap-1">
              <Plus size={11} />{t('approval.ruleConfig.addLayer')}
            </button>
          </div>
          <div className="space-y-2">
            {steps.map((step, idx) => (
              <div key={idx} className="flex items-start gap-2 bg-muted/40 rounded-lg p-2">
                <span className="text-xs text-muted-foreground font-medium mt-1.5 flex-shrink-0 w-4">{idx + 1}.</span>
                <div className="flex-1 space-y-1.5">
                  <div className="flex gap-2">
                    <SearchableSelect
                      value={step.approver_type}
                      onChange={e => updateStep(setSteps, idx, { approver_type: e.target.value as 'role' | 'user', approver_role: 'admin', approver_user_id: null })}
                      aria-label={t('approval.ruleConfig.approverType')}
                      className="text-xs bg-card border border-border rounded px-1.5 py-1 text-foreground"
                    >
                      <option value="role">{t('approval.ruleConfig.byRole')}</option>
                      <option value="user">{t('approval.ruleConfig.byUser')}</option>
                    </SearchableSelect>
                    {step.approver_type === 'role' ? (
                      <SearchableSelect
                        value={step.approver_role ?? ''}
                        onChange={e => updateStep(setSteps, idx, { approver_role: e.target.value })}
                        aria-label={t('approval.ruleConfig.approverRole')}
                        className="flex-1 text-xs bg-card border border-border rounded px-1.5 py-1 text-foreground"
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </SearchableSelect>
                    ) : (
                      <SearchableSelect
                        value={step.approver_user_id ?? ''}
                        onChange={e => updateStep(setSteps, idx, { approver_user_id: e.target.value })}
                        aria-label={t('approval.ruleConfig.assignApprover')}
                        className="flex-1 text-xs bg-card border border-border rounded px-1.5 py-1 text-foreground"
                      >
                        <option value="">{t('approval.ruleConfig.selectMember')}</option>
                        {users.filter(u => u.isActive).map(u => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </SearchableSelect>
                    )}
                  </div>
                  {/* Row 2: allow delegate */}
                  <div className="flex items-center">
                    <label className="text-[10px] text-muted-foreground flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={step.allow_delegate}
                        onChange={e => updateStep(setSteps, idx, { allow_delegate: e.target.checked })}
                        className="rounded"
                      />
                      {t('approval.ruleConfig.allowDelegate')}
                    </label>
                  </div>
                  {/* Row 3: timeout settings */}
                  <div className="flex gap-2 items-center">
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">{t('approval.ruleConfig.timeoutSetting')}:</span>
                    <input
                      type="number"
                      min="1"
                      placeholder={t('common.hours')}
                      value={step.timeout_hours ?? ''}
                      onChange={e => updateStep(setSteps, idx, { timeout_hours: e.target.value ? Number(e.target.value) : null })}
                      className="w-16 text-[10px] bg-card border border-border rounded px-1.5 py-0.5 text-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">{t('approval.ruleConfig.hoursAfter')}</span>
                    <SearchableSelect
                      value={step.timeout_action ?? ''}
                      onChange={e => updateStep(setSteps, idx, { timeout_action: (e.target.value as 'remind' | 'auto_approve' | 'escalate') || null })}
                      aria-label={t('approval.ruleConfig.timeoutAction')}
                      className="text-[10px] bg-card border border-border rounded px-1.5 py-0.5 text-foreground"
                    >
                      <option value="">{t('approval.ruleConfig.selectAction')}</option>
                      <option value="remind">{t('approval.ruleConfig.actionRemind')}</option>
                      <option value="auto_approve">{t('approval.ruleConfig.actionAutoApprove')}</option>
                      <option value="escalate">{t('approval.ruleConfig.actionEscalate')}</option>
                    </SearchableSelect>
                  </div>
                </div>
                {steps.length > 1 && (
                  <button onClick={() => removeStep(setSteps, idx)} className="text-destructive/60 hover:text-destructive mt-1">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onSave}
            disabled={saving || addRuleProjectIds.length === 0 || !fromStatus || !toStatus || fromStatus === toStatus}
            className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : editingRuleId ? t('common.save') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
