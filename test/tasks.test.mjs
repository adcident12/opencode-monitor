// What you set the agent to do and how far each got: sessions by project, how each ended, its plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endOf, latestPlanOf, planFromWrite, tasksOf } from '../src/tasks.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const show = text => String(text ?? '');
const todos = (...items) => JSON.stringify(items.map(([content, status]) => ({ content, status, priority: 'high' })));

test('the plan is the latest completed todowrite; a broken list is skipped', () => {
  const parts = [
    { type: 'tool', tool: 'todowrite', status: 'completed', todos: todos(['a', 'pending']) },
    { type: 'tool', tool: 'todowrite', status: 'completed', todos: todos(['a', 'completed'], ['b', 'in_progress']) },
    { type: 'tool', tool: 'todowrite', status: 'error', todos: todos(['x', 'pending']) },
    { type: 'tool', tool: 'todowrite', status: 'completed', todos: '{not json' },
  ];
  assert.deepEqual(latestPlanOf(parts), [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]);
  assert.deepEqual(latestPlanOf([]), []);
  assert.equal(planFromWrite('"text"'), null);
});

test('how the last turn ended', () => {
  const reply = extra => [{ role: 'user', time_created: NOW - HOUR }, { role: 'assistant', time_created: NOW - HOUR, completed: NOW - HOUR + MIN, ...extra }];
  assert.equal(endOf(reply({}), NOW), 'stopped');
  assert.equal(endOf(reply({ error: 'MessageAbortedError' }), NOW), 'interrupted');
  assert.equal(endOf(reply({ error_name: 'APIError' }), NOW), 'error');
  // Never completed: still going if lately, otherwise it was left so.
  assert.equal(endOf([{ role: 'assistant', time_created: NOW - MIN }], NOW), 'working');
  assert.equal(endOf([{ role: 'assistant', time_created: NOW - HOUR }], NOW), 'interrupted');
  // The Now tab knows better when a prompt is open.
  assert.equal(endOf(reply({}), NOW, 'waiting'), 'waiting');
  assert.equal(endOf(reply({}), NOW, 'finished'), 'stopped');
});

test('sessions by project, most recent first, unfinished first within one, with what is left of each plan', () => {
  const sessions = [
    { id: 'done', parent_id: null, directory: '/work/shop', title: 'Checkout', time_created: NOW - 5 * HOUR, time_updated: NOW - HOUR },
    { id: 'half', parent_id: null, directory: '/work/shop', title: 'Services page', time_created: NOW - 9 * HOUR, time_updated: NOW - 8 * HOUR },
    { id: 'sub', parent_id: 'half', directory: '/work/shop', title: 'subagent', time_created: NOW - 8 * HOUR, time_updated: NOW - 8 * HOUR },
    { id: 'old', parent_id: null, directory: '/work/blog', title: 'Old', time_created: NOW - 20 * 24 * HOUR, time_updated: NOW - 20 * 24 * HOUR },
    { id: 'quick', parent_id: null, directory: '/work/blog', title: 'Typo', time_created: NOW - 3 * HOUR, time_updated: NOW - 2 * HOUR },
  ];
  const stopped = [{ role: 'assistant', time_created: NOW - 2 * HOUR, completed: NOW - 2 * HOUR + MIN }];
  const value = tasksOf({
    sessions,
    // 1.x keeps its plan in the todo table; that wins over its calls.
    tablePlan: id => (id === 'done' ? [{ content: 'pay', status: 'completed' }, { content: 'skip', status: 'cancelled' }] : []),
    writes: new Map([['half', todos(['header', 'completed'], ['row', 'in_progress'], ['form', 'pending'])], ['done', todos(['x', 'pending'])]]),
    lastMessages: () => stopped,
    show, now: NOW, days: 7,
  });
  assert.equal(value.total, 3);
  assert.equal(value.open, 1);
  assert.deepEqual(value.projects.map(p => [p.project, p.open, p.sessions.map(s => s.id)]), [['shop', 1, ['half', 'done']], ['blog', 0, ['quick']]]);
  const half = value.projects[0].sessions[0];
  assert.deepEqual(half.plan, { done: 1, total: 3 });
  assert.deepEqual(half.left, [{ content: 'row', status: 'in_progress' }, { content: 'form', status: 'pending' }]);
  assert.equal(half.open, true);
  assert.deepEqual(value.projects[0].sessions[1].plan, { done: 1, total: 1 });
  // No plan and handed back: nothing to say is left.
  assert.deepEqual([value.projects[1].sessions[0].plan, value.projects[1].sessions[0].open], [null, false]);
});
