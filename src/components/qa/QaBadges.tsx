import { useQaDisplayConfiguration } from '@/context/QaDisplaySettingsContext';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { priorityConfig, StatusBadge } from '@/components/ui/badges';
import type { Priority } from '@/types';
import type { QaIssue, QaSeverity, QaState } from '@/lib/qa/domain';

// Use the same priority order, icons and colours as ordinary LIVO task cards.
export const qaPriorities: Priority[] = ['highest', 'high', 'medium', 'low', 'lowest'];
export const qaStateColors: Record<string, string> = {
  new: '#6B778C', triaged: '#6554C0', in_progress: '#0065FF',
  verification: '#B86E00', verified: '#15803D', failed: '#DE350B',
  closed: '#00875A', dismissed: '#6B778C',
};
/**
 * A new bug keeps the default priority (3, medium) until someone sets it. It is
 * shown as that value marked "default", so it matches the priority filter and
 * sort, which use the stored value.
 */
function qaPriorityIsDefault(issue?: QaIssue): boolean {
  return (issue?.state === 'new' && !issue.assigneeId && !issue.qaOwnerId)
    || (issue as unknown as { legacySource?: { priorityMeaning?: string } })?.legacySource?.priorityMeaning === 'LIVO default 3; source has severity only';
}
export function QaPriorityBadge({ priority, issue }: { priority: number; issue?: QaIssue }) {
  const { t } = useTranslation();
  const name = qaPriorities[priority - 1] || 'medium';
  const config = priorityConfig[name];
  const isDefault = qaPriorityIsDefault(issue);
  return <span className={`inline-flex items-center gap-1 rounded border border-border/70 bg-background px-1.5 py-0.5 text-xs ${isDefault ? 'text-muted-foreground' : ''}`} title={isDefault ? t('qa.priorityDefaultHint') : t('qa.priority')}>
    {config.icon}<span>{isDefault ? t('qa.priorityDefault', { name: t(`priority.${name}`) }) : t(`priority.${name}`)}</span>
  </span>;
}
export function QaSeverityBadge({ severity }: { severity: QaSeverity }) {
  const { t } = useTranslation();
  const configuration = useQaDisplayConfiguration();
  if (!configuration?.showSeverity) return null;
  // Reuse the task card's icon treatment; severity remains its own domain field.
  const visual = severity === 'untriaged' ? null : priorityConfig[severity];
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t('qa.severity')}>
    <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${visual ? `${visual.className} ${visual.bg}` : 'bg-muted text-muted-foreground'}`}>
      {visual ? visual.icon : <AlertCircle size={13} />}
    </span>{t('qa.severity')}: {t(`qa.severityNames.${severity}`)}
  </span>;
}
export function QaStateBadge({ state, label }: { state: QaState; label?: string }) {
  const { t } = useTranslation();
  return <StatusBadge name={label || t(`qa.state.${state}`)} color={qaStateColors[state] || '#6B778C'} />;
}
