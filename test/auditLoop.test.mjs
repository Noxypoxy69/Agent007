/**
 * THE SCHEDULER'S DECISIONS, WATCHED.
 *
 * Every tick this thing authorises is a paid LLM review, so the branch that
 * matters most is the one that STOPS. A backoff nobody has watched is how a
 * loop bills once a second; a stop condition nobody has watched is how a
 * backlog gets reported as drained.
 *
 * Pure input, pure output: no clock, no fs, no spawn. That is the whole
 * reason the decision was split out of the daemon (rule 10) -- the daemon
 * cannot be imported without it trying to consume a job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextAction, LOOP_ACTION, LOOP_STOP, LOOP_DEFAULTS,
} from '../src/auditLoop.mjs';

test('THE POSITIVE FIRST: work available and budget left means TICK (rule 5)', () => {
  const r = nextAction({ ticksUsed: 0, consecutiveNoProgress: 0, queueDepth: 7 });
  assert.equal(r.action, LOOP_ACTION.TICK,
    'a loop that never ticks is not a scheduler, and every stop below would be vacuous');
  assert.match(r.why, /7 claimable/);
});

test('THE BUDGET IS A HARD STOP, and it counts ATTEMPTS not successes', () => {
  /*
   * Spending is the owner's call. A loop that treats its cap as advisory is
   * the failure that costs money rather than correctness, and it is the one
   * failure this repository cannot measure after the fact.
   */
  const r = nextAction(
    { ticksUsed: 3, consecutiveNoProgress: 0, queueDepth: 50 },
    { maxTicks: 3 },
  );
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.BUDGET);

  /* Derived from the default rather than typed, so raising it extends the
   * coverage instead of silently skipping it (rule 7). */
  const atDefault = nextAction({ ticksUsed: LOOP_DEFAULTS.maxTicks, queueDepth: 50 });
  assert.equal(atDefault.code, LOOP_STOP.BUDGET);

  /* And one under the bound still runs -- the boundary is exact, not off by one. */
  const under = nextAction({ ticksUsed: LOOP_DEFAULTS.maxTicks - 1, queueDepth: 50 });
  assert.equal(under.action, LOOP_ACTION.TICK);
});

test('maxTicks 0 MEANS ZERO, even with a full queue', () => {
  /*
   * "Do not launch anything" must survive a queue that wants attention.
   * This is the dry-run contract, and a scheduler that overrides it because
   * work exists has removed the operator's only cost control.
   */
  const r = nextAction({ ticksUsed: 0, queueDepth: 115 }, { maxTicks: 0 });
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.BUDGET);
});

test('AN EMPTY QUEUE STOPS, and says it is the good ending', () => {
  const r = nextAction({ ticksUsed: 1, queueDepth: 0 });
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.EMPTY);
});

test('STARVED IS NOT EMPTY -- different code, and it names the backlog', () => {
  /*
   * The distinction this whole subsystem exists for. Measured on this
   * machine: 115 claimable jobs and none placeable, because one seat held
   * one live claim. Reporting that as "drained" is the lie that let the
   * queue reach 115 in the first place.
   */
  const r = nextAction(
    { ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 115 },
    { starvedLimit: 5 },
  );
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.STARVED);
  assert.notEqual(r.code, LOOP_STOP.EMPTY, 'a starved queue was reported as drained');
  assert.match(r.why, /115/, 'the stop reason does not say how much work was left behind');
  assert.match(r.why, /NOT EMPTY/);
});

