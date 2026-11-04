import { useState, useEffect, useRef } from 'react';

export type TimerStatus = 'idle' | 'normal' | 'warning' | 'critical' | 'buffer';

interface UseStandupTimerOptions {
  turnKey: string | null;
  startOnTurn: boolean;
  duration: number;
  bufferSeconds: number;
  autoAdvance: boolean;
  onAdvance: () => void;
}

function startTurn(turnKey: string | null, duration: number, bufferSeconds: number, running: boolean) {
  return {
    turnKey, duration, bufferSeconds, timeLeft: duration, bufferLeft: bufferSeconds,
    isRunning: running, hasStarted: running, inBuffer: false,
  };
}

export function useStandupTimer({
  turnKey, startOnTurn, duration, bufferSeconds, autoAdvance, onAdvance,
}: UseStandupTimerOptions) {
  const [timer, setTimer] = useState(() => startTurn(turnKey, duration, bufferSeconds, startOnTurn));
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;
  // The group/member identity owns the countdown. Queue edits and refreshes
  // may change the group object, but the current allocation stays in effect.
  if (timer.turnKey !== turnKey) {
    setTimer(startTurn(turnKey, duration, bufferSeconds, startOnTurn));
  }

  const { isRunning, inBuffer, timeLeft, bufferLeft, hasStarted } = timer;
  useEffect(() => {
    if (!isRunning || turnKey === null) return;

    if (!inBuffer && timeLeft === 0) {
      if (autoAdvance) setTimer(previous => ({ ...previous, inBuffer: true }));
      return;
    }

    if (inBuffer && bufferLeft === 0) {
      setTimer(previous => ({ ...previous, isRunning: false }));
      onAdvanceRef.current();
      return;
    }

    const field = inBuffer ? 'bufferLeft' : 'timeLeft';
    const id = setInterval(() => {
      setTimer(previous => previous.turnKey === turnKey && previous.isRunning
        ? { ...previous, [field]: Math.max(0, previous[field] - 1) }
        : previous);
    }, 1000);
    return () => clearInterval(id);
  }, [turnKey, isRunning, inBuffer, timeLeft, bufferLeft, autoAdvance]);

  const timerStatus: TimerStatus = (() => {
    if (!isRunning && timeLeft === timer.duration && !inBuffer) return 'idle';
    if (inBuffer) return 'buffer';
    if (timeLeft <= 10) return 'critical';
    if (timeLeft <= 30) return 'warning';
    return 'normal';
  })();

  return {
    displayTime: inBuffer ? bufferLeft : timeLeft,
    maxTime: inBuffer ? timer.bufferSeconds : timer.duration,
    inBuffer,
    isRunning,
    hasStarted,
    timerStatus,
    pause: () => setTimer(previous => ({ ...previous, isRunning: false })),
    resume: () => setTimer(previous => ({ ...previous, isRunning: true, hasStarted: true })),
    reset: () => setTimer(previous => ({ ...startTurn(turnKey, duration, bufferSeconds, false), hasStarted: previous.hasStarted })),
  };
}
