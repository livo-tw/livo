import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { knowledgeWorkErrorCode, type KnowledgeSearchItem, type KnowledgeSearchResult, type KnowledgeWorkClient } from '@/lib/knowledgeWork/client';
import { Lock } from 'lucide-react';
import { qaButton, qaPrimary } from '@/components/qa/QaFields';
import KnowledgeWorkSearch from './KnowledgeWorkSearch';
import KnowledgeDraftComposer from './KnowledgeDraftComposer';

export default function KnowledgeWorkSpace({ client, projectId, onClose, onOpen, onSaved, onOpenDraft }: {
  client: KnowledgeWorkClient; projectId?: string; onClose: () => void;
  onOpen: (item: KnowledgeSearchItem) => Promise<void>; onSaved: (pageId: string) => Promise<void>;
  /** Opens the saved draft in the knowledge base and closes this dialog. */
  onOpenDraft?: (pageId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'search' | 'compose' | 'mine'>('search');
  const [composer, setComposer] = useState({ busy: false, dirty: false });
  const [openError, setOpenError] = useState(false);
  const composerState = useCallback((value: { busy: boolean; dirty: boolean }) => setComposer(value), []);
  const allowLeave = () => !composer.busy && (!composer.dirty || window.confirm(t('kb.discard')));
  const openItem = (item: KnowledgeSearchItem) => { setOpenError(false); void onOpen(item).catch(() => setOpenError(true)); };
  return <Dialog open onOpenChange={open => { if (!open && allowLeave()) onClose(); }}><DialogContent aria-describedby={undefined} className="max-h-[90vh] max-w-4xl overflow-y-auto" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (composer.busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>{t('knowledgeWork.workspaceTitle')}</DialogTitle></DialogHeader>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('knowledgeWork.workspaceTitle')}>{(['search', 'compose', 'mine'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={value === tab} className={value === tab ? qaPrimary : qaButton} disabled={composer.busy} onClick={() => { if (value !== tab && allowLeave()) setTab(value); }}>{t(`knowledgeWork.tabs.${value}`)}</button>)}</div>
    {openError && <p role="alert">{t('knowledgeWork.errors.knowledge_source_unavailable')}</p>}
    {tab === 'search' && <KnowledgeWorkSearch client={client} projectId={projectId} onOpen={openItem} />}
    {tab === 'compose' && <KnowledgeDraftComposer client={client} projectId={projectId} onSaved={onSaved} onOpenDraft={onOpenDraft} onStateChange={composerState} />}
    {tab === 'mine' && <PrivateDraftList client={client} onOpen={openItem} />}
  </DialogContent></Dialog>;
}
function PrivateDraftList({ client, onOpen }: { client: KnowledgeWorkClient; onOpen: (item: KnowledgeSearchItem) => void }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null), [error, setError] = useState('');
  const [trail, setTrail] = useState([0]), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = async (cursor: number, history: number[]) => {
    const epoch = ++generation.current; setBusy(true); setError('');
    try { const value = await client.drafts(cursor); if (epoch === generation.current) { setResult(value); setTrail(history); } }
    catch (failure) { if (epoch === generation.current) setError(knowledgeWorkErrorCode(failure)); }
    finally { if (epoch === generation.current) setBusy(false); }
  };
  useEffect(() => { setResult(null); void load(0, [0]); return () => { generation.current++; }; }, [client]);
  return <div className="space-y-3"><p className="text-sm text-muted-foreground">{t('knowledgeWork.privateListHint')}</p>{busy && <p role="status">{t('kb.loading')}</p>}{error && <p role="alert">{t(`knowledgeWork.errors.${error}`)}</p>}{result && <><ul className="space-y-2">{result.items.map(item => <li key={item.id} className="rounded-lg border p-3 text-sm"><p className="mb-2 flex items-center gap-1.5 font-medium"><Lock size={13} className="shrink-0 text-muted-foreground" aria-label={t('knowledgeWork.privateDraft')} />{item.title}</p><button type="button" className={qaButton} onClick={() => onOpen(item)}>{t('knowledgeWork.openDraft')}</button></li>)}</ul>{!result.items.length && <p>{t('knowledgeWork.noDrafts')}</p>}<div className="flex gap-2"><button className={qaButton} disabled={busy || trail.length < 2} onClick={() => void load(trail[trail.length - 2], trail.slice(0, -1))}>{t('qa.previous')}</button><button className={qaButton} disabled={busy || result.nextCursor === null} onClick={() => result.nextCursor !== null && void load(result.nextCursor, [...trail, result.nextCursor])}>{t('qa.next')}</button></div></>}</div>;
}
