/**
 * StudyOS — main application controller.
 *
 * Loads data from IndexedDB, renders the dashboard, and wires every control.
 * The DOM is the *view*; `state` (below) is the single source of truth and
 * IndexedDB is the durable copy. User-supplied text is only ever written with
 * `textContent`, never `innerHTML`.
 */

import {
  initDB,
  getAllSubjects,
  getAllTasks,
  addTask,
  toggleTaskCompletion,
  deleteTask,
  getAllSessions,
  getScheduleBlocks,
  saveScheduleBlocks,
  toDateKey,
} from './core/db.js';
import { generateSmartSchedule } from './modules/scheduler.js';

/* ==========================================================================
   Configuration
   ========================================================================== */

const CONFIG = Object.freeze({
  userName: 'Rudra',
  // Monday of week 1. Change this once per semester.
  semesterStart: new Date(2026, 7, 31),
  dailyFocusGoalMinutes: 240,
  defaultSubjectCode: 'CS-301',
  defaultPriority: 'medium',
  defaultDurationMinutes: 45,
  minDurationMinutes: 5,
  maxDurationMinutes: 600,
  listRefreshDelayMs: 320,
});

const PRIORITY_META = Object.freeze({
  high: { label: 'High', badge: 'priority-badge--high' },
  medium: { label: 'Medium', badge: 'priority-badge--med' },
  low: { label: 'Low', badge: 'priority-badge--low' },
});

const ICON_CHECK =
  '<svg class="block-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-label="Completed" role="img"><path d="M20 6 9 17l-5-5"/></svg>';

/* ==========================================================================
   State
   ========================================================================== */

const state = {
  subjects: [],
  tasks: [],
  sessions: [],
  blocks: [],
  filter: 'all', // 'all' | 'pending' | 'completed'
  subjectId: null, // sidebar subject filter
};

/** Cached DOM references, filled by cacheElements(). */
const refs = {};

let listRefreshTimer = null;
let autoPlanBusy = false;
let quickAddBusy = false;

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
ready.catch(() => {}); // callers handle errors; avoid an "unhandled rejection" log

/* ==========================================================================
   Small helpers
   ========================================================================== */

function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 45 -> "45m", 90 -> "1h 30m", 120 -> "2h 00m" (matches the dashboard's style). */
function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function getSubject(id) {
  return state.subjects.find((subject) => subject.id === id) ?? null;
}

/** Resolves "cs-301", "CS301", or an id to a known subject id (or null). */
function resolveSubjectId(value) {
  if (!value) return null;
  const needle = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = state.subjects.find(
    (subject) =>
      subject.id.toLowerCase().replace(/[^a-z0-9]/g, '') === needle ||
      subject.code.toLowerCase().replace(/[^a-z0-9]/g, '') === needle,
  );
  return match ? match.id : null;
}

function defaultSubjectId() {
  return state.subjectId ?? resolveSubjectId(CONFIG.defaultSubjectCode) ?? state.subjects[0]?.id ?? null;
}

function clampDuration(minutes) {
  return Math.min(CONFIG.maxDurationMinutes, Math.max(CONFIG.minDurationMinutes, Math.round(minutes)));
}

/* ==========================================================================
   Toasts
   ========================================================================== */

function ensureToastRegion() {
  if (!refs.toastRegion) {
    refs.toastRegion = createEl('div', 'toast-region');
    refs.toastRegion.setAttribute('role', 'status');
    refs.toastRegion.setAttribute('aria-live', 'polite');
    document.body.append(refs.toastRegion);
  }
  return refs.toastRegion;
}

/**
 * Shows a small transient message. Optionally includes one action button
 * (used for "Undo").
 */
function showToast(message, { actionLabel, onAction, duration = 3200, tone = 'default' } = {}) {
  const region = ensureToastRegion();
  const toast = createEl('div', `toast${tone === 'error' ? ' toast--error' : ''}`);
  toast.append(createEl('span', 'toast-message', message));

  let dismissTimer = null;
  const dismiss = () => {
    clearTimeout(dismissTimer);
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
  };

  if (actionLabel && onAction) {
    const action = createEl('button', 'toast-action', actionLabel);
    action.type = 'button';
    action.addEventListener('click', () => {
      dismiss();
      onAction();
    });
    toast.append(action);
  }

  region.append(toast);
  while (region.children.length > 3) region.firstElementChild.remove();
  dismissTimer = setTimeout(dismiss, duration);
}

/* ==========================================================================
   Header (greeting + date)
   ========================================================================== */

function getSemesterWeek(now) {
  const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(CONFIG.semesterStart)) / 86_400_000);
  return days < 0 ? 0 : Math.floor(days / 7) + 1;
}

