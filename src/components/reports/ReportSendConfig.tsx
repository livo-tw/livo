import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '@/context/AuthContext';
import { Plus, Trash2, ToggleLeft, ToggleRight, Globe, FolderOpen, Slack, Mail, MessageCircle, Webhook } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useReportSendTargets } from '@/hooks/useReportSendTargets';
import type { ReportSendTarget, ChannelType, ReportSendFormat, ChannelConfig } from '@/lib/reportSendQueries';
import AddTargetDialog from './AddTargetDialog';

const CHANNEL_ICONS: Record<ChannelType, React.ComponentType<{ size?: number; className?: string }>> = {
  slack: Slack,
  email: Mail,
  line: MessageCircle,
  webhook: Webhook,
};

function channelLabel(target: ReportSendTarget): string {
  const cfg = target.channel_config as Record<string, unknown>;
  switch (target.channel_type) {
    case 'slack': return `#${String(cfg.channel_name ?? cfg.channel_id ?? '')}`;
    case 'email': return Array.isArray(cfg.recipients) ? (cfg.recipients as string[]).join(', ') : '';
    case 'line': return 'LINE Notify';
    case 'webhook': return String(cfg.url ?? '');
    default: return target.channel_type;
  }
}

interface ReportSendConfigProps {
  projectId?: string;
}

const ReportSendConfig = ({ projectId }: ReportSendConfigProps) => {
  const { t } = useTranslation();
  const TAB_LABELS: Record<string, string> = { daily: t('reportSend.tabs.daily'), weekly: t('reportSend.tabs.weekly'), monthly: t('reportSend.tabs.monthly') };
  const FORMAT_LABELS: Record<ReportSendFormat, string> = { text: t('reportSend.formatText'), full: t('reportSend.formatFull'), pdf: t('reportSend.formatPdf') };
  const { currentMemberId } = useAuthContext();
  const { targets, loading, fetchTargets, deleteTarget, toggleTarget } = useReportSendTargets();
  const [showAdd, setShowAdd] = useState(false);
  const [addReportType, setAddReportType] = useState<'daily' | 'weekly' | 'monthly'>('daily');

  useEffect(() => {
    void fetchTargets(undefined, projectId);
  }, [fetchTargets, projectId]);

  const targetsForTab = (type: string) =>
    targets.filter(t => t.report_type === type && (projectId ? t.project_id === projectId || t.project_id === null : t.project_id === null));

  return (
    <div className="space-y-4">
      <Tabs defaultValue="daily">
        <TabsList className="h-8">
          {Object.entries(TAB_LABELS).map(([type, label]) => (
            <TabsTrigger key={type} value={type} className="text-xs h-7">{label}</TabsTrigger>
          ))}
        </TabsList>

        {(Object.keys(TAB_LABELS) as Array<'daily' | 'weekly' | 'monthly'>).map(type => (
          <TabsContent key={type} value={type} className="mt-3 space-y-2">
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('reportSend.loading')}</p>
            ) : targetsForTab(type).length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('reportSend.empty')}</p>
            ) : (
              targetsForTab(type).map(target => {
                const Icon = CHANNEL_ICONS[target.channel_type];
                return (
                  <div key={target.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-card">
                    <Icon size={16} className="text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate block">{channelLabel(target)}</span>
                      <span className="text-[11px] text-muted-foreground">{FORMAT_LABELS[target.format]}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {target.project_id === null ? (
                        <span title={t('reportSend.global')} className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Globe size={10} /> {t('reportSend.global')}
                        </span>
                      ) : (
                        <span title={t('reportSend.projectScope')} className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <FolderOpen size={10} /> {t('reportSend.projectScope')}
                        </span>
                      )}
                      <button
                        onClick={() => void toggleTarget(target.id, !target.is_enabled)}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title={target.is_enabled ? t('reportSend.disableToggle') : t('reportSend.enableToggle')}
                      >
                        {target.is_enabled
                          ? <ToggleRight size={18} className="text-primary" />
                          : <ToggleLeft size={18} />}
                      </button>
                      <button
                        onClick={() => void deleteTarget(target.id)}
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}

            <button
              onClick={() => { setAddReportType(type); setShowAdd(true); }}
              className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
            >
              <Plus size={13} /> {t('reportSend.addTarget')}
            </button>
          </TabsContent>
        ))}
      </Tabs>

      {showAdd && (
        <AddTargetDialog
          reportType={addReportType}
          projectId={projectId ?? null}
          currentUserId={currentMemberId}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void fetchTargets(undefined, projectId); }}
        />
      )}
    </div>
  );
};

export default ReportSendConfig;
