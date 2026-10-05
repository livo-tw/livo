import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskContext } from '@/context/TaskContext';
import { useSprintContext } from '@/context/SprintContext';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useAuthContext } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import AdminLicenseSection from '@/components/system-admin/AdminLicenseSection';
import AdminFeatureToggles from '@/components/system-admin/AdminFeatureToggles';
import AdminUsageSection from '@/components/system-admin/AdminUsageSection';
import AdminBackupSection from '@/components/system-admin/AdminBackupSection';
import AdminNotifySection from '@/components/system-admin/AdminNotifySection';
import AdminImportExportSection from '@/components/system-admin/AdminImportExportSection';
import IntegrationsView from '@/components/IntegrationsView';
import { Wrench, Link2 } from 'lucide-react';
import type { BackupSettings } from '@/components/system-admin/AdminBackupSection';

type AdminTab = 'admin' | 'integrations';

const TAB_STYLE_BASE = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all';
const TAB_ACTIVE = `${TAB_STYLE_BASE} bg-background text-foreground shadow-sm`;
const TAB_INACTIVE = `${TAB_STYLE_BASE} text-muted-foreground hover:text-foreground hover:bg-background/50`;

const SystemAdminView = () => {
  const { t } = useTranslation();
  const { refreshTasks, refreshComments, refreshTaskSpecs, refreshStatusLogs, refreshStatuses, refreshTaskChecks, refreshTaskTodos } = useTaskContext();
  const { refreshSprints } = useSprintContext();
  const { refreshUsers } = useMemberContext();
  const { refreshProductLines } = useProjectContext();
  const { currentMemberId, permissions } = useAuthContext();
  const { hasFeature } = useLicense();

  const [activeTab, setActiveTab] = useState<AdminTab>('admin');
  const [backupSettings, setBackupSettings] = useState<BackupSettings | null>(null);

  const loadBackupSettings = useCallback(async () => {
    const { data } = await supabase.from('backup_settings').select('*').limit(1).maybeSingle();
    if (data) setBackupSettings(data);
  }, []);

  // Reload whenever the admin tab opens: the Slack card on the integrations tab
  // edits the same row, so a copy kept from earlier would show an old channel.
  useEffect(() => {
    if (activeTab === 'admin') void loadBackupSettings();
  }, [activeTab, loadBackupSettings]);

  const saveBackupSettings = useCallback(async (updates: Partial<BackupSettings>) => {
    if (!backupSettings) return;
    setBackupSettings(previous => previous ? { ...previous, ...updates } : previous);
    // Only the fields this control changed: writing the whole row back would
    // overwrite what another screen saved in the meantime.
    const { error } = await supabase.from('backup_settings').update(updates).eq('id', backupSettings.id);
    if (error) {
      toast.error(t('integrations.saveFailed') + error.message);
      await loadBackupSettings();
      return;
    }
    toast.success(t('integrations.saveSuccess'));
  }, [backupSettings, loadBackupSettings, t]);

  const refreshAll = useCallback(() => Promise.all([
    refreshTasks(), refreshSprints(), refreshComments(),
    refreshTaskSpecs(), refreshStatusLogs(), refreshUsers(),
    refreshProductLines(), refreshStatuses(),
    refreshTaskChecks(), refreshTaskTodos(),
  ]), [refreshTasks, refreshSprints, refreshComments, refreshTaskSpecs, refreshStatusLogs, refreshUsers, refreshProductLines, refreshStatuses, refreshTaskChecks, refreshTaskTodos]);

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-6 md:px-6">
        <div className="max-w-5xl mx-auto">
          {/* Page header */}
          <div className="mb-6">
            <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('systemAdmin.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('systemAdmin.desc')}</p>
          </div>

          {/* Tab bar */}
          <div className="inline-flex items-center rounded-lg bg-muted p-1 text-muted-foreground mb-6 gap-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('admin')}
              className={activeTab === 'admin' ? TAB_ACTIVE : TAB_INACTIVE}
            >
              <Wrench size={14} />
              {t('systemAdmin.tabs.admin')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('integrations')}
              className={activeTab === 'integrations' ? TAB_ACTIVE : TAB_INACTIVE}
            >
              <Link2 size={14} />
              {t('systemAdmin.tabs.integrations')}
            </button>
          </div>

          {/* Tab content */}
          {activeTab === 'admin' && (
            <div className="space-y-6">
              <AdminFeatureToggles />
              <AdminLicenseSection />

              <AdminUsageSection currentMemberId={currentMemberId} />

              <AdminBackupSection
                currentMemberId={currentMemberId}
                hasFeature={hasFeature}
                backupSettings={backupSettings}
                setBackupSettings={setBackupSettings}
                saveBackupSettings={saveBackupSettings}
              />

              <AdminNotifySection
                hasFeature={hasFeature}
                backupSettings={backupSettings}
                saveBackupSettings={saveBackupSettings}
              />

              <AdminImportExportSection
                currentMemberId={currentMemberId}
                hasFeature={hasFeature}
                refreshAll={refreshAll}
              />
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
              <IntegrationsView embedded />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemAdminView;
