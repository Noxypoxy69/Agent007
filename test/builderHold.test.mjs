/**
 * THE HOLD BAR, AND THE THREE WAYS IT COULD BE WORSE THAN NOTHING.
 *
 * A control that stops a builder early is easy to write and easy to get wrong
 * in ways that all look identical from outside -- a green suite and a verdict
 * of `continue`. The three failures worth testing for are not "does it fire":
 *
 *   IT FIRES AND LOSES THE WORK. Rotating a builder with uncommitted edits
 *   discards them, and a control that destroys evidence is worse than the
 *   degradation it was preventing.
 *
 *   IT FIRES INSTEAD OF FAILING. A stuck builder that rotates hands its
 *   successor the same wall with a fresh budget, and the task never completes
 *   and never reports a problem.
 *
 *   IT NEVER FIRES AT ALL. Every signal is optional, so a runtime that wires
 *   this up and forwards nothing gets `continue` forever -- rule 17 wearing a
 *   pass. Hence the `measured` assertions, which are the only thing that
 *   distinguishes "healthy" from "nobody is looking".
 *
 * The wiring block at the bottom is a SEPARATE CLAIM from the logic above it.
 * Rule 17: the guard's own unit tests were green throughout while nothing
 * consulted it. These tests call `nextAction`, not `holdVerdict`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  holdVerdict, rotationHandover, HOLD, LIMITS, SOFT_SIGNALS,
} from '../src/builderHold.mjs';
import { nextAction, returnPayload, ACTION } from '../src/workerLoop.mjs';
import { createLoopState, observe } from '../src/loopDetector.mjs';

/* A builder that has done a little of everything and is nowhere near the bar. */
const healthy = () => ({
  steps: 5,
  contextFraction: 0.1,
  filesTouched: 2,
  elapsedMs: 60_000,
  rotations: 0,
  loop: null,
  checkpointable: true,
});

/* ── the positive control, first, because a negative needs one (rule 5) ── */

test('THE POSITIVE CONTROL: a working builder is told to continue, and it was measured', () => {
  const v = holdVerdict(healthy());
  assert.equal(v.verdict, HOLD.CONTINUE);
  assert.equal(v.measured, true, 'a fixture with four live signals reported as unmeasured');
  assert.deepEqual(v.crossed, []);
});

test('"NOBODY MEASURED ANYTHING" IS DISTINGUISHABLE FROM "MEASURED AND FINE"', () => {
  /*
   * THE RULE 17 CASE. Every signal is optional, so a runtime that forwards no
   * observations gets `continue` on every tick and the bar never fires once.
   * The verdict deliberately stays `continue` -- refusing all work because
   * telemetry is missing is the rule 19 outage that gets a control switched
   * off -- so `measured` is the ONLY thing that can tell an operator the
   * difference. If these two collapse, the control is unfalsifiable.
   */
  const unwired = holdVerdict({});
  assert.equal(unwired.verdict, HOLD.CONTINUE);
  assert.equal(unwired.measured, false, 'an empty observation reported as measured: the bar is unfalsifiable');
  assert.match(unwired.why, /no degradation signals were measured/);

  assert.notEqual(unwired.why, holdVerdict(healthy()).why,
    'a measured-healthy builder and an unmonitored one gave the same explanation');

  for (const junk of [null, undefined, 'nope', 42, []]) {
    assert.equal(holdVerdict(junk).measured, false, `junk observation ${JSON.stringify(junk)} read as measured`);
  }
});

/* ── every signal fires, and the list is derived not typed (rule 7) ────── */

test('EVERY SOFT SIGNAL CROSSES THE BAR ON ITS OWN -- generated from the real list', () => {
  /*
   * DERIVED FROM SOFT_SIGNALS so that adding a signal extends this coverage
   * without anybody remembering to. A hand-typed list of four stops covering
   * the module the moment a fifth arrives, and nothing goes red to say so.
   */
  assert.ok(SOFT_SIGNALS.length >= 4, 'the signal list shrank; this test is now weaker than it reads');

  for (const key of SOFT_SIGNALS) {
    assert.ok(LIMITS[key] != null, `${key} is a signal with no limit, so it can never fire`);

    const at = holdVerdict({ ...healthy(), [key]: LIMITS[key] });
    assert.equal(at.verdict, HOLD.ROTATE, `${key} at its limit did not cross the bar`);
    assert.deepEqual(at.crossed, [key], `${key} crossed but reported ${JSON.stringify(at.crossed)}`);
    assert.match(at.why, new RegExp(key), 'the reason does not name the signal that fired');

    /* AND THE NEGATIVE: just under the bar must not fire, or the limit is decorative. */
    const under = holdVerdict({ ...healthy(), [key]: LIMITS[key] * 0.9 });
    assert.equal(under.verdict, HOLD.CONTINUE, `${key} fired at 90% of its limit`);
  }
});

