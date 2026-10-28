import { useEffect, useRef, useState } from 'react';
import { Trophy, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from './useDashboardData';
import type { Sprint } from '@/context/SprintContext';
import type { SprintHistoryRecord } from '@/lib/sprintLifecycle';
import { readSprintHistory } from '@/lib/sprintHistory';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface DashboardSprintHistoryProps {
  currentSprint: Sprint | null;
  completedSprints: Sprint[];
  isMobile: boolean;
}

const DashboardSprintHistory = ({ currentSprint, completedSprints, isMobile }: DashboardSprintHistoryProps) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Sprint | null>(null);
  const [rows, setRows] = useState<SprintHistoryRecord[] | null>(null);
  const [error, setError] = useState(false);
  const token = useRef(0);
  useEffect(() => () => { token.current++; }, []);
  const load = async (sprint: Sprint) => {
    const visit = ++token.current;
    setSelected(sprint); setRows(null); setError(false);
    try { const result = await readSprintHistory(sprint.id); if (visit === token.current) setRows(result); }
    catch { if (visit === token.current) setError(true); }
  };
  const close = () => { token.current++; setSelected(null); setRows(null); setError(false); };
  const rate = (sprint: Sprint) => {
    const total = sprint.completedCount + sprint.pendingCount + (sprint.cancelledCount ?? 0);
    return sprint.historyCapturedAt ? (total ? Math.round(sprint.completedCount / total * 100) : 0) : null;
  };
  const completedLabel = (sprint: Sprint) => sprint.historyCapturedAt
    ? t('dashboard.completedCount', { count: sprint.completedCount })
    : t('sprint.history.legacyFinished', { count: sprint.completedCount });
  const details = (sprint: Sprint) => <button className="min-h-11 text-xs text-primary underline sm:min-h-0" aria-label={t('sprint.history.open', { name: sprint.name })} onClick={() => void load(sprint)}>{t('sprint.history.view')}</button>;

  return (
    <div className="bg-card rounded-lg border border-border p-3 md:p-4 mt-4 md:mt-6">
      <div className="flex items-center gap-2 mb-3"><Trophy size={18} className="text-primary" /><h3 className="text-sm md:text-base font-semibold text-foreground">{t('dashboard.sprintHistoryTitle')}</h3></div>
      {currentSprint && <div className="mb-4 p-3 rounded-lg border border-primary/20 bg-primary/5">
        <div className="flex flex-wrap items-center gap-2 mb-1"><Zap size={14} className="text-primary" /><span className="text-[13px] font-semibold">{currentSprint.name}</span><span className="text-[13px] text-primary">{t('dashboard.inProgress')}</span></div>
        <div className="text-[13px] text-muted-foreground">{t('dashboard.startedOn', { date: formatDate(currentSprint.startedAt) })}</div>
      </div>}
      {completedSprints.length === 0 ? <div className="text-center text-muted-foreground text-sm py-6">{t('dashboard.noSprintHistory')}</div> : isMobile ? (
        <div className="space-y-2">{completedSprints.map(sprint => <div key={sprint.id} className="bg-muted rounded-lg p-3 text-[13px]">
          <div className="font-medium">{sprint.name}</div><p className="text-muted-foreground">{formatDate(sprint.startedAt)} → {formatDate(sprint.completedAt)}</p>
          <div className="my-2 flex flex-wrap gap-3"><span>{completedLabel(sprint)}</span><span>{sprint.cancelledCount == null ? t('sprint.history.cancelledUnknown') : t('sprint.history.cancelledCount', { count: sprint.cancelledCount })}</span><span>{t('dashboard.pendingCount', { count: sprint.pendingCount })}</span></div>
          <div className="flex justify-between items-center"><span title={t('sprint.history.rateHint')}>{t('dashboard.completionRateHeader')}: {rate(sprint) == null ? '—' : `${rate(sprint)}%`}</span>{details(sprint)}</div>
        </div>)}</div>
      ) : <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-sm"><thead><tr className="bg-muted/50">
        <th className="px-3 py-2 text-left">{t('dashboard.sprintNameHeader')}</th><th className="px-3 py-2 text-left">{t('dashboard.startTimeHeader')}</th><th className="px-3 py-2 text-left">{t('dashboard.endTimeHeader')}</th><th className="px-3 py-2">{t('dashboard.completedHeader')}</th><th className="px-3 py-2">{t('sprint.history.cancelled')}</th><th className="px-3 py-2">{t('dashboard.pendingHeader')}</th><th className="px-3 py-2" title={t('sprint.history.rateHint')}>{t('dashboard.completionRateHeader')}</th><th className="px-3 py-2">{t('sprint.history.view')}</th>
      </tr></thead><tbody>{completedSprints.map(sprint => <tr key={sprint.id} className="border-t border-border">
        <td className="px-3 py-2 font-medium">{sprint.name}</td><td className="px-3 py-2 text-xs">{formatDate(sprint.startedAt)}</td><td className="px-3 py-2 text-xs">{formatDate(sprint.completedAt)}</td><td className="px-3 py-2 text-center">{sprint.historyCapturedAt ? sprint.completedCount : completedLabel(sprint)}</td><td className="px-3 py-2 text-center">{sprint.cancelledCount ?? t('sprint.history.unknown')}</td><td className="px-3 py-2 text-center">{sprint.pendingCount}</td><td className="px-3 py-2 text-center">{rate(sprint) == null ? '—' : `${rate(sprint)}%`}</td><td className="px-3 py-2 text-center">{details(sprint)}</td>
      </tr>)}</tbody></table></div>}
      <Dialog open={!!selected} onOpenChange={open => { if (!open) close(); }}><DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t('sprint.history.title', { name: selected?.name ?? '' })}</DialogTitle><DialogDescription>{t('sprint.history.readScope')}</DialogDescription></DialogHeader>
        {selected && !selected.historyCapturedAt && <p className="text-sm text-amber-600">{t('sprint.history.legacyNotice')}</p>}
        {error ? <div role="alert"><p>{t('sprint.history.loadFailed')}</p><button className="mt-2 min-h-11 text-primary underline" onClick={() => selected && void load(selected)}>{t('sprint.history.retry')}</button></div> : rows === null ? <p role="status">{t('sprint.history.loading')}</p> : rows.length === 0 ? <p>{t('sprint.history.empty')}</p> : <div className="space-y-2">{rows.map(row => <article key={row.id} className="rounded border border-border p-3">
          <div className="flex flex-wrap gap-2"><span className="text-xs font-mono text-muted-foreground">{row.task_key}</span><span className="text-xs rounded bg-muted px-2">{t(`sprint.history.outcomes.${row.outcome}`)}</span>{row.source === 'legacy' && <span className="text-xs text-amber-600">{t('sprint.history.unknown')}</span>}</div>
          <p className="text-sm break-words mt-1">{row.title}</p><p className="text-xs text-muted-foreground mt-1">{row.status_name}</p>
        </article>)}</div>}
      </DialogContent></Dialog>
    </div>
  );
};

export default DashboardSprintHistory;
