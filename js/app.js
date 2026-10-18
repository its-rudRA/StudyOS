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
  addSubject,
  updateSubject,
  deleteSubject,
  SUBJECT_TONES,
  getAllTasks,
  addTask,
  updateTask,
  toggleTaskCompletion,
  deleteTask,
  getAllSessions,
  getScheduleBlocks,
  saveScheduleBlocks,
  toDateKey,
  normalizeDueDateString,
  formatDueLabelFromDate,
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

const ICON_CLOCK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

const ICON_EDIT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/* ==========================================================================
   State
   ========================================================================== */

const state = {
  view: 'dashboard', // 'dashboard' | 'subjects' | 'tasks'
  subjects: [],
  tasks: [],
  sessions: [],
  blocks: [],
  filter: 'all', // 'all' | 'pending' | 'completed' (dashboard)
  subjectId: null, // sidebar subject filter
  tasksFilter: {
    search: '',
    subjectId: 'all',
    status: 'all', // 'all' | 'pending' | 'completed'
    sort: 'smart', // 'smart' | 'deadline' | 'duration-desc' | 'duration-asc'
  },
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
  const activeSubjectId =
    state.view === 'tasks'
      ? state.tasksFilter.subjectId !== 'all' && state.tasksFilter.subjectId !== 'none'
        ? state.tasksFilter.subjectId
        : null
      : state.subjectId;

  refs.subjectList.querySelectorAll('.subject-item').forEach((button) => {
    const selected = button.dataset.subjectId === activeSubjectId;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function setSubjectFilter(subjectId) {
  if (state.view === 'tasks') {
    state.tasksFilter.subjectId = state.tasksFilter.subjectId === subjectId ? 'all' : subjectId;
    if (refs.tasksSubjectFilter) refs.tasksSubjectFilter.value = state.tasksFilter.subjectId;
    renderSubjectSelection();
    renderTasksView();
    return;
  }

  if (state.view !== 'dashboard') {
    state.subjectId = subjectId;
    switchView('dashboard');
  } else {
    state.subjectId = state.subjectId === subjectId ? null : subjectId; // second click clears
  }
  renderSubjectSelection();
  renderCounts();
  renderTaskList();
}

/* ==========================================================================
   SPA View Navigation & Module 2: Subjects & Courses View
   ========================================================================== */

const UPCOMING_VIEW_LABELS = Object.freeze({
  calendar: 'Academic Calendar',
  focus: 'Focus Mode',
  analytics: 'Analytics',
});

function switchView(viewName) {
  if (viewName !== 'dashboard' && viewName !== 'subjects' && viewName !== 'tasks') {
    const label = UPCOMING_VIEW_LABELS[viewName] ?? 'That module';
    showToast(`${label} is coming in a later phase.`);
    return;
  }

  state.view = viewName;

  if (refs.dashboardView) refs.dashboardView.hidden = viewName !== 'dashboard';
  if (refs.subjectsView) refs.subjectsView.hidden = viewName !== 'subjects';
  if (refs.tasksView) refs.tasksView.hidden = viewName !== 'tasks';

  refs.navItems.forEach((link) => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  renderSubjectSelection();

  if (viewName === 'subjects') {
    renderSubjectsView();
  } else if (viewName === 'tasks') {
    populateSubjectSelects();
    renderTasksView();
  }
}

function getSubjectFocusMinutes(subjectId) {
  return state.sessions
    .filter((session) => session.subjectId === subjectId)
    .reduce((sum, session) => sum + (Number(session.durationMinutes) || 0), 0);
}

function createSubjectCardElement(subject) {
  const tone = SUBJECT_TONES.includes(subject.tone) ? subject.tone : 'blue';
  const subjectTasks = state.tasks.filter((task) => task.subjectId === subject.id);
  const totalTasks = subjectTasks.length;
  const doneTasks = subjectTasks.filter((task) => task.completed).length;
  const pendingTasks = totalTasks - doneTasks;
  const pct = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);
  const focusMinutes = getSubjectFocusMinutes(subject.id);

  const card = createEl('article', `subject-card subject-card--${tone}`);
  card.setAttribute('role', 'listitem');
  card.dataset.subjectId = subject.id;

  // Card header: badge + title on left, Edit / Delete buttons on right
  const header = createEl('header', 'subject-card-header');
  const heading = createEl('div', 'subject-card-heading');
  const badgeRow = createEl('div', 'subject-card-badge-row');
  const dot = createEl('span', 'subject-dot');
  dot.setAttribute('aria-hidden', 'true');
  const badge = createEl('span', `course-tag course-tag--${tone}`, subject.code);
  badgeRow.append(dot, badge);

  const title = createEl('h3', 'subject-card-title', subject.name);
  heading.append(badgeRow, title);

  const actions = createEl('div', 'subject-card-actions');
  const editBtn = createEl('button', 'btn-card-action', 'Edit');
  editBtn.type = 'button';
  editBtn.dataset.action = 'edit-subject';
  editBtn.dataset.subjectId = subject.id;
  editBtn.setAttribute('aria-label', `Edit ${subject.code} ${subject.name}`);

  const deleteBtn = createEl('button', 'btn-card-action btn-card-action--danger', 'Delete');
  deleteBtn.type = 'button';
  deleteBtn.dataset.action = 'delete-subject';
  deleteBtn.dataset.subjectId = subject.id;
  deleteBtn.setAttribute('aria-label', `Delete ${subject.code} ${subject.name}`);

  actions.append(editBtn, deleteBtn);
  header.append(heading, actions);

  // Completion progress bar ("X of Y tasks done")
  const progressSection = createEl('div', 'subject-card-progress');
  const progressMeta = createEl('div', 'subject-progress-meta');
  progressMeta.append(
    createEl('span', 'subject-progress-counts', `${doneTasks} of ${totalTasks} tasks done`),
    createEl('span', 'subject-progress-pct', `${pct}%`),
  );

  const track = createEl('div', 'progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(pct));
  track.setAttribute('aria-label', `${subject.code} task completion`);

  const fill = createEl('div', 'progress-fill');
  fill.style.width = `${pct}%`;
  track.append(fill);
  progressSection.append(progressMeta, track);

  // Footer: total logged focus time from sessions + pending count + "+ Add Task" quick action
  const footer = createEl('footer', 'subject-card-footer');
  const focusStat = createEl('div', 'subject-focus-stat');
  focusStat.insertAdjacentHTML('beforeend', ICON_CLOCK);
  const focusText = createEl('span');
  const focusStrong = createEl('strong', '', formatDuration(focusMinutes));
  focusText.append(focusStrong, document.createTextNode(' focus logged'));
  focusStat.append(focusText);

  const footerRight = createEl('div', 'subject-card-footer-right');
  const pendingPill = createEl(
    'span',
    'subject-pending-pill',
    totalTasks === 0
      ? 'No tasks yet'
      : pendingTasks === 0
        ? 'All tasks complete'
        : `${pendingTasks} pending`,
  );

  const addTaskBtn = createEl('button', 'btn-subject-add-task', '+ Add Task');
  addTaskBtn.type = 'button';
  addTaskBtn.dataset.action = 'add-subject-task';
  addTaskBtn.dataset.subjectId = subject.id;
  addTaskBtn.setAttribute('aria-label', `Add task to ${subject.code} ${subject.name}`);

  footerRight.append(pendingPill, addTaskBtn);
  footer.append(focusStat, footerRight);

  card.append(header, progressSection, footer);
  return card;
}

function renderSubjectsView() {
  if (!refs.subjectsGrid) return;

  const totalSubjects = state.subjects.length;
  const totalTasks = state.tasks.filter((task) => task.subjectId).length;
  const doneTasks = state.tasks.filter((task) => task.subjectId && task.completed).length;
  const totalFocusMinutes = state.sessions.reduce(
    (sum, session) => sum + (Number(session.durationMinutes) || 0),
    0,
  );

  if (refs.subjectsSummaryText) {
    refs.subjectsSummaryText.textContent = `${totalSubjects} enrolled ${
      totalSubjects === 1 ? 'course' : 'courses'
    } • ${doneTasks} of ${totalTasks} course tasks done • ${formatDuration(totalFocusMinutes)} total focus logged`;
  }

  if (totalSubjects === 0) {
    const empty = createEl('div', 'empty-state card');
    empty.append(
      createEl('p', 'empty-state-title', 'No subjects added yet'),
      createEl(
        'p',
        'empty-state-hint',
        'Create your first course to organize tasks, track completion progress, and log focus hours.',
      ),
    );
    const addBtn = createEl('button', 'btn-primary', '+ New Subject');
    addBtn.type = 'button';
    addBtn.dataset.action = 'new-subject-empty';
    empty.append(addBtn);
    refs.subjectsGrid.replaceChildren(empty);
    return;
  }

  refs.subjectsGrid.replaceChildren(...state.subjects.map(createSubjectCardElement));
}

function showSubjectFormError(message) {
  if (!refs.subjectFormError) return;
  if (!message) {
    refs.subjectFormError.textContent = '';
    refs.subjectFormError.hidden = true;
  } else {
    refs.subjectFormError.textContent = message;
    refs.subjectFormError.hidden = false;
  }
}

function openSubjectModal(subject = null) {
  if (!refs.subjectModal || !refs.subjectForm) return;

  const isEdit = Boolean(subject && subject.id);
  refs.subjectModalTitle.textContent = isEdit ? 'Edit Subject' : 'New Subject';
  refs.subjectSaveBtn.textContent = isEdit ? 'Save Changes' : 'Save Subject';

  refs.subjectIdInput.value = isEdit ? subject.id : '';
  refs.subjectCodeInput.value = isEdit ? subject.code : '';
  refs.subjectNameInput.value = isEdit ? subject.name : '';

  const selectedTone = isEdit && SUBJECT_TONES.includes(subject.tone) ? subject.tone : 'blue';
  const radio = refs.subjectForm.querySelector(`input[name="tone"][value="${selectedTone}"]`);
  if (radio) radio.checked = true;

  showSubjectFormError('');

  if (typeof refs.subjectModal.showModal === 'function') {
    if (!refs.subjectModal.open) refs.subjectModal.showModal();
  } else {
    refs.subjectModal.setAttribute('open', '');
  }

  refs.subjectCodeInput.focus();
  refs.subjectCodeInput.select();
}

function closeSubjectModal() {
  if (!refs.subjectModal) return;
  showSubjectFormError('');
  if (typeof refs.subjectModal.close === 'function' && refs.subjectModal.open) {
    refs.subjectModal.close();
  } else {
    refs.subjectModal.removeAttribute('open');
  }
}

async function handleSubjectFormSubmit(event) {
  event.preventDefault();

  const editingId = refs.subjectIdInput.value.trim();
  const code = refs.subjectCodeInput.value.trim().toUpperCase();
  const name = refs.subjectNameInput.value.trim();
  const checkedRadio = refs.subjectForm.querySelector('input[name="tone"]:checked');
  const tone = checkedRadio && SUBJECT_TONES.includes(checkedRadio.value) ? checkedRadio.value : 'blue';

  if (!code) {
    showSubjectFormError('Please enter a course code (for example, CS-301).');
    refs.subjectCodeInput.focus();
    return;
  }

  if (!name) {
    showSubjectFormError('Please enter a subject title (for example, Algorithms).');
    refs.subjectNameInput.focus();
    return;
  }

  const duplicate = state.subjects.find(
    (subject) => subject.code.toUpperCase() === code && subject.id !== editingId,
  );
  if (duplicate) {
    showSubjectFormError(`A subject with course code "${code}" already exists.`);
    refs.subjectCodeInput.focus();
    return;
  }

  refs.subjectSaveBtn.disabled = true;
  try {
    let saved;
    if (editingId) {
      saved = await updateSubject({ id: editingId, code, name, tone });
    } else {
      saved = await addSubject({ code, name, tone, pinned: true });
    }

    state.subjects = await getAllSubjects();

    // Keep schedule block labels/tones synchronized if an existing subject was edited.
    if (editingId && state.blocks.length > 0) {
      const taskSubjectMap = new Map(state.tasks.map((task) => [task.id, task.subjectId]));
      let blocksChanged = false;
      const updatedBlocks = state.blocks.map((block) => {
        const blockSubjId = block.subjectId ?? (block.taskId ? taskSubjectMap.get(block.taskId) : null);
        if (blockSubjId === saved.id) {
          blocksChanged = true;
          return {
            ...block,
            subjectCode: saved.code,
            subjectName: saved.name,
            tone: saved.tone,
          };
        }
        return block;
      });
      if (blocksChanged) await commitBlocks(updatedBlocks);
    }

    renderSubjects();
    populateSubjectSelects();
    renderSubjectsView();
    renderTaskList();
    renderTasksView();
    renderMetrics();
    closeSubjectModal();

    showToast(
      editingId
        ? `Updated "${saved.code} — ${saved.name}"`
        : `Added "${saved.code} — ${saved.name}"`,
    );
  } catch (error) {
    console.warn('StudyOS: could not save subject.', error);
    showSubjectFormError('Could not save that subject. Please try again.');
  } finally {
    refs.subjectSaveBtn.disabled = false;
  }
}

async function handleDeleteSubject(subjectId) {
  const subject = getSubject(subjectId);
  if (!subject) return;

  const linkedTaskCount = state.tasks.filter((task) => task.subjectId === subject.id).length;
  const confirmMessage =
    linkedTaskCount > 0
      ? `Delete "${subject.code} — ${subject.name}"?\n\nIts ${linkedTaskCount} associated task${
          linkedTaskCount === 1 ? '' : 's'
        } will be unassigned to General (GEN).`
      : `Delete "${subject.code} — ${subject.name}"?`;

  if (!window.confirm(confirmMessage)) return;

  try {
    await deleteSubject(subject.id);
    const [subjects, tasks] = await Promise.all([getAllSubjects(), getAllTasks()]);
    state.subjects = subjects;
    state.tasks = tasks;

    if (state.subjectId === subject.id) {
      state.subjectId = null;
    }
    if (state.tasksFilter.subjectId === subject.id) {
      state.tasksFilter.subjectId = 'all';
    }

    // Update any schedule blocks that belonged to this subject's tasks
    if (state.blocks.length > 0) {
      const updatedBlocks = state.blocks.map((block) => {
        if (block.subjectCode === subject.code) {
          return { ...block, subjectCode: 'GEN', subjectName: 'General', tone: 'muted' };
        }
        return block;
      });
      await commitBlocks(reconcileBlocks(updatedBlocks, state.tasks));
    }

    renderSubjects();
    populateSubjectSelects();
    renderSubjectsView();
    renderFilters();
    renderTaskList();
    renderTasksView();
    renderMetrics();

    showToast(`Deleted "${subject.code} — ${subject.name}"`);
  } catch (error) {
    console.warn('StudyOS: could not delete subject.', error);
    showToast('Could not delete that subject. Please try again.', { tone: 'error' });
  }
}

/* ==========================================================================
   Task list & Module 3: Full Task Management View (#tasks-view & #task-modal)
   ========================================================================== */

const PRIORITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

function createFocusButton(task) {
  const button = createEl('button', 'btn-task-focus', 'Focus ▶');
  button.type = 'button';
  button.setAttribute('aria-label', `Start a focus session for: ${task.title}`);
  return button;
}

function createTaskElement(task, { isNew = false, listPrefix = 'dash' } = {}) {
  const subject = getSubject(task.subjectId);
  const priority = PRIORITY_META[task.priority] ?? PRIORITY_META.medium;

  const row = createEl('article', `task-item${isNew ? ' is-new' : ''}`);
  row.dataset.taskId = task.id;
  row.dataset.status = task.completed ? 'completed' : 'pending';

  const checkbox = createEl('input', 'task-check');
  checkbox.type = 'checkbox';
  checkbox.id = `task-check-${listPrefix}-${task.id}`;
  checkbox.checked = task.completed;
  checkbox.setAttribute('aria-labelledby', `task-title-${listPrefix}-${task.id}`);

  const body = createEl('div', 'task-body');
  const title = createEl('h3', 'task-title', task.title);
  title.id = `task-title-${listPrefix}-${task.id}`;

  const meta = createEl('div', 'task-meta');
  meta.append(
    createEl('span', `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`, subject ? subject.code : 'GEN'),
    createEl('span', 'task-meta-item', formatDuration(task.durationMinutes)),
    createEl('span', 'task-meta-item', task.dueLabel),
  );
  body.append(title, meta);

  if (task.notes) {
    body.append(createEl('p', 'task-notes', task.notes));
  }

  const actions = createEl('div', 'task-actions');
  if (!task.completed) actions.append(createFocusButton(task));

  const badge = createEl('span', `priority-badge ${priority.badge}`, priority.label);

  const editBtn = createEl('button', 'task-edit');
  editBtn.type = 'button';
  editBtn.title = 'Edit task';
  editBtn.setAttribute('aria-label', `Edit task: ${task.title}`);
  editBtn.insertAdjacentHTML('beforeend', ICON_EDIT);

  const remove = createEl('button', 'task-delete', '×');
  remove.type = 'button';
  remove.title = 'Delete task';
  remove.setAttribute('aria-label', `Delete task: ${task.title}`);
  actions.append(badge, editBtn, remove);

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

/** The first pending row in each task list keeps its "Focus ▶" button permanently visible. */
function updatePinnedFocus(container = refs.taskList) {
  if (!container) return;
  container.querySelectorAll('.btn-task-focus--pinned').forEach((button) => {
    button.classList.remove('btn-task-focus--pinned');
  });
  const firstPending = container.querySelector('.task-item[data-status="pending"] .btn-task-focus');
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
    ...visible.map((task) => createTaskElement(task, { isNew: task.id === highlightId, listPrefix: 'dash' })),
  );
  updatePinnedFocus(refs.taskList);
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
  updatePinnedFocus(row.parentElement);
}

function findRows(id) {
  const escaped = CSS.escape(id);
  const rows = [];
  if (refs.taskList) {
    const dashRow = refs.taskList.querySelector(`[data-task-id="${escaped}"]`);
    if (dashRow) rows.push(dashRow);
  }
  if (refs.fullTasksList) {
    const fullRow = refs.fullTasksList.querySelector(`[data-task-id="${escaped}"]`);
    if (fullRow) rows.push(fullRow);
  }
  return rows;
}

/* ==========================================================================
   Module 3: Full Task Management View (#tasks-view) & Modal (#task-modal)
   ========================================================================== */

function populateSubjectSelects() {
  if (refs.tasksSubjectFilter) {
    const prevValue = state.tasksFilter.subjectId;
    const filterOptions = [createEl('option', '', 'All Subjects')];
    filterOptions[0].value = 'all';

    for (const subject of state.subjects) {
      const opt = createEl('option', '', `${subject.code} — ${subject.name}`);
      opt.value = subject.id;
      filterOptions.push(opt);
    }

    const genOpt = createEl('option', '', 'General (GEN)');
    genOpt.value = 'none';
    filterOptions.push(genOpt);

    refs.tasksSubjectFilter.replaceChildren(...filterOptions);
    const valid = filterOptions.some((opt) => opt.value === prevValue);
    state.tasksFilter.subjectId = valid ? prevValue : 'all';
    refs.tasksSubjectFilter.value = state.tasksFilter.subjectId;
  }

  if (refs.taskSubjectSelect) {
    const currentVal = refs.taskSubjectSelect.value;
    const modalOptions = [];
    for (const subject of state.subjects) {
      const opt = createEl('option', '', `${subject.code} — ${subject.name}`);
      opt.value = subject.id;
      modalOptions.push(opt);
    }
    const genOpt = createEl('option', '', 'General (GEN)');
    genOpt.value = '';
    modalOptions.push(genOpt);

    refs.taskSubjectSelect.replaceChildren(...modalOptions);
    if (modalOptions.some((opt) => opt.value === currentVal)) {
      refs.taskSubjectSelect.value = currentVal;
    }
  }
}

function matchesTasksViewSearchAndSubject(task) {
  const { search, subjectId } = state.tasksFilter;

  if (subjectId === 'none') {
    if (task.subjectId) return false;
  } else if (subjectId !== 'all') {
    if (task.subjectId !== subjectId) return false;
  }

  if (search) {
    const q = search.toLowerCase();
    const subject = getSubject(task.subjectId);
    const haystack = [
      task.title,
      task.notes ?? '',
      task.dueLabel ?? '',
      subject ? subject.code : 'GEN',
      subject ? subject.name : 'General',
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

function matchesTasksViewAll(task) {
  if (!matchesTasksViewSearchAndSubject(task)) return false;
  if (state.tasksFilter.status === 'pending') return !task.completed;
  if (state.tasksFilter.status === 'completed') return task.completed;
  return true;
}

function compareTasksForView(a, b) {
  const sortMode = state.tasksFilter.sort;

  if (sortMode === 'duration-desc') {
    return (
      (Number(b.durationMinutes) || 0) - (Number(a.durationMinutes) || 0) ||
      (PRIORITY_WEIGHT[b.priority] ?? 2) - (PRIORITY_WEIGHT[a.priority] ?? 2) ||
      String(b.createdAt).localeCompare(String(a.createdAt))
    );
  }

  if (sortMode === 'duration-asc') {
    return (
      (Number(a.durationMinutes) || 0) - (Number(b.durationMinutes) || 0) ||
      (PRIORITY_WEIGHT[b.priority] ?? 2) - (PRIORITY_WEIGHT[a.priority] ?? 2) ||
      String(b.createdAt).localeCompare(String(a.createdAt))
    );
  }

  if (sortMode === 'deadline') {
    // Pending tasks first, then soonest dueDate, then highest priority
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (
      String(a.dueDate ?? '').localeCompare(String(b.dueDate ?? '')) ||
      (PRIORITY_WEIGHT[b.priority] ?? 2) - (PRIORITY_WEIGHT[a.priority] ?? 2) ||
      String(b.createdAt).localeCompare(String(a.createdAt))
    );
  }

  // Default 'smart': Pending first, then Priority (high > medium > low), then soonest dueDate, then newest
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  return (
    (PRIORITY_WEIGHT[b.priority] ?? 2) - (PRIORITY_WEIGHT[a.priority] ?? 2) ||
    String(a.dueDate ?? '').localeCompare(String(b.dueDate ?? '')) ||
    String(b.createdAt).localeCompare(String(a.createdAt)) ||
    a.id.localeCompare(b.id)
  );
}

function createTasksViewEmptyState() {
  const wrapper = createEl('div', 'empty-state');
  const hasActiveFilters =
    Boolean(state.tasksFilter.search) ||
    state.tasksFilter.subjectId !== 'all' ||
    state.tasksFilter.status !== 'all';

  if (hasActiveFilters) {
    wrapper.append(
      createEl('p', 'empty-state-title', 'No tasks match your filters'),
      createEl('p', 'empty-state-hint', 'Try adjusting your search query, subject filter, or status tab.'),
    );
    const resetBtn = createEl('button', 'btn-ghost', 'Reset filters');
    resetBtn.type = 'button';
    resetBtn.dataset.action = 'reset-tasks-filters';
    wrapper.append(resetBtn);
  } else {
    wrapper.append(
      createEl('p', 'empty-state-title', 'No tasks in your workspace yet'),
      createEl('p', 'empty-state-hint', 'Create your first task with a course tag, priority, due date, and notes.'),
    );
    const newBtn = createEl('button', 'btn-primary', '+ New Task');
    newBtn.type = 'button';
    newBtn.dataset.action = 'open-new-task-modal';
    wrapper.append(newBtn);
  }
  return wrapper;
}

function renderTasksView({ highlightId = null } = {}) {
  if (!refs.fullTasksList) return;

  const total = state.tasks.length;
  const doneTotal = state.tasks.filter((task) => task.completed).length;
  const pendingTotal = total - doneTotal;

  if (refs.tasksSummaryCounter) {
    refs.tasksSummaryCounter.textContent = `${pendingTotal} pending • ${doneTotal} completed`;
  }

  const scoped = state.tasks.filter(matchesTasksViewSearchAndSubject);
  const scopedDone = scoped.filter((task) => task.completed).length;
  const counts = {
    all: scoped.length,
    pending: scoped.length - scopedDone,
    completed: scopedDone,
  };

  if (refs.tasksStatusButtons) {
    refs.tasksStatusButtons.forEach((button) => {
      const status = button.dataset.tasksStatus;
      const isActive = status === state.tasksFilter.status;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      const countEl = button.querySelector('.count');
      if (countEl) countEl.textContent = String(counts[status] ?? 0);
    });
  }

  const visible = scoped
    .filter((task) => {
      if (state.tasksFilter.status === 'pending') return !task.completed;
      if (state.tasksFilter.status === 'completed') return task.completed;
      return true;
    })
    .sort(compareTasksForView);

  if (visible.length === 0) {
    refs.fullTasksList.replaceChildren(createTasksViewEmptyState());
    return;
  }

  refs.fullTasksList.replaceChildren(
    ...visible.map((task) => createTaskElement(task, { isNew: task.id === highlightId, listPrefix: 'full' })),
  );
  updatePinnedFocus(refs.fullTasksList);
}

function showTaskFormError(message) {
  if (!refs.taskFormError) return;
  if (!message) {
    refs.taskFormError.textContent = '';
    refs.taskFormError.hidden = true;
  } else {
    refs.taskFormError.textContent = message;
    refs.taskFormError.hidden = false;
  }
}

function openTaskModal({ task = null, defaultSubjectId: presetSubjectId = null } = {}) {
  if (!refs.taskModal || !refs.taskForm) return;

  populateSubjectSelects();

  const isEdit = Boolean(task && task.id);
  refs.taskModalTitle.textContent = isEdit ? 'Edit Task' : 'New Task';
  refs.taskSaveBtn.textContent = isEdit ? 'Save Changes' : 'Save Task';

  refs.taskIdInput.value = isEdit ? task.id : '';
  refs.taskTitleInput.value = isEdit ? task.title : '';

  const fallbackSubjId =
    presetSubjectId ??
    (state.view === 'tasks' && state.tasksFilter.subjectId !== 'all' && state.tasksFilter.subjectId !== 'none'
      ? state.tasksFilter.subjectId
      : defaultSubjectId()) ??
    '';

  refs.taskSubjectSelect.value = isEdit ? task.subjectId ?? '' : fallbackSubjId;
  refs.taskDurationInput.value = String(
    isEdit ? task.durationMinutes ?? CONFIG.defaultDurationMinutes : CONFIG.defaultDurationMinutes,
  );

  const selectedPriority = isEdit && PRIORITY_META[task.priority] ? task.priority : CONFIG.defaultPriority;
  const priorityRadio = refs.taskForm.querySelector(`input[name="priority"][value="${selectedPriority}"]`);
  if (priorityRadio) priorityRadio.checked = true;

  const dueDateVal = isEdit ? normalizeDueDateString(task.dueDate) : toDateKey(new Date());
  refs.taskDueDateInput.value = dueDateVal;

  const autoDueLabel = formatDueLabelFromDate(dueDateVal);
  refs.taskDueLabelInput.placeholder = `e.g., ${autoDueLabel}`;
  refs.taskDueLabelInput.value =
    isEdit && task.dueLabel && task.dueLabel !== autoDueLabel ? task.dueLabel : '';

  refs.taskNotesInput.value = isEdit ? task.notes ?? '' : '';

  showTaskFormError('');

  if (typeof refs.taskModal.showModal === 'function') {
    if (!refs.taskModal.open) refs.taskModal.showModal();
  } else {
    refs.taskModal.setAttribute('open', '');
  }

  refs.taskTitleInput.focus();
  if (isEdit) refs.taskTitleInput.select();
}

function closeTaskModal() {
  if (!refs.taskModal) return;
  showTaskFormError('');
  if (typeof refs.taskModal.close === 'function' && refs.taskModal.open) {
    refs.taskModal.close();
  } else {
    refs.taskModal.removeAttribute('open');
  }
}

async function handleTaskFormSubmit(event) {
  event.preventDefault();

  const editingId = refs.taskIdInput.value.trim();
  const title = refs.taskTitleInput.value.trim();
  const subjectId = refs.taskSubjectSelect.value || null;
  const rawDuration = Number(refs.taskDurationInput.value);
  const checkedPriority = refs.taskForm.querySelector('input[name="priority"]:checked');
  const priority = checkedPriority && PRIORITY_META[checkedPriority.value] ? checkedPriority.value : 'medium';
  const dueDate = normalizeDueDateString(refs.taskDueDateInput.value || toDateKey(new Date()));
  const customDueLabel = refs.taskDueLabelInput.value.trim();
  const dueLabel = customDueLabel || formatDueLabelFromDate(dueDate);
  const notes = refs.taskNotesInput.value.trim();

  if (!title) {
    showTaskFormError('Please enter a task title.');
    refs.taskTitleInput.focus();
    return;
  }

  if (!Number.isFinite(rawDuration) || rawDuration < CONFIG.minDurationMinutes) {
    showTaskFormError(`Estimated duration must be at least ${CONFIG.minDurationMinutes} minutes.`);
    refs.taskDurationInput.focus();
    return;
  }

  const durationMinutes = clampDuration(rawDuration);

  refs.taskSaveBtn.disabled = true;
  try {
    if (editingId) {
      const saved = await updateTask({
        id: editingId,
        title,
        subjectId,
        priority,
        durationMinutes,
        dueDate,
        dueLabel,
        notes,
      });

      const index = state.tasks.findIndex((item) => item.id === editingId);
      if (index !== -1) state.tasks[index] = saved;

      // Keep any linked Smart Schedule blocks synchronized with the edited task.
      if (state.blocks.length > 0) {
        const subject = getSubject(saved.subjectId);
        let blocksChanged = false;
        const updatedBlocks = state.blocks.map((block) => {
          if (block.taskId === saved.id) {
            blocksChanged = true;
            const partSuffix = block.title.match(/(\s*\(\d+\/\d+\))$/)?.[1] ?? '';
            return {
              ...block,
              title: `${saved.title}${partSuffix}`,
              subjectId: saved.subjectId,
              subjectCode: subject ? subject.code : 'GEN',
              subjectName: subject ? subject.name : 'General',
              tone: subject ? subject.tone : 'muted',
            };
          }
          return block;
        });
        if (blocksChanged) await commitBlocks(updatedBlocks);
      }

      renderFilters();
      renderTaskList({ highlightId: saved.id });
      renderTasksView({ highlightId: saved.id });
      renderSubjectsView();
      renderMetrics();
      closeTaskModal();

      const subject = getSubject(saved.subjectId);
      showToast(`Updated "${saved.title}" · ${subject ? subject.code : 'GEN'}`);
    } else {
      await createTask({
        title,
        subjectId,
        priority,
        durationMinutes,
        dueDate,
        dueLabel,
        notes,
      });
      closeTaskModal();
    }
  } catch (error) {
    console.warn('StudyOS: could not save task.', error);
    showTaskFormError('Could not save that task. Please try again.');
  } finally {
    refs.taskSaveBtn.disabled = false;
  }
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

  const rows = findRows(id);
  rows.forEach((row) => syncRow(row, updated));

  renderMetrics();
  renderCounts();
  renderSubjectsView();

  // Let the fade/strikethrough finish, then refresh lists where filtering or sorting changes.
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => {
    renderTaskList();
    renderTasksView();
  }, CONFIG.listRefreshDelayMs);

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

  const rows = findRows(id);
  if (rows.length > 0) {
    rows.forEach((row) => row.classList.add('is-removing'));
    clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(() => {
      renderTaskList();
      renderTasksView();
    }, 220);
  } else {
    renderTaskList();
    renderTasksView();
  }

  renderMetrics();
  renderCounts();
  renderSubjectsView();
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
        renderTasksView();
        renderMetrics();
        renderCounts();
        renderSubjectsView();
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
    dueDate: fields.dueDate,
    dueLabel: fields.dueLabel,
    notes: fields.notes,
  });
  state.tasks.push(saved);

  // A brand-new task is pending: reset any filter that would hide it.
  if (state.filter === 'completed') state.filter = 'all';
  if (state.subjectId && state.subjectId !== saved.subjectId) state.subjectId = null;
  if (state.tasksFilter.status === 'completed') state.tasksFilter.status = 'all';
  if (
    state.tasksFilter.subjectId !== 'all' &&
    ((state.tasksFilter.subjectId === 'none' && saved.subjectId) ||
      (state.tasksFilter.subjectId !== 'none' && state.tasksFilter.subjectId !== saved.subjectId))
  ) {
    state.tasksFilter.subjectId = 'all';
    if (refs.tasksSubjectFilter) refs.tasksSubjectFilter.value = 'all';
  }

  renderFilters();
  renderTaskList({ highlightId: saved.id });
  renderTasksView({ highlightId: saved.id });
  renderMetrics();
  renderSubjectsView();
  await syncBlocks();

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

function handleTaskListClick(event) {
  const row = event.target.closest('.task-item');

  if (event.target.closest('.task-delete') && row) {
    removeTask(row.dataset.taskId);
  } else if (event.target.closest('.task-edit') && row) {
    const task = state.tasks.find((item) => item.id === row.dataset.taskId);
    if (task) openTaskModal({ task });
  } else if (event.target.closest('.btn-task-focus') && row) {
    requestFocusSession(state.tasks.find((task) => task.id === row.dataset.taskId) ?? null);
  } else if (event.target.closest('[data-action="clear-subject"]')) {
    state.subjectId = null;
    renderSubjectSelection();
    renderCounts();
    renderTaskList();
  } else if (event.target.closest('[data-action="reset-tasks-filters"]')) {
    state.tasksFilter.search = '';
    state.tasksFilter.subjectId = 'all';
    state.tasksFilter.status = 'all';
    if (refs.tasksSearchInput) refs.tasksSearchInput.value = '';
    if (refs.tasksSubjectFilter) refs.tasksSubjectFilter.value = 'all';
    renderSubjectSelection();
    renderTasksView();
  } else if (event.target.closest('[data-action="open-new-task-modal"]')) {
    openTaskModal();
  }
}

function handleTaskListChange(event) {
  const checkbox = event.target.closest('.task-check');
  if (!checkbox) return;
  const row = checkbox.closest('.task-item');
  if (row) toggleTask(row.dataset.taskId, checkbox);
}

function bindEvents() {
  if (refs.sidebarNav) {
    refs.sidebarNav.addEventListener('click', (event) => {
      const navLink = event.target.closest('.nav-item[data-view]');
      if (!navLink) return;
      event.preventDefault();
      switchView(navLink.dataset.view);
    });
  }

  refs.taskList.addEventListener('change', handleTaskListChange);
  refs.taskList.addEventListener('click', handleTaskListClick);

  if (refs.fullTasksList) {
    refs.fullTasksList.addEventListener('change', handleTaskListChange);
    refs.fullTasksList.addEventListener('click', handleTaskListClick);
  }

  refs.filterGroup.addEventListener('click', (event) => {
    const button = event.target.closest('.segmented-btn');
    if (button) setFilter(button.dataset.filter);
  });

  if (refs.tasksSearchInput) {
    refs.tasksSearchInput.addEventListener('input', () => {
      state.tasksFilter.search = refs.tasksSearchInput.value.trim();
      renderTasksView();
    });
  }

  if (refs.tasksSubjectFilter) {
    refs.tasksSubjectFilter.addEventListener('change', () => {
      state.tasksFilter.subjectId = refs.tasksSubjectFilter.value;
      renderSubjectSelection();
      renderTasksView();
    });
  }

  if (refs.tasksStatusGroup) {
    refs.tasksStatusGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tasks-status]');
      if (!button) return;
      state.tasksFilter.status = button.dataset.tasksStatus;
      renderTasksView();
    });
  }

  if (refs.tasksSortSelect) {
    refs.tasksSortSelect.addEventListener('change', () => {
      state.tasksFilter.sort = refs.tasksSortSelect.value;
      renderTasksView();
    });
  }

  refs.subjectList.addEventListener('click', (event) => {
    const button = event.target.closest('.subject-item');
    if (button) setSubjectFilter(button.dataset.subjectId);
  });

  if (refs.sidebarAddSubjectBtn) {
    refs.sidebarAddSubjectBtn.addEventListener('click', () => openSubjectModal());
  }

  if (refs.newSubjectBtn) {
    refs.newSubjectBtn.addEventListener('click', () => openSubjectModal());
  }

  if (refs.subjectsGrid) {
    refs.subjectsGrid.addEventListener('click', (event) => {
      const editBtn = event.target.closest('[data-action="edit-subject"]');
      if (editBtn) {
        const subject = getSubject(editBtn.dataset.subjectId);
        if (subject) openSubjectModal(subject);
        return;
      }

      const deleteBtn = event.target.closest('[data-action="delete-subject"]');
      if (deleteBtn) {
        handleDeleteSubject(deleteBtn.dataset.subjectId);
        return;
      }

      const addTaskBtn = event.target.closest('[data-action="add-subject-task"]');
      if (addTaskBtn) {
        openTaskModal({ defaultSubjectId: addTaskBtn.dataset.subjectId });
        return;
      }

      const emptyNewBtn = event.target.closest('[data-action="new-subject-empty"]');
      if (emptyNewBtn) {
        openSubjectModal();
      }
    });
  }

  if (refs.subjectForm) {
    refs.subjectForm.addEventListener('submit', handleSubjectFormSubmit);
  }

  if (refs.subjectCancelBtn) {
    refs.subjectCancelBtn.addEventListener('click', closeSubjectModal);
  }

  if (refs.subjectModalClose) {
    refs.subjectModalClose.addEventListener('click', closeSubjectModal);
  }

  if (refs.subjectModal) {
    refs.subjectModal.addEventListener('click', (event) => {
      if (event.target === refs.subjectModal) closeSubjectModal();
    });
  }

  if (refs.taskForm) {
    refs.taskForm.addEventListener('submit', handleTaskFormSubmit);
  }

  if (refs.taskDueDateInput && refs.taskDueLabelInput) {
    refs.taskDueDateInput.addEventListener('change', () => {
      const autoLabel = formatDueLabelFromDate(refs.taskDueDateInput.value);
      refs.taskDueLabelInput.placeholder = `e.g., ${autoLabel}`;
    });
  }

  if (refs.taskCancelBtn) {
    refs.taskCancelBtn.addEventListener('click', closeTaskModal);
  }

  if (refs.taskModalClose) {
    refs.taskModalClose.addEventListener('click', closeTaskModal);
  }

  if (refs.taskModal) {
    refs.taskModal.addEventListener('click', (event) => {
      if (event.target === refs.taskModal) closeTaskModal();
    });
  }

  refs.quickForm.addEventListener('submit', handleQuickAdd);
  refs.autoPlan.addEventListener('click', handleAutoPlan);
  refs.newTaskButton.addEventListener('click', () => openTaskModal());
  if (refs.tasksNewTaskBtn) {
    refs.tasksNewTaskBtn.addEventListener('click', () => openTaskModal());
  }
  refs.startFocusButton.addEventListener('click', () => requestFocusSession());

  document.addEventListener('keydown', (event) => {
    const isOptN = event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyN';
    const isCmdOrCtrlN =
      (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n';

    const target = event.target;
    const isEditableTarget =
      target instanceof HTMLElement &&
      (target.matches('input, textarea, select, [contenteditable="true"]') ||
        Boolean(target.closest('dialog[open]')));
    const isPlainN =
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'n' &&
      !isEditableTarget;

    if (isOptN || isCmdOrCtrlN || isPlainN) {
      event.preventDefault();
      openTaskModal();
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
    dueDate: task.dueDate,
    dueLabel: task.dueLabel,
    notes: task.notes ?? '',
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
   * or an object { title, subjectId | subjectCode, priority, durationMinutes, dueDate, dueLabel, notes }.
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
        dueDate: input.dueDate,
        dueLabel: input.dueLabel,
        notes: input.notes,
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
    sidebarNav: document.querySelector('.sidebar-nav'),
    navItems: [...document.querySelectorAll('.sidebar-nav .nav-item[data-view]')],
    dashboardView: byId('dashboard-content'),
    subjectsView: byId('subjects-view'),
    subjectsGrid: byId('subjects-grid'),
    subjectsSummaryText: byId('subjects-summary-text'),
    sidebarAddSubjectBtn: byId('sidebar-add-subject-btn'),
    newSubjectBtn: byId('new-subject-btn'),
    subjectModal: byId('subject-modal'),
    subjectForm: byId('subject-form'),
    subjectModalTitle: byId('subject-modal-title'),
    subjectModalClose: byId('subject-modal-close'),
    subjectCancelBtn: byId('subject-cancel-btn'),
    subjectSaveBtn: byId('subject-save-btn'),
    subjectIdInput: byId('subject-id-input'),
    subjectCodeInput: byId('subject-code-input'),
    subjectNameInput: byId('subject-name-input'),
    subjectFormError: byId('subject-form-error'),
    tasksView: byId('tasks-view'),
    tasksSummaryCounter: byId('tasks-summary-counter'),
    tasksNewTaskBtn: byId('tasks-new-task-btn'),
    tasksSearchInput: byId('tasks-search-input'),
    tasksSubjectFilter: byId('tasks-subject-filter'),
    tasksStatusGroup: byId('tasks-status-group'),
    tasksStatusButtons: [...document.querySelectorAll('[data-tasks-status]')],
    tasksSortSelect: byId('tasks-sort-select'),
    fullTasksList: byId('full-tasks-list'),
    taskModal: byId('task-modal'),
    taskForm: byId('task-form'),
    taskModalTitle: byId('task-modal-title'),
    taskModalClose: byId('task-modal-close'),
    taskCancelBtn: byId('task-cancel-btn'),
    taskSaveBtn: byId('task-save-btn'),
    taskIdInput: byId('task-id-input'),
    taskTitleInput: byId('task-title-input'),
    taskSubjectSelect: byId('task-subject-select'),
    taskDurationInput: byId('task-duration-input'),
    taskDueDateInput: byId('task-duedate-input'),
    taskDueLabelInput: byId('task-duelabel-input'),
    taskNotesInput: byId('task-notes-input'),
    taskFormError: byId('task-form-error'),
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
    populateSubjectSelects();
    renderSubjectsView();
    renderFilters();
    renderTaskList();
    renderTasksView();
    renderMetrics();
    renderPlannedBlocks();

    if (window.location.hash === '#subjects') {
      switchView('subjects');
    } else if (window.location.hash === '#tasks') {
      switchView('tasks');
    }

    await ensureTodaysPlan();
    resolveReady();
  } catch (error) {
    console.warn('StudyOS: IndexedDB is unavailable.', error);
    setStorageStatus(false);
    populateSubjectSelects();
    renderSubjectsView();
    renderTaskList();
    renderTasksView();
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
