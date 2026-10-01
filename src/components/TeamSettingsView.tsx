import { useUIContext } from '@/context/UIContext';
import { MessageSquare, ClipboardCheck, Link2, SendHorizonal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import NotificationRuleManager from '@/components/notifications/NotificationRuleManager';
import TemplateManager from '@/components/notifications/TemplateManager';
import ApprovalRuleConfig from '@/components/approval/ApprovalRuleConfig';
import ExternalPlatformSettings from '@/components/integrations/ExternalPlatformSettings';
import ReportSendConfig from '@/components/reports/ReportSendConfig';

const TeamSettingsView = () => {
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-6 md:px-6">
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('teamSettings.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('teamSettings.desc')}</p>
        </div>

        {/* Notification Rules */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <MessageSquare size={16} className="text-primary" />
            {t('teamSettings.notificationRules')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
            <p className="text-xs text-muted-foreground mb-3">{t('teamSettings.notificationRulesDesc')}</p>
            <NotificationRuleManager />
          </div>
        </section>

        {/* Notification Templates */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <MessageSquare size={16} className="text-primary" />
            {t('teamSettings.messageTemplates')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
            <p className="text-xs text-muted-foreground mb-3">{t('teamSettings.messageTemplatesDesc')}</p>
            <TemplateManager />
          </div>
        </section>

        {/* Approval Rules */}
        {approvalsEnabled && <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <ClipboardCheck size={16} className="text-primary" />
            {t('teamSettings.approvalRules')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
            <p className="text-xs text-muted-foreground mb-3">{t('teamSettings.approvalRulesDesc')}</p>
            <ApprovalRuleConfig />
          </div>
        </section>}

        {/* External Platform */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <Link2 size={16} className="text-primary" />
            {t('teamSettings.externalPlatform')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
            <ExternalPlatformSettings />
          </div>
        </section>

        {/* Report Send Config */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <SendHorizonal size={16} className="text-primary" />
            {t('teamSettings.reportSend')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-6">
            <p className="text-xs text-muted-foreground mb-3">{t('teamSettings.reportSendDesc')}</p>
            <ReportSendConfig />
          </div>
        </section>
      </div>
      </div>
    </div>
  );
};

export default TeamSettingsView;
