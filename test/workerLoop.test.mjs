import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextAction, renewalDue, returnPayload, summarise, actionableEvent,
  ACTION, RENEW_FLOOR_MS, NOTES_LIMIT,
} from '../src/workerLoop.mjs';

/**
 * THE WORKER RUNTIME, AND THE FOUR WAYS IT COULD DESTROY WORK.
 *
 * This is the component whose absence is why `max_attempt` is 0, `outbox` has
 * never held a row, and 538 proposals died unconfirmed. Everything else in this
 * repository tells a worker what to do; nothing WAS one.
 *
 * Every test below is a way the runtime could be worse than not having one:
 *
 *   returning under a dead lease  overwrites somebody else's live work
 *   working after a failed renewal  burns time producing output to discard
 *   pausing without renewing        loses the task while a human decides
 *   swallowing a failure            turns a fast failure into a silent stall
 *
 * The first is the dangerous one. A runtime that occasionally does nothing is
 * an inconvenience; a runtime that returns stale work under a superseded token
 * corrupts the thing it is supposed to be building.
 */

const NOW = '2026-09-16T02:00:00.000Z';
const MIN = 60_000;
const at = (off) => new Date(Date.parse(NOW) + off).toISOString();

const task = (over = {}) => ({ task_id: 't1', state: 'assigned', assigned_session: 's-me', ...over });
const lease = (over = {}) => ({
  lease_token: 'tok-1', leased_at: at(-5 * MIN), lease_expires_at: at(10 * MIN), ...over,
});
const worker = (over = {}) => ({
  session_id: 's-me', task: task(), lease: lease(), run: null, pausedTaskIds: [], ...over,
});

// ── 1. NEVER RETURN WITHOUT A LIVE LEASE ───────────────────────────────────

test('AN EXPIRED LEASE DISCARDS THE RESULT — even when the run SUCCEEDED', () => {
  /*
   * THE test. The work is finished, it is good, and it must be thrown away,
   * because the task may have been reaped and re-claimed while we ran. Handing
   * it back would overwrite live work with the output of a run nobody is
   * waiting for -- exactly the zombie the fencing design exists to stop.
   *
   * A runtime that got this wrong would look like it was working perfectly.
   */
  const w = worker({
    lease: lease({ lease_expires_at: at(-1) }),
    run: { done: true, ok: true, headSha: 'a'.repeat(40), notes: 'all tests pass' },
  });
  const out = nextAction(w, { now: NOW });

  assert.equal(out.action, ACTION.ABANDON, 'a successful run was submitted under a dead lease');
  assert.equal(out.discard, true);
  assert.match(out.reason, /reaped and re-claimed/);
});

test('the expiry check runs BEFORE the run-finished check, not after', () => {
  // Ordering is the whole guarantee. If `run.done` were tested first, the
  // branch above is unreachable and the test passes for the wrong reason.
  for (const run of [null, { done: false }, { done: true, ok: true, headSha: 'a'.repeat(40) },
    { done: true, ok: false, error: 'boom' }]) {
    const out = nextAction(worker({ lease: lease({ lease_expires_at: at(-1) }), run }), { now: NOW });
    assert.equal(out.action, ACTION.ABANDON, JSON.stringify(run));
  }
});

test('returnPayload REFUSES to assemble a return without a live token', () => {
  // Belt and braces: even if the machine were bypassed, the payload builder
  // will not produce something /return would have to refuse.
  const w = worker({ lease: { lease_token: '' }, run: { done: true, ok: true, headSha: 'a'.repeat(40) } });
  const out = returnPayload(w, { now: NOW });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /no lease token/);
});

test('A RETURN MUST CARRY A COMMIT, and the commit is never invented', () => {
  /*
   * bin/agentbridge.mjs already refuses a typed --head-sha: a return carrying a
   * commit somebody typed is a claim about work, not evidence of it. The
   * payload builder holds the same line for the runtime.
   */
  const w = worker({ run: { done: true, ok: true, headSha: '' } });
  const out = returnPayload(w, { now: NOW });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /must carry the commit/);
});

// ── 2. A FAILED RENEWAL STOPS THE WORK IMMEDIATELY ─────────────────────────

test('A REFUSED RENEWAL ABANDONS AT ONCE — not at the end of the run', () => {
  /*
   * The moment renewal is refused this process is no longer the holder. Every
   * second it keeps running produces output that must be discarded, and the
   * tempting "finish first, then check" is how a worker spends twenty minutes
   * on work it cannot hand back.
   */
  const w = worker({ renewalFailed: true, run: { done: false } });
  const out = nextAction(w, { now: NOW });
  assert.equal(out.action, ACTION.ABANDON);
  assert.equal(out.discard, true);
  assert.match(out.reason, /no longer the holder/);
});

