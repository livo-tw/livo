import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaClient } from '@/lib/qa/client';
import type { QaIssue, QaListResult } from '@/lib/qa/domain';
import type { ReleaseComponent, ReleaseQaSource } from '@/lib/releases/core';
import { ReleaseField, ReleaseSelect, releaseButton } from './ReleaseFields';

export type QaEvidenceChoice = { issueId: string; issueVersion: number; targetId: string; runId: string };
export default function ReleaseQaPicker({ client, component, environment, onChange, onSource }: {
  client: QaClient; component: ReleaseComponent; environment: string;
  onChange: (value: QaEvidenceChoice | null) => void; onSource: (source: ReleaseQaSource) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(''), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QaListResult | null>(null), [issueId, setIssueId] = useState(''), [issue, setIssue] = useState<QaIssue | null>(null);
  const [error, setError] = useState(false), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setPage(null); setError(false);
    void client.list({ projectId: component.projectId, search, offset, limit: 25 }, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, component.projectId, search, offset, revision]);
  useEffect(() => {
    const controller = new AbortController(); setIssue(null); onChange(null);
    if (issueId) void client.get(issueId, controller.signal).then(detail => {
      if (controller.signal.aborted) return;
      if (detail.issue.projectId !== component.projectId) { setError(true); return; }
      setIssue(detail.issue); onSource(detail.issue);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [client, component.projectId, issueId, revision]);
  const target = component.targets.find(row => row.environment === environment);
  const runs = issue?.runs.filter(run => run.fixCycle === issue.fixCycle && run.build === target?.build && issue.targets.some(item => item.id === run.targetId && item.environment === environment && item.component === component.name && item.build === target?.build)) ?? [];
  return <div className="space-y-3 rounded border p-3">
    <p className="text-sm text-muted-foreground">{t('releaseWorkspace.qaEvidenceHint')}</p>
    <div className="flex items-end gap-2"><ReleaseField label={t('releaseWorkspace.qaSearch')} value={draft} maxLength={200} onChange={e => setDraft(e.target.value)} /><button type="button" className={releaseButton} onClick={() => { setSearch(draft); setOffset(0); }}>{t('releaseWorkspace.search')}</button></div>
    {error && <p role="alert">{t('releaseWorkspace.qaUnavailable')} <button type="button" className={releaseButton} onClick={() => setRevision(v => v + 1)}>{t('releaseWorkspace.refresh')}</button></p>}
    {loading && <p role="status">{t('releaseWorkspace.loading')}</p>}
    {page && <><ReleaseSelect label={t('releaseWorkspace.qaIssue')} value={issueId} required onChange={e => { setIssueId(e.target.value); onChange(null); }}><option value="">{t('releaseWorkspace.choose')}</option>{issue && !page.issues.some(v => v.id === issueId) && <option value={issueId}>{issue.title}</option>}{page.issues.map(v => <option value={v.id} key={v.id}>{v.title}</option>)}</ReleaseSelect><div className="flex items-center gap-2"><button type="button" className={releaseButton} disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 25))}>{t('releaseWorkspace.previous')}</button><span className="text-xs">{t('releaseWorkspace.page', { n: offset / 25 + 1 })}</span><button type="button" className={releaseButton} disabled={!page.hasMore} onClick={() => setOffset(v => v + 25)}>{t('releaseWorkspace.next')}</button></div>{!page.issues.length && <p>{t('releaseWorkspace.noQaMatches')}</p>}</>}
    {issue && <><p className="text-xs text-muted-foreground">{t('releaseWorkspace.qaSnapshot', { version: issue.version, cycle: issue.fixCycle })}</p><ReleaseSelect key={`${issue.id}-${issue.version}-${environment}`} label={t('releaseWorkspace.qaRun')} defaultValue="" required onChange={e => { const run = runs.find(v => v.id === e.target.value); onChange(run ? { issueId: issue.id, issueVersion: issue.version, targetId: run.targetId, runId: run.id } : null); }}><option value="">{t('releaseWorkspace.choose')}</option>{runs.map(run => <option value={run.id} key={run.id}>{t(`releaseWorkspace.qaResult.${run.result}`)} · {run.build} · {run.createdAt}</option>)}</ReleaseSelect>{!runs.length && <p role="status">{t('releaseWorkspace.noQaRuns')}</p>}</>}
  </div>;
}
