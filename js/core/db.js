/**
 * StudyOS — Local-First IndexedDB repository & seed engine.
 *
 * Every public helper is async and resolves only after the underlying
 * IndexedDB transaction has committed, so callers can trust that a resolved
 * promise means the data is durable.
 *
 * Stores:
 *   subjects        keyPath 'id'
 *   tasks           keyPath 'id'   indexes: subjectId, completed, dueDate
 *   sessions        keyPath 'id'   indexes: date, subjectId
 *   scheduleBlocks  keyPath 'id'
 *
 * Note on the `completed` index: IndexedDB cannot use booleans as keys, so the
 * index named 'completed' is built on a numeric `completedFlag` (0 | 1) that
 * this module keeps in sync with the boolean `completed` field on every write.
 */

const DB_NAME = 'StudyOS_DB';
const DB_VERSION = 2;

export const STORES = Object.freeze({
  SUBJECTS: 'subjects',
  TASKS: 'tasks',
  SESSIONS: 'sessions',
  SCHEDULE_BLOCKS: 'scheduleBlocks',
  EVENTS: 'events',
});

export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const EVENT_TYPES = Object.freeze(['exam', 'assignment', 'lab', 'milestone']);

const DEFAULT_DURATION_MINUTES = 45;

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/* ==========================================================================
   Small utilities
   ========================================================================== */

