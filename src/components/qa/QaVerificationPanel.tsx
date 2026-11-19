import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaCommand, QaResult, QaTarget } from '@/lib/qa/domain';
import { QaField, QaSelect, qaPrimary } from './QaFields';
import { useQaDetailDraft } from './QaDetailDraftContext';
import { useQaDraftFiles } from './QaDraftAttachments';
import QaWorkflowAttachmentPicker, { type QaWorkflowAttachmentDraft } from './QaWorkflowAttachmentPicker';

export type QaVerificationCommand = Extract<QaCommand, { type: 'record_verification' }>;
type SubmitVerification = (command: QaCommand, draft?: QaWorkflowAttachmentDraft) => Promise<boolean | void>;

export default function QaVerificationPanel({ targets, initialResult, acknowledgedVerification, canDeploy, canVerify, busy, onCommand, deploymentAttachments }: {
  targets: QaTarget[];
  initialResult?: 'pass' | 'fail';
  acknowledgedVerification?: QaVerificationCommand;
  canDeploy: boolean;
  canVerify: boolean;
  busy: boolean;
  onCommand: SubmitVerification;
  deploymentAttachments?: (targetId: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const initialTarget = targets.find(target => target.deployedAt && target.required) || targets.find(target => target.deployedAt);
  return <div className="space-y-3">{canVerify && <p className="text-sm text-muted-foreground">{t('qa.autoCloseAfterVerificationHint')}</p>}{targets.map(target => <QaVerificationTarget key={target.id} target={target}
    initialResult={canVerify && target.id === initialTarget?.id ? initialResult : undefined}
    acknowledgedVerification={acknowledgedVerification}
    canDeploy={canDeploy} canVerify={canVerify} busy={busy} onCommand={onCommand} deploymentAttachments={deploymentAttachments?.(target.id)} />)}</div>;
}

function QaVerificationTarget({ target, initialResult, acknowledgedVerification, canDeploy, canVerify, busy, onCommand, deploymentAttachments }: {
  target: QaTarget;
  initialResult?: 'pass' | 'fail';
  acknowledgedVerification?: QaVerificationCommand;
  canDeploy: boolean;
  canVerify: boolean;
  busy: boolean;
  onCommand: SubmitVerification;
  deploymentAttachments?: ReactNode;
}) {
  const { t } = useTranslation();
  const deploymentFiles = useQaDraftFiles();
  const verificationFiles = useQaDraftFiles();
  const [evidence, setEvidence] = useState('');
  const defaultResult = initialResult || 'pass';
  const [{ result, note }, setVerification] = useState<{ result: QaResult; note: string }>({ result: defaultResult, note: '' });
  const handledVerification = useRef<QaVerificationCommand>();
  useEffect(() => {
    if (acknowledgedVerification?.targetId !== target.id || acknowledgedVerification.build !== target.build ||
      acknowledgedVerification === handledVerification.current) return;
    handledVerification.current = acknowledgedVerification;
    setVerification(draft => draft.result === acknowledgedVerification.result && draft.note === acknowledgedVerification.note
      ? { result: defaultResult, note: '' }
      : draft);
  }, [acknowledgedVerification, target.id, target.build, defaultResult]);
  useQaDetailDraft((canDeploy && !target.deployedAt && (evidence !== '' || deploymentFiles.files.length > 0)) ||
    (canVerify && !!target.deployedAt && (note !== '' || result !== defaultResult || verificationFiles.files.length > 0)));
  return <article className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    <div><h3 className="break-words text-sm font-semibold">{[target.environment, target.component, target.build].filter(Boolean).join(' / ')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t(target.deployedAt ? 'qa.deployed' : 'qa.notDeployed')}{target.deployedAt && ` · ${new Date(target.deployedAt).toLocaleString()}`}{target.required && ` · ${t('qa.required')}`}</p>
      {target.deploymentEvidence && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{target.deploymentEvidence}</p>}
      {deploymentAttachments}
      {canVerify && !target.deployedAt && <p className="mt-2 text-sm text-muted-foreground">{t('qa.verificationAwaitingDeployment')}</p>}
    </div>
    {canDeploy && !target.deployedAt && <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      if (!busy) {
        const command = { type: 'record_deployment', targetId: target.id, build: target.build, evidence } as const;
        void (deploymentFiles.files.length ? onCommand(command, deploymentFiles) : onCommand(command));
      }
    }}>
      <QaField label={t('qa.deploymentEvidence')} hint={t('qa.deploymentConfirmationHint')} maxLength={8000} value={evidence} onChange={event => setEvidence(event.target.value)} disabled={busy} />
      <QaWorkflowAttachmentPicker draft={deploymentFiles} busy={busy} />
      <button className={qaPrimary} disabled={busy}>{t('qa.deployment')}</button>
    </form>}
    {canVerify && target.deployedAt && <form className="space-y-2 border-t border-border pt-3" onSubmit={event => {
      event.preventDefault();
      if (!busy) {
        const command = { type: 'record_verification', targetId: target.id, build: target.build, result, note } as const;
        void (verificationFiles.files.length ? onCommand(command, verificationFiles) : onCommand(command));
      }
    }}>
      <QaSelect label={t('qa.resultField')} value={result} onChange={event => { const value = event.target.value as QaResult; setVerification(draft => ({ ...draft, result: value })); }} disabled={busy}>
        {(['pass', 'fail', 'blocked'] as const).map(value => <option key={value} value={value}>{t(`qa.result.${value}`)}</option>)}
      </QaSelect>
      {result === 'pass' ? <details className="rounded-md border border-border p-2"><summary className="cursor-pointer text-sm text-muted-foreground">{t('qa.verificationNote')}</summary><div className="mt-2"><QaField label={t('qa.note')} multiline maxLength={8000} value={note} onChange={event => { const value = event.target.value; setVerification(draft => ({ ...draft, note: value })); }} disabled={busy} /></div></details>
        : <QaField label={t('qa.note')} multiline maxLength={8000} value={note} onChange={event => { const value = event.target.value; setVerification(draft => ({ ...draft, note: value })); }} disabled={busy} />}
      <QaWorkflowAttachmentPicker draft={verificationFiles} busy={busy} />
      <button className={qaPrimary} disabled={busy}>{t('qa.verification')}</button>
    </form>}
  </article>;
}
