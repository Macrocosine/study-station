import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, createState, normalizeState, updateCard, timerRemaining, startTimer, pauseTimer, setTimerMode, completeTimer, getStats, validateBackup } from '../dist/core.mjs';

const seed = { tasks: [{ id: 't1', title: '积分练习', subject: '高数', minutes: 25 }], cards: [{ id: 'c1', subject: '高数', front: '<img src=x onerror=alert(1)>', back: '原样保存，界面负责文本渲染', tags: ['微积分', '基础'] }], notes: [] };
const baseTime = new Date(2026, 9, 21, 12).getTime();
const backup = state => JSON.stringify({ app: 'study-station', version: 1, state });

test('local calendar keys and seed dates are deterministic', () => {
  assert.equal(dayKey(new Date(2026, 0, 2, 0, 1)), '2026-01-02');
  assert.equal(createState(seed, '2026-10-23').tasks[0].dueDate, '2026-10-23');
  assert.equal(createState(seed).sessions.length, 0);
  assert.throws(() => dayKey('invalid'), /日期/);
});

test('normalization clamps preferences and preserves plain text payloads', () => {
  const state = createState(seed);
  state.settings = { focusMinutes: -20, breakMinutes: 1000, dailyGoal: '120' };
  state.tasks.push({ ...state.tasks[0], dueDate: '2026-02-30' });
  state.timer = { mode: 'focus', status: 'running', remaining: 45, endsAt: 'garbage' };
  const result = normalizeState(state);
  assert.deepEqual(result.settings, { focusMinutes: 1, breakMinutes: 60, dailyGoal: 120 });
  assert.equal(result.cards[0].front, seed.cards[0].front);
  assert.equal(result.timer.status, 'paused');
  assert.notEqual(result.tasks[0].id, result.tasks[1].id);
  assert.notEqual(result.tasks[1].dueDate, '2026-02-30');
  assert.throws(() => normalizeState([]), /对象/);
});

test('backup validation rejects unrelated JSON and oversized or malformed collections', () => {
  const state = createState(seed);
  assert.equal(validateBackup(backup(state)).cards[0].front, seed.cards[0].front);
  assert.throws(() => validateBackup('{oops'), /JSON/);
  assert.throws(() => validateBackup('{}'), /版本/);
  assert.throws(() => validateBackup(backup({ ...state, tasks: [null] })), /格式/);
  assert.throws(() => validateBackup(backup({ ...state, cards: [{ ...state.cards[0], front: 'x'.repeat(4001) }] })), /过长/);
  assert.throws(() => validateBackup(backup({ ...state, sessions: undefined })), /格式/);
  assert.throws(() => validateBackup(backup({ ...state, tasks: [{}] })), /必要/);
  assert.throws(() => validateBackup(backup({ ...state, settings: null })), /格式/);
  assert.throws(() => validateBackup(backup({ ...state, schemaVersion: 99 })), /版本/);
  assert.throws(() => validateBackup(' '.repeat(5 * 1024 * 1024 + 1)), /过大/);
});

test('card tags survive normalization and backup round trips within bounded limits', () => {
  const state = createState(seed);
  assert.deepEqual(state.cards[0].tags, ['微积分', '基础']);
  assert.deepEqual(validateBackup(backup(state)).cards[0].tags, state.cards[0].tags);
  assert.throws(() => validateBackup(backup({ ...state, cards: [{ ...state.cards[0], tags: ['x'.repeat(61)] }] })), /标签/);
  assert.throws(() => validateBackup(backup({ ...state, cards: [{ ...state.cards[0], tags: Array(13).fill('x') }] })), /标签/);
  assert.throws(() => validateBackup(backup({ ...state, cards: [{ ...state.cards[0], tags: [123] }] })), /标签/);
  assert.equal(normalizeState({ ...state, tasks: [{ ...state.tasks[0], minutes: 999 }] }).tasks[0].minutes, 180);
});

test('backup sessions reject reverse date ranges and negative study minutes', () => {
  const state = createState(seed);
  const session = { id: 's1', runId: 'r1', startedAt: baseTime, endedAt: baseTime + 1500000, minutes: 25 };
  assert.throws(() => validateBackup(backup({ ...state, sessions: [{ ...session, endedAt: baseTime - 1 }] })), /日期或时长/);
  assert.throws(() => validateBackup(backup({ ...state, sessions: [{ ...session, minutes: -1 }] })), /日期或时长/);
});