test('SEVERAL SIGNALS ARE ALL REPORTED, not just the first one found', () => {
  /*
   * Whoever is deciding whether the bar sits in the right place needs to know
   * it was three signals and not one. Short-circuiting on the first would hide
   * that, and the numbers here are judgements that somebody will want to argue
   * with using this output.
   */
  const v = holdVerdict({ ...healthy(), steps: LIMITS.steps, filesTouched: LIMITS.filesTouched });
  assert.equal(v.verdict, HOLD.ROTATE);
  assert.deepEqual(new Set(v.crossed), new Set(['steps', 'filesTouched']));
});

/* ── the three refusals ─────────────────────────────────────────────────── */

test('ROTATION MUST NOT LOSE WORK: uncheckpointable and degraded is a FAIL', () => {
  /*
   * The worst available outcome. A builder at its step limit with an hour of
   * uncommitted edits, rotated, loses the edits -- and it loses them QUIETLY,
   * because rotation is the success-shaped verdict. Failing loudly with the
   * reason is the only honest answer.
   */
  const v = holdVerdict({ ...healthy(), steps: LIMITS.steps, checkpointable: false });
  assert.equal(v.verdict, HOLD.FAIL, 'a rotation was ordered for work that cannot be handed over');
  assert.match(v.why, /cannot be checkpointed/);
  assert.match(v.why, /discard/);

  /* A MISSING FLAG IS NOT A YES. Absent telemetry must not authorise a rotation. */
  for (const bad of [undefined, null, 'true', 1, 0]) {
    const r = holdVerdict({ ...healthy(), steps: LIMITS.steps, checkpointable: bad });
    assert.equal(r.verdict, HOLD.FAIL,
      `checkpointable=${JSON.stringify(bad)} was treated as a promise that the work is safe`);
  }
});

test('ROTATION IS NOT AN ESCAPE FROM BEING STUCK', () => {
  /*
   * A builder going in circles is not tired, and a fresh one meets the same
   * wall with a full budget to spend on it. This must outrank every soft
   * limit, so each fixture is degraded AND stuck: if the ordering were wrong
   * it would rotate.
   *
   * THE FINDINGS COME FROM THE REAL DETECTOR, not from a hand-written shape.
   * A fixture invented here would keep passing after loopDetector changed what
   * it emits -- hollow gate 9, the fixture that is not a shape the system
   * produces.
   */
  const drive = (fps) => {
    let state = createLoopState();
    let step = { state, loop: null };
    for (const fp of fps) { step = observe(state, fp); state = step.state; }
    return step.loop;
  };

  const repeat = drive(['a', 'a', 'a']);
  assert.ok(repeat, 'the real detector did not report a repeat; this fixture proves nothing');

  const v = holdVerdict({ ...healthy(), steps: LIMITS.steps, loop: repeat });
  assert.equal(v.verdict, HOLD.FAIL);
  assert.match(v.why, /stuck, not degraded/);
  assert.match(v.why, /repeat/, 'the verdict does not say which loop shape was found');

  /*
   * OSCILLATION IS THE ONE THE OLD COUNTER MISSED. Every attempt differs from
   * the one before it, so a consecutive-identical-errors counter never fires,
   * and loopDetector's own header calls this "the shape that runs all night".
   */
  const osc = drive(['a', 'b', 'a', 'b']);
  assert.ok(osc, 'the real detector did not report an oscillation');
  assert.equal(holdVerdict({ ...healthy(), steps: LIMITS.steps, loop: osc }).verdict, HOLD.FAIL,
    'an oscillating builder was rotated: the successor inherits the same A-B-A-B');

  /* No loop found: the soft limits decide, and a rotation is right. */
  const clean = drive(['a']);
  assert.equal(clean, null, 'the detector fired on a single fingerprint');
  assert.equal(holdVerdict({ ...healthy(), steps: LIMITS.steps, loop: clean }).verdict, HOLD.ROTATE);
});