/** Generates a unique id, e.g. `task-lq3x9k-a8f2c1`. */
export function generateId(prefix = 'id') {
  const random =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** Local-time `YYYY-MM-DD` key (never UTC, so "today" matches the user's clock). */
export function toDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function endOfDayISO(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, 0).toISOString();
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

export const SUBJECT_TONES = Object.freeze(['blue', 'green', 'amber', 'pink', 'violet', 'cyan']);

/* ==========================================================================
   Normalizers
   ========================================================================== */

function slugifySubjectCode(code) {
  return String(code ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSubject(input) {
  const code = String(input.code ?? '').trim().toUpperCase();
  const explicitId = input.id !== undefined && input.id !== null ? String(input.id).trim() : '';
  const id = explicitId || slugifySubjectCode(code);
  if (!id) throw new Error('A subject needs an id or a course code.');
  const tone = SUBJECT_TONES.includes(input.tone) ? input.tone : 'blue';
  return {
    ...input,
    id,
    code: code || id.toUpperCase(),
    name: String(input.name ?? '').trim(),
    tone,
    pinned: input.pinned ?? true,
  };
}

export function normalizeDueDateString(rawDueDate, fallbackDate = new Date()) {
  if (!rawDueDate) return toDateKey(fallbackDate);
  const value = String(rawDueDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? toDateKey(fallbackDate) : toDateKey(parsed);
}

export function formatDueLabelFromDate(dueDateStr, now = new Date()) {
  const normalized = normalizeDueDateString(dueDateStr, now);
  const todayKey = toDateKey(now);
  if (normalized === todayKey) return 'Due 11:59 PM';

  const tomorrowKey = toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (normalized === tomorrowKey) return 'Due Tomorrow';

  const [y, m, d] = normalized.split('-').map(Number);
  const dateObj = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(dateObj.getTime())) return 'Due 11:59 PM';

  return `Due ${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function normalizeTask(input) {
  const now = new Date();
  const completed = Boolean(input.completed);
  const duration = Math.round(Number(input.durationMinutes));
  const dueDate = normalizeDueDateString(input.dueDate ?? endOfDayISO(now), now);
  const explicitDueLabel = input.dueLabel !== undefined && input.dueLabel !== null ? String(input.dueLabel).trim() : '';

  return {
    ...input,
    id: input.id ?? generateId('task'),
    title: String(input.title ?? '').trim(),
    subjectId: input.subjectId || null,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION_MINUTES,
    dueDate,
    dueLabel: explicitDueLabel || formatDueLabelFromDate(dueDate, now),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'medium',
    notes: String(input.notes ?? '').trim(),
    completed,
    completedFlag: completed ? 1 : 0,
    completedAt: completed ? input.completedAt ?? now.toISOString() : null,
    createdAt: input.createdAt ?? now.toISOString(),
  };
}

function normalizeEvent(input = {}) {
  const now = new Date();
  const type = EVENT_TYPES.includes(input.type) ? input.type : 'exam';
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'medium';
  const date = normalizeDueDateString(input.date, now);

  return {
    ...input,
    id: input.id ?? generateId('event'),
    title: String(input.title ?? '').trim(),
    type,
    subjectId: input.subjectId || null,
    priority,
    date,
    timeLabel: String(input.timeLabel ?? '').trim() || '10:00 AM',
    location: String(input.location ?? '').trim(),
    notes: String(input.notes ?? '').trim(),
    createdAt: input.createdAt ?? now.toISOString(),
  };
}

/* ==========================================================================
   Open + seed
   ========================================================================== */

function ensureStoreAndIndexes(db, tx, storeName, indexes = []) {
  let store;
  if (!db.objectStoreNames.contains(storeName)) {
    store = db.createObjectStore(storeName, { keyPath: 'id' });
  } else if (tx) {
    store = tx.objectStore(storeName);
  }
  if (!store) return;

  for (const { name, keyPath, options } of indexes) {
    if (!store.indexNames.contains(name)) {
      try {
        store.createIndex(name, keyPath, options ?? { unique: false });
      } catch (err) {
        console.warn(`StudyOS: could not create index "${name}" on "${storeName}".`, err);
      }
    }
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      const err = new Error('IndexedDB is not available in this environment.');
      console.error('StudyOS: openDatabase failed —', err);
      reject(err);
      return;
    }

    let settled = false;
    let blockTimer = null;

    const clearBlockTimer = () => {
      if (blockTimer) {
        clearTimeout(blockTimer);
        blockTimer = null;
      }
    };

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.error('StudyOS: indexedDB.open threw synchronously —', err);
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = event.target?.transaction ?? request.transaction;

      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      ensureStoreAndIndexes(db, tx, STORES.SUBJECTS, []);
      ensureStoreAndIndexes(db, tx, STORES.TASKS, [
        { name: 'subjectId', keyPath: 'subjectId', options: { unique: false } },
        { name: 'completed', keyPath: 'completedFlag', options: { unique: false } },
        { name: 'dueDate', keyPath: 'dueDate', options: { unique: false } },
      ]);
      ensureStoreAndIndexes(db, tx, STORES.SESSIONS, [
        { name: 'date', keyPath: 'date', options: { unique: false } },
        { name: 'subjectId', keyPath: 'subjectId', options: { unique: false } },
      ]);
      ensureStoreAndIndexes(db, tx, STORES.SCHEDULE_BLOCKS, []);
      ensureStoreAndIndexes(db, tx, STORES.EVENTS, [
        { name: 'date', keyPath: 'date', options: { unique: false } },
        { name: 'subjectId', keyPath: 'subjectId', options: { unique: false } },
        { name: 'type', keyPath: 'type', options: { unique: false } },
      ]);
    };

    request.onblocked = () => {
      console.warn(
        'StudyOS: IndexedDB upgrade is blocked by another open connection. Waiting briefly...',
      );
      clearBlockTimer();
      blockTimer = setTimeout(() => {
        if (settled) return;
        // Fallback: open without explicit version so existing v1/v2 connection still works
        try {
          const fallbackReq = indexedDB.open(DB_NAME);
          fallbackReq.onsuccess = () => {
            if (settled) {
              fallbackReq.result.close();
              return;
            }
            settled = true;
            const db = fallbackReq.result;
            db.onversionchange = () => {
              db.close();
              dbPromise = null;
            };
            resolve(db);
          };
          fallbackReq.onerror = () => {
            if (settled) return;
            settled = true;
            console.error('StudyOS: fallback indexedDB.open failed —', fallbackReq.error);
            reject(fallbackReq.error || new Error('IndexedDB upgrade blocked.'));
          };
        } catch (fallbackErr) {
          if (settled) return;
          settled = true;
          console.error('StudyOS: fallback indexedDB.open threw —', fallbackErr);
          reject(fallbackErr);
        }
      }, 1200);
    };

    request.onsuccess = () => {
      clearBlockTimer();
      if (settled) return;
      settled = true;
      const db = request.result;
      // Let any future schema upgrade in another tab proceed instead of blocking it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      clearBlockTimer();
      if (settled) return;
      settled = true;
      console.error('StudyOS: IndexedDB open error —', request.error);
      reject(request.error);
    };
  });
}

/**
 * Checks each store (`subjects`, `tasks`, `sessions`, `events`, `scheduleBlocks`)
 * independently:
 * - Seeds missing stores.
 * - If all existing `sessions` are older than 7 days (e.g. from October) or empty,
 *   seeds fresh 7-day sample focus sessions relative to today.
 * - If existing `events` are empty or have past dates from October, rolls their
 *   dates forward relative to today (`+4d`, `+7d`, `+11d`).
 * - If seeded pending tasks have past due dates from October, refreshes their
 *   dueDate to today so the Dashboard and Calendar stay current.
 */
function seedIfEmpty(db) {
  return new Promise((resolve) => {
    const availableStores = Object.values(STORES).filter((name) =>
      db.objectStoreNames.contains(name),
    );
    if (availableStores.length === 0) {
      resolve();
      return;
    }

    let tx;
    try {
      tx = db.transaction(availableStores, 'readwrite');
    } catch (txErr) {
      console.error('StudyOS: could not open seedIfEmpty transaction —', txErr);
      resolve();
      return;
    }

    const now = new Date();
    const todayKey = toDateKey(now);
    const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const sevenDaysAgoKey = toDateKey(sevenDaysAgo);
    const seed = buildSeedData(now);

    if (availableStores.includes(STORES.SUBJECTS)) {
      const subjectStore = tx.objectStore(STORES.SUBJECTS);
      const countReq = subjectStore.count();
      countReq.onsuccess = () => {
        if (countReq.result === 0) {
          seed.subjects.forEach((row) => subjectStore.put(normalizeSubject(row)));
        }
      };
    }

    if (availableStores.includes(STORES.TASKS)) {
      const taskStore = tx.objectStore(STORES.TASKS);
      const getAllTasksReq = taskStore.getAll();
      getAllTasksReq.onsuccess = () => {
        const existingTasks = getAllTasksReq.result ?? [];
        if (existingTasks.length === 0) {
          seed.tasks.forEach((row) => taskStore.put(normalizeTask(row)));
          return;
        }
        // If all tasks are untouched seed tasks from a previous month (e.g. October), refresh their dates
        const allSeedTasksStale =
          existingTasks.every((t) => String(t.id || '').startsWith('task-seed-')) &&
          existingTasks.some((t) => !t.completed && String(t.dueDate || '') < todayKey);
        if (allSeedTasksStale) {
          seed.tasks.forEach((row) => {
            const prev = existingTasks.find((t) => t.id === row.id);
            taskStore.put(
              normalizeTask({
                ...row,
                completed: prev ? prev.completed : row.completed,
              }),
            );
          });
        }
      };
    }

    if (availableStores.includes(STORES.SESSIONS)) {
      const sessionStore = tx.objectStore(STORES.SESSIONS);
      const getAllSessionsReq = sessionStore.getAll();
      getAllSessionsReq.onsuccess = () => {
        const existingSessions = getAllSessionsReq.result ?? [];
        const hasRecentSession = existingSessions.some(
          (s) => s && typeof s.date === 'string' && s.date >= sevenDaysAgoKey && s.date <= todayKey,
        );
        if (existingSessions.length === 0 || !hasRecentSession) {
          // Remove old stale seed sessions so IDs don't collide, then insert fresh 7-day sessions
          for (const old of existingSessions) {
            if (String(old.id || '').startsWith('session-seed-')) {
              sessionStore.delete(old.id);
            }
          }
          seed.sessions.forEach((row) => sessionStore.put(row));
        }
      };
    }

    if (availableStores.includes(STORES.SCHEDULE_BLOCKS)) {
      const blockStore = tx.objectStore(STORES.SCHEDULE_BLOCKS);
      const getAllBlocksReq = blockStore.getAll();
      getAllBlocksReq.onsuccess = () => {
        const existingBlocks = getAllBlocksReq.result ?? [];
        if (existingBlocks.length === 0) {
          seed.scheduleBlocks.forEach((row) => blockStore.put(row));
        }
      };
    }

    if (availableStores.includes(STORES.EVENTS)) {
      const eventStore = tx.objectStore(STORES.EVENTS);
      const getAllEventsReq = eventStore.getAll();
      getAllEventsReq.onsuccess = () => {
        const existingEvents = getAllEventsReq.result ?? [];
        if (existingEvents.length === 0) {
          seed.events.forEach((row) => eventStore.put(normalizeEvent(row)));
          return;
        }
        // Roll forward any existing events whose dates fell in the past (e.g. October)
        const forwardOffsets = [4, 7, 11, 14];
        let staleIndex = 0;
        for (const ev of existingEvents) {
          const evDate = normalizeDueDateString(ev.date, now);
          if (evDate < todayKey) {
            const offset = forwardOffsets[staleIndex % forwardOffsets.length];
            staleIndex += 1;
            const rolledDate = toDateKey(
              new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset),
            );
            eventStore.put(normalizeEvent({ ...ev, date: rolledDate }));
          }
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error('StudyOS: seedIfEmpty transaction error —', tx.error);
      resolve(); // Resolve so app still boots with existing DB connection
    };
    tx.onabort = () => {
      console.error('StudyOS: seedIfEmpty transaction aborted —', tx.error);
      resolve();
    };
  });
}

/**
 * Opens the database (once) and seeds/refreshes it on startup.
 * Safe to call repeatedly — every caller shares the same promise.
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  if (!dbPromise) {
    dbPromise = openDatabase()
      .then(async (db) => {
        await seedIfEmpty(db);
        return db;
      })
      .catch((error) => {
        console.error('StudyOS: initDB failed —', error);
        dbPromise = null; // allow a retry after a failure
        throw error;
      });
  }
  return dbPromise;
}

/* ==========================================================================
   Generic store helpers
   ========================================================================== */

async function getAll(storeName) {
  const db = await initDB();
  return promisify(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

async function putOne(storeName, value) {
  const db = await initDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await transactionDone(tx);
  return value;
}

/* ==========================================================================
   Subjects
   ========================================================================== */

export async function getAllSubjects() {
  const subjects = await getAll(STORES.SUBJECTS);
  const rank = (subject) => (Number.isFinite(subject.order) ? subject.order : Number.MAX_SAFE_INTEGER);
  return subjects.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

export async function addSubject(subject) {
  const existing = await getAllSubjects();
  const existingIds = new Set(existing.map((item) => item.id));
  const maxOrder = existing.reduce(
    (max, item) => (Number.isFinite(item.order) ? Math.max(max, item.order) : max),
    -1,
  );

  const explicitId = subject?.id !== undefined && subject?.id !== null ? String(subject.id).trim() : '';
  let id = explicitId || slugifySubjectCode(subject?.code);
  if (!explicitId && id && existingIds.has(id)) {
    let suffix = 2;
    while (existingIds.has(`${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }

  const normalized = normalizeSubject({
    ...subject,
    id: id || generateId('subj'),
    order: Number.isFinite(subject?.order) ? subject.order : maxOrder + 1,
  });
  return putOne(STORES.SUBJECTS, normalized);
}

export async function updateSubject(subject) {
  if (!subject || !subject.id) throw new Error('updateSubject requires a subject with an id.');
  const db = await initDB();
  const current = await promisify(
    db.transaction(STORES.SUBJECTS, 'readonly').objectStore(STORES.SUBJECTS).get(subject.id),
  );
  const merged = normalizeSubject({
    ...(current ?? {}),
    ...subject,
    id: subject.id,
  });
  return putOne(STORES.SUBJECTS, merged);
}

/**
 * Deletes a subject and unassigns (or removes when `deleteTasks: true`) its tasks and events
 * within a single atomic IndexedDB transaction.
 */
export async function deleteSubject(subjectId, { deleteTasks = false } = {}) {
  const id = String(subjectId ?? '').trim();
  if (!id) return false;

  const db = await initDB();
  const tx = db.transaction([STORES.SUBJECTS, STORES.TASKS, STORES.EVENTS], 'readwrite');
  const subjectStore = tx.objectStore(STORES.SUBJECTS);
  const taskStore = tx.objectStore(STORES.TASKS);
  const eventStore = tx.objectStore(STORES.EVENTS);

  subjectStore.delete(id);

  const tasksRequest = taskStore.getAll();
  tasksRequest.onsuccess = () => {
    const tasks = tasksRequest.result ?? [];
    for (const task of tasks) {
      if (task.subjectId !== id) continue;
      if (deleteTasks) {
        taskStore.delete(task.id);
      } else {
        taskStore.put(normalizeTask({ ...task, subjectId: null }));
      }
    }
  };

  const eventsRequest = eventStore.getAll();
  eventsRequest.onsuccess = () => {
    const events = eventsRequest.result ?? [];
    for (const ev of events) {
      if (ev.subjectId !== id) continue;
      if (deleteTasks) {
        eventStore.delete(ev.id);
      } else {
        eventStore.put(normalizeEvent({ ...ev, subjectId: null }));
      }
    }
  };

  await transactionDone(tx);
  return true;
}

/* ==========================================================================
   Tasks
   ========================================================================== */

export async function getAllTasks() {
  const rows = await getAll(STORES.TASKS);
  return rows.map((row) => normalizeTask(row));
}

export async function getTaskById(id) {
  const db = await initDB();
  const task = await promisify(db.transaction(STORES.TASKS, 'readonly').objectStore(STORES.TASKS).get(id));
  return task ? normalizeTask(task) : null;
}

/** Inserts (or, when `id` already exists, replaces) a task and returns the saved record. */
export async function addTask(task) {
  return putOne(STORES.TASKS, normalizeTask(task));
}

export async function updateTask(task) {
  if (!task || !task.id) throw new Error('updateTask requires a task with an id.');
  const db = await initDB();
  const current = await promisify(
    db.transaction(STORES.TASKS, 'readonly').objectStore(STORES.TASKS).get(task.id),
  );
  const nextDueDate = task.dueDate ?? current?.dueDate;
  const dueDateChanged =
    current && task.dueDate !== undefined && normalizeDueDateString(task.dueDate) !== normalizeDueDateString(current.dueDate);
  const nextDueLabel =
    task.dueLabel !== undefined
      ? task.dueLabel
      : dueDateChanged
        ? formatDueLabelFromDate(nextDueDate)
        : current?.dueLabel;

  const merged = normalizeTask({
    ...(current ?? {}),
    ...task,
    id: task.id,
    dueDate: nextDueDate,
    dueLabel: nextDueLabel,
  });
  return putOne(STORES.TASKS, merged);
}

/**
 * Flips a task's completion state atomically (read + write in one transaction).
 * @returns {Promise<object | null>} the updated task, or null when the id is unknown.
 */
export async function toggleTaskCompletion(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.TASKS, 'readwrite');
    const store = tx.objectStore(STORES.TASKS);
    let result = null;

    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const existing = getRequest.result;
      if (!existing) return;
      result = normalizeTask({ ...existing, completed: !existing.completed, completedAt: null });
      store.put(result);
    };

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Toggle transaction aborted.'));
  });
}

