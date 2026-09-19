/**
 * ONE ACTIVE TASK PER WORKER, AND A BLOCK THAT REALLY RELEASES THE SLOT.
 *
 * The WIP limit here is a correctness rule, not a productivity one. Measured
 * on this machine 2026-09-18/19, workers holding several things at once
 * produced: a working-tree reset that destroyed another session's uncommitted
 * work, two sessions racing the shared git index, and a half-finished rename
 * that left the shell rail importing a function that no longer existed -- the
 * guard was dead until a human noticed.
 *
 * So the tests below care about two opposite failures, and the second is the
 * one that gets a rule switched off:
 *
 *   a worker must not be handed a second CONCURRENT MUTATION
 *   a worker must not be stranded -- BLOCKED returns the slot immediately,
 *   because a blocked worker that cannot take other work is idle for hours
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_WIP_STATES,
  PARKED_STATES,
  BLOCK_CLASSES,
  consumesSlot,
  wipHeldBy,
  canTakeNext,
  validateBlock,
  applyBlock,
} from '../src/takeNext.mjs';

const WORKER = Object.freeze({ agent_id: 'fixer', session_id: 'sess-1' });
const task = (over = {}) => ({
  task_id: 't-1', state: 'WORKING', assigned_session: 'sess-1', ...over,
});

/* ── the limit ──────────────────────────────────────────────────────────── */

test('every ACTIVE state consumes the slot, and every PARKED state does not', () => {
  for (const s of ACTIVE_WIP_STATES) {
    assert.equal(consumesSlot(s), true, `${s} is active work and must hold the slot`);
  }
  for (const s of PARKED_STATES) {
    assert.equal(consumesSlot(s), false, `${s} must not strand the worker`);
  }
});

test('AN UNKNOWN STATE COUNTS AS ACTIVE -- the safe default is "busy"', () => {
  /*
   * Rule 19 in the direction that matters here. Defaulting an unrecognised
   * state to "not busy" would hand a worker a second concurrent job on a typo
   * or on a state added upstream -- and that corrupts a working tree
   * silently. Defaulting to busy is recoverable: the worker says so.
   */
  for (const s of ['REVIEWING', 'wip', '', null, undefined, 'Working']) {
    assert.equal(consumesSlot(s), true, `unrecognised state ${JSON.stringify(s)} must be treated as active`);
  }
  assert.equal(consumesSlot('WORKING'), true, 'positive control: the exact token is active');
  assert.equal(consumesSlot('BLOCKED'), false, 'positive control: a known parked state is not');
});

test('a worker already WORKING is refused a second job, and told which task', () => {
  const r = canTakeNext({ worker: WORKER, tasks: [task()] });
  assert.equal(r.ok, false);
  assert.match(r.why, /already holding t-1/, 'a bare "no" produces a worker that asks again in a loop');
  assert.match(r.why, /MARK_BLOCKED/, 'and it must say how to release the slot');
});

test('a worker whose only task is BLOCKED may take another immediately', () => {
  const r = canTakeNext({ worker: WORKER, tasks: [task({ state: 'BLOCKED' })] });
  assert.equal(r.ok, true, 'a blocked worker that cannot take other work is idle for hours');
});

test('tasks belonging to ANOTHER worker do not consume this one slot', () => {
  const r = canTakeNext({ worker: WORKER, tasks: [task({ assigned_session: 'sess-other' })] });
  assert.equal(r.ok, true);
});

test('the slot is held per SESSION, not per durable agent id', () => {
  /*
   * Two concurrent sessions of the same agent are exactly the pair that
   * collide on the shared index, so session is the sharper key. A task
   * recording only an agent id still matches, because otherwise it would
   * escape the limit entirely.
   */
  const otherSession = { agent_id: 'fixer', session_id: 'sess-2' };
  assert.equal(canTakeNext({ worker: otherSession, tasks: [task()] }).ok, true,
    'a different session of the same agent has its own slot');

  const sessionless = [task({ assigned_session: null, assigned_agent: 'fixer' })];
  assert.equal(canTakeNext({ worker: otherSession, tasks: sessionless }).ok, false,
    'but a task recorded only against the agent must not escape the limit');
});

test('a caller that names no worker is refused rather than issued a job', () => {
  const r = canTakeNext({ worker: {}, tasks: [] });
  assert.equal(r.ok, false);
  assert.match(r.why, /named no worker/);
});

test('wipHeldBy returns the actual task, so a caller can report it', () => {
  const held = wipHeldBy(WORKER, [task({ task_id: 't-9', state: 'MUTATION_PROVEN' })]);
  assert.equal(held.task_id, 't-9');
  assert.equal(wipHeldBy(WORKER, [task({ state: 'SHIPPED' })]), null);
});

/* ── the block, which is what makes the limit survivable ────────────────── */

test('a block with no class and no reason is refused', () => {
  assert.equal(validateBlock({}).ok, false);
  assert.match(validateBlock({}).errors.join(' '), /block_class is required/);
  assert.match(validateBlock({}).errors.join(' '), /reason is required/);
});

test('an invented block class is refused, and every declared one is accepted', () => {
  assert.equal(validateBlock({ block_class: 'BORED', reason: 'x' }).ok, false);
  for (const cls of BLOCK_CLASSES) {
    const extra = (cls === 'DEPENDENCY' || cls === 'COLLISION') ? { blocked_on: 't-2' } : {};
    assert.equal(validateBlock({ block_class: cls, reason: 'a real reason', ...extra }).ok, true,
      `${cls} is a declared class and must be usable`);
  }
});

test('DEPENDENCY and COLLISION must name what they wait on, or nothing can notice it clearing', () => {
  assert.equal(validateBlock({ block_class: 'DEPENDENCY', reason: 'waiting' }).ok, false);
  assert.equal(validateBlock({ block_class: 'COLLISION', reason: 'waiting' }).ok, false);
  assert.equal(validateBlock({ block_class: 'DEPENDENCY', reason: 'waiting', blocked_on: 't-2' }).ok, true);

  /* And the other classes must NOT demand it -- an infrastructure fault has no task id. */
  assert.equal(validateBlock({ block_class: 'INFRASTRUCTURE', reason: 'disk full' }).ok, true);
});

test('a VALID block moves the task to BLOCKED and releases the slot', () => {
  const r = applyBlock({ task: task(), block: { block_class: 'OWNER_DECISION', reason: 'needs Danny' } });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.slotReleased, true);

  /* End to end: the worker can now take another job. */
  assert.equal(canTakeNext({ worker: WORKER, tasks: [task({ state: r.state })] }).ok, true);
});

test('AN INVALID BLOCK RELEASES NOTHING -- otherwise the limit costs nothing to evade', () => {
  const r = applyBlock({ task: task(), block: { reason: 'cba' } });
  assert.equal(r.ok, false);
  assert.equal(r.slotReleased, false, 'a slot released on an unrecorded reason is an abandoned task');
  assert.equal(r.state, 'WORKING', 'and the task must not move');

  /* The worker is still at its limit. */
  assert.equal(canTakeNext({ worker: WORKER, tasks: [task({ state: r.state })] }).ok, false);
});

test('only active work can be blocked; blocking a shipped task is refused', () => {
  const r = applyBlock({ task: task({ state: 'SHIPPED' }), block: { block_class: 'UNKNOWN', reason: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /only active work can be blocked/);
});