test('BACKOFF IS EXPONENTIAL AND CAPPED, and it is watched at both ends', () => {
  const opts = { intervalMs: 1000, maxIntervalMs: 8000, starvedLimit: 99 };

  const one = nextAction({ queueDepth: 5, consecutiveNoProgress: 1 }, opts);
  assert.equal(one.action, LOOP_ACTION.WAIT);
  assert.equal(one.waitMs, 2000);

  assert.equal(nextAction({ queueDepth: 5, consecutiveNoProgress: 2 }, opts).waitMs, 4000);
  assert.equal(nextAction({ queueDepth: 5, consecutiveNoProgress: 3 }, opts).waitMs, 8000);

  /* CAPPED: without this a few idle cycles reach hours and the loop is
   * "running" in name only. */
  assert.equal(nextAction({ queueDepth: 5, consecutiveNoProgress: 9 }, opts).waitMs, 8000,
    'backoff grew past its cap');
});

test('A DEADLINE STOPS THE LOOP whatever it is doing', () => {
  const r = nextAction(
    { queueDepth: 50, startedAt: 1000, now: 1000 + 60_000 },
    { deadlineMs: 60_000 },
  );
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.DEADLINE);

  /* THE POSITIVE (rule 5): one millisecond before, it still works. */
  const before = nextAction(
    { queueDepth: 50, startedAt: 1000, now: 1000 + 59_999 },
    { deadlineMs: 60_000 },
  );
  assert.equal(before.action, LOOP_ACTION.TICK);
});

test('AN UNREADABLE CLOCK DOES NOT SILENTLY DISABLE THE DEADLINE', () => {
  /*
   * Fail-safe direction check. If the clock is missing the deadline cannot
   * be evaluated -- so the loop must fall through to its OTHER bounds
   * (budget, starvation) rather than run unbounded. Asserted because "could
   * not measure" quietly becoming "no limit" is this repository's signature
   * bug, and a deadline is the last line when the others are raised.
   */
  const r = nextAction(
    { queueDepth: 50, ticksUsed: 99, startedAt: undefined, now: undefined },
    { deadlineMs: 1, maxTicks: 3 },
  );
  assert.equal(r.action, LOOP_ACTION.STOP);
  assert.equal(r.code, LOOP_STOP.BUDGET,
    'with an unreadable clock the deadline was skipped AND no other bound caught it');
});

test('EVERY STOP CARRIES A REASON -- generated from the real code list', () => {
  /*
   * Rule 7: derived from LOOP_STOP rather than from the four cases I
   * happened to write, so a new stop code cannot ship mute. A supervisor
   * whose exits are indistinguishable is the defect this repo has a whole
   * section about.
   */
  const seen = new Map();
  const cases = [
    [{ queueDepth: 50, ticksUsed: 9 }, { maxTicks: 3 }],
    [{ queueDepth: 0 }, {}],
    [{ queueDepth: 9, consecutiveNoProgress: 99 }, {}],
    [{ queueDepth: 9, startedAt: 0, now: 10 }, { deadlineMs: 1 }],
  ];
  for (const [s, o] of cases) {
    const r = nextAction(s, o);
    if (r.action === LOOP_ACTION.STOP) seen.set(r.code, r.why);
  }
  for (const code of Object.values(LOOP_STOP)) {
    assert.ok(seen.has(code), `no case produced stop code ${code}; it may be unreachable`);
    assert.ok(seen.get(code).length > 20, `stop code ${code} has no usable reason`);
  }
});

test('GARBAGE STATE DOES NOT THROW and does not invent work', () => {
  /*
   * The scheduler reads a queue file other processes write. A malformed
   * depth must not crash the loop, and must not be read as "there is work"
   * -- inventing work means spending money on a number nobody wrote.
   */
  for (const bad of [null, undefined, 'seven', {}, [], NaN, -1, Infinity]) {
    const r = nextAction({ queueDepth: bad, ticksUsed: 0 });
    assert.equal(r.action, LOOP_ACTION.STOP, `queueDepth ${JSON.stringify(bad)} did not fail closed`);
    assert.equal(r.code, LOOP_STOP.EMPTY);
  }
  assert.doesNotThrow(() => nextAction(null, null));
  assert.doesNotThrow(() => nextAction(undefined, undefined));
});