test('A MALFORMED LOOP FINDING IS NOT A LOOP', () => {
  /*
   * The detector owns the threshold, so this only checks the finding is real
   * rather than re-reading it. That makes junk in this field the way to kill
   * a healthy attempt, so junk must not count.
   */
  for (const junk of [{}, { kind: '' }, { kind: '  ' }, 'repeat', 42, true, [], null, undefined]) {
    assert.equal(holdVerdict({ ...healthy(), loop: junk }).verdict, HOLD.CONTINUE,
      `a malformed loop finding ${JSON.stringify(junk)} terminated a healthy attempt`);
  }
});

test('AN UNRECOVERABLE REASON OUTRANKS EVERYTHING, including a clean fixture', () => {
  const v = holdVerdict({ ...healthy(), unrecoverable: 'lease revoked by the reaper' });
  assert.equal(v.verdict, HOLD.FAIL);
  assert.match(v.why, /lease revoked by the reaper/, 'the reason was swallowed');

  /* An empty or blank string is not a reason and must not terminate an attempt. */
  for (const blank of ['', '   ', null, undefined, false]) {
    assert.equal(holdVerdict({ ...healthy(), unrecoverable: blank }).verdict, HOLD.CONTINUE,
      `a blank unrecoverable ${JSON.stringify(blank)} killed a healthy attempt`);
  }
});

test('ROTATION IS BOUNDED: past the budget it is a FAIL, not a fourth rotation', () => {
  /*
   * Unbounded rotation is a task that never completes and never fails, which
   * is worse than either -- budget disappears and nothing reports a problem.
   */
  const degraded = { ...healthy(), steps: LIMITS.steps };
  assert.equal(holdVerdict({ ...degraded, rotations: LIMITS.rotations - 1 }).verdict, HOLD.ROTATE);

  const spent = holdVerdict({ ...degraded, rotations: LIMITS.rotations });
  assert.equal(spent.verdict, HOLD.FAIL, 'the rotation budget did not bound anything');
  assert.match(spent.why, /unfinishable as scoped/);

  assert.equal(holdVerdict({ ...degraded, rotations: 99 }).verdict, HOLD.FAIL);
});

test('A SPENT BUDGET ALONE DOES NOT KILL A HEALTHY BUILDER', () => {
  /*
   * Rule 9, the other direction: the budget only decides once something has
   * actually crossed the bar. A builder that rotated three times and is now
   * working fine must keep working -- otherwise a successor is killed on
   * arrival for its predecessors' history.
   */
  const v = holdVerdict({ ...healthy(), rotations: LIMITS.rotations + 5 });
  assert.equal(v.verdict, HOLD.CONTINUE, 'a fresh builder was failed for inherited rotation count');
});

test('LIMITS ARE OVERRIDABLE, and an override that omits a key keeps the default', () => {
  const v = holdVerdict({ ...healthy(), steps: 10 }, { limits: { steps: 10 } });
  assert.equal(v.verdict, HOLD.ROTATE, 'a lowered limit did not take effect');

  /* The un-overridden keys must survive the merge, or one override disarms the rest. */
  const still = holdVerdict({ ...healthy(), filesTouched: LIMITS.filesTouched }, { limits: { steps: 10 } });
  assert.equal(still.verdict, HOLD.ROTATE, 'overriding one limit disarmed the others');
});

/* ── the handover ───────────────────────────────────────────────────────── */

test('A HANDOVER CARRIES THE OBLIGATIONS FORWARD, and advances the attempt', () => {
  const r = rotationHandover({
    task_id: 't-1',
    attempt: 3,
    checkpoint_sha: 'f'.repeat(40),
    findings: ['F-001'],
    required_regressions: ['R-9'],
  });
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.equal(r.handover.attempt, 4, 'the successor would write under its predecessor\'s attempt');
  assert.equal(r.handover.predecessor_attempt, 3);
  assert.deepEqual(r.handover.findings, ['F-001'], 'findings were dropped: the successor re-derives paid-for work');
  assert.deepEqual(r.handover.required_regressions, ['R-9'], 'the successor does not know what it owes');
});

