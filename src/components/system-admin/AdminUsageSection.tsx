import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Database, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { logActivity } from '@/lib/activityLog';
import { getWorkspaceStorageLimitBytes } from '@/lib/workspaceQuota';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';

interface AdminUsageSectionProps {
  currentMemberId: string;
}

const DB_LIMIT = 500 * 1024 * 1024;
const DEFAULT_STORAGE_LIMIT = 1 * 1024 * 1024 * 1024;

const AdminUsageSection = ({ currentMemberId }: AdminUsageSectionProps) => {
  const { t } = useTranslation();
  const [dbUsed, setDbUsed] = useState<number | null>(null);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  // Cloud-beta workspaces report a real quota (500MB) via check_license.
  const [STORAGE_LIMIT, setStorageLimit] = useState(DEFAULT_STORAGE_LIMIT);
  useEffect(() => {
    getWorkspaceStorageLimitBytes().then((v) => { if (v) setStorageLimit(v); });
  }, []);
  const [logRetentionDays, setLogRetentionDays] = useState(90);
  const [cleaningLogs, setCleaningLogs] = useState(false);
  const [logCounts, setLogCounts] = useState<{ activity: number | null; status: number | null; notifications: number | null }>({ activity: null, status: null, notifications: null });
  const { confirm, ConfirmDialog } = useConfirmDialog();

  useEffect(() => {
    loadUsageStats();
    loadLogCounts();
  }, []);

  const loadLogCounts = async () => {
    const [{ count: actCount }, { count: statusCount }, { count: notifCount }] = await Promise.all([
      supabase.from('activity_logs').select('*', { count: 'exact', head: true }),
      supabase.from('status_logs').select('*', { count: 'exact', head: true }),
      supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('is_read', true),
    ]);
    setLogCounts({ activity: actCount ?? 0, status: statusCount ?? 0, notifications: notifCount ?? 0 });
  };

  const loadUsageStats = async () => {
    const { data: attData } = await supabase.from('task_attachments').select('file_size');
    const { data: bkData } = await supabase.from('backup_history').select('file_size');
    const attTotal = (attData || []).reduce((s, r) => s + (Number(r.file_size) || 0), 0);
    const bkTotal = (bkData || []).reduce((s, r) => s + (Number(r.file_size) || 0), 0);
    setStorageUsed(attTotal + bkTotal);

    const tables = ['tasks', 'members', 'projects', 'statuses', 'sprints', 'product_lines', 'comments', 'task_specs', 'task_checks', 'task_todos', 'status_logs', 'task_deployments', 'member_manuals', 'notifications', 'backup_settings', 'backup_history', 'activity_logs', 'profiles', 'user_column_configs', 'task_attachments'] as const;
    let totalSize = 0;
    for (const table of tables) {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      totalSize += (count || 0) * 500;
    }
    setDbUsed(totalSize);
  };

  const handleCleanupLogs = async () => {
    if (!(await confirm({ description: `確定要刪除 ${logRetentionDays} 天前的所有 Log 嗎？此操作無法復原。`, title: '確認操作', destructive: true }))) return;
    try {
      setCleaningLogs(true);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - logRetentionDays);
      const cutoff = cutoffDate.toISOString();

      const [actRes, statusRes, notifRes] = await Promise.all([
        supabase.from('activity_logs').delete().lt('created_at', cutoff),
        supabase.from('status_logs').delete().lt('changed_at', cutoff),
        supabase.from('notifications').delete().eq('is_read', true).lt('created_at', cutoff),
      ]);

      const errors = [actRes.error, statusRes.error, notifRes.error].filter(Boolean);
      if (errors.length > 0) {
        toast.error(t('error.operationFailed') + ': ' + errors.map(e => e!.message).join(', '));
      } else {
        toast.success(t('adminUsage.cleanupTitle') + ' ' + t('common.completed') + '!');
        if (currentMemberId) {
          await logActivity(currentMemberId, 'cleanup_logs', `清理 ${logRetentionDays} 天前的 Log（操作歷程、狀態紀錄、已讀通知）`, undefined, undefined, 'system');
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
                <span className="text-muted-foreground">{t('adminUsage.dbLabel')}</span>
                <span className="font-medium text-foreground">
                  {dbUsed !== null
                    ? dbUsed < 1024 * 1024 ? `${(dbUsed / 1024).toFixed(0)} KB` : `${(dbUsed / 1024 / 1024).toFixed(1)} MB`
                    : t('common.loading')}
                </span>
              </div>
              {dbUsed !== null && (
                <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${(dbUsed / DB_LIMIT) > 0.8 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.max(Math.min((dbUsed / DB_LIMIT) * 100, 100), 1)}%` }}
                  />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('adminUsage.storageLabel')}</span>
                <span className="font-medium text-foreground">
                  {storageUsed !== null
                    ? storageUsed < 1024 * 1024 ? `${(storageUsed / 1024).toFixed(0)} KB` : `${(storageUsed / 1024 / 1024).toFixed(1)} MB`
                    : t('common.loading')}
                </span>
              </div>
              {storageUsed !== null && (
                <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${(storageUsed / STORAGE_LIMIT) > 0.8 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.max(Math.min((storageUsed / STORAGE_LIMIT) * 100, 100), 1)}%` }}
                  />
                </div>
              )}
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => { loadUsageStats(); loadLogCounts(); }}>
              <RefreshCw size={14} /> {t('adminUsage.refreshButton')}
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
              <span>{t('adminUsage.activityLogs')}<span className="font-medium text-foreground">{logCounts.activity ?? '...'}</span> {t('common.records')}</span>
              <span>{t('adminUsage.statusLogs')}<span className="font-medium text-foreground">{logCounts.status ?? '...'}</span> {t('common.records')}</span>
              <span>{t('adminUsage.readNotifications')}<span className="font-medium text-foreground">{logCounts.notifications ?? '...'}</span> {t('common.records')}</span>
            </div>
            <div className="flex items-center gap-3">
              <Select value={String(logRetentionDays)} onValueChange={(v) => setLogRetentionDays(parseInt(v))}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('adminUsage.retention.1day')}</SelectItem>
                  <SelectItem value="7">{t('adminUsage.retention.7days')}</SelectItem>
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