test('HOLDING A TASK WITH NO LEASE TOKEN REFUSES TO START', () => {
  /*
   * This is the shape the whole system had before the token was delivered:
   * assignment without a credential to return under. Starting would produce
   * work that cannot be handed back, which is worse than not starting.
   */
  const out = nextAction(worker({ lease: null }), { now: NOW });
  assert.equal(out.action, ACTION.ABANDON);
  assert.match(out.reason, /nothing could be returned under it/);
});

// ── 3. A PAUSED TASK STILL RENEWS ──────────────────────────────────────────

test('A PAUSED TASK KEEPS ITS LEASE ALIVE — the one case where doing nothing is wrong', () => {
  /*
   * A worker waiting on a permission decision still HOLDS the task. If it stops
   * renewing, the reaper takes the work away while a human is deciding whether
   * to allow it -- and the human's answer then arrives for a task somebody else
   * is doing.
   */
  const w = worker({ pausedTaskIds: ['t1'], lease: lease({ lease_expires_at: at(20_000) }) });
  const out = nextAction(w, { now: NOW });
  assert.equal(out.action, ACTION.RENEW, 'a paused worker let its lease lapse');
});

test('a paused task with a healthy lease waits, and does NOT start work', () => {
  const w = worker({ pausedTaskIds: ['t1'] });
  const out = nextAction(w, { now: NOW });
  assert.equal(out.action, ACTION.PAUSE);
  assert.match(out.reason, /awaiting a permission decision/);
});

test('a pause on ANOTHER task does not pause this one', () => {
  // "Pauses only that task" was explicit. A worker blocked on task A is still a
  // live worker for task B.
  const w = worker({ pausedTaskIds: ['t-other'] });
  assert.equal(nextAction(w, { now: NOW }).action, ACTION.START);
});

// ── 4. A FAILED RUN IS RETURNED, NOT SWALLOWED ─────────────────────────────

test('A CRASHED RUN IS RETURNED with the failure attached', () => {
  /*
   * Holding it until the lease expires turns a fast, legible failure into a
   * silent ten-minute stall, and the retry counter never learns anything.
   */
  const w = worker({ run: { done: true, ok: false, headSha: 'b'.repeat(40), error: 'exit 1', notes: 'tsc failed' } });
  const out = nextAction(w, { now: NOW });
  assert.equal(out.action, ACTION.RETURN);
  assert.equal(out.outcome, 'failed');

  const p = returnPayload(w, { now: NOW });
  assert.equal(p.ok, true);
  assert.equal(p.body.outcome, 'failed');
  assert.match(p.body.notes, /tsc failed/);
});

test('a TIMED OUT run is a failure that says so', () => {
  const notes = summarise({ ok: false, timedOut: true, error: 'killed after 1800s' });
  assert.match(notes, /TIMED OUT/);
  assert.match(notes, /killed after 1800s/);
});

test('notes are bounded, and the TAIL is kept', () => {
  // The useful part of a crash is where it stopped, not where it started.
  const notes = summarise({ ok: false, notes: `START${'x'.repeat(NOTES_LIMIT * 2)}END` });
  assert.ok(notes.length <= NOTES_LIMIT + 1, `notes were ${notes.length} long`);
  assert.match(notes, /END$/, 'the head was kept instead of the tail');
});

// ── the happy path, which must actually work ───────────────────────────────

test('THE POSITIVE CONTROL: a healthy worker starts, waits, and returns', () => {
  /*
   * Required, and not decoration. Every assertion above is about refusing to
   * act; a machine that returned ABANDON unconditionally would satisfy all of
   * them and never do a single piece of work. A runtime that only refuses is
   * exactly the state this file was written to end.
   */
  assert.equal(nextAction(worker(), { now: NOW }).action, ACTION.START);
  assert.equal(nextAction(worker({ run: { done: false } }), { now: NOW }).action, ACTION.WAIT);

  const finished = worker({ run: { done: true, ok: true, headSha: 'c'.repeat(40), notes: 'done' } });
  assert.equal(nextAction(finished, { now: NOW }).action, ACTION.RETURN);

  const p = returnPayload(finished, { now: NOW });
  assert.equal(p.ok, true);
  assert.deepEqual(p.body, {
    task_id: 't1', session_id: 's-me', lease_token: 'tok-1',
    head_sha: 'c'.repeat(40), outcome: 'completed', notes: 'done',
  });
});

