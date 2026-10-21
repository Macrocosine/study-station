// Browser-independent state, review scheduling and wall-clock timer logic.
export const SCHEMA_VERSION = 1;
const DAY = 86_400_000;
const LIMITS = { tasks: 2000, cards: 3000, notes: 1000, sessions: 10000 };
const DEFAULT_SETTINGS = { focusMinutes: 25, breakMinutes: 5, dailyGoal: 90 };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, min, max) => {
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  return numeric && Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
};
const text = (value, fallback = '', max = 12000) => typeof value === 'string' ? value.slice(0, max) : fallback;
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export function dayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new TypeError('日期无效');
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function validDay(value, fallback) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return dayKey(date) === value ? value : fallback;
}

function timestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) && result >= 0 && result <= 8_640_000_000_000_000 ? result : fallback;
}

function settingsOf(value = {}) {
  return {
    focusMinutes: Math.round(bounded(value.focusMinutes, 25, 1, 180)),
    breakMinutes: Math.round(bounded(value.breakMinutes, 5, 1, 60)),
    dailyGoal: Math.round(bounded(value.dailyGoal, 90, 5, 1440))
  };
}

function listOf(value, limit, transform, duplicateMode = 'renew') {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, limit).filter(plain).map(transform).filter(item => {
    if (seen.has(item.id)) {
      if (duplicateMode === 'skip') return false;
      item.id = uid('item');
    }
    seen.add(item.id);
    return true;
  });
}

export function createState(seed = {}, today = dayKey()) {
  const now = Date.now();
  const date = validDay(today, dayKey());
  return normalizeState({
    schemaVersion: SCHEMA_VERSION,
    tasks: (seed.tasks ?? []).map(task => ({ ...task, dueDate: task.dueDate || date })),
    cards: (seed.cards ?? []).map(card => ({ ...card, dueAt: card.dueAt ?? now })),
    notes: seed.notes ?? [],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    timer: { mode: 'focus', status: 'idle', remaining: 1500, endsAt: null, taskId: null }
  });
}

export function normalizeState(input, seed) {
  if (!plain(input)) throw new TypeError('学习数据必须是一个对象');
  const now = Date.now(), today = dayKey(), settings = settingsOf(plain(input.settings) ? input.settings : {});
  // Missing collections in a partial local state may be populated from the starter content.
  const source = name => Array.isArray(input[name]) ? input[name] : (seed?.[name] ?? []);
  const state = {
    schemaVersion: SCHEMA_VERSION,
    tasks: listOf(source('tasks'), LIMITS.tasks, item => ({
      id: text(item.id, uid('task'), 120), title: text(item.title, '未命名任务', 300),
      subject: text(item.subject, '其他', 60), minutes: Math.round(bounded(item.minutes, 25, 1, 180)),
      dueDate: validDay(item.dueDate, today), done: item.done === true,
      completedAt: timestamp(item.completedAt), createdAt: timestamp(item.createdAt, now)
    })),
    cards: listOf(source('cards'), LIMITS.cards, item => ({
      id: text(item.id, uid('card'), 120), subject: text(item.subject, '其他', 60),
      front: text(item.front, '', 4000), back: text(item.back, '', 12000),
      tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 12).map(tag => tag.slice(0, 60)) : [],
      dueAt: timestamp(item.dueAt, now), intervalDays: bounded(item.intervalDays, 0, 0, 3650),
      reviews: Math.floor(bounded(item.reviews, 0, 0, 1000000)), lastReviewed: timestamp(item.lastReviewed)
    })),
    notes: listOf(source('notes'), LIMITS.notes, item => ({
      id: text(item.id, uid('note'), 120), title: text(item.title, '未命名笔记', 300),
      subject: text(item.subject, '其他', 60), body: text(item.body, '', 100000),
      createdAt: timestamp(item.createdAt, now), updatedAt: timestamp(item.updatedAt, now)
    })),
    sessions: listOf(source('sessions'), LIMITS.sessions, item => ({
      id: text(item.id, uid('session'), 120), runId: text(item.runId, text(item.id, uid('run'), 120), 120),
      startedAt: timestamp(item.startedAt, now), endedAt: timestamp(item.endedAt, now),
      minutes: bounded(item.minutes, 0, 0, 1440), taskId: typeof item.taskId === 'string' ? item.taskId.slice(0, 120) : null,
      title: text(item.title, '', 300), subject: text(item.subject, '', 60)
    }), 'skip'),
    settings,
    timer: null
  };
  const raw = plain(input.timer) ? input.timer : {};
  const mode = raw.mode === 'break' ? 'break' : 'focus';
  const defaultSeconds = (mode === 'focus' ? settings.focusMinutes : settings.breakMinutes) * 60;
  const status = ['running', 'paused', 'idle'].includes(raw.status) ? raw.status : 'idle';
  const endsAt = timestamp(raw.endsAt);
  state.timer = {
    mode, status: status === 'running' && endsAt === null ? 'paused' : status,
    remaining: Math.ceil(bounded(raw.remaining, defaultSeconds, 0, 10800)), endsAt,
    taskId: typeof raw.taskId === 'string' ? raw.taskId.slice(0, 120) : null,
    runId: typeof raw.runId === 'string' ? raw.runId.slice(0, 120) : null,
    startedAt: timestamp(raw.startedAt), durationSeconds: Math.ceil(bounded(raw.durationSeconds, defaultSeconds, 1, 10800))
  };
  const runIds = new Set();
  state.sessions = state.sessions.filter(session => {
    if (runIds.has(session.runId)) return false;
    runIds.add(session.runId);
    return true;
  });
  return state;
}

