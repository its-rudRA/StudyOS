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
  addSession,
  deleteSession,
  getScheduleBlocks,
  saveScheduleBlocks,
  getAllEvents,
  addEvent,
  updateEvent,
  deleteEvent,
  EVENT_TYPES,
  toDateKey,
  normalizeDueDateString,
  formatDueLabelFromDate,
} from './core/db.js';
import { generateSmartSchedule } from './modules/scheduler.js';
import {
  FOCUS_MODES,
  clampFocusMinutes,
  playCompletionChime,
  createFocusTimer,
} from './modules/focus.js';

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

const EVENT_TYPE_META = Object.freeze({
  exam: { label: 'Exam', badgeClass: 'calendar-type-badge--exam' },
  assignment: { label: 'Assignment', badgeClass: 'calendar-type-badge--assignment' },
  lab: { label: 'Lab', badgeClass: 'calendar-type-badge--lab' },
  milestone: { label: 'Milestone', badgeClass: 'calendar-type-badge--milestone' },
  task: { label: 'Task', badgeClass: 'calendar-type-badge--task' },
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

const initialNow = new Date();

const state = {
  view: 'dashboard', // 'dashboard' | 'subjects' | 'tasks' | 'focus' | 'calendar'
  subjects: [],
  tasks: [],
  sessions: [],
  blocks: [],
  events: [],
  filter: 'all', // 'all' | 'pending' | 'completed' (dashboard)
  subjectId: null, // sidebar subject filter
  tasksFilter: {
    search: '',
    subjectId: 'all',
    status: 'all', // 'all' | 'pending' | 'completed'
    sort: 'smart', // 'smart' | 'deadline' | 'duration-desc' | 'duration-asc'
  },
  focus: {
    mode: 'pomodoro', // 'pomodoro' | 'deep' | 'sprint' | 'break' | 'custom'
    durationMinutes: 25,
    taskId: null,
    subjectId: null,
    muted: false,
    zenMode: false,
  },
  calendar: {
    year: initialNow.getFullYear(),
    month: initialNow.getMonth(),
    selectedDate: toDateKey(initialNow),
    category: 'all', // 'all' | 'exam' | 'assignment' | 'lab' | 'task'
  },
  analytics: {
    range: '7d', // '7d' | '14d' | 'all'
    sessionSubjectFilter: 'all', // 'all' | subjectId | 'none'
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
  const formattedFocus = formatDuration(focusMinutes);

  if (refs.focusLogged) refs.focusLogged.textContent = formattedFocus;
  const altFocusTimeEl = document.getElementById('metric-focus-time');
  if (altFocusTimeEl) altFocusTimeEl.textContent = formattedFocus;

  if (refs.focusBar) {
    refs.focusBar.style.width = `${focusPct}%`;
    refs.focusBar.parentElement?.setAttribute('aria-valuenow', String(focusPct));
  }
  if (refs.focusGoal) {
    refs.focusGoal.textContent = `${formatDuration(CONFIG.dailyFocusGoalMinutes)} Goal`;
  }
  if (refs.focusTodayTotalPill) {
    refs.focusTodayTotalPill.textContent = `${formattedFocus} logged today`;
  }

  renderDashboardDeadlinesAndExam();
  renderDashboardWeeklyChart();
  renderAnalyticsView();
}

/**
 * Renders the Dashboard's bottom-right "Weekly Activity" mini bar chart (last 7 days)
 * and updates `#weekly-total-label` ("Xh this wk").
 */
function renderDashboardWeeklyChart() {
  if (!refs.dashboardWeekChart && !refs.weeklyTotalLabel) return;

  const now = new Date();
  const minutesByDate = new Map();
  for (const session of state.sessions) {
    if (!session.date) continue;
    minutesByDate.set(
      session.date,
      (minutesByDate.get(session.date) ?? 0) + (Number(session.durationMinutes) || 0),
    );
  }

  const buckets = [];
  let totalMinutes = 0;

  for (let offset = -6; offset <= 0; offset += 1) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const dateKey = toDateKey(dt);
    const mins = minutesByDate.get(dateKey) ?? 0;
    totalMinutes += mins;
    buckets.push({
      dateKey,
      weekday: dt.toLocaleDateString('en-US', { weekday: 'short' }),
      shortDate: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      minutes: mins,
      isToday: offset === 0,
    });
  }

  const totalHoursStr = (totalMinutes / 60).toFixed(1).replace(/\.0$/, '');
  if (refs.weeklyTotalLabel) {
    refs.weeklyTotalLabel.textContent = `${totalHoursStr}h this wk`;
  }

  if (!refs.dashboardWeekChart) return;

  const maxMinutes = Math.max(
    CONFIG.dailyFocusGoalMinutes,
    ...buckets.map((b) => b.minutes),
    60,
  );

  const items = buckets.map((b) => {
    const pct = b.minutes === 0 ? 0 : Math.max(8, Math.min(100, Math.round((b.minutes / maxMinutes) * 100)));
    const li = createEl(
      'li',
      `week-col${b.isToday ? ' week-col--today' : ''}${b.minutes === 0 && !b.isToday ? ' week-col--future' : ''}`,
    );
    if (b.isToday) li.setAttribute('aria-current', 'date');
    li.title = `${b.weekday}, ${b.shortDate}: ${formatDuration(b.minutes)} logged`;

    const track = createEl('div', 'week-bar-track');
    const fill = createEl('span', 'week-bar-fill');
    fill.style.setProperty('--bar-height', `${pct}%`);
    track.append(fill);

    const dayLabel = createEl('span', 'week-day', b.weekday);
    const srText = createEl(
      'span',
      'visually-hidden',
      `${formatDuration(b.minutes)}${b.isToday ? ', today' : ''}`,
    );

    li.append(track, dayLabel, srText);
    return li;
  });

  refs.dashboardWeekChart.replaceChildren(...items);
}

/**
 * Returns the integer number of calendar days from `now` (midnight) to `dateStr` (YYYY-MM-DD).
 * Returns null if `dateStr` is invalid.
 */
function daysFromToday(dateStr, now = new Date()) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const target = new Date(y, m - 1, d);
  if (Number.isNaN(target.getTime())) return null;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - todayStart.getTime()) / 86_400_000);
}

function formatShortDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return String(dateStr || '');
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(dateStr);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCountdownPillText(diffDays) {
  if (diffDays === null) return '';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'in 1d';
  if (diffDays > 1) return `in ${diffDays}d`;
  if (diffDays === -1) return '1d ago';
  return `${Math.abs(diffDays)}d ago`;
}

