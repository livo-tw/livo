import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '@/context/ProjectContext';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { KNOWLEDGE_SOURCE_KINDS, knowledgeWorkErrorCode, type KnowledgeSearchItem, type KnowledgeSearchResult, type KnowledgeSourceKind, type KnowledgeSourceRef, type KnowledgeWorkClient } from '@/lib/knowledgeWork/client';
import { QaField, QaSelect, qaButton, qaPrimary } from '@/components/qa/QaFields';

export default function KnowledgeWorkSearch({ client, projectId = '', types = KNOWLEDGE_SOURCE_KINDS, effective = false, selected = [], onSelect, onOpen }: {
  client: KnowledgeWorkClient; projectId?: string; types?: readonly KnowledgeSourceKind[]; effective?: boolean;
  selected?: KnowledgeSourceRef[]; onSelect?: (item: KnowledgeSearchItem) => void; onOpen?: (item: KnowledgeSearchItem) => void;
}) {
  const { t } = useTranslation();
  const { allProjects, productLines } = useProjectContext();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState(projectId);
  const [kinds, setKinds] = useState<KnowledgeSourceKind[]>([...types]);
  const [effectiveOnly, setEffective] = useState(effective);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([0]);
  const generation = useRef(0), querying = useRef<number | null>(null);
  const last = useRef<Parameters<KnowledgeWorkClient['search']>[0] | null>(null);
  const typeKey = types.join(',');
  useEffect(() => {
    generation.current++; querying.current = null; setResult(null); setQuery(''); setProject(projectId); setKinds([...types]); setEffective(effective); setError(''); setBusy(false); last.current = null;
    return () => { generation.current++; };
  }, [client, projectId, typeKey, effective]);
  const search = async (cursor: number, trail: number[], fresh = false) => {
    const epoch = generation.current;
    if (querying.current === epoch) return;
    querying.current = epoch; setBusy(true); setError('');
    const input = fresh || !last.current ? { query, types: effectiveOnly ? types.filter(kind => ['knowledge', 'knowledge_file'].includes(kind)) : kinds, projectIds: project ? [project] : [], effectiveOnly, cursor } : { ...last.current, cursor };
    last.current = input;
    try { const value = await client.search(input); if (epoch === generation.current) { setResult(value); setHistory(trail); } }
    catch (failure) { if (epoch === generation.current) { setResult(null); setError(knowledgeWorkErrorCode(failure)); } }
    finally { if (querying.current === epoch) querying.current = null; if (epoch === generation.current) setBusy(false); }
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('knowledgeWork.searchHint')}</p>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void search(0, [0], true); }}><fieldset disabled={busy} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><QaField label={t('knowledgeWork.query')} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /><QaSelect label={t('kb.scope')} value={project} onChange={event => setProject(event.target.value)}><option value="">{t('kb.allScopes')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects)} /></QaSelect></div>
      <div className="flex flex-wrap gap-3">{types.map(kind => <label key={kind} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={kinds.includes(kind)} disabled={effectiveOnly} onChange={event => setKinds(previous => event.target.checked ? [...previous, kind] : previous.filter(value => value !== kind))} />{t(`knowledgeWork.kinds.${kind}`)}</label>)}</div>
      {types.some(kind => ['knowledge', 'knowledge_file'].includes(kind)) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={effectiveOnly} onChange={event => setEffective(event.target.checked)} />{t('knowledgeWork.effectiveOnly')}</label>}
      <button className={qaPrimary} type="submit" disabled={!effectiveOnly && !kinds.length}>{t('knowledgeWork.search')}</button>
    </fieldset></form>
    {busy && <p role="status">{t('kb.loading')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t(`knowledgeWork.errors.${error}`)}</p>}
    {result && <>
      {!result.coverage.complete && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('knowledgeWork.partialResults')}</p>}
      {!result.items.length && <p className="text-sm text-muted-foreground">{t('kb.noResults')}</p>}
      <ul className="max-h-[50vh] space-y-2 overflow-auto">{result.items.map(item => {
        const ref = selected.find(value => value.kind === item.kind && value.id === item.id);
        return <li key={`${item.kind}:${item.id}`} className="rounded-lg border p-3 text-sm"><p className="break-words font-medium">{item.title}</p><p className="mb-2 text-xs text-muted-foreground">{t(`knowledgeWork.kinds.${item.kind}`)}{item.effective && ` · ${t('knowledgeWork.effective')}`}</p><div className="flex flex-wrap gap-2">{onOpen && <button className={qaButton} type="button" disabled={busy} onClick={() => onOpen(item)}>{t('knowledgeWork.open')}</button>}{onSelect && <button className={qaButton} type="button" disabled={busy || ref?.version === item.version} onClick={() => onSelect(item)}>{t(ref ? 'knowledgeWork.updateReference' : 'knowledgeWork.addReference')}</button>}</div></li>;
      })}</ul>
      <div className="flex gap-2"><button className={qaButton} disabled={busy || history.length < 2} onClick={() => void search(history[history.length - 2], history.slice(0, -1))}>{t('qa.previous')}</button><button className={qaButton} disabled={busy || result.nextCursor === null} onClick={() => result.nextCursor !== null && void search(result.nextCursor, [...history, result.nextCursor])}>{t('qa.next')}</button></div>
    </>}
  </div>;
}
