import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, FileText, AlertTriangle, Trash2, Download, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { fnUrl } from '@/lib/apiBase';
import { logActivity } from '@/lib/activityLog';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import UpgradePrompt from '@/components/UpgradePrompt';
import type { FeatureName } from '@/lib/license';

interface BackupSettings {
  id: string;
  enabled: boolean;
  interval_days: number;
  backup_hour: number;
  notify_email: string;
  notify_channel: string;
  last_backup_at: string | null;
  task_notify_channel: string;
  task_notify_types: string[];
  dm_notify_enabled: boolean;
  dm_notify_start_hour: number;
  dm_notify_end_hour: number;
  updated_at: string;
}

interface BackupRecord {
  id: string;
  filename: string;
  file_size: number;
  storage_path: string;
  created_at: string;
}

export type { BackupSettings };

interface AdminBackupSectionProps {
  currentMemberId: string;
  hasFeature: (feature: FeatureName) => boolean;
  backupSettings: BackupSettings | null;
  setBackupSettings: React.Dispatch<React.SetStateAction<BackupSettings | null>>;
  saveBackupSettings: (updates: Partial<BackupSettings>) => Promise<void>;
}

const AdminBackupSection = ({
  currentMemberId, hasFeature, backupSettings, setBackupSettings, saveBackupSettings,
}: AdminBackupSectionProps) => {
  const { t } = useTranslation();
  const [backupHistory, setBackupHistory] = useState<BackupRecord[]>([]);
  const [manualBackingUp, setManualBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const jsonRestoreRef = useRef<HTMLInputElement>(null);
  const { confirm, ConfirmDialog } = useConfirmDialog();

  useEffect(() => { loadBackupHistory(); }, []);

  const loadBackupHistory = async () => {
    const { data } = await supabase.from('backup_history').select('*').order('created_at', { ascending: false }).limit(20);
    if (data) setBackupHistory(data);
  };

  const handleManualBackup = async () => {
    try {
      setManualBackingUp(true);
      const url = fnUrl('scheduled-backup');
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ manual: true }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        toast.error(t('adminBackup.errorPrefix') + (data.error || '未知錯誤'));
      } else {
        toast.success(t('adminBackup.successPrefix') + data.totalRecords + t('adminBackup.recordsSuffix'));
        if (currentMemberId) {
          await logActivity(currentMemberId, 'manual_backup', `手動備份完成，共 ${data.totalRecords} 筆資料`, undefined, undefined, 'system');
        }
        await loadBackupHistory();
      }
    } catch (err: unknown) {
      toast.error(t('adminBackup.errorPrefix') + (err instanceof Error ? err.message : String(err)));
    } finally {
      setManualBackingUp(false);
    }
  };

  const handleDownloadBackup = async (record: BackupRecord) => {
    const { data, error } = await supabase.storage.from('backups').download(record.storage_path);
    if (error || !data) { toast.error(t('adminBackup.downloadFailed')); return; }
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = record.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteBackup = async (record: BackupRecord) => {
    if (!(await confirm({ description: t('adminBackup.confirmDelete', { name: record.filename }), title: t('adminBackup.confirmTitle'), destructive: true }))) return;
    await supabase.storage.from('backups').remove([record.storage_path]);
    await supabase.from('backup_history').delete().eq('id', record.id);
    toast.success(t('adminBackup.deletedSuccess'));
    loadBackupHistory();
  };

  const handleRestoreClick = () => jsonRestoreRef.current?.click();

  const handleRestoreSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!(await confirm({ description: t('adminBackup.confirmRestore'), title: t('adminBackup.confirmTitle'), destructive: true }))) {
      if (jsonRestoreRef.current) jsonRestoreRef.current.value = '';
      return;
    }

    try {
      setRestoring(true);
      const jsonText = await file.text();
      const backup = JSON.parse(jsonText) as Record<string, Record<string, unknown>[]>;

      const requiredTables = ['tasks', 'members', 'projects', 'statuses', 'sprints', 'product_lines'];
      const missingTables = requiredTables.filter(t => !backup[t]);
      if (missingTables.length > 0) {
        toast.error(t('adminBackup.missingTables') + ' ' + missingTables.join(', '));
        return;
      }

      const hasQa = Object.entries(backup).some(([table, rows]) => table.startsWith('qa_') && (!Array.isArray(rows) || rows.length > 0));
      const restoreQa = async (validateOnly: boolean) => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('請重新登入後還原 QA 資料');
        const response = await fetch(fnUrl('qa'), { method: 'POST', headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`,
        }, body: JSON.stringify({ action: 'restore', tables: backup, validateOnly }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || result.error?.code || 'QA 還原失敗');
        if (result.conflicts?.length || result.missingAssets?.length) throw new Error(
          `QA 備份有 ${result.conflicts?.length || 0} 筆衝突、${result.missingAssets?.length || 0} 個附件缺失，請先排除再還原。`);
        return result;
      };
      // Validate QA references/version conflicts before the existing restore
      // starts changing any ordinary table. QA itself is merged atomically.
      if (hasQa) await restoreQa(true);

      const deleteOrder = [
        'comments', 'task_checks', 'task_todos', 'task_specs',
        'task_deployments', 'status_logs', 'notifications',
        'tasks', 'member_manuals', 'sprints',
      ];
      for (const table of deleteOrder) {
        if (table === 'sprints') {
          await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
        } else {
          await supabase.from(table as 'comments').delete().neq('id', '___none___');
        }
      }

      const insertOrder = [
        'product_lines', 'members', 'member_manuals', 'statuses', 'projects', 'sprints',
        'tasks', 'comments', 'task_specs', 'task_checks', 'task_todos',
        'task_deployments', 'status_logs', 'notifications',
      ];

      let totalInserted = 0;
      for (const table of insertOrder) {
        const rows = backup[table];
        if (!rows || rows.length === 0) continue;
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error } = await supabase.from(table as 'tasks').upsert(batch as Record<string, unknown>[]);
          if (error) {
            throw new Error(`Restore ${table} failed: ${error.message}`);
          }
        }
        totalInserted += rows.length;
      }

      if (hasQa) {
        const qaResult = await restoreQa(false);
        totalInserted += qaResult.inserted || 0;
        toast.info('QA 記錄已還原；JSON 僅含附件資訊，媒體檔案需保留或另行還原儲存空間。');
      }

      toast.success(t('adminBackup.restoreSuccess') + totalInserted + t('adminBackup.recordsSuffix'));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'restore_backup', `從 JSON 備份還原，共 ${totalInserted} 筆資料`, undefined, undefined, 'system');
      }
    } catch (err: unknown) {
      toast.error(t('adminBackup.restoreError') + ' ' + (err instanceof Error ? err.message : String(err)));
      console.error('Restore error:', err);
    } finally {
      setRestoring(false);
      if (jsonRestoreRef.current) jsonRestoreRef.current.value = '';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <>
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2 border-b border-border pb-2">
        <Clock size={18} className="text-primary" />
        {t('adminBackup.sectionTitle')}
      </h2>
      {/* Manual backup/restore is allowed for ANY paid license (data-export, standard+).
          Only the SCHEDULED auto-backup settings stay professional-only (json-backup). */}
      {!hasFeature('data-export') ? (
        <UpgradePrompt feature="data-export" inline />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock size={20} className="text-primary" />
              {t('adminBackup.scheduledTitle')}
            </CardTitle>
            <CardDescription>{t('adminBackup.scheduledDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!hasFeature('json-backup') && (
              <UpgradePrompt feature="json-backup" inline />
            )}
            {hasFeature('json-backup') && backupSettings && (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{t('adminBackup.enableLabel')}</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('adminBackup.enableDesc')}</p>
                  </div>
                  <Switch checked={backupSettings.enabled} onCheckedChange={(checked) => saveBackupSettings({ enabled: checked })} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm">{t('adminBackup.frequencyLabel')}</Label>
                    <Select value={String(backupSettings.interval_days)} onValueChange={(v) => saveBackupSettings({ interval_days: parseInt(v) })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">{t('adminBackup.daily')}</SelectItem>
                        <SelectItem value="3">{t('adminBackup.every3Days')}</SelectItem>
                        <SelectItem value="7">{t('adminBackup.every7Days')}</SelectItem>
                        <SelectItem value="14">{t('adminBackup.every14Days')}</SelectItem>
                        <SelectItem value="30">{t('adminBackup.every30Days')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">{t('adminBackup.backupTimeLabel')}</Label>
                    <Select value={String(backupSettings.backup_hour)} onValueChange={(v) => saveBackupSettings({ backup_hour: parseInt(v) })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>{String(i).padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">{t('adminBackup.notifyChannelLabel')}</Label>
                  <Input
                    placeholder={t('adminBackup.notifyChannelPlaceholder')}
                    value={backupSettings.notify_channel}
                    onChange={(e) => setBackupSettings({ ...backupSettings, notify_channel: e.target.value })}
                    onBlur={() => saveBackupSettings({ notify_channel: backupSettings.notify_channel })}
                  />
                </div>
                {backupSettings.last_backup_at && (
                  <p className="text-xs text-muted-foreground">{t('adminBackup.lastBackup')}{formatDate(backupSettings.last_backup_at)}</p>
                )}
              </>
            )}
            {/* Manual backup: available to any paid license (data-export), independent of the pro-only scheduled settings. */}
            <Button onClick={handleManualBackup} disabled={manualBackingUp} variant="outline" className="gap-2">
              <RefreshCw size={16} className={manualBackingUp ? 'animate-spin' : ''} />
              {manualBackingUp ? t('adminBackup.backingUp') : t('adminBackup.manualBackup')}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {backupHistory.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FileText size={20} className="text-primary" />
                  {t('adminBackup.historyTitle')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-[240px] overflow-y-auto">
                  {backupHistory.map((record) => (
                    <div key={record.id} className="flex items-center justify-between p-2.5 rounded-md bg-muted/50 hover:bg-muted transition-colors">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText size={14} className="text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{record.filename}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(record.created_at)} · {formatFileSize(record.file_size)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDownloadBackup(record)} title={t('adminBackup.download')}><Download size={14} /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => handleDeleteBackup(record)} title={t('adminBackup.deleteTooltip')}><Trash2 size={14} /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <RotateCcw size={20} className="text-primary" />
                {t('adminBackup.restoreTitle')}
              </CardTitle>
              <CardDescription>{t('adminBackup.restoreDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <input ref={jsonRestoreRef} type="file" accept=".json" onChange={handleRestoreSelect} className="hidden" />
              <Button onClick={handleRestoreClick} disabled={restoring} variant="outline" className="gap-2">
                <RotateCcw size={16} className={restoring ? 'animate-spin' : ''} />
                {restoring ? t('adminBackup.restoring') : t('adminBackup.restoreButton')}
              </Button>
              <p className="text-xs text-destructive flex items-center gap-1.5">
                <AlertTriangle size={12} className="flex-shrink-0" />
                {t('adminBackup.restoreWarning')}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      )}
    </div>
    {ConfirmDialog}
    </>
  );
};

export default AdminBackupSection;
