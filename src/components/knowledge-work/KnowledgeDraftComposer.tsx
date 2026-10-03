import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeWorkErrorCode, type KnowledgeDraftPreview, type KnowledgeSearchItem, type KnowledgeSourceRef, type KnowledgeWorkClient } from '@/lib/knowledgeWork/client';
import { QaField, QaSelect, qaButton, qaPrimary } from '@/components/qa/QaFields';
import KnowledgeWorkSearch from './KnowledgeWorkSearch';

export default function KnowledgeDraftComposer({ client, projectId, onSaved, onStateChange }: { client: KnowledgeWorkClient; projectId?: string; onSaved: (pageId: string) => Promise<void>; onStateChange?: (state: { busy: boolean; dirty: boolean }) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'meeting' | 'weekly'>('meeting');
  const [notes, setNotes] = useState(''), [title, setTitle] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [sources, setSources] = useState<KnowledgeSearchItem[]>([]);
  const [preview, setPreview] = useState<KnowledgeDraftPreview | null>(null);
  const [draftTitle, setDraftTitle] = useState(''), [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [savedPageId, setSaved] = useState('');
  const generation = useRef(0), submitting = useRef(false);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [client]);
  const dirty = !savedPageId && !!(notes.trim() || title.trim() || from || to || sources.length || preview);
  useEffect(() => { onStateChange?.({ busy, dirty }); }, [busy, dirty, onStateChange]);
  useEffect(() => () => { onStateChange?.({ busy: false, dirty: false }); }, [onStateChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const refs: KnowledgeSourceRef[] = sources.map(({ kind: sourceKind, id, version }) => ({ kind: sourceKind, id, version }));
  const prepare = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (submitting.current || !event.currentTarget.reportValidity()) return;
    submitting.current = true; setBusy(true); setError(''); const epoch = generation.current;
    try {
      const result = await client.prepare({ kind, ...(title.trim() ? { title: title.trim() } : {}), notes, sourceRefs: refs, ...(kind === 'weekly' ? { period: { from, to } } : {}) });
      if (epoch !== generation.current) return;
      setPreview(result); setDraftTitle(result.title); setText(result.text); setConfirmed(false);
    } catch (failure) { if (epoch === generation.current) setError(knowledgeWorkErrorCode(failure)); }
    finally { submitting.current = false; if (epoch === generation.current) setBusy(false); }
  };
  const save = async () => {
    if (!preview || !confirmed || !preview.coverage.complete || submitting.current || savedPageId) return;
    submitting.current = true; setBusy(true); setError(''); const epoch = generation.current;
    let saved = false;
    try {
      const result = await client.save({ preview, title: draftTitle.trim(), text, confirmed: true });
      if (epoch !== generation.current) return;
      saved = true; setSaved(result.page.pageId); await onSaved(result.page.pageId);
    } catch (failure) { if (epoch === generation.current) setError(saved ? 'saved_refresh_failed' : knowledgeWorkErrorCode(failure)); }
    finally { submitting.current = false; if (epoch === generation.current) setBusy(false); }
  };
  const pick = (item: KnowledgeSearchItem) => {
    if (submitting.current) return;
    if (sources.length >= 50 && !sources.some(value => value.kind === item.kind && value.id === item.id)) { setError('source_limit'); return; }
    setSources(previous => [...previous.filter(value => value.kind !== item.kind || value.id !== item.id), item]);
  };
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('knowledgeWork.draftHint')}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t(`knowledgeWork.errors.${error}`)}</p>}
    {savedPageId ? <div role="status" className="space-y-3"><p>{t('knowledgeWork.draftSaved')}</p><button className={qaButton} onClick={() => void onSaved(savedPageId).catch(() => setError('saved_refresh_failed'))}>{t('knowledgeWork.openDraft')}</button></div> : preview ? <>
      {!preview.coverage.complete && <p role="alert">{t('knowledgeWork.incompletePreview')}</p>}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) void save(); }}><fieldset disabled={busy} className="space-y-3">
        <QaField label={t('knowledgeWork.draftTitle')} required maxLength={200} value={draftTitle} onChange={event => { setDraftTitle(event.target.value); setConfirmed(false); }} />
        <QaField label={t('knowledgeWork.previewText')} multiline required maxLength={100000} value={text} onChange={event => { setText(event.target.value); setConfirmed(false); }} />
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('knowledgeWork.confirmPrivateSave')}</label>
        <button className={qaPrimary} type="submit" disabled={!confirmed || !preview.coverage.complete}>{t('knowledgeWork.savePrivateDraft')}</button> <button className={qaButton} type="button" onClick={() => { setPreview(null); setConfirmed(false); }}>{t('knowledgeWork.backToNotes')}</button>
      </fieldset></form>
    </> : <>
      <form className="space-y-3" onSubmit={event => void prepare(event)}><fieldset disabled={busy} className="space-y-3">
        <QaSelect label={t('knowledgeWork.draftKind')} value={kind} onChange={event => setKind(event.target.value as 'meeting' | 'weekly')}><option value="meeting">{t('knowledgeWork.meeting')}</option><option value="weekly">{t('knowledgeWork.weekly')}</option></QaSelect>
        <QaField label={t('knowledgeWork.optionalTitle')} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} />
        {kind === 'weekly' && <div className="grid gap-3 sm:grid-cols-2"><QaField label={t('knowledgeWork.periodFrom')} type="date" required value={from} onChange={event => setFrom(event.target.value)} /><QaField label={t('knowledgeWork.periodTo')} type="date" required value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></div>}
        <QaField label={t('knowledgeWork.notes')} multiline maxLength={30000} value={notes} onChange={event => setNotes(event.target.value)} />
        <p className="text-xs text-muted-foreground">{t('knowledgeWork.referenceCount', { count: sources.length })}</p>
        <ul className="space-y-2">{sources.map(source => <li className="flex items-center justify-between gap-2 text-sm" key={`${source.kind}:${source.id}`}><span>{source.title}</span><button type="button" className={qaButton} onClick={() => setSources(previous => previous.filter(value => value.kind !== source.kind || value.id !== source.id))}>{t('knowledgeWork.removeReference')}</button></li>)}</ul>
        <button className={qaPrimary} type="submit" disabled={!notes.trim() && !sources.length}>{t('knowledgeWork.preparePreview')}</button>
      </fieldset></form>
      <details><summary className="cursor-pointer text-sm font-medium">{t('knowledgeWork.chooseSources')}</summary><div className="mt-3"><KnowledgeWorkSearch client={client} projectId={projectId} selected={refs} onSelect={pick} /></div></details>
    </>}
    {busy && <p role="status">{t('kb.loading')}</p>}
  </div>;
}
