import test from 'node:test';
import assert from 'node:assert/strict';

import { delegationsForSession, OUTSTANDING_STATES, TRANSITIONS } from '../src/provenance.mjs';

/**
 * THE PULL HALF OF COORDINATION.
 *
 * Both directions are asserted throughout, because the two ways this can be
 * wrong are not symmetrical and only one of them is visible:
 *
 *   returning too little  -- an agent is told it has nothing and stops. Silent.
 *   returning too much    -- an agent picks up another session's contract and
 *                            edits outside its own bounds. Loud, eventually,
 *                            via the collision guard -- after the damage.
 *
 * So every test that proves something IS returned has a sibling proving the
 * neighbouring case is NOT.
 */

const base = {
  id: 'd-x',
  assigning_session: 'lead',
  assigned_session: 'worker',
  task: 'a bounded task',
  lane_id: 'agentbridge',
  base_sha: 'b364b84489a9e5cd0860e60f56ac5302634dc1bb',
  allowed_paths: ['src/x.mjs'],
  forbidden_paths: ['package.json'],
  shared_paths: [],
  notes: null,
  state: 'assigned',
  head_sha: null,
  history: [],
};

const del = (over = {}) => ({ ...base, ...over });

test('delegationsFor: returns this session\'s outstanding work', () => {
  const rows = [del({ id: 'd-1', state: 'assigned' })];
  const got = delegationsForSession(rows, 'worker');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'd-1');
});

test('delegationsFor: an agent with no work sees nothing, and that is not an error', () => {
  // The silent half. Every row here belongs to somebody else or is finished.
  const rows = [
    del({ id: 'd-1', assigned_session: 'other', state: 'assigned' }),
    del({ id: 'd-2', state: 'accepted' }),
  ];
  assert.deepEqual(delegationsForSession(rows, 'worker'), []);
  assert.deepEqual(delegationsForSession([], 'worker'), []);
});

test('delegationsFor: a different session\'s work is NEVER returned', () => {
  const rows = [
    del({ id: 'mine', assigned_session: 'worker' }),
    del({ id: 'theirs', assigned_session: 'worker-2' }),
    del({ id: 'theirs-too', assigned_session: 'Worker' }),   // case differs: not me
  ];
  const ids = delegationsForSession(rows, 'worker').map((d) => d.id);
  assert.deepEqual(ids, ['mine']);

  // And with --all, which widens STATE and must not widen OWNERSHIP.
  const allIds = delegationsForSession(rows, 'worker', { includeAll: true }).map((d) => d.id);
  assert.deepEqual(allIds, ['mine']);
});

test('delegationsFor: assigning a task is not the same as owing it', () => {
  // A lead who hands work out must not see it come back as their own queue.
  const rows = [del({ id: 'd-1', assigning_session: 'lead', assigned_session: 'worker' })];
  assert.deepEqual(delegationsForSession(rows, 'lead'), []);
  assert.deepEqual(delegationsForSession(rows, 'lead', { includeAll: true }), []);
});

test('delegationsFor: rejected is outstanding — the case easiest to drop', () => {
  // Rejected means handed back, found wanting, still the delegate's. Omitting
  // it would tell an agent with rework to do that it was finished.
  const rows = [del({ id: 'd-rej', state: 'rejected' })];
  assert.equal(delegationsForSession(rows, 'worker').length, 1);
});

test('delegationsFor: returned and the terminal states are not outstanding', () => {
  for (const state of ['returned', 'accepted', 'withdrawn']) {
    const rows = [del({ id: `d-${state}`, state })];
    assert.deepEqual(
      delegationsForSession(rows, 'worker'), [],
      `${state} was reported as outstanding`,
    );
    // --all still shows it: the history is real, it is just not work.
    assert.equal(delegationsForSession(rows, 'worker', { includeAll: true }).length, 1);
  }
});

test('delegationsFor: OUTSTANDING_STATES agrees with the lifecycle it describes', () => {
  // Reads the shipped TRANSITIONS rather than restating it. A state is
  // outstanding exactly when it is non-terminal -- if someone adds a state or
  // makes `rejected` terminal, this fails instead of quietly disagreeing.
  const nonTerminal = Object.entries(TRANSITIONS)
    .filter(([, next]) => next.length > 0)
    .map(([state]) => state);
  // `returned` is non-terminal but belongs to the LEAD, so it is the one
  // documented exception.
  assert.deepEqual(
    [...OUTSTANDING_STATES].sort(),
    nonTerminal.filter((s) => s !== 'returned').sort(),
  );
});

test('delegationsFor: a missing session id throws rather than matching nothing', () => {
  // `--for` with no value parses to boolean true. Silently returning [] there
  // would report "no work" to an agent that has some -- a confident wrong
  // answer, which is the worst outcome for a command read on startup.
  const rows = [del()];
  for (const bad of [true, undefined, null, '', 0, {}]) {
    assert.throws(
      () => delegationsForSession(rows, bad),
      TypeError,
      `session id ${JSON.stringify(bad)} did not throw`,
    );
  }
});

test('delegationsFor: a non-array store throws rather than being read as empty', () => {
  assert.throws(() => delegationsForSession(null, 'worker'), TypeError);
  assert.throws(() => delegationsForSession({ 0: del() }, 'worker'), TypeError);
});
