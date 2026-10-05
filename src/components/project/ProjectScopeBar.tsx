import { Filter, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectScope } from '@/hooks/useProjectScope';

/** Shows which sidebar project or product line the current view is limited to. */
export default function ProjectScopeBar() {
  const { t } = useTranslation();
  const scope = useProjectScope();
  if (!scope.active) return null;
  return <div role="status" className="flex shrink-0 items-center gap-2 border-b border-primary/15 bg-primary/5 px-4 py-1.5 text-xs text-foreground md:px-5">
    <Filter size={13} className="shrink-0 text-primary" aria-hidden="true" />
    <span className="min-w-0 truncate">{t(scope.kind === 'line' ? 'projectScope.line' : 'projectScope.project', { name: scope.label })}</span>
    <button type="button" onClick={scope.clear} className="ml-1 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10">
      <X size={12} aria-hidden="true" />{t('projectScope.clear')}
    </button>
  </div>;
}