function renderHeader() {
  const now = new Date();
  const hour = now.getHours();
  const period = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  refs.greeting.textContent = `Good ${period}, ${CONFIG.userName}`;

  const dateText = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const week = getSemesterWeek(now);
  refs.dateDisplay.textContent = `${dateText} • ${week >= 1 ? `Week ${week} of Semester` : 'Semester starts soon'}`;
}

/* ==========================================================================
   Metrics, badges, filter counts
   ========================================================================== */

function renderMetrics() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.completed).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  refs.tasksDone.textContent = String(done);
  refs.tasksTotal.textContent = String(total);
  refs.tasksBar.style.width = `${pct}%`;
  refs.tasksBar.parentElement.setAttribute('aria-valuenow', String(pct));
  refs.tasksPct.textContent = `${pct}%`;

  refs.badgeTasks.textContent = String(total - done);
  refs.badgeSubjects.textContent = String(state.subjects.length);

  const todayKey = toDateKey(new Date());
  const focusMinutes = state.sessions
    .filter((session) => session.date === todayKey)
    .reduce((sum, session) => sum + (Number(session.durationMinutes) || 0), 0);
  const focusPct = Math.min(100, Math.round((focusMinutes / CONFIG.dailyFocusGoalMinutes) * 100));

  refs.focusLogged.textContent = formatDuration(focusMinutes);
  refs.focusBar.style.width = `${focusPct}%`;
  refs.focusBar.parentElement.setAttribute('aria-valuenow', String(focusPct));
  refs.focusGoal.textContent = `${formatDuration(CONFIG.dailyFocusGoalMinutes)} Goal`;
}

/** Tasks narrowed by the sidebar subject filter only (what the filter tabs count). */
function getScopedTasks() {
  return state.subjectId ? state.tasks.filter((task) => task.subjectId === state.subjectId) : state.tasks;
}

function matchesFilters(task) {
  if (state.subjectId && task.subjectId !== state.subjectId) return false;
  if (state.filter === 'pending') return !task.completed;
  if (state.filter === 'completed') return task.completed;
  return true;
}

function renderCounts() {
  const scoped = getScopedTasks();
  const done = scoped.filter((task) => task.completed).length;
  const counts = { all: scoped.length, pending: scoped.length - done, completed: done };

  refs.filterButtons.forEach((button) => {
    const count = button.querySelector('.count');
    if (count) count.textContent = String(counts[button.dataset.filter] ?? 0);
  });
}

