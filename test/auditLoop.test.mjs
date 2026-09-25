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

  /*
   * AND IT DOES NOT GUESS A REMEDY (M-E). The old message asserted two
   * causes and recommended registering a seat or waiting for leases --
   * neither of which touches REVIEW_EXHAUSTED or AUTHOR_UNKNOWN, so a
   * queue of only those would stop for ever while advising a fix that
   * cannot work.
   */
  assert.doesNotMatch(r.why, /^.*Register another seat, or wait/,
    'the stop message still prescribes a remedy without knowing the cause');
  assert.match(r.why, /UNKNOWN rather than assumed/,
    'with no reasons reported, the message must say the cause is unknown');

  /* Given the real reasons, it PRINTS them instead. */
  const told = nextAction(
    {
      ticksUsed: 1,
      consecutiveNoProgress: 5,
      queueDepth: 115,
      unplacedReasons: ['review_exhausted', 'author_unknown'],
    },
    { starvedLimit: 5 },
  );
  assert.match(told.why, /review_exhausted/);
  assert.match(told.why, /author_unknown/);
  assert.match(told.why, /only helps the seat-related ones/,
    'it lists the reasons but still implies waiting will fix them');
});

test('BACKOFF IS EXPONENTIAL AND CAPPED, and it is watched at both ends', () => {
  /*
   * `maxTicks` is raised alongside `starvedLimit` because the two are now
   * RECONCILED -- starvedLimit is clamped to maxTicks - 1 so STARVED stays
   * reachable at any budget (M-1). Without the raise, `starvedLimit: 99`
   * silently becomes 4 and the curve stops being observable past that.
   * Stating it here because a reader who changes one and not the other
   * gets a confusing red.
   */
  const opts = {
    intervalMs: 1000, maxIntervalMs: 8000, starvedLimit: 99, maxTicks: 1000,
  };

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

test('A SERVED BACKOFF LEADS TO A TICK, not another backoff', () => {
  /*
   * MEASURED as a live defect, not imagined. The first version returned
   * WAIT whenever noProgress > 0, and noProgress only changes after a
   * TICK -- so the loop waited, came back, saw the same count, and waited
   * again for ever. It ran 300 seconds without a second tick and without
   * stopping, printing "backing off" each time.
   *
   * Worse than a spin, because a spin is visible and expensive while this
   * looked exactly like a healthy supervisor and did nothing. It also made
   * the STARVED stop unreachable, so the loop could never report the
   * backlog it was sitting on.
   */
  const s = { queueDepth: 50, consecutiveNoProgress: 2 };

  const first = nextAction(s, { intervalMs: 1000 });
  assert.equal(first.action, LOOP_ACTION.WAIT, 'the backoff never happens at all');

  const after = nextAction({ ...s, backoffServed: true }, { intervalMs: 1000 });
  assert.equal(after.action, LOOP_ACTION.TICK,
    'after sleeping, the loop backed off AGAIN instead of retrying -- it can never '
    + 'tick a second time and can never reach the starved stop');

  /*
   * The backoff still GROWS across genuine no-progress cycles; serving one
   * must not flatten the curve.
   *
   * OBSERVED BELOW starvedLimit, and derived from it rather than typed.
   * This used to assert n=3 and broke when starvedLimit dropped to 3 --
   * correctly, because at the limit the loop STOPS rather than waits. A
   * literal here is a claim about one configuration, which is the same
   * mistake as encoding a machine's accident (rule 21).
   */
  const below = LOOP_DEFAULTS.starvedLimit - 1;
  assert.ok(below >= 2, `starvedLimit ${LOOP_DEFAULTS.starvedLimit} leaves no curve to observe`);
  assert.equal(nextAction({ ...s, consecutiveNoProgress: 1 }, { intervalMs: 1000 }).waitMs, 2000);
  assert.equal(
    nextAction({ ...s, consecutiveNoProgress: below }, { intervalMs: 1000 }).waitMs,
    1000 * (2 ** below),
  );

  /*
   * And a served backoff still yields to the STOP conditions, or the loop
   * would tick past its budget on the cycle after every wait.
   *
   * `consecutiveNoProgress: 0` ISOLATES BUDGET. This passed `s` whole,
   * carrying noProgress 2, and with `maxTicks: 3` the M-1 reconciliation
   * clamps starvedLimit to 2 -- so STARVED fired first and the assertion
   * named the wrong code. Both are correct stops; the test was pinning an
   * interaction it did not mean to test.
   */
  const capped = nextAction(
    { ...s, backoffServed: true, ticksUsed: 9, consecutiveNoProgress: 0 },
    { intervalMs: 1000, maxTicks: 3 },
  );
  assert.equal(capped.action, LOOP_ACTION.STOP);
  assert.equal(capped.code, LOOP_STOP.BUDGET);
});

test('T-291 B-10: backoffServed IS SERVED ONLY FOR THE BOOLEAN true', () => {
  /*
   * It was read by truthiness, so "false", "no", 1 and {} all skipped the
   * backoff (T-277, 09c51a3 F1). Skipping a wait is the unsafe direction,
   * so every value except the boolean true must still WAIT.
   *
   * THE POSITIVE FIRST (rule 5): this state waits when nothing is served
   * and ticks when true is, or every WAIT row below is vacuous.
   */
  const s = { queueDepth: 50, consecutiveNoProgress: 1 };
  const opts = { intervalMs: 1000 };
  assert.equal(nextAction(s, opts).action, LOOP_ACTION.WAIT, 'precondition: this state does not back off at all');

  /*
   * T-298 (Controller ruling; pinned defect T-293 F2): the non-boolean rows
   * were WAIT, and a caller that writes the marker after every WAIT then
   * waited for ever. They are now the fail-closed terminal STOP (STARVED),
   * which is neither "served" nor a wait. null is corrupt too (see src).
   */
  const table = [
    [true, LOOP_ACTION.TICK],
    [false, LOOP_ACTION.WAIT],
    ['true', LOOP_ACTION.STOP],
    ['false', LOOP_ACTION.STOP],
    ['no', LOOP_ACTION.STOP],
    [1, LOOP_ACTION.STOP],
    [0, LOOP_ACTION.STOP],
    [{}, LOOP_ACTION.STOP],
    [NaN, LOOP_ACTION.STOP],
    [null, LOOP_ACTION.STOP],
    [undefined, LOOP_ACTION.WAIT],
  ];
  for (const [value, want] of table) {
    const label = value === undefined ? 'undefined' : Number.isNaN(value) ? 'NaN' : JSON.stringify(value);
    const r = nextAction({ ...s, backoffServed: value }, opts);
    const got = r.action;
    assert.equal(got, want, want === LOOP_ACTION.TICK
      ? `B-10: backoffServed ${label} was NOT read as served (got ${got})`
      : want === LOOP_ACTION.STOP
        ? `B-22: corrupt backoffServed ${label} did not fail closed (got ${got})`
        : `B-10: backoffServed ${label} was read as served (got ${got})`);
    if (want === LOOP_ACTION.STOP) {
      assert.equal(r.code, LOOP_STOP.STARVED, `B-22: corrupt backoffServed ${label} stopped as ${r.code}`);
      assert.ok(r.why.includes(`backoffServed is ${label}`), `B-22: the reason does not name the marker: ${r.why}`);
    }
  }
});

test('T-298 B-22: A CORRUPT backoffServed ENDS THE CALLER LOOP, it never waits for ever', () => {
  /*
   * T-293 F2: a caller that writes a non-boolean marker after every WAIT got
   * 200 waits and 0 ticks. Driven through the caller's real invariant
   * (counters in lockstep, the marker written after each WAIT), over the
   * marker table. Corrupt markers must reach a terminal STOP naming the
   * marker; the boolean true must still tick and reach STARVED normally.
   */
  const drive = (marker) => {
    let ticksUsed = 0; let noProgress = 1; let served = false; let last = null; let waits = 0; let ticks = 0;
    for (let i = 0; i < 200; i += 1) {
      last = nextAction({ ticksUsed, consecutiveNoProgress: noProgress, queueDepth: 40, backoffServed: served },
        { intervalMs: 1000, maxTicks: 50 });
      if (last.action === LOOP_ACTION.STOP) return { last, waits, ticks, steps: i + 1 };
      if (last.action === LOOP_ACTION.WAIT) { waits += 1; served = marker; continue; }
      ticks += 1; ticksUsed += 1; noProgress += 1; served = false;
    }
    return { last, waits, ticks, steps: 200 };
  };

  /* THE POSITIVE FIRST (rule 5): the boolean true ticks, then starves normally. */
  const healthy = drive(true);
  assert.equal(healthy.last.action, LOOP_ACTION.STOP);
  assert.equal(healthy.last.code, LOOP_STOP.STARVED);
  assert.ok(healthy.ticks >= 1, 'premise: the boolean true never ticked');
  assert.ok(!/backoffServed is/.test(healthy.last.why), 'the healthy run stopped on the corrupt-marker path');

  for (const [label, marker] of [['"true"', 'true'], ['"false"', 'false'], ['1', 1], ['0', 0], ['{}', {}], ['null', null], ['NaN', NaN]]) {
    const r = drive(marker);
    assert.equal(r.last.action, LOOP_ACTION.STOP,
      `B-22: marker ${label} gave ${r.waits} waits and ${r.ticks} ticks in ${r.steps} steps with no terminal state`);
    assert.equal(r.last.code, LOOP_STOP.STARVED, `B-22: marker ${label} stopped as ${r.last.code}`);
    assert.ok(r.last.why.includes(`backoffServed is ${label}`), `B-22: the reason does not name marker ${label}: ${r.last.why}`);
    assert.equal(r.waits, 1, `B-22: marker ${label} waited ${r.waits} times; only the first (unmarked) wait is legitimate`);
  }

  /* BOOLEAN false AND ABSENT ARE UNCHANGED: not served, so WAIT with progress
   * pending, and TICK with none. */
  for (const [label, marker] of [['false', false], ['undefined', undefined]]) {
    assert.equal(nextAction({ queueDepth: 40, consecutiveNoProgress: 1, backoffServed: marker }, { intervalMs: 1000 }).action,
      LOOP_ACTION.WAIT, `marker ${label} no longer waits`);
    assert.equal(nextAction({ queueDepth: 40, consecutiveNoProgress: 0, backoffServed: marker }).action,
      LOOP_ACTION.TICK, `marker ${label} no longer ticks with no backoff owed`);
  }
  assert.equal(nextAction({ queueDepth: 40, consecutiveNoProgress: 0, backoffServed: true }).action, LOOP_ACTION.TICK);
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

test('STARVED IS REACHABLE THROUGH THE REAL CALLER, not only from a hand-built state', () => {
  /*
   * Blind audit M-1, and it is hollow gate 9 in my own test file. The two
   * existing STARVED cases pass `{ ticksUsed: 1, consecutiveNoProgress: 5 }`
   * and `{ consecutiveNoProgress: 99 }` -- shapes the daemon CANNOT
   * produce, because it increments both counters together and neither
   * moves on a WAIT, so it maintains `noProgress <= ticksUsed` always.
   *
   * With both limits at 5, BUDGET was reached on the same cycle that would
   * have tripped STARVED and won every time. STARVED -- the reason this
   * module exists -- was unreachable, and a blocked backlog was reported
   * as budget exhaustion with advice to RAISE THE SPEND CAP.
   *
   * So this simulates the caller's own invariant instead of asserting a
   * state: counters in lockstep, exactly as audit-daemon.mjs does it.
   */
  let ticksUsed = 0;
  let noProgress = 0;
  let backoffServed = false;
  let last = null;

  for (let i = 0; i < 50; i += 1) {
    last = nextAction({
      ticksUsed, consecutiveNoProgress: noProgress, queueDepth: 118, backoffServed,
    });
    if (last.action === LOOP_ACTION.STOP) break;
    if (last.action === LOOP_ACTION.WAIT) { backoffServed = true; continue; }
    backoffServed = false;
    ticksUsed += 1;
    noProgress += 1; /* a permanently starved queue: nothing is ever placed */
  }

  assert.equal(last.action, LOOP_ACTION.STOP);
  assert.equal(last.code, LOOP_STOP.STARVED,
    'a permanently starved queue stopped for some other reason. If that reason is '
    + 'budget_exhausted, the operator is told to raise a SPEND cap while nothing was '
    + 'spent and every seat is blocked');
  assert.match(last.why, /118/);

  /* AND THE PREMISE (rule 6): the invariant this depends on really holds --
   * starvedLimit must be strictly below maxTicks or the above is luck. */
  assert.ok(LOOP_DEFAULTS.starvedLimit < LOOP_DEFAULTS.maxTicks,
    'starvedLimit >= maxTicks makes STARVED unreachable through the real caller');
});

test('STARVED STAYS REACHABLE AT ANY --max-ticks the operator can pass (M-1)', () => {
  /*
   * The premise above checks the DEFAULTS OBJECT, which is not the value
   * the function used -- so it could not see that `--max-ticks 2` or `1`
   * puts the budget below `starvedLimit: 3` and hands BUDGET the win
   * again. A cost-conscious operator lowering the spend cap is the single
   * most likely person to touch that flag, and they got back exactly the
   * misleading "raise the spend cap" message the reorder removed.
   *
   * Driven through the caller's real invariant at every budget the daemon
   * accepts, rather than asserted about a constant.
   */
  for (const maxTicks of [1, 2, 3, 5, 9]) {
    let ticksUsed = 0;
    let noProgress = 0;
    let backoffServed = false;
    let last = null;

    for (let i = 0; i < 100; i += 1) {
      last = nextAction(
        { ticksUsed, consecutiveNoProgress: noProgress, queueDepth: 40, backoffServed },
        { maxTicks },
      );
      if (last.action === LOOP_ACTION.STOP) break;
      if (last.action === LOOP_ACTION.WAIT) { backoffServed = true; continue; }
      backoffServed = false;
      ticksUsed += 1;
      noProgress += 1;
    }

    assert.equal(last.code, LOOP_STOP.STARVED,
      `at --max-ticks ${maxTicks} a permanently starved queue stopped as ${last.code}. `
      + 'If that is budget_exhausted the operator is told to raise a spend cap while '
      + 'nothing was spent and every seat is blocked');
  }

  /* THE POSITIVE (rule 5): a queue that IS draining still reports BUDGET,
   * so the reconciliation has not turned STARVED into the only outcome. */
  const drained = nextAction({ ticksUsed: 5, consecutiveNoProgress: 0, queueDepth: 40 }, { maxTicks: 5 });
  assert.equal(drained.code, LOOP_STOP.BUDGET);
});

test('deadlineMs IS VALIDATED TOO -- it was the one opts field left open (M-2)', () => {
  /*
   * The hardening pass routed maxTicks, starvedLimit, intervalMs and
   * maxIntervalMs through `num` and left deadlineMs on the bare spread,
   * where a non-number is silently ignored. `'600000'` is exactly what a
   * caller computing `posInt(...) * 1000` could hand it, and it disabled
   * the deadline with no word -- the same failure as maxTicks, inside the
   * fix that said every opts field was covered.
   */
  const past = { queueDepth: 50, startedAt: 0, now: 10_000 };

  for (const bad of ['600000', NaN, {}, [], true]) {
    const r = nextAction(past, { deadlineMs: bad, maxTicks: 99 });
    assert.equal(r.action, LOOP_ACTION.STOP,
      `deadlineMs ${JSON.stringify(bad)} silently disabled the deadline`);
    assert.equal(r.code, LOOP_STOP.DEADLINE);
  }

  /* A real number still works in both directions (rule 5). */
  assert.equal(nextAction(past, { deadlineMs: 5_000, maxTicks: 99 }).code, LOOP_STOP.DEADLINE);
  assert.equal(nextAction(past, { deadlineMs: 50_000, maxTicks: 99 }).action, LOOP_ACTION.TICK);

  /* And ABSENT still means "no deadline", which is the documented default
   * and must not become "stop immediately". */
  assert.equal(nextAction(past, { maxTicks: 99 }).action, LOOP_ACTION.TICK);
  assert.equal(nextAction(past, { deadlineMs: undefined, maxTicks: 99 }).action, LOOP_ACTION.TICK);

  /*
   * AND ZERO IS A REAL DEADLINE, NOT THE ABSENCE OF ONE (L-2).
   *
   * The daemon computed `posInt('--deadline', 0) * 1000 || undefined`, so
   * `--deadline 0` -- the tightest bound an operator can ask for -- fell
   * through `||` and became NO bound. The sentinel for "not asked for" and
   * a value the operator can type were the same token.
   */
  const atZero = nextAction({ queueDepth: 50, startedAt: 0, now: 0 }, { deadlineMs: 0, maxTicks: 99 });
  assert.equal(atZero.action, LOOP_ACTION.STOP,
    'deadlineMs 0 was read as "no deadline", which is the opposite of what it asks for');
  assert.equal(atZero.code, LOOP_STOP.DEADLINE);
});

test('THE SPEND BOUND FAILS CLOSED ON A NON-NUMBER, like every state field', () => {
  /*
   * Blind audit M-2. `state` was validated and `opts` was not, and spread
   * means an explicitly present `maxTicks: undefined` OVERRIDES the default
   * rather than falling back. So the only spending bound in the system was
   * the one value nothing checked, and it failed OPEN: TICK for ever.
   *
   * Generated from the hostile shapes rather than the one I thought of.
   */
  for (const bad of [undefined, NaN, 'abc', '5', {}, [], -1, Infinity, true]) {
    const r = nextAction({ ticksUsed: 99, queueDepth: 50 }, { maxTicks: bad });
    assert.equal(r.action, LOOP_ACTION.STOP,
      `maxTicks ${JSON.stringify(bad)} left the loop ticking with 99 ticks used`);
    assert.equal(r.code, LOOP_STOP.BUDGET);
  }

  /* THE POSITIVE (rule 5): a real number is still honoured in both
   * directions, so the guard above is not just forcing a constant. */
  assert.equal(nextAction({ ticksUsed: 2, queueDepth: 50 }, { maxTicks: 9 }).action,
    LOOP_ACTION.TICK);
  assert.equal(nextAction({ ticksUsed: 9, queueDepth: 50 }, { maxTicks: 9 }).code,
    LOOP_STOP.BUDGET);
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
