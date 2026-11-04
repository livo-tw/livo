import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaClient, QaTaskReference } from '@/lib/qa/client';
import { QaField, qaButton } from './QaFields';

type ReferenceClient = Pick<QaClient, 'taskReferences'>;

export function QaExternalLinkedTasks({ client, projectId, ids, onRemove }: {
  client: ReferenceClient;
  projectId: string;
  ids: string[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ projectId: string; refs: QaTaskReference[] } | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    const request = new AbortController();
    void client.taskReferences(projectId, { taskIds: ids }, request.signal).then(result => {
      if (!request.signal.aborted) setSnapshot({ projectId, refs: result.tasks });
    }).catch(() => { /* Unavailable references use a generic label. */ });
    return () => request.abort();
  }, [client, projectId, ids]);
  if (!ids.length) return <p className="text-sm text-muted-foreground">{t('qa.noTasks')}</p>;
  const references = new Map(snapshot?.projectId === projectId ? snapshot.refs.map(ref => [ref.id, ref]) : []);
  return <ul className="space-y-2 text-sm">{ids.map(id => {
    const ref = references.get(id);
    const label = ref ? ref.taskKey + ' · ' + ref.title : t('common.unknown');
    return <li key={id}>
      {onRemove ? <label className="flex items-start gap-2"><input type="checkbox" checked onChange={() => onRemove(id)} />{label}</label> : label}
    </li>;
  })}</ul>;
}

export function QaExternalTaskPicker({ client, projectId, links, onChange }: {
  client: ReferenceClient;
  projectId: string;
  links: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([projectId, search]);
  const [page, setPage] = useState<{ key: string; tasks: QaTaskReference[]; hasMore: boolean; offset: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    setFailed(false);
    const timer = window.setTimeout(() => {
      void client.taskReferences(projectId, { search, offset }, request.signal).then(result => {
        if (request.signal.aborted) return;
        setPage(previous => ({
          key, offset, hasMore: result.hasMore,
          tasks: offset > 0 && previous?.key === key && previous.offset < offset ? [...previous.tasks, ...result.tasks] : result.tasks,
        }));
      }).catch(() => { if (!request.signal.aborted) setFailed(true); });
    }, 180);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [client, key, offset, projectId, revision, search]);
  const shown = page?.key === key ? page : null;
  return <div className="space-y-3">
    {links.length > 0 && <QaExternalLinkedTasks client={client} projectId={projectId} ids={links} onRemove={id => onChange(links.filter(link => link !== id))} />}
    <QaField label={t('qa.taskSearch')} value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
    <div className="max-h-60 space-y-2 overflow-y-auto">{shown?.tasks.filter(task => !links.includes(task.id)).map(task =>
      <label key={task.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={false}
        onChange={() => { if (links.length < 50) onChange([...links, task.id]); }} disabled={links.length >= 50} />{task.taskKey} · {task.title}</label>
    )}</div>
    {failed ? <div role="alert" className="flex items-center gap-2 text-sm">{t('qa.failed')}
      <button type="button" className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('common.retry')}</button>
    </div> : shown?.hasMore && <button type="button" className={qaButton} disabled={shown.offset !== offset}
      onClick={() => setOffset(shown.tasks.length)}>{t('qa.loadMore')}</button>}
  </div>;
}
