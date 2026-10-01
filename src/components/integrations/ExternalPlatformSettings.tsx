import { useUIContext } from '@/context/UIContext';
import { isEventEnabled } from '@/lib/featureToggles';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Slack, Users, MessageCircle, Link, Unlink, Clock, CheckCircle2, AlertCircle, ShieldAlert, Construction } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useExternalBindings } from '@/hooks/useExternalBindings';
import type { Platform, ExternalAccountBinding, ExternalActionLog } from '@/lib/integrationQueries';

const PLATFORM_ICON: Record<Platform, React.ComponentType<{ size?: number; className?: string }>> = {
  slack: Slack,
  teams: Users,
  line: MessageCircle,
};

const ACTION_TYPE_I18N: Record<string, string> = {
  approval_approve: 'integrations.external.actions.approve',
  approval_reject: 'integrations.external.actions.reject',
  approval_return: 'integrations.external.actions.return',
  status_change: 'integrations.external.actions.statusChange',
  comment_add: 'integrations.external.actions.commentAdd',
  task_view: 'integrations.external.actions.taskView',
  task_assign: 'integrations.external.actions.taskAssign',
  slash_command: 'integrations.external.actions.slashCommand',
};

const STATUS_BADGE_VARIANT: Record<string, { i18nKey: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  success: { i18nKey: 'integrations.external.statuses.success', variant: 'default' },
  failed: { i18nKey: 'integrations.external.statuses.failed', variant: 'destructive' },
  denied: { i18nKey: 'integrations.external.statuses.denied', variant: 'destructive' },
  expired: { i18nKey: 'integrations.external.statuses.expired', variant: 'outline' },
};

interface BindRowProps {
  platform: Platform;
  binding: ExternalAccountBinding | undefined;
  onUnbind: (id: string) => Promise<void>;
  onBind: (platform: Platform) => void;
}

function BindRow({ platform, binding, onUnbind, onBind }: BindRowProps) {
  const { t } = useTranslation();
  const label = t(`integrations.external.${platform}`);
  const Icon = PLATFORM_ICON[platform];

  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-muted border border-border">
          <Icon size={18} className="text-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          {binding ? (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              {binding.is_verified
                ? <CheckCircle2 size={11} className="text-green-500" />
                : <AlertCircle size={11} className="text-yellow-500" />
              }
              {binding.display_name ?? binding.platform_user_id}
              {binding.last_active_at && (
                <span className="ml-1 text-muted-foreground/60">
                  · {t('integrations.external.lastActive')} {new Date(binding.last_active_at).toLocaleDateString('zh-TW')}
                </span>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground mt-0.5">{t('integrations.external.notBound')}</div>
          )}
        </div>
      </div>
      {binding ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive"
          onClick={() => onUnbind(binding.id)}
          disabled
          title={t('integration.comingSoon')}
          aria-label={t('integration.unbindLabel', { platform: label })}
        >
          <Unlink size={12} className="mr-1" />
          {t('integrations.external.unbind')}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onBind(platform)}
          disabled
          title={t('integration.comingSoon')}
          aria-label={t('integration.bindLabel', { platform: label })}
        >
          <Link size={12} className="mr-1" />
          {t('integrations.external.bindAccount')}
        </Button>
      )}
    </div>
  );
}

function ActionLogItem({ log }: { log: ExternalActionLog }) {
  const { t } = useTranslation();
  const statusEntry = STATUS_BADGE_VARIANT[log.result_status] ?? STATUS_BADGE_VARIANT.failed;
  const statusLabel = t(statusEntry.i18nKey);
  const variant = statusEntry.variant;
  const platformLabel = t(`integrations.external.${log.platform}`);
  const actionI18nKey = ACTION_TYPE_I18N[log.action_type];
  const actionLabel = actionI18nKey ? t(actionI18nKey) : log.action_type;

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 flex-shrink-0">
        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
          <Clock size={12} className="text-muted-foreground" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{actionLabel}</span>
          <Badge variant={variant} className="text-xs h-4 px-1.5">{statusLabel}</Badge>
          <span className="text-xs text-muted-foreground">{platformLabel}</span>
        </div>
        {log.error_message && (
          <div className="text-xs text-destructive mt-0.5 truncate">{log.error_message}</div>
        )}
        <div className="text-xs text-muted-foreground mt-0.5">
          {new Date(log.acted_at).toLocaleString('zh-TW')}
        </div>
      </div>
    </div>
  );
}

