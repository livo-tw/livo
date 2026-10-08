import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { StandupGroup } from '@/hooks/useStandupGrouping';
import type { User } from '@/types';
import { queueGroupId, queueMemberId, type QueueDragData } from './standupQueueDnd';
const ACTION_CLASS = 'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30';

function MoveButtons({ name, first, last, compact, onMove }: {
  name: string;
  first: boolean;
  last: boolean;
  compact: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const color = compact ? 'text-sidebar-foreground hover:bg-sidebar-hover' : 'text-muted-foreground hover:bg-accent';
  return (
    <div className="flex shrink-0">
      <button type="button" disabled={first} aria-label={t('standup.queue.moveUp', { name })} title={t('standup.queue.moveUp', { name })}
        className={`${ACTION_CLASS} ${color}`} onClick={() => onMove(-1)}><ArrowUp size={14} aria-hidden="true" /></button>
      <button type="button" disabled={last} aria-label={t('standup.queue.moveDown', { name })} title={t('standup.queue.moveDown', { name })}
        className={`${ACTION_CLASS} ${color}`} onClick={() => onMove(1)}><ArrowDown size={14} aria-hidden="true" /></button>
    </div>
  );
}

export function QueueMemberRow({ member, groupKey, index, first, last, compact, topLevel = false, active = false, onMove, onExclude, onSelect }: {
  member: User;
  groupKey: string;
  index: number;
  first: boolean;
  last: boolean;
  compact: boolean;
  topLevel?: boolean;
  active?: boolean;
  onMove: (direction: -1 | 1) => void;
  onExclude: () => void;
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const data: QueueDragData = { kind: 'member', groupKey, memberId: member.id, name: member.name };
  const sortable = useSortable({ id: queueMemberId(groupKey, member.id), data });
  const name = (
    <>
      <span className="block truncate font-medium">{index + 1}. {member.name}</span>
      {member.jobTitle && <span className={`block truncate text-[10px] ${compact ? 'text-sidebar-foreground/60' : 'text-muted-foreground'}`}>{member.jobTitle}</span>}
    </>
  );
  const textColor = compact ? 'text-sidebar-primary-foreground' : 'text-foreground';
  const surface = compact
    ? active ? 'bg-sidebar-active' : 'bg-sidebar-accent/30'
    : active ? 'bg-primary/10' : 'bg-accent/30';
  return (
    <div ref={sortable.setNodeRef} role={topLevel ? 'listitem' : undefined}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={`min-w-0 rounded-md ${!compact ? 'sm:flex sm:items-center' : ''} ${surface} ${sortable.isDragging ? 'opacity-30' : ''}`}>
      <div className={`flex min-w-0 items-center gap-1 pr-2 ${!compact ? 'sm:flex-1' : ''}`}>
        <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners}
          data-standup-report-id={member.id}
          aria-label={t('standup.queue.dragMember', { name: member.name })} title={t('standup.queue.dragMember', { name: member.name })}
          className={`${ACTION_CLASS} touch-none cursor-grab active:cursor-grabbing ${compact ? 'text-sidebar-foreground/60 hover:bg-sidebar-hover' : 'text-muted-foreground hover:bg-accent'}`}>
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" aria-hidden="true" style={{ backgroundColor: member.color }}>
          {member.avatar}
        </span>
        {onSelect ? (
          <button type="button" aria-label={member.name} aria-current={active ? 'step' : undefined} onClick={onSelect}
            className={`min-h-11 min-w-0 flex-1 rounded px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${textColor}`}>
            {name}
          </button>
        ) : <div className={`min-w-0 flex-1 px-1 py-1 text-xs ${textColor}`}>{name}</div>}
      </div>
      <div className={`flex flex-wrap items-center justify-between gap-x-1 border-t px-1 ${compact ? 'border-sidebar-border/40' : 'border-border/40 sm:shrink-0 sm:flex-nowrap sm:border-t-0'}`}>
        <MoveButtons name={member.name} first={first} last={last} compact={compact} onMove={onMove} />
        <button type="button" aria-label={t('standup.queue.excludeNamed', { name: member.name })} onClick={onExclude}
          className={`min-h-11 rounded px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${compact ? 'text-sidebar-foreground/80 hover:bg-sidebar-hover' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
          {t('standup.queue.exclude')}
        </button>
      </div>
    </div>
  );
}

export function QueueGroupRow({ group, index, first, last, compact, onMove, children }: {
  group: StandupGroup;
  index: number;
  first: boolean;
  last: boolean;
  compact: boolean;
  onMove: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const data: QueueDragData = { kind: 'group', groupKey: group.group_key, name: group.group_title };
  const sortable = useSortable({ id: queueGroupId(group.group_key), data });
  return (
    <div ref={sortable.setNodeRef} role="listitem" style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className={`min-w-0 rounded-md border ${compact ? 'border-sidebar-border' : 'border-border'} ${sortable.isDragging ? 'opacity-30' : ''}`}>
      <div className={`flex min-w-0 flex-wrap items-center rounded-t-md ${compact ? 'bg-sidebar-accent/50 text-sidebar-primary-foreground' : 'bg-accent/60 text-foreground'}`}>
        <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners}
          aria-label={t('standup.queue.dragGroup', { name: group.group_title })} title={t('standup.queue.dragGroup', { name: group.group_title })}
          className={`${ACTION_CLASS} touch-none cursor-grab active:cursor-grabbing ${compact ? 'hover:bg-sidebar-hover' : 'hover:bg-accent'}`}>
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 py-2 pr-2 text-xs">
          <p className="break-words font-medium">{index + 1}. {group.group_title}</p>
          <p className={`mt-0.5 text-[10px] ${compact ? 'text-sidebar-foreground/60' : 'text-muted-foreground'}`}>
            {group.members.length} {t('standup.settings.memberCountUnit')}
          </p>
        </div>
        <MoveButtons name={group.group_title} first={first} last={last} compact={compact} onMove={onMove} />
      </div>
      <div className="space-y-1 p-1">{children}</div>
    </div>
  );
}
