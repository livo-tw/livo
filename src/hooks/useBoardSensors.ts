import {
  KeyboardCode, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';

/** Card controls keep their own tap/press actions; the card's main surface may be a button. */
function canStartBoardDrag(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;
  const control = target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], [data-no-drag]');
  return !control || control.hasAttribute('data-drag-surface');
}

class BoardMouseSensor extends MouseSensor {
  static activators = MouseSensor.activators.map(activator => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      canStartBoardDrag(args[0].nativeEvent.target) && activator.handler(...args),
  }));
}

class BoardCardTouchSensor extends TouchSensor {
  static activators = TouchSensor.activators.map(activator => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      canStartBoardDrag(args[0].nativeEvent.target) && activator.handler(...args),
  }));
}

class BoardHandleTouchSensor extends TouchSensor {
  static activators = TouchSensor.activators.map(activator => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) => {
      const target = args[0].nativeEvent.target;
      // Do not create a delayed sensor on the card body: even a slow swipe must
      // stay native. The handle opts out of native panning before touchstart.
      return target instanceof Element && !!target.closest('[data-board-drag-handle]')
        && canStartBoardDrag(target) && activator.handler(...args);
    },
  }));
}

/** Card bodies scroll natively; Backlog explicitly retains its whole-card touch entry. */
export function useBoardSensors(coordinateGetter?: KeyboardCoordinateGetter, { touchDrag = 'handle' }: { touchDrag?: 'handle' | 'card' } = {}) {
  return useSensors(
    useSensor(BoardMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(touchDrag === 'card' ? BoardCardTouchSensor : BoardHandleTouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      ...(coordinateGetter ? { coordinateGetter } : {}),
      keyboardCodes: { start: [KeyboardCode.Space], end: [KeyboardCode.Space], cancel: [KeyboardCode.Esc] },
    }),
  );
}
