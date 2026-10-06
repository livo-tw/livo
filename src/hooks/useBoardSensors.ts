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

class BoardTouchSensor extends TouchSensor {
  static activators = TouchSensor.activators.map(activator => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      canStartBoardDrag(args[0].nativeEvent.target) && activator.handler(...args),
  }));
}

/** Separate mouse and touch so swiping stays native until a deliberate long press. */
export function useBoardSensors(coordinateGetter?: KeyboardCoordinateGetter) {
  return useSensors(
    useSensor(BoardMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(BoardTouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      ...(coordinateGetter ? { coordinateGetter } : {}),
      keyboardCodes: { start: [KeyboardCode.Space], end: [KeyboardCode.Space], cancel: [KeyboardCode.Esc] },
    }),
  );
}
