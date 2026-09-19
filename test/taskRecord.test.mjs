/**
 * A TASK THAT CANNOT BE ASSIGNED SHOULD BE REFUSED WHEN IT IS WRITTEN.
 *
 * `assign_task` refuses when the repo or lane does not match, when the task is
 * not runnable or returned, when a dependency is unsatisfied, and when a path
 * collides with another assignment. Half of those are properties of the RECORD,
 * knowable the moment somebody types it — and until now they were discovered
 * hours later, by a refusal that names the worker rather than the record.
 *
 * These tests are the refusals, exhaustively, offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask, validateTask, pathsCollide, RUNNABLE_STATES, TASK_ID,
} from '../src/taskRecord.mjs';

const AT = '2026-09-18T22:45:00.000Z';

const good = (extra = {}) => createTask({
  task_id: 't-null-contract-locks',
  title: 'Give list_locks a way to say unknown',
  lane_id: 'agentbridge',
  repo_id: 'Agent007',
  allowed_paths: ['mcp/toolDefs.mjs', 'supabase/functions/mcp/_shared.js'],
  created_at: AT,
  created_by: 'code-b',
  ...extra,
});

test('THE POSITIVE FIRST: a well-formed task validates', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a validator that refuses
   * everything, which would make the tool useless in the other direction.
   */
  const v = validateTask(good());
  assert.deepEqual(v.errors, [], `a well-formed task was refused: ${v.errors.join('; ')}`);
  assert.equal(v.ok, true);
});

test('A TASK IS BORN CLAIMABLE, or it can never be picked up', () => {
  /*
   * claim_task admits `runnable` and `returned` and nothing else. A task
   * created in any other state is invisible to the only mechanism that hands it
   * out — and CLAUDE.md records a real row that sat `assigned` with a null
   * lease, which reconcile_leases could never reclaim, until somebody cancelled
   * it by hand.
   */
  assert.equal(validateTask(good()).ok, true);
  for (const state of RUNNABLE_STATES) {
    assert.equal(validateTask(good({ state })).ok, true, `${state} was refused`);
  }
  /*
   * `undefined` is NOT in this list, and that is deliberate: it triggers the
   * parameter default, which is `runnable`. Asserting it should be refused
   * would be pinning that the default does not work.
   */
  for (const state of ['assigned', 'accepted', 'cancelled', 'open', '', null, 0, 'RUNNABLE']) {
    const v = validateTask(good({ state }));
    assert.equal(v.ok, false, `state ${JSON.stringify(state)} was accepted — it can never be claimed`);
    assert.match(v.errors.join(' '), /claim_task admits no others/);
  }
});

test('AN EMPTY allowed_paths IS REFUSED, because it means two opposite things', () => {
  /*
   * It reads as "no restriction" to a person and as "nothing is permitted" to a
   * path check. Two rows in the live tasks table have carried `[]` for days and
   * nobody can say which was meant.
   */
  for (const paths of [[], undefined, null, 'src/']) {
    const v = validateTask(good({ allowed_paths: paths }));
    assert.equal(v.ok, false, `allowed_paths ${JSON.stringify(paths)} was accepted`);
  }
});

test('A PATH THAT CAN ESCAPE THE REPOSITORY IS REFUSED', () => {
  /*
   * collisionGuard compares PATHS. Two agents agreeing they may both touch
   * `../` have agreed on nothing, and the guard cannot tell them apart.
   */
  for (const p of ['../outside', 'src/../../etc', '/abs/path', 'C:/Users/x', 'src\\windows', '..']) {
    const v = validateTask(good({ allowed_paths: [p] }));
    assert.equal(v.ok, false, `allowed path ${JSON.stringify(p)} was accepted`);
  }
  // And the ordinary shapes still pass, or the rule is a blanket refusal.
  for (const p of ['src/events.mjs', 'test/a.test.mjs', 'docs/x.md', 'a', 'a/b/c.d']) {
    assert.equal(validateTask(good({ allowed_paths: [p] })).ok, true, `${p} was refused`);
  }
});

test('A TASK THAT DEPENDS ON ITSELF CAN NEVER RUN', () => {
  const v = validateTask(good({ depends_on: ['t-null-contract-locks'] }));
  assert.equal(v.ok, false, 'a self-dependent task was accepted');
  assert.match(v.errors.join(' '), /depends on itself/);
});

test('LANE, REPO, TITLE AND AUTHOR ARE ALL REQUIRED', () => {
  /*
   * Each of these is a refusal assign_task makes at assign time. Catching them
   * here turns a permanent silent failure into a message at the keyboard.
   */
  for (const field of ['lane_id', 'repo_id', 'title', 'created_by', 'created_at']) {
    const v = validateTask(good({ [field]: '' }));
    assert.equal(v.ok, false, `a task with no ${field} was accepted`);
    assert.match(v.errors.join(' '), new RegExp(field.replace('_', '_?')),
      `the refusal does not name ${field}: ${v.errors.join('; ')}`);
  }
});

test('A TASK ID MUST BE FILE-SAFE, because it becomes a path and a predicate', () => {
  for (const id of ['t/slash', 't space', '../t', 't\u0000', '', 'x'.repeat(65), '-leading']) {
    assert.equal(validateTask(good({ task_id: id })).ok, false,
      `task_id ${JSON.stringify(id)} was accepted`);
  }
  for (const id of ['t-1', 'T.2_x', 'x'.repeat(64)]) {
    assert.equal(TASK_ID.test(id), true, `${id} should be a legal id`);
  }
});

