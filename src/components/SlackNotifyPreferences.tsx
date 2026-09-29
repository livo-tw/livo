import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '@/context/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Bell, Clock } from 'lucide-react';

interface NotifyPrefs {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  weekday: number; // 0=Sun, 1=Mon, ... 6=Sat
  hour: number;
  includeAssigned: boolean;
  includeReview: boolean;
}

const DEFAULT_PREFS: NotifyPrefs = {
  enabled: false,
  frequency: 'daily',
  weekday: 1,
  hour: 9,
  includeAssigned: true,
  includeReview: true,
};

const SlackNotifyPreferences = () => {
  const { t } = useTranslation();
  const WEEKDAYS = [t('slackNotify.weekdays.sun'), t('slackNotify.weekdays.mon'), t('slackNotify.weekdays.tue'), t('slackNotify.weekdays.wed'), t('slackNotify.weekdays.thu'), t('slackNotify.weekdays.fri'), t('slackNotify.weekdays.sat')];
  const { currentMemberId } = useAuthContext();
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentMemberId) return;
    const load = async () => {
      const { data } = await supabase
        .from('user_notification_preferences')
        .select('*')
        .eq('user_id', currentMemberId)
        .maybeSingle();
      if (data) {
        setPrefs({
          enabled: data.enabled ?? false,
          frequency: data.frequency ?? 'daily',
          weekday: data.weekday ?? 1,
          hour: data.hour ?? 9,
          includeAssigned: data.include_assigned ?? true,
          includeReview: data.include_review ?? true,
        });
      }
      setLoading(false);
    };
    load();
  }, [currentMemberId]);

  const handleSave = async () => {
    if (!currentMemberId) return;
    setSaving(true);
    const { error } = await supabase
      .from('user_notification_preferences')
      .upsert({
        user_id: currentMemberId,
        enabled: prefs.enabled,
        frequency: prefs.frequency,
        weekday: prefs.weekday,
        hour: prefs.hour,
        include_assigned: prefs.includeAssigned,
        include_review: prefs.includeReview,
        updated_at: new Date().toISOString(),
      } as Record<string, unknown>, { onConflict: 'user_id' });
    setSaving(false);
    if (error) {
      toast.error(t('slackNotify.saveFailed') + ' ' + error.message);
    } else {
      toast.success(t('slackNotify.saveSuccess'));
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">{t('slackNotify.loading')}</div>;

  return (
    <div className="space-y-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell size={16} className="text-primary" />
          <span className="text-sm font-medium text-foreground">{t('slackNotify.enableLabel')}</span>
        </div>
        <button
          onClick={() => setPrefs(prev => ({ ...prev, enabled: !prev.enabled }))}
          className={`relative w-11 h-6 rounded-full transition-colors ${prefs.enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${prefs.enabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {prefs.enabled && (
        <>
          {/* Frequency */}
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('slackNotify.frequencyLabel')}</label>
            <div className="flex gap-2">
              <button
                onClick={() => setPrefs(prev => ({ ...prev, frequency: 'daily' }))}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  prefs.frequency === 'daily' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-accent'
                }`}
              >
                {t('slackNotify.daily')}
              </button>
              <button
                onClick={() => setPrefs(prev => ({ ...prev, frequency: 'weekly' }))}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  prefs.frequency === 'weekly' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-accent'
                }`}
              >
                {t('slackNotify.weekly')}
              </button>
            </div>
          </div>

          {/* Weekday (only show for weekly) */}
          {prefs.frequency === 'weekly' && (
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('slackNotify.weekdayLabel')}</label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((label, i) => (
                  <button
                    key={i}
                    onClick={() => setPrefs(prev => ({ ...prev, weekday: i }))}
                    className={`px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
                      prefs.weekday === i ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-accent'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Hour */}
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-1 block flex items-center gap-1.5">
              <Clock size={14} />
              {t('slackNotify.timeLabel')}
            </label>
            <select
              value={prefs.hour}
              onChange={e => setPrefs(prev => ({ ...prev, hour: parseInt(e.target.value) }))}
              className="w-full max-w-xs border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>

          {/* Content types */}
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">{t('slackNotify.contentLabel')}</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={prefs.includeAssigned}
                  onChange={() => setPrefs(prev => ({ ...prev, includeAssigned: !prev.includeAssigned }))}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{t('slackNotify.assignedTasks')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={prefs.includeReview}
                  onChange={() => setPrefs(prev => ({ ...prev, includeReview: !prev.includeReview }))}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{t('slackNotify.reviewTasks')}</span>
              </label>
            </div>
          </div>

          {/* Save */}
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={saving || (!prefs.includeAssigned && !prefs.includeReview)}
              className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('slackNotify.saveButton')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SlackNotifyPreferences;
