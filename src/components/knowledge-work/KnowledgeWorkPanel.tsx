import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import UserSelect from '@/components/UserSelect';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';
import { knowledgeWorkErrorCode, type KnowledgeDocumentKind, type KnowledgeMetadata, type KnowledgePublication, type KnowledgeSearchItem, type KnowledgeWorkClient, type KnowledgeWorkDetail, type KnowledgeWorkResult } from '@/lib/knowledgeWork/client';
import type { KnowledgePage } from '@/types/knowledge';
import { QaField, QaSection, QaSelect, qaButton, qaPrimary } from '@/components/qa/QaFields';
import KnowledgeWorkSearch from './KnowledgeWorkSearch';

type Confirmation = { operation: 'publish' | 'replace' | 'share'; version: number; publicationId: string | null; title: string; body: string; predecessor: KnowledgePublication | null };
export default function KnowledgeWorkPanel({ client, pageId, pageVersion, parents, disabled = false, onChanged }: {
  client: KnowledgeWorkClient; pageId: string; pageVersion: number; parents: KnowledgePage[]; disabled?: boolean; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { users } = useMemberContext(), { allProjects, productLines } = useProjectContext();
  const [data, setData] = useState<KnowledgeWorkDetail | null>(null), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [meta, setMeta] = useState<{ version: number; value: KnowledgeMetadata } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [confirmed, setConfirmed] = useState(false);
  const [shareProject, setShareProject] = useState('unselected'), [shareParent, setShareParent] = useState('');
  const [linking, setLinking] = useState(false), [historical, setHistorical] = useState<KnowledgePublication | null>(null);
  const generation = useRef(0), saving = useRef(false), predecessorRequest = useRef(0);
  useEffect(() => { setMeta(null); setConfirmation(null); setLinking(false); setHistorical(null); setNotice(''); }, [client, pageId]);
  useEffect(() => {
    const epoch = ++generation.current; setData(null); setError('');
    void client.get(pageId).then(value => { if (epoch === generation.current) setData(value); }).catch(failure => { if (epoch === generation.current) setError(knowledgeWorkErrorCode(failure)); });
    return () => { generation.current++; };
  }, [client, pageId, pageVersion, reload]);
  const run = async (write: () => Promise<KnowledgeWorkResult>) => {
    if (saving.current || disabled) return;
    saving.current = true; setBusy(true); setError(''); setNotice(''); const epoch = generation.current;
    let saved = false;
    try {
      await write(); saved = true;
      if (epoch !== generation.current) return;
      setMeta(null); setConfirmation(null); setLinking(false);
      // A receipt may describe an earlier result. Read current state after a confirmed write.
      setData(null); const fresh = await client.get(pageId);
      if (epoch !== generation.current) return;
      setData(fresh);
      setNotice('knowledgeWork.saved'); await onChanged();
    } catch (failure) { if (epoch === generation.current) setError(saved ? 'saved_refresh_failed' : knowledgeWorkErrorCode(failure)); }
    finally { saving.current = false; if (epoch === generation.current) setBusy(false); }
  };
  const openConfirmation = (operation: Confirmation['operation']) => {
    if (!data) return;
    predecessorRequest.current++;
    setMeta(null); setError(''); setConfirmed(false); setShareProject('unselected'); setShareParent('');
    setConfirmation({ operation, version: data.pageVersion, publicationId: data.publication?.id || null, title: data.title, body: data.body, predecessor: null });
  };
  const pickPredecessor = async (item: KnowledgeSearchItem) => {
    const epoch = generation.current, request = ++predecessorRequest.current; setError(''); setConfirmed(false);
    try {
      const previous = await client.get(item.pageId || item.id);
      if (epoch !== generation.current || request !== predecessorRequest.current) return;
      if (previous.pageId === pageId || previous.publication?.state !== 'effective') { setError('invalid_predecessor'); return; }
      setConfirmation(value => value && { ...value, predecessor: previous.publication });
    } catch (failure) { if (epoch === generation.current && request === predecessorRequest.current) setError(knowledgeWorkErrorCode(failure)); }
  };
  const publish = () => {
    if (!confirmation || !confirmed) return;
    const common = { pageId, expectedVersion: confirmation.version, expectedPublicationId: confirmation.publicationId, confirmed: true as const };
    if (confirmation.operation === 'publish') void run(() => client.publish(common));
    else if (confirmation.operation === 'replace' && confirmation.predecessor) {
      const predecessor = confirmation.predecessor;
      void run(() => client.replace({ ...common, predecessorPublicationId: predecessor.id, expectedPredecessorVersion: predecessor.version }));
    } else if (confirmation.operation === 'share' && shareProject !== 'unselected') void run(() => client.share({ pageId, expectedVersion: confirmation.version, projectId: shareProject || null, parentId: shareParent || null, confirmed: true }));
  };
  const history = async (id: string) => {
    const epoch = generation.current;
    try { const value = await client.publication(id); if (epoch === generation.current) setHistorical(value); }
    catch (failure) { if (epoch === generation.current) { setHistorical(null); setError(knowledgeWorkErrorCode(failure)); } }
  };
  const ownerName = (id: string | null) => users.find(user => user.id === id)?.name || t('knowledgeWork.noOwner');
  const writable = !!data?.canEdit && !disabled && !busy;
  const canPublish = writable && !data?.privateDraftOwnerId && !!data?.metadata.documentKind && !!data?.metadata.ownerId;
  const currentPublication = data?.publication;
  return <QaSection title={t('knowledgeWork.documentStatus')}>
    {error && <div role="alert" className="mb-3 text-sm text-destructive">{t(`knowledgeWork.errors.${error}`)} <button type="button" className="underline" disabled={busy} onClick={() => setReload(value => value + 1)}>{t('kb.retry')}</button></div>}
    {notice && <p role="status" className="mb-3 text-sm">{t(notice)}</p>}
    {!data ? !error && <p role="status">{t('kb.loading')}</p> : <div className="space-y-4">
      <p className="text-sm">{t(data.privateDraftOwnerId ? 'knowledgeWork.privateDraft' : currentPublication?.state === 'effective' ? 'knowledgeWork.effective' : currentPublication?.state === 'superseded' ? 'knowledgeWork.superseded' : 'knowledgeWork.workingCopy')}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">{t('knowledgeWork.documentKind')}</dt><dd>{t(`knowledgeWork.${data.metadata.documentKind || 'general'}`)}</dd></div><div><dt className="text-xs text-muted-foreground">{t('knowledgeWork.owner')}</dt><dd>{ownerName(data.metadata.ownerId)}</dd></div><div><dt className="text-xs text-muted-foreground">{t('knowledgeWork.productVersion')}</dt><dd>{data.metadata.applicability.productVersion || '—'}</dd></div><div><dt className="text-xs text-muted-foreground">{t('knowledgeWork.environment')}</dt><dd>{data.metadata.applicability.environment || '—'}</dd></div></dl>
      {data.metadata.applicability.summary && <p className="whitespace-pre-wrap break-words text-sm">{data.metadata.applicability.summary}</p>}
      {currentPublication && <details><summary className="cursor-pointer text-sm font-medium">{t('knowledgeWork.publishedRevision', { version: currentPublication.page_version })}</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{new Date(currentPublication.published_at).toLocaleString()}</p><div className="knowledge-content prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(currentPublication.body) }} />{currentPublication.predecessor_id && <button type="button" className={qaButton} onClick={() => void history(currentPublication.predecessor_id!)}>{t('knowledgeWork.viewPredecessor')}</button>}{currentPublication.successor_id && <button type="button" className={qaButton} onClick={() => void history(currentPublication.successor_id!)}>{t('knowledgeWork.viewSuccessor')}</button>}</div></details>}
      {currentPublication && currentPublication.page_version !== data.pageVersion && <p className="text-sm text-amber-700 dark:text-amber-400">{t('knowledgeWork.unpublishedChanges')}</p>}
      <div className="flex flex-wrap gap-2">{data.canEdit && <><button type="button" className={qaButton} disabled={!writable} onClick={() => { setConfirmation(null); setMeta({ version: data.pageVersion, value: structuredClone(data.metadata) }); }}>{t('knowledgeWork.editMetadata')}</button><button type="button" className={qaButton} disabled={!writable} onClick={() => setLinking(value => !value)}>{t('knowledgeWork.chooseSources')}</button></>}{!data.privateDraftOwnerId && data.canEdit && <><button type="button" className={qaPrimary} disabled={!canPublish || (currentPublication?.state === 'effective' && currentPublication.page_version === data.pageVersion)} onClick={() => openConfirmation('publish')}>{t('knowledgeWork.publish')}</button><button type="button" className={qaButton} disabled={!canPublish} onClick={() => openConfirmation('replace')}>{t('knowledgeWork.replace')}</button></>}{data.privateDraftOwnerId && data.canShare && <button type="button" className={qaPrimary} disabled={!writable} onClick={() => openConfirmation('share')}>{t('knowledgeWork.shareDraft')}</button>}</div>
      {meta && <form onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) void run(() => client.metadata({ pageId, expectedVersion: meta.version, metadata: meta.value })); }}><fieldset disabled={!writable} className="space-y-3">
        <QaSelect label={t('knowledgeWork.documentKind')} value={meta.value.documentKind || ''} onChange={event => setMeta(value => value && { ...value, value: { ...value.value, documentKind: (event.target.value || null) as KnowledgeDocumentKind } })}><option value="">{t('knowledgeWork.general')}</option><option value="specification">{t('knowledgeWork.specification')}</option><option value="decision">{t('knowledgeWork.decision')}</option></QaSelect>
        <UserSelect label={t('knowledgeWork.owner')} activeOnly allowEmpty disabled={!writable} value={meta.value.ownerId || ''} onChange={ownerId => setMeta(value => value && { ...value, value: { ...value.value, ownerId: ownerId || null } })} emptyLabel={t('knowledgeWork.noOwner')} />
        {(['productVersion', 'environment', 'summary'] as const).map(field => <QaField key={field} label={t(`knowledgeWork.${field}`)} maxLength={field === 'summary' ? 1000 : 200} multiline={field === 'summary'} value={meta.value.applicability[field] || ''} onChange={event => setMeta(value => value && { ...value, value: { ...value.value, applicability: { ...value.value.applicability, [field]: event.target.value || null } } })} />)}
        <p className="text-xs text-muted-foreground">{t('knowledgeWork.metadataHint')}</p><button className={qaPrimary} type="submit">{t('kb.save')}</button> <button className={qaButton} type="button" onClick={() => setMeta(null)}>{t('kb.cancel')}</button>
      </fieldset></form>}
      {confirmation && <div className="space-y-3 rounded-lg border p-3"><p className="font-medium">{t(confirmation.operation === 'share' ? 'knowledgeWork.shareReview' : 'knowledgeWork.publicationReview')}</p><p className="text-sm">{confirmation.title} · {t('knowledgeWork.revision', { version: confirmation.version })}</p><details><summary className="cursor-pointer text-sm">{t('knowledgeWork.reviewBody')}</summary><div className="knowledge-content prose prose-sm mt-3 max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(confirmation.body) }} /></details>
        {confirmation.operation === 'replace' && <><KnowledgeWorkSearch client={client} types={['knowledge']} effective onSelect={item => void pickPredecessor(item)} />{confirmation.predecessor && <p className="text-sm">{t('knowledgeWork.replacing', { title: confirmation.predecessor.title, version: confirmation.predecessor.page_version })}</p>}</>}
        {confirmation.operation === 'share' && <><QaSelect label={t('knowledgeWork.destination')} disabled={busy} value={shareProject} onChange={event => { setShareProject(event.target.value); setShareParent(''); setConfirmed(false); }}><option value="unselected">{t('qa.choose')}</option><option value="">{t('kb.shared')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects)} /></QaSelect><QaSelect label={t('knowledgeWork.parent')} disabled={busy || shareProject === 'unselected'} value={shareParent} onChange={event => { setShareParent(event.target.value); setConfirmed(false); }}><option value="">{t('knowledgeWork.noParent')}</option>{parents.filter(page => page.id !== pageId && !page.is_archived && !page.private_draft_owner_id && (page.project_id || '') === shareProject).map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</QaSelect></>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t(confirmation.operation === 'share' ? 'knowledgeWork.confirmShare' : 'knowledgeWork.confirmPublication')}</label>
        <button type="button" className={qaPrimary} disabled={busy || !confirmed || (confirmation.operation === 'replace' && !confirmation.predecessor) || (confirmation.operation === 'share' && shareProject === 'unselected')} onClick={publish}>{t(confirmation.operation === 'share' ? 'knowledgeWork.confirmShareButton' : 'knowledgeWork.confirmPublishButton')}</button> <button type="button" className={qaButton} disabled={busy} onClick={() => setConfirmation(null)}>{t('kb.cancel')}</button>
      </div>}
      {data.links.length > 0 && <ul className="space-y-2">{data.links.map((source, index) => { const item = data.linkItems?.find(value => value.kind === source.kind && value.id === source.id); return <li key={`${source.kind}:${source.id}`} className="flex items-start justify-between gap-2 text-sm"><span>{item?.title || t('knowledgeWork.unavailableReference', { number: index + 1 })} · {t(`knowledgeWork.kinds.${source.kind}`)}</span>{data.canEdit && <button className={qaButton} type="button" disabled={!writable} onClick={() => void run(() => client.unlink({ pageId, expectedVersion: data.pageVersion, source }))}>{t('knowledgeWork.removeReference')}</button>}</li>; })}</ul>}
      {linking && <KnowledgeWorkSearch client={client} projectId={data.projectId || ''} selected={data.links} onSelect={item => { if (writable) void run(() => client.link({ pageId, expectedVersion: data.pageVersion, source: { kind: item.kind, id: item.id, version: item.version } })); }} />}
      {historical && <div className="rounded-lg border p-3"><h3 className="font-medium">{historical.title} · {t('knowledgeWork.revision', { version: historical.page_version })}</h3><p className="my-2 text-xs text-muted-foreground">{t(historical.state === 'effective' ? 'knowledgeWork.effective' : 'knowledgeWork.superseded')}</p><div className="knowledge-content prose prose-sm max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(historical.body) }} /><button type="button" className={qaButton} onClick={() => setHistorical(null)}>{t('kb.close')}</button></div>}
    </div>}
  </QaSection>;
}
