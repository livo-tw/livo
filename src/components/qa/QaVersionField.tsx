import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaVersionsState } from '@/hooks/useQaVersions';
import { QaField, QaSelect } from './QaFields';

/** A text value remains editable regardless of suggestion availability. */
export function QaVersionField({ label, value, onChange, suggestions, required = false }: {
  label: string; value: string; onChange: (value: string) => void; suggestions: QaVersionsState; required?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  return <div className="space-y-2">
    <QaField label={label} hint={t(required ? 'qa.fixVersionHint' : 'qa.versionHint')} list={listId} autoComplete="off" maxLength={200}
      required={required} value={value} onChange={event => onChange(event.target.value)} />
    <datalist id={listId}>{suggestions.values.map(version => <option key={version} value={version} />)}</datalist>
    {!!suggestions.values.length && <QaSelect label={t('qa.versionChoose')} value="" onChange={event => { if (event.target.value) onChange(event.target.value); }}>
      <option value="">{t('qa.choose')}</option>{suggestions.values.map(version => <option key={version} value={version}>{version}</option>)}
    </QaSelect>}
    <p role="status" className="text-xs text-muted-foreground">{suggestions.status === 'loading' ? t('qa.versionLoading') : suggestions.status === 'failed' ? t('qa.versionLoadFailed') : !suggestions.values.length ? t('qa.versionEmpty') : ''}</p>
  </div>;
}