function renderDashboardDeadlinesAndExam() {
  const now = new Date();
  const priorityRank = { high: 3, medium: 2, low: 1 };

  const upcomingEvents = state.events
    .map((ev) => ({ ...ev, diffDays: daysFromToday(ev.date, now) }))
    .filter((ev) => ev.diffDays !== null && ev.diffDays >= 0)
    .sort(
      (a, b) =>
        a.diffDays - b.diffDays ||
        (priorityRank[b.priority] ?? 2) - (priorityRank[a.priority] ?? 2) ||
        String(a.title).localeCompare(String(b.title)),
    );

  if (refs.badgeCalendar) {
    refs.badgeCalendar.textContent = String(upcomingEvents.length);
  }

  // 1. Live Dashboard "Next Exam" Card
  const upcomingExams = upcomingEvents.filter((ev) => ev.type === 'exam');
  const nextMilestone = upcomingExams[0] ?? upcomingEvents[0] ?? null;

  if (refs.nextExamTag && refs.nextExamLabel && refs.nextExamCountdown && refs.nextExamMeta) {
    if (nextMilestone) {
      const subject = getSubject(nextMilestone.subjectId);
      const priorityMeta = PRIORITY_META[nextMilestone.priority] ?? PRIORITY_META.high;
      const diff = nextMilestone.diffDays;

      refs.nextExamTag.className = `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`;
      refs.nextExamTag.textContent = subject ? subject.code : 'GEN';

      let cleanLabel = nextMilestone.title;
      if (subject && cleanLabel.toUpperCase().startsWith(subject.code.toUpperCase())) {
        const stripped = cleanLabel.slice(subject.code.length).replace(/^[\s—–-]+/, '').trim();
        if (stripped) cleanLabel = stripped;
      }
      refs.nextExamLabel.textContent = cleanLabel;

      if (refs.nextExamPriority) {
        refs.nextExamPriority.hidden = false;
        refs.nextExamPriority.className = `priority-badge ${priorityMeta.badge}`;
        refs.nextExamPriority.textContent = priorityMeta.label;
      }

      const daysSpan = createEl('span', 'metric-big', String(diff));
      daysSpan.id = 'metric-exam-days';
      refs.metricExamDays = daysSpan;

      if (diff === 0) {
        refs.nextExamCountdown.replaceChildren(
          document.createTextNode('Today ('),
          daysSpan,
          document.createTextNode('d)'),
        );
      } else if (diff === 1) {
        refs.nextExamCountdown.replaceChildren(
          document.createTextNode('in '),
          daysSpan,
          document.createTextNode(' Day'),
        );
      } else {
        refs.nextExamCountdown.replaceChildren(
          document.createTextNode('in '),
          daysSpan,
          document.createTextNode(' Days'),
        );
      }

      const metaParts = [formatShortDate(nextMilestone.date)];
      if (nextMilestone.timeLabel) metaParts.push(nextMilestone.timeLabel);
      if (nextMilestone.location) metaParts.push(nextMilestone.location);
      refs.nextExamMeta.textContent = metaParts.join(' • ');
    } else {
      refs.nextExamTag.className = 'course-tag';
      refs.nextExamTag.textContent = 'NONE';
      refs.nextExamLabel.textContent = 'No Upcoming Exams';
      if (refs.nextExamPriority) refs.nextExamPriority.hidden = true;

      const daysSpan = createEl('span', 'metric-big', '0');
      daysSpan.id = 'metric-exam-days';
      refs.metricExamDays = daysSpan;
      refs.nextExamCountdown.replaceChildren(daysSpan, document.createTextNode(' Scheduled'));
      refs.nextExamMeta.textContent = 'Add an exam or milestone in Academic Calendar';
    }
  }

  // 2. Live Dashboard "Upcoming Deadlines & Exams" List
  if (!refs.dashboardDeadlineList) return;

  const combinedItems = upcomingEvents.map((ev) => ({
    id: ev.id,
    kind: 'event',
    type: ev.type,
    title: ev.title,
    subjectId: ev.subjectId,
    date: ev.date,
    diffDays: ev.diffDays,
    timeLabel: ev.timeLabel || 'All Day',
    priority: ev.priority || 'medium',
  }));

  const eventSignatures = new Set(
    combinedItems.map((item) => `${item.date}::${item.title.toLowerCase().trim()}`),
  );

  for (const task of state.tasks) {
    if (task.completed || !task.dueDate) continue;
    const diff = daysFromToday(task.dueDate, now);
    if (diff === null || diff < 0) continue;
    const sig = `${task.dueDate}::${task.title.toLowerCase().trim()}`;
    if (eventSignatures.has(sig)) continue;
    combinedItems.push({
      id: task.id,
      kind: 'task',
      type: 'task',
      title: task.title,
      subjectId: task.subjectId,
      date: task.dueDate,
      diffDays: diff,
      timeLabel: task.dueLabel || '11:59 PM',
      priority: task.priority || 'medium',
    });
  }

  combinedItems.sort(
    (a, b) =>
      a.diffDays - b.diffDays ||
      (a.type === 'exam' ? -1 : b.type === 'exam' ? 1 : 0) ||
      (priorityRank[b.priority] ?? 2) - (priorityRank[a.priority] ?? 2) ||
      String(a.title).localeCompare(String(b.title)),
  );

  const topItems = combinedItems.slice(0, 5);

  if (topItems.length === 0) {
    const emptyLi = createEl('li', 'empty-state empty-state--compact');
    emptyLi.append(
      createEl('p', 'empty-state-title', 'No upcoming deadlines'),
      createEl('p', 'empty-state-hint', 'Add an exam or milestone in Academic Calendar.'),
    );
    refs.dashboardDeadlineList.replaceChildren(emptyLi);
    return;
  }

  const nodes = topItems.map((item) => {
    const subject = getSubject(item.subjectId);
    const tone = subject ? subject.tone : 'blue';
    const li = createEl('li', 'deadline-item');
    li.dataset.tone = tone;
    li.dataset.date = item.date;

    const info = createEl('div', 'deadline-info');
    const titleEl = createEl('p', 'deadline-title', item.title);
    const metaEl = createEl('p', 'deadline-meta');
    const courseTag = createEl(
      'span',
      `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`,
      subject ? subject.code : 'GEN',
    );
    metaEl.append(courseTag, document.createTextNode(` ${formatShortDate(item.date)} • ${item.timeLabel}`));
    info.append(titleEl, metaEl);

    const isUrgent = item.diffDays <= 4 || (item.type === 'exam' && item.diffDays <= 6);
    const pill = createEl(
      'span',
      `countdown-pill${isUrgent ? ' countdown-pill--urgent' : ''}`,
      formatCountdownPillText(item.diffDays),
    );

    li.append(info, pill);
    return li;
  });

  refs.dashboardDeadlineList.replaceChildren(...nodes);
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
  let activeSubjectId = state.subjectId;
  if (state.view === 'tasks') {
    activeSubjectId =
      state.tasksFilter.subjectId !== 'all' && state.tasksFilter.subjectId !== 'none'
        ? state.tasksFilter.subjectId
        : null;
  } else if (state.view === 'focus') {
    activeSubjectId = state.focus.subjectId;
  }

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

  if (state.view === 'focus') {
    state.focus.subjectId = subjectId;
    if (state.focus.taskId) {
      const boundTask = state.tasks.find((t) => t.id === state.focus.taskId);
      if (boundTask && boundTask.subjectId !== subjectId) {
        state.focus.taskId = null;
      }
    }
    renderSubjectSelection();
    renderFocusView();
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
   SPA View Navigation & Priority View-Stacking Isolation
   ========================================================================== */

const VIEW_SECTION_MAP = Object.freeze({
  dashboard: 'dashboard-content',
  subjects: 'subjects-view',
  tasks: 'tasks-view',
  focus: 'focus-view',
  calendar: 'calendar-view',
  analytics: 'analytics-view',
});

const WORKSPACE_SECTION_IDS = Object.freeze([
  'dashboard-content',
  'subjects-view',
  'tasks-view',
  'focus-view',
  'calendar-view',
  'analytics-view',
]);

const UPCOMING_VIEW_LABELS = Object.freeze({});

function enforceActiveViewDOM(activeSectionId) {
  for (const id of WORKSPACE_SECTION_IDS) {
    const section = document.getElementById(id);
    if (!section) continue;
    const isActive = section.id === activeSectionId;
    section.hidden = !isActive;
    section.style.display = isActive ? '' : 'none';
  }
}

function scrollWorkspaceToTop() {
  const workspaceContainer = document.querySelector('.workspace, .main-workspace');
  if (workspaceContainer) workspaceContainer.scrollTop = 0;
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}

function switchView(viewName, { updateHash = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(VIEW_SECTION_MAP, viewName)) {
    const label = UPCOMING_VIEW_LABELS[viewName] ?? 'That module';
    showToast(`${label} is coming in a later phase.`);
    enforceActiveViewDOM(VIEW_SECTION_MAP[state.view] ?? 'dashboard-content');
    return;
  }

  if (viewName !== 'focus' && state.focus.zenMode) {
    setZenMode(false);
  }

  state.view = viewName;
  const activeSectionId = VIEW_SECTION_MAP[viewName];
  enforceActiveViewDOM(activeSectionId);

  if (updateHash && window.location.hash !== `#${viewName}`) {
    try {
      window.history.replaceState(null, '', `#${viewName}`);
    } catch {
      // Ignore history API restrictions in sandboxed environments
    }
  }

  refs.navItems.forEach((link) => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  scrollWorkspaceToTop();
  renderSubjectSelection();

  if (viewName === 'subjects') {
    renderSubjectsView();
  } else if (viewName === 'tasks') {
    populateSubjectSelects();
    renderTasksView();
  } else if (viewName === 'focus') {
    renderFocusView();
  } else if (viewName === 'calendar') {
    populateSubjectSelects();
    renderCalendarView();
  } else if (viewName === 'analytics') {
    populateSubjectSelects();
    renderAnalyticsView();
  }
}

function resolveRouteFromHash(rawHash = window.location.hash) {
  const clean = String(rawHash || '').replace(/^#/, '').trim().toLowerCase();
  if (clean === 'focus' || clean === 'focus-view') return { view: 'focus', subjectId: null };
  if (clean === 'calendar' || clean === 'calendar-view') return { view: 'calendar', subjectId: null };
  if (clean === 'analytics' || clean === 'analytics-view') return { view: 'analytics', subjectId: null };
  if (clean === 'subjects' || clean === 'subjects-view') return { view: 'subjects', subjectId: null };
  if (clean === 'tasks' || clean === 'tasks-view') return { view: 'tasks', subjectId: null };
  if (clean.startsWith('subject-')) {
    const subjectSlug = clean.slice('subject-'.length);
    const matchedSubjectId = resolveSubjectId(subjectSlug);
    return { view: 'subjects', subjectId: matchedSubjectId };
  }
  return { view: 'dashboard', subjectId: null };
}

function applyHashRoute({ updateHash = false } = {}) {
  const route = resolveRouteFromHash(window.location.hash);
  if (route.subjectId) {
    state.subjectId = route.subjectId;
  }
  switchView(route.view, { updateHash });
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
    renderFocusView();
    renderCalendarView();
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
    const [subjects, tasks, events] = await Promise.all([
      getAllSubjects(),
      getAllTasks(),
      getAllEvents(),
    ]);
    state.subjects = subjects;
    state.tasks = tasks;
    state.events = events;

    if (state.subjectId === subject.id) {
      state.subjectId = null;
    }
    if (state.tasksFilter.subjectId === subject.id) {
      state.tasksFilter.subjectId = 'all';
    }
    if (state.focus.subjectId === subject.id) {
      state.focus.subjectId = defaultSubjectId();
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
    renderFocusView();
    renderCalendarView();
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

  if (refs.analyticsSessionsSubjectFilter) {
    const prevValue = state.analytics.sessionSubjectFilter;
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

    refs.analyticsSessionsSubjectFilter.replaceChildren(...filterOptions);
    const valid = filterOptions.some((opt) => opt.value === prevValue);
    state.analytics.sessionSubjectFilter = valid ? prevValue : 'all';
    refs.analyticsSessionsSubjectFilter.value = state.analytics.sessionSubjectFilter;
  }

  for (const selectEl of [refs.taskSubjectSelect, refs.eventSubjectSelect, refs.analyticsLogSubject]) {
    if (!selectEl) continue;
    const currentVal = selectEl.value;
    const modalOptions = [];
    for (const subject of state.subjects) {
      const opt = createEl('option', '', `${subject.code} — ${subject.name}`);
      opt.value = subject.id;
      modalOptions.push(opt);
    }
    const genOpt = createEl('option', '', 'General (GEN)');
    genOpt.value = '';
    modalOptions.push(genOpt);

    selectEl.replaceChildren(...modalOptions);
    if (modalOptions.some((opt) => opt.value === currentVal)) {
      selectEl.value = currentVal;
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
      renderFocusView();
      renderCalendarView();
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
  renderFocusView();
  renderCalendarView();

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
  renderFocusView();
  renderCalendarView();
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
        renderFocusView();
        renderCalendarView();
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
  renderFocusView();
  renderCalendarView();
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
   Module 5: Focus Mode (#focus-view), Timer Engine & Live Session Logging
   ========================================================================== */

const FOCUS_RING_CIRCUMFERENCE = 2 * Math.PI * 120; // r = 120 in #focus-ring-progress

const focusTimer = createFocusTimer({
  onTick(snapshot) {
    renderFocusTimerSnapshot(snapshot);
  },
  onComplete(completed) {
    handleFocusTimerComplete(completed);
  },
});

function matchPresetModeByMinutes(minutes) {
  const num = Number(minutes);
  if (num === 25) return 'pomodoro';
  if (num === 50) return 'deep';
  if (num === 15) return 'sprint';
  if (num === 5) return 'break';
  return 'custom';
}

function setZenMode(enabled) {
  state.focus.zenMode = Boolean(enabled);
  document.body.classList.toggle('is-zen-mode', state.focus.zenMode);
  if (refs.focusZenBtn) {
    refs.focusZenBtn.setAttribute('aria-pressed', String(state.focus.zenMode));
  }
  if (refs.focusZenLabel) {
    refs.focusZenLabel.textContent = state.focus.zenMode ? 'Exit Zen (Esc)' : 'Zen Mode';
  }
}

function setFocusMuted(muted) {
  state.focus.muted = Boolean(muted);
  try {
    localStorage.setItem('studyos_focus_muted', state.focus.muted ? '1' : '0');
  } catch {
    // Ignore localStorage restrictions
  }
  if (refs.focusMuteBtn) {
    refs.focusMuteBtn.setAttribute('aria-pressed', String(state.focus.muted));
  }
  if (refs.focusMuteLabel) {
    refs.focusMuteLabel.textContent = state.focus.muted ? 'Muted' : 'Chime On';
  }
}

function selectFocusMode(modeId, customMinutes = null) {
  const modeMeta = FOCUS_MODES[modeId] ?? FOCUS_MODES.custom;
  const minutes = clampFocusMinutes(
    customMinutes ?? modeMeta.defaultMinutes,
    modeMeta.defaultMinutes,
  );

  state.focus.mode = FOCUS_MODES[modeId] ? modeId : 'custom';
  state.focus.durationMinutes = minutes;

  if (refs.focusCustomMinutes && state.focus.mode === 'custom') {
    refs.focusCustomMinutes.value = String(minutes);
  }

  if (refs.focusModePills) {
    refs.focusModePills.querySelectorAll('.focus-mode-pill').forEach((btn) => {
      const active = btn.dataset.focusMode === state.focus.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  focusTimer.setModeAndDuration(state.focus.mode, minutes);
}

function populateFocusSelects() {
  if (!state.focus.subjectId && state.subjects.length > 0) {
    state.focus.subjectId = defaultSubjectId();
  }

  // Validate that any bound task still exists and is pending
  if (state.focus.taskId) {
    const task = state.tasks.find((item) => item.id === state.focus.taskId);
    if (!task || task.completed) {
      state.focus.taskId = null;
    } else if (task.subjectId) {
      state.focus.subjectId = task.subjectId;
    }
  }

  if (refs.focusTaskSelect) {
    const defaultOpt = createEl('option', '', 'No specific task (Direct Subject Focus)');
    defaultOpt.value = '';
    const taskOptions = [defaultOpt];

    const pendingTasks = state.tasks
      .filter((task) => !task.completed)
      .sort(compareTasksForView);

    for (const task of pendingTasks) {
      const subject = getSubject(task.subjectId);
      const code = subject ? subject.code : 'GEN';
      const opt = createEl(
        'option',
        '',
        `[${code}] ${task.title} (${formatDuration(task.durationMinutes)})`,
      );
      opt.value = task.id;
      taskOptions.push(opt);
    }

    refs.focusTaskSelect.replaceChildren(...taskOptions);
    refs.focusTaskSelect.value = state.focus.taskId ?? '';
  }

  const buildSubjectOptions = () => {
    const opts = [];
    for (const subject of state.subjects) {
      const opt = createEl('option', '', `${subject.code} — ${subject.name}`);
      opt.value = subject.id;
      opts.push(opt);
    }
    const genOpt = createEl('option', '', 'General (GEN)');
    genOpt.value = '';
    opts.push(genOpt);
    return opts;
  };

  if (refs.focusSubjectSelect) {
    const opts = buildSubjectOptions();
    refs.focusSubjectSelect.replaceChildren(...opts);
    const validSubj = state.focus.subjectId && state.subjects.some((s) => s.id === state.focus.subjectId);
    state.focus.subjectId = validSubj ? state.focus.subjectId : '';
    refs.focusSubjectSelect.value = state.focus.subjectId;
  }

  if (refs.focusManualSubject) {
    const prevManual = refs.focusManualSubject.value;
    const opts = buildSubjectOptions();
    refs.focusManualSubject.replaceChildren(...opts);
    if (prevManual && opts.some((o) => o.value === prevManual)) {
      refs.focusManualSubject.value = prevManual;
    } else {
      refs.focusManualSubject.value = state.focus.subjectId || defaultSubjectId() || '';
    }
  }

  if (refs.focusMarkTaskDoneBtn) {
    const boundTask = state.focus.taskId
      ? state.tasks.find((item) => item.id === state.focus.taskId && !item.completed)
      : null;
    refs.focusMarkTaskDoneBtn.hidden = !boundTask;
  }
}

function renderFocusBoundContext() {
  const boundTask = state.focus.taskId
    ? state.tasks.find((item) => item.id === state.focus.taskId)
    : null;
  const effectiveSubjectId = boundTask?.subjectId ?? state.focus.subjectId;
  const subject = getSubject(effectiveSubjectId);

  if (refs.focusBoundTag) {
    refs.focusBoundTag.className = `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`;
    refs.focusBoundTag.textContent = subject ? subject.code : 'GEN';
  }

  if (refs.focusBoundTitle) {
    if (boundTask) {
      refs.focusBoundTitle.textContent = boundTask.title;
    } else if (subject) {
      refs.focusBoundTitle.textContent = `${subject.name} Focus`;
    } else {
      refs.focusBoundTitle.textContent = 'General Focus Session';
    }
  }
}

function renderFocusTimerSnapshot(snapshot = focusTimer.getSnapshot()) {
  if (refs.focusTimerDisplay) {
    refs.focusTimerDisplay.textContent = snapshot.formattedRemaining;
  }
  if (refs.focusElapsedDisplay) {
    refs.focusElapsedDisplay.textContent = snapshot.formattedElapsed;
  }
  if (refs.focusStatusPill) {
    refs.focusStatusPill.textContent = snapshot.statusLabel;
    refs.focusStatusPill.dataset.status = snapshot.isBreak ? 'break' : snapshot.status;
  }
  if (refs.focusRingContainer) {
    refs.focusRingContainer.dataset.status = snapshot.status;
    refs.focusRingContainer.dataset.mode = snapshot.mode;
  }
  if (refs.focusRingProgress) {
    const clampedProgress = Math.min(1, Math.max(0, snapshot.progress));
    const dashOffset = FOCUS_RING_CIRCUMFERENCE * clampedProgress;
    refs.focusRingProgress.style.strokeDashoffset = dashOffset.toFixed(2);
  }
  if (refs.focusStartPauseGlyph && refs.focusStartPauseLabel) {
    if (snapshot.status === 'running') {
      refs.focusStartPauseGlyph.textContent = '⏸';
      refs.focusStartPauseLabel.textContent = 'Pause';
    } else if (snapshot.status === 'paused') {
      refs.focusStartPauseGlyph.textContent = '▶';
      refs.focusStartPauseLabel.textContent = 'Resume';
    } else {
      refs.focusStartPauseGlyph.textContent = '▶';
      refs.focusStartPauseLabel.textContent = snapshot.isBreak ? 'Start Break' : 'Start Focus';
    }
  }
}

function formatSessionTimeLabel(session) {
  const raw = session.timestamp || session.startedAt;
  if (!raw) return 'Today';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return 'Today';
  return parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function resolveSessionTitle(session) {
  if (session.title && String(session.title).trim()) {
    return String(session.title).trim();
  }
  if (session.taskId) {
    const task = state.tasks.find((item) => item.id === session.taskId);
    if (task) return task.title;
  }
  const subject = getSubject(session.subjectId);
  return subject ? `${subject.name} Deep Work` : 'Focus Session';
}

function renderFocusHistory() {
  if (!refs.focusHistoryList) return;

  const todayKey = toDateKey(new Date());
  const todaysSessions = state.sessions
    .filter((session) => session.date === todayKey)
    .sort((a, b) => {
      const timeA = String(a.timestamp || a.startedAt || '');
      const timeB = String(b.timestamp || b.startedAt || '');
      return timeB.localeCompare(timeA) || String(b.id).localeCompare(String(a.id));
    });

  const totalMinutes = todaysSessions.reduce(
    (sum, session) => sum + (Number(session.durationMinutes) || 0),
    0,
  );

  if (refs.focusHistorySummary) {
    refs.focusHistorySummary.textContent = `${todaysSessions.length} ${
      todaysSessions.length === 1 ? 'session' : 'sessions'
    } • ${formatDuration(totalMinutes)}`;
  }

  if (refs.focusTodayTotalPill) {
    refs.focusTodayTotalPill.textContent = `${formatDuration(totalMinutes)} logged today`;
  }

  if (todaysSessions.length === 0) {
    const empty = createEl('li', 'empty-state empty-state--compact');
    empty.append(
      createEl('p', 'empty-state-title', 'No focus sessions logged today yet'),
      createEl(
        'p',
        'empty-state-hint',
        'Start the timer above or use the manual logger to record your study time.',
      ),
    );
    refs.focusHistoryList.replaceChildren(empty);
    return;
  }

  const items = todaysSessions.map((session) => {
    const subject = getSubject(session.subjectId);
    const li = createEl('li', 'focus-history-item');
    li.dataset.sessionId = session.id;

    const left = createEl('div', 'focus-history-left');
    const badge = createEl(
      'span',
      `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`,
      subject ? subject.code : 'GEN',
    );
    const title = createEl('span', 'focus-history-title', resolveSessionTitle(session));
    left.append(badge, title);

    const right = createEl('div', 'focus-history-right');
    const timeLabel = createEl('span', 'focus-history-time', formatSessionTimeLabel(session));
    const durationPill = createEl(
      'span',
      'focus-history-duration',
      `+${formatDuration(session.durationMinutes)}`,
    );

    const deleteBtn = createEl('button', 'focus-history-delete', '×');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete session log';
    deleteBtn.dataset.action = 'delete-session';
    deleteBtn.dataset.sessionId = session.id;
    deleteBtn.setAttribute('aria-label', `Delete session: ${resolveSessionTitle(session)}`);

    right.append(timeLabel, durationPill, deleteBtn);
    li.append(left, right);
    return li;
  });

  refs.focusHistoryList.replaceChildren(...items);
}

function renderFocusView() {
  populateFocusSelects();
  renderFocusBoundContext();
  renderFocusTimerSnapshot();
  renderFocusHistory();
}

async function recordAndSyncFocusSession({
  subjectId,
  taskId = null,
  durationMinutes,
  title = '',
  date = null,
  startedAt = null,
}) {
  const now = new Date();
  const boundTask = taskId ? state.tasks.find((item) => item.id === taskId) : null;
  const resolvedSubjectId = subjectId ?? boundTask?.subjectId ?? defaultSubjectId();
  const subject = getSubject(resolvedSubjectId);
  const resolvedTitle =
    String(title || '').trim() ||
    boundTask?.title ||
    (subject ? `${subject.name} Focus Session` : 'Focus Session');

  const safeMinutes = Math.max(1, Math.round(Number(durationMinutes) || 25));
  const timestamp = now.toISOString();
  const resolvedDate =
    date && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : toDateKey(now);

  try {
    const saved = await addSession({
      subjectId: resolvedSubjectId,
      taskId: boundTask ? boundTask.id : null,
      durationMinutes: safeMinutes,
      date: resolvedDate,
      timestamp,
      startedAt: startedAt ?? timestamp,
      title: resolvedTitle,
    });

    state.sessions.push(saved);

    renderMetrics();
    renderSubjectsView();
    renderFocusHistory();

    showToast(
      `Logged ${formatDuration(safeMinutes)} · ${subject ? subject.code : 'GEN'} — "${resolvedTitle}"`,
    );
    return saved;
  } catch (error) {
    console.warn('StudyOS: could not log focus session.', error);
    showToast('Could not save that focus session.', { tone: 'error' });
    return null;
  }
}

async function handleFocusTimerComplete(completed) {
  playCompletionChime({ muted: state.focus.muted });

  if (completed.isBreak) {
    selectFocusMode('pomodoro', 25);
    showToast('Break complete! Ready for your next focus session.');
    return;
  }

  await recordAndSyncFocusSession({
    subjectId: state.focus.subjectId,
    taskId: state.focus.taskId,
    durationMinutes: completed.durationMinutes,
    startedAt: completed.startedAt,
  });
}

async function handleCompleteAndLogEarly() {
  const snapshot = focusTimer.getSnapshot();
  if (snapshot.isBreak) {
    focusTimer.reset();
    selectFocusMode('pomodoro', 25);
    showToast('Break ended — switched back to Pomodoro (25m).');
    return;
  }

  const minutesToLog =
    snapshot.elapsedSeconds > 0
      ? Math.max(1, Math.round(snapshot.elapsedSeconds / 60))
      : snapshot.durationMinutes;

  const startedAt = snapshot.startedAt;
  focusTimer.reset();

  await recordAndSyncFocusSession({
    subjectId: state.focus.subjectId,
    taskId: state.focus.taskId,
    durationMinutes: minutesToLog,
    startedAt,
  });
}

async function handleManualSessionSubmit(event) {
  event.preventDefault();
  const subjectId = refs.focusManualSubject?.value || null;
  const customTitle = refs.focusManualTitle?.value.trim() || '';
  const rawMinutes = Number(refs.focusManualDuration?.value || 25);
  const durationMinutes = clampFocusMinutes(rawMinutes, 25);

  const saved = await recordAndSyncFocusSession({
    subjectId,
    taskId: null,
    durationMinutes,
    title: customTitle,
  });

  if (saved && refs.focusManualTitle) {
    refs.focusManualTitle.value = '';
  }
}

async function handleDeleteFocusSession(sessionId) {
  if (!sessionId) return;
  try {
    await deleteSession(sessionId);
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
    renderMetrics();
    renderSubjectsView();
    renderFocusHistory();
    showToast('Removed focus session from history.');
  } catch (error) {
    console.warn('StudyOS: could not delete focus session.', error);
    showToast('Could not remove that focus session.', { tone: 'error' });
  }
}

function handleFocusRequestEvent(event) {
  const detail = event?.detail ?? {};
  const requestedTaskId = detail.taskId ?? null;
  const task = requestedTaskId ? state.tasks.find((item) => item.id === requestedTaskId) : null;

  if (task) {
    state.focus.taskId = task.id;
    state.focus.subjectId = detail.subjectId ?? task.subjectId ?? defaultSubjectId();
    const targetMinutes = clampFocusMinutes(
      detail.durationMinutes ?? task.durationMinutes ?? 25,
      25,
    );
    const matchedMode = matchPresetModeByMinutes(targetMinutes);
    selectFocusMode(matchedMode, targetMinutes);
  } else if (!state.focus.subjectId) {
    state.focus.subjectId = defaultSubjectId();
  }

  switchView('focus');

  if (task) {
    showToast(`Loaded "${task.title}" (${formatDuration(state.focus.durationMinutes)})`);
  }
  refs.focusStartPauseBtn?.focus();
}

function requestFocusSession(task = null) {
  document.dispatchEvent(
    new CustomEvent('studyos:focus-request', {
      detail: task
        ? { taskId: task.id, title: task.title, subjectId: task.subjectId, durationMinutes: task.durationMinutes }
        : { taskId: null },
    }),
  );
}

/* ==========================================================================
   Module 4: Academic Calendar (#calendar-view) & Event Modal (#event-modal)
   ========================================================================== */

function formatLongSelectedDate(dateStr, now = new Date()) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return 'Selected Day';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return 'Selected Day';

  const diff = daysFromToday(dateStr, now);
  const formatted = dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: dt.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });

  if (diff === 0) return `Today — ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  if (diff === 1) return `Tomorrow — ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  return formatted;
}

function matchesCalendarCategory(item, category = state.calendar.category) {
  if (!category || category === 'all') return true;
  if (category === 'exam') return item.type === 'exam';
  if (category === 'assignment') return item.type === 'assignment' || item.type === 'milestone';
  if (category === 'lab') return item.type === 'lab';
  if (category === 'task') return item.type === 'task';
  return true;
}

/**
 * Returns unified calendar items combining `state.events` and `state.tasks` (with valid `dueDate`).
 */
function getUnifiedCalendarItems({ applyCategory = true } = {}) {
  const now = new Date();
  const priorityRank = { high: 3, medium: 2, low: 1 };
  const items = [];

  for (const ev of state.events) {
    if (!ev.date) continue;
    items.push({
      uid: `event:${ev.id}`,
      id: ev.id,
      kind: 'event',
      type: EVENT_TYPES.includes(ev.type) ? ev.type : 'exam',
      title: ev.title,
      subjectId: ev.subjectId,
      date: ev.date,
      diffDays: daysFromToday(ev.date, now),
      timeLabel: ev.timeLabel || 'All Day',
      location: ev.location || '',
      priority: ev.priority || 'medium',
      notes: ev.notes || '',
      completed: false,
      rawEvent: ev,
    });
  }

  for (const task of state.tasks) {
    if (!task.dueDate) continue;
    items.push({
      uid: `task:${task.id}`,
      id: task.id,
      kind: 'task',
      type: 'task',
      title: task.title,
      subjectId: task.subjectId,
      date: task.dueDate,
      diffDays: daysFromToday(task.dueDate, now),
      timeLabel: task.dueLabel || 'Due 11:59 PM',
      location: task.completed ? 'Completed' : `${formatDuration(task.durationMinutes || 45)} est.`,
      priority: task.priority || 'medium',
      notes: task.notes || '',
      completed: Boolean(task.completed),
      rawTask: task,
    });
  }

  const filtered = applyCategory
    ? items.filter((item) => matchesCalendarCategory(item, state.calendar.category))
    : items;

  filtered.sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      (a.kind === 'event' && b.kind !== 'event' ? -1 : a.kind !== 'event' && b.kind === 'event' ? 1 : 0) ||
      (a.type === 'exam' ? -1 : b.type === 'exam' ? 1 : 0) ||
      (priorityRank[b.priority] ?? 2) - (priorityRank[a.priority] ?? 2) ||
      String(a.title).localeCompare(String(b.title)),
  );

  return filtered;
}

function createCalendarAgendaCard(item, { showDateInMeta = false } = {}) {
  const subject = getSubject(item.subjectId);
  const tone = subject ? subject.tone : 'blue';
  const typeMeta = EVENT_TYPE_META[item.type] ?? EVENT_TYPE_META.milestone;

  const li = createEl(
    'li',
    `calendar-agenda-item calendar-agenda-item--${tone}${item.completed ? ' is-completed' : ''}`,
  );
  li.dataset.date = item.date;
  li.dataset.kind = item.kind;
  li.dataset.itemId = item.id;

  const top = createEl('div', 'calendar-agenda-top');
  const badges = createEl('div', 'calendar-agenda-badges');

  const courseTag = createEl(
    'span',
    `course-tag${subject ? ` course-tag--${subject.tone}` : ''}`,
    subject ? subject.code : 'GEN',
  );
  const typeBadge = createEl('span', `calendar-type-badge ${typeMeta.badgeClass}`, typeMeta.label);
  badges.append(courseTag, typeBadge);

  const isUrgent =
    !item.completed &&
    item.diffDays !== null &&
    item.diffDays >= 0 &&
    (item.diffDays <= 4 || (item.type === 'exam' && item.diffDays <= 6));
  const countdownPill = createEl(
    'span',
    `countdown-pill${isUrgent ? ' countdown-pill--urgent' : ''}`,
    item.completed ? 'Done' : formatCountdownPillText(item.diffDays),
  );

  top.append(badges, countdownPill);

  const titleEl = createEl('p', 'calendar-agenda-title', item.title);

  const metaParts = [];
  if (showDateInMeta) metaParts.push(formatShortDate(item.date));
  if (item.timeLabel) metaParts.push(item.timeLabel);
  if (item.location) metaParts.push(item.location);

  const metaEl = createEl('p', 'calendar-agenda-meta', metaParts.join(' • '));

  li.append(top, titleEl, metaEl);

  if (item.notes) {
    li.append(createEl('p', 'calendar-agenda-notes', item.notes));
  }

  const actions = createEl('div', 'calendar-agenda-actions');
  if (item.kind === 'event') {
    const editBtn = createEl('button', 'btn-card-action', 'Edit');
    editBtn.type = 'button';
    editBtn.dataset.action = 'edit-event';
    editBtn.dataset.eventId = item.id;

    const deleteBtn = createEl('button', 'btn-card-action btn-card-action--danger', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.dataset.action = 'delete-event';
    deleteBtn.dataset.eventId = item.id;

    actions.append(editBtn, deleteBtn);
  } else if (item.kind === 'task') {
    if (!item.completed) {
      const focusBtn = createEl('button', 'btn-card-action', 'Focus ▶');
      focusBtn.type = 'button';
      focusBtn.dataset.action = 'focus-calendar-task';
      focusBtn.dataset.taskId = item.id;
      actions.append(focusBtn);
    }
    const editTaskBtn = createEl('button', 'btn-card-action', 'Edit Task');
    editTaskBtn.type = 'button';
    editTaskBtn.dataset.action = 'edit-calendar-task';
    editTaskBtn.dataset.taskId = item.id;
    actions.append(editTaskBtn);
  }

  li.append(actions);
  return li;
}

function renderCalendarView() {
  if (!refs.calendarDaysGrid) return;

  const now = new Date();
  const todayKey = toDateKey(now);
  const { year, month, selectedDate, category } = state.calendar;

  // Update summary pill in header
  if (refs.calendarSummaryPill) {
    const upcomingEvCount = state.events.filter((ev) => {
      const d = daysFromToday(ev.date, now);
      return d !== null && d >= 0;
    }).length;
    const pendingTaskDeadlines = state.tasks.filter((t) => !t.completed && t.dueDate).length;
    refs.calendarSummaryPill.textContent = `${upcomingEvCount} upcoming ${
      upcomingEvCount === 1 ? 'milestone' : 'milestones'
    } • ${pendingTaskDeadlines} task ${pendingTaskDeadlines === 1 ? 'deadline' : 'deadlines'}`;
  }

  // Update Month / Year label
  if (refs.calendarMonthLabel) {
    const monthDate = new Date(year, month, 1);
    refs.calendarMonthLabel.textContent = monthDate.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
  }

  // Update category filter buttons
  if (refs.calendarCategoryButtons) {
    refs.calendarCategoryButtons.forEach((btn) => {
      const active = btn.dataset.calFilter === category;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  const allVisibleItems = getUnifiedCalendarItems({ applyCategory: true });
  const itemsByDate = new Map();
  for (const item of allVisibleItems) {
    const list = itemsByDate.get(item.date) ?? [];
    list.push(item);
    itemsByDate.set(item.date, list);
  }

  // Build 42-cell Monday-Sunday month grid
  const firstDayOfMonth = new Date(year, month, 1);
  const mondayOffset = (firstDayOfMonth.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const cells = [];

  for (let i = 0; i < 42; i += 1) {
    const cellDate = new Date(year, month, 1 - mondayOffset + i);
    const dateKey = toDateKey(cellDate);
    const isOutside = cellDate.getMonth() !== month;
    const isToday = dateKey === todayKey;
    const isSelected = dateKey === selectedDate;
    const dayItems = itemsByDate.get(dateKey) ?? [];

    const cell = createEl(
      'div',
      `calendar-day-cell${isOutside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}${
        isSelected ? ' is-selected' : ''
      }`,
    );
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('tabindex', isSelected ? '0' : '-1');
    cell.setAttribute('aria-selected', String(isSelected));
    cell.dataset.date = dateKey;

    const topRow = createEl('div', 'calendar-day-top');
    topRow.append(createEl('span', 'calendar-day-num', String(cellDate.getDate())));
    if (isToday) {
      topRow.append(createEl('span', 'calendar-today-tag', 'Today'));
    }
    cell.append(topRow);

    const eventsWrap = createEl('div', 'calendar-day-events');
    const maxPills = 3;
    dayItems.slice(0, maxPills).forEach((item) => {
      const subject = getSubject(item.subjectId);
      const tone = subject ? subject.tone : 'blue';
      const pill = createEl(
        'div',
        `calendar-pill calendar-pill--${tone}${item.type === 'exam' ? ' calendar-pill--exam' : ''}${
          item.completed ? ' is-completed' : ''
        }`,
      );
      const dot = createEl('span', 'calendar-pill-dot');
      dot.setAttribute('aria-hidden', 'true');
      const shortPrefix = subject ? `${subject.code} ` : '';
      const labelText = item.title.toUpperCase().startsWith(shortPrefix.trim().toUpperCase())
        ? item.title
        : `${shortPrefix}${item.title}`;
      const textSpan = createEl('span', 'calendar-pill-text', labelText);
      pill.append(dot, textSpan);
      eventsWrap.append(pill);
    });

    if (dayItems.length > maxPills) {
      eventsWrap.append(createEl('span', 'calendar-more-pill', `+${dayItems.length - maxPills} more`));
    }

    cell.append(eventsWrap);
    cells.push(cell);
  }

  refs.calendarDaysGrid.replaceChildren(...cells);

  // Render Right Column Card 1: Selected Day Agenda
  const selectedDayItems = itemsByDate.get(selectedDate) ?? [];
  if (refs.calendarSelectedDayTitle) {
    refs.calendarSelectedDayTitle.textContent = formatLongSelectedDate(selectedDate, now);
  }
  if (refs.calendarSelectedDayMeta) {
    refs.calendarSelectedDayMeta.textContent =
      selectedDayItems.length === 0
        ? 'No exams, milestones, or task deadlines on this date'
        : `${selectedDayItems.length} scheduled ${selectedDayItems.length === 1 ? 'item' : 'items'}`;
  }

  if (refs.calendarSelectedDayList) {
    if (selectedDayItems.length === 0) {
      const emptyLi = createEl('li', 'empty-state empty-state--compact');
      emptyLi.append(
        createEl('p', 'empty-state-title', `Nothing scheduled for ${formatShortDate(selectedDate)}`),
        createEl('p', 'empty-state-hint', 'Add an exam, assignment, or lab milestone for this day.'),
      );
      const addDayBtn = createEl('button', 'btn-ghost', `+ Add Event on ${formatShortDate(selectedDate)}`);
      addDayBtn.type = 'button';
      addDayBtn.dataset.action = 'add-event-on-selected-day';
      emptyLi.append(addDayBtn);
      refs.calendarSelectedDayList.replaceChildren(emptyLi);
    } else {
      refs.calendarSelectedDayList.replaceChildren(
        ...selectedDayItems.map((item) => createCalendarAgendaCard(item, { showDateInMeta: false })),
      );
    }
  }

  // Render Right Column Card 2: Upcoming Milestones (Next 14 Days + upcoming academic events)
  const upcomingItems = allVisibleItems.filter((item) => {
    if (item.completed) return false;
    if (item.diffDays === null || item.diffDays < 0) return false;
    return item.kind === 'event' || item.diffDays <= 14;
  });

  if (refs.calendarUpcomingCount) {
    refs.calendarUpcomingCount.textContent = String(upcomingItems.length);
  }

  if (refs.calendarUpcomingList) {
    if (upcomingItems.length === 0) {
      const emptyUpcoming = createEl('li', 'empty-state empty-state--compact');
      emptyUpcoming.append(
        createEl('p', 'empty-state-title', 'No upcoming milestones'),
        createEl('p', 'empty-state-hint', 'Use "+ Add Event / Exam" to schedule upcoming assessments.'),
      );
      refs.calendarUpcomingList.replaceChildren(emptyUpcoming);
    } else {
      refs.calendarUpcomingList.replaceChildren(
        ...upcomingItems.map((item) => createCalendarAgendaCard(item, { showDateInMeta: true })),
      );
    }
  }
}

function selectCalendarDate(dateKey, { syncMonth = true } = {}) {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return;
  state.calendar.selectedDate = dateKey;
  if (syncMonth) {
    const [y, m] = dateKey.split('-').map(Number);
    state.calendar.year = y;
    state.calendar.month = m - 1;
  }
  renderCalendarView();
}

function shiftCalendarMonth(deltaMonths) {
  const shifted = new Date(state.calendar.year, state.calendar.month + deltaMonths, 1);
  state.calendar.year = shifted.getFullYear();
  state.calendar.month = shifted.getMonth();
  renderCalendarView();
}

function jumpCalendarToToday() {
  const now = new Date();
  state.calendar.year = now.getFullYear();
  state.calendar.month = now.getMonth();
  state.calendar.selectedDate = toDateKey(now);
  renderCalendarView();
}

function showEventFormError(message) {
  if (!refs.eventFormError) return;
  if (!message) {
    refs.eventFormError.textContent = '';
    refs.eventFormError.hidden = true;
  } else {
    refs.eventFormError.textContent = message;
    refs.eventFormError.hidden = false;
  }
}

function openEventModal({ eventItem = null, defaultDate = null } = {}) {
  if (!refs.eventModal || !refs.eventForm) return;

  populateSubjectSelects();

  const isEdit = Boolean(eventItem && eventItem.id);
  refs.eventModalTitle.textContent = isEdit ? 'Edit Academic Event' : 'Add Academic Event / Exam';
  refs.eventSaveBtn.textContent = isEdit ? 'Save Changes' : 'Save Event';

  refs.eventIdInput.value = isEdit ? eventItem.id : '';
  refs.eventTitleInput.value = isEdit ? eventItem.title : '';
  refs.eventTypeSelect.value =
    isEdit && EVENT_TYPES.includes(eventItem.type) ? eventItem.type : 'exam';
  refs.eventSubjectSelect.value = isEdit ? eventItem.subjectId ?? '' : defaultSubjectId() ?? '';

  const fallbackDate = defaultDate || state.calendar.selectedDate || toDateKey(new Date());
  refs.eventDateInput.value = isEdit ? normalizeDueDateString(eventItem.date) : fallbackDate;
  refs.eventTimeInput.value = isEdit ? eventItem.timeLabel ?? '' : '10:00 AM';
  refs.eventLocationInput.value = isEdit ? eventItem.location ?? '' : '';

  const selectedPriority =
    isEdit && PRIORITY_META[eventItem.priority] ? eventItem.priority : 'high';
  const priorityRadio = refs.eventForm.querySelector(
    `input[name="eventPriority"][value="${selectedPriority}"]`,
  );
  if (priorityRadio) priorityRadio.checked = true;

  refs.eventNotesInput.value = isEdit ? eventItem.notes ?? '' : '';
  showEventFormError('');

  if (typeof refs.eventModal.showModal === 'function') {
    if (!refs.eventModal.open) refs.eventModal.showModal();
  } else {
    refs.eventModal.setAttribute('open', '');
  }

  refs.eventTitleInput.focus();
  if (isEdit) refs.eventTitleInput.select();
}

function closeEventModal() {
  if (!refs.eventModal) return;
  showEventFormError('');
  if (typeof refs.eventModal.close === 'function' && refs.eventModal.open) {
    refs.eventModal.close();
  } else {
    refs.eventModal.removeAttribute('open');
  }
}

async function handleEventFormSubmit(event) {
  event.preventDefault();

  const editingId = refs.eventIdInput.value.trim();
  const title = refs.eventTitleInput.value.trim();
  const type = EVENT_TYPES.includes(refs.eventTypeSelect.value) ? refs.eventTypeSelect.value : 'exam';
  const subjectId = refs.eventSubjectSelect.value || null;
  const rawDate = refs.eventDateInput.value;
  const timeLabel = refs.eventTimeInput.value.trim() || 'All Day';
  const location = refs.eventLocationInput.value.trim();
  const checkedPriority = refs.eventForm.querySelector('input[name="eventPriority"]:checked');
  const priority =
    checkedPriority && PRIORITY_META[checkedPriority.value] ? checkedPriority.value : 'high';
  const notes = refs.eventNotesInput.value.trim();

  if (!title) {
    showEventFormError('Please enter an event or exam title.');
    refs.eventTitleInput.focus();
    return;
  }

  if (!rawDate) {
    showEventFormError('Please choose a valid date.');
    refs.eventDateInput.focus();
    return;
  }

  const date = normalizeDueDateString(rawDate);

  refs.eventSaveBtn.disabled = true;
  try {
    let saved;
    if (editingId) {
      saved = await updateEvent({
        id: editingId,
        title,
        type,
        subjectId,
        date,
        timeLabel,
        location,
        priority,
        notes,
      });
    } else {
      saved = await addEvent({
        title,
        type,
        subjectId,
        date,
        timeLabel,
        location,
        priority,
        notes,
      });
    }

    state.events = await getAllEvents();
    selectCalendarDate(saved.date, { syncMonth: true });
    renderMetrics();
    closeEventModal();

    const subject = getSubject(saved.subjectId);
    showToast(
      `${editingId ? 'Updated' : 'Scheduled'} "${saved.title}" · ${
        subject ? subject.code : 'GEN'
      } (${formatShortDate(saved.date)})`,
    );
  } catch (error) {
    console.warn('StudyOS: could not save calendar event.', error);
    showEventFormError('Could not save that event. Please try again.');
  } finally {
    refs.eventSaveBtn.disabled = false;
  }
}

async function handleDeleteEvent(eventId) {
  const existing = state.events.find((item) => item.id === eventId);
  if (!existing) return;

  try {
    await deleteEvent(eventId);
    state.events = await getAllEvents();
    renderMetrics();
    renderCalendarView();

    showToast(`Deleted "${existing.title}"`, {
      actionLabel: 'Undo',
      duration: 6000,
      onAction: async () => {
        try {
          await addEvent(existing);
          state.events = await getAllEvents();
          renderMetrics();
          renderCalendarView();
        } catch (err) {
          console.warn('StudyOS: could not restore event.', err);
          showToast('Could not restore that event.', { tone: 'error' });
        }
      },
    });
  } catch (error) {
    console.warn('StudyOS: could not delete event.', error);
    showToast('Could not delete that event. Please try again.', { tone: 'error' });
  }
}

/* ==========================================================================
   Module 6: Analytics & Study Insights View (#analytics-view)
   ========================================================================== */

const TONE_COLOR_HEX = Object.freeze({
  blue: '#60A5FA',
  green: '#34D399',
  amber: '#FBBF24',
  pink: '#F472B6',
  violet: '#A78BFA',
  cyan: '#22D3EE',
});

function formatDecimalHours(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total === 0) return '0h';
  const hrs = total / 60;
  return Number.isInteger(hrs) ? `${hrs}h` : `${hrs.toFixed(1)}h`;
}

function getAnalyticsDateWindow(range, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = toDateKey(today);

  if (range === '7d' || range === '14d') {
    const daysCount = range === '14d' ? 14 : 7;
    const dates = [];
    for (let i = daysCount - 1; i >= 0; i -= 1) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      dates.push(toDateKey(d));
    }
    return {
      range,
      daysCount,
      startKey: dates[0],
      endKey: todayKey,
      dateKeys: dates,
      label: range === '14d' ? 'Last 14 Days' : 'Last 7 Days',
    };
  }

  // 'all' time: span at least the last 7 days, or from earliest session up to today
  const sessionDates = state.sessions
    .map((s) => s.date)
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const sevenDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  const sevenDaysAgoKey = toDateKey(sevenDaysAgo);
  const earliestKey =
    sessionDates.length > 0 && sessionDates[0] < sevenDaysAgoKey
      ? sessionDates[0]
      : sevenDaysAgoKey;

  const [sy, sm, sd] = earliestKey.split('-').map(Number);
  const startDate = new Date(sy, sm - 1, sd);
  const diffDays = Math.max(
    7,
    Math.min(30, Math.round((today.getTime() - startDate.getTime()) / 86_400_000) + 1),
  );

  const dates = [];
  for (let i = diffDays - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dates.push(toDateKey(d));
  }

  return {
    range: 'all',
    daysCount: Math.max(
      1,
      Math.round((today.getTime() - startDate.getTime()) / 86_400_000) + 1,
    ),
    startKey: sessionDates[0] || sevenDaysAgoKey,
    endKey: todayKey,
    dateKeys: dates,
    label: 'All Time',
  };
}

function getFilteredAnalyticsSessions(windowInfo) {
  if (windowInfo.range === 'all') {
    return [...state.sessions];
  }
  return state.sessions.filter(
    (s) => s.date && s.date >= windowInfo.startKey && s.date <= windowInfo.endKey,
  );
}

function calculateStudyStreak(now = new Date()) {
  const activeDates = new Set();

  for (const session of state.sessions) {
    if (session.date && (Number(session.durationMinutes) || 0) > 0) {
      activeDates.add(session.date);
    }
  }

  for (const task of state.tasks) {
    if (task.completed) {
      if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) {
        activeDates.add(task.dueDate);
      } else if (typeof task.createdAt === 'number') {
        activeDates.add(toDateKey(new Date(task.createdAt)));
      }
    }
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = toDateKey(today);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday);

  const hasToday = activeDates.has(todayKey);
  const hasYesterday = activeDates.has(yesterdayKey);

  if (!hasToday && !hasYesterday) {
    return {
      streak: 0,
      activeToday: false,
      activeDatesCount: activeDates.size,
    };
  }

  let streak = 0;
  let cursor = hasToday ? today : yesterday;

  while (activeDates.has(toDateKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }

  return {
    streak,
    activeToday: hasToday,
    activeDatesCount: activeDates.size,
  };
}

function buildSmartRecommendations(now = new Date()) {
  const recommendations = [];
  const todayKey = toDateKey(now);
  const sevenDaysWindow = getAnalyticsDateWindow('7d', now);
  const recentSessions = getFilteredAnalyticsSessions(sevenDaysWindow);

  const minutesBySubject = new Map();
  for (const session of recentSessions) {
    if (!session.subjectId) continue;
    minutesBySubject.set(
      session.subjectId,
      (minutesBySubject.get(session.subjectId) ?? 0) + (Number(session.durationMinutes) || 0),
    );
  }

  // 1. Check upcoming exams within 10 days with low recent focus time
  const upcomingExams = state.events
    .filter((ev) => ev.type === 'exam' && ev.date >= todayKey)
    .map((ev) => ({ ...ev, daysAway: daysBetweenIso(todayKey, ev.date) }))
    .filter((ev) => ev.daysAway !== null && ev.daysAway <= 14)
    .sort((a, b) => a.daysAway - b.daysAway);

  for (const exam of upcomingExams) {
    const subject = getSubject(exam.subjectId);
    const subjMins = minutesBySubject.get(exam.subjectId) ?? 0;
    if (subjMins < 120) {
      const code = subject ? subject.code : 'Exam Prep';
      const whenText =
        exam.daysAway === 0
          ? 'today'
          : exam.daysAway === 1
            ? 'tomorrow'
            : `in ${exam.daysAway} days`;
      recommendations.push({
        tone: exam.daysAway <= 4 ? 'high' : 'amber',
        badge: `${code} · Exam Alert`,
        title: `${exam.title} is ${whenText} with only ${formatDuration(subjMins)} logged this week`,
        detail: `Schedule a 50m Deep Work session for ${subject ? subject.name : code} to stay ahead of the curve.`,
        actionLabel: 'Start 50m Deep Work →',
        actionType: 'focus-subject',
        subjectId: exam.subjectId || defaultSubjectId(),
        minutes: 50,
      });
    }
  }

  // 2. Check high-priority pending tasks with low subject focus time
  const highPriorityPending = state.tasks.filter(
    (task) => !task.completed && task.priority === 'high',
  );
  for (const task of highPriorityPending) {
    if (recommendations.length >= 3) break;
    const subject = getSubject(task.subjectId);
    const subjMins = minutesBySubject.get(task.subjectId) ?? 0;
    const code = subject ? subject.code : 'General';
    recommendations.push({
      tone: 'indigo',
      badge: `${code} · High Priority`,
      title: `Prioritize "${task.title}" (${task.durationMinutes || 45}m est.)`,
      detail:
        subjMins === 0
          ? `No focus sessions logged for ${code} in the last 7 days. Launch a timer now to build momentum.`
          : `${formatDuration(subjMins)} logged for ${code} this week. Complete this high-priority deliverable next.`,
      actionLabel: 'Focus on Task →',
      actionType: 'focus-task',
      taskId: task.id,
    });
  }

  // 3. Check subjects that have pending tasks but 0 minutes logged this week
  for (const subject of state.subjects) {
    if (recommendations.length >= 3) break;
    const pendingForSubject = state.tasks.filter(
      (t) => !t.completed && t.subjectId === subject.id,
    );
    const subjMins = minutesBySubject.get(subject.id) ?? 0;
    if (pendingForSubject.length > 0 && subjMins === 0) {
      recommendations.push({
        tone: 'amber',
        badge: `${subject.code} · Course Balance`,
        title: `${subject.code} (${subject.name}) has 0m logged in the last 7 days`,
        detail: `You have ${pendingForSubject.length} pending task${pendingForSubject.length === 1 ? '' : 's'} waiting in ${subject.code}. Try a quick 25m Pomodoro sprint.`,
        actionLabel: `Start ${subject.code} Pomodoro →`,
        actionType: 'focus-subject',
        subjectId: subject.id,
        minutes: 25,
      });
    }
  }

  // 4. Positive reinforcement / daily goal check if fewer than 3 recommendations
  const todayMinutes = state.sessions
    .filter((s) => s.date === todayKey)
    .reduce((sum, s) => sum + (Number(s.durationMinutes) || 0), 0);

  if (recommendations.length < 3) {
    if (todayMinutes < CONFIG.dailyFocusGoalMinutes) {
      const remaining = CONFIG.dailyFocusGoalMinutes - todayMinutes;
      recommendations.push({
        tone: 'emerald',
        badge: 'Daily Goal Pacing',
        title: `${formatDuration(remaining)} away from your ${formatDuration(CONFIG.dailyFocusGoalMinutes)} daily target`,
        detail:
          todayMinutes > 0
            ? `Great progress with ${formatDuration(todayMinutes)} logged today. One more focused block will close the gap.`
            : 'Kick off your first focus session today to keep your academic streak alive.',
        actionLabel: 'Open Focus Timer →',
        actionType: 'open-focus',
      });
    } else {
      recommendations.push({
        tone: 'emerald',
        badge: 'Target Achieved',
        title: `Daily focus goal reached (${formatDuration(todayMinutes)} logged today)!`,
        detail:
          'You have exceeded your daily target. Review your upcoming calendar milestones or take a well-earned break.',
        actionLabel: 'View Calendar →',
        actionType: 'open-calendar',
      });
    }
  }

  return recommendations.slice(0, 3);
}

function renderAnalyticsView() {
  if (!refs.analyticsView) return;

  const now = new Date();
  const todayKey = toDateKey(now);
  const windowInfo = getAnalyticsDateWindow(state.analytics.range, now);
  const rangeSessions = getFilteredAnalyticsSessions(windowInfo);

  // Range toggle buttons state
  if (refs.analyticsRangeButtons) {
    for (const btn of refs.analyticsRangeButtons) {
      const active = btn.dataset.analyticsRange === state.analytics.range;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }
  }

  // Total focus minutes in selected range
  const totalRangeMinutes = rangeSessions.reduce(
    (sum, s) => sum + (Number(s.durationMinutes) || 0),
    0,
  );
  const avgDailyMinutes = Math.round(totalRangeMinutes / Math.max(1, windowInfo.daysCount));
  const rangeGoalMinutes = CONFIG.dailyFocusGoalMinutes * Math.max(1, windowInfo.daysCount);
  const goalPct = Math.min(
    100,
    Math.round((totalRangeMinutes / Math.max(60, rangeGoalMinutes)) * 100),
  );

  // Header summary pill
  if (refs.analyticsSummaryPill) {
    refs.analyticsSummaryPill.textContent = `${windowInfo.label} · ${formatDuration(totalRangeMinutes)} across ${rangeSessions.length} session${rangeSessions.length === 1 ? '' : 's'}`;
  }

  // KPI 1: Total Focus Hours
  if (refs.analyticsKpiHours) {
    refs.analyticsKpiHours.textContent = formatDuration(totalRangeMinutes);
  }
  if (refs.analyticsKpiGoalBar) {
    refs.analyticsKpiGoalBar.style.width = `${goalPct}%`;
  }
  if (refs.analyticsKpiDailyAvg) {
    refs.analyticsKpiDailyAvg.textContent = `${formatDuration(avgDailyMinutes)} / day avg`;
  }

  // KPI 2: Task Completion Rate
  const totalTasks = state.tasks.length;
  const completedTasks = state.tasks.filter((t) => t.completed).length;
  const completionPct = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);
  if (refs.analyticsKpiCompletionPct) {
    refs.analyticsKpiCompletionPct.textContent = `${completionPct}%`;
  }
  if (refs.analyticsKpiCompletionBar) {
    refs.analyticsKpiCompletionBar.style.width = `${completionPct}%`;
  }
  if (refs.analyticsKpiCompletionCounts) {
    refs.analyticsKpiCompletionCounts.textContent = `${completedTasks} of ${totalTasks} tasks completed`;
  }

  // KPI 3: Current Study Streak
  const streakInfo = calculateStudyStreak(now);
  if (refs.analyticsKpiStreakDays) {
    refs.analyticsKpiStreakDays.textContent = String(streakInfo.streak);
  }
  if (refs.analyticsKpiStreakUnit) {
    refs.analyticsKpiStreakUnit.textContent =
      streakInfo.streak === 1 ? 'Consecutive Day' : 'Consecutive Days';
  }
  if (refs.analyticsKpiStreakMeta) {
    refs.analyticsKpiStreakMeta.textContent = streakInfo.activeToday
      ? `Active today · ${streakInfo.activeDatesCount} total study day${streakInfo.activeDatesCount === 1 ? '' : 's'} logged`
      : streakInfo.streak > 0
        ? 'Log a session today to extend your streak'
        : 'Log a session or complete a task to start a streak';
  }

  // Aggregate minutes per subject across rangeSessions
  const subjectTotals = new Map();
  for (const subject of state.subjects) {
    subjectTotals.set(subject.id, {
      subject,
      minutes: 0,
      sessionsCount: 0,
    });
  }

  let unassignedMinutes = 0;
  let unassignedCount = 0;

  for (const session of rangeSessions) {
    const mins = Number(session.durationMinutes) || 0;
    if (session.subjectId && subjectTotals.has(session.subjectId)) {
      const entry = subjectTotals.get(session.subjectId);
      entry.minutes += mins;
      entry.sessionsCount += 1;
    } else {
      unassignedMinutes += mins;
      unassignedCount += 1;
    }
  }

  const sortedSubjects = [...subjectTotals.values()].sort(
    (a, b) => b.minutes - a.minutes || a.subject.code.localeCompare(b.subject.code),
  );

  // KPI 4: Top Subject by Focus
  const topEntry = sortedSubjects[0];
  if (topEntry && topEntry.minutes > 0) {
    const topShare =
      totalRangeMinutes > 0 ? Math.round((topEntry.minutes / totalRangeMinutes) * 100) : 0;
    if (refs.analyticsKpiTopBadge) {
      refs.analyticsKpiTopBadge.className = `course-tag ${toneClass(topEntry.subject.tone)}`;
      refs.analyticsKpiTopBadge.textContent = topEntry.subject.code;
    }
    if (refs.analyticsKpiTopHours) {
      refs.analyticsKpiTopHours.textContent = formatDuration(topEntry.minutes);
    }
    if (refs.analyticsKpiTopShare) {
      refs.analyticsKpiTopShare.textContent = `${topShare}% Share`;
    }
    if (refs.analyticsKpiTopName) {
      refs.analyticsKpiTopName.textContent = `${topEntry.subject.name} · ${topEntry.sessionsCount} session${topEntry.sessionsCount === 1 ? '' : 's'}`;
    }
  } else {
    if (refs.analyticsKpiTopBadge) {
      refs.analyticsKpiTopBadge.className = 'course-tag tag-blue';
      refs.analyticsKpiTopBadge.textContent = 'None';
    }
    if (refs.analyticsKpiTopHours) {
      refs.analyticsKpiTopHours.textContent = '0m';
    }
    if (refs.analyticsKpiTopShare) {
      refs.analyticsKpiTopShare.textContent = '0% Share';
    }
    if (refs.analyticsKpiTopName) {
      refs.analyticsKpiTopName.textContent = 'Log a focus session to see your top course';
    }
  }

  // Main Chart 1: Daily Focus Hours Trend
  if (refs.analyticsTrendSubtitle) {
    refs.analyticsTrendSubtitle.textContent =
      windowInfo.range === '7d'
        ? 'Logged study time over the last 7 days'
        : windowInfo.range === '14d'
          ? 'Logged study time over the last 14 days'
          : `Logged study time across ${windowInfo.dateKeys.length} recent days`;
  }
  if (refs.analyticsTrendTotalBadge) {
    refs.analyticsTrendTotalBadge.textContent = `${formatDecimalHours(totalRangeMinutes)} Total`;
  }

  if (refs.analyticsTrendChart) {
    const minutesByDay = new Map();
    for (const session of rangeSessions) {
      if (!session.date) continue;
      minutesByDay.set(
        session.date,
        (minutesByDay.get(session.date) ?? 0) + (Number(session.durationMinutes) || 0),
      );
    }

    const dailyRows = windowInfo.dateKeys.map((dateKey) => {
      const [y, m, d] = dateKey.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d);
      const shortDay = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
      const shortDate = dateObj.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      return {
        dateKey,
        shortDay,
        shortDate,
        minutes: minutesByDay.get(dateKey) ?? 0,
        isToday: dateKey === todayKey,
      };
    });

    const maxDayMinutes = Math.max(
      CONFIG.dailyFocusGoalMinutes,
      ...dailyRows.map((r) => r.minutes),
      60,
    );

    refs.analyticsTrendChart.style.setProperty(
      '--trend-cols',
      String(dailyRows.length),
    );

    refs.analyticsTrendChart.innerHTML = dailyRows
      .map((row) => {
        const heightPct =
          row.minutes === 0
            ? 4
            : Math.max(10, Math.min(100, Math.round((row.minutes / maxDayMinutes) * 100)));
        const valueLabel = row.minutes > 0 ? formatDecimalHours(row.minutes) : '0h';
        const dayLabel =
          dailyRows.length <= 7
            ? row.isToday
              ? 'Today'
              : row.shortDay
            : row.isToday
              ? 'Today'
              : row.shortDate.replace(' ', '/');
        const tooltip = `${row.shortDay}, ${row.shortDate}: ${formatDuration(row.minutes)}`;

        return `<div class="analytics-bar-col${row.isToday ? ' is-today' : ''}${row.minutes === 0 ? ' is-zero' : ''}" title="${escapeHtml(tooltip)}">
          <span class="analytics-bar-value">${escapeHtml(valueLabel)}</span>
          <div class="analytics-bar-track">
            <div class="analytics-bar-fill" style="height: ${heightPct}%"></div>
          </div>
          <span class="analytics-bar-day">${escapeHtml(dayLabel)}</span>
        </div>`;
      })
      .join('');
  }

  // Main Chart 2: Subject Time Distribution
  const activeCourseCount = sortedSubjects.filter((item) => item.minutes > 0).length;
  if (refs.analyticsDistCoursesCount) {
    refs.analyticsDistCoursesCount.textContent = `${activeCourseCount} of ${state.subjects.length} Active Course${state.subjects.length === 1 ? '' : 's'}`;
  }

  if (refs.analyticsSubjectStackedBar) {
    if (totalRangeMinutes <= 0) {
      refs.analyticsSubjectStackedBar.innerHTML =
        '<div class="analytics-stacked-empty" title="No focus time logged in this window"></div>';
    } else {
      const segments = sortedSubjects
        .filter((item) => item.minutes > 0)
        .map((item) => {
          const pct = Math.max(3, Math.round((item.minutes / totalRangeMinutes) * 100));
          const color = TONE_COLOR_HEX[item.subject.tone] || TONE_COLOR_HEX.blue;
          return `<div class="analytics-stacked-segment" style="width: ${pct}%; background: ${color}" title="${escapeHtml(item.subject.code)}: ${escapeHtml(formatDuration(item.minutes))} (${pct}%)"></div>`;
        });
      if (unassignedMinutes > 0) {
        const pct = Math.max(3, Math.round((unassignedMinutes / totalRangeMinutes) * 100));
        segments.push(
          `<div class="analytics-stacked-segment" style="width: ${pct}%; background: #6B7280" title="General: ${escapeHtml(formatDuration(unassignedMinutes))} (${pct}%)"></div>`,
        );
      }
      refs.analyticsSubjectStackedBar.innerHTML = segments.join('');
    }
  }

  if (refs.analyticsSubjectDistList) {
    if (state.subjects.length === 0) {
      refs.analyticsSubjectDistList.innerHTML = `<li class="task-empty">No subjects available yet. Add a course in Subjects & Courses.</li>`;
    } else {
      refs.analyticsSubjectDistList.innerHTML = sortedSubjects
        .map(({ subject, minutes, sessionsCount }) => {
          const pct =
            totalRangeMinutes > 0 ? Math.round((minutes / totalRangeMinutes) * 100) : 0;
          const color = TONE_COLOR_HEX[subject.tone] || TONE_COLOR_HEX.blue;
          return `<li class="analytics-subject-item">
            <div class="analytics-subject-item-top">
              <div class="analytics-subject-name-wrap">
                <span class="course-tag ${toneClass(subject.tone)}">${escapeHtml(subject.code)}</span>
                <span class="analytics-subject-name">${escapeHtml(subject.name)}</span>
              </div>
              <div class="analytics-subject-stats">
                <span class="analytics-subject-hours">${escapeHtml(formatDuration(minutes))}</span>
                <span class="analytics-subject-pct">${pct}%</span>
              </div>
            </div>
            <div class="analytics-subject-bar-track">
              <div class="analytics-subject-bar-fill" style="width: ${pct}%; background: ${color}"></div>
            </div>
            <div class="analytics-subject-meta">
              <span>${sessionsCount} session${sessionsCount === 1 ? '' : 's'} logged</span>
              <span>${minutes > 0 ? `${Math.round(minutes / Math.max(1, sessionsCount))}m avg session` : 'No sessions in range'}</span>
            </div>
          </li>`;
        })
        .join('');
    }
  }

  // Bottom Left: Smart Study Recommendations
  if (refs.analyticsRecommendationsList) {
    const recs = buildSmartRecommendations(now);
    refs.analyticsRecommendationsList.innerHTML = recs
      .map(
        (rec) => `<li class="analytics-rec-card tone-${escapeHtml(rec.tone)}">
        <div class="analytics-rec-top">
          <span class="analytics-rec-badge">${escapeHtml(rec.badge)}</span>
          <button
            type="button"
            class="btn-link analytics-rec-action"
            data-rec-action="${escapeHtml(rec.actionType)}"
            ${rec.subjectId ? `data-subject-id="${escapeHtml(rec.subjectId)}"` : ''}
            ${rec.taskId ? `data-task-id="${escapeHtml(rec.taskId)}"` : ''}
            ${rec.minutes ? `data-minutes="${escapeHtml(String(rec.minutes))}"` : ''}
          >
            ${escapeHtml(rec.actionLabel)}
          </button>
        </div>
        <p class="analytics-rec-title">${escapeHtml(rec.title)}</p>
        <p class="analytics-rec-detail">${escapeHtml(rec.detail)}</p>
      </li>`,
      )
      .join('');
  }

  // Bottom Right: Recent Focus Sessions Log
  if (refs.analyticsSessionsList) {
    const subjFilter = state.analytics.sessionSubjectFilter || 'all';
    const filteredSessions = rangeSessions
      .filter((s) => subjFilter === 'all' || s.subjectId === subjFilter)
      .sort(
        (a, b) =>
          (b.date || '').localeCompare(a.date || '') ||
          (b.completedAt || 0) - (a.completedAt || 0),
      );

    if (filteredSessions.length === 0) {
      refs.analyticsSessionsList.innerHTML = `<li class="task-empty">
        <p class="task-empty-title">No focus sessions match this filter</p>
        <p class="task-empty-sub">Use "+ Log Study Session" above or run the Focus Timer to record study blocks.</p>
      </li>`;
    } else {
      refs.analyticsSessionsList.innerHTML = filteredSessions
        .map((session) => {
          const subject = getSubject(session.subjectId);
          const tagClass = subject ? toneClass(subject.tone) : 'tag-blue';
          const tagCode = subject ? subject.code : 'GEN';
          const dateLabel =
            session.date === todayKey
              ? 'Today'
              : formatDueLabelFromDate(session.date) || session.date;
          const timeStamp = session.completedAt
            ? new Date(session.completedAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })
            : '';

          return `<li class="analytics-session-item" data-session-id="${escapeHtml(session.id)}">
            <span class="course-tag ${tagClass}">${escapeHtml(tagCode)}</span>
            <div class="analytics-session-info">
              <p class="analytics-session-title">${escapeHtml(session.title || 'Focus Session')}</p>
              <span class="analytics-session-meta">${escapeHtml(dateLabel)}${timeStamp ? ` · ${escapeHtml(timeStamp)}` : ''}</span>
            </div>
            <span class="analytics-session-duration">${escapeHtml(formatDuration(session.durationMinutes))}</span>
            <button
              type="button"
              class="btn-icon-action is-danger"
              data-action="delete-analytics-session"
              data-session-id="${escapeHtml(session.id)}"
              aria-label="Delete focus session"
              title="Delete session"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </li>`;
        })
        .join('');
    }
  }
}

function toggleAnalyticsLogForm(forceOpen) {
  if (!refs.analyticsLogForm) return;
  const shouldOpen =
    typeof forceOpen === 'boolean' ? forceOpen : refs.analyticsLogForm.hidden;
  refs.analyticsLogForm.hidden = !shouldOpen;
  if (shouldOpen) {
    if (refs.analyticsLogDate && !refs.analyticsLogDate.value) {
      refs.analyticsLogDate.value = toDateKey();
    }
    refs.analyticsLogTitle?.focus();
  }
}

async function handleAnalyticsLogFormSubmit(event) {
  event.preventDefault();
  const subjectId = refs.analyticsLogSubject?.value || defaultSubjectId();
  const rawTitle = refs.analyticsLogTitle?.value.trim() || '';
  const dateVal =
    refs.analyticsLogDate?.value && /^\d{4}-\d{2}-\d{2}$/.test(refs.analyticsLogDate.value)
      ? refs.analyticsLogDate.value
      : toDateKey();
  const durationMinutes = clampFocusMinutes(refs.analyticsLogDuration?.value, 45);
  const subject = getSubject(subjectId);
  const title = rawTitle || (subject ? `${subject.code} Study Session` : 'Study Session');

  const saved = await recordAndSyncFocusSession({
    subjectId,
    taskId: null,
    durationMinutes,
    title,
    mode: 'manual',
    date: dateVal,
  });

  if (saved) {
    if (refs.analyticsLogTitle) refs.analyticsLogTitle.value = '';
    if (refs.analyticsLogDuration) refs.analyticsLogDuration.value = '45';
    toggleAnalyticsLogForm(false);
    showToast(`Logged ${durationMinutes}m session for ${subject ? subject.code : 'Study'}!`);
  }
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

function handleCalendarAgendaClick(event) {
  const editEventBtn = event.target.closest('[data-action="edit-event"]');
  if (editEventBtn) {
    const ev = state.events.find((item) => item.id === editEventBtn.dataset.eventId);
    if (ev) openEventModal({ eventItem: ev });
    return;
  }

  const deleteEventBtn = event.target.closest('[data-action="delete-event"]');
  if (deleteEventBtn) {
    handleDeleteEvent(deleteEventBtn.dataset.eventId);
    return;
  }

  const focusTaskBtn = event.target.closest('[data-action="focus-calendar-task"]');
  if (focusTaskBtn) {
    const task = state.tasks.find((item) => item.id === focusTaskBtn.dataset.taskId);
    if (task) requestFocusSession(task);
    return;
  }

  const editTaskBtn = event.target.closest('[data-action="edit-calendar-task"]');
  if (editTaskBtn) {
    const task = state.tasks.find((item) => item.id === editTaskBtn.dataset.taskId);
    if (task) openTaskModal({ task });
    return;
  }

  const addOnSelectedBtn = event.target.closest('[data-action="add-event-on-selected-day"]');
  if (addOnSelectedBtn) {
    openEventModal({ defaultDate: state.calendar.selectedDate });
    return;
  }

  const agendaCard = event.target.closest('.calendar-agenda-item[data-date]');
  if (agendaCard && agendaCard.dataset.date) {
    selectCalendarDate(agendaCard.dataset.date, { syncMonth: true });
  }
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

  window.addEventListener('hashchange', () => {
    applyHashRoute({ updateHash: false });
  });

  document.addEventListener('studyos:focus-request', handleFocusRequestEvent);

  refs.taskList.addEventListener('change', handleTaskListChange);
  refs.taskList.addEventListener('click', handleTaskListClick);

  if (refs.fullTasksList) {
    refs.fullTasksList.addEventListener('change', handleTaskListChange);
    refs.fullTasksList.addEventListener('click', handleTaskListClick);
  }

  if (refs.dashboardDeadlineList) {
    refs.dashboardDeadlineList.addEventListener('click', (event) => {
      const row = event.target.closest('.deadline-item[data-date]');
      if (!row) return;
      selectCalendarDate(row.dataset.date, { syncMonth: true });
      switchView('calendar');
    });
  }

  if (refs.dashboardWeekChart) {
    refs.dashboardWeekChart.addEventListener('click', () => {
      switchView('analytics');
    });
  }

  // Analytics & Study Insights events
  if (refs.analyticsRangeGroup) {
    refs.analyticsRangeGroup.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-analytics-range]');
      if (!btn) return;
      state.analytics.range = btn.dataset.analyticsRange;
      renderAnalyticsView();
    });
  }

  if (refs.analyticsLogSessionBtn) {
    refs.analyticsLogSessionBtn.addEventListener('click', () => {
      toggleAnalyticsLogForm();
    });
  }

  if (refs.analyticsLogCancelBtn) {
    refs.analyticsLogCancelBtn.addEventListener('click', () => {
      toggleAnalyticsLogForm(false);
    });
  }

  if (refs.analyticsLogForm) {
    refs.analyticsLogForm.addEventListener('submit', handleAnalyticsLogFormSubmit);
  }

  if (refs.analyticsSessionsSubjectFilter) {
    refs.analyticsSessionsSubjectFilter.addEventListener('change', () => {
      state.analytics.sessionSubjectFilter = refs.analyticsSessionsSubjectFilter.value;
      renderAnalyticsView();
    });
  }

  if (refs.analyticsSessionsList) {
    refs.analyticsSessionsList.addEventListener('click', (event) => {
      const delBtn = event.target.closest('[data-action="delete-analytics-session"]');
      if (delBtn) {
        handleDeleteFocusSession(delBtn.dataset.sessionId);
      }
    });
  }

  if (refs.analyticsRecommendationsList) {
    refs.analyticsRecommendationsList.addEventListener('click', (event) => {
      const actionBtn = event.target.closest('[data-rec-action]');
      if (!actionBtn) return;
      const action = actionBtn.dataset.recAction;
      if (action === 'focus-task' && actionBtn.dataset.taskId) {
        const task = state.tasks.find((t) => t.id === actionBtn.dataset.taskId);
        if (task) requestFocusSession(task);
      } else if (action === 'focus-subject') {
        const subjectId = actionBtn.dataset.subjectId || defaultSubjectId();
        const mins = Number(actionBtn.dataset.minutes) || 25;
        state.focus.subjectId = subjectId;
        state.focus.taskId = null;
        selectFocusMode(mins === 50 ? 'deep' : 'pomodoro', mins);
        switchView('focus');
      } else if (action === 'open-focus') {
        switchView('focus');
      } else if (action === 'open-calendar') {
        switchView('calendar');
      }
    });
  }

  // Academic Calendar controls & grid
  if (refs.calendarPrevBtn) {
    refs.calendarPrevBtn.addEventListener('click', () => shiftCalendarMonth(-1));
  }
  if (refs.calendarNextBtn) {
    refs.calendarNextBtn.addEventListener('click', () => shiftCalendarMonth(1));
  }
  if (refs.calendarTodayBtn) {
    refs.calendarTodayBtn.addEventListener('click', jumpCalendarToToday);
  }
  if (refs.calendarAddEventBtn) {
    refs.calendarAddEventBtn.addEventListener('click', () =>
      openEventModal({ defaultDate: state.calendar.selectedDate }),
    );
  }
  if (refs.calendarAddSelectedDayBtn) {
    refs.calendarAddSelectedDayBtn.addEventListener('click', () =>
      openEventModal({ defaultDate: state.calendar.selectedDate }),
    );
  }

  if (refs.calendarCategoryGroup) {
    refs.calendarCategoryGroup.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-cal-filter]');
      if (!btn) return;
      state.calendar.category = btn.dataset.calFilter;
      renderCalendarView();
    });
  }

  if (refs.calendarDaysGrid) {
    refs.calendarDaysGrid.addEventListener('click', (event) => {
      const cell = event.target.closest('.calendar-day-cell[data-date]');
      if (!cell) return;
      selectCalendarDate(cell.dataset.date, { syncMonth: true });
    });

    refs.calendarDaysGrid.addEventListener('dblclick', (event) => {
      const cell = event.target.closest('.calendar-day-cell[data-date]');
      if (!cell) return;
      selectCalendarDate(cell.dataset.date, { syncMonth: true });
      openEventModal({ defaultDate: cell.dataset.date });
    });

    refs.calendarDaysGrid.addEventListener('keydown', (event) => {
      const cell = event.target.closest('.calendar-day-cell[data-date]');
      if (!cell) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectCalendarDate(cell.dataset.date, { syncMonth: true });
      }
    });
  }

  if (refs.calendarSelectedDayList) {
    refs.calendarSelectedDayList.addEventListener('click', handleCalendarAgendaClick);
  }
  if (refs.calendarUpcomingList) {
    refs.calendarUpcomingList.addEventListener('click', handleCalendarAgendaClick);
  }

  if (refs.eventForm) {
    refs.eventForm.addEventListener('submit', handleEventFormSubmit);
  }
  if (refs.eventCancelBtn) {
    refs.eventCancelBtn.addEventListener('click', closeEventModal);
  }
  if (refs.eventModalClose) {
    refs.eventModalClose.addEventListener('click', closeEventModal);
  }
  if (refs.eventModal) {
    refs.eventModal.addEventListener('click', (event) => {
      if (event.target === refs.eventModal) closeEventModal();
    });
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

  // Focus Mode events
  if (refs.focusModePills) {
    refs.focusModePills.addEventListener('click', (event) => {
      const pill = event.target.closest('.focus-mode-pill[data-focus-mode]');
      if (!pill) return;
      const mode = pill.dataset.focusMode;
      const mins = Number(pill.dataset.minutes) || 25;
      selectFocusMode(mode, mins);
    });
  }

  const applyCustomFocusMinutes = () => {
    if (!refs.focusCustomMinutes) return;
    const clamped = clampFocusMinutes(refs.focusCustomMinutes.value, 30);
    refs.focusCustomMinutes.value = String(clamped);
    selectFocusMode('custom', clamped);
  };

  if (refs.focusCustomApplyBtn) {
    refs.focusCustomApplyBtn.addEventListener('click', applyCustomFocusMinutes);
  }

  if (refs.focusCustomMinutes) {
    refs.focusCustomMinutes.addEventListener('change', applyCustomFocusMinutes);
    refs.focusCustomMinutes.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyCustomFocusMinutes();
      }
    });
  }

  if (refs.focusTaskSelect) {
    refs.focusTaskSelect.addEventListener('change', () => {
      const taskId = refs.focusTaskSelect.value || null;
      state.focus.taskId = taskId;
      if (taskId) {
        const task = state.tasks.find((item) => item.id === taskId);
        if (task) {
          if (task.subjectId) {
            state.focus.subjectId = task.subjectId;
            if (refs.focusSubjectSelect) refs.focusSubjectSelect.value = task.subjectId;
          }
        }
      }
      renderSubjectSelection();
      populateFocusSelects();
      renderFocusBoundContext();
    });
  }

  if (refs.focusSubjectSelect) {
    refs.focusSubjectSelect.addEventListener('change', () => {
      const nextSubjId = refs.focusSubjectSelect.value || null;
      state.focus.subjectId = nextSubjId;
      if (state.focus.taskId) {
        const task = state.tasks.find((item) => item.id === state.focus.taskId);
        if (task && (task.subjectId || null) !== nextSubjId) {
          state.focus.taskId = null;
          if (refs.focusTaskSelect) refs.focusTaskSelect.value = '';
        }
      }
      renderSubjectSelection();
      populateFocusSelects();
      renderFocusBoundContext();
    });
  }

  if (refs.focusMarkTaskDoneBtn) {
    refs.focusMarkTaskDoneBtn.addEventListener('click', async () => {
      if (!state.focus.taskId) return;
      const taskId = state.focus.taskId;
      const updated = await toggleTask(taskId);
      if (updated && updated.completed) {
        state.focus.taskId = null;
        renderFocusView();
        showToast(`Completed "${updated.title}"!`);
      }
    });
  }

  if (refs.focusStartPauseBtn) {
    refs.focusStartPauseBtn.addEventListener('click', () => {
      focusTimer.toggle();
    });
  }

  if (refs.focusResetBtn) {
    refs.focusResetBtn.addEventListener('click', () => {
      focusTimer.reset();
    });
  }

  if (refs.focusCompleteLogBtn) {
    refs.focusCompleteLogBtn.addEventListener('click', () => {
      handleCompleteAndLogEarly();
    });
  }

  if (refs.focusZenBtn) {
    refs.focusZenBtn.addEventListener('click', () => {
      setZenMode(!state.focus.zenMode);
    });
  }

  if (refs.focusMuteBtn) {
    refs.focusMuteBtn.addEventListener('click', () => {
      setFocusMuted(!state.focus.muted);
    });
  }

  if (refs.focusToggleManualBtn && refs.focusManualForm) {
    refs.focusToggleManualBtn.addEventListener('click', () => {
      const isHidden = refs.focusManualForm.hidden;
      refs.focusManualForm.hidden = !isHidden;
      refs.focusToggleManualBtn.setAttribute('aria-expanded', String(!refs.focusManualForm.hidden));
      if (!refs.focusManualForm.hidden) {
        refs.focusManualTitle?.focus();
      }
    });
  }

  if (refs.focusManualForm) {
    refs.focusManualForm.addEventListener('submit', handleManualSessionSubmit);
  }

  if (refs.focusHistoryList) {
    refs.focusHistoryList.addEventListener('click', (event) => {
      const delBtn = event.target.closest('[data-action="delete-session"]');
      if (delBtn) {
        handleDeleteFocusSession(delBtn.dataset.sessionId);
      }
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
    if (event.key === 'Escape' && state.focus.zenMode && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      setZenMode(false);
      showToast('Exited Zen Mode.');
      return;
    }

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
      if (state.view === 'calendar') {
        openEventModal({ defaultDate: state.calendar.selectedDate });
      } else {
        openTaskModal();
      }
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
    focusView: byId('focus-view'),
    focusTodayTotalPill: byId('focus-today-total-pill'),
    focusMuteBtn: byId('focus-mute-btn'),
    focusMuteLabel: byId('focus-mute-label'),
    focusZenBtn: byId('focus-zen-btn'),
    focusZenLabel: byId('focus-zen-label'),
    focusTaskSelect: byId('focus-task-select'),
    focusSubjectSelect: byId('focus-subject-select'),
    focusMarkTaskDoneBtn: byId('focus-mark-task-done-btn'),
    focusModePills: byId('focus-mode-pills'),
    focusCustomMinutes: byId('focus-custom-minutes'),
    focusCustomApplyBtn: byId('focus-custom-apply-btn'),
    focusRingContainer: byId('focus-ring-container'),
    focusRingProgress: byId('focus-ring-progress'),
    focusStatusPill: byId('focus-status-pill'),
    focusTimerDisplay: byId('focus-timer-display'),
    focusBoundTag: byId('focus-bound-tag'),
    focusBoundTitle: byId('focus-bound-title'),
    focusElapsedDisplay: byId('focus-elapsed-display'),
    focusStartPauseBtn: byId('focus-start-pause-btn'),
    focusStartPauseGlyph: byId('focus-start-pause-glyph'),
    focusStartPauseLabel: byId('focus-start-pause-label'),
    focusResetBtn: byId('focus-reset-btn'),
    focusCompleteLogBtn: byId('focus-complete-log-btn'),
    focusHistorySummary: byId('focus-history-summary'),
    focusToggleManualBtn: byId('focus-toggle-manual-btn'),
    focusManualForm: byId('focus-manual-form'),
    focusManualSubject: byId('focus-manual-subject'),
    focusManualTitle: byId('focus-manual-title'),
    focusManualDuration: byId('focus-manual-duration'),
    focusHistoryList: byId('focus-history-list'),
    calendarView: byId('calendar-view'),
    calendarSummaryPill: byId('calendar-summary-pill'),
    calendarPrevBtn: byId('calendar-prev-btn'),
    calendarTodayBtn: byId('calendar-today-btn'),
    calendarNextBtn: byId('calendar-next-btn'),
    calendarMonthLabel: byId('calendar-month-label'),
    calendarAddEventBtn: byId('calendar-add-event-btn'),
    calendarCategoryGroup: byId('calendar-category-group'),
    calendarCategoryButtons: [...document.querySelectorAll('[data-cal-filter]')],
    calendarDaysGrid: byId('calendar-days-grid'),
    calendarSelectedDayTitle: byId('calendar-selected-day-title'),
    calendarSelectedDayMeta: byId('calendar-selected-day-meta'),
    calendarAddSelectedDayBtn: byId('calendar-add-selected-day-btn'),
    calendarSelectedDayList: byId('calendar-selected-day-list'),
    calendarUpcomingTitle: byId('calendar-upcoming-title'),
    calendarUpcomingCount: byId('calendar-upcoming-count'),
    calendarUpcomingList: byId('calendar-upcoming-list'),
    eventModal: byId('event-modal'),
    eventForm: byId('event-form'),
    eventModalTitle: byId('event-modal-title'),
    eventModalClose: byId('event-modal-close'),
    eventIdInput: byId('event-id-input'),
    eventTitleInput: byId('event-title-input'),
    eventTypeSelect: byId('event-type-select'),
    eventSubjectSelect: byId('event-subject-select'),
    eventDateInput: byId('event-date-input'),
    eventTimeInput: byId('event-time-input'),
    eventLocationInput: byId('event-location-input'),
    eventNotesInput: byId('event-notes-input'),
    eventFormError: byId('event-form-error'),
    eventCancelBtn: byId('event-cancel-btn'),
    eventSaveBtn: byId('event-save-btn'),
    analyticsView: byId('analytics-view'),
    analyticsSummaryPill: byId('analytics-summary-pill'),
    analyticsRangeGroup: byId('analytics-range-group'),
    analyticsRangeButtons: [...document.querySelectorAll('[data-analytics-range]')],
    analyticsLogSessionBtn: byId('analytics-log-session-btn'),
    analyticsLogForm: byId('analytics-log-form'),
    analyticsLogCancelBtn: byId('analytics-log-cancel-btn'),
    analyticsLogSubject: byId('analytics-log-subject'),
    analyticsLogTitle: byId('analytics-log-title'),
    analyticsLogDate: byId('analytics-log-date'),
    analyticsLogDuration: byId('analytics-log-duration'),
    analyticsKpiHours: byId('analytics-kpi-hours'),
    analyticsKpiGoalBar: byId('analytics-kpi-goal-bar'),
    analyticsKpiDailyAvg: byId('analytics-kpi-daily-avg'),
    analyticsKpiCompletionPct: byId('analytics-kpi-completion-pct'),
    analyticsKpiCompletionBar: byId('analytics-kpi-completion-bar'),
    analyticsKpiCompletionCounts: byId('analytics-kpi-completion-counts'),
    analyticsKpiStreakDays: byId('analytics-kpi-streak-days'),
    analyticsKpiStreakUnit: byId('analytics-kpi-streak-unit'),
    analyticsKpiStreakMeta: byId('analytics-kpi-streak-meta'),
    analyticsKpiTopBadge: byId('analytics-kpi-top-badge'),
    analyticsKpiTopHours: byId('analytics-kpi-top-hours'),
    analyticsKpiTopShare: byId('analytics-kpi-top-share'),
    analyticsKpiTopName: byId('analytics-kpi-top-name'),
    analyticsTrendSubtitle: byId('analytics-trend-subtitle'),
    analyticsTrendTotalBadge: byId('analytics-trend-total-badge'),
    analyticsTrendChart: byId('analytics-trend-chart'),
    analyticsDistCoursesCount: byId('analytics-dist-courses-count'),
    analyticsSubjectStackedBar: byId('analytics-subject-stacked-bar'),
    analyticsSubjectDistList: byId('analytics-subject-dist-list'),
    analyticsRecommendationsList: byId('analytics-recommendations-list'),
    analyticsSessionsSubjectFilter: byId('analytics-sessions-subject-filter'),
    analyticsSessionsList: byId('analytics-sessions-list'),
    weeklyTotalLabel: byId('weekly-total-label'),
    dashboardWeekChart: byId('dashboard-week-chart'),
    greeting: byId('greeting-title'),
    dateDisplay: byId('current-date-display'),
    tasksDone: byId('metric-tasks-done'),
    tasksTotal: byId('metric-tasks-total'),
    tasksBar: byId('metric-tasks-bar'),
    tasksPct: byId('metric-tasks-pct'),
    focusLogged: byId('metric-focus-logged'),
    focusBar: byId('metric-focus-bar'),
    focusGoal: byId('metric-focus-goal'),
    statExamCard: byId('stat-exam-card'),
    nextExamTag: byId('next-exam-tag'),
    nextExamLabel: byId('next-exam-label'),
    nextExamPriority: byId('next-exam-priority'),
    nextExamCountdown: byId('next-exam-countdown'),
    metricExamDays: byId('metric-exam-days'),
    nextExamMeta: byId('next-exam-meta'),
    dashboardDeadlineList: byId('dashboard-deadline-list'),
    badgeTasks: byId('badge-tasks'),
    badgeSubjects: byId('badge-subjects'),
    badgeCalendar: byId('badge-calendar'),
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

  // Restore saved chime mute preference if available
  try {
    if (localStorage.getItem('studyos_focus_muted') === '1') {
      setFocusMuted(true);
    }
  } catch {
    // Ignore localStorage restrictions
  }

  // Immediately isolate the active view based on URL hash before async DB work
  applyHashRoute({ updateHash: false });

  renderHeader();
  setInterval(renderHeader, 60_000); // keep greeting/date right across the day
  bindEvents();

  try {
    await initDB();
    const [subjects, tasks, sessions, blocks, events] = await Promise.all([
      getAllSubjects(),
      getAllTasks(),
      getAllSessions(),
      getScheduleBlocks(),
      getAllEvents(),
    ]);

    Object.assign(state, { subjects, tasks, sessions, blocks, events });
    if (!state.focus.subjectId && subjects.length > 0) {
      state.focus.subjectId = defaultSubjectId();
    }
    setStorageStatus(true);

    renderSubjects();
    populateSubjectSelects();
    renderSubjectsView();
    renderFilters();
    renderTaskList();
    renderTasksView();
    renderFocusView();
    renderCalendarView();
    renderAnalyticsView();
    renderMetrics();
    renderPlannedBlocks();

    applyHashRoute({ updateHash: false });

    await ensureTodaysPlan();
    resolveReady();
  } catch (error) {
    console.warn('StudyOS: IndexedDB is unavailable.', error);
    setStorageStatus(false);
    populateSubjectSelects();
    renderSubjectsView();
    renderTaskList();
    renderTasksView();
    renderFocusView();
    renderCalendarView();
    renderAnalyticsView();
    renderPlannedBlocks();
    applyHashRoute({ updateHash: false });
    showToast('Local storage is unavailable, so changes cannot be saved.', { tone: 'error', duration: 6000 });
    rejectReady(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
