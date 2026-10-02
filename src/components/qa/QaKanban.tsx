import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canQaCommand } from '@/lib/qa/domain';
import type { QaActor, QaCommand, QaIssue, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { QaFailure } from './QaIssueDetail';
import { qaButton } from './QaFields';

const nextActions: Partial<Record<QaState, { command: QaCommand['type']; label: string }>> = {
  new: { command: 'triage', label: 'triage' },
  triaged: { command: 'start_fix', label: 'startFix' },
  in_progress: { command: 'submit_fix', label: 'submitFix' },
  verification: { command: 'close', label: 'close' },
  closed: { command: 'reopen', label: 'reopen' },
};

export default function QaKanban({ client, actor, workflow, filters, onOpen, projectName, memberName }: {
  client: QaClient;
  actor: QaActor;
  workflow: QaWorkflow;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type']) => void;
  projectName: (id: string) => string;
  memberName: (id: string | null) => string;
}) {
  const { t } = useTranslation();
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('qa.boardHint')}</p>
    <div className="flex items-start gap-3 overflow-x-auto pb-4" aria-label={t('qa.board')}>
      {workflow.order.filter(state => !filters.state || filters.state === state).map(state => <QaColumn key={state} client={client} actor={actor}
        state={state} label={workflow.labels[state] || t(`qa.state.${state}`)} filters={filters} onOpen={onOpen} projectName={projectName} memberName={memberName} />)}
    </div>
  </div>;
}

function QaColumn({ client, actor, state, label, filters, onOpen, projectName, memberName }: {
  client: QaClient;
  actor: QaActor;
  state: QaState;
  label: string;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type']) => void;
  projectName: (id: string) => string;
  memberName: (id: string | null) => string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const load = useCallback(async (offset: number) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      const page = await client.list({ ...filters, state, offset, limit: 20 }, controller.signal);
      if (!controller.signal.aborted) {
        nextOffset.current = offset + page.issues.length;
        setResult(previous => ({ ...page, issues: offset ? [...previous.issues, ...page.issues.filter(issue => !previous.issues.some(old => old.id === issue.id))] : page.issues }));
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [client, filters, state]);
  useEffect(() => { void load(0); return () => pending.current?.abort(); }, [load]);
  const renderCard = (issue: QaIssue) => {
    const next = nextActions[issue.state];
    return <li key={issue.id} className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <button className="w-full text-left font-semibold hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary" onClick={() => onOpen(issue.id)}><span className="line-clamp-3 break-words">{issue.title}</span></button>
      <p className="mt-2 truncate text-xs text-muted-foreground">{projectName(issue.projectId)} · {t(`qa.severityNames.${issue.severity}`)}</p>
      <p className="mt-1 break-words text-xs text-muted-foreground">{issue.observedEnvironment} · {issue.observedVersion || '—'}</p>
      <p className="mt-2 text-xs">{t('qa.assignee')}: {memberName(issue.assigneeId)}</p>
      <p className="mt-1 text-xs">{t('qa.qaOwner')}: {memberName(issue.qaOwnerId)}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button className={qaButton} onClick={() => onOpen(issue.id)}>{t('qa.openBug')}</button>
        {next && canQaCommand(issue, actor, next.command) && <button className={qaButton} onClick={() => onOpen(issue.id, next.command)}>{t(`qa.${next.label}`)}</button>}
      </div>
    </li>;
  };
  return <section className="w-[min(82vw,300px)] shrink-0 rounded-xl border border-border bg-muted/40 p-3" aria-label={label}>
    <header className="mb-3 flex items-start justify-between gap-2"><h2 className="min-w-0 break-words font-semibold">{label}</h2><span className="rounded-full bg-background px-2 py-0.5 text-xs">{result.total}</span></header>
    {error !== null && <div className="mb-3 space-y-2"><QaFailure error={error} /><button className={qaButton} onClick={() => void load(nextOffset.current)}>{t('qa.refresh')}</button></div>}
    <ul className="space-y-3">{result.issues.map(renderCard)}</ul>
    {loading && <p role="status" className="py-4 text-center text-xs text-muted-foreground">{t('qa.loading')}</p>}
    {!loading && !error && !result.issues.length && <p className="py-6 text-center text-xs text-muted-foreground">{t('qa.boardEmpty')}</p>}
    {result.hasMore && <button className={`${qaButton} mt-3 w-full`} disabled={loading} onClick={() => void load(nextOffset.current)}>{t('qa.loadMore')}</button>}
  </section>;
}
