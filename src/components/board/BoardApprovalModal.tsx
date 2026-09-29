export interface ApprovalConfirmPayload {
  taskId: string;
  fromStatusId: string;
  toStatusId: string;
  projectId: string;
  toStatusName: string;
  advisory?: boolean;
}

export interface BoardApprovalModalProps {
  approvalConfirm: ApprovalConfirmPayload;
  onClose: () => void;
  onDirectChange: (payload: ApprovalConfirmPayload) => Promise<void>;
  onSubmitApproval: (payload: ApprovalConfirmPayload) => Promise<void>;
  onMandatoryApproval: (payload: ApprovalConfirmPayload) => Promise<void>;
  t: (key: string, opts?: any) => string;
}

const BoardApprovalModal = ({
  approvalConfirm,
  onClose,
  onDirectChange,
  onSubmitApproval,
  onMandatoryApproval,
  t,
}: BoardApprovalModalProps) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-bold text-foreground mb-2">{approvalConfirm.advisory ? t('approval.advisoryTitle') : t('approval.title')}</h3>
        <p className="text-sm text-muted-foreground mb-4">
          {approvalConfirm.advisory
            ? t('approval.advisoryDesc', { statusName: approvalConfirm.toStatusName })
            : t('approval.description', { statusName: approvalConfirm.toStatusName })}
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">{t('common.cancel')}</button>
          {approvalConfirm.advisory ? (
            <>
              <button onClick={() => onDirectChange(approvalConfirm)}
                className="px-3 py-1.5 text-sm font-medium border border-border text-foreground rounded-lg hover:bg-accent transition-colors">{t('approval.directChange')}</button>
              <button onClick={() => onSubmitApproval(approvalConfirm)}
                className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">{t('approval.submitForApproval')}</button>
            </>
          ) : (
            <button onClick={() => onMandatoryApproval(approvalConfirm)}
              className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">{t('button.submitApproval')}</button>
          )}
        </div>
      </div>
    </div>
  );
};

export default BoardApprovalModal;
