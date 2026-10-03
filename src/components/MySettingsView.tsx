import { SearchableSelect } from '@/components/ui/searchable-select';
import { Palette, Bell, FileText, Globe, Info, KeyRound, Mail, UserCircle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import ThemeSelector from '@/components/ThemeSelector';
import MyAvatarSettings from '@/components/MyAvatarSettings';
import ChangePasswordForm from '@/components/ChangePasswordForm';
import SlackNotifyPreferences from '@/components/SlackNotifyPreferences';
import EmailNotifyPreferences from '@/components/EmailNotifyPreferences';
import AutoReportSettings from '@/components/AutoReportSettings';
import UpgradePrompt from '@/components/UpgradePrompt';
import { useLicense } from '@/context/LicenseContext';

const MySettingsView = () => {
  const { t, i18n } = useTranslation();
  const { hasFeature } = useLicense();

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-6 md:px-6">
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('settings.mySettings')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('settings.mySettingsDesc')}</p>
        </div>

        {/* Avatar badge — every member edits their own */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <UserCircle size={16} className="text-primary" />
            {t('settings.avatarLabel')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
            <p className="text-sm text-muted-foreground mb-4">{t('settings.avatarDesc')}</p>
            <MyAvatarSettings />
          </div>
        </section>

        {/* Theme — always available */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <Palette size={16} className="text-primary" />
            {t('settings.themeLabel')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
            <p className="text-sm text-muted-foreground mb-4">{t('settings.themeDesc')}</p>
            <ThemeSelector />
          </div>
        </section>

        {/* Language */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <Globe size={16} className="text-primary" />
            {t('settings.languageLabel')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
            <p className="text-sm text-muted-foreground mb-4">{t('settings.languageDesc')}</p>
            <SearchableSelect
              value={i18n.language}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="zh-TW">{t('settings.langZhTW')}</option>
              <option value="zh-CN">{t('settings.langZhCN')}</option>
              <option value="en">{t('settings.langEn')}</option>
            </SearchableSelect>
          </div>
        </section>

        {/* Password */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <KeyRound size={16} className="text-primary" />
            {t('settings.passwordLabel')}
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
            <p className="text-sm text-muted-foreground mb-4">{t('settings.passwordDesc')}</p>
            <ChangePasswordForm />
          </div>
        </section>

        {/* Slack Digest — professional */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <Bell size={16} className="text-primary" />
            {t('settings.slackNotifyLabel')}
            <Tooltip><TooltipTrigger asChild><Info size={14} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="right"><p className="text-xs max-w-[240px]">{t('settings.slackNotifyTooltip')}</p></TooltipContent></Tooltip>
          </div>
          {hasFeature('slack-notify') ? (
            <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
              <p className="text-sm text-muted-foreground mb-4">{t('settings.slackNotifyDesc')}</p>
              <SlackNotifyPreferences />
            </div>
          ) : (
            <UpgradePrompt feature="slack-notify" inline />
          )}
        </section>

        {/* Email notifications — available on all tiers */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <Mail size={16} className="text-primary" />
            {t('settings.emailNotifyLabel')}
            <Tooltip><TooltipTrigger asChild><Info size={14} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="right"><p className="text-xs max-w-[240px]">{t('settings.emailNotifyTooltip')}</p></TooltipContent></Tooltip>
          </div>
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
            <p className="text-sm text-muted-foreground mb-4">{t('settings.emailNotifyDesc')}</p>
            <EmailNotifyPreferences />
          </div>
        </section>

        {/* Auto Reports — professional */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground border-b border-border pb-2">
            <FileText size={16} className="text-primary" />
            {t('settings.autoReportLabel')}
            <Tooltip><TooltipTrigger asChild><Info size={14} className="text-muted-foreground/50 cursor-help" /></TooltipTrigger><TooltipContent side="right"><p className="text-xs max-w-[240px]">{t('settings.autoReportTooltip')}</p></TooltipContent></Tooltip>
          </div>
          {hasFeature('auto-reports') ? (
            <div className="bg-card rounded-lg border border-border shadow-sm p-4 md:p-5">
              <p className="text-sm text-muted-foreground mb-4">{t('settings.autoReportDesc')}</p>
              <AutoReportSettings />
            </div>
          ) : (
            <UpgradePrompt feature="auto-reports" inline />
          )}
        </section>
      </div>
      </div>
    </div>
  );
};

export default MySettingsView;