test('A HANDOVER WITH NOTHING COMMITTED IS REFUSED', () => {
  /*
   * That is a restart wearing the name of a rotation, and it is the shape that
   * silently loses an attempt's work.
   */
  const r = rotationHandover({ task_id: 't-1', attempt: 1, checkpoint_sha: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /checkpoint_sha is required/);

  assert.equal(rotationHandover({ attempt: 1, checkpoint_sha: 'a'.repeat(40) }).ok, false, 'a handover forgot its task');
  assert.equal(rotationHandover({ task_id: 't', checkpoint_sha: 'a'.repeat(40) }).ok, false, 'a handover had no attempt');
  assert.equal(rotationHandover().ok, false);
});

test('THE HANDOVER COPIES, so a successor cannot mutate its predecessor\'s record', () => {
  const findings = ['F-001'];
  const r = rotationHandover({ task_id: 't', attempt: 1, checkpoint_sha: 'a'.repeat(40), findings });
  r.handover.findings.push('F-002');
  assert.deepEqual(findings, ['F-001'], 'the handover aliased the caller\'s array');
});

/* ══ THE WIRING. A separate claim from everything above (rule 17). ══════ */

const LEASE = { lease_token: 'tok', leased_at: '2026-09-19T00:00:00Z', lease_expires_at: '2026-09-19T01:00:00Z' };
const NOW = '2026-09-19T00:05:00Z';
const TASK = { task_id: 't-42', state: 'assigned' };
const degraded = { ...healthy(), steps: LIMITS.steps };

test('WIRED: a degraded builder is told to rotate instead of starting new work', () => {
  /*
   * The cheap moment to hand over is BEFORE the next phase begins. If the bar
   * only sat in front of WAIT, a builder past its limit would still pick up
   * one more piece of work first.
   */
  const d = nextAction({ session_id: 's', task: TASK, lease: LEASE, run: null, observed: degraded }, { now: NOW });
  assert.equal(d.action, ACTION.ROTATE, 'the hold bar is not consulted on the START path');
  assert.equal(d.hold.verdict, HOLD.ROTATE);
  assert.match(d.reason, /held:/);
});

test('WIRED: without the bar, that same fixture starts work -- so the test can fail', () => {
  /*
   * Rule 1. The assertion above is only worth anything if the SAME fixture
   * reaches a different answer when nothing is degraded. Otherwise it could be
   * passing because `nextAction` returns ROTATE for everything.
   */
  const d = nextAction({ session_id: 's', task: TASK, lease: LEASE, run: null, observed: healthy() }, { now: NOW });
  assert.equal(d.action, ACTION.START);
});

test('WIRED: a running builder past the bar rotates rather than waiting', () => {
  const d = nextAction(
    { session_id: 's', task: TASK, lease: LEASE, run: { done: false }, observed: degraded },
    { now: NOW },
  );
  assert.equal(d.action, ACTION.ROTATE);
  assert.equal(
    nextAction({ session_id: 's', task: TASK, lease: LEASE, run: { done: false }, observed: healthy() }, { now: NOW }).action,
    ACTION.WAIT,
  );
});

test('WIRED: an unmonitored worker keeps working, and nothing pretends otherwise', () => {
  /*
   * No `observed` at all is today's production shape. It must not stall the
   * worker -- but it also must not be indistinguishable from a healthy one, so
   * the verdict carries measured:false out to the caller.
   */
  const d = nextAction({ session_id: 's', task: TASK, lease: LEASE, run: null }, { now: NOW });
  assert.equal(d.action, ACTION.START, 'a worker with no telemetry was stalled: rule 19, and the hook gets switched off');
  assert.equal(holdVerdict(undefined).measured, false);
});

/* ── precedence: the bar is last, and every neighbour must prove it ────── */

test('PRECEDENCE: the lease outranks the bar, in every direction it can', () => {
  /*
   * Rotating a task we no longer hold is worse than not rotating. Each fixture
   * here is BOTH degraded and lease-broken: if the ordering were wrong, every
   * one of these would answer ROTATE.
   */
  const expired = nextAction(
    { session_id: 's', task: TASK, lease: { ...LEASE, lease_expires_at: '2026-09-19T00:01:00Z' }, run: null, observed: degraded },
    { now: NOW },
  );
  assert.equal(expired.action, ACTION.ABANDON, 'a rotation was ordered on an expired lease');
  assert.equal(expired.discard, true);

  const noToken = nextAction(
    { session_id: 's', task: TASK, lease: { ...LEASE, lease_token: '' }, run: null, observed: degraded },
    { now: NOW },
  );
  assert.equal(noToken.action, ACTION.ABANDON, 'a rotation was ordered with no lease token to return under');

  const refused = nextAction(
    { session_id: 's', task: TASK, lease: LEASE, run: null, observed: degraded, renewalFailed: true },
    { now: NOW },
  );
  assert.equal(refused.action, ACTION.ABANDON, 'a rotation was ordered after renewal was refused');
});

test('PRECEDENCE: finished work is returned, never rotated', () => {
  /*
   * A rotation of a completed run throws away a result that already exists --
   * the same mistake the shutdown branch at the top of nextAction avoids.
   */
  const d = nextAction(
    { session_id: 's', task: TASK, lease: LEASE, run: { done: true, ok: true, headSha: 'a'.repeat(40) }, observed: degraded },
    { now: NOW },
  );
  assert.equal(d.action, ACTION.RETURN, 'a finished result was rotated away');
  assert.equal(d.outcome, 'completed');
});

test('PRECEDENCE: renewal and pause both outrank the bar', () => {
  /*
   * Checkpointing takes time, and doing it while the lease lapses loses the
   * work anyway. A paused builder is burning nothing and is waiting on a
   * person, so rotating it would hand a successor somebody else's pending
   * decision.
   */
  const dueSoon = { ...LEASE, lease_expires_at: '2026-09-19T00:05:30Z' };
  assert.equal(
    nextAction({ session_id: 's', task: TASK, lease: dueSoon, run: null, observed: degraded }, { now: NOW }).action,
    ACTION.RENEW,
  );
  assert.equal(
    nextAction(
      { session_id: 's', task: TASK, lease: LEASE, run: null, observed: degraded, pausedTaskIds: ['t-42'] },
      { now: NOW },
    ).action,
    ACTION.PAUSE,
  );
});

/* ── the FAIL path must actually be executable (rule 16) ───────────────── */

test('A HELD ATTEMPT CAN ACTUALLY BE RETURNED -- the decision is not a dead end', () => {
  /*
   * RULE 16, APPLIED TO A CONTROL RATHER THAN A TEST. `nextAction` answering
   * RETURN is worth nothing if `returnPayload` then refuses to build one,
   * which it would have: a held attempt is stopped mid-flight, so `run.done`
   * is false by construction and the old "the run has not finished" check
   * covered exactly this case. A verdict nothing can carry out is a control
   * firing into a wall.
   */
  const w = {
    session_id: 's',
    task: TASK,
    lease: LEASE,
    run: null,
    observed: { ...healthy(), steps: LIMITS.steps, checkpointable: false },
  };
  const d = nextAction(w, { now: NOW });
  assert.equal(d.action, ACTION.RETURN);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.hold.verdict, HOLD.FAIL);

  const p = returnPayload({ ...w, hold: d.hold }, { now: NOW });
  assert.equal(p.ok, true, `the hold verdict could not be carried out: ${p.errors?.join('; ')}`);
  assert.equal(p.body.outcome, 'failed');
  assert.equal(p.body.head_sha, null, 'a commit was invented for an attempt that produced none');
  assert.match(p.body.notes, /^HELD: /);
  assert.match(p.body.notes, /cannot be checkpointed/, 'the operator is not told why the attempt was stopped');
});