test('A TASK CANNOT BE CREATED IN A STATE THE DATABASE WILL REFUSE', () => {
  /*
   * CLAIMABLE AND CREATABLE ARE DIFFERENT SETS, and conflating them produced
   * exactly the failure this module says it prevents. `returned` is claimable;
   * the table's `returned_carries_evidence` CHECK also requires returned_by and
   * returned_head_sha, which no create path writes. So the record passed every
   * check here, passed the duplicate and collision checks in the route, and
   * failed the INSERT with a 400 that reaches the caller as a 500.
   */
  assert.equal(validateTask(good({ state: 'runnable' })).ok, true, 'runnable was refused');
  const v = validateTask(good({ state: 'returned' }));
  assert.equal(v.ok, false,
    'a task was created in `returned`, which the database refuses for want of returned_by');
  assert.match(v.errors.join(' '), /returned_by/, `the refusal does not explain why: ${v.errors.join('; ')}`);
});

test('base_sha IS CHECKED AGAINST THE CONSTRAINT THE TABLE CARRIES', () => {
  /*
   * `tasks_base_sha_check` is `base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'`.
   * Unvalidated, every one of these passed here and was rejected by the INSERT.
   */
  assert.equal(validateTask(good({ base_sha: null })).ok, true, 'null base_sha was refused');
  assert.equal(validateTask(good({ base_sha: 'a'.repeat(40) })).ok, true, 'a real sha was refused');
  for (const bad of ['HEAD', 'main', 'abc123', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41), '', 42]) {
    assert.equal(validateTask(good({ base_sha: bad })).ok, false,
      `base_sha ${JSON.stringify(bad)} was accepted and the database would refuse it`);
  }
});

test('A TASK ID IS STORED AS IT WAS VALIDATED', () => {
  /*
   * It was validated trimmed and stored raw, so "  abc  " and "abc" both
   * validated and became two rows a human reads as one id — and the route's
   * duplicate check compares the stored value, so it would not catch the second.
   */
  assert.equal(createTask({ ...good(), task_id: '  t-spaced  ' }).task_id, 't-spaced',
    'the id was stored with the whitespace the validator ignored');
});

test('AN ALIAS OF THE SAME PATH STILL COLLIDES', () => {
  /*
   * Five spellings defeated this, and validateTask accepted every one, so two
   * coordinator-created tasks could claim the same file with the gate silent.
   * On NTFS the case one is literally the same file. Fixed at the matcher, not
   * by listing the five that were tried (rule 8).
   */
  for (const alias of ['./src/a', 'src//a', 'SRC/a', 'src/./a', 'src/a ', 'src\\a', 'src/A']) {
    assert.equal(pathsCollide(['src/a'], [alias]).length, 1,
      `"${alias}" did not collide with "src/a" — two tasks can claim the same file`);
  }
  // And the discrimination survives: a genuinely different path still does not collide.
  assert.deepEqual(pathsCollide(['src/a'], ['src/ab']), [], 'the normalisation swallowed a distinct path');
  assert.deepEqual(pathsCollide(['src/a'], ['']), [], 'an empty path collided with something');
});

test('COLLIDING PATHS ARE FOUND AT CREATION, not hours later at assignment', () => {
  /*
   * assign_task refuses "a path collides with another assignment" — at ASSIGN
   * time, long after somebody wrote two tasks that were always going to fight.
   */
  assert.deepEqual(pathsCollide(['src/events.mjs'], ['test/a.test.mjs']), [],
    'unrelated paths were reported as colliding');

  assert.equal(pathsCollide(['src/events.mjs'], ['src/events.mjs']).length, 1, 'identical paths do not collide');

  // Prefix-aware: a directory covers what is under it.
  assert.equal(pathsCollide(['src/'], ['src/events.mjs']).length, 1, 'a directory does not cover its contents');
  assert.equal(pathsCollide(['src'], ['src/events.mjs']).length, 1, 'a directory without a slash does not cover');

  /*
   * ON SEGMENT BOUNDARIES, or `src/a` swallows `src/ab` and every task in the
   * repo collides with every other. Same judgement segmentSuffixes makes in the
   * permission matcher.
   */
  assert.deepEqual(pathsCollide(['src/a'], ['src/ab']), [],
    'a prefix that is not a path segment was treated as a collision');
});

test('createTask PRODUCES A RECORD THE VALIDATOR ACCEPTS, and copies its arrays', () => {
  /*
   * A constructor that emits something its own validator refuses is the shape
   * that makes every caller write the record by hand instead.
   */
  const paths = ['src/a.mjs'];
  const t = createTask({
    task_id: 't-x', title: 'x', lane_id: 'l', repo_id: 'r',
    allowed_paths: paths, created_at: AT, created_by: 'code-b',
  });
  assert.equal(validateTask(t).ok, true, 'the constructor produced an invalid record');

  paths.push('src/b.mjs');
  assert.deepEqual(t.allowed_paths, ['src/a.mjs'],
    'the record aliased the caller\'s array — a later mutation would rewrite a stored task');

  assert.equal(t.assigned_agent, null, 'a new task arrived pre-assigned');
  assert.equal(t.attempt, 0, 'a new task arrived with attempts already spent');
});

test('THE CONTROL: the validator really discriminates', () => {
  /*
   * Rule 1. A validator that always passes satisfies the positive; one that
   * always fails satisfies every negative. This pins that it does both.
   */
  assert.equal(validateTask(good()).ok, true, 'the validator refuses everything — the negatives are inert');
  assert.equal(validateTask(good({ lane_id: '' })).ok, false, 'the validator accepts everything — the positives are inert');
  assert.equal(validateTask(null).ok, false, 'a non-object validated');
});