const ExternalPlatformSettings = () => {
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  const {
    bindings, actionLogs: allActionLogs, loading,
    fetchBindings, fetchActionLogs,
    unbindAccount, getBindingForPlatform,
  } = useExternalBindings();

  const actionLogs = allActionLogs.filter(log => isEventEnabled(log.action_type, approvalsEnabled));
  const [activeTab, setActiveTab] = useState<'bindings' | 'logs'>('bindings');

  useEffect(() => {
    void fetchBindings();
    void fetchActionLogs(20);
  }, [fetchBindings, fetchActionLogs]);

  const handleUnbind = async (id: string) => {
    await unbindAccount(id);
  };

  const BIND_INSTRUCTIONS: Record<Platform, string> = {
    slack: t('integrations.external.slackBindInstruction'),
    teams: t('integrations.external.teamsBindInstruction'),
    line: t('integrations.external.lineBindInstruction'),
  };

  const handleBind = (platform: Platform) => {
    toast.info(BIND_INSTRUCTIONS[platform], { duration: 6000 });
  };

  const platforms: Platform[] = ['slack', 'teams', 'line'];

  return (
    <div className="space-y-5">
      {/* Coming Soon banner */}
      <div className="flex items-center gap-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-4 py-3">
        <Construction size={18} className="text-yellow-600 dark:text-yellow-400 shrink-0" />
        <div>
          <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">{t('integrations.external.comingSoonBanner')}</p>
          <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-0.5">{t('integrations.external.comingSoonDesc')}</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 border-b border-border">
        {(['bindings', 'logs'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            aria-label={tab === 'bindings' ? t('integrations.external.connectedTab') : t('integrations.external.logsTab')}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
              activeTab === tab
                ? 'text-primary border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'bindings' ? t('integrations.external.connectedTab') : t('integrations.external.logsTab')}
          </button>
        ))}
      </div>

      {activeTab === 'bindings' && (
        <div className="space-y-4">
          {loading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{t('common.loading')}</div>
          ) : (
            <div className="divide-y divide-border border border-border rounded-lg bg-muted/20 overflow-hidden">
              {platforms.map(p => (
                <BindRow
                  key={p}
                  platform={p}
                  binding={getBindingForPlatform(p)}
                  onUnbind={handleUnbind}
                  onBind={handleBind}
                />
              ))}
            </div>
          )}
          <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 space-y-1.5">
            <p className="text-sm font-semibold text-foreground">{t('integrations.external.howToBind')}</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside leading-relaxed">
              <li>{t('integrations.external.slackInstruction')}</li>
              <li>{t('integrations.external.teamsInstruction')} <code className="bg-muted rounded px-1 py-0.5">@LIVO bind</code> {t('integrations.external.toBot')}</li>
              <li>{t('integrations.external.lineInstruction')} <code className="bg-muted rounded px-1 py-0.5">/bind</code></li>
            </ul>
            <p className="text-xs text-muted-foreground pt-0.5">{t(approvalsEnabled ? 'integrations.external.bindSyncDesc' : 'featureToggles.externalDescription')}</p>
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-4 py-3">
            <ShieldAlert size={14} className="text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-xs text-yellow-700 dark:text-yellow-300">
              {t('integrations.external.unbindComingSoon')}
            </p>
          </div>
        </div>
      )}

      {activeTab === 'logs' && (
        <div>
          {loading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{t('common.loading')}</div>
          ) : actionLogs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg bg-muted/10">{t('integrations.external.noLogs')}</div>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
              {actionLogs.map(log => (
                <ActionLogItem key={log.id} log={log} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ExternalPlatformSettings;
