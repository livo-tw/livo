import { Check, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import TaskSidebarFields from './TaskSidebarFields';

type Props = { detail: TaskDetailState };

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24));

const effColor = (days: number, type: 'create' | 'start') => {
  if (type === 'create') return days <= 7 ? '#36B37E' : days <= 14 ? '#FF8B00' : '#FF5630';
  return days <= 5 ? '#36B37E' : days <= 10 ? '#FF8B00' : '#FF5630';
};

const formatTimelineDate = (d: string) => {
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const hms = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return hms === '00:00' ? ymd : `${ymd} ${hms}`;
};

const TaskMetricsTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const { task, statuses, users, logs, isMobile } = detail;
  if (!task) return null;

  const createToComplete = task.completedAt ? daysBetween(task.createdAt, task.completedAt) : null;
  const startToComplete = task.completedAt && task.startedAt ? daysBetween(task.startedAt, task.completedAt) : null;
  const overdueDays = task.completedAt && task.dueDate ? daysBetween(task.dueDate, task.completedAt) : null;

  // Build timeline
  const timeline: { statusName: string; statusColor: string; date: string; changedByName?: string }[] = [];
  timeline.push({ statusName: t('taskDetail.metrics.createdStatus'), statusColor: '#6B778C', date: task.createdAt });
  logs.forEach(log => {
    const toStatus = statuses.find(s => s.id === log.toStatusId);
    const changer = users.find(u => u.id === log.changedBy);
    if (toStatus) timeline.push({ statusName: toStatus.name, statusColor: toStatus.color, date: log.changedAt, changedByName: changer?.name });
  });
  if (logs.length === 0 && task.startedAt) {
    const inProgressStatus = statuses.find(s => s.autoStart) || statuses.find(s => s.name.includes('進行'));
    if (inProgressStatus) timeline.push({ statusName: inProgressStatus.name, statusColor: inProgressStatus.color, date: task.startedAt });
  }
  if (logs.length === 0 && task.completedAt) {
    const doneStatus = statuses.find(s => s.isDone);
    if (doneStatus) timeline.push({ statusName: doneStatus.name, statusColor: doneStatus.color, date: task.completedAt });
  }
  timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {[
          { label: t('taskDetail.metrics.createdDate'), value: task.createdAt },
          { label: t('taskDetail.metrics.startedDate'), value: task.startedAt || '—' },
          { label: t('taskDetail.metrics.completedDate'), value: task.completedAt || '—' },
          { label: t('taskDetail.metrics.dueDate'), value: task.dueDate || '—' },
        ].map(item => (
          <div key={item.label} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="text-foreground font-medium">{item.value}</span>
          </div>
        ))}
      </div>

      <div className="border-t border-border pt-3 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('taskDetail.metrics.createToComplete')}</span>
          {createToComplete !== null
            ? <span className="font-medium" style={{ color: effColor(createToComplete, 'create') }}>{t('taskDetail.metrics.daysUnit', { count: createToComplete })}</span>
            : <span className="text-muted-foreground">—</span>}
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('taskDetail.metrics.startToComplete')}</span>
          {startToComplete !== null
            ? <span className="font-medium" style={{ color: effColor(startToComplete, 'start') }}>{t('taskDetail.metrics.daysUnit', { count: startToComplete })}</span>
            : <span className="text-muted-foreground">—</span>}
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('taskDetail.metrics.overdueLabel')}</span>
          {overdueDays !== null ? (
            overdueDays > 0
              ? <span className="font-medium text-destructive">{t('taskDetail.metrics.overdueDays', { days: overdueDays })}</span>
              : <span className="font-medium flex items-center gap-1 text-emerald-500">{t('taskDetail.metrics.onTime')} <Check size={14} /></span>
          ) : <span className="text-muted-foreground">—</span>}
        </div>
      </div>

      {timeline.length > 0 && (
        <div className="border-t border-border pt-3">
          <h4 className="text-sm font-semibold text-foreground mb-2">{t('taskDetail.metrics.statusTimeline')}</h4>
          <div className="space-y-0 relative">
            {timeline.map((entry, i) => {
              const isLast = i === timeline.length - 1;
              const nextEntry = timeline[i + 1];
              const dwellMs = nextEntry ? new Date(nextEntry.date).getTime() - new Date(entry.date).getTime() : null;
              const dwellDays = dwellMs !== null ? Math.round(dwellMs / (1000 * 60 * 60 * 24)) : null;
              const dwellHours = dwellMs !== null && dwellMs < 1000 * 60 * 60 * 24 ? Math.round(dwellMs / (1000 * 60 * 60)) : null;
              return (
                <div key={i} className="flex gap-3 relative">
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5" style={{ backgroundColor: entry.statusColor }} />
                    {!isLast && <div className="w-px flex-1 min-h-[24px] bg-border" />}
                  </div>
                  <div className="pb-3 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: entry.statusColor }}>{entry.statusName}</span>
                      <span className="text-xs text-muted-foreground">{formatTimelineDate(entry.date)}</span>
                      {entry.changedByName && <span className="text-xs text-muted-foreground">by {entry.changedByName}</span>}
                    </div>
                    {dwellDays !== null && dwellDays > 0 && (
                      <div className={`text-xs mt-0.5 ${dwellDays > 7 ? 'text-amber-500' : 'text-muted-foreground'}`}>{t('taskDetail.metrics.dwellDays', { days: dwellDays })}</div>
                    )}
                    {dwellHours !== null && dwellDays === 0 && dwellHours > 0 && (
                      <div className="text-xs mt-0.5 text-muted-foreground">{t('taskDetail.metrics.dwellHours', { hours: dwellHours })}</div>
                    )}
                    {isLast && !task.completedAt && (
                      <div className="text-xs mt-0.5 text-muted-foreground italic">{t('taskDetail.metrics.currentStatus')}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isMobile && (
        <div className="border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h4>
          <TaskSidebarFields detail={detail} />
        </div>
      )}
    </div>
  );
};

export default TaskMetricsTab;