function renderFilterTabs() {
  refs.filterButtons.forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

/* ==========================================================================
   Sidebar: pinned subjects
   ========================================================================== */

function renderSubjects() {
  const items = state.subjects
    .filter((subject) => subject.pinned)
    .map((subject) => {
      const li = document.createElement('li');
      const button = createEl('button', `subject-item subject-item--${subject.tone}`);
      button.type = 'button';
      button.dataset.subjectId = subject.id;
      button.append(
        createEl('span', 'subject-dot'),
        createEl('span', 'subject-code', subject.code),
        createEl('span', 'subject-name', subject.name),
      );
      button.firstElementChild.setAttribute('aria-hidden', 'true');
      li.append(button);
      return li;
    });

  refs.subjectList.replaceChildren(...items);
  renderSubjectSelection();
}

function renderSubjectSelection() {
  refs.subjectList.querySelectorAll('.subject-item').forEach((button) => {
    const selected = button.dataset.subjectId === state.subjectId;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function setSubjectFilter(subjectId) {
  state.subjectId = state.subjectId === subjectId ? null : subjectId; // second click clears
  renderSubjectSelection();
  renderCounts();
  renderTaskList();
}

/* ==========================================================================
   Task list
   ========================================================================== */

function createFocusButton(task) {
  const button = createEl('button', 'btn-task-focus', 'Focus ▶');
  button.type = 'button';
  button.setAttribute('aria-label', `Start a focus session for: ${task.title}`);
  return button;
}

function createTaskElement(task, { isNew = false } = {}) {
  const subject = getSubject(task.subjectId);
  const priority = PRIORITY_META[task.priority] ?? PRIORITY_META.medium;

  const row = createEl('article', `task-item${isNew ? ' is-new' : ''}`);
  row.dataset.taskId = task.id;
  row.dataset.status = task.completed ? 'completed' : 'pending';

  const checkbox = createEl('input', 'task-check');
  checkbox.type = 'checkbox';
  checkbox.id = `task-check-${task.id}`;
  checkbox.checked = task.completed;
  checkbox.setAttribute('aria-labelledby', `task-title-${task.id}`);

  const body = createEl('div', 'task-body');
  const title = createEl('h3', 'task-title', task.title);
  title.id = `task-title-${task.id}`;

  const meta = createEl('div', 'task-meta');
  meta.append(
    createEl('span', `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`, subject ? subject.code : 'GEN'),
    createEl('span', 'task-meta-item', formatDuration(task.durationMinutes)),
    createEl('span', 'task-meta-item', task.dueLabel),
  );
  body.append(title, meta);

  const actions = createEl('div', 'task-actions');
  if (!task.completed) actions.append(createFocusButton(task));

  const badge = createEl('span', `priority-badge ${priority.badge}`, priority.label);
  const remove = createEl('button', 'task-delete', '×');
  remove.type = 'button';
  remove.title = 'Delete task';
  remove.setAttribute('aria-label', `Delete task: ${task.title}`);
  actions.append(badge, remove);

  row.append(checkbox, body, actions);
  return row;
}

function createEmptyState() {
  const subject = state.subjectId ? getSubject(state.subjectId) : null;
  const wrapper = createEl('div', 'empty-state');
  let title;
  let hint;

  if (subject) {
    const word = state.filter === 'all' ? '' : `${state.filter} `;
    title = `No ${word}tasks for ${subject.code}`;
    hint = 'Add one above, or clear the subject filter to see everything.';
  } else if (state.filter === 'pending') {
    title = 'All caught up';
    hint = 'No pending tasks. Add one above, or enjoy the break.';
  } else if (state.filter === 'completed') {
    title = 'Nothing completed yet';
    hint = 'Check off a task and it will show up here.';
  } else {
    title = 'No tasks yet';
    hint = 'Type one above and press Enter. Try: CS-301 Revise graph theory !high 60m';
  }

  wrapper.append(createEl('p', 'empty-state-title', title), createEl('p', 'empty-state-hint', hint));

  if (subject) {
    const clear = createEl('button', 'btn-ghost', 'Clear subject filter');
    clear.type = 'button';
    clear.dataset.action = 'clear-subject';
    wrapper.append(clear);
  }
  return wrapper;
}

/** The first pending row keeps its "Focus ▶" button permanently visible. */
function updatePinnedFocus() {
  refs.taskList.querySelectorAll('.btn-task-focus--pinned').forEach((button) => {
    button.classList.remove('btn-task-focus--pinned');
  });
  const firstPending = refs.taskList.querySelector('.task-item[data-status="pending"] .btn-task-focus');
  if (firstPending) firstPending.classList.add('btn-task-focus--pinned');
}

function renderTaskList({ highlightId = null } = {}) {
  clearTimeout(listRefreshTimer);

  const visible = state.tasks
    .filter(matchesFilters)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));

  if (visible.length === 0) {
    refs.taskList.replaceChildren(createEmptyState());
    return;
  }

  refs.taskList.replaceChildren(
    ...visible.map((task) => createTaskElement(task, { isNew: task.id === highlightId })),
  );
  updatePinnedFocus();
}

function renderFilters() {
  renderFilterTabs();
  renderSubjectSelection();
  renderCounts();
}

function setFilter(filter) {
  if (state.filter === filter) return;
  state.filter = filter;
  renderFilterTabs();
  renderTaskList();
}

/** Updates one existing row in place so the opacity transition can play. */
function syncRow(row, task) {
  row.dataset.status = task.completed ? 'completed' : 'pending';
  row.querySelector('.task-check').checked = task.completed;

  const actions = row.querySelector('.task-actions');
  const focusButton = actions.querySelector('.btn-task-focus');
  if (task.completed && focusButton) focusButton.remove();
  if (!task.completed && !focusButton) actions.prepend(createFocusButton(task));
  updatePinnedFocus();
}

function findRow(id) {
  return refs.taskList.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
}

/* ==========================================================================
   Planned blocks
   ========================================================================== */

const BLOCK_CLASS = { completed: 'block--past', 'up-next': 'block--active', planned: 'block--planned' };

function formatBlockTime(block) {
  if (!block.dayOffset) return block.timeRange;
  const day = block.dayOffset === 1 ? 'Tomorrow' : `+${block.dayOffset}d`;
  return `${day} · ${block.timeRange}`;
}

function createBlockElement(block) {
  const li = createEl('li', `block ${BLOCK_CLASS[block.status] ?? 'block--planned'}`);
  if (block.status === 'up-next') li.setAttribute('aria-current', 'true');
  if (block.reason) li.title = block.reason;

  const top = createEl('div', 'block-top');
  top.append(createEl('span', 'block-time', formatBlockTime(block)));

  if (block.status === 'completed') {
    top.insertAdjacentHTML('beforeend', ICON_CHECK);
  } else if (block.status === 'up-next') {
    top.append(createEl('span', 'badge-up-next', 'Up next'));
  } else {
    top.append(createEl('span', 'block-duration', formatDuration(block.durationMinutes ?? 0)));
  }

  const course = createEl('p', `block-course tone-${block.tone ?? 'muted'}`);
  const dot = createEl('span', 'subject-dot');
  dot.setAttribute('aria-hidden', 'true');
  course.append(dot, document.createTextNode(`${block.subjectCode} ${block.subjectName}`));

  li.append(top, createEl('p', 'block-title', block.title), course);
  return li;
}

function renderPlannedBlocks({ flash = false } = {}) {
  if (state.blocks.length === 0) {
    const empty = createEl('li', 'empty-state empty-state--compact');
    empty.append(
      createEl('p', 'empty-state-title', 'Nothing planned yet'),
      createEl('p', 'empty-state-hint', 'Press Auto-Plan Day to build a schedule from your pending tasks.'),
    );
    refs.blocksList.replaceChildren(empty);
    return;
  }

  refs.blocksList.replaceChildren(...state.blocks.map(createBlockElement));

  if (flash) {
    refs.blocksList.classList.remove('is-refreshed');
    void refs.blocksList.offsetWidth; // restart the CSS animation
    refs.blocksList.classList.add('is-refreshed');
  }
}

/**
 * Keeps block statuses honest: a block is 'completed' exactly when its task is,
 * blocks of deleted tasks disappear, and the first unfinished block is 'up-next'.
 */
function reconcileBlocks(blocks, tasks) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const kept = blocks.filter((block) => !block.taskId || taskById.has(block.taskId));

  let upNextAssigned = false;
  return kept.map((block) => {
    const done = block.taskId ? taskById.get(block.taskId).completed : block.status === 'completed';
    if (done) return { ...block, status: 'completed' };
    if (!upNextAssigned) {
      upNextAssigned = true;
      return { ...block, status: 'up-next' };
    }
    return { ...block, status: 'planned' };
  });
}

function blocksSignature(blocks) {
  return blocks.map((block) => `${block.id}:${block.status}`).join('|');
}

async function commitBlocks(blocks, options) {
  state.blocks = await saveScheduleBlocks(blocks);
  renderPlannedBlocks(options);
}

/** Re-derives block statuses after tasks changed; writes only when something differs. */
async function syncBlocks() {
  try {
    const next = reconcileBlocks(state.blocks, state.tasks);
    if (blocksSignature(next) !== blocksSignature(state.blocks)) await commitBlocks(next);
  } catch (error) {
    console.warn('StudyOS: could not sync schedule blocks.', error);
  }
}

async function regenerateSchedule() {
  const now = new Date();
  const todayKey = toDateKey(now);
  const reconciled = reconcileBlocks(state.blocks, state.tasks);
  const history = reconciled.filter((block) => block.date === todayKey && block.status === 'completed');

  const planned = generateSmartSchedule(state.tasks, state.subjects, { now, existingBlocks: history }).map(
    (block) => ({ ...block, date: todayKey }),
  );

  await commitBlocks(planned, { flash: true });
  return state.blocks;
}

/** First load of a new day (or empty plan): build a fresh plan automatically. */
async function ensureTodaysPlan() {
  const todayKey = toDateKey(new Date());
  const stale = state.blocks.length === 0 || state.blocks.some((block) => block.date !== todayKey);

  if (stale) {
    await regenerateSchedule();
  } else {
    await syncBlocks();
  }
}

/* ==========================================================================
   Task actions
   ========================================================================== */

async function toggleTask(id, checkbox = null) {
  let updated;
  try {
    updated = await toggleTaskCompletion(id);
  } catch (error) {
    console.warn('StudyOS: could not update task.', error);
    if (checkbox) checkbox.checked = !checkbox.checked;
    showToast('Could not save that change. Please try again.', { tone: 'error' });
    return null;
  }

  if (!updated) {
    if (checkbox) checkbox.checked = !checkbox.checked;
    showToast('That task no longer exists.', { tone: 'error' });
    return null;
  }

  const index = state.tasks.findIndex((task) => task.id === id);
  if (index !== -1) state.tasks[index] = updated;

  const row = findRow(id);
  if (row) syncRow(row, updated);

  renderMetrics();
  renderCounts();

  // Let the fade/strikethrough finish, then drop rows that no longer match the filter.
  if (row && !matchesFilters(updated)) {
    clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(renderTaskList, CONFIG.listRefreshDelayMs);
  }

  await syncBlocks();
  return updated;
}

async function removeTask(id) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) return false;

  const orphanedBlocks = state.blocks.filter((block) => block.taskId === id);

  try {
    await deleteTask(id);
  } catch (error) {
    console.warn('StudyOS: could not delete task.', error);
    showToast('Could not delete that task. Please try again.', { tone: 'error' });
    return false;
  }

  state.tasks = state.tasks.filter((candidate) => candidate.id !== id);

  const row = findRow(id);
  if (row) {
    row.classList.add('is-removing');
    clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(renderTaskList, 220);
  } else {
    renderTaskList();
  }

  renderMetrics();
  renderCounts();
  await syncBlocks();

  showToast(`Deleted "${task.title}"`, {
    actionLabel: 'Undo',
    duration: 6000,
    onAction: async () => {
      try {
        const restored = await addTask(task); // same id + createdAt: it returns to its old spot
        state.tasks.push(restored);
        const restoredBlocks = [...state.blocks, ...orphanedBlocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        renderTaskList();
        renderMetrics();
        renderCounts();
        await commitBlocks(reconcileBlocks(restoredBlocks, state.tasks));
      } catch (error) {
        console.warn('StudyOS: could not restore task.', error);
        showToast('Could not restore that task.', { tone: 'error' });
      }
    },
  });
  return true;
}

