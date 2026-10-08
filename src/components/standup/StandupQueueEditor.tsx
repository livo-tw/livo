import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  closestCenter, pointerWithin, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import type { StandupGroup } from '@/hooks/useStandupGrouping';
import type { SortMode } from '@/hooks/useStandupSettings';
import type { User } from '@/types';
import { QueueGroupRow, QueueMemberRow } from './StandupQueueRows';
import { dragData, queueGroupId, queueMemberId, type QueueDragData } from './standupQueueDnd';

const EXCLUDED_ZONE_ID = 'standup-excluded-zone';

export interface StandupQueueEditorProps {
  groups: StandupGroup[];
  sortMode: SortMode;
  onReorder: (groups: StandupGroup[]) => void;
  excludedMembers: User[];
  onExclude: (memberId: string) => void;
  onRestore: (memberId: string) => void;
  compact?: boolean;
  onSelect?: (groupKey: string, memberId: string) => void;
  label?: string;
}

function ExcludedZone({ members, compact, acceptingMember, onRestore }: {
  members: User[];
  compact: boolean;
  acceptingMember: boolean;
  onRestore: (memberId: string) => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: EXCLUDED_ZONE_ID, disabled: !acceptingMember });
  return (
    <section ref={setNodeRef} aria-label={t('standup.queue.excluded', { count: members.length })}
      className={`min-h-24 min-w-0 rounded-lg border-2 border-dashed p-2 transition-colors ${isOver
        ? 'border-primary bg-primary/15 ring-2 ring-primary/20'
        : compact ? 'border-sidebar-border bg-sidebar-accent/20' : 'border-border bg-muted/20'}`}>
      <p className={`text-xs font-medium ${compact ? 'text-sidebar-primary-foreground' : 'text-foreground'}`}>
        {t('standup.queue.excluded', { count: members.length })}
      </p>
      <p className={`mt-1 text-[11px] ${compact ? 'text-sidebar-foreground/60' : 'text-muted-foreground'}`}>{t('standup.queue.dropHint')}</p>
      {members.length > 0 && (
        <div className="mt-2 space-y-1">
          {members.map(member => (
            <div key={member.id} className={`flex min-w-0 items-center gap-1 rounded px-1 ${compact ? 'bg-sidebar-accent/30 text-sidebar-foreground' : 'bg-background/70 text-foreground'}`}>
              <span className="min-w-0 flex-1 truncate text-xs" title={member.name}>{member.name}</span>
              <button type="button" data-standup-restore-id={member.id} aria-label={t('standup.queue.restoreNamed', { name: member.name })} onClick={() => onRestore(member.id)}
                className={`min-h-11 shrink-0 rounded px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${compact ? 'hover:bg-sidebar-hover' : 'text-primary hover:bg-accent'}`}>
                {t('standup.queue.restore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function StandupQueueEditor({ groups, sortMode, onReorder, excludedMembers, onExclude, onRestore, compact = false, onSelect, label }: StandupQueueEditorProps) {
  const { t } = useTranslation();
  const [activeDrag, setActiveDrag] = useState<QueueDragData | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ memberId: string; excluded: boolean } | null>(null);
  // Moving between lists removes the triggering button. Keep keyboard focus in
  // the editor rather than letting it fall to the page behind the launch dialog.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const attribute = focusRequest.excluded ? 'data-standup-restore-id' : 'data-standup-report-id';
    const target = Array.from(editorRef.current?.querySelectorAll<HTMLButtonElement>(`button[${attribute}]`) ?? [])
      .find(button => button.getAttribute(attribute) === focusRequest.memberId);
    (target ?? editorRef.current)?.focus();
    setFocusRequest(null);
  }, [focusRequest]);
  const excludeMember = (memberId: string) => {
    setFocusRequest({ memberId, excluded: true });
    onExclude(memberId);
  };
  const restoreMember = (memberId: string) => {
    setFocusRequest({ memberId, excluded: false });
    onRestore(memberId);
  };
  const byMember = sortMode === 'by_member';
  const memberIds = (group: StandupGroup) => group.members.map(member => queueMemberId(group.group_key, member.id));
  const rootIds = byMember
    ? groups.flatMap(memberIds)
    : groups.map(group => queueGroupId(group.group_key));

  const permittedIds = (active: QueueDragData): string[] => {
    if (active.kind === 'group') return groups.map(group => queueGroupId(group.group_key));
    const group = groups.find(item => item.group_key === active.groupKey);
    const ids = byMember ? groups.flatMap(memberIds) : group ? memberIds(group) : [];
    return [...ids, EXCLUDED_ZONE_ID];
  };

  // Restrict collisions to the current group. Only a pointer inside the separate
  // excluded zone may exclude someone; dragging below the queue still reorders.
  const collisionDetection: CollisionDetection = args => {
    const active = dragData(args.active.data.current);
    if (!active) return [];
    const allowed = new Set(permittedIds(active));
    const droppableContainers = args.droppableContainers.filter(container => allowed.has(String(container.id)));
    if (args.pointerCoordinates) {
      const hits = pointerWithin({ ...args, droppableContainers });
      if (hits.length) return hits;
      return closestCenter({ ...args, droppableContainers: droppableContainers.filter(container => container.id !== EXCLUDED_ZONE_ID) });
    }
    return closestCenter({ ...args, droppableContainers });
  };

  // Arrow keys stay within the same sortable list. Moving down from its last
  // person reaches the excluded zone, which is also a keyboard drop target.
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return;
    const active = dragData(args.context.active?.data.current);
    const collisionRect = args.context.collisionRect;
    if (!active || !collisionRect) return;
    event.preventDefault();
    const ids = permittedIds(active);
    const current = ids.indexOf(String(args.context.over?.id ?? args.active));
    const next = current + (event.code === 'ArrowDown' ? 1 : -1);
    const target = ids[next];
    const rect = target ? args.context.droppableRects.get(target) : undefined;
    if (!rect) return;
    return {
      x: args.currentCoordinates.x + rect.left + rect.width / 2 - collisionRect.left - collisionRect.width / 2,
      y: args.currentCoordinates.y + rect.top + rect.height / 2 - collisionRect.top - collisionRect.height / 2,
    };
  };
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

  const moveGroup = (groupKey: string, direction: -1 | 1) => {
    const index = groups.findIndex(group => group.group_key === groupKey);
    if (index < 0 || index + direction < 0 || index + direction >= groups.length) return;
    onReorder(arrayMove(groups, index, index + direction));
  };
  const moveMember = (groupKey: string, memberId: string, direction: -1 | 1) => {
    if (byMember) { moveGroup(groupKey, direction); return; }
    const group = groups.find(item => item.group_key === groupKey);
    if (!group) return;
    const index = group.members.findIndex(member => member.id === memberId);
    if (index < 0 || index + direction < 0 || index + direction >= group.members.length) return;
    onReorder(groups.map(item => item.group_key === groupKey ? { ...item, members: arrayMove(item.members, index, index + direction) } : item));
  };
  const finishDrag = ({ active, over }: DragEndEvent) => {
    setActiveDrag(null);
    const source = dragData(active.data.current);
    if (!source || !over) return;
    if (over.id === EXCLUDED_ZONE_ID) {
      if (source.kind === 'member' && source.memberId) excludeMember(source.memberId);
      return;
    }
    const target = dragData(over.data.current);
    if (!target || active.id === over.id) return;
    if (source.kind === 'group' || byMember) {
      if (!byMember && target.kind !== 'group') return;
      const from = groups.findIndex(group => group.group_key === source.groupKey);
      const to = groups.findIndex(group => group.group_key === target.groupKey);
      if (from >= 0 && to >= 0) onReorder(arrayMove(groups, from, to));
      return;
    }
    if (target.kind !== 'member' || source.groupKey !== target.groupKey) return;
    const group = groups.find(item => item.group_key === source.groupKey);
    if (!group) return;
    const from = group.members.findIndex(member => member.id === source.memberId);
    const to = group.members.findIndex(member => member.id === target.memberId);
    if (from >= 0 && to >= 0) onReorder(groups.map(item => item.group_key === group.group_key ? { ...item, members: arrayMove(item.members, from, to) } : item));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection}
      accessibility={{
        screenReaderInstructions: { draggable: t('standup.queue.dragInstructions') },
        announcements: {
          onDragStart: ({ active }) => t('standup.queue.dragStart', { name: dragData(active.data.current)?.name ?? '' }),
          onDragOver: ({ over }) => over ? t('standup.queue.dragOver', { name: over.id === EXCLUDED_ZONE_ID ? t('standup.queue.exclude') : dragData(over.data.current)?.name ?? '' }) : undefined,
          onDragEnd: ({ active, over }) => over?.id === EXCLUDED_ZONE_ID
            ? t('standup.queue.excludeNamed', { name: dragData(active.data.current)?.name ?? '' })
            : t('standup.queue.dragEnd', { name: dragData(active.data.current)?.name ?? '' }),
          onDragCancel: ({ active }) => t('standup.queue.dragCancel', { name: dragData(active.data.current)?.name ?? '' }),
        },
      }}
      onDragStart={({ active }) => setActiveDrag(dragData(active.data.current))}
      onDragEnd={finishDrag} onDragCancel={() => setActiveDrag(null)}>
      <div ref={editorRef} tabIndex={-1} data-standup-dragging={activeDrag ? 'true' : undefined} className="min-w-0 space-y-3">
        {groups.length > 0 ? (
          <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
            <div role="list" aria-label={label ?? t('standup.settings.preview')} className="space-y-2">
              {groups.map((group, groupIndex) => byMember ? (
                group.members.map(member => (
                  <QueueMemberRow key={queueMemberId(group.group_key, member.id)} member={member} groupKey={group.group_key}
                    index={groupIndex} first={groupIndex === 0} last={groupIndex === groups.length - 1} compact={compact} topLevel
                    onMove={direction => moveMember(group.group_key, member.id, direction)} onExclude={() => excludeMember(member.id)}
                    onSelect={onSelect ? () => onSelect(group.group_key, member.id) : undefined} />
                ))
              ) : (
                <QueueGroupRow key={group.group_key} group={group} index={groupIndex} first={groupIndex === 0} last={groupIndex === groups.length - 1}
                  compact={compact} onMove={direction => moveGroup(group.group_key, direction)}>
                  <SortableContext items={memberIds(group)} strategy={verticalListSortingStrategy}>
                    {group.members.map((member, index) => (
                      <QueueMemberRow key={queueMemberId(group.group_key, member.id)} member={member} groupKey={group.group_key}
                        index={index} first={index === 0} last={index === group.members.length - 1} compact={compact}
                        onMove={direction => moveMember(group.group_key, member.id, direction)} onExclude={() => excludeMember(member.id)}
                        onSelect={onSelect ? () => onSelect(group.group_key, member.id) : undefined} />
                    ))}
                  </SortableContext>
                </QueueGroupRow>
              ))}
            </div>
          </SortableContext>
        ) : <p role="status" className={`py-2 text-xs ${compact ? 'text-sidebar-foreground/60' : 'text-muted-foreground'}`}>{t('standup.queue.empty')}</p>}
        <ExcludedZone members={excludedMembers} compact={compact} acceptingMember={activeDrag?.kind === 'member'} onRestore={restoreMember} />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDrag && <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-primary bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg">
          <GripVertical size={16} aria-hidden="true" /><span className="truncate">{activeDrag.name}</span>
        </div>}
      </DragOverlay>
    </DndContext>
  );
}
