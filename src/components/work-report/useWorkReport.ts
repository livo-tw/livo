import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format, addDays, isWithinInterval, parseISO } from 'date-fns';
import { WorkReport, ReportType, getPeriodRange, periodTitle } from './types';
import i18n from '@/i18n';
import { copyText } from '@/lib/clipboard';

export function useWorkReport() {
  const { allTasks, statuses } = useTaskContext();
  const { currentMemberId } = useAuthContext();
  const { allProjects } = useProjectContext();

  const [reportType, setReportType] = useState<ReportType>('daily');
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [content, setContent] = useState('');
  const [savedReport, setSavedReport] = useState<WorkReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [history, setHistory] = useState<WorkReport[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const savedReportRef = useRef<WorkReport | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedContentRef = useRef('');

  savedReportRef.current = savedReport;

  const { start, end } = useMemo(() => getPeriodRange(reportType, anchor), [reportType, anchor]);
  const title = useMemo(() => periodTitle(reportType, start, end), [reportType, start, end]);

  const generateContent = useCallback((customTemplate?: string) => {
    const today = new Date();
    const done = statuses.filter(s => s.isDone).map(s => s.id);
    const myTasks = allTasks.filter(t => t.assigneeId === currentMemberId);

    const inPeriod = (dateStr?: string) => {
      if (!dateStr) return false;
      try {
        return isWithinInterval(parseISO(dateStr), { start, end });
      } catch { return false; }
    };

    const completedInPeriod = myTasks.filter(t =>
      done.includes(t.statusId) && inPeriod(t.completedAt)
    );
    const inProgress = myTasks.filter(t => !done.includes(t.statusId));
    const overdue = inProgress.filter(t => {
      if (!t.dueDate) return false;
      try { return parseISO(t.dueDate) < today; } catch { return false; }
    });
    const upcoming = inProgress.filter(t => {
      if (!t.dueDate) return false;
      try {
        const due = parseISO(t.dueDate);
        return due >= today && due <= addDays(today, 3);
      } catch { return false; }
    });
    const ongoing = inProgress.filter(t => !overdue.includes(t));

    const taskLine = (t: typeof allTasks[0]) => {
      const prefix = `[${t.taskKey}]`;
      const due = t.dueDate ? ` (${format(parseISO(t.dueDate), 'MM/dd')} ${i18n.t('workReport.generator.due')})` : '';
      return `• ${prefix} ${t.title}${due}`;
    };

    const none = i18n.t('workReport.generator.none');

    if (customTemplate) {
      const dateStr = format(today, 'yyyy/MM/dd');
      return customTemplate
        .replace(/\{\{date\}\}/g, dateStr)
        .replace(/\{\{task_count\}\}/g, String(myTasks.length))
        .replace(/\{\{completed_count\}\}/g, String(completedInPeriod.length))
        .replace(/\{\{in_progress_count\}\}/g, String(ongoing.length))
        .replace(/\{\{overdue_count\}\}/g, String(overdue.length))
        .replace(/\{\{completed_tasks\}\}/g, completedInPeriod.length > 0 ? completedInPeriod.map(taskLine).join('\n') : none)
        .replace(/\{\{in_progress_tasks\}\}/g, ongoing.length > 0 ? ongoing.map(taskLine).join('\n') : none)
        .replace(/\{\{overdue_tasks\}\}/g, overdue.length > 0 ? overdue.map(taskLine).join('\n') : none)
        .replace(/\{\{upcoming_deadlines\}\}/g, upcoming.length > 0 ? upcoming.map(taskLine).join('\n') : none)
        .replace(/\{\{all_tasks\}\}/g, myTasks.length > 0 ? myTasks.map(taskLine).join('\n') : none);
    }

    const isDaily = reportType === 'daily';
    const isWeekly = reportType === 'weekly';
    const headerLabel = isDaily ? i18n.t('workReport.generator.dailyReport') : isWeekly ? i18n.t('workReport.generator.weeklyReport') : i18n.t('workReport.generator.monthlyReport');
    const completedLabel = isDaily ? i18n.t('workReport.generator.completedToday') : isWeekly ? i18n.t('workReport.generator.completedThisWeek') : i18n.t('workReport.generator.completedThisMonth');

    const lines: string[] = [];
    lines.push(`【${headerLabel}】 ${title}`);
    lines.push('');
    lines.push(`${completedLabel}（${completedInPeriod.length}）`);
    if (completedInPeriod.length > 0) completedInPeriod.forEach(t => lines.push(taskLine(t)));
    else lines.push(i18n.t('workReport.generator.noCompletedThisPeriod'));
    lines.push('');
    lines.push(`${i18n.t('workReport.generator.inProgress')}（${ongoing.length}）`);
    if (ongoing.length > 0) ongoing.forEach(t => lines.push(taskLine(t)));
    else lines.push(none);
    lines.push('');
    if (overdue.length > 0) {
      lines.push(`${i18n.t('workReport.generator.overdue')}（${overdue.length}）`);
      overdue.forEach(t => {
        const daysLate = Math.floor((today.getTime() - parseISO(t.dueDate!).getTime()) / 86400000);
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
    lines.push(`${i18n.t('workReport.generator.totalTasks')}${myTasks.length} | ${i18n.t('workReport.generator.completedPeriod')}${completedInPeriod.length} | ${i18n.t('workReport.generator.inProgressLabel')}${ongoing.length} | ${i18n.t('workReport.generator.overdueLabel')}${overdue.length}`);

    return lines.join('\n');
  }, [allTasks, statuses, currentMemberId, allProjects, start, end, reportType, title]);

  const saveContent = useCallback(async (
    contentToSave: string,
    opts: { silent?: boolean; isEdited?: boolean } = {},
  ) => {
    if (!currentMemberId || !contentToSave.trim()) return;
    const { silent = false, isEdited = false } = opts;
    if (!silent) setSaving(true);
    setSaveStatus('saving');

    const currentSaved = savedReportRef.current;
    const row = {
      user_id: currentMemberId,
      report_type: reportType,
      period_start: format(start, 'yyyy-MM-dd'),
      period_end: format(end, 'yyyy-MM-dd'),
      title,
      content: contentToSave,
      is_edited: isEdited || (currentSaved?.isEdited ?? false),
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>;

    let error: { message: string } | null = null;
    if (currentSaved?.id) {
      ({ error } = await supabase.from('work_reports').update(row).eq('id', currentSaved.id));
    } else {
      ({ error } = await supabase.from('work_reports').insert({ ...row, generated_at: new Date().toISOString() }));
    }

    if (!silent) setSaving(false);
    if (error) {
      if (!silent) toast.error(i18n.t('workReport.saveFailed') + error.message);
      else console.error('[LIVO] Auto-save failed:', error.message);
      setSaveStatus('idle');
    } else {
      if (!silent) toast.success(i18n.t('workReport.saved'));
      lastLoadedContentRef.current = contentToSave;
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 3000);
      if (!currentSaved?.id) await loadReportSilent();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMemberId, reportType, start, end, title]);

  const loadReportSilent = useCallback(async () => {
    if (!currentMemberId) return;
    const { data } = await supabase
      .from('work_reports')
      .select('*')
      .eq('user_id', currentMemberId)
      .eq('report_type', reportType)
      .eq('period_start', format(start, 'yyyy-MM-dd'))
      .maybeSingle();
    if (data) {
      setSavedReport({
        id: data.id, userId: data.user_id, reportType: data.report_type as ReportType,
        periodStart: data.period_start, periodEnd: data.period_end, title: data.title,
        content: data.content, isEdited: data.is_edited, generatedAt: data.generated_at,
        updatedAt: data.updated_at,
      });
    }
  }, [currentMemberId, reportType, start]);

  const loadReport = useCallback(async () => {
    if (!currentMemberId) return;
    setLoading(true);
    const { data } = await supabase
      .from('work_reports')
      .select('*')
      .eq('user_id', currentMemberId)
      .eq('report_type', reportType)
      .eq('period_start', format(start, 'yyyy-MM-dd'))
      .maybeSingle();

    if (data) {
      const r: WorkReport = {
        id: data.id, userId: data.user_id, reportType: data.report_type as ReportType,
        periodStart: data.period_start, periodEnd: data.period_end, title: data.title,
        content: data.content, isEdited: data.is_edited, generatedAt: data.generated_at,
        updatedAt: data.updated_at,
      };
      setSavedReport(r);
      lastLoadedContentRef.current = data.content;
      setContent(data.content);
    } else {
      setSavedReport(null);
      lastLoadedContentRef.current = '';
      setContent('');
    }
    setLoading(false);
  }, [currentMemberId, reportType, start]);

  useEffect(() => { loadReport(); }, [loadReport]);

  useEffect(() => {
    if (content === lastLoadedContentRef.current) return;
    if (!content.trim() || !currentMemberId) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveContent(content, { silent: true, isEdited: true });
    }, 2000);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [content, currentMemberId, saveContent]);

  const loadHistory = useCallback(async () => {
    if (!currentMemberId) return;
    const { data } = await supabase
      .from('work_reports')
      .select('*')
      .eq('user_id', currentMemberId)
      .eq('report_type', reportType)
      .order('period_start', { ascending: false })
      .limit(20);
    if (data) {
      setHistory(data.map(row => ({
        id: row.id, userId: row.user_id, reportType: row.report_type as ReportType,
        periodStart: row.period_start, periodEnd: row.period_end, title: row.title,
        content: row.content, isEdited: row.is_edited, generatedAt: row.generated_at,
        updatedAt: row.updated_at,
      })));
    }
  }, [currentMemberId, reportType]);

  useEffect(() => { if (showHistory) loadHistory(); }, [showHistory, loadHistory]);

  const handleGenerate = async () => {
    let customTemplate: string | undefined;
    if (currentMemberId) {
      const { data: cfgData } = await supabase
        .from('user_report_configs')
        .select('template_key, custom_template')
        .eq('user_id', currentMemberId)
        .eq('report_type', reportType)
        .maybeSingle();
      if (cfgData?.template_key === 'custom' && cfgData.custom_template) {
        customTemplate = cfgData.custom_template as string;
      }
    }
    const generated = generateContent(customTemplate);
    setContent(generated);
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveContent(generated, { silent: true, isEdited: false });
    }, 500);
    toast.success(i18n.t('workReport.generated'));
  };

  const handleSave = async () => {
    if (!currentMemberId || !content.trim()) {
      toast.error(i18n.t('workReport.enterContent'));
      return;
    }
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    await saveContent(content, {
      silent: false,
      isEdited: savedReport ? content !== generateContent() : false,
    });
    await loadReport();
  };

  const handleCopy = () => {
    if (!content.trim()) { toast.error(i18n.t('workReport.nothingToCopy')); return; }
    void copyText(content).then(ok => {
      if (ok) toast.success(i18n.t('workReport.copied'));
      else toast.error(i18n.t('workReport.copyFailed'));
    });
  };

  const done = statuses.filter(s => s.isDone).map(s => s.id);
  const myTasks = allTasks.filter(t => t.assigneeId === currentMemberId);
  const today = new Date();
  const completedCount = myTasks.filter(t => done.includes(t.statusId)).length;
  const inProgressCount = myTasks.filter(t => !done.includes(t.statusId)).length;
  const overdueCount = myTasks.filter(t => {
    if (done.includes(t.statusId) || !t.dueDate) return false;
    try { return parseISO(t.dueDate) < today; } catch { return false; }
  }).length;

  return {
    reportType, setReportType,
    anchor, setAnchor,
    title, start, end,
    content, setContent,
    savedReport, setSavedReport,
    loading, saving, saveStatus,
    history,
    showHistory, setShowHistory,
    lastLoadedContentRef,
    completedCount, inProgressCount, overdueCount,
    handleGenerate, handleSave, handleCopy,
  };
};