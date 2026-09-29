import { useTranslation } from 'react-i18next';

interface StandupGroupHeaderProps {
  groupTitle: string;
  groupIndex: number;
  totalGroups: number;
  taskCount: number;
}

export function StandupGroupHeader({ groupTitle, groupIndex, totalGroups, taskCount }: StandupGroupHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-1.5 bg-sidebar-accent/50 border-b border-sidebar-border flex-shrink-0">
      <p className="text-[10px] text-sidebar-foreground/50">
        {t('standup.groupHeader', { current: groupIndex + 1, total: totalGroups })}
      </p>
      <p className="text-xs font-medium text-sidebar-primary-foreground truncate">
        {groupTitle}
      </p>
      <p className="text-[10px] text-sidebar-foreground/50">
        {taskCount} {t('standup.taskCount')}
      </p>
    </div>
  );
}
