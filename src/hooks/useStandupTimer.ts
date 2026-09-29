import { useState, useEffect, useRef, useCallback } from 'react';

export type TimerStatus = 'idle' | 'normal' | 'warning' | 'critical' | 'buffer';

interface UseStandupTimerOptions {
  duration: number;       // seconds allocated for current member
  bufferSeconds: number;  // grace period after time runs out
  autoAdvance: boolean;   // trigger onAdvance after buffer expires
  onAdvance?: () => void;
}

export function useStandupTimer({
  duration,
  bufferSeconds,
  autoAdvance,
  onAdvance,
}: UseStandupTimerOptions) {
  const [timeLeft, setTimeLeft]       = useState(duration);
  const [isRunning, setIsRunning]     = useState(false);
  const [inBuffer, setInBuffer]       = useState(false);
  const [bufferLeft, setBufferLeft]   = useState(bufferSeconds);
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;

  // Reset whenever the target duration changes (new member selected)
  const reset = useCallback(
    (newDuration?: number) => {
      setTimeLeft(newDuration ?? duration);
      setIsRunning(false);
      setInBuffer(false);
      setBufferLeft(bufferSeconds);
    },
    [duration, bufferSeconds],
  );

  useEffect(() => {
    reset(duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  // Main countdown tick
  useEffect(() => {
    if (!isRunning) return;

    if (!inBuffer) {
      if (timeLeft > 0) {
        const id = setInterval(() => setTimeLeft(t => t - 1), 1000);
        return () => clearInterval(id);
      }
      // Time reached 0 — enter buffer if autoAdvance is on
      if (autoAdvance) {
        setInBuffer(true);
        setBufferLeft(bufferSeconds);
      }
      return;
    }

    // In buffer
    if (bufferLeft > 0) {
      const id = setInterval(() => setBufferLeft(t => t - 1), 1000);
      return () => clearInterval(id);
    }
    // Buffer exhausted
    setIsRunning(false);
    onAdvanceRef.current?.();
  }, [isRunning, timeLeft, inBuffer, bufferLeft, autoAdvance, bufferSeconds]);

  const timerStatus: TimerStatus = (() => {
    if (!isRunning && timeLeft === duration && !inBuffer) return 'idle';
    if (inBuffer)        return 'buffer';
    if (timeLeft <= 10)  return 'critical';
    if (timeLeft <= 30)  return 'warning';
    return 'normal';
  })();

  return {
    /** Time to display: bufferLeft while in buffer, otherwise timeLeft */
    displayTime: inBuffer ? bufferLeft : timeLeft,
    rawTimeLeft: timeLeft,
    bufferLeft,
    inBuffer,
    isRunning,
    timerStatus,
    toggle:  useCallback(() => setIsRunning(r => !r), []),
    pause:   useCallback(() => setIsRunning(false), []),
    resume:  useCallback(() => setIsRunning(true), []),
    skip:    useCallback(() => { setIsRunning(false); onAdvanceRef.current?.(); }, []),
    reset,
  };
}