/** Simple deterministic interval ladder; this is not an FSRS/SM-2 implementation.
 * Again: 1 minute. Hard: at least 1 day, ×1.2. Good: 1 day then ×2.
 * Easy: at least 4 days, ×3. Review intervals are capped at 10 years.
 */
export function updateCard(card, rating, now = Date.now()) {
  if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new TypeError('复习评分无效');
  const current = bounded(card.intervalDays, 0, 0, 3650);
  const intervals = { again: 0, hard: Math.max(1, Math.round(current * 1.2)), good: Math.max(1, Math.round(current * 2)), easy: Math.max(4, Math.round(current * 3)) };
  const intervalDays = Math.min(3650, intervals[rating]);
  return { ...card, intervalDays, dueAt: now + (rating === 'again' ? 60000 : intervalDays * DAY), reviews: Math.floor(bounded(card.reviews, 0, 0, 1000000)) + 1, lastReviewed: now };
}

export function timerRemaining(timer, now = Date.now()) {
  if (timer.status === 'running' && Number.isFinite(timer.endsAt)) return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
  return Math.max(0, Math.ceil(Number(timer.remaining) || 0));
}

export function startTimer(timer, now = Date.now()) {
  if (timer.status === 'running') return { ...timer };
  const resume = timer.status === 'paused' && timer.runId;
  const remaining = resume ? timerRemaining(timer, now) : (timerRemaining(timer, now) || timer.durationSeconds || (timer.mode === 'break' ? 300 : 1500));
  return { ...timer, status: 'running', remaining, endsAt: now + remaining * 1000,
    runId: resume ? timer.runId : uid('run'), startedAt: resume ? timer.startedAt : now,
    durationSeconds: resume ? timer.durationSeconds : remaining };
}

export function pauseTimer(timer, now = Date.now()) {
  if (timer.status !== 'running') return { ...timer };
  const remaining = timerRemaining(timer, now);
  // Keep an expired run completeable if the pause click races the next timer tick.
  if (remaining === 0) return { ...timer };
  return { ...timer, status: 'paused', remaining, endsAt: null };
}

export function setTimerMode(timer, mode, settings = DEFAULT_SETTINGS) {
  const next = mode === 'break' ? 'break' : 'focus', preferences = settingsOf(settings);
  const remaining = (next === 'focus' ? preferences.focusMinutes : preferences.breakMinutes) * 60;
  return { ...timer, mode: next, status: 'idle', remaining, endsAt: null, runId: null, startedAt: null, durationSeconds: remaining };
}

export function completeTimer(state, now = Date.now()) {
  const timer = state.timer;
  if (timer.status !== 'running' || timerRemaining(timer, now) > 0) return state;
  const sessions = [...state.sessions];
  if (timer.mode === 'focus' && timer.runId && !sessions.some(session => session.runId === timer.runId)) {
    const task = state.tasks.find(item => item.id === timer.taskId);
    sessions.push({ id: uid('session'), runId: timer.runId, startedAt: timer.startedAt ?? now,
      endedAt: timer.endsAt ?? now, minutes: (timer.durationSeconds ?? state.settings.focusMinutes * 60) / 60,
      taskId: timer.taskId ?? null, title: task?.title ?? '', subject: task?.subject ?? '' });
  }
  return { ...state, sessions, timer: setTimerMode(timer, timer.mode === 'focus' ? 'break' : 'focus', state.settings) };
}

