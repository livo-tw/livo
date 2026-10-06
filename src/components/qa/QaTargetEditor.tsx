import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, SlidersHorizontal, X } from 'lucide-react';
import type { QaTarget } from '@/lib/qa/domain';
import type { QaVersionsState } from '@/hooks/useQaVersions';
import QaEnvironmentField from './QaEnvironmentField';
import QaVersionInput from './QaVersionInput';
import { QaField, qaButton } from './QaFields';

export type QaTargetDraft = Pick<QaTarget, 'environment' | 'component' | 'build' | 'required'>;

export default function QaTargetEditor({ targets, onChange, versions, disabled = false }: {
  targets: QaTargetDraft[];
  onChange: (targets: QaTargetDraft[]) => void;
  versions: QaVersionsState;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const update = (index: number, patch: Partial<QaTargetDraft>) => {
    if (!disabled) onChange(targets.map((target, at) => at === index ? { ...target, ...patch } : target));
  };
  return <div className="min-w-0 space-y-3">
    {targets.map((target, index) => {
      const onlyRequired = target.required && targets.filter(item => item.required).length === 1;
      const hintId = `${id}-${index}-required`;
      return <fieldset key={index} disabled={disabled} className="min-w-0 space-y-3 rounded-lg border border-border/80 p-3">
        {targets.length > 1 && <legend className="px-1 text-xs font-medium text-muted-foreground">{t('qa.targetNumber', { number: index + 1 })}</legend>}
        <QaEnvironmentField label={t('qa.environment')} required disabled={disabled} value={target.environment} onChange={environment => update(index, { environment })} />
        <QaVersionInput label={t('qa.build')} hint={t('qa.fixVersionHint')} disabled={disabled} value={target.build} suggestions={versions} onChange={build => update(index, { build })} />
        <details className="min-w-0 rounded-md bg-muted/30 px-2.5 py-2">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><SlidersHorizontal size={13} aria-hidden="true" />{t('qa.targetMoreOptions')}</summary>
          <div className="mt-3 space-y-3">
            <QaField label={t('qa.fixComponent')} hint={t('qa.fixComponentHint')} maxLength={120} value={target.component} onChange={event => update(index, { component: event.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={target.required} disabled={disabled || onlyRequired}
              aria-describedby={onlyRequired ? hintId : undefined} onChange={event => update(index, { required: event.target.checked })} />{t('qa.required')}</label>
            {onlyRequired && <p id={hintId} className="text-xs text-muted-foreground">{t('qa.oneRequiredTarget')}</p>}
          </div>
        </details>
        {targets.length > 1 && <button type="button" className={qaButton} disabled={disabled || onlyRequired} title={onlyRequired ? t('qa.oneRequiredTarget') : undefined}
          onClick={() => { if (!disabled && !onlyRequired) onChange(targets.filter((_, at) => at !== index)); }}><X size={13} aria-hidden="true" />{t('qa.remove')}</button>}
      </fieldset>;
    })}
    <button type="button" className={qaButton} disabled={disabled || targets.length >= 30}
      onClick={() => { if (!disabled && targets.length < 30) onChange([...targets, { environment: '', component: '', build: '', required: true }]); }}>
      <Plus size={14} aria-hidden="true" />{t('qa.addEnvironment')}
    </button>
  </div>;
}
