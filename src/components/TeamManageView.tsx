import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Settings, MessageSquare, Link2, Layers, BookOpen } from 'lucide-react';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import KnowledgeImportPermissions from '@/components/KnowledgeImportPermissions';
import MemberManageView from '@/components/MemberManageView';
import DeploymentEnvironmentSettings from '@/components/DeploymentEnvironmentSettings';
import StatusManageView from '@/components/StatusManageView';
import TaskTemplateManager from '@/components/TaskTemplateManager';
import NotificationRuleManager from '@/components/notifications/NotificationRuleManager';
import TemplateManager from '@/components/notifications/TemplateManager';
import ReportSendConfig from '@/components/reports/ReportSendConfig';
import ProductLineManageModal from '@/components/ProductLineManageModal';

export type TeamManageTab = 'members' | 'task-config' | 'notifications' | 'knowledge';

interface Props {
  initialTab?: TeamManageTab;
}

const TAB_STYLE_BASE = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs md:text-sm font-medium transition-all';
const TAB_ACTIVE = `${TAB_STYLE_BASE} bg-background text-foreground shadow-sm`;
const TAB_INACTIVE = `${TAB_STYLE_BASE} text-muted-foreground hover:text-foreground hover:bg-background/50`;

const TeamManageView = ({ initialTab = 'members' }: Props) => {
  const { t } = useTranslation();
  const { permissions, currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const [activeTab, setActiveTab] = useState<TeamManageTab>(initialTab === 'approval' ? 'task-config' : initialTab as TeamManageTab);
  const [showLineManage, setShowLineManage] = useState(false);

  const tabs: Array<{ id: TeamManageTab; label: string; icon: React.ReactNode; show?: boolean }> = [
    { id: 'members', label: t('teamManage.tabs.members'), icon: <Users size={14} /> },
    { id: 'task-config', label: t('teamManage.tabs.taskConfig'), icon: <Settings size={14} />, show: permissions.canManageStatuses },
    { id: 'notifications', label: t('teamManage.tabs.notifications'), icon: <MessageSquare size={14} /> },
    { id: 'knowledge', label: t('kbImport.permissionTitle'), icon: <BookOpen size={14} />, show: currentMember?.role === 'super_admin' },
  ];

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-6 md:px-6">
        {/* Full width: the member table and settings use the whole content area. */}
        <div className="w-full min-w-0">
          {/* Page header */}
          <div className="mb-6">
            <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('teamManage.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('teamManage.desc')}</p>
          </div>

          {/* Tab bar */}
          <div className="inline-flex items-center rounded-lg bg-muted p-1 text-muted-foreground mb-6 flex-wrap gap-0.5">
            {tabs.filter(tab => tab.show !== false).map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={activeTab === tab.id ? TAB_ACTIVE : TAB_INACTIVE}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === 'knowledge' && currentMember?.role === 'super_admin' && <KnowledgeImportPermissions actor={currentMember} users={users} />}
          {activeTab === 'members' && (
            <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
              <MemberManageView embedded />
            </div>
          )}

          {activeTab === 'task-config' && permissions.canManageStatuses && (
            <div className="space-y-6">
              {/* Product Line Management */}
              {permissions.canEditProject && (
                <div className="flex items-center justify-between bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                  <div className="flex items-center gap-3">
                    <Layers size={16} className="text-primary" />
                    <div>
                      <h3 className="text-base font-semibold text-foreground">{t('sidebar.manageProductLines')}</h3>
                      <p className="text-sm text-muted-foreground">{t('teamManage.productLineDesc')}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowLineManage(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors flex-shrink-0"
                  >
                    {t('common.manage')}
                  </button>
                </div>
              )}

              {/* Status Management */}
              <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Settings size={16} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">{t('teamManage.statusManage')}</h3>
                </div>
                <StatusManageView embedded />
              </div>

              <DeploymentEnvironmentSettings />

              {/* Task Templates */}
              <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Settings size={16} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">{t('sidebar.taskTemplate')}</h3>
                </div>
                <TaskTemplateManager />
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-6">
              <div className="rounded-lg bg-blue-500/10 border border-blue-500/30 px-4 py-2.5 text-xs text-blue-700 dark:text-blue-400 flex items-start gap-2">
                <Link2 size={14} className="shrink-0 mt-0.5" />
                <span>{t('teamSettings.channelIntegrationNote')}</span>
              </div>
              <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MessageSquare size={16} className="text-primary" />
                    <h3 className="text-base font-semibold text-foreground">{t('teamSettings.notificationRules')}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{t('teamSettings.notificationRulesDesc')}</p>
                </div>
                <NotificationRuleManager />
              </div>
              <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MessageSquare size={16} className="text-primary" />
                    <h3 className="text-base font-semibold text-foreground">{t('teamSettings.messageTemplates')}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{t('teamSettings.messageTemplatesDesc')}</p>
                </div>
                <TemplateManager />
              </div>
              <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MessageSquare size={16} className="text-primary" />
                    <h3 className="text-base font-semibold text-foreground">{t('teamSettings.reportSend')}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{t('teamSettings.reportSendDesc')}</p>
                </div>
                <ReportSendConfig />
              </div>
            </div>
          )}

        </div>
      </div>
      <ProductLineManageModal open={showLineManage} onClose={() => setShowLineManage(false)} />
    </div>
  );
};

export default TeamManageView;