export function getStats(state, now = Date.now()) {
  const today = dayKey(now), minutes = new Map();
  for (const session of state.sessions) {
    const key = dayKey(timestamp(session.endedAt, now));
    minutes.set(key, (minutes.get(key) ?? 0) + bounded(session.minutes, 0, 0, 1440));
  }
  const week = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now); date.setDate(date.getDate() - offset);
    const key = dayKey(date); week.push({ date: key, minutes: minutes.get(key) ?? 0 });
  }
  let streak = 0, cursor = new Date(now);
  if (!(minutes.get(today) > 0)) cursor.setDate(cursor.getDate() - 1);
  for (let n = 0; n <= state.sessions.length; n++) {
    if (!(minutes.get(dayKey(cursor)) > 0)) break;
    streak++; cursor.setDate(cursor.getDate() - 1);
  }
  return {
    todayMinutes: minutes.get(today) ?? 0,
    completedTasks: state.tasks.filter(task => task.done && timestamp(task.completedAt) !== null && dayKey(timestamp(task.completedAt)) === today).length,
    dueCards: state.cards.filter(card => card.dueAt <= now).length, streak, week,
    totalMinutes: [...minutes.values()].reduce((sum, value) => sum + value, 0),
    totalSessions: state.sessions.length,
    totalReviews: state.cards.reduce((sum, card) => sum + (card.reviews || 0), 0),
    totalCompletedTasks: state.tasks.filter(task => task.done).length
  };
}

export function validateBackup(raw, seed) {
  if (typeof raw !== 'string' || raw.length > 5 * 1024 * 1024) throw new TypeError('备份文件过大或格式无效（上限 5 MB）');
  let data;
  try { data = JSON.parse(raw); } catch { throw new TypeError('备份不是有效的 JSON 文件'); }
  if (!plain(data) || data.app !== 'study-station' || data.version !== 1 || !plain(data.state)) throw new TypeError('请选择自习站导出的版本 1 备份');
  const state = data.state;
  if (state.schemaVersion !== SCHEMA_VERSION) throw new TypeError('备份的数据版本不受支持');
  if (!plain(state.settings) || !plain(state.timer)) throw new TypeError('备份中的设置或计时器格式无效');
  for (const [name, limit] of Object.entries(LIMITS)) {
    if (!Array.isArray(state[name]) || state[name].length > limit || state[name].some(item => !plain(item))) throw new TypeError(`备份中的 ${name} 数据格式无效或超出数量上限`);
  }
  const fields = {
    tasks: { id: 120, title: 300, subject: 60 },
    cards: { id: 120, subject: 60, front: 4000, back: 12000 },
    notes: { id: 120, subject: 60, title: 300, body: 100000 },
    sessions: { id: 120, runId: 120, taskId: 120, title: 300, subject: 60 }
  };
  for (const [name, limits] of Object.entries(fields)) {
    for (const item of state[name]) {
      for (const [field, max] of Object.entries(limits)) {
        if (item[field] != null && (typeof item[field] !== 'string' || item[field].length > max)) throw new TypeError(`备份中的 ${name}.${field} 无效或过长`);
      }
    }
  }
  const required = { tasks: ['id', 'title'], cards: ['id', 'front', 'back'], notes: ['id', 'title', 'body'], sessions: ['id', 'runId'] };
  for (const [name, names] of Object.entries(required)) {
    if (state[name].some(item => names.some(field => typeof item[field] !== 'string' || (field === 'id' && !item[field])))) throw new TypeError(`备份中的 ${name} 缺少必要字段`);
  }
  for (const item of state.cards) {
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 12 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 60))) throw new TypeError('备份中的复习卡片标签格式无效或过长');
  }
  for (const item of state.sessions) {
    if (timestamp(item.startedAt) === null || timestamp(item.endedAt) === null || timestamp(item.endedAt) < timestamp(item.startedAt) || typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes < 0 || item.minutes > 1440) throw new TypeError('备份中的专注记录日期或时长无效');
  }
  return normalizeState(state, seed);
}
