import { Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '@/context/AuthContext';
import { useIntegrations } from './integrations/useIntegrations';
import SlackCard from './integrations/SlackCard';
import WebhookCard from './integrations/WebhookCard';
import EmailCard from './integrations/EmailCard';
import EmailNotifyCard from './integrations/EmailNotifyCard';
import WebhooksCard from './integrations/WebhooksCard';
import ApiTokensCard from './integrations/ApiTokensCard';
import GitLabCard from './integrations/GitLabCard';
import CalendarCard from './integrations/CalendarCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import NotificationPolicyView from './notifications/NotificationPolicyView';

// Email(SMTP) / GitLab / Calendar cards collect config that NOTHING consumes:
// no worker or frontend code reads integration_email / integration_gitlab /
// integration_calendar (2026-07 integrations audit). Hidden until a real
// implementation exists — a settings card that silently does nothing (while
// storing SMTP passwords / GitLab tokens in team_settings) erodes trust.
// Flip to true only after wiring actual consumers for these settings.
const SHOW_UNIMPLEMENTED_INTEGRATIONS = false;

const IntegrationsView = ({ embedded }: { embedded?: boolean }) => {
  const { t } = useTranslation();
  const { permissions } = useAuthContext();
  const {
    webhook, setWebhook,
    email, setEmail,
    gitlab, setGitlab,
    calendar, setCalendar,
    saving, loaded, loadError,
    save,
  } = useIntegrations();

  if (!permissions.canManageMembers) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('integrations.adminOnly')}</p>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle size={16} />
          <span>{t('error.loadFailed')}{loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto'}>
      <div className={embedded ? '' : 'px-4 py-6 md:px-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        {!embedded && (
          <div className="mb-5">
            <h2 className="text-xl md:text-2xl font-bold text-foreground">{t('integrations.title')}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{t('integrations.desc')}</p>
          </div>
        )}

        <Tabs defaultValue="integrations">
          <TabsList className="mb-4">
            <TabsTrigger value="integrations">{t('integrations.servicesTab')}</TabsTrigger>
            <TabsTrigger value="notification-policy">{t('integrations.policiesTab')}</TabsTrigger>
          </TabsList>

          <TabsContent value="integrations" className="space-y-3">
            <SlackCard />
            <EmailNotifyCard />
            <WebhooksCard />
            <ApiTokensCard />
            <WebhookCard
              webhook={webhook}
              onChange={setWebhook}
              onSave={() => save('integration_webhook', webhook)}
              saving={!!saving['integration_webhook']}
            />
            {SHOW_UNIMPLEMENTED_INTEGRATIONS && (
              <>
                <EmailCard
                  email={email}
                  onChange={setEmail}
                  onSave={() => save('integration_email', email)}
                  saving={!!saving['integration_email']}
                />
                <GitLabCard
                  gitlab={gitlab}
                  onChange={setGitlab}
                  onSave={() => save('integration_gitlab', gitlab)}
                  saving={!!saving['integration_gitlab']}
                />
                <CalendarCard
                  calendar={calendar}
                  onChange={setCalendar}
                  onSave={() => save('integration_calendar', calendar)}
                  saving={!!saving['integration_calendar']}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="notification-policy">
            <NotificationPolicyView />
          </TabsContent>
        </Tabs>
      </div>
      </div>
    </div>
  );
};

export default IntegrationsView;