import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Active, ClientRect, DndContextDescriptor, DndContextProps, DragEndEvent,
  DroppableContainer, KeyboardCoordinateGetter, Over, SensorContext,
} from '@dnd-kit/core';
import { KeyboardSensor } from '@dnd-kit/core';
import { StandupQueueEditor, type StandupQueueEditorProps } from '@/components/standup/StandupQueueEditor';
import { queueGroupId, queueMemberId, type QueueDragData } from '@/components/standup/standupQueueDnd';
import type { StandupGroup } from '@/hooks/useStandupGrouping';
import type { User } from '@/types';

const captured = vi.hoisted(() => ({ props: null as DndContextProps | null, context: null as DndContextDescriptor | null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string; count?: number }) => `${key}${values?.name ? ` ${values.name}` : values?.count !== undefined ? ` ${values.count}` : ''}` }) }));
// Keep real dnd-kit hooks, sensors, and collision algorithms. The wrapper exposes
// callbacks so domain boundaries can also be checked without browser geometry.
vi.mock('@dnd-kit/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  function ContextProbe(): null { captured.context = actual.useDndContext(); return null; }
  function DndContext(props: DndContextProps) {
    captured.props = props;
    return <actual.DndContext {...props}>{props.children}<ContextProbe /></actual.DndContext>;
  }
  return { ...actual, DndContext };
});

const user = (id: string, name: string): User => ({ id, name, avatar: name[0], role: 'member', jobTitle: 'Engineer', color: '#667788', email: `${id}@example.com`, isActive: true, sortOrder: 0 });
const alex = user('a', 'Alex'), blair = user('b', 'Blair'), casey = user('c', 'Casey');
const group = (key: string, members: User[]): StandupGroup => ({ group_key: key, group_title: key, members, task_count: members.length, estimated_duration: members.length * 135 });
const rect = (top: number, height = 48): ClientRect => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height });
const domRect = (top: number): DOMRect => ({ ...rect(top), x: 0, y: top, toJSON: () => rect(top) });
const memberData = (groupKey: string, member: User): QueueDragData => ({ kind: 'member', groupKey, memberId: member.id, name: member.name });
const groupData = (groupKey: string): QueueDragData => ({ kind: 'group', groupKey, name: groupKey });
const active = (data: QueueDragData): Active => ({ id: data.kind === 'group' ? queueGroupId(data.groupKey) : queueMemberId(data.groupKey, data.memberId!), data: { current: data }, rect: { current: { initial: rect(0), translated: rect(0) } } });
const over = (id: string, data?: QueueDragData, top = 0): Over => ({ id, disabled: false, data: { current: data }, rect: rect(top) });
const container = (id: string, data: QueueDragData | undefined, top: number): DroppableContainer => ({ id, key: id, data: { current: data }, disabled: false, node: { current: null }, rect: { current: rect(top) } });
const endEvent = (source: QueueDragData, target: Over | null): DragEndEvent => ({ active: active(source), over: target, activatorEvent: new MouseEvent('mouseup'), delta: { x: 0, y: 0 }, collisions: null });

let callbacks: Pick<StandupQueueEditorProps, 'onReorder' | 'onExclude' | 'onRestore' | 'onSelect'>;
beforeEach(() => {
  captured.props = null; captured.context = null;
  callbacks = { onReorder: vi.fn(), onExclude: vi.fn(), onRestore: vi.fn(), onSelect: vi.fn() };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(groups = [group('a', [alex]), group('b', [blair]), group('c', [casey])], extra: Partial<StandupQueueEditorProps> = {}) {
  return render(<StandupQueueEditor groups={groups} sortMode="by_member" excludedMembers={[]} {...callbacks} {...extra} />);
}
function simulateEnd(source: QueueDragData, target: Over | null) {
  act(() => captured.props!.onDragEnd!(endEvent(source, target)));
}
function mockOverlayGeometry() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const positioned = this.style.position === 'fixed' ? this : this.parentElement?.style.position === 'fixed' ? this.parentElement : undefined;
    return positioned ? domRect(Number.parseFloat(positioned.style.top) || 0) : original.call(this);
  });
}

