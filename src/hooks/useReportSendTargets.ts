import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  targetQueries,
  type ReportSendTarget,
  type ChannelType,
  type ReportSendFormat,
  type ChannelConfig,
} from '@/lib/reportSendQueries';

interface CreateTargetInput {
  project_id?: string | null;
  report_type: 'daily' | 'weekly' | 'monthly';
  channel_type: ChannelType;
  channel_config: ChannelConfig;
  format: ReportSendFormat;
  created_by: string;
}

export function useReportSendTargets() {
  const [targets, setTargets] = useState<ReportSendTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTargets = useCallback(async (
    reportType?: string,
    projectId?: string,
  ): Promise<ReportSendTarget[]> => {
    setLoading(true);
    setError(null);
    try {
      let query;
      if (reportType && projectId) {
        // Fetch global (project_id=null) + project-specific targets for this type
        query = targetQueries.fetchByProjectAndType(supabase, projectId, reportType);
      } else if (reportType) {
        query = targetQueries.fetchByReportType(supabase, reportType);
      } else if (projectId) {
        query = targetQueries.fetchByProject(supabase, projectId);
      } else {
        query = targetQueries.fetchAll(supabase);
      }
      const { data, error: err } = await query;
      if (err) throw new Error(err.message);
      const result = (data as ReportSendTarget[]) ?? [];
      setTargets(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const createTarget = useCallback(async (input: CreateTargetInput) => {
    const { data, error: err } = await targetQueries.create(supabase, {
      project_id: input.project_id ?? null,
      report_type: input.report_type,
      channel_type: input.channel_type,
      channel_config: input.channel_config,
      format: input.format,
      is_enabled: true,
      created_by: input.created_by,
    });
    if (err) throw new Error(err.message);
    const created = data as ReportSendTarget;
    setTargets(prev => [...prev, created]);
    return created;
  }, []);

  const updateTarget = useCallback(async (id: string, updates: Partial<ReportSendTarget>) => {
    const { data, error: err } = await targetQueries.update(supabase, id, updates);
    if (err) throw new Error(err.message);
    const updated = data as ReportSendTarget;
    setTargets(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const deleteTarget = useCallback(async (id: string) => {
    const { error: err } = await targetQueries.delete(supabase, id);
    if (err) throw new Error(err.message);
    setTargets(prev => prev.filter(t => t.id !== id));
  }, []);

  const toggleTarget = useCallback(async (id: string, enabled: boolean) => {
    const { data, error: err } = await targetQueries.toggle(supabase, id, enabled);
    if (err) throw new Error(err.message);
    const updated = data as ReportSendTarget;
    setTargets(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  /**
   * 合并全域 + 项目级配置，项目级优先（同 channel_type+report_type 覆盖全域）
   * 全局目标 project_id=null；项目目标 project_id=projectId
   */
  const getEffectiveTargets = useCallback((
    reportType: string,
    projectId?: string,
  ): ReportSendTarget[] => {
    const forType = targets.filter(t => t.report_type === reportType && t.is_enabled);
    const globals = forType.filter(t => t.project_id === null);
    if (!projectId) return globals;
    const projectTargets = forType.filter(t => t.project_id === projectId);
    // 项目级覆盖同 channel_type 的全域配置
    const overriddenTypes = new Set(projectTargets.map(t => t.channel_type));
    const merged = [
      ...globals.filter(t => !overriddenTypes.has(t.channel_type)),
      ...projectTargets,
    ];
    return merged;
  }, [targets]);

  return {
    targets,
    loading,
    error,
    fetchTargets,
    createTarget,
    updateTarget,
    deleteTarget,
    toggleTarget,
    getEffectiveTargets,
  };
}