/** Creates a task, stores it, and makes sure it is visible under the current filters. */
async function createTask(fields, { announce = true } = {}) {
  const saved = await addTask({
    title: fields.title,
    subjectId: fields.subjectId,
    priority: fields.priority,
    durationMinutes: fields.durationMinutes,
  });
  state.tasks.push(saved);

  // A brand-new task is pending: reset any filter that would hide it.
  if (state.filter === 'completed') state.filter = 'all';
  if (state.subjectId && state.subjectId !== saved.subjectId) state.subjectId = null;

  renderFilters();
  renderTaskList({ highlightId: saved.id });
  renderMetrics();

  if (announce) {
    const subject = getSubject(saved.subjectId);
    const priority = PRIORITY_META[saved.priority]?.label ?? 'Medium';
    showToast(
      `Added "${saved.title}" · ${subject ? subject.code : 'GEN'} · ${priority} · ${formatDuration(saved.durationMinutes)}`,
    );
  }
  return saved;
}

/* ==========================================================================
   Quick-add shorthand parser
   ========================================================================== */

/**
 * Understands, in any order:
 *   a course code   "CS-301", "cs301", "math-204"
 *   a priority      "!high", "!medium", "!med", "!low"
 *   a duration      "60m", "45 min", "1.5h", "2h", "1h30m"
 * Everything else becomes the title. Missing pieces fall back to the selected
 * subject (or CS-301), Medium priority and 45 minutes.
 */
