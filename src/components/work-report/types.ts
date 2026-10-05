import { format, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays, addDays, subWeeks, addWeeks, subMonths, addMonths } from 'date-fns';
import { dateFnsLocale } from '@/lib/dateLabels';
import i18n from '@/i18n';

export type ReportType = 'daily' | 'weekly' | 'monthly';

export interface WorkReport {
  id?: string;
  userId: string;
  reportType: ReportType;
  periodStart: string;
  periodEnd: string;
  title: string;
  content: string;
  isEdited: boolean;
  generatedAt: string;
  updatedAt: string;
}

export function getTabLabels(): Record<ReportType, string> {
  return {
    daily: i18n.t('workReport.tabs.daily'),
    weekly: i18n.t('workReport.tabs.weekly'),
    monthly: i18n.t('workReport.tabs.monthly'),
  };
}

export const TAB_LABELS: Record<ReportType, string> = { daily: '日報', weekly: '週報', monthly: '月報' };

export function getPeriodRange(type: ReportType, anchor: Date): { start: Date; end: Date } {
  if (type === 'daily') {
    return { start: startOfDay(anchor), end: endOfDay(anchor) };
  }
  if (type === 'weekly') {
    return {
      start: startOfWeek(anchor, { weekStartsOn: 1 }),
      end: endOfWeek(anchor, { weekStartsOn: 1 }),
    };
  }
  return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
}

export function shiftAnchor(type: ReportType, anchor: Date, dir: -1 | 1): Date {
  if (type === 'daily') return dir === -1 ? subDays(anchor, 1) : addDays(anchor, 1);
  if (type === 'weekly') return dir === -1 ? subWeeks(anchor, 1) : addWeeks(anchor, 1);
  return dir === -1 ? subMonths(anchor, 1) : addMonths(anchor, 1);
}

export function periodTitle(type: ReportType, start: Date, end: Date): string {
  if (type === 'daily') return format(start, 'yyyy/MM/dd (EEE)', { locale: dateFnsLocale() });
  if (type === 'weekly') return `${format(start, 'yyyy/MM/dd')} ~ ${format(end, 'MM/dd')}`;
  return format(start, 'yyyy/MM', { locale: dateFnsLocale() });
}
