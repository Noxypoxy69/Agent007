import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownTask, ownTasks, WORKER_TASK_FIELDS } from '../src/ownWork.mjs';

/**
 * A WORKER READS ITS OWN WORK, AND NOTHING ELSE.
 *
 * The gap: `eventsFor` tells a worker WHICH task it holds and says in its own
 * comment that this is "never enough to act without reading it" — and there was
 * nowhere to read it from. /wait returns events only, /register is registration
 * state, /return is write-only, and the MCP read surface 401s a registration
 * token. The worker was told to read the authority and given no way to.
 *
 * Found by building the consumer, which is how the lease-token delivery gap was
 * found too. Two halves of the same omission: the runtime never existed, so
 * nothing had ever needed either of them.
 *
 * Most of this file is about what a worker CANNOT see, because that is the part
 * that is correct exactly as long as its scope is.
 */

const T = (over = {}) => ({
  task_id: 't1', state: 'assigned', assigned_session: 's-me',
  title: 'Fix the thing', notes: 'be careful', lane_id: 'agentbridge',
  repo_id: 'agentbridge', allowed_paths: ['src/a.mjs'], base_sha: 'b'.repeat(40),
  depends_on: [], attempt: 1, assigned_at: '2026-09-16T03:00:00.000Z',
  lease_token: 'tok-me', lease_expires_at: '2026-09-16T03:15:00.000Z',
  leased_at: '2026-09-16T03:00:00.000Z',
  ...over,
});

// ── the worker can do its job ──────────────────────────────────────────────

test('A WORKER CAN READ THE TASK IT WAS TOLD TO READ — the whole point', () => {
  /*
   * The positive control, and it is the reason the file exists. Every refusal
   * below is satisfied by returning null unconditionally, which would leave the
   * worker exactly as unable to act as it was before.
   */
  const out = ownTask([T()], { task_id: 't1', session_id: 's-me' });

  assert.ok(out, 'a worker could not read its own assigned task');
  assert.equal(out.task_id, 't1');
  assert.equal(out.title, 'Fix the thing');
  assert.deepEqual(out.allowed_paths, ['src/a.mjs']);
  assert.equal(out.base_sha, 'b'.repeat(40));
  assert.equal(out.lease_token, 'tok-me', 'a restarted worker cannot recover its own credential');
});

test('a restarted worker can ask what it already holds', () => {
  /*
   * After a crash the cursor is gone with the process, so there is no event to
   * replay. Without this the worker sits idle while its lease runs down on work
   * nobody else can take until the reaper frees it.
   */
  const rows = [T(), T({ task_id: 't2', assigned_session: 's-other' }), T({ task_id: 't3' })];
  const mine = ownTasks(rows, { session_id: 's-me' });

  assert.deepEqual(mine.map((t) => t.task_id), ['t1', 't3']);
});

// ── scope, which is the whole safety argument ──────────────────────────────

test('ANOTHER SESSION\'S TASK IS INVISIBLE, credential and all', () => {
  const rows = [T({ task_id: 't2', assigned_session: 's-other', lease_token: 'tok-other' })];

  assert.equal(ownTask(rows, { task_id: 't2', session_id: 's-me' }), null,
    'a worker read a task assigned to somebody else');
  assert.equal(JSON.stringify(ownTasks(rows, { session_id: 's-me' })).includes('tok-other'), false,
    'another session\'s lease token was disclosed');
});

test('THE SESSION IS THE UNIT, NOT THE AGENT', () => {
  /*
   * An agent that died and came back under a new session must not read the old
   * session's work. Same argument that makes a fencing token a fencing token: a
   * session id is what the lease was minted against, and "same agent" is
   * exactly the claim a zombie makes.
   */
  const rows = [T({ assigned_session: 's-old' })];
  assert.equal(ownTask(rows, { task_id: 't1', session_id: 's-new' }), null,
    'a restarted agent read the previous session\'s work');
});

