import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  templateQueries,
  type NotificationTemplate,
  type EventType,
} from '@/lib/notificationQueries';

export interface TemplateContext {
  task_name?: string;
  task_url?: string;
  assignee?: string;
  reporter?: string;
  project_name?: string;
  status?: string;
  prev_status?: string;
  priority?: string;
  due_date?: string;
  due_remaining?: string;
  overdue_days?: string;
  description_summary?: string;
  approver?: string;
  subtask_progress?: string;
}

import i18n from '@/i18n';

const FALLBACK_KEY = 'common.notSet';

/** Pure function — safe to import outside the hook */
export function resolveTemplate(content: string, ctx: TemplateContext): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = ctx[key as keyof TemplateContext];
    return val !== undefined && val !== '' ? val : i18n.t(FALLBACK_KEY);
  });
}

export function useNotificationTemplates() {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async (eventType?: EventType) => {
    setLoading(true);
    setError(null);
    const query = eventType
      ? templateQueries.fetchByEvent(supabase, eventType)
      : templateQueries.fetchAll(supabase);
    const { data, error: err } = await query;
    if (err) {
      setError((err as { message: string }).message);
    } else {
      setTemplates((data as NotificationTemplate[]) ?? []);
    }
    setLoading(false);
  }, []);

  const createTemplate = useCallback(async (
    data: Omit<NotificationTemplate, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NotificationTemplate | null> => {
    const { data: created, error: err } = await templateQueries.create(supabase, data);
    if (err) {
      console.error('[LIVO] Failed to create template:', (err as { message: string }).message);
      return null;
    }
    const t = created as NotificationTemplate;
    setTemplates(prev => [...prev, t]);
    return t;
  }, []);

  const updateTemplate = useCallback(async (
    id: string,
    data: Partial<NotificationTemplate>,
  ): Promise<NotificationTemplate | null> => {
    const { data: updated, error: err } = await templateQueries.update(supabase, id, data);
    if (err) {
      console.error('[LIVO] Failed to update template:', (err as { message: string }).message);
      return null;
    }
    const t = updated as NotificationTemplate;
    setTemplates(prev => prev.map(x => (x.id === id ? t : x)));
    return t;
  }, []);

  const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
    const { error: err } = await templateQueries.delete(supabase, id);
    if (err) {
      console.error('[LIVO] Failed to delete template:', (err as { message: string }).message);
      return false;
    }
    setTemplates(prev => prev.filter(x => x.id !== id));
    return true;
  }, []);

  return {
    templates,
    loading,
    error,
    fetchTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    resolveTemplate,
  };
}
