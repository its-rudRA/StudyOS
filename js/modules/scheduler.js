/**
 * StudyOS — Rule-based smart scheduler.
 *
 * This is NOT machine learning. It is a small, deterministic set of rules, and
 * every block it produces carries a `reason` string explaining why it is where
 * it is. The same inputs (tasks, subjects, `now`) always give the same plan.
 *
 * Rules, in order:
 *   1. Score each pending task chunk:
 *        priority weight   high 30 / medium 20 / low 10
 *      + deadline urgency  overdue +15, due within 6h +10, within 24h +5
 *      + duration fit      +5 when the chunk fits the ideal 45–90 minute window
 *   2. Split tasks longer than 90 minutes into even, focused chunks (<= 90m).
 *   3. Walk the chunks from highest score to lowest, but if the next chunk would
 *      follow a heavy (>= 60m) block of the same subject, pull forward the
 *      highest-scored chunk of a different subject instead (when one exists).
 *   4. Lay chunks out from the next half-hour, with a short break between
 *      blocks, inside an 08:00–23:00 study window. Anything that does not fit
 *      today rolls over to tomorrow at 09:00.
 *
 * The module is pure: it never touches the DOM or storage.
 */

export const SCHEDULER_CONFIG = Object.freeze({
  priorityWeight: Object.freeze({ high: 30, medium: 20, low: 10 }),
  urgencyBonus: Object.freeze({ overdue: 15, within6h: 10, within24h: 5 }),
  fitBonus: 5,
  idealMinBlockMinutes: 45,
  maxBlockMinutes: 90,
  heavyBlockMinutes: 60,
  minBlockMinutes: 15,
  breakMinutes: 15,
  dayStartMinutes: 8 * 60,
  dayEndMinutes: 23 * 60,
  nextDayStartMinutes: 9 * 60,
  synthesisMinutes: 45,
});

const MINUTES_PER_DAY = 1440;
const FALLBACK_SUBJECT = Object.freeze({ id: 'general', code: 'GEN', name: 'General', tone: 'muted' });

/* ==========================================================================
   Helpers
   ========================================================================== */

function formatClock(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function roundUpToFive(value) {
  return Math.ceil(value / 5) * 5;
}

/** Splits `total` minutes into the fewest even chunks that are each <= maxBlockMinutes. */
function splitDuration(total) {
  const { maxBlockMinutes } = SCHEDULER_CONFIG;
  if (total <= maxBlockMinutes) return [total];

  const parts = Math.ceil(total / maxBlockMinutes);
  const base = roundUpToFive(total / parts);
  const chunks = [];
  let remaining = total;

  for (let i = 0; i < parts; i += 1) {
    const length = i === parts - 1 ? remaining : Math.min(base, remaining);
    chunks.push(length);
    remaining -= length;
  }
  return chunks.filter((length) => length > 0);
}

/** Returns { bonus, label } describing how close a task's deadline is. */
function deadlineUrgency(task, now) {
  const due = task.dueDate ? new Date(task.dueDate).getTime() : NaN;
  if (Number.isNaN(due)) return { bonus: 0, label: null };

  const hoursLeft = (due - now.getTime()) / 3_600_000;
  const { overdue, within6h, within24h } = SCHEDULER_CONFIG.urgencyBonus;

  if (hoursLeft < 0) return { bonus: overdue, label: 'overdue' };
  if (hoursLeft <= 6) return { bonus: within6h, label: 'due within 6h' };
  if (hoursLeft <= 24) return { bonus: within24h, label: 'due within 24h' };
  return { bonus: 0, label: null };
}

function compareUnits(a, b) {
  return (
    b.score - a.score ||
    String(a.task.dueDate ?? '').localeCompare(String(b.task.dueDate ?? '')) ||
    String(a.task.id).localeCompare(String(b.task.id)) ||
    a.part - b.part
  );
}

/** Turns pending tasks into scored, ordered-by-score chunks. */
function buildUnits(pendingTasks, subjectMap, now) {
  const { priorityWeight, fitBonus, idealMinBlockMinutes, maxBlockMinutes, minBlockMinutes } = SCHEDULER_CONFIG;
  const units = [];

  for (const task of pendingTasks) {
    const subject = subjectMap.get(task.subjectId) ?? FALLBACK_SUBJECT;
    const priority = priorityWeight[task.priority] ? task.priority : 'medium';
    const urgency = deadlineUrgency(task, now);
    const total = Math.max(minBlockMinutes, Math.round(Number(task.durationMinutes)) || 45);
    const chunks = splitDuration(total);

    chunks.forEach((minutes, index) => {
      const fits = minutes >= idealMinBlockMinutes && minutes <= maxBlockMinutes;
      const reasons = [`${capitalize(priority)} priority`];
      if (urgency.label) reasons.push(urgency.label);
      if (chunks.length > 1) reasons.push(`part ${index + 1} of ${chunks.length} (task split into <=${maxBlockMinutes}m blocks)`);

      units.push({
        task,
        subject,
        part: index,
        parts: chunks.length,
        minutes,
        score: priorityWeight[priority] + urgency.bonus + (fits ? fitBonus : 0),
        reasons,
      });
    });
  }

  return units.sort(compareUnits);
}

/** Applies the subject-balance rule to the score-ordered chunks. */
function orderWithSubjectBalance(units) {
  const { heavyBlockMinutes } = SCHEDULER_CONFIG;
  const queue = [...units];
  const ordered = [];

  while (queue.length > 0) {
    let pickIndex = 0;
    const previous = ordered[ordered.length - 1];
    const candidate = queue[0];

    if (
      previous &&
      previous.minutes >= heavyBlockMinutes &&
      candidate.minutes >= heavyBlockMinutes &&
      candidate.subject.id === previous.subject.id
    ) {
      const alternative = queue.findIndex((unit) => unit.subject.id !== previous.subject.id);
      if (alternative !== -1) {
        pickIndex = alternative;
        queue[alternative].reasons.push('moved up to avoid back-to-back heavy blocks of one subject');
      }
    }

    ordered.push(queue.splice(pickIndex, 1)[0]);
  }

  return ordered;
}

function firstStartMinute(now) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return Math.ceil(nowMinutes / 30) * 30;
}

