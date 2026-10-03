import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateReportContent, type AutoReportType } from '@/lib/reportGenerator';
import i18n from '@/i18n';
import type { Task, Status } from '@/types';
import { listTaskReminderPreferences } from '@/lib/taskPlanning/client';
import { reminderPaused } from '@/lib/taskPlanning/core';

export function useSideEffects(
  currentMemberId: string,
  allTasks: Task[],
  statuses: Status[],
) {
  const autoReportCheckedRef = useRef(false);
  const dueSoonCheckedRef = useRef(false);

  // Due-soon notification
  useEffect(() => {
    if (!currentMemberId || allTasks.length === 0 || dueSoonCheckedRef.current) return;
    dueSoonCheckedRef.current = true;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = tomorrow.toISOString().split('T')[0];
    const todayStart = new Date().toISOString().split('T')[0];

    const dueSoonTasks = allTasks.filter(t =>
      t.dueDate === tomorrowDate &&
      (t.assigneeId === currentMemberId || t.reviewerId === currentMemberId)
    );
    if (dueSoonTasks.length === 0) return;

    (async () => {
      const preferences=await listTaskReminderPreferences(currentMemberId);
      const paused=new Set(preferences.filter(p=>reminderPaused(p.snoozed_until)).map(p=>p.task_id));
      const { data } = await supabase
        .from('notifications')
        .select('task_id')
        .eq('recipient_id', currentMemberId)
        .eq('type', 'due_soon')
        .gte('created_at', todayStart);
      const alreadyNotified = new Set((data || []).map(n => n.task_id));
      const toNotify = dueSoonTasks.filter(t => !alreadyNotified.has(t.id) && !paused.has(t.id));
      if (toNotify.length === 0) return;
      const rows = toNotify.map(t => ({
        recipient_id: currentMemberId,
        sender_id: currentMemberId,
        type: 'due_soon',
        task_id: t.id,
        content: i18n.t('notification.types.dueSoon') + `：${t.title}`,
        is_read: false,
      }));
      const { error } = await supabase.from('notifications').insert(rows);
      if (error) console.error('[LIVO] due-soon notification insert failed:', error.message);
    })().catch(()=>{ dueSoonCheckedRef.current=false; });
  }, [currentMemberId, allTasks]);

  // Auto-report generation
  useEffect(() => {
    if (!currentMemberId || allTasks.length === 0 || statuses.length === 0 || autoReportCheckedRef.current) return;
    autoReportCheckedRef.current = true;

    const toDateStr = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const getWeekStart = (d: Date): Date => {
      const copy = new Date(d);
      const day = copy.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      copy.setDate(copy.getDate() + diff);
      copy.setHours(0, 0, 0, 0);
      return copy;
    };

    const getWeekEnd = (d: Date): Date => {
      const start = getWeekStart(d);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return end;
    };

    const checkAutoReports = async () => {
      const { data: configs } = await supabase
        .from('user_report_configs')
        .select('*')
        .eq('user_id', currentMemberId)
        .eq('enabled', true);

      if (!configs || configs.length === 0) return;

      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const currentWeekday = now.getDay();

      for (const cfg of configs) {
        const timeReached =
          currentHour > cfg.hour ||
          (currentHour === cfg.hour && currentMinute >= cfg.minute);
        if (!timeReached) continue;

        if (cfg.report_type === 'weekly' && cfg.weekday !== currentWeekday) continue;

        const periodStart =
          cfg.report_type === 'daily'
            ? toDateStr(now)
            : toDateStr(getWeekStart(now));

        const periodEnd =
          cfg.report_type === 'daily'
            ? periodStart
            : toDateStr(getWeekEnd(now));

        const { data: existing } = await supabase
          .from('work_reports')
          .select('id')
          .eq('user_id', currentMemberId)
          .eq('report_type', cfg.report_type)
          .eq('period_start', periodStart)
          .maybeSingle();
        if (existing) continue;

        const customTemplate =
          cfg.template_key === 'custom' && cfg.custom_template
            ? (cfg.custom_template as string)
            : undefined;

        const { title, content } = generateReportContent({
          reportType: cfg.report_type as AutoReportType,
          tasks: allTasks,
          statuses,
          memberId: currentMemberId,
          customTemplate,
        });

        const { error: saveErr } = await supabase.from('work_reports').insert({
          user_id: currentMemberId,
          report_type: cfg.report_type,
          period_start: periodStart,
          period_end: periodEnd,
          title,
          content,
          is_edited: false,
          generated_at: now.toISOString(),
          updated_at: now.toISOString(),
        } as Record<string, unknown>);

        if (!saveErr) {
          const reportLabel = cfg.report_type === 'daily' ? i18n.t('autoReport.dailyLabel') : i18n.t('autoReport.weeklyLabel');
          await supabase.from('notifications').insert({
            recipient_id: currentMemberId,
            sender_id: currentMemberId,
            type: 'system',
            task_id: '',
            content: `${reportLabel} - ${periodStart}`,
            is_read: false,
          } as Record<string, unknown>);
        }
      }
    };

    checkAutoReports().catch(err => console.error('[LIVO] auto-report check failed:', err));
  }, [currentMemberId, allTasks, statuses]);
}
