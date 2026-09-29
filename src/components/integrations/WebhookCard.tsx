import { Webhook } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WebhookSettings } from './types';
import { WEBHOOK_EVENTS } from './constants';
import { ServiceCard, Field, EventCheckboxes, inputCls } from './shared';

interface WebhookCardProps {
  webhook: WebhookSettings;
  onChange: (s: WebhookSettings) => void;
  onSave: () => void;
  saving: boolean;
}

const WebhookCard = ({ webhook, onChange, onSave, saving }: WebhookCardProps) => {
  const { t } = useTranslation();
  return (
  <ServiceCard
    icon={<Webhook size={20} />}
    title={t('integrations.webhook.title')}
    description={t('integrations.webhook.desc')}
    enabled={webhook.enabled}
    onToggle={v => onChange({ ...webhook, enabled: v })}
    onSave={onSave}
    saving={saving}
  >
    <Field label="Webhook URL">
      <input
        type="url"
        className={inputCls}
        placeholder="https://your-server.com/webhook"
        value={webhook.url}
        onChange={e => onChange({ ...webhook, url: e.target.value })}
      />
    </Field>
    <Field label={t('integrations.webhook.secretLabel')}>
      <input
        type="password"
        className={inputCls}
        placeholder="your-secret-key"
        value={webhook.secret}
        onChange={e => onChange({ ...webhook, secret: e.target.value })}
      />
    </Field>
    <Field label={t('integrations.webhook.eventsLabel')}>
      <EventCheckboxes
        options={WEBHOOK_EVENTS}
        values={webhook.events}
        onChange={v => onChange({ ...webhook, events: v })}
      />
    </Field>
  </ServiceCard>
  );
};

export default WebhookCard;
