// Per-user Email notification preferences (我的設定 → Email 通知).
//
// Extends the SAME user_notification_preferences row that
// SlackNotifyPreferences upserts (keyed by user_id) with two new columns:
//   email_notify_enabled: boolean   (DB default 1)
//   email_notify_types:   string[]  ('assigned' | 'mentioned' | 'due_soon')
// Only the email columns are written here so the Slack digest columns are
// never clobbered (and vice versa).

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '@/context/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Mail } from 'lucide-react';

type EmailNotifyType = 'assigned' | 'mentioned' | 'due_soon';

const ALL_TYPES: EmailNotifyType[] = ['assigned', 'mentioned', 'due_soon'];

const TYPE_LABEL_KEYS: Record<EmailNotifyType, string> = {
  assigned: 'settings.emailNotifyAssigned',
  mentioned: 'settings.emailNotifyMentioned',
  due_soon: 'settings.emailNotifyDueSoon',
};

// The generated supabase types predate the email_notify_* columns, so go
// through a minimal structural facade (runtime behaviour is unchanged).
interface PrefRow { email_notify_enabled?: boolean; email_notify_types?: unknown }
interface PrefsResult { data: PrefRow | null; error: { message: string } | null }
interface PrefsFilter {
  eq(col: string, val: unknown): PrefsFilter;
  maybeSingle(): PromiseLike<PrefsResult>;
}
interface PrefsTable {
  select(cols: string): PrefsFilter;
  upsert(vals: Record<string, unknown>, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
}
const prefsTable = (): PrefsTable =>
  (supabase as unknown as { from(table: string): PrefsTable }).from('user_notification_preferences');

const EmailNotifyPreferences = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  // DB defaults: enabled with all three types on.
  const [enabled, setEnabled] = useState(true);
  const [types, setTypes] = useState<EmailNotifyType[]>(ALL_TYPES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentMemberId) return;
    const load = async () => {
      const { data } = await prefsTable()
        .select('*')
        .eq('user_id', currentMemberId)
        .maybeSingle();
      if (data) {
        setEnabled(data.email_notify_enabled ?? true);
        const raw = data.email_notify_types;
        if (Array.isArray(raw)) {
          setTypes(raw.filter((v): v is EmailNotifyType => (ALL_TYPES as string[]).includes(v as string)));
        }
      }
      setLoading(false);
    };
    load();
  }, [currentMemberId]);

  const toggleType = (type: EmailNotifyType) => {
    setTypes(prev => prev.includes(type) ? prev.filter(v => v !== type) : [...prev, type]);
  };

  const handleSave = async () => {
    if (!currentMemberId) return;
    setSaving(true);
    const { error } = await prefsTable()
      .upsert({
        user_id: currentMemberId,
        email_notify_enabled: enabled,
        email_notify_types: types,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    setSaving(false);
    if (error) {
      toast.error(t('settings.emailNotifySaveFailed') + ' ' + error.message);
    } else {
      toast.success(t('settings.emailNotifySaved'));
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>;

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-primary" />
          <span className="text-sm font-medium text-foreground">{t('settings.emailNotifyEnable')}</span>
        </div>
        <button
          onClick={() => setEnabled(v => !v)}
          className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {enabled && (
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-2 block">{t('settings.emailNotifyTypesLabel')}</label>
          <div className="space-y-2">
            {ALL_TYPES.map(type => (
              <label key={type} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={types.includes(type)}
                  onChange={() => toggleType(type)}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{t(TYPE_LABEL_KEYS[type])}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Save */}
      <div className="pt-2">
        <button
          onClick={handleSave}
          disabled={saving || (enabled && types.length === 0)}
          className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? t('common.saving') : t('settings.emailNotifySaveButton')}
        </button>
      </div>
    </div>
  );
};

export default EmailNotifyPreferences;
