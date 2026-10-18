/**
 * StudyOS — Module 5: Focus Mode Timer Engine & Web Audio Synthesizer
 *
 * Provides a drift-compensated countdown timer anchored to `Date.now()`
 * wall-clock timestamps so backgrounded browser tabs never lose accuracy,
 * plus a zero-dependency Web Audio API harmonic completion chime.
 */

export const FOCUS_MODES = Object.freeze({
  pomodoro: Object.freeze({
    id: 'pomodoro',
    label: 'Pomodoro',
    defaultMinutes: 25,
    isBreak: false,
    runningLabel: 'Focusing...',
  }),
  deep: Object.freeze({
    id: 'deep',
    label: 'Deep Work',
    defaultMinutes: 50,
    isBreak: false,
    runningLabel: 'Focusing...',
  }),
  sprint: Object.freeze({
    id: 'sprint',
    label: 'Sprint',
    defaultMinutes: 15,
    isBreak: false,
    runningLabel: 'Focusing...',
  }),
  break: Object.freeze({
    id: 'break',
    label: 'Short Break',
    defaultMinutes: 5,
    isBreak: true,
    runningLabel: 'Break',
  }),
  custom: Object.freeze({
    id: 'custom',
    label: 'Custom',
    defaultMinutes: 30,
    isBreak: false,
    runningLabel: 'Focusing...',
  }),
});

export const MIN_FOCUS_MINUTES = 1;
export const MAX_FOCUS_MINUTES = 180;

export function clampFocusMinutes(value, fallback = 25) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, num));
}

/**
 * Formats seconds into tabular `MM:SS` (or `HHH:MM:SS` if >= 100 minutes, though
 * `MM:SS` handles up to 180:00 cleanly as `180:00` or `99:59`).
 */