export async function deleteTask(id) {
  const db = await initDB();
  const tx = db.transaction(STORES.TASKS, 'readwrite');
  tx.objectStore(STORES.TASKS).delete(id);
  await transactionDone(tx);
  return true;
}

/* ==========================================================================
   Sessions
   ========================================================================== */

export async function getAllSessions() {
  return getAll(STORES.SESSIONS);
}

export async function addSession(session = {}) {
  const now = new Date();
  const isoNow = now.toISOString();
  const durationMinutes = Math.max(1, Math.round(Number(session.durationMinutes) || 25));
  const timestamp = session.timestamp ?? session.startedAt ?? isoNow;
  const startedAt = session.startedAt ?? timestamp;
  const title = String(session.title ?? '').trim();

  return putOne(STORES.SESSIONS, {
    type: 'focus',
    ...session,
    id: session.id ?? generateId('session'),
    subjectId: session.subjectId || null,
    taskId: session.taskId || null,
    durationMinutes,
    date: session.date ?? toDateKey(now),
    timestamp,
    startedAt,
    title: title || 'Focus Session',
  });
}

export async function deleteSession(id) {
  const db = await initDB();
  const tx = db.transaction(STORES.SESSIONS, 'readwrite');
  tx.objectStore(STORES.SESSIONS).delete(id);
  await transactionDone(tx);
  return true;
}

