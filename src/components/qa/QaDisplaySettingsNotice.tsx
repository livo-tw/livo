import { useTranslation } from 'react-i18next';
import { qaButton } from './QaFields';
export default function QaDisplaySettingsNotice({ configuration, error, retry }: {
  configuration: unknown; error: unknown; retry: () => void;
}) {
  const { t } = useTranslation();
  if (configuration) return null;
  return error !== null ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
    <span>{t('qa.displaySettings.loadFailed')}</span><button type="button" className={qaButton} onClick={retry}>{t('qa.retry')}</button>
  </div> : <p role="status" className="text-sm text-muted-foreground">{t('qa.displaySettings.loading')}</p>;
}