test('NOT FOUND AND NOT YOURS ARE THE SAME ANSWER', () => {
  /*
   * Distinguishing them would let a worker enumerate which task ids exist by
   * watching whether it gets nothing or a refusal. A small leak, free to close,
   * and the caller has nothing to do differently either way.
   */
  const rows = [T({ task_id: 't2', assigned_session: 's-other' })];
  assert.equal(ownTask(rows, { task_id: 't2', session_id: 's-me' }), null);
  assert.equal(ownTask(rows, { task_id: 'no-such-task', session_id: 's-me' }), null);
});

test('an unassigned task is nobody\'s', () => {
  for (const session of [null, undefined, '']) {
    assert.equal(ownTask([T({ assigned_session: session })], { task_id: 't1', session_id: 's-me' }), null);
  }
  // And a caller with no session reads nothing, rather than everything.
  assert.equal(ownTask([T()], { task_id: 't1', session_id: '' }), null);
  assert.deepEqual(ownTasks([T()], {}), []);
});

// ── the field list is a decision, not a spread ─────────────────────────────

test('AN UNLISTED COLUMN IS NEVER HANDED OUT', () => {
  /*
   * `select *` on a view cost this project a PGRST204 outage when the table
   * grew and the view did not. The same argument applies to a response shape: a
   * row spread into a response discloses every column somebody adds later,
   * forever, without anybody deciding to.
   */
  const out = ownTask([T({ internal_cost_cents: 999, reviewer_notes: 'do not show' })],
    { task_id: 't1', session_id: 's-me' });

  assert.equal(out.internal_cost_cents, undefined, 'a column nobody reviewed was disclosed');
  assert.equal(out.reviewer_notes, undefined);
  assert.deepEqual(Object.keys(out).sort(), [...WORKER_TASK_FIELDS].sort());
});

test('a missing column reads as null, not as absent', () => {
  // The runtime distinguishes "no lease token" from "key not present"; a
  // vanishing key is how that guard gets bypassed.
  const out = ownTask([{ task_id: 't1', assigned_session: 's-me' }],
    { task_id: 't1', session_id: 's-me' });
  assert.equal(out.lease_token, null);
  assert.ok('lease_token' in out);
  assert.ok('allowed_paths' in out);
});

test('the returned object is a COPY, never the row', () => {
  // A row passed through by reference is one refactor away from carrying a
  // column nobody reviewed — and one mutation away from corrupting the source.
  const rows = [T()];
  const out = ownTask(rows, { task_id: 't1', session_id: 's-me' });
  out.title = 'mutated';
  assert.equal(rows[0].title, 'Fix the thing', 'the caller could edit the authority row');
});

test('the field list is frozen', () => {
  assert.ok(Object.isFrozen(WORKER_TASK_FIELDS));
  assert.ok(WORKER_TASK_FIELDS.includes('allowed_paths'),
    'the path contract stopped reaching the worker, which would let it change anything');
});

test('AN EMPTY SESSION MATCHES NOTHING — including an empty assigned_session', () => {
  /*
   * FOUND BY MUTATION. Removing the `nonEmpty(session_id)` guard left every
   * test green, because the ownership comparison caught every case the fixtures
   * tried: 's-me' !== '' is true, so null came back anyway.
   *
   * The case it did NOT catch is the one that matters. A row whose
   * assigned_session is '' — an unassigned task, or a half-written one —
   * compared against a caller with no session is '' !== '', which is FALSE.
   * The task would be handed over, credential included, to a caller who
   * identified itself as nobody.
   *
   * The guard is not redundant; the fixtures were too narrow to reach it. Same
   * shape as every other hollow gate here: the assertion and the risk were
   * about different things.
   */
  const orphan = T({ assigned_session: '', lease_token: 'tok-orphan' });

  assert.equal(ownTask([orphan], { task_id: 't1', session_id: '' }), null,
    'a caller with no session read an unassigned task');
  assert.deepEqual(ownTasks([orphan], { session_id: '' }), [],
    'a caller with no session listed unassigned work');

  // Same for the whitespace-only spellings of "nobody".
  for (const s of ['   ', '\t', '\n']) {
    assert.equal(ownTask([T({ assigned_session: s })], { task_id: 't1', session_id: s }), null, JSON.stringify(s));
  }
});