test('duplicate imported focus runs cannot inflate actual focused minutes', () => {
  const state = createState(seed);
  const session = { id: 's1', runId: 'r1', startedAt: baseTime, endedAt: baseTime + 1500000, minutes: 25, taskId: 't1' };
  state.sessions = [session, { ...session, id: 's2' }, { ...session, runId: 'r2' }];
  const imported = validateBackup(backup(state));
  assert.equal(imported.sessions.length, 1);
  assert.equal(getStats(imported, baseTime + 2000000).todayMinutes, 25);
});

test('review intervals use the documented deterministic ladder', () => {
  const card = createState(seed).cards[0];
  const again = updateCard(card, 'again', baseTime);
  assert.equal(again.dueAt, baseTime + 60000);
  assert.equal(again.reviews, 1);
  const good = updateCard(card, 'good', baseTime);
  assert.equal(good.intervalDays, 1);
  assert.equal(updateCard(good, 'good', baseTime).intervalDays, 2);
  assert.equal(updateCard(card, 'easy', baseTime).intervalDays, 4);
  assert.equal(updateCard({ ...card, intervalDays: 3000 }, 'easy', baseTime).intervalDays, 3650);
  assert.throws(() => updateCard(card, 'unknown'), /评分/);
});

test('timer follows elapsed wall time, preserves runs across pause, catches up after sleep', () => {
  let state = createState(seed);
  state.timer = startTimer(state.timer, baseTime);
  const runId = state.timer.runId;
  assert.equal(timerRemaining(state.timer, baseTime + 10001), 1490);
  state.timer = pauseTimer(state.timer, baseTime + 10000);
  assert.equal(state.timer.remaining, 1490);
  state.timer = startTimer(state.timer, baseTime + 3600000);
  assert.equal(state.timer.runId, runId);
  assert.equal(timerRemaining(state.timer, baseTime + 3600000), 1490);
  const finished = completeTimer(state, baseTime + 7200000);
  assert.equal(finished.sessions.length, 1);
  assert.equal(finished.sessions[0].minutes, 25);
  assert.equal(finished.sessions[0].endedAt, baseTime + 3600000 + 1490000);
  assert.equal(finished.timer.mode, 'break');
  assert.equal(finished.timer.status, 'idle');
  assert.strictEqual(completeTimer(finished, baseTime + 7300000), finished);
  assert.equal(completeTimer({ ...state, sessions: finished.sessions }, baseTime + 7300000).sessions.length, 1);
});

test('break completion produces no focus session and switching mode starts a fresh run', () => {
  let state = createState(seed);
  state.timer = startTimer(setTimerMode(state.timer, 'break', state.settings), baseTime);
  const finished = completeTimer(state, baseTime + 300000);
  assert.equal(finished.sessions.length, 0);
  assert.equal(finished.timer.mode, 'focus');
  assert.equal(finished.timer.remaining, 1500);
  assert.equal(setTimerMode(state.timer, 'focus', { focusMinutes: 45, breakMinutes: 5 }).remaining, 2700);
});

test('a pause click at the deadline cannot accidentally restart a finished focus run', () => {
  const state = createState(seed);
  state.timer = startTimer(state.timer, baseTime);
  const paused = pauseTimer(state.timer, baseTime + 1500000);
  assert.equal(paused.status, 'running');
  assert.equal(completeTimer({ ...state, timer: paused }, baseTime + 1500000).sessions.length, 1);
  const restored = startTimer({ ...state.timer, status: 'paused', remaining: 0, endsAt: null }, baseTime + 1500000);
  assert.equal(timerRemaining(restored, baseTime + 1500000), 0);
});

test('statistics count only actual recorded study and use local days for streaks', () => {
  const state = createState(seed);
  const yesterday = new Date(2026, 9, 20, 12).getTime();
  const twoDaysAgo = new Date(2026, 9, 19, 12).getTime();
  state.sessions = [
    { endedAt: baseTime, minutes: 25 }, { endedAt: baseTime + 1000, minutes: 15 },
    { endedAt: yesterday, minutes: 30 }, { endedAt: twoDaysAgo, minutes: 10 }
  ];
  state.tasks[0].done = true;
  state.tasks[0].completedAt = baseTime;
  state.cards[0].dueAt = baseTime;
  const stats = getStats(state, baseTime + 2000);
  assert.equal(stats.todayMinutes, 40);
  assert.equal(stats.totalMinutes, 80);
  assert.equal(stats.completedTasks, 1);
  assert.equal(stats.dueCards, 1);
  assert.equal(stats.streak, 3);
  assert.equal(stats.week.length, 7);
  assert.equal(stats.week.at(-1).minutes, 40);
  assert.equal(getStats({ ...state, sessions: state.sessions.slice(2) }, baseTime).streak, 2);
});