test('THE RELAXATION IS NARROW: a completed run still has to name its commit', () => {
  /*
   * Rule 5 for the widening itself. Letting a held attempt return without a
   * commit is only safe if it did not also let a run that CLAIMS to have
   * completed skip the evidence -- "the commit is derived, never supplied" is
   * the property that stops a return being a claim about work.
   */
  const p = returnPayload(
    { session_id: 's', task: TASK, lease: LEASE, run: { done: true, ok: true, headSha: '' } },
    { now: NOW },
  );
  assert.equal(p.ok, false, 'a completed return was accepted with no commit');
  assert.match(p.errors.join(' '), /must carry the commit/);

  /* And a non-FAIL hold must not open the same door. */
  const rotating = returnPayload(
    { session_id: 's', task: TASK, lease: LEASE, run: null, hold: { verdict: HOLD.ROTATE, why: 'x' } },
    { now: NOW },
  );
  assert.equal(rotating.ok, false, 'a ROTATE verdict was accepted as grounds for a failed return');

  /* A held return still needs a lease token; the relaxation is about the commit only. */
  const noTok = returnPayload(
    { session_id: 's', task: TASK, lease: { ...LEASE, lease_token: '' }, run: null, hold: { verdict: HOLD.FAIL, why: 'x' } },
    { now: NOW },
  );
  assert.equal(noTok.ok, false, 'a held return skipped the lease token');
});
