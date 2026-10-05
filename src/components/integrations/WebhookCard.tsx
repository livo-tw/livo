import { Loader2, Webhook } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WebhookSettings } from './types';

interface WebhookCardProps {
  webhook: WebhookSettings;
  onClear: () => void;
  saving: boolean;
}

/**
 * The old single webhook was sent from each member's browser and kept its
 * signing secret in settings every member can read. It no longer sends; the
 * server Webhooks card above replaces it. This card appears only while an old
 * setting is still stored, so an admin can recreate it there and clear it here.
 */
const WebhookCard = ({ webhook, onClear, saving }: WebhookCardProps) => {
  const { t } = useTranslation();
  return (
    <div role="note" className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 sm:flex-row sm:items-start">
      <Webhook size={20} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{t('integrations.webhook.legacyTitle')}</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{t('integrations.webhook.legacyDesc', { url: webhook.url || '—' })}</p>
      </div>
      <button type="button" onClick={onClear} disabled={saving}
        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50">
        {saving && <Loader2 size={14} className="animate-spin" />}{t('integrations.webhook.legacyClear')}
      </button>
    </div>
  );
};

export default WebhookCard;
