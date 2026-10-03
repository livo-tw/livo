import { SearchableSelect } from '@/components/ui/searchable-select';
import { Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CalendarSettings } from './types';
import { ServiceCard, Field, inputCls } from './shared';

interface CalendarCardProps {
  calendar: CalendarSettings;
  onChange: (s: CalendarSettings) => void;
  onSave: () => void;
  saving: boolean;
}

const CalendarCard = ({ calendar, onChange, onSave, saving }: CalendarCardProps) => {
  const { t } = useTranslation();
  return (
  <ServiceCard
    icon={<Calendar size={20} />}
    title={t('integrations.calendar.title')}
    description={t('integrations.calendar.desc')}
    enabled={calendar.enabled}
    onToggle={v => onChange({ ...calendar, enabled: v })}
    onSave={onSave}
    saving={saving}
    badge={t('common.comingSoon')}
  >
    <Field label={t('integrations.calendar.providerLabel')}>
      <SearchableSelect
        className={inputCls}
        value={calendar.provider}
        onChange={e => onChange({ ...calendar, provider: e.target.value as 'google' | 'ical' })}
      >
        <option value="google">{t('integrations.calendar.providerGoogle')}</option>
        <option value="ical">{t('integrations.calendar.providerIcal')}</option>
      </SearchableSelect>
    </Field>
    <Field label="Calendar ID / URL">
      <input
        type="text"
        className={inputCls}
        placeholder={calendar.provider === 'google'
          ? 'primary 或 your-calendar-id@group.calendar.google.com'
          : 'https://caldav.example.com/calendar/'}
        value={calendar.calendarId}
        onChange={e => onChange({ ...calendar, calendarId: e.target.value })}
      />
    </Field>
    <div className="flex gap-4">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={calendar.syncDueDates}
          onChange={e => onChange({ ...calendar, syncDueDates: e.target.checked })}
          className="rounded"
        />
        <span className="text-sm text-foreground">{t('integrations.calendar.syncDueDates')}</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={calendar.syncStartDates}
          onChange={e => onChange({ ...calendar, syncStartDates: e.target.checked })}
          className="rounded"
        />
        <span className="text-sm text-foreground">{t('integrations.calendar.syncStartDates')}</span>
      </label>
    </div>
  </ServiceCard>
  );
};

export default CalendarCard;
