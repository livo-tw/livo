import { useState, useEffect } from 'react';
import { Check, X, CornerUpLeft, Clock, Ban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApprovalWorkflow, type ApprovalProgress as ProgressData } from '@/hooks/useApprovalWorkflow';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { toast } from 'sonner';

interface Props {
  approvalRequestId: string;
  onAction?: (result?: import('@/hooks/useApprovalWorkflow').ApprovalActionResult) => void;
}

function StatusIcon({ status }: { status: ProgressData['steps'][0]['status'] }) {
  if (status === 'approved') return <Check size={10} className="text-white" />;
  if (status === 'rejected') return <X size={10} className="text-white" />;
  if (status === 'returned') return <CornerUpLeft size={10} className="text-white" />;
  if (status === 'pending') return <Clock size={10} className="text-white" />;
  return null;
}

function stepBgColor(status: ProgressData['steps'][0]['status']): string {
  if (status === 'approved') return 'bg-green-500';
  if (status === 'rejected') return 'bg-destructive';
  if (status === 'returned') return 'bg-amber-500';
  if (status === 'pending') return 'bg-primary';
  return 'bg-muted-foreground/30';
}

export default function ApprovalProgress({ approvalRequestId, onAction }: Props) {
  const { t } = useTranslation();
  const ROLE_LABELS: Record<string, string> = {
    admin: t('role.admin'),
    super_admin: t('role.superAdmin'),
    member: t('role.member'),
  };
  const { getApprovalProgress, performAction, cancelApproval } = useApprovalWorkflow();
  const { users } = useMemberContext();
  const { currentMemberId, currentMember } = useAuthContext();

  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showActionDialog, setShowActionDialog] = useState<'approve' | 'reject' | 'return' | null>(null);
  const [comment, setComment] = useState('');
  const [actioning, setActioning] = useState(false);

  const actionDialogRef = useFocusTrap(showActionDialog !== null);

  const loadProgress = async () => {
    setLoading(true);
    try {
      const p = await getApprovalProgress(approvalRequestId);
      setProgress(p);
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadProgress(); }, [approvalRequestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const getUserName = (id: string | null) => id ? (users.find(u => u.id === id)?.name ?? id) : null;

  const isCurrentApprover = (): boolean => {
    if (!progress || progress.legacy) return false;
    if (progress.ruleId === null && progress.requestStatus === 'pending') return ['admin','super_admin'].includes(currentMember?.role ?? '');
    const currentStepInfo = progress.steps.find(s => s.status === 'pending');
    if (!currentStepInfo) return false;
    if (currentStepInfo.approverType === 'user') {
      return currentStepInfo.approverUserId === currentMemberId;
    }
    if (currentStepInfo.approverType === 'role') {
      return currentMember?.role === currentStepInfo.approverRole;
    }
    return false;
  };

  const handleAction = async () => {
    if (!showActionDialog) return;
    setActioning(true);
    try {
      const result = await performAction(approvalRequestId, showActionDialog, comment || undefined, undefined, progress ? {version:progress.version,current_step:progress.currentStep} : undefined);
      if (result.ok) {
        setShowActionDialog(null);
        setComment('');
        await loadProgress();
        onAction?.(result);
      }
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    } finally {
      setActioning(false);
    }
  };

  const handleCancel = async () => {
    try {
      const ok = await cancelApproval(approvalRequestId,{onResult:result => onAction?.(result)});
      if (ok) {
        await loadProgress();
      }
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    }
  };

  if (loading) {
    return <div className="py-3 text-xs text-muted-foreground">{t('approval.loadingProgress')}</div>;
  }

  if (!progress) return null;

  // A requester never decides their own request, whatever their role; it waits for another approver.
  const matchesCurrentStep = isCurrentApprover();
  const isRequester = progress.requestedBy === currentMemberId;
  const canAct = matchesCurrentStep && !isRequester;

  return (
    <div className="space-y-3">
      {progress?.legacy && <p role="alert" className="text-sm text-amber-700">{t('approvalCommand.legacy')}</p>}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('approval.progressTitle')}</span>
        <span className="text-[10px] text-muted-foreground">
          {progress.steps.filter(s => s.status === 'approved').length} / {progress.totalSteps} {t('approval.layers')}
        </span>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-1.5">
        {progress.steps.map((step, i) => (
          <div key={i} className="flex items-center gap-1.5 flex-1">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${stepBgColor(step.status)}`}>
              <StatusIcon status={step.status} />
              {step.status === 'waiting' && (
                <span className="text-[8px] text-muted-foreground font-bold">{step.stepOrder}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-foreground truncate">
                {step.approverType === 'role'
                  ? ROLE_LABELS[step.approverRole ?? ''] ?? step.approverRole
                  : getUserName(step.approverUserId) ?? t('approval.assignedUser')}
              </div>
              {step.actedAt && (
                <div className="text-[9px] text-muted-foreground">
                  {getUserName(step.actionBy)} · {new Date(step.actedAt).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })}
                </div>
              )}
              {step.comment && (
                <div className="text-[9px] text-muted-foreground/70 italic truncate" title={step.comment}>
                  &ldquo;{step.comment}&rdquo;
                </div>
              )}
            </div>
            {i < progress.steps.length - 1 && (
              <div className="w-3 h-px bg-border flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* Action buttons for current approver */}
      {canAct && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => setShowActionDialog('approve')}
            className="flex-1 flex items-center justify-center gap-1 text-xs bg-green-600 hover:bg-green-700 text-white py-1.5 rounded-lg transition-colors"
          >
            <Check size={12} />{t('approval.approve')}
          </button>
          <button
            onClick={() => setShowActionDialog('return')}
            className="flex-1 flex items-center justify-center gap-1 text-xs bg-amber-600 hover:bg-amber-700 text-white py-1.5 rounded-lg transition-colors"
          >
            <CornerUpLeft size={12} />{t('approval.returnAction')}
          </button>
          <button
            onClick={() => setShowActionDialog('reject')}
            className="flex-1 flex items-center justify-center gap-1 text-xs bg-destructive hover:bg-destructive/90 text-white py-1.5 rounded-lg transition-colors"
          >
            <X size={12} />{t('approval.reject')}
          </button>
        </div>
      )}

      {matchesCurrentStep && isRequester && (
        <p className="text-xs text-muted-foreground">{t('approvalCommand.selfDecisionHint')}</p>
      )}

      {/* Withdraw — the requester or an administrator, like the withdraw command allows. Administrators
          need it for requests from before the upgrade, which have no fixed workflow and can only be withdrawn. */}
      {progress.requestStatus === 'pending'
        && (progress.requestedBy === currentMemberId || ['admin', 'super_admin'].includes(currentMember?.role ?? '')) && (
        <div className="pt-1">
          <button
            onClick={() => void handleCancel()}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            <Ban size={11} />{t('approval.cancelApproval')}
          </button>
        </div>
      )}


      {/* Inline action dialog */}
      {showActionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div ref={actionDialogRef} role="dialog" aria-modal="true" aria-labelledby="approval-progress-action-title" className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-5 space-y-4">
            <h3 id="approval-progress-action-title" className="text-base font-semibold text-foreground">
              {showActionDialog === 'approve' ? t('approval.approve') : showActionDialog === 'return' ? t('approval.returnForRevision') : t('approval.rejectApproval')}
            </h3>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('approval.commentPlaceholder')}
              rows={3}
              className="w-full text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowActionDialog(null)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleAction}
                disabled={actioning}
                className={`px-4 py-1.5 text-sm text-white rounded-lg disabled:opacity-50 transition-colors ${
                  showActionDialog === 'approve' ? 'bg-green-600 hover:bg-green-700' :
                  showActionDialog === 'return' ? 'bg-amber-600 hover:bg-amber-700' :
                  'bg-destructive hover:bg-destructive/90'
                }`}
              >
                {actioning ? t('common.processing') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