/**
 * Finds where a block of `length` minutes can start, given a cursor expressed as
 * minutes since today 00:00 (so values >= 1440 are tomorrow and beyond).
 */
function placeBlock(cursor, length) {
  const { dayStartMinutes, dayEndMinutes, nextDayStartMinutes } = SCHEDULER_CONFIG;
  let start = cursor;
  const minuteOfDay = start % MINUTES_PER_DAY;

  if (minuteOfDay < dayStartMinutes) start += dayStartMinutes - minuteOfDay;

  if ((start % MINUTES_PER_DAY) + length > dayEndMinutes) {
    start = (Math.floor(start / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY + nextDayStartMinutes;
  }
  return start;
}

function toBlock({ start, length, title, subject, task, status, reason }) {
  const dayOffset = Math.floor(start / MINUTES_PER_DAY);
  const startMinutes = start % MINUTES_PER_DAY;
  const endMinutes = startMinutes + length;

  return {
    timeRange: `${formatClock(startMinutes)} - ${formatClock(endMinutes)}`,
    startMinutes,
    endMinutes,
    dayOffset,
    durationMinutes: length,
    title,
    taskId: task ? task.id : null,
    subjectId: subject.id,
    subjectName: subject.name,
    subjectCode: subject.code,
    tone: subject.tone ?? 'muted',
    status,
    reason,
  };
}

/* ==========================================================================
   Public API
   ========================================================================== */

/**
 * Builds today's plan from the pending tasks.
 *
 * @param {Array<object>} tasks     all tasks (completed ones are ignored)
 * @param {Array<object>} subjects  all subjects
 * @param {{ now?: Date, existingBlocks?: Array<object> }} [options]
 *        `existingBlocks`: blocks already marked 'completed' are kept at the top
 *        of the result as history; every other block is re-planned.
 * @returns {Array<object>} time blocks with status 'completed' | 'up-next' | 'planned'
 */
export function generateSmartSchedule(tasks, subjects, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const subjectMap = new Map((subjects ?? []).map((subject) => [subject.id, subject]));
  const config = SCHEDULER_CONFIG;

  const history = (options.existingBlocks ?? [])
    .filter((block) => block.status === 'completed')
    .sort((a, b) => (a.dayOffset ?? 0) - (b.dayOffset ?? 0) || a.startMinutes - b.startMinutes)
    .map((block) => ({ ...block, status: 'completed' }));

  const pending = (tasks ?? []).filter((task) => !task.completed);
  const planned = [];
  let cursor = firstStartMinute(now);

  if (pending.length > 0) {
    const ordered = orderWithSubjectBalance(buildUnits(pending, subjectMap, now));

    ordered.forEach((unit) => {
      const start = placeBlock(cursor, unit.minutes);
      cursor = start + unit.minutes + config.breakMinutes;

      const title = unit.parts > 1 ? `${unit.task.title} (${unit.part + 1}/${unit.parts})` : unit.task.title;
      planned.push(
        toBlock({
          start,
          length: unit.minutes,
          title,
          subject: unit.subject,
          task: unit.task,
          status: 'planned',
          reason: unit.reasons.join(' · '),
        }),
      );
    });
  } else {
    // Everything is done: offer a restorative review block instead of an empty plan.
    const lastCompleted = [...(tasks ?? [])]
      .filter((task) => task.completed)
      .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')))[0];
    const subject =
      (lastCompleted && subjectMap.get(lastCompleted.subjectId)) || (subjects ?? [])[0] || FALLBACK_SUBJECT;

    const start = placeBlock(cursor, config.synthesisMinutes);
    planned.push(
      toBlock({
        start,
        length: config.synthesisMinutes,
        title: 'Review & Practice Synthesis',
        subject,
        task: null,
        status: 'planned',
        reason: 'All tasks are complete — consolidate with active recall and a few practice problems',
      }),
    );
  }

  if (planned.length > 0) planned[0].status = 'up-next';

  return [...history, ...planned].map((block, index) => ({ ...block, id: `block-${index + 1}` }));
}
