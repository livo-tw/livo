import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Database, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { logActivity } from '@/lib/activityLog';
import { getWorkspaceStorageQuota } from '@/lib/workspaceQuota';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';

interface AdminUsageSectionProps {
  currentMemberId: string;
}

const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB`
  : bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;

/** Tables whose rows make up most of the database; counted, not sized. */
const RECORD_TABLES = ['tasks', 'comments', 'status_logs', 'activity_logs', 'notifications', 'task_attachments', 'task_specs', 'task_checks', 'task_todos', 'task_deployments', 'kb_pages', 'projects', 'members', 'sprints'] as const;
/** Uploaded files and backups a member can list; the cloud uses the server's own counter instead. */
const FILE_TABLES = ['task_attachments', 'kb_attachments', 'backup_history'] as const;
/** Sizes and counts need only a table name; some of these tables are outside the generated types. */
type UsageClient = { from: (table: string) => { select: (columns: string, options?: { count: 'exact'; head: true }) => PromiseLike<{ data: unknown[] | null; count: number | null; error?: unknown }> } };
const usageClient = supabase as unknown as UsageClient;

const AdminUsageSection = ({ currentMemberId }: AdminUsageSectionProps) => {
  const { t } = useTranslation();
  const [records, setRecords] = useState<number | null>(null);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  // Cloud-beta workspaces have a quota (500 MB) enforced by the server's counter.
  // Self-host and demo have none: no meter, and the total is what the app can list.
  const [storageLimit, setStorageLimit] = useState<number | null>(null);
  const [logRetentionDays, setLogRetentionDays] = useState(90);
  const [cleaningLogs, setCleaningLogs] = useState(false);
  const [logCounts, setLogCounts] = useState<{ activity: number | null; notifications: number | null }>({ activity: null, notifications: null });
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState(false);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState(false);
  const usageRequest = useRef(0);
  const logsRequest = useRef(0);
  const { confirm, ConfirmDialog } = useConfirmDialog();

  useEffect(() => {
    void loadUsageStats(false);
    void loadLogCounts();
    return () => { usageRequest.current += 1; logsRequest.current += 1; };
  }, []);

  const loadLogCounts = async () => {
    const request = ++logsRequest.current;
    setLogsLoading(true);
    setLogsError(false);
    try {
      const [activity, notifications] = await Promise.all([
        supabase.from('activity_logs').select('*', { count: 'exact', head: true }),
        supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('is_read', true),
      ]);
      if ([activity, notifications].some(({ error, count }) => error || typeof count !== 'number' || !Number.isFinite(count))) {
        throw new Error('log_count_unavailable');
      }
      if (request === logsRequest.current) {
        setLogCounts({ activity: activity.count, notifications: notifications.count });
      }
    } catch {
      if (request === logsRequest.current) setLogsError(true);
    } finally {
      if (request === logsRequest.current) setLogsLoading(false);
    }
  };

  const loadUsageStats = async (refresh = true) => {
    const request = ++usageRequest.current;
    setUsageLoading(true);
    setUsageError(false);
    try {
      const quota = await getWorkspaceStorageQuota({ refresh });
      let nextStorageUsed = quota?.usedBytes ?? null;
      if (nextStorageUsed === null) {
        const sizes = await Promise.all(FILE_TABLES.map(table => usageClient.from(table).select('file_size')));
        if (sizes.some(({ error, data }) => error || !Array.isArray(data))) throw new Error('file_sizes_unavailable');
        nextStorageUsed = sizes.reduce((sum, { data }) => sum + (data ?? []).reduce<number>((size, row) => size + (Number((row as { file_size?: unknown }).file_size) || 0), 0), 0);
      }
      const counts = await Promise.all(RECORD_TABLES.map(table => usageClient.from(table).select('*', { count: 'exact', head: true })));
      if (counts.some(({ error, count }) => error || typeof count !== 'number' || !Number.isFinite(count))) throw new Error('record_count_unavailable');
      if (request === usageRequest.current) {
        // Publish only a complete read; a failed refresh retains the last confirmed values.
        setStorageLimit(quota?.limitBytes ?? null);
        setStorageUsed(nextStorageUsed);
        setRecords(counts.reduce((sum, { count }) => sum + (count ?? 0), 0));
      }
    } catch {
      if (request === usageRequest.current) setUsageError(true);
    } finally {
      if (request === usageRequest.current) setUsageLoading(false);
    }
  };

  const handleCleanupLogs = async () => {
    if (!(await confirm({ description: t('adminUsage.cleanupConfirm', { days: logRetentionDays }), title: t('confirm.defaultTitle'), destructive: true }))) return;
    try {
      setCleaningLogs(true);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - logRetentionDays);
      const cutoff = cutoffDate.toISOString();

      // Status change records stay: the dashboard's cycle and transition times are computed from them.
      const [actRes, notifRes] = await Promise.all([
        supabase.from('activity_logs').delete().lt('created_at', cutoff),
        supabase.from('notifications').delete().eq('is_read', true).lt('created_at', cutoff),
      ]);

      const errors = [actRes.error, notifRes.error].filter(Boolean);
      if (errors.length > 0) {
        toast.error(t('error.operationFailed') + ': ' + errors.map(e => e!.message).join(', '));
      } else {
        toast.success(t('adminUsage.cleanupTitle') + ' ' + t('common.completed') + '!');
        if (currentMemberId) {
          await logActivity(currentMemberId, 'cleanup_logs', t('adminUsage.cleanupLogDetail', { days: logRetentionDays }), undefined, undefined, 'system');
        }
      }
      await Promise.all([loadLogCounts(), loadUsageStats()]);
    } catch (err: unknown) {
      toast.error(t('error.operationFailed') + ': ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCleaningLogs(false);
    }
  };

  return (
    <>
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2 border-b border-border pb-2">
        <HardDrive size={18} className="text-primary" />
        {t('adminUsage.sectionTitle')}
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database size={20} className="text-primary" />
              {t('adminUsage.capacityTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('adminUsage.recordsLabel')}</span>
                <span className="font-medium text-foreground">
                  {records !== null ? t('adminUsage.recordsValue', { value: records.toLocaleString() }) : t(usageLoading ? 'common.loading' : 'adminUsage.unknownValue')}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('adminUsage.storageLabel')}</span>
                <span className="font-medium text-foreground">
                  {storageUsed !== null ? formatSize(storageUsed) : t(usageLoading ? 'common.loading' : 'adminUsage.unknownValue')}
                  {storageLimit !== null && <span className="text-muted-foreground font-normal"> / {t('adminUsage.storageLimit', { size: formatSize(storageLimit) })}</span>}
                </span>
              </div>
              {storageUsed !== null && storageLimit !== null && (
                <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${(storageUsed / storageLimit) > 0.8 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.max(Math.min((storageUsed / storageLimit) * 100, 100), 1)}%` }}
                  />
                </div>
              )}
              {records !== null && storageUsed !== null && storageLimit === null && <p className="text-xs text-muted-foreground">{t('adminUsage.storageNoLimit')}</p>}
            </div>
            {usageError && <p role="alert" className="text-sm text-destructive">
              {t(records !== null ? 'adminUsage.usageRefreshFailed' : 'adminUsage.usageLoadFailed')}
            </p>}
            <Button variant="outline" size="sm" className="gap-2" disabled={usageLoading || logsLoading || cleaningLogs} onClick={() => { void loadUsageStats(); void loadLogCounts(); }}>
              <RefreshCw size={14} className={usageLoading || logsLoading ? 'animate-spin' : undefined} />
              {t(usageLoading || logsLoading ? 'adminUsage.refreshing' : usageError || logsError ? 'adminUsage.retryButton' : 'adminUsage.refreshButton')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Trash2 size={20} className="text-primary" />
              {t('adminUsage.cleanupTitle')}
            </CardTitle>
            <CardDescription>{t('adminUsage.cleanupDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>{t('adminUsage.activityLogs')}<span className="font-medium text-foreground">{logCounts.activity ?? t(logsLoading ? 'common.loading' : 'adminUsage.unknownValue')}</span> {t('common.records')}</span>
              <span>{t('adminUsage.readNotifications')}<span className="font-medium text-foreground">{logCounts.notifications ?? t(logsLoading ? 'common.loading' : 'adminUsage.unknownValue')}</span> {t('common.records')}</span>
            </div>
            {logsError && <p role="alert" className="text-sm text-destructive">
              {t(logCounts.activity !== null ? 'adminUsage.logsRefreshFailed' : 'adminUsage.logsLoadFailed')}
            </p>}
            <div className="flex items-center gap-3">
              <Select value={String(logRetentionDays)} onValueChange={(v) => setLogRetentionDays(parseInt(v))}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t('adminUsage.retention.30days')}</SelectItem>
                  <SelectItem value="60">{t('adminUsage.retention.60days')}</SelectItem>
                  <SelectItem value="90">{t('adminUsage.retention.90days')}</SelectItem>
                  <SelectItem value="180">{t('adminUsage.retention.180days')}</SelectItem>
                  <SelectItem value="365">{t('adminUsage.retention.365days')}</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={handleCleanupLogs} disabled={cleaningLogs} variant="destructive" size="sm" className="gap-2">
                <Trash2 size={14} className={cleaningLogs ? 'animate-spin' : ''} />
                {cleaningLogs ? t('adminUsage.cleaning') : t('adminUsage.cleanupButtonPrefix') + logRetentionDays + t('adminUsage.cleanupButtonSuffix')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle size={12} className="flex-shrink-0" />
              {t('adminUsage.cleanupWarning')}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
    {ConfirmDialog}
    </>
  );
};

export default AdminUsageSection;
