import { useEffect, useState } from 'react';
import { X, Send, CheckCircle2, XCircle, Loader2, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReportSendTargets } from '@/hooks/useReportSendTargets';
import { useReportSender } from '@/hooks/useReportSender';
import type { ReportSendTarget, ReportSendFormat } from '@/lib/reportSendQueries';
import AddTargetDialog from './AddTargetDialog';

function ChannelBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    slack: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    email: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    line: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    webhook: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors[type] ?? 'bg-muted text-muted-foreground'}`}>
      {type.toUpperCase()}
    </span>
  );
}

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

interface ReportSendPanelProps {
  reportType: 'daily' | 'weekly' | 'monthly';
  content: string;
  currentUserId: string;
  projectId?: string;
  onClose: () => void;
}

const ReportSendPanel = ({ reportType, content, currentUserId, projectId, onClose }: ReportSendPanelProps) => {
  const { t } = useTranslation();
  const FORMAT_LABELS: Record<ReportSendFormat, string> = { text: t('reportSend.formatText'), full: t('reportSend.formatFull'), pdf: 'PDF' };
  const { fetchTargets } = useReportSendTargets();
  const { states, sending, summary, sendReport, retryFailed, reset } = useReportSender(currentUserId);
  const [selectedTargets, setSelectedTargets] = useState<ReportSendTarget[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [hasSent, setHasSent] = useState(false);

  useEffect(() => {
    void fetchTargets(reportType, projectId).then(fetched => {
      const forType = fetched.filter(t => t.report_type === reportType && t.is_enabled);
      const globals = forType.filter(t => t.project_id === null);
      if (!projectId) {
        setSelectedTargets(globals);
        return;
      }
      const projectTargets = forType.filter(t => t.project_id === projectId);
      const overriddenTypes = new Set(projectTargets.map(t => t.channel_type));
      setSelectedTargets([
        ...globals.filter(t => !overriddenTypes.has(t.channel_type)),
        ...projectTargets,
      ]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemove = (id: string) => {
    setSelectedTargets(prev => prev.filter(t => t.id !== id));
  };

  const hasNonSlackTargets = selectedTargets.some(t => t.channel_type !== 'slack');

  const handleSend = async () => {
    if (selectedTargets.length === 0) return;
    setHasSent(true);
    await sendReport(content, reportType, selectedTargets);
  };

  const handleRetry = async () => {
    await retryFailed(content, reportType);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const done = hasSent && summary.pending === 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="report-send-panel-title" className="bg-card border border-border rounded-xl w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 id="report-send-panel-title" className="font-semibold text-foreground text-sm flex items-center gap-2">
            <Send size={14} className="text-primary" />
            {t('reportSend.title')}
          </h3>
          <button onClick={handleClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Target list */}
          {!hasSent ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('reportSend.selectTargets')}</p>
              {selectedTargets.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">{t('reportSend.noTargets')}</p>
              ) : (
                selectedTargets.map(target => (
                  <div key={target.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background">
                    <ChannelBadge type={target.channel_type} />
                    <span className="flex-1 text-sm text-foreground truncate">{channelLabel(target)}</span>
                    {target.channel_type !== 'slack' && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 shrink-0">{t('reportSend.comingSoon')}</span>
                    )}
                    <span className="text-[11px] text-muted-foreground shrink-0">{FORMAT_LABELS[target.format]}</span>
                    <button
                      onClick={() => handleRemove(target.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors p-0.5 shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <Plus size={12} /> {t('reportSend.addTarget')}
              </button>
            </div>
          ) : (
            /* Sending status */
            <div className="space-y-2">
              {states.map(s => (
                <div key={s.target.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background">
                  {s.status === 'sent' && <CheckCircle2 size={16} className="text-green-500 shrink-0" />}
                  {s.status === 'failed' && <XCircle size={16} className="text-destructive shrink-0" />}
                  {(s.status === 'pending' || s.status === 'sending') && (
                    <Loader2 size={16} className="text-primary animate-spin shrink-0" />
                  )}
                  <ChannelBadge type={s.target.channel_type} />
                  <span className="flex-1 text-sm text-foreground truncate">{channelLabel(s.target)}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {s.status === 'sent' ? t('reportSend.statusSent') : s.status === 'failed' ? t('reportSend.statusFailed') : t('reportSend.statusSending')}
                  </span>
                </div>
              ))}

              {/* Error details */}
              {states.filter(s => s.status === 'failed').map(s => s.error && (
                <p key={s.target.id} className="text-xs text-destructive px-1">
                  {channelLabel(s.target)}：{s.error}
                </p>
              ))}

              {/* Summary */}
              {done && (
                <div className="pt-2 border-t border-border text-sm text-muted-foreground">
                  {summary.failed === 0
                    ? <span className="text-green-600 font-medium">{t('reportSend.allSuccess', { count: summary.total })}</span>
                    : <span>{t('reportSend.partialResult', { sent: summary.sent, failed: summary.failed })}</span>
                  }
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          {done && summary.failed > 0 && (
            <button
              onClick={() => void handleRetry()}
              disabled={sending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm border border-border rounded-lg text-foreground hover:bg-accent transition-colors"
            >
              <RefreshCw size={13} /> {t('reportSend.retryFailed')}
            </button>
          )}
          {!hasSent ? (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm border border-border rounded-lg text-foreground hover:bg-accent transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void handleSend()}
                disabled={selectedTargets.length === 0 || sending || hasNonSlackTargets}
                title={hasNonSlackTargets ? t('reportSend.nonSlackWarning') : undefined}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Send size={13} />
                {t('reportSend.sendToChannels', { count: selectedTargets.length })}
              </button>
            </>
          ) : (
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {done ? t('common.close') : t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      {showAdd && (
        <AddTargetDialog
          reportType={reportType}
          projectId={projectId ?? null}
          currentUserId={currentUserId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void fetchTargets(reportType, projectId).then(fetched => {
              const forType = fetched.filter(t => t.report_type === reportType && t.is_enabled);
              const globals = forType.filter(t => t.project_id === null);
              const projectTargets = projectId ? forType.filter(t => t.project_id === projectId) : [];
              setSelectedTargets([...projectTargets, ...globals]);
            });
          }}
        />
      )}
    </div>
  );
};

export default ReportSendPanel;