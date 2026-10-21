import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, normalizeState, validateBackup, dayKey, startTimer, pauseTimer, timerRemaining, completeTimer, updateCard, getStats } from '../dist/core.mjs';

const seed = { tasks: [{ id: 'task-1', title: '复习', minutes: 25, subject: '高数' }], cards: [{ id: 'card-1', front: '问', back: '答', tags: ['基础'] }], notes: [{ id: 'note-1', title: '笔记', body: '内容' }] };
const at = new Date(2024, 1, 29, 12).getTime();
const asBackup = state => JSON.stringify({ app: 'study-station', version: 1, state });
const session = (id, endedAt, minutes = 25) => ({ id, runId: `run-${id}`, startedAt: endedAt - minutes * 60000, endedAt, minutes, taskId: null });

test('invalid numeric setting types cannot coerce into unexpected one-minute preferences', () => {
  const input = createState(seed);
  input.settings = { focusMinutes: [30], breakMinutes: true, dailyGoal: null };
  assert.deepEqual(normalizeState(input).settings, { focusMinutes: 25, breakMinutes: 5, dailyGoal: 90 });
  input.settings = { focusMinutes: ' 45 ', breakMinutes: {}, dailyGoal: '' };
  assert.deepEqual(normalizeState(input).settings, { focusMinutes: 45, breakMinutes: 5, dailyGoal: 90 });
});

test('out-of-range timestamps fall back while valid future review dates survive import', () => {
  const input = createState(seed), future = Date.now() + 90 * 86400000;
  input.cards[0].dueAt = future;
  assert.equal(validateBackup(asBackup(input)).cards[0].dueAt, future);
  input.cards[0].dueAt = 8_640_000_000_000_001;
  input.notes[0].createdAt = 'not a date';
  const before = Date.now(), result = normalizeState(input), after = Date.now();
  assert.ok(result.cards[0].dueAt >= before && result.cards[0].dueAt <= after);
  assert.ok(result.notes[0].createdAt >= before && result.notes[0].createdAt <= after);
});

test('maximum card tags survive exact roundtrip, with oversized local tags bounded', () => {
  const state = createState(seed), tags = Array.from({ length: 12 }, (_, n) => String(n).padEnd(60, '字'));
  state.cards[0].tags = tags;
  assert.deepEqual(validateBackup(asBackup(state)).cards[0].tags, tags);
  state.cards[0].tags = [...tags, 'extra'];
  assert.equal(normalizeState(state).cards[0].tags.length, 12);
});

test('an intentionally empty backup does not reinsert starter content', () => {
  const state = createState(seed);
  state.tasks = []; state.cards = []; state.notes = []; state.sessions = [];
  const restored = validateBackup(asBackup(state), seed);
  for (const key of ['tasks', 'cards', 'notes', 'sessions']) assert.deepEqual(restored[key], []);
});

test('multiple pauses exclude all pause time and still produce only one full focus session', () => {
  let state = createState(seed), now = at;
  state.timer = startTimer(state.timer, now);
  for (let n = 0; n < 3; n++) {
    now += 300000;
    state.timer = pauseTimer(state.timer, now);
    now += 3600000;
    state.timer = startTimer(state.timer, now);
  }
  assert.equal(timerRemaining(state.timer, now), 600);
  assert.strictEqual(completeTimer(state, now + 599999), state);
  const finished = completeTimer(state, now + 600000);
  assert.equal(finished.sessions.length, 1);
  assert.equal(finished.sessions[0].minutes, 25);
  assert.equal(finished.sessions[0].startedAt, at);
  assert.equal(finished.sessions[0].endedAt, now + 600000);
});

test('leap-day and local midnight statistics keep adjacent sessions on their actual dates', () => {
  const state = createState(seed);
  const midnight = new Date(2024, 2, 1, 0, 0).getTime();
  state.sessions = [session('before', midnight - 1000, 15), session('after', midnight + 1000, 10)];
  const stats = getStats(state, midnight + 2000);
  assert.equal(dayKey(midnight - 1000), '2024-02-29');
  assert.equal(stats.todayMinutes, 10);
  assert.equal(stats.week.at(-2).date, '2024-02-29');
  assert.equal(stats.week.at(-2).minutes, 15);
  assert.equal(stats.streak, 2);
});

test('imported duplicate record IDs and run IDs cannot duplicate focus credit', () => {
  const state = createState(seed), original = session('unique', at);
  state.sessions = [original, { ...original, id: 'another-id' }, { ...original, runId: 'another-run' }];
  state.tasks.push({ ...state.tasks[0], title: '第二个任务' });
  const restored = validateBackup(asBackup(state));
  assert.equal(restored.sessions.length, 1);
  assert.equal(getStats(restored, at).todayMinutes, 25);
  assert.equal(restored.tasks.length, 2);
  assert.notEqual(restored.tasks[0].id, restored.tasks[1].id);
});

test('an expired running backup settles once after reload at its scheduled finish', () => {
  let state = createState(seed);
  state.timer = startTimer(state.timer, at);
  state = validateBackup(asBackup(state));
  assert.equal(timerRemaining(state.timer, at + 86400000), 0);
  const result = completeTimer(state, at + 86400000);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].endedAt, at + 1500000);
  assert.equal(completeTimer(validateBackup(asBackup(result)), at + 86400000).sessions.length, 1);
});

test('an imported paused run resumes from its remaining active time', () => {
  let state = createState(seed);
  state.timer = pauseTimer(startTimer(state.timer, at), at + 600000);
  state = validateBackup(asBackup(state));
  state.timer = startTimer(state.timer, at + 86400000);
  assert.equal(timerRemaining(state.timer, at + 86400000), 900);
  assert.equal(completeTimer(state, at + 86400000 + 900000).sessions[0].minutes, 25);
});

test('repeated easy ratings cap long-term intervals, and forgetting resets to one minute', () => {
  let card = createState(seed).cards[0];
  for (let n = 0; n < 30; n++) card = updateCard(card, 'easy', at);
  assert.equal(card.intervalDays, 3650);
  assert.equal(card.reviews, 30);
  assert.ok(Number.isFinite(card.dueAt));
  const forgotten = updateCard(card, 'again', at);
  assert.equal(forgotten.intervalDays, 0);
  assert.equal(forgotten.dueAt, at + 60000);
  assert.deepEqual(forgotten.tags, ['基础']);
});