/* ==========================================================================
   Academic Events & Milestones
   ========================================================================== */

export async function getAllEvents() {
  const rows = await getAll(STORES.EVENTS);
  return rows
    .map((row) => normalizeEvent(row))
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(a.timeLabel).localeCompare(String(b.timeLabel)) ||
        String(a.title).localeCompare(String(b.title)),
    );
}

export async function addEvent(event) {
  return putOne(STORES.EVENTS, normalizeEvent(event));
}

export async function updateEvent(event) {
  if (!event || !event.id) throw new Error('updateEvent requires an event with an id.');
  const db = await initDB();
  const current = await promisify(
    db.transaction(STORES.EVENTS, 'readonly').objectStore(STORES.EVENTS).get(event.id),
  );
  const merged = normalizeEvent({
    ...(current ?? {}),
    ...event,
    id: event.id,
  });
  return putOne(STORES.EVENTS, merged);
}

export async function deleteEvent(eventId) {
  const id = String(eventId ?? '').trim();
  if (!id) return false;
  const db = await initDB();
  const tx = db.transaction(STORES.EVENTS, 'readwrite');
  tx.objectStore(STORES.EVENTS).delete(id);
  await transactionDone(tx);
  return true;
}

/* ==========================================================================
   Schedule blocks
   ========================================================================== */

