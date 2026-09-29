import { Task, Status } from '@/types';
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  isWithinInterval,
  parseISO,
  addDays,
} from 'date-fns';
import { zhTW } from 'date-fns/locale';
import i18n from '@/i18n';

export type AutoReportType = 'daily' | 'weekly';

export interface GenerateReportOptions {
  reportType: AutoReportType;
  tasks: Task[];
  statuses: Status[];
  memberId: string;
  customTemplate?: string;
}

export interface GeneratedReport {
  title: string;
  content: string;
  periodStart: string;
  periodEnd: string;
}

export function generateReportContent(opts: GenerateReportOptions): GeneratedReport {
  const { reportType, tasks, statuses, memberId, customTemplate } = opts;
  const today = new Date();

  const start =
    reportType === 'daily'
      ? startOfDay(today)
      : startOfWeek(today, { weekStartsOn: 1 });
  const end =
    reportType === 'daily'
      ? endOfDay(today)
      : endOfWeek(today, { weekStartsOn: 1 });

  const periodStart = format(start, 'yyyy-MM-dd');
  const periodEnd = format(end, 'yyyy-MM-dd');

  const title =
    reportType === 'daily'
      ? format(today, 'yyyy/MM/dd (EEE)', { locale: zhTW })
      : `${format(start, 'yyyy/MM/dd')} ~ ${format(end, 'MM/dd')}`;

  const doneIds = statuses.filter(s => s.isDone).map(s => s.id);
  const myTasks = tasks.filter(t => t.assigneeId === memberId);

  const inPeriod = (dateStr?: string) => {
    if (!dateStr) return false;
    try {
      return isWithinInterval(parseISO(dateStr), { start, end });
    } catch {
      return false;
    }
  };

  const completedInPeriod = myTasks.filter(
    t => doneIds.includes(t.statusId) && inPeriod(t.completedAt),
  );
  const inProgressAll = myTasks.filter(t => !doneIds.includes(t.statusId));
  const overdue = inProgressAll.filter(t => {
    if (!t.dueDate) return false;
    try {
      return parseISO(t.dueDate) < today;
    } catch {
      return false;
    }
  });
  const upcoming = inProgressAll.filter(t => {
    if (!t.dueDate) return false;
    try {
      const due = parseISO(t.dueDate);
      return due >= today && due <= addDays(today, 3);
    } catch {
      return false;
    }
  });
  const ongoing = inProgressAll.filter(t => !overdue.includes(t));

  const taskLine = (t: Task) => {
    const due = t.dueDate ? ` (${format(parseISO(t.dueDate), 'MM/dd')} ${i18n.t('workReport.generator.due')})` : '';
    return `• [${t.taskKey}] ${t.title}${due}`;
  };

  const none = i18n.t('workReport.generator.none');
  let content: string;

  if (customTemplate) {
    const dateStr = format(today, 'yyyy/MM/dd');
    content = customTemplate
      .replace(/\{\{date\}\}/g, dateStr)
      .replace(/\{\{task_count\}\}/g, String(myTasks.length))
      .replace(/\{\{completed_count\}\}/g, String(completedInPeriod.length))
      .replace(/\{\{in_progress_count\}\}/g, String(ongoing.length))
      .replace(/\{\{overdue_count\}\}/g, String(overdue.length))
      .replace(
        /\{\{completed_tasks\}\}/g,
        completedInPeriod.length > 0 ? completedInPeriod.map(taskLine).join('\n') : none,
      )
      .replace(
        /\{\{in_progress_tasks\}\}/g,
        ongoing.length > 0 ? ongoing.map(taskLine).join('\n') : none,
      )
      .replace(
        /\{\{overdue_tasks\}\}/g,
        overdue.length > 0 ? overdue.map(taskLine).join('\n') : none,
      )
      .replace(
        /\{\{upcoming_deadlines\}\}/g,
        upcoming.length > 0 ? upcoming.map(taskLine).join('\n') : none,
      )
      .replace(
        /\{\{all_tasks\}\}/g,
        myTasks.length > 0 ? myTasks.map(taskLine).join('\n') : none,
      );
  } else {
    const headerLabel = reportType === 'daily' ? i18n.t('workReport.generator.dailyReport') : i18n.t('workReport.generator.weeklyReport');
    const completedLabel = reportType === 'daily' ? i18n.t('workReport.generator.completedToday') : i18n.t('workReport.generator.completedThisWeek');
    const lines: string[] = [];

    lines.push(`【${headerLabel}】 ${title}`);
    lines.push('');

    lines.push(`${completedLabel}（${completedInPeriod.length}）`);
    if (completedInPeriod.length > 0) {
      completedInPeriod.forEach(t => lines.push(taskLine(t)));
    } else {
      lines.push(i18n.t('workReport.generator.noCompletedThisPeriod'));
    }
    lines.push('');

    lines.push(`${i18n.t('workReport.generator.inProgress')}（${ongoing.length}）`);
    if (ongoing.length > 0) {
      ongoing.forEach(t => lines.push(taskLine(t)));
    } else {
      lines.push(none);
    }
    lines.push('');

    if (overdue.length > 0) {
      lines.push(`${i18n.t('workReport.generator.overdue')}（${overdue.length}）`);
      overdue.forEach(t => {
        const daysLate = Math.floor(
          (today.getTime() - parseISO(t.dueDate!).getTime()) / 86400000,
        );
        lines.push(`• [${t.taskKey}] ${t.title}（${i18n.t('workReport.generator.overdueDays', { count: daysLate })}）`);
      });
      lines.push('');
    }

    if (upcoming.length > 0) {
      lines.push(`${i18n.t('workReport.generator.upcoming')}（${upcoming.length}）`);
      upcoming.forEach(t => lines.push(taskLine(t)));
      lines.push('');
    }

    lines.push('---');
    lines.push(
      `${i18n.t('workReport.generator.totalTasks')}${myTasks.length} | ${i18n.t('workReport.generator.completedPeriod')}${completedInPeriod.length} | ${i18n.t('workReport.generator.inProgressLabel')}${ongoing.length} | ${i18n.t('workReport.generator.overdueLabel')}${overdue.length}`,
    );
    content = lines.join('\n');
  }

  return { title, content, periodStart, periodEnd };
}
