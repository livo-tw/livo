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
export function QaPriorityBadge({ priority, issue }: { priority: number; issue?: QaIssue }) {
  const { t } = useTranslation();
  if ((issue?.state === 'new' && !issue.assigneeId && !issue.qaOwnerId) || (issue as unknown as { legacySource?: { priorityMeaning?: string } })?.legacySource?.priorityMeaning === 'LIVO default 3; source has severity only') return <span className="text-xs text-muted-foreground">{t('qa.priorityUnassigned')}</span>;
  const name = qaPriorities[priority - 1] || 'medium';
  const config = priorityConfig[name];
  return <span className="inline-flex items-center gap-1 rounded border border-border/70 bg-background px-1.5 py-0.5 text-xs" title={t('qa.priority')}>
    {config.icon}<span>{t(`priority.${name}`)}</span>
  </span>;
}
export function QaSeverityBadge({ severity }: { severity: QaSeverity }) {
  const { t } = useTranslation();
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={t('qa.severity')}>
    <AlertCircle size={12} aria-hidden="true" />{t('qa.severity')}: {t(`qa.severityNames.${severity}`)}
  </span>;
}
export function QaStateBadge({ state, label }: { state: QaState; label?: string }) {
  const { t } = useTranslation();
  return <StatusBadge name={label || t(`qa.state.${state}`)} color={qaStateColors[state] || '#6B778C'} />;
}
