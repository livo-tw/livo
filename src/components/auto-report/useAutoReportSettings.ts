import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { ReportConfig } from './types';
import { DEFAULT_DAILY, DEFAULT_WEEKLY } from './constants';
import { reportToDisplay, reportToStorage } from '@/lib/templateVariables';

export function useAutoReportSettings() {
  const { currentMemberId } = useAuthContext();
  const { allProjects, productLines } = useProjectContext();
  const [daily, setDaily] = useState<ReportConfig>(DEFAULT_DAILY);
  const [weekly, setWeekly] = useState<ReportConfig>(DEFAULT_WEEKLY);
  const [loading, setLoading] = useState(true);
  const [savingDaily, setSavingDaily] = useState(false);
  const [savingWeekly, setSavingWeekly] = useState(false);
  const [activeTab, setActiveTab] = useState<'daily' | 'weekly'>('daily');
  const [showPreview, setShowPreview] = useState(false);
  const dailyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const weeklyTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!currentMemberId) return;
    const load = async () => {
      const { data } = await supabase
        .from('user_report_configs')
        .select('*')
        .eq('user_id', currentMemberId);
      if (data) {
        for (const row of data) {
          const cfg: ReportConfig = {
            id: row.id,
            reportType: row.report_type,
            enabled: row.enabled,
            hour: row.hour,
            minute: row.minute,
            weekday: row.weekday,
            templateKey: row.template_key,
            customTemplate: row.custom_template ? reportToDisplay(row.custom_template) : '',
            scope: row.scope,
            scopeProjectIds: row.scope_project_ids || [],
            sendTarget: row.send_target,
            sendChannel: row.send_channel || '',
          };
          if (row.report_type === 'daily') setDaily(cfg);
          else setWeekly(cfg);
        }
      }
      setLoading(false);
    };
    load();
  }, [currentMemberId]);

  const handleSave = async (cfg: ReportConfig, setSaving: (v: boolean) => void) => {
    if (!currentMemberId) return;
    setSaving(true);
    const row: Record<string, unknown> = {
      user_id: currentMemberId,
      report_type: cfg.reportType,
      enabled: cfg.enabled,
      hour: cfg.hour,
      minute: cfg.minute,
      weekday: cfg.weekday,
      template_key: cfg.templateKey,
      custom_template: cfg.customTemplate ? reportToStorage(cfg.customTemplate) : null,
      scope: cfg.scope,
      scope_project_ids: cfg.scopeProjectIds.length > 0 ? cfg.scopeProjectIds : null,
      send_target: cfg.sendTarget,
      send_channel: cfg.sendChannel || null,
      updated_at: new Date().toISOString(),
    };
    if (cfg.id) row.id = cfg.id;
    const { error } = await supabase
      .from('user_report_configs')
      .upsert(row as never, { onConflict: 'user_id,report_type' });
    setSaving(false);
    if (error) toast.error(i18n.t('report.saveFailed') + error.message);
    else toast.success(i18n.t('report.configSaved', { type: cfg.reportType === 'daily' ? i18n.t('report.daily') : i18n.t('report.weekly') }));
  };

  const insertVariable = (
    varText: string,
    setCfg: (fn: (prev: ReportConfig) => ReportConfig) => void,
    textareaRef: React.RefObject<HTMLTextAreaElement>,
  ) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const newValue = before + varText + after;
    setCfg(prev => ({ ...prev, customTemplate: newValue }));
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + varText.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const groupedProjects = useMemo(() =>
    productLines.map(line => ({
      line,
      projects: allProjects.filter(p => p.lineId === line.id && !p.isArchived),
    })).filter(g => g.projects.length > 0),
  [productLines, allProjects]);

  return {
    daily, setDaily,
    weekly, setWeekly,
    loading,
    savingDaily, setSavingDaily,
    savingWeekly, setSavingWeekly,
    activeTab, setActiveTab,
    showPreview, setShowPreview,
    dailyTextareaRef, weeklyTextareaRef,
    groupedProjects,
    handleSave,
    insertVariable,
  };
}
