import { Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmailSettings } from './types';
import { EMAIL_EVENTS } from './constants';
import { ServiceCard, Field, EventCheckboxes, inputCls } from './shared';

interface EmailCardProps {
  email: EmailSettings;
  onChange: (s: EmailSettings) => void;
  onSave: () => void;
  saving: boolean;
}

const EmailCard = ({ email, onChange, onSave, saving }: EmailCardProps) => {
  const { t } = useTranslation();
  return (
  <ServiceCard
    icon={<Mail size={20} />}
    title={t('integrations.email.title')}
    description={t('integrations.email.desc')}
    enabled={email.enabled}
    onToggle={v => onChange({ ...email, enabled: v })}
    onSave={onSave}
    saving={saving}
    badge={t('integrations.email.badge')}
  >
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('integrations.email.hostLabel')}>
        <input
          type="text"
          className={inputCls}
          placeholder="smtp.gmail.com"
          value={email.smtpHost}
          onChange={e => onChange({ ...email, smtpHost: e.target.value })}
        />
      </Field>
      <Field label={t('integrations.email.portLabel')}>
        <input
          type="number"
          className={inputCls}
          placeholder="587"
          value={email.smtpPort}
          onChange={e => onChange({ ...email, smtpPort: Number(e.target.value) })}
        />
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('integrations.email.usernameLabel')}>
        <input
          type="text"
          className={inputCls}
          placeholder="user@example.com"
          value={email.smtpUser}
          onChange={e => onChange({ ...email, smtpUser: e.target.value })}
        />
      </Field>
      <Field label={t('integrations.email.passwordLabel')}>
        <input
          type="password"
          className={inputCls}
          placeholder="••••••••"
          value={email.smtpPassword}
          onChange={e => onChange({ ...email, smtpPassword: e.target.value })}
        />
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('integrations.email.fromNameLabel')}>
        <input
          type="text"
          className={inputCls}
          placeholder="LIVO"
          value={email.fromName}
          onChange={e => onChange({ ...email, fromName: e.target.value })}
        />
      </Field>
      <Field label={t('integrations.email.fromEmailLabel')}>
        <input
          type="email"
          className={inputCls}
          placeholder="noreply@yourdomain.com"
          value={email.fromEmail}
          onChange={e => onChange({ ...email, fromEmail: e.target.value })}
        />
      </Field>
    </div>
    <Field label={t('integrations.email.eventsLabel')}>
      <EventCheckboxes
        options={EMAIL_EVENTS}
        values={email.events}
        onChange={v => onChange({ ...email, events: v })}
      />
    </Field>
    <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2 border border-border">
      {t('integrations.email.warning')}
    </p>
  </ServiceCard>
  );
};

export default EmailCard;
