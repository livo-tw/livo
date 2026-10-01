import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { clipAvatarText } from '@/lib/avatarText';

// Badge colours offered in the picker; any #RRGGBB can also be chosen.
const AVATAR_COLORS = [
  '#FF5630', '#FF8B00', '#FFAB00', '#36B37E', '#00875A', '#00B8D9',
  '#0065FF', '#6554C0', '#E774BB', '#6B778C', '#172B4D', '#000000',
];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Each member edits their own round badge: its text (1–2 characters or an emoji) and colour. */
const MyAvatarSettings = () => {
  const { t } = useTranslation();
  const { realMember } = useAuthContext();
  const { refreshUsers } = useMemberContext();
  const [avatar, setAvatar] = useState('');
  const [color, setColor] = useState('#0065FF');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!realMember) return;
    setAvatar(realMember.avatar || '');
    setColor(realMember.color || '#0065FF');
  }, [realMember?.id, realMember?.avatar, realMember?.color]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!realMember) return null;

  const trimmed = avatar.trim();
  const valid = trimmed.length > 0 && COLOR_RE.test(color);
  const changed = trimmed !== realMember.avatar || color.toLowerCase() !== (realMember.color || '').toLowerCase();

  const save = async () => {
    if (!valid || !changed || saving) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('members')
        .update({ avatar: trimmed, color } as Record<string, unknown>)
        .eq('id', realMember.id);
      if (error) {
        toast.error(t('settings.avatarSaveFailed') + error.message);
        return;
      }
      await refreshUsers();
      toast.success(t('settings.avatarSaved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row gap-5">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
        style={{ backgroundColor: COLOR_RE.test(color) ? color : '#6B778C' }}
        aria-label={t('settings.avatarPreview')}
      >
        {trimmed || '?'}
      </div>
      <div className="flex-1 space-y-4">
        <div>
          <label htmlFor="my-avatar-text" className="text-xs font-medium text-muted-foreground block mb-1">{t('settings.avatarTextLabel')}</label>
          <input
            id="my-avatar-text"
            type="text"
            value={avatar}
            onChange={e => setAvatar(clipAvatarText(e.target.value))}
            className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="text-[11px] text-muted-foreground mt-1">{t('settings.avatarTextHint')}</p>
        </div>
        <div>
          <span className="text-xs font-medium text-muted-foreground block mb-1">{t('settings.avatarColorLabel')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {AVATAR_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                aria-pressed={color.toLowerCase() === c.toLowerCase()}
                className="w-7 h-7 rounded-full transition-transform hover:scale-110"
                style={{
                  backgroundColor: c,
                  boxShadow: color.toLowerCase() === c.toLowerCase() ? '0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--primary))' : 'none',
                }}
              />
            ))}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer ml-1">
              <input
                type="color"
                value={COLOR_RE.test(color) ? color : '#0065FF'}
                onChange={e => setColor(e.target.value)}
                className="w-7 h-7 rounded border border-border bg-transparent cursor-pointer"
              />
              {t('settings.avatarCustomColor')}
            </label>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || !changed || saving}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
};

export default MyAvatarSettings;
