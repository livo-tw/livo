import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import UserSelect from '@/components/UserSelect';
import { useMemberContext } from '@/context/MemberContext';
import { canQaCommand, type QaActor, type QaCommand, type QaIssue } from '@/lib/qa/domain';
import { QaField, QaSection, qaButton, qaPrimary } from './QaFields';

export function handoffReplyTime(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  const date = new Date(value);
  if (!match || !Number.isFinite(date.getTime()) || date.getFullYear() !== Number(match[1]) || date.getMonth() + 1 !== Number(match[2]) || date.getDate() !== Number(match[3]) || date.getHours() !== Number(match[4]) || date.getMinutes() !== Number(match[5])) throw new Error('invalid_reply_time');
  return date.toISOString();
}

type Draft = { version: number; reason: string; nextOwnerId: string; replyBy: string; externalDependency: string };
export default function QaHandoffPanel({ issue, actor, busy, onCommand }: {
  issue: QaIssue; actor: QaActor; busy: boolean;
  onCommand: (command: QaCommand, expectedVersion?: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resolving, setResolving] = useState<{ version: number; id: string; evidence: string } | null>(null);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const handoff = issue.handoff;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = (id: string | null) => users.find(user => user.id === id)?.name || t('qaHandoff.unavailableMember');
  const run = async (command: QaCommand, version: number) => {
    if (busy || submitting.current) return;
    if (version !== issue.version) { setError(t('qaHandoff.draftConflict')); return; }
    submitting.current = true;
    try { if (await onCommand(command, version)) { setDraft(null); setResolving(null); } }
    finally { submitting.current = false; }
  };
  const request = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !event.currentTarget.reportValidity()) return;
    setError('');
    let replyBy: string | null;
    try { replyBy = handoffReplyTime(draft.replyBy); }
    catch { setError(t('qaHandoff.invalidTime')); return; }
    await run({ type: 'request_handoff', reason: draft.reason.trim(), nextOwnerId: draft.nextOwnerId, replyBy, externalDependency: draft.externalDependency.trim() }, draft.version);
  };
  const openRequest = () => { setError(''); setResolving(null); setDraft({ version: issue.version, reason: '', nextOwnerId: '', replyBy: '', externalDependency: '' }); };
  return <QaSection title={t('qaHandoff.title')}>
    <p className="mb-3 text-xs text-muted-foreground">{t('qaHandoff.roleHint')}</p>
    {handoff ? <dl className="space-y-3 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.nextOwner')}</dt><dd>{name(handoff.nextOwnerId)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.reason')}</dt><dd className="whitespace-pre-wrap break-words">{handoff.reason}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.replyBy')}</dt><dd>{handoff.replyBy ? new Date(handoff.replyBy).toLocaleString() : t('qaHandoff.noDeadline')}</dd></div>
      {handoff.externalDependency && <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.externalDependency')}</dt><dd className="whitespace-pre-wrap break-words">{handoff.externalDependency}</dd></div>}
      <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.status')}</dt><dd>{t(handoff.resolvedAt ? 'qaHandoff.resolved' : handoff.acceptedAt ? 'qaHandoff.accepted' : 'qaHandoff.pending')}{handoff.acceptedAt && ` · ${name(handoff.acceptedBy)} · ${new Date(handoff.acceptedAt).toLocaleString()}`}</dd></div>
      {handoff.resolvedAt && <div><dt className="text-xs text-muted-foreground">{t('qaHandoff.evidence')}</dt><dd className="whitespace-pre-wrap break-words">{handoff.resolutionEvidence}</dd></div>}
    </dl> : <p className="text-sm text-muted-foreground">{t('qaHandoff.empty')}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {canQaCommand(issue, actor, 'request_handoff') && <button type="button" className={qaButton} disabled={busy} onClick={openRequest}>{t(handoff && !handoff.resolvedAt ? 'qaHandoff.replace' : 'qaHandoff.request')}</button>}
      {handoff && canQaCommand(issue, actor, 'accept_handoff') && <button type="button" className={qaPrimary} disabled={busy} onClick={() => void run({ type: 'accept_handoff', handoffId: handoff.id }, issue.version)}>{t('qaHandoff.accept')}</button>}
      {handoff && canQaCommand(issue, actor, 'resolve_handoff') && <button type="button" className={qaButton} disabled={busy} onClick={() => { setDraft(null); setError(''); setResolving({ version: issue.version, id: handoff.id, evidence: '' }); }}>{t('qaHandoff.resolve')}</button>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {draft && <form className="mt-4 space-y-3" onSubmit={event => void request(event)}><fieldset disabled={busy} className="space-y-3">
      {handoff && !handoff.resolvedAt && <p className="text-sm text-muted-foreground">{t('qaHandoff.replaceHint')}</p>}
      <UserSelect name="nextOwnerId" label={t('qaHandoff.nextOwner')} activeOnly required disabled={busy} value={draft.nextOwnerId} onChange={nextOwnerId => setDraft(previous => previous && { ...previous, nextOwnerId })} emptyLabel={t('qa.choose')} />
      <QaField label={t('qaHandoff.reason')} multiline required maxLength={10000} value={draft.reason} onChange={event => setDraft(previous => previous && { ...previous, reason: event.target.value })} />
      <QaField label={t('qaHandoff.replyTime', { timezone })} type="datetime-local" value={draft.replyBy} onChange={event => setDraft(previous => previous && { ...previous, replyBy: event.target.value })} />
      <QaField label={t('qaHandoff.externalDependency')} multiline maxLength={10000} value={draft.externalDependency} onChange={event => setDraft(previous => previous && { ...previous, externalDependency: event.target.value })} />
      <button className={qaPrimary} type="submit">{t('qaHandoff.confirmRequest')}</button> <button className={qaButton} type="button" onClick={() => setDraft(null)}>{t('qa.cancel')}</button>
    </fieldset></form>}
    {resolving && <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) void run({ type: 'resolve_handoff', handoffId: resolving.id, evidence: resolving.evidence.trim() }, resolving.version); }}><fieldset disabled={busy} className="space-y-3">
      <QaField label={t('qaHandoff.evidence')} multiline required maxLength={10000} value={resolving.evidence} onChange={event => setResolving(previous => previous && { ...previous, evidence: event.target.value })} />
      <button className={qaPrimary} type="submit">{t('qaHandoff.confirmResolve')}</button> <button className={qaButton} type="button" onClick={() => setResolving(null)}>{t('qa.cancel')}</button>
    </fieldset></form>}
  </QaSection>;
}
