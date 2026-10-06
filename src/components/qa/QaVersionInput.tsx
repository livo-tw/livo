import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaVersionsState } from '@/hooks/useQaVersions';
import { QaField } from './QaFields';

export interface QaVersionInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: QaVersionsState;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** One editable native combobox: suggestions never replace or restrict text. */
export default function QaVersionInput({ label, value, onChange, suggestions, required = false, disabled, hint }: QaVersionInputProps) {
  const { t } = useTranslation();
  const listId = useId();
  const message = suggestions.status === 'loading' ? t('qa.versionLoading')
    : suggestions.status === 'failed' ? t('qa.versionLoadFailed') : '';
  return <div className="min-w-0 space-y-1">
    <QaField label={label} list={listId} autoComplete="off" maxLength={200} required={required} disabled={disabled}
      hint={hint ?? t(required ? 'qa.fixVersionHint' : 'qa.versionHint')} aria-describedby={message ? `${listId}-status` : undefined}
      value={value} onChange={event => onChange(event.target.value)} />
    <datalist id={listId}>{suggestions.values.map(version => <option key={version} value={version} />)}</datalist>
    {message && <p id={`${listId}-status`} role="status" className="text-xs text-muted-foreground">{message}</p>}
  </div>;
}