export async function getScheduleBlocks() {
  const blocks = await getAll(STORES.SCHEDULE_BLOCKS);
  return blocks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Replaces the whole schedule atomically; `order` follows array order. */
export async function saveScheduleBlocks(blocks) {
  const db = await initDB();
  const tx = db.transaction(STORES.SCHEDULE_BLOCKS, 'readwrite');
  const store = tx.objectStore(STORES.SCHEDULE_BLOCKS);
  const saved = blocks.map((block, index) => ({
    ...block,
    id: block.id ?? generateId('block'),
    order: index,
  }));

  store.clear();
  saved.forEach((block) => store.put(block));
  await transactionDone(tx);
  return saved;
}

/* ==========================================================================
   JSON Data Export & Import (Backup & Restore)
   ========================================================================== */

/**
 * Opens a read-only transaction across all active object stores (`subjects`,
 * `tasks`, `sessions`, `events`, and `scheduleBlocks`), fetches all records
 * from each store, and returns a structured backup object containing metadata
 * and data arrays.
 */
export async function exportDatabase() {
  const db = await initDB();
  const storeNames = [
    STORES.SUBJECTS,
    STORES.TASKS,
    STORES.SESSIONS,
    STORES.EVENTS,
    STORES.SCHEDULE_BLOCKS,
  ];
  const tx = db.transaction(storeNames, 'readonly');

  const [subjects, tasks, sessions, events, scheduleBlocks] = await Promise.all([
    promisify(tx.objectStore(STORES.SUBJECTS).getAll()),
    promisify(tx.objectStore(STORES.TASKS).getAll()),
    promisify(tx.objectStore(STORES.SESSIONS).getAll()),
    promisify(tx.objectStore(STORES.EVENTS).getAll()),
    promisify(tx.objectStore(STORES.SCHEDULE_BLOCKS).getAll()),
  ]);

  const rank = (subject) => (Number.isFinite(subject.order) ? subject.order : Number.MAX_SAFE_INTEGER);
  const sortedSubjects = [...subjects].sort(
    (a, b) => rank(a) - rank(b) || String(a.code || '').localeCompare(String(b.code || '')),
  );

  return {
    appName: 'StudyOS',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      subjects: sortedSubjects,
      tasks: tasks.map((row) => normalizeTask(row)),
      sessions,
      events: events.map((row) => normalizeEvent(row)),
      scheduleBlocks: [...scheduleBlocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    },
  };
}

/**
 * Parses a StudyOS backup JSON string (or object), validates that it contains
 * valid StudyOS data, opens a single atomic readwrite transaction across all
 * stores, clears old records, inserts the imported records, and returns a
 * summary of restored counts.
 */
export async function importDatabase(jsonInput) {
  let parsed;
  if (typeof jsonInput === 'string') {
    const trimmed = jsonInput.trim();
    if (!trimmed) {
      throw new Error('The selected backup file is empty.');
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON file. Please select a valid StudyOS .json backup.');
    }
  } else if (jsonInput && typeof jsonInput === 'object') {
    parsed = jsonInput;
  } else {
    throw new Error('Backup data must be a JSON string or object.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup payload must be a JSON object.');
  }

  // Support both `{ appName: "StudyOS", data: { subjects, tasks, ... } }` and top-level `{ subjects, tasks, ... }`
  const payload =
    parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data
      : parsed;

  const hasAppSignature = parsed.appName === 'StudyOS' || payload.appName === 'StudyOS';
  const hasKnownArrays =
    Array.isArray(payload.subjects) ||
    Array.isArray(payload.tasks) ||
    Array.isArray(payload.sessions) ||
    Array.isArray(payload.events);

  if (!hasAppSignature && !hasKnownArrays) {
    throw new Error(
      'Unrecognized backup format. Expected a StudyOS backup containing subjects, tasks, sessions, or events.',
    );
  }

  for (const key of ['subjects', 'tasks', 'sessions', 'events', 'scheduleBlocks']) {
    if (payload[key] !== undefined && !Array.isArray(payload[key])) {
      throw new Error(`Invalid backup structure: "${key}" must be an array.`);
    }
  }

  const rawSubjects = payload.subjects ?? [];
  const rawTasks = payload.tasks ?? [];
  const rawSessions = payload.sessions ?? [];
  const rawEvents = payload.events ?? [];
  const rawScheduleBlocks = payload.scheduleBlocks ?? [];

  const now = new Date();
  const isoNow = now.toISOString();

  const normalizedSubjects = rawSubjects.map((subj, index) =>
    normalizeSubject({
      ...subj,
      order: Number.isFinite(subj?.order) ? subj.order : index,
    }),
  );

  const normalizedTasks = rawTasks
    .filter((task) => task && typeof task === 'object' && String(task.title ?? '').trim())
    .map((task) => normalizeTask(task));

  const normalizedSessions = rawSessions
    .filter((session) => session && typeof session === 'object')
    .map((session) => {
      const durationMinutes = Math.max(1, Math.round(Number(session.durationMinutes) || 25));
      const timestamp = session.timestamp ?? session.startedAt ?? isoNow;
      return {
        type: 'focus',
        ...session,
        id: session.id ?? generateId('session'),
        subjectId: session.subjectId || null,
        taskId: session.taskId || null,
        durationMinutes,
        date: normalizeDueDateString(session.date, now),
        timestamp,
        startedAt: session.startedAt ?? timestamp,
        title: String(session.title ?? '').trim() || 'Focus Session',
      };
    });

  const normalizedEvents = rawEvents
    .filter((ev) => ev && typeof ev === 'object' && String(ev.title ?? '').trim())
    .map((ev) => normalizeEvent(ev));

  const normalizedBlocks = rawScheduleBlocks
    .filter((block) => block && typeof block === 'object')
    .map((block, index) => ({
      ...block,
      id: block.id ?? generateId('block'),
      order: Number.isFinite(block.order) ? block.order : index,
    }));

  const db = await initDB();
  const storeNames = [
    STORES.SUBJECTS,
    STORES.TASKS,
    STORES.SESSIONS,
    STORES.EVENTS,
    STORES.SCHEDULE_BLOCKS,
  ];
  const tx = db.transaction(storeNames, 'readwrite');

  const subjectStore = tx.objectStore(STORES.SUBJECTS);
  const taskStore = tx.objectStore(STORES.TASKS);
  const sessionStore = tx.objectStore(STORES.SESSIONS);
  const eventStore = tx.objectStore(STORES.EVENTS);
  const blockStore = tx.objectStore(STORES.SCHEDULE_BLOCKS);

  subjectStore.clear();
  taskStore.clear();
  sessionStore.clear();
  eventStore.clear();
  blockStore.clear();

  normalizedSubjects.forEach((row) => subjectStore.put(row));
  normalizedTasks.forEach((row) => taskStore.put(row));
  normalizedSessions.forEach((row) => sessionStore.put(row));
  normalizedEvents.forEach((row) => eventStore.put(row));
  normalizedBlocks.forEach((row) => blockStore.put(row));

  await transactionDone(tx);

  return {
    success: true,
    counts: {
      subjects: normalizedSubjects.length,
      tasks: normalizedTasks.length,
      sessions: normalizedSessions.length,
      events: normalizedEvents.length,
      scheduleBlocks: normalizedBlocks.length,
    },
  };
}

/**
 * Clears all object stores and re-seeds fresh demo data with dates relative to today.
 */
export async function resetDemoDatabase() {
  const db = await initDB();
  const availableStores = Object.values(STORES).filter((name) =>
    db.objectStoreNames.contains(name),
  );
  const tx = db.transaction(availableStores, 'readwrite');
  const seed = buildSeedData(new Date());

  for (const storeName of availableStores) {
    tx.objectStore(storeName).clear();
  }

  if (availableStores.includes(STORES.SUBJECTS)) {
    seed.subjects.forEach((row) => tx.objectStore(STORES.SUBJECTS).put(normalizeSubject(row)));
  }
  if (availableStores.includes(STORES.TASKS)) {
    seed.tasks.forEach((row) => tx.objectStore(STORES.TASKS).put(normalizeTask(row)));
  }
  if (availableStores.includes(STORES.SESSIONS)) {
    seed.sessions.forEach((row) => tx.objectStore(STORES.SESSIONS).put(row));
  }
  if (availableStores.includes(STORES.SCHEDULE_BLOCKS)) {
    seed.scheduleBlocks.forEach((row) => tx.objectStore(STORES.SCHEDULE_BLOCKS).put(row));
  }
  if (availableStores.includes(STORES.EVENTS)) {
    seed.events.forEach((row) => tx.objectStore(STORES.EVENTS).put(normalizeEvent(row)));
  }

  await transactionDone(tx);
  return {
    success: true,
    counts: {
      subjects: seed.subjects.length,
      tasks: seed.tasks.length,
      sessions: seed.sessions.length,
      events: seed.events.length,
      scheduleBlocks: seed.scheduleBlocks.length,
    },
  };
}

/* ==========================================================================
   Seed data (first run only)
   ========================================================================== */

function buildSeedData(now) {
  const at = (dayOffset, hours, minutes) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes, 0, 0);

  // "Due Fri 9:00 AM" -> the next upcoming Friday.
  const daysUntilFriday = ((5 - now.getDay() + 7) % 7) || 7;

  const subjects = [
    { id: 'cs-301', code: 'CS-301', name: 'Algorithms', tone: 'blue', pinned: true, order: 0 },
    { id: 'math-204', code: 'MATH-204', name: 'Linear Algebra', tone: 'green', pinned: true, order: 1 },
    { id: 'phys-102', code: 'PHYS-102', name: 'Electromagnetism', tone: 'amber', pinned: true, order: 2 },
    { id: 'hum-110', code: 'HUM-110', name: 'Ethics', tone: 'pink', pinned: true, order: 3 },
  ];

  // 2 pending + 4 completed  =>  4 of 6 (67%).
  const taskRows = [
    { title: 'Finish dynamic programming problem set (Q4–Q7)', subjectId: 'cs-301', durationMinutes: 90, dueLabel: 'Due 11:59 PM', due: at(0, 23, 59), priority: 'high', completed: false },
    { title: 'Review eigenvalue decomposition lecture notes', subjectId: 'math-204', durationMinutes: 45, dueLabel: 'Due 6:00 PM', due: at(0, 18, 0), priority: 'medium', completed: false },
    { title: "Draft lab report: Faraday's law induction", subjectId: 'phys-102', durationMinutes: 60, dueLabel: 'Due Fri 9:00 AM', due: at(daysUntilFriday, 9, 0), priority: 'high', completed: true },
    { title: "Read Kant's Groundwork, Section II", subjectId: 'hum-110', durationMinutes: 40, dueLabel: 'Due 10:00 PM', due: at(0, 22, 0), priority: 'low', completed: true },
    { title: 'Implement Dijkstra with binary heap for practice', subjectId: 'cs-301', durationMinutes: 50, dueLabel: 'Due 8:00 PM', due: at(0, 20, 0), priority: 'medium', completed: true },
    { title: 'Verify orthogonality proofs for Homework 4', subjectId: 'math-204', durationMinutes: 35, dueLabel: 'Due 5:00 PM', due: at(0, 17, 0), priority: 'low', completed: true },
  ];

  // Newest-first ordering by createdAt keeps the list in the order written above.
  const tasks = taskRows.map(({ due, ...row }, index) => ({
    ...row,
    id: `task-seed-${index + 1}`,
    dueDate: due.toISOString(),
    createdAt: new Date(now.getTime() - index * 1000).toISOString(),
    completedAt: row.completed ? new Date(now.getTime() - (index + 1) * 600000).toISOString() : null,
  }));

  // Focus sessions across the last 7 days (today = 135 min / 2h 15m) so both the
  // Dashboard Weekly Activity chart and Analytics 7-day trend display rich bars immediately.
  const sessionPlan = [
    {
      dayOffset: -6,
      items: [
        ['cs-301', 60, 'Divide & Conquer Recurrence Relations'],
        ['math-204', 45, 'Vector Subspace Basis Proofs'],
      ],
    }, // 105 min (1.8h)
    {
      dayOffset: -5,
      items: [
        ['phys-102', 50, 'Gauss Law Flux Integrals'],
        ['hum-110', 40, 'Utilitarianism vs Deontology Reading'],
      ],
    }, // 90 min (1.5h)
    {
      dayOffset: -4,
      items: [
        ['cs-301', 75, 'Graph Traversal & Topological Sort'],
        ['math-204', 50, 'Rank-Nullity Theorem Problem Set'],
      ],
    }, // 125 min (2.1h)
    {
      dayOffset: -3,
      items: [
        ['cs-301', 90, 'Dynamic Programming Memoization Tables'],
        ['math-204', 60, 'Eigenvalues & Characteristic Polynomials'],
        ['hum-110', 60, "Kant's Categorical Imperative Seminar Prep"],
      ],
    }, // 210 min (3.5h)
    {
      dayOffset: -2,
      items: [
        ['phys-102', 60, 'Magnetic Field & Biot-Savart Law'],
        ['cs-301', 90, 'Shortest Paths & Dijkstra Heap Implementation'],
      ],
    }, // 150 min (2.5h)
    {
      dayOffset: -1,
      items: [
        ['math-204', 90, 'Orthogonality & Gram-Schmidt Process'],
        ['phys-102', 45, "Faraday's Law Lab Data Analysis"],
        ['hum-110', 45, 'Groundwork Section II Annotations'],
      ],
    }, // 180 min (3.0h)
    {
      dayOffset: 0,
      items: [
        ['cs-301', 50, 'DP Problem Set Q4–Q7 Deep Work'],
        ['math-204', 45, 'Eigenvalue Decomposition Lecture Review'],
        ['phys-102', 40, 'Electromagnetic Induction Lab Draft'],
      ],
    }, // 135 min (2h 15m)
  ];

  const sessions = sessionPlan.flatMap(({ dayOffset, items }) =>
    items.map(([subjectId, durationMinutes, title], index) => {
      const startObj = at(dayOffset, 9 + index * 3, 0);
      return {
        id: `session-seed-${dayOffset + 6}-${index + 1}`,
        type: 'focus',
        mode: durationMinutes >= 50 ? 'deep' : 'pomodoro',
        title,
        date: toDateKey(at(dayOffset, 0, 0)),
        subjectId,
        taskId: null,
        durationMinutes,
        startedAt: startObj.toISOString(),
        timestamp: startObj.toISOString(),
        completedAt: startObj.getTime() + durationMinutes * 60_000,
      };
    }),
  );

  const todayKey = toDateKey(now);
  const blockBase = { date: todayKey, dayOffset: 0 };

  const scheduleBlocks = [
    {
      ...blockBase, id: 'block-seed-1', order: 0, timeRange: '09:00 - 10:30', startMinutes: 540, endMinutes: 630, durationMinutes: 90,
      title: 'Algorithm Problem Set', taskId: null, subjectId: 'cs-301', subjectName: 'Algorithms', subjectCode: 'CS-301', tone: 'blue',
      status: 'completed', reason: 'Example block from the starter plan',
    },
    {
      ...blockBase, id: 'block-seed-2', order: 1, timeRange: '14:00 - 15:00', startMinutes: 840, endMinutes: 900, durationMinutes: 60,
      title: 'Linear Algebra Review', taskId: null, subjectId: 'math-204', subjectName: 'Linear Algebra', subjectCode: 'MATH-204', tone: 'green',
      status: 'completed', reason: 'Example block from the starter plan',
    },
    {
      ...blockBase, id: 'block-seed-3', order: 2, timeRange: '19:30 - 21:00', startMinutes: 1170, endMinutes: 1260, durationMinutes: 90,
      title: 'DP Deep Work — Q4 to Q7', taskId: 'task-seed-1', subjectId: 'cs-301', subjectName: 'Algorithms', subjectCode: 'CS-301', tone: 'blue',
      status: 'up-next', reason: 'Example block from the starter plan',
    },
  ];

  // 3 initial academic milestones (4d, 7d, 11d from today)
  const events = [
    {
      id: 'event-seed-1',
      title: 'CS-301 Midterm Exam',
      type: 'exam',
      subjectId: 'cs-301',
      priority: 'high',
      date: toDateKey(at(4, 10, 0)),
      timeLabel: '10:00 AM',
      location: 'Hall B',
      notes: 'Covers asymptotic analysis, divide-and-conquer, and dynamic programming.',
    },
    {
      id: 'event-seed-2',
      title: 'Problem Set 5: Vector Spaces',
      type: 'assignment',
      subjectId: 'math-204',
      priority: 'medium',
      date: toDateKey(at(7, 23, 59)),
      timeLabel: '11:59 PM',
      location: 'Canvas Upload',
      notes: 'Basis, dimension, rank-nullity theorem proofs.',
    },
    {
      id: 'event-seed-3',
      title: "Faraday's Law Lab Submission",
      type: 'lab',
      subjectId: 'phys-102',
      priority: 'medium',
      date: toDateKey(at(11, 17, 0)),
      timeLabel: '5:00 PM',
      location: 'Physics Lab 204',
      notes: 'Include oscilloscope plots and error propagation analysis.',
    },
  ];

  return { subjects, tasks, sessions, scheduleBlocks, events };
}