export function formatTimerMMSS(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatElapsedSummary(elapsedSeconds) {
  const secs = Math.max(0, Math.floor(elapsedSeconds));
  if (secs === 0) return '0m elapsed';
  if (secs < 60) return `${secs}s elapsed`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) {
    return remSecs > 0 ? `${mins}m ${remSecs}s elapsed` : `${mins}m elapsed`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, '0')}m elapsed`;
}

/* ==========================================================================
   Web Audio API Completion Chime
   ========================================================================== */

let sharedAudioContext = null;

function getAudioContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioCtx();
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }
  return sharedAudioContext;
}

/**
 * Synthesizes a gentle, resonant 4-note ascending chime (C5 - E5 - G5 - C6)
 * using the native Web Audio API.
 */
export function playCompletionChime({ muted = false } = {}) {
  if (muted) return false;
  try {
    const ctx = getAudioContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

    notes.forEach((freq, idx) => {
      const start = now + idx * 0.14;
      const duration = 0.65;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = idx === notes.length - 1 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + duration + 0.02);
    });
    return true;
  } catch (error) {
    console.warn('StudyOS: Web Audio chime could not play.', error);
    return false;
  }
}

/* ==========================================================================
   Drift-Compensated Timer Engine
   ========================================================================== */

/**
 * Creates a drift-compensated timer using `Date.now()` timestamps.
 *
 * @param {object} options
 * @param {(snapshot: object) => void} [options.onTick]
 * @param {(result: object) => void} [options.onComplete]
 */
export function createFocusTimer({ onTick, onComplete } = {}) {
  let mode = 'pomodoro';
  let status = 'idle'; // 'idle' | 'running' | 'paused'
  let durationMinutes = FOCUS_MODES.pomodoro.defaultMinutes;
  let totalDurationMs = durationMinutes * 60 * 1000;
  let accumulatedElapsedMs = 0;
  let segmentStartedAt = null;
  let sessionStartedAtISO = null;
  let intervalId = null;

  function computeElapsedMs(now = Date.now()) {
    if (status === 'running' && segmentStartedAt !== null) {
      return accumulatedElapsedMs + Math.max(0, now - segmentStartedAt);
    }
    return accumulatedElapsedMs;
  }

  function getStatusLabel() {
    const modeMeta = FOCUS_MODES[mode] ?? FOCUS_MODES.pomodoro;
    if (status === 'running') {
      return modeMeta.isBreak ? 'Break' : 'Focusing...';
    }
    if (status === 'paused') {
      return 'Paused';
    }
    return modeMeta.isBreak ? 'Break' : 'Ready to Focus';
  }

  function getSnapshot(now = Date.now()) {
    const rawElapsedMs = computeElapsedMs(now);
    const clampedElapsedMs = Math.min(totalDurationMs, rawElapsedMs);
    const remainingMs = Math.max(0, totalDurationMs - clampedElapsedMs);

    const totalSeconds = Math.round(totalDurationMs / 1000);
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const elapsedSeconds = Math.floor(clampedElapsedMs / 1000);
    const progress = totalDurationMs > 0 ? clampedElapsedMs / totalDurationMs : 0;
    const modeMeta = FOCUS_MODES[mode] ?? FOCUS_MODES.pomodoro;

    return {
      mode,
      modeLabel: modeMeta.label,
      isBreak: modeMeta.isBreak,
      status,
      statusLabel: getStatusLabel(),
      durationMinutes,
      totalSeconds,
      remainingSeconds,
      elapsedSeconds,
      elapsedMinutes: Math.max(1, Math.round(elapsedSeconds / 60)),
      progress,
      formattedRemaining: formatTimerMMSS(remainingSeconds),
      formattedElapsed: formatElapsedSummary(elapsedSeconds),
      startedAt: sessionStartedAtISO,
    };
  }

  function stopInterval() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function notifyTick(now = Date.now()) {
    if (typeof onTick === 'function') {
      onTick(getSnapshot(now));
    }
  }

  function checkTick() {
    const now = Date.now();
    const elapsedMs = computeElapsedMs(now);

    if (status === 'running' && elapsedMs >= totalDurationMs) {
      stopInterval();
      accumulatedElapsedMs = totalDurationMs;
      segmentStartedAt = null;
      status = 'idle';

      const completedSnapshot = {
        mode,
        isBreak: (FOCUS_MODES[mode] ?? FOCUS_MODES.pomodoro).isBreak,
        durationMinutes,
        elapsedSeconds: Math.round(totalDurationMs / 1000),
        startedAt: sessionStartedAtISO ?? new Date(now - totalDurationMs).toISOString(),
        completedAt: new Date(now).toISOString(),
      };

      // Reset elapsed for next run
      accumulatedElapsedMs = 0;
      sessionStartedAtISO = null;
      notifyTick(now);

      if (typeof onComplete === 'function') {
        onComplete(completedSnapshot);
      }
      return;
    }

    notifyTick(now);
  }

  function start() {
    if (status === 'running') return getSnapshot();
    const now = Date.now();
    if (!sessionStartedAtISO) {
      sessionStartedAtISO = new Date(now).toISOString();
    }
    segmentStartedAt = now;
    status = 'running';
    stopInterval();
    intervalId = setInterval(checkTick, 250);
    notifyTick(now);
    return getSnapshot(now);
  }

  function pause() {
    if (status !== 'running') return getSnapshot();
    const now = Date.now();
    accumulatedElapsedMs = computeElapsedMs(now);
    segmentStartedAt = null;
    status = 'paused';
    stopInterval();
    notifyTick(now);
    return getSnapshot(now);
  }

  function toggle() {
    return status === 'running' ? pause() : start();
  }

  function reset() {
    stopInterval();
    status = 'idle';
    accumulatedElapsedMs = 0;
    segmentStartedAt = null;
    sessionStartedAtISO = null;
    notifyTick();
    return getSnapshot();
  }

  function setModeAndDuration(nextMode, minutes) {
    stopInterval();
    mode = FOCUS_MODES[nextMode] ? nextMode : 'custom';
    const fallback = FOCUS_MODES[mode]?.defaultMinutes ?? 25;
    durationMinutes = clampFocusMinutes(minutes ?? fallback, fallback);
    totalDurationMs = durationMinutes * 60 * 1000;
    status = 'idle';
    accumulatedElapsedMs = 0;
    segmentStartedAt = null;
    sessionStartedAtISO = null;
    notifyTick();
    return getSnapshot();
  }

  // Ensure backgrounded tabs sync immediately when becoming visible again
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (status === 'running') {
        checkTick();
      }
    });
  }

  return {
    start,
    pause,
    toggle,
    reset,
    setModeAndDuration,
    getSnapshot,
  };
}