function parseQuickTask(raw) {
  let text = ` ${String(raw).trim()} `;
  const take = (regex) => {
    const match = text.match(regex);
    if (match) text = text.replace(regex, ' ');
    return match;
  };

  let subjectId = null;
  for (const subject of state.subjects) {
    const pattern = subject.code.split('-').map(escapeRegExp).join('-?');
    if (take(new RegExp(`(^|\\s)${pattern}(?=\\s|$)`, 'i'))) {
      subjectId = subject.id;
      break;
    }
  }

  let priority = CONFIG.defaultPriority;
  const priorityMatch = take(/(^|\s)!(high|medium|med|low)(?=\s|$)/i);
  if (priorityMatch) {
    const word = priorityMatch[2].toLowerCase();
    priority = word === 'med' ? 'medium' : word;
  }

  let durationMinutes = CONFIG.defaultDurationMinutes;
  const combined = take(/(^|\s)(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?(?=\s|$)/i);
  if (combined) {
    durationMinutes = clampDuration(Number(combined[2]) * 60 + Number(combined[3]));
  } else {
    const single = take(/(^|\s)(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?=\s|$)/i);
    if (single) {
      const value = Number(single[2]);
      durationMinutes = clampDuration(single[3].toLowerCase().startsWith('h') ? value * 60 : value);
    }
  }

  return {
    title: text.replace(/\s+/g, ' ').trim(),
    subjectId: subjectId ?? defaultSubjectId(),
    priority,
    durationMinutes,
  };
}

async function handleQuickAdd(event) {
  event.preventDefault();
  if (quickAddBusy) return;

  const parsed = parseQuickTask(refs.quickInput.value);
  if (!parsed.title) {
    refs.quickForm.classList.add('has-error');
    setTimeout(() => refs.quickForm.classList.remove('has-error'), 600);
    refs.quickInput.focus();
    return;
  }

  quickAddBusy = true;
  try {
    await createTask(parsed);
    refs.quickInput.value = '';
  } catch (error) {
    console.warn('StudyOS: could not add task.', error);
    showToast('Could not save that task. Please try again.', { tone: 'error' });
  } finally {
    quickAddBusy = false;
    refs.quickInput.focus();
  }
}

/* ==========================================================================
   Focus (placeholder until Focus Mode exists)
   ========================================================================== */

function requestFocusSession(task = null) {
  document.dispatchEvent(
    new CustomEvent('studyos:focus-request', {
      detail: task
        ? { taskId: task.id, title: task.title, subjectId: task.subjectId, durationMinutes: task.durationMinutes }
        : { taskId: null },
    }),
  );
  showToast(
    task
      ? `Focus Mode isn't built yet — "${task.title}" will be ready to start when it lands.`
      : "Focus Mode isn't built yet — it's coming in a later phase.",
  );
}

/* ==========================================================================
   Auto-Plan
   ========================================================================== */

async function handleAutoPlan() {
  if (autoPlanBusy) return;
  autoPlanBusy = true;

  const button = refs.autoPlan;
  const label = button.querySelector('.btn-label');
  const originalLabel = label.textContent;
  button.disabled = true;

  try {
    const blocks = await regenerateSchedule();
    const pending = state.tasks.filter((task) => !task.completed).length;
    const planned = blocks.filter((block) => block.status !== 'completed').length;

    label.textContent = '✓ Planned';
    button.classList.add('is-done');

    showToast(
      pending === 0
        ? 'All tasks are done — added a review block.'
        : `Planned ${planned} block${planned === 1 ? '' : 's'} for ${pending} pending task${pending === 1 ? '' : 's'}.`,
    );
  } catch (error) {
    console.warn('StudyOS: could not generate the plan.', error);
    showToast('Could not save the plan. Please try again.', { tone: 'error' });
  } finally {
    setTimeout(() => {
      label.textContent = originalLabel;
      button.classList.remove('is-done');
      button.disabled = false;
      autoPlanBusy = false;
    }, 1600);
  }
}

/* ==========================================================================
   Storage status pill
   ========================================================================== */

function setStorageStatus(ok) {
  refs.statusPill.classList.toggle('is-error', !ok);
  refs.statusDetail.textContent = ok ? 'IndexedDB Synced' : 'Storage unavailable';
}

/* ==========================================================================
   Events
   ========================================================================== */

function bindEvents() {
  refs.taskList.addEventListener('change', (event) => {
    const checkbox = event.target.closest('.task-check');
    if (!checkbox) return;
    const row = checkbox.closest('.task-item');
    if (row) toggleTask(row.dataset.taskId, checkbox);
  });

  refs.taskList.addEventListener('click', (event) => {
    const row = event.target.closest('.task-item');

    if (event.target.closest('.task-delete') && row) {
      removeTask(row.dataset.taskId);
    } else if (event.target.closest('.btn-task-focus') && row) {
      requestFocusSession(state.tasks.find((task) => task.id === row.dataset.taskId) ?? null);
    } else if (event.target.closest('[data-action="clear-subject"]')) {
      state.subjectId = null;
      renderSubjectSelection();
      renderCounts();
      renderTaskList();
    }
  });

  refs.filterGroup.addEventListener('click', (event) => {
    const button = event.target.closest('.segmented-btn');
    if (button) setFilter(button.dataset.filter);
  });

  refs.subjectList.addEventListener('click', (event) => {
    const button = event.target.closest('.subject-item');
    if (button) setSubjectFilter(button.dataset.subjectId);
  });

  refs.quickForm.addEventListener('submit', handleQuickAdd);
  refs.autoPlan.addEventListener('click', handleAutoPlan);
  refs.newTaskButton.addEventListener('click', () => refs.quickInput.focus());
  refs.startFocusButton.addEventListener('click', () => requestFocusSession());

  document.addEventListener('keydown', (event) => {
    const isNewTaskShortcut =
      (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n';
    if (isNewTaskShortcut) {
      event.preventDefault();
      refs.quickInput.focus();
    }
  });
}

/* ==========================================================================
   External API (macOS WKWebView / Apple Shortcuts bridge)
   ========================================================================== */

function summarizeTask(task) {
  const subject = getSubject(task.subjectId);
  return {
    id: task.id,
    title: task.title,
    subjectId: task.subjectId,
    subjectCode: subject ? subject.code : null,
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    dueLabel: task.dueLabel,
    completed: task.completed,
  };
}

function summarizeBlock(block) {
  return {
    id: block.id,
    timeRange: block.timeRange,
    dayOffset: block.dayOffset ?? 0,
    title: block.title,
    subjectCode: block.subjectCode,
    status: block.status,
    taskId: block.taskId ?? null,
  };
}

const api = {
  /** Snapshot of today: task stats, pending tasks, focus time and the plan. */
  async getTodaySummary() {
    await ready;
    const now = new Date();
    const total = state.tasks.length;
    const completed = state.tasks.filter((task) => task.completed).length;
    const todayKey = toDateKey(now);
    const focusMinutes = state.sessions
      .filter((session) => session.date === todayKey)
      .reduce((sum, session) => sum + (Number(session.durationMinutes) || 0), 0);

    return {
      date: todayKey,
      generatedAt: now.toISOString(),
      tasks: {
        total,
        completed,
        pending: total - completed,
        completionPercent: total === 0 ? 0 : Math.round((completed / total) * 100),
      },
      pendingTasks: state.tasks.filter((task) => !task.completed).map(summarizeTask),
      focus: {
        loggedMinutes: focusMinutes,
        goalMinutes: CONFIG.dailyFocusGoalMinutes,
      },
      nextBlock: state.blocks.find((block) => block.status === 'up-next') ?? null,
      schedule: state.blocks.map(summarizeBlock),
    };
  },

  /**
   * Adds a task. `input` is either a shorthand string ("CS-301 Revise !high 60m")
   * or an object { title, subjectId | subjectCode, priority, durationMinutes }.
   */
  async addTaskFromExternal(input) {
    await ready;
    let fields;

    if (typeof input === 'string') {
      fields = parseQuickTask(input);
    } else if (input && typeof input === 'object') {
      const durationValue = Number(input.durationMinutes);
      fields = {
        title: String(input.title ?? '').trim(),
        subjectId: resolveSubjectId(input.subjectId ?? input.subjectCode) ?? defaultSubjectId(),
        priority: PRIORITY_META[input.priority] ? input.priority : CONFIG.defaultPriority,
        durationMinutes: Number.isFinite(durationValue) && durationValue > 0
          ? clampDuration(durationValue)
          : CONFIG.defaultDurationMinutes,
      };
    } else {
      throw new TypeError('addTaskFromExternal expects a string or an object.');
    }

    if (!fields.title) throw new Error('A task needs a title.');
    return summarizeTask(await createTask(fields));
  },

  /** Flips a task's completion by id. Resolves to the updated task, or null if unknown. */
  async toggleTaskById(id) {
    await ready;
    const updated = await toggleTask(String(id));
    return updated ? summarizeTask(updated) : null;
  },

  /** Rebuilds today's plan with the rule-based scheduler. */
  async regenerateSchedule() {
    await ready;
    const blocks = await regenerateSchedule();
    return blocks.map(summarizeBlock);
  },
};

window.StudyOS = Object.freeze({ version: '0.1.0', ready, api });

/* ==========================================================================
   Boot
   ========================================================================== */

function cacheElements() {
  const byId = (id) => document.getElementById(id);

  Object.assign(refs, {
    greeting: byId('greeting-title'),
    dateDisplay: byId('current-date-display'),
    tasksDone: byId('metric-tasks-done'),
    tasksTotal: byId('metric-tasks-total'),
    tasksBar: byId('metric-tasks-bar'),
    tasksPct: byId('metric-tasks-pct'),
    focusLogged: byId('metric-focus-logged'),
    focusBar: byId('metric-focus-bar'),
    focusGoal: byId('metric-focus-goal'),
    badgeTasks: byId('badge-tasks'),
    badgeSubjects: byId('badge-subjects'),
    subjectList: byId('pinned-subject-list'),
    taskList: byId('dashboard-task-list'),
    filterGroup: document.querySelector('.segmented'),
    filterButtons: [...document.querySelectorAll('.segmented-btn[data-filter]')],
    quickForm: byId('quick-task-form'),
    quickInput: byId('quick-task-input'),
    blocksList: byId('planned-blocks-list'),
    autoPlan: byId('btn-auto-plan'),
    newTaskButton: byId('new-task-btn'),
    startFocusButton: byId('start-focus-btn'),
    statusPill: byId('status-pill'),
    statusDetail: byId('status-detail'),
  });
}

async function init() {
  cacheElements();
  renderHeader();
  setInterval(renderHeader, 60_000); // keep greeting/date right across the day
  bindEvents();

  try {
    await initDB();
    const [subjects, tasks, sessions, blocks] = await Promise.all([
      getAllSubjects(),
      getAllTasks(),
      getAllSessions(),
      getScheduleBlocks(),
    ]);

    Object.assign(state, { subjects, tasks, sessions, blocks });
    setStorageStatus(true);

    renderSubjects();
    renderFilters();
    renderTaskList();
    renderMetrics();
    renderPlannedBlocks();

    await ensureTodaysPlan();
    resolveReady();
  } catch (error) {
    console.warn('StudyOS: IndexedDB is unavailable.', error);
    setStorageStatus(false);
    renderTaskList();
    renderPlannedBlocks();
    showToast('Local storage is unavailable, so changes cannot be saved.', { tone: 'error', duration: 6000 });
    rejectReady(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
