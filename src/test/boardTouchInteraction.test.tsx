import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardSensors } from '@/hooks/useBoardSensors';

function Card({ onOpen, onAction }: { onOpen: () => void; onAction: () => void }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: 'example-card' });
  return <div ref={setNodeRef} {...attributes} {...listeners} data-drag-surface aria-label="Move card">
    <button data-drag-surface onClick={onOpen}>Example card</button>
    <button onClick={onAction}>Quick edit</button>
  </div>;
}
function Board({ onStart, onEnd, onCancel, onOpen, onAction }: { onStart: () => void; onEnd: () => void; onCancel: () => void; onOpen: () => void; onAction: () => void }) {
  const sensors = useBoardSensors();
  return <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={onCancel}>
    <Column><Card onOpen={onOpen} onAction={onAction} /></Column>
  </DndContext>;
}
function Column({ children }: { children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: 'example-column' });
  return <section ref={setNodeRef}>{children}</section>;
}
const touch = (x = 50, y = 50) => ({ identifier: 1, clientX: x, clientY: y });
const startTouch = (node: HTMLElement) => fireEvent.touchStart(node, { touches: [touch()], changedTouches: [touch()] });

describe('board touch and mouse gestures', () => {
  const start = vi.fn(), end = vi.fn(), cancel = vi.fn(), open = vi.fn(), action = vi.fn();
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { cleanup(); act(() => { vi.runOnlyPendingTimers(); }); vi.useRealTimers(); });
  const mount = () => render(<Board onStart={start} onEnd={end} onCancel={cancel} onOpen={open} onAction={action} />);

  it.each([[80, 50], [50, 80]])('keeps a swipe native before the long press, including movement to %s,%s', (x, y) => {
    mount(); const card = screen.getByRole('button', { name: 'Example card' });
    startTouch(card);
    expect(fireEvent.touchMove(card, { touches: [touch(x, y)], changedTouches: [touch(x, y)] })).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.touchEnd(card, { touches: [], changedTouches: [touch(x, y)] });
    expect(start).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  });

  it('activates only after holding, captures movement during drag and releases click suppression after the drop', () => {
    mount(); const card = screen.getByRole('button', { name: 'Example card' });
    startTouch(card); act(() => { vi.advanceTimersByTime(299); }); expect(start).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); }); expect(start).toHaveBeenCalledTimes(1);
    expect(fireEvent.touchMove(card, { touches: [touch(80)], changedTouches: [touch(80)] })).toBe(false);
    fireEvent.click(card); expect(open).not.toHaveBeenCalled();
    fireEvent.touchEnd(card, { touches: [], changedTouches: [touch(80)] });
    expect(end).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60); }); fireEvent.click(card); expect(open).toHaveBeenCalledTimes(1);
  });

  it('cancels an interrupted touch without dropping or leaving later taps blocked', () => {
    mount(); const card = screen.getByRole('button', { name: 'Example card' });
    startTouch(card); act(() => { vi.advanceTimersByTime(300); });
    fireEvent.touchCancel(card, { touches: [], changedTouches: [touch()] });
    expect(cancel).toHaveBeenCalledTimes(1); expect(end).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60); }); fireEvent.click(card); expect(open).toHaveBeenCalledTimes(1);
  });

  it('lets nested quick edits handle a tap or long press without starting a card drag', () => {
    mount(); const button = screen.getByRole('button', { name: 'Quick edit' });
    startTouch(button); act(() => { vi.advanceTimersByTime(400); });
    fireEvent.touchEnd(button, { touches: [], changedTouches: [touch()] });
    fireEvent.click(button); expect(start).not.toHaveBeenCalled(); expect(action).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(button, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 80, clientY: 50 }); fireEvent.mouseUp(document);
    expect(start).not.toHaveBeenCalled();
  });

  it('preserves distance activation for a mouse and Space/Escape for the keyboard', () => {
    mount(); const card = screen.getByRole('button', { name: 'Example card' });
    fireEvent.mouseDown(card, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 54, clientY: 50 }); expect(start).not.toHaveBeenCalled();
    fireEvent.mouseMove(document, { clientX: 80, clientY: 50 }); expect(start).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(document); act(() => { vi.advanceTimersByTime(60); });
    const handle = screen.getByRole('button', { name: 'Move card' }); handle.focus();
    fireEvent.keyDown(handle, { code: 'Space' }); expect(start).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.keyDown(document, { code: 'Escape' }); expect(cancel).toHaveBeenCalledTimes(1);
  });
});
