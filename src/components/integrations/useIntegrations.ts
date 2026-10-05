import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { SlackSettings, WebhookSettings, EmailSettings, GitLabSettings, CalendarSettings } from './types';
import { DEFAULT_SLACK, DEFAULT_WEBHOOK, DEFAULT_EMAIL, DEFAULT_GITLAB, DEFAULT_CALENDAR } from './constants';

export function useIntegrations() {
  const { t } = useTranslation();
  const [slack, setSlack] = useState<SlackSettings>(DEFAULT_SLACK);
  const [webhook, setWebhook] = useState<WebhookSettings>(DEFAULT_WEBHOOK);
  const [email, setEmail] = useState<EmailSettings>(DEFAULT_EMAIL);
  const [gitlab, setGitlab] = useState<GitLabSettings>(DEFAULT_GITLAB);
  const [calendar, setCalendar] = useState<CalendarSettings>(DEFAULT_CALENDAR);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const keys = ['integration_slack', 'integration_webhook', 'integration_email', 'integration_gitlab', 'integration_calendar'];
    supabase
      .from('team_settings')
      .select('key, value')
      .in('key', keys)
      .then(({ data, error }) => {
        if (error) {
          setLoadError(error.message);
        } else if (data) {
          data.forEach(row => {
            const v = row.value as Record<string, unknown>;
            if (row.key === 'integration_slack') setSlack({ ...DEFAULT_SLACK, ...v } as SlackSettings);
            if (row.key === 'integration_webhook') setWebhook({ ...DEFAULT_WEBHOOK, ...v } as WebhookSettings);
            if (row.key === 'integration_email') setEmail({ ...DEFAULT_EMAIL, ...v } as EmailSettings);
            if (row.key === 'integration_gitlab') setGitlab({ ...DEFAULT_GITLAB, ...v } as GitLabSettings);
            if (row.key === 'integration_calendar') setCalendar({ ...DEFAULT_CALENDAR, ...v } as CalendarSettings);
          });
        }
        setLoaded(true);
      });
  }, []);

  const save = async (key: string, value: unknown) => {
    setSaving(s => ({ ...s, [key]: true }));
    const { error } = await supabase
      .from('team_settings')
      .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    setSaving(s => ({ ...s, [key]: false }));
    if (error) toast.error(t('integrations.saveFailed') + error.message);
    else {
      toast.success(t('integrations.saveSuccess'));
    }
  };

  const testSlack = async () => {
    if (!slack.webhookUrl) { toast.error(t('integrations.slack.webhookRequired')); return; }
    setTesting(true);
    try {
      const resp = await fetch(slack.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t('integrations.slack.testSuccessMsg') }),
      });
      if (resp.ok) toast.success(t('integrations.slack.testSent'));
      else toast.error(t('integrations.slack.testFailedHttp') + resp.status + ')');
    } catch {
      toast.error(t('integrations.slack.testConnectionError'));
    } finally {
      setTesting(false);
    }
  };

  return {
    slack, setSlack,
    webhook, setWebhook,
    email, setEmail,
    gitlab, setGitlab,
    calendar, setCalendar,
    saving, loaded, loadError, testing,
    save, testSlack,
  };
};