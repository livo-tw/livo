import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import QaIssueCard from './QaIssueCard';
import { qaStateColors } from './QaBadges';
import type { QaActor, QaCommand, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { getQaStateLabel, getQaWorkflowColumns, type QaWorkflow } from '@/lib/qa/workflow';
import { QaFailure } from './QaIssueDetail';
import { qaButton } from './QaFields';

export default function QaKanban({ client, actor, workflow, filters, onOpen }: {
  client: QaClient;
  actor: QaActor;
  workflow: QaWorkflow;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type']) => void;
}) {
  const { t } = useTranslation();
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('qa.boardHint')}</p>
    <div className="flex min-h-[480px] items-stretch gap-3 overflow-x-auto pb-4 snap-x snap-proximity" aria-label={t('qa.board')}>
      {getQaWorkflowColumns(workflow, state => t(`qa.state.${state}`)).filter(column => !filters.state || column.states.includes(filters.state)).map(column => <QaColumn key={column.id} client={client} actor={actor}
        state={column.id} states={filters.state ? [filters.state] : column.states} workflow={workflow} grouped={column.states.length > 1}
        label={column.label} filters={filters} onOpen={onOpen} />)}
    </div>
  </div>;
}

function QaColumn({ client, actor, state, states, workflow, grouped, label, filters, onOpen }: {
  client: QaClient;
  actor: QaActor;
  state: QaState;
  states: QaState[];
  workflow: QaWorkflow;
  grouped: boolean;
  label: string;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type']) => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const stateKey = states.join(',');
  const load = useCallback(async (offset: number) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      const page = await client.list({ ...filters, state: undefined, states: stateKey.split(',') as QaState[], offset, limit: 20 }, controller.signal);
      if (!controller.signal.aborted) {
        nextOffset.current = offset + page.issues.length;
        setResult(previous => ({ ...page, issues: offset ? [...previous.issues, ...page.issues.filter(issue => !previous.issues.some(old => old.id === issue.id))] : page.issues }));
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [client, filters, stateKey]);
  useEffect(() => { void load(0); return () => pending.current?.abort(); }, [load]);
  return <section className="flex min-h-[320px] w-[min(82vw,300px)] min-w-[260px] flex-1 shrink-0 snap-start flex-col rounded-xl border border-border/80 bg-muted/35" aria-label={label}>
    <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3"><h2 className="flex min-w-0 items-center gap-2 break-words text-sm font-semibold"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: qaStateColors[state] }} />{label}</h2><span className="rounded bg-background px-2 py-0.5 text-xs font-medium tabular-nums">{result.total}</span></header><div className="min-h-0 max-h-[calc(100dvh-310px)] flex-1 space-y-3 overflow-y-auto overscroll-contain p-2.5">
    {error !== null && <div className="mb-3 space-y-2"><QaFailure error={error} /><button className={qaButton} onClick={() => void load(nextOffset.current)}>{t('qa.refresh')}</button></div>}
    <ul className="space-y-2.5">{result.issues.map(issue => <li key={issue.id}><QaIssueCard issue={issue} actor={actor} onOpen={onOpen}
      stateLabel={grouped ? getQaStateLabel(workflow,issue.state,state => t(`qa.state.${state}`)) : undefined} /></li>)}</ul>
    {loading && <p role="status" className="py-4 text-center text-xs text-muted-foreground">{t('qa.loading')}</p>}
    {!loading && !error && !result.issues.length && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/80 px-3 py-10 text-center text-xs text-muted-foreground"><Inbox size={22} strokeWidth={1.5} aria-hidden="true" />{t('qa.boardEmpty')}</div>}
    {result.hasMore && <button className={`${qaButton} mt-3 w-full`} disabled={loading} onClick={() => void load(nextOffset.current)}>{t('qa.loadMore')}</button>}
    </div>
  </section>;
}
