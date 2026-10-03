import { SearchableSelect } from '@/components/ui/searchable-select';
import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReportSendTargets } from '@/hooks/useReportSendTargets';
import type { ChannelType, ReportSendFormat, ChannelConfig } from '@/lib/reportSendQueries';

interface AddTargetDialogProps {
  reportType: 'daily' | 'weekly' | 'monthly';
  projectId: string | null;
  currentUserId: string;
  onClose: () => void;
  onCreated: () => void;
}

const AddTargetDialog = ({ reportType, projectId, currentUserId, onClose, onCreated }: AddTargetDialogProps) => {
  const { t } = useTranslation();

  const FORMAT_OPTIONS: { value: ReportSendFormat; label: string }[] = [
    { value: 'text', label: t('reportSend.formatText') },
    { value: 'full', label: t('reportSend.formatFull') },
    { value: 'pdf', label: 'PDF' },
  ];

  const CHANNEL_OPTIONS: { value: ChannelType; label: string }[] = [
    { value: 'slack', label: 'Slack' },
    { value: 'email', label: 'Email' },
    { value: 'line', label: 'LINE Notify' },
    { value: 'webhook', label: 'Webhook' },
  ];

  const { createTarget } = useReportSendTargets();
  const [channelType, setChannelType] = useState<ChannelType>('slack');
  const [format, setFormat] = useState<ReportSendFormat>('text');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slack
  const [slackChannelId, setSlackChannelId] = useState('');
  const [slackChannelName, setSlackChannelName] = useState('');
  // Email
  const [emailRecipients, setEmailRecipients] = useState('');
  // LINE
  const [lineToken, setLineToken] = useState('');
  // Webhook
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMethod, setWebhookMethod] = useState('POST');

  function buildConfig(): ChannelConfig {
    switch (channelType) {
      case 'slack': return { channel_id: slackChannelId.trim(), channel_name: slackChannelName.trim() };
      case 'email': return { recipients: emailRecipients.split(',').map(s => s.trim()).filter(Boolean) };
      case 'line': return { notify_token: lineToken.trim() };
      case 'webhook': return { url: webhookUrl.trim(), method: webhookMethod };
    }
  }

  function validate(): string | null {
    if (channelType === 'slack' && !slackChannelId.trim()) return t('reportSend.validation.slackChannelId');
    if (channelType === 'email' && !emailRecipients.trim()) return t('reportSend.validation.emailRecipients');
    if (channelType === 'line' && !lineToken.trim()) return t('reportSend.validation.lineToken');
    if (channelType === 'webhook' && !webhookUrl.trim()) return t('reportSend.validation.webhookUrl');
    return null;
  }

  const handleSave = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);
    try {
      await createTarget({
        project_id: projectId,
        report_type: reportType,
        channel_type: channelType,
        channel_config: buildConfig(),
        format,
        created_by: currentUserId,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reportSend.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-semibold text-foreground text-sm">{t('reportSend.addTargetTitle')}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Channel type */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">{t('reportSend.platform')}</label>
            <div className="flex gap-2 flex-wrap">
              {CHANNEL_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setChannelType(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    channelType === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Channel-specific config */}
          {channelType === 'slack' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Channel ID</label>
                <input
                  value={slackChannelId}
                  onChange={e => setSlackChannelId(e.target.value)}
                  placeholder="C1234567890"
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('reportSend.slackChannelName')}</label>
                <input
                  value={slackChannelName}
                  onChange={e => setSlackChannelName(e.target.value)}
                  placeholder="general"
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          )}

          {channelType === 'email' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">{t('reportSend.emailRecipientsLabel')}</label>
              <input
                value={emailRecipients}
                onChange={e => setEmailRecipients(e.target.value)}
                placeholder="a@example.com, b@example.com"
                className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {channelType === 'line' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">LINE Notify Token</label>
              <input
                value={lineToken}
                onChange={e => setLineToken(e.target.value)}
                placeholder="your-line-notify-token"
                type="password"
                className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {channelType === 'webhook' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Webhook URL</label>
                <input
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.example.com/..."
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Method</label>
                <SearchableSelect
                  value={webhookMethod}
                  onChange={e => setWebhookMethod(e.target.value)}
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:ring-1 focus:ring-primary"
                >
                  <option>POST</option>
                  <option>PUT</option>
                </SearchableSelect>
              </div>
            </div>
          )}

          {/* Format */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">{t('reportSend.format')}</label>
            <div className="flex gap-2">
              {FORMAT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setFormat(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    format === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded-lg text-foreground hover:bg-accent transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddTargetDialog;