test('with no task, it polls', () => {
  assert.equal(nextAction(worker({ task: null, lease: null }), { now: NOW }).action, ACTION.POLL);
});

// ── renewal timing ─────────────────────────────────────────────────────────

test('renewal is a MARGIN, not a deadline', () => {
  /*
   * Renewing exactly at expiry means one slow round trip loses the lease while
   * the work is still running and correct -- the most expensive way to lose it.
   */
  const leaseMs = 15 * MIN;
  assert.equal(renewalDue({ lease_expires_at: at(14 * MIN), leased_at: at(-MIN) }, { now: NOW, leaseMs }), false);
  assert.equal(renewalDue({ lease_expires_at: at(4 * MIN), leased_at: at(-11 * MIN) }, { now: NOW, leaseMs }), true);
});

test('a lease with no readable expiry is DUE, never healthy', () => {
  // Failing toward "renew" costs one round trip. Failing the other way loses
  // the task silently.
  assert.equal(renewalDue({}, { now: NOW }), true);
  assert.equal(renewalDue({ lease_expires_at: 'not a date' }, { now: NOW }), true);
});

test('the floor applies to a very long lease', () => {
  // A third of a 24-hour lease is 8 hours; the floor stops the first renewal
  // attempt happening long after anything has gone wrong.
  const out = renewalDue({ lease_expires_at: at(RENEW_FLOOR_MS - 1000), leased_at: at(-23 * 60 * MIN) },
    { now: NOW, leaseMs: 24 * 60 * MIN });
  assert.equal(out, true);
});

test('the clock is required and never guessed', () => {
  assert.throws(() => nextAction(worker(), {}), /requires a `now` timestamp/);
  assert.throws(() => renewalDue(lease(), {}), /requires a `now` timestamp/);
  assert.throws(() => returnPayload(worker(), {}), /requires a `now` timestamp/);
});

// ── shutdown ───────────────────────────────────────────────────────────────

test('SHUTDOWN STILL SUBMITS WORK THAT IS FINISHED AND STILL OURS', () => {
  /*
   * A worker told to stop between "the run completed" and "the result was
   * submitted" should submit it. The result exists and the lease is live;
   * throwing it away would make an orderly shutdown more destructive than a
   * crash.
   */
  const w = worker({ stopping: true, run: { done: true, ok: true, headSha: 'd'.repeat(40) } });
  assert.equal(nextAction(w, { now: NOW }).action, ACTION.RETURN);
});

test('shutdown mid-run stops rather than finishing', () => {
  const w = worker({ stopping: true, run: { done: false } });
  assert.equal(nextAction(w, { now: NOW }).action, ACTION.STOP);
});

// ── events are doorbells, not payloads ─────────────────────────────────────

test('AN EVENT IS A DOORBELL: duplicates must not act twice', () => {
  /*
   * The outbox is at-least-once BY CONSTRUCTION -- the event is written in the
   * same transaction as the claim, which closes "lost publish after commit" and
   * makes duplicates certain. No consumer may trust an event body.
   */
  const idle = { task: null };
  assert.equal(actionableEvent({ kind: 'assigned', task_id: 't1' }, idle).act, true);

  const holding = { task: { task_id: 't1' } };
  assert.equal(actionableEvent({ kind: 'assigned', task_id: 't1' }, holding).act, false,
    'a duplicate assignment event would have been acted on twice');
});

test('a busy worker does not take a second task', () => {
  const out = actionableEvent({ kind: 'assigned', task_id: 't2' }, { task: { task_id: 't1' } });
  assert.equal(out.act, false);
  assert.match(out.reason, /busy with t1/);
});

test('the lease token rides on the event, because that is the only place to learn it', () => {
  /*
   * The delivery gap recorded in docs/lease-interface.md: the token is minted
   * in the coordinator's response and the worker is a different process. The
   * assigned event is the only channel that reaches the holder.
   */
  const out = actionableEvent({ kind: 'assigned', task_id: 't1', lease_token: 'tok-9' }, { task: null });
  assert.equal(out.act, true);
  assert.equal(out.lease_token, 'tok-9');
});

test('non-assignment events are ignored, and a token-less one still says so', () => {
  assert.equal(actionableEvent({ kind: 'cancelled', task_id: 't1' }, { task: null }).act, false);
  assert.equal(actionableEvent({ kind: 'assigned' }, { task: null }).act, false);
  assert.equal(actionableEvent({ kind: 'assigned', task_id: 't1' }, { task: null }).lease_token, null);
});
