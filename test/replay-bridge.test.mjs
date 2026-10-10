import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeDays, createBridgeSource, dayBounds, dayKey, MAX_BRIDGE } from '../src/replay-bridge.mjs';

// Local times, as the days are: noon of a day, plus hours.
const at = (day, hour = 12) => new Date(2026, 9, day, hour).getTime();

test('bridge: a day is this machine\'s own, midnight to midnight; what is not a day is refused', () => {
  assert.equal(dayKey(at(9, 0)), '2026-10-09');
  assert.equal(dayKey(at(9, 23)), '2026-10-09');
  assert.deepEqual(dayBounds('2026-10-09'), [at(9, 0), at(10, 0)]);
  for (const bad of ['', null, '2026-10', '2026-02-31', '2026-13-01', '../etc', '2026-10-09T00']) assert.equal(dayBounds(bad), null, String(bad));
});

test('bridge: a session counts for each day it has a message on; a subagent never on its own', () => {
  const sessions = [{ id: 'a', parent_id: null }, { id: 'b', parent_id: null }, { id: 'kid', parent_id: 'a' }];
  const messages = [
    { session_id: 'a', time_created: at(8) }, { session_id: 'a', time_created: at(9) }, { session_id: 'a', time_created: at(9, 13) },
    { session_id: 'b', time_created: at(9) }, { session_id: 'kid', time_created: at(10) }, { session_id: 'gone', time_created: at(9) },
  ];
  const days = activeDays(sessions, messages);
  assert.deepEqual([...days].map(([day, ids]) => [day, [...ids]]), [['2026-10-08', ['a']], ['2026-10-09', ['a', 'b']]]);
});

function source(count = 2) {
  const sessions = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, parent_id: null, time_created: at(9, 1) + (count - i) * 1000 }));
  const messages = sessions.map(s => ({ session_id: s.id, time_created: at(9, 10) }));
  messages.push({ session_id: 's0', time_created: at(7, 10) });
  const asked = [];
  const db = { stats: { sessions: () => sessions, messages: () => messages } };
  const replay = (id, now) => {
    asked.push(id);
    return id === 's1' && count === 3 ? null : { session: { id }, now };
  };
  return { ...createBridgeSource({ db, replay }), asked };
}

test('bridge: the days there is something to play back, newest first, with their sessions', () => {
  assert.deepEqual(source().days(at(10)), [{ day: '2026-10-09', sessions: 2 }, { day: '2026-10-07', sessions: 1 }]);
  // A day more than thirty days back is not offered.
  assert.deepEqual(source().days(at(10) + 40 * 86_400_000), []);
});

test('bridge: the sessions of a day, in the order they began, each as its own replay', () => {
  const s = source();
  const bridge = s.bridge('2026-10-09', at(10));
  assert.deepEqual(bridge.sessions.map(r => r.session.id), ['s1', 's0']);
  assert.deepEqual([bridge.start, bridge.end, bridge.more], [at(9, 0), at(10, 0), 0]);
  // Today ends now, not at midnight to come.
  assert.equal(source().bridge('2026-10-09', at(9, 15)).end, at(9, 15));
  assert.deepEqual(source().bridge('2026-10-01', at(10)).sessions, []);
  assert.equal(source().bridge('yesterday', at(10)), null);
});

test('bridge: no more stations than the bridge has, the rest counted; a session that cannot be read is left out', () => {
  const many = source(MAX_BRIDGE + 3).bridge('2026-10-09', at(10));
  assert.equal(many.sessions.length, MAX_BRIDGE);
  assert.equal(many.more, 3);
  assert.deepEqual(source(3).bridge('2026-10-09', at(10)).sessions.map(r => r.session.id), ['s2', 's0']);
});
