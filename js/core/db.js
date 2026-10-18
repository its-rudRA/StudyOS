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
const DB_VERSION = 1;

export const STORES = Object.freeze({
  SUBJECTS: 'subjects',
  TASKS: 'tasks',
  SESSIONS: 'sessions',
  SCHEDULE_BLOCKS: 'scheduleBlocks',
});

export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);

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

/* ==========================================================================
   Open + seed
   ========================================================================== */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.SUBJECTS)) {
        db.createObjectStore(STORES.SUBJECTS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.TASKS)) {
        const tasks = db.createObjectStore(STORES.TASKS, { keyPath: 'id' });
        tasks.createIndex('subjectId', 'subjectId', { unique: false });
        tasks.createIndex('completed', 'completedFlag', { unique: false });
        tasks.createIndex('dueDate', 'dueDate', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        const sessions = db.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
        sessions.createIndex('date', 'date', { unique: false });
        sessions.createIndex('subjectId', 'subjectId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SCHEDULE_BLOCKS)) {
        db.createObjectStore(STORES.SCHEDULE_BLOCKS, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Let a future schema upgrade in another tab proceed instead of blocking it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Seeds demo data in ONE transaction, and only if `subjects` is empty.
 * All seed ids are fixed, so even two tabs racing here cannot duplicate rows.
 */
function seedIfEmpty(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Object.values(STORES), 'readwrite');
    const countRequest = tx.objectStore(STORES.SUBJECTS).count();

    countRequest.onsuccess = () => {
      if (countRequest.result > 0) return;

      const seed = buildSeedData(new Date());
      seed.subjects.forEach((row) => tx.objectStore(STORES.SUBJECTS).put(normalizeSubject(row)));
      seed.tasks.forEach((row) => tx.objectStore(STORES.TASKS).put(normalizeTask(row)));
      seed.sessions.forEach((row) => tx.objectStore(STORES.SESSIONS).put(row));
      seed.scheduleBlocks.forEach((row) => tx.objectStore(STORES.SCHEDULE_BLOCKS).put(row));
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Seeding transaction aborted.'));
  });
}

/**
 * Opens the database (once) and seeds it on first run.
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
 * Deletes a subject and unassigns (or removes when `deleteTasks: true`) its tasks
 * within a single atomic IndexedDB transaction.
 */
export async function deleteSubject(subjectId, { deleteTasks = false } = {}) {
  const id = String(subjectId ?? '').trim();
  if (!id) return false;

  const db = await initDB();
  const tx = db.transaction([STORES.SUBJECTS, STORES.TASKS], 'readwrite');
  const subjectStore = tx.objectStore(STORES.SUBJECTS);
  const taskStore = tx.objectStore(STORES.TASKS);

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

export async function addSession(session) {
  const now = new Date();
  return putOne(STORES.SESSIONS, {
    type: 'focus',
    taskId: null,
    startedAt: now.toISOString(),
    ...session,
    id: session.id ?? generateId('session'),
    date: session.date ?? toDateKey(now),
  });
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

  // Focus sessions: today = 135 min (2h 15m). The three earlier days follow the
  // dashboard's chart (3.5h, 2.5h, 3.0h); later days are plan, not history.
  const sessionPlan = [
    { dayOffset: -3, items: [['cs-301', 90], ['math-204', 60], ['hum-110', 60]] }, // 210 min
    { dayOffset: -2, items: [['phys-102', 60], ['cs-301', 90]] },                  // 150 min
    { dayOffset: -1, items: [['math-204', 90], ['phys-102', 45], ['hum-110', 45]] }, // 180 min
    { dayOffset: 0, items: [['cs-301', 50], ['math-204', 45], ['phys-102', 40]] },   // 135 min
  ];

  const sessions = sessionPlan.flatMap(({ dayOffset, items }) =>
    items.map(([subjectId, durationMinutes], index) => ({
      id: `session-seed-${dayOffset + 3}-${index + 1}`,
      type: 'focus',
      date: toDateKey(at(dayOffset, 0, 0)),
      subjectId,
      taskId: null,
      durationMinutes,
      startedAt: at(dayOffset, 9 + index * 3, 0).toISOString(),
    })),
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

  return { subjects, tasks, sessions, scheduleBlocks };
}
