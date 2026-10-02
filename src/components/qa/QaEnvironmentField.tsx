import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { deploymentEnvironmentOptions } from '@/lib/deploymentEnvironments';
import { qaInput } from './QaFields';

export default function QaEnvironmentField({ label, value, onChange, required, disabled, id: suppliedId, hint, className }: {
  label: string; value: string; onChange: (value: string) => void;
  required?: boolean; disabled?: boolean; id?: string; hint?: string; className?: string;
}) {
  const generatedId = useId(), id = suppliedId || generatedId;
  const { t } = useTranslation();
  const { values, ready, loadError } = useDeploymentEnvironments();
  const description = loadError ? t('deploymentEnvironments.loadFailed') : hint;
  return <div className={`block min-w-0 space-y-1 text-sm ${className || ''}`}>
    <label htmlFor={id} className="font-medium">{label}{required ? ' *' : ''}</label>
    <select id={id} className={qaInput} value={value} required={required} disabled={disabled || !ready}
      aria-describedby={description ? `${id}-hint` : undefined}
      onChange={event => { if (!event.target.value || values.includes(event.target.value)) onChange(event.target.value); }}>
      <option value="">{t('qa.choose')}</option>
      {deploymentEnvironmentOptions(values, [value]).map(option => <option key={option.value} value={option.value} disabled={option.legacy}>
        {option.value}{option.legacy ? ` (${t('qa.legacyValue')})` : ''}
      </option>)}
    </select>
    {description && <span id={`${id}-hint`} className="block text-xs text-muted-foreground">{description}</span>}
  </div>;
}