describe('standup queue editor boundaries', () => {
  it('keeps grouped list items, names, and actions separate and offers non-drag controls', () => {
    mount([group('Project A', [alex, blair]), group('Project B', [casey])], { sortMode: 'by_project', excludedMembers: [user('d', 'Drew')], compact: true });
    const list = screen.getByRole('list', { name: 'standup.settings.preview' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.querySelector('button button')).toBeNull();
    expect(screen.getByRole('button', { name: 'standup.queue.moveUp Alex' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'standup.queue.moveDown Alex' }));
    expect(callbacks.onReorder).toHaveBeenLastCalledWith([group('Project A', [blair, alex]), group('Project B', [casey])]);
    fireEvent.click(screen.getByRole('button', { name: 'standup.queue.excludeNamed Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'standup.queue.restoreNamed Drew' }));
    expect(callbacks.onExclude).toHaveBeenCalledWith('a'); expect(callbacks.onRestore).toHaveBeenCalledWith('d');
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Alex' }));
    expect(callbacks.onSelect).toHaveBeenCalledWith('Project A', 'a');
    const handle = screen.getByRole('button', { name: 'standup.queue.dragMember Alex' });
    expect(handle).toHaveClass('touch-none');
    expect(screen.getByRole('button', { name: 'Alex' })).not.toHaveClass('touch-none');
  });

  it('reorders a member only in the same group and preserves metadata and input arrays', () => {
    const groups = [group('Project A', [alex, blair]), group('Project B', [alex, casey])];
    mount(groups, { sortMode: 'by_project' });
    simulateEnd(memberData('Project A', alex), over(queueMemberId('Project B', casey.id), memberData('Project B', casey)));
    expect(callbacks.onReorder).not.toHaveBeenCalled();
    simulateEnd(memberData('Project A', alex), over(queueMemberId('Project A', blair.id), memberData('Project A', blair)));
    expect(callbacks.onReorder).toHaveBeenCalledWith([group('Project A', [blair, alex]), groups[1]]);
    expect(groups[0].members).toEqual([alex, blair]);
    simulateEnd(groupData('Project A'), over(queueGroupId('Project B'), groupData('Project B')));
    expect(callbacks.onReorder).toHaveBeenLastCalledWith([groups[1], groups[0]]);
  });

  it('excludes only the dragged person when dropped into the dedicated zone; group drops do not exclude', () => {
    mount([group('Project A', [alex, blair]), group('Project B', [alex, casey])], { sortMode: 'by_project' });
    simulateEnd(memberData('Project A', alex), over('standup-excluded-zone'));
    expect(callbacks.onExclude).toHaveBeenCalledTimes(1); expect(callbacks.onExclude).toHaveBeenCalledWith('a');
    simulateEnd(groupData('Project A'), over('standup-excluded-zone'));
    simulateEnd(memberData('Project A', blair), null);
    expect(callbacks.onExclude).toHaveBeenCalledTimes(1); expect(callbacks.onReorder).not.toHaveBeenCalled();
  });

  it('requires pointer entry into the excluded zone and ignores cross-group targets', () => {
    mount([group('Project A', [alex, blair]), group('Project B', [casey])], { sortMode: 'by_project' });
    const containers = [
      container(queueMemberId('Project A', alex.id), memberData('Project A', alex), 0),
      container(queueMemberId('Project A', blair.id), memberData('Project A', blair), 64),
      container(queueMemberId('Project B', casey.id), memberData('Project B', casey), 128),
      container('standup-excluded-zone', undefined, 240),
    ];
    const collisionArgs = {
      active: active(memberData('Project A', alex)), collisionRect: rect(176), droppableContainers: containers,
      droppableRects: new Map(containers.map(item => [item.id, item.rect.current!])), pointerCoordinates: { x: 250, y: 190 },
    };
    const collide = captured.props!.collisionDetection!;
    expect(collide(collisionArgs)[0].id).toBe(queueMemberId('Project A', blair.id));
    expect(collide({ ...collisionArgs, pointerCoordinates: { x: 250, y: 150 } })[0].id).not.toBe(queueMemberId('Project B', casey.id));
    expect(collide({ ...collisionArgs, pointerCoordinates: { x: 250, y: 260 } })[0].id).toBe('standup-excluded-zone');
    expect(callbacks.onExclude).not.toHaveBeenCalled();
  });

  it('does not make the excluded zone a collision target for dragged groups', () => {
    mount([group('Project A', [alex]), group('Project B', [casey])], { sortMode: 'by_project' });
    const containers = [
      container(queueGroupId('Project A'), groupData('Project A'), 0),
      container(queueGroupId('Project B'), groupData('Project B'), 64),
      container('standup-excluded-zone', undefined, 240),
    ];
    const collisions = captured.props!.collisionDetection!({
      active: active(groupData('Project A')), collisionRect: rect(240), droppableContainers: containers,
      droppableRects: new Map(containers.map(item => [item.id, item.rect.current!])), pointerCoordinates: { x: 250, y: 260 },
    });
    expect(collisions[0].id).toBe(queueGroupId('Project B'));
    expect(collisions.some(collision => collision.id === 'standup-excluded-zone')).toBe(false);
  });

  it('keeps keyboard targets inside the group and includes its explicit excluded target', () => {
    mount([group('Project A', [alex, blair]), group('Project B', [casey])], { sortMode: 'by_project' });
    const descriptor = captured.props!.sensors!.find(sensor => sensor.sensor === KeyboardSensor)!;
    const getter = (descriptor.options as { coordinateGetter: KeyboardCoordinateGetter }).coordinateGetter;
    const context: SensorContext = {
      activatorEvent: null, active: active(memberData('Project A', blair)), activeNode: null,
      collisionRect: rect(64), collisions: null, draggableNodes: captured.context!.draggableNodes,
      draggingNode: null, draggingNodeRect: rect(64), droppableContainers: captured.context!.droppableContainers,
      droppableRects: new Map([[queueMemberId('Project A', alex.id), rect(0)], [queueMemberId('Project A', blair.id), rect(64)], [queueMemberId('Project B', casey.id), rect(128)], ['standup-excluded-zone', rect(240)]]),
      over: over(queueMemberId('Project A', blair.id), memberData('Project A', blair), 64), scrollableAncestors: [], scrollAdjustedTranslate: null,
    };
    const event = new KeyboardEvent('keydown', { code: 'ArrowDown', cancelable: true });
    expect(getter(event, { active: context.active!.id, currentCoordinates: { x: 0, y: 0 }, context })).toEqual({ x: 0, y: 176 });
    expect(event.defaultPrevented).toBe(true);
    context.over = over('standup-excluded-zone', undefined, 240); context.collisionRect = rect(240);
    expect(getter(new KeyboardEvent('keydown', { code: 'ArrowUp' }), { active: context.active!.id, currentCoordinates: { x: 0, y: 176 }, context })).toEqual({ x: 0, y: 0 });
  });

  it('starts and cancels a real keyboard drag without changing order or invoking selection', async () => {
    mount();
    const handle = screen.getByRole('button', { name: 'standup.queue.dragMember Alex' });
    handle.focus(); fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(handle).not.toHaveAttribute('aria-pressed', 'true'));
    expect(captured.context!.active).toBeNull();
    expect(callbacks.onReorder).not.toHaveBeenCalled(); expect(callbacks.onExclude).not.toHaveBeenCalled(); expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it('commits a real keyboard drag to the next report using measured row rectangles', async () => {
    mockOverlayGeometry();
    mount();
    screen.getAllByRole('listitem').forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => domRect(index * 64));
    });
    vi.spyOn(screen.getByRole('region', { name: 'standup.queue.excluded 0' }), 'getBoundingClientRect')
      .mockImplementation(() => domRect(240));
    const handle = screen.getByRole('button', { name: 'standup.queue.dragMember Alex' });
    handle.focus(); fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(captured.context!.droppableRects.get(queueMemberId('b', 'b'))?.top).toBe(64));
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(captured.context!.over?.id).toBe(queueMemberId('b', 'b')));
    fireEvent.keyDown(document, { key: ' ', code: 'Space' });
    await waitFor(() => expect(callbacks.onReorder).toHaveBeenCalledWith([group('b', [blair]), group('a', [alex]), group('c', [casey])]));
    expect(callbacks.onExclude).not.toHaveBeenCalled(); expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it('drops the last person into the excluded zone with the real keyboard sensor', async () => {
    mockOverlayGeometry();
    mount([group('a', [alex]), group('b', [blair])]);
    screen.getAllByRole('listitem').forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => domRect(index * 64)));
    vi.spyOn(screen.getByRole('region', { name: 'standup.queue.excluded 0' }), 'getBoundingClientRect').mockImplementation(() => domRect(240));
    const handle = screen.getByRole('button', { name: 'standup.queue.dragMember Blair' });
    handle.focus(); fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(captured.context!.droppableRects.get('standup-excluded-zone')?.top).toBe(240));
    // KeyboardSensor attaches its document listener on the next task.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(captured.context!.droppableContainers.get('standup-excluded-zone')?.disabled).toBe(false);
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(captured.context!.over?.id).toBe('standup-excluded-zone'));
    fireEvent.keyDown(document, { key: ' ', code: 'Space' });
    await waitFor(() => expect(callbacks.onExclude).toHaveBeenCalledWith('b'));
    expect(callbacks.onReorder).not.toHaveBeenCalled(); expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
