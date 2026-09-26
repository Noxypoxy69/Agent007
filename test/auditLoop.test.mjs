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
import { readFileSync } from 'node:fs';
import { constants } from 'node:buffer';
import { spawnSync } from 'node:child_process';

import { stripComments } from '../src/moduleGraph.mjs';
import {
  nextAction, LOOP_ACTION, LOOP_STOP, LOOP_DEFAULTS, capText,
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
    /* Two-sided (T-356 r2, hook K-5: no assertion behind an if): a STOP names the marker and carries STARVED; a
     * WAIT or TICK carries no stop code and does not talk about the marker. */
    assert.equal(r.code, want === LOOP_ACTION.STOP ? LOOP_STOP.STARVED : undefined, `B-22: backoffServed ${label} ${want === LOOP_ACTION.STOP ? `stopped as ${r.code}` : `carries stop code ${r.code} on a ${got}`}`);
    assert.equal(r.why.includes(`backoffServed is ${label}`), want === LOOP_ACTION.STOP, `B-22: the reason does not name the marker${want === LOOP_ACTION.STOP ? '' : ' -- or names it on a non-stop'}: ${r.why}`);
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

test('T-305 B-25 F1: THE CORRUPT-MARKER REASON IS TOTAL -- it never throws, and it names the type', () => {
  /*
   * T-302 F1: the reason was built with JSON.stringify, which THROWS on a
   * BigInt (and on a cycle, or a throwing toJSON) and returns undefined for a
   * symbol or a function. A fail-closed branch that throws is not closed: the
   * caller sees an exception, not STOP. Generated from the shapes
   * JSON.stringify cannot print, not from the one that was reported (rule 8).
   */
  const s = { queueDepth: 50, consecutiveNoProgress: 1 };
  const cyclic = {}; cyclic.self = cyclic;
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const hostile = [
    ['bigint', 10n],
    ['bigint', 0n],
    ['symbol', Symbol('x')],
    ['function', () => true],
    ['object', cyclic],
    ['object', Object.create(null)],
    ['object', { toJSON() { throw new Error('toJSON bomb'); } }],
    ['object', { toJSON() { throw new Error('bomb'); }, toString() { throw new Error('bomb'); } }],
    ['object', revoked],
    ['array', [1n]],
  ];
  for (const [type, value] of hostile) {
    let r;
    assert.doesNotThrow(() => { r = nextAction({ ...s, backoffServed: value }, { intervalMs: 1000 }); },
      `F1: a ${type} backoffServed threw in the reason builder`);
    assert.equal(r.action, LOOP_ACTION.STOP, `F1: a ${type} marker did not fail closed (got ${r.action})`);
    assert.equal(r.code, LOOP_STOP.STARVED);
    assert.equal(typeof r.why, 'string');
    assert.match(r.why, /^backoffServed is /, `F1: the reason lost its subject: ${r.why}`);
    assert.ok(r.why.includes(`(${type})`), `F1: the reason does not name the type ${type}: ${r.why}`);
  }
  /* The BigInt is shown as what it is, not as a number it is not. */
  assert.ok(nextAction({ ...s, backoffServed: 10n }).why.startsWith('backoffServed is 10n (bigint)'));
});

/*
 * ═══ T-316 / B-28 F-A: THE DESCRIBED VALUE IS BOUNDED, BEFORE ANY CONCATENATION ═══
 *
 * T-308 F-A: after T-305 the builder no longer threw on a BigInt or a cycle,
 * but an object whose toString returns a near-MAX_STRING_LENGTH string made
 * `${text} (${type})` overflow -- a RangeError out of a fail-closed branch --
 * and nothing capped the text at all. The rope is derived from the running
 * engine (rule 21); `repeat` builds it lazily and the first slice flattens
 * it once (measured ~0.15 s, ~540 MB transient on node 24).
 */
const NEAR_MAX = 'x'.repeat(constants.MAX_STRING_LENGTH - 5);
const shownFor = (value) => {
  const r = nextAction({ queueDepth: 50, consecutiveNoProgress: 1, backoffServed: value }, { intervalMs: 1000 });
  assert.equal(r.action, LOOP_ACTION.STOP);
  const m = /^backoffServed is ([\s\S]*) \((\w+)\), which is not a boolean\. /.exec(r.why);
  assert.ok(m, `F-A: the reason lost its subject or type: ${String(r.why).slice(0, 120)}`);
  return { text: m[1], type: m[2] };
};

test('T-316 B-28 F-A: A NEAR-MAX-LENGTH VALUE NEVER THROWS, and the text shown is capped', () => {
  const hostile = [
    ['object', { toJSON() { return undefined; }, toString() { return NEAR_MAX; } }],
    ['object', { toJSON() { throw new Error('t'); }, toString() { return NEAR_MAX; } }],
    ['object', { toJSON() { return NEAR_MAX; } }],
    ['string', NEAR_MAX],
    ['string', `${NEAR_MAX}yyyy`],
    ['array', [NEAR_MAX]],
    ['object', { k: NEAR_MAX }],
    ['string', 'y'.repeat(1e6)],
    ['bigint', 10n ** 1000n],
  ];
  for (const [type, value] of hostile) {
    let got;
    try { got = shownFor(value); } catch (e) {
      if (e?.code === 'ERR_ASSERTION') throw e;
      assert.fail(`F-A: a ${type} backoffServed THREW in the reason builder: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(got.type, type, `F-A: a ${type} was described as ${got.type}`);
    assert.ok(got.text.length <= 201, `F-A: the described ${type} is UNBOUNDED (${got.text.length} chars)`);
  }
});

test('T-316 r3 (a): THE STARVED REASON NEVER THROWS ON A HOSTILE unplacedReasons, and it is capped', () => {
  /*
   * `Array.isArray` throws on a revoked proxy, `.filter` runs a hostile get
   * trap, and `reasons.join(', ')` overflowed on a near-max element -- all
   * inside the STOP branch the operator most needs to see. Hostile at BOTH
   * levels: the container, and the elements in it (rule 7).
   */
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const { proxy: revokedArr, revoke: revokeArr } = Proxy.revocable([], {}); revokeArr();
  const trapArr = new Proxy(['a'], {
    get(t, k) { if (k === 'length' || typeof k === 'symbol') return Reflect.get(t, k); throw new Error('arr get trap'); },
  });
  const cyclic = {}; cyclic.self = cyclic;
  const hostile = [
    ['revoked proxy', revoked], ['revoked array proxy', revokedArr], ['array with a get trap', trapArr],
    ['[nearMax]', [NEAR_MAX]], ['[nearMax, nearMax+y]', [NEAR_MAX, `${NEAR_MAX}y`]],
    ['50 distinct 250-char reasons', Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(250, 'r'))],
    ['hostile elements', [2n, Symbol('s'), cyclic, revoked, { toString() { throw new Error('t'); } }, null, 'ok_code']],
    ['2n', 2n], ['string', 'review_exhausted'], ['object', { length: 3 }],
  ];
  for (const [label, value] of hostile) {
    let r;
    try {
      r = nextAction({ ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: value }, { starvedLimit: 5 });
    } catch (e) {
      assert.fail(`(a): a ${label} unplacedReasons THREW in the STARVED reason: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.code, LOOP_STOP.STARVED, `(a): a ${label} unplacedReasons did not stop as STARVED`);
    assert.ok(r.why.length <= 3000, `(a): the STARVED reason for a ${label} is UNBOUNDED (${r.why.length} chars)`);
    assert.match(r.why, /THE QUEUE IS NOT EMPTY/);
  }
  /* A container that cannot be read is NAMED as such, not passed off as "none reported". */
  const unread = nextAction({ ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: revoked }, { starvedLimit: 5 });
  assert.match(unread.why, /could not be read/, '(a): an unreadable unplacedReasons was reported as if absent');
  /* THE POSITIVE (rule 5): real codes still print whole, beside hostile elements. */
  const mixed = nextAction({ ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: hostile[6][1] }, { starvedLimit: 5 });
  assert.match(mixed.why, /The dispatcher refused them for: ok_code\. /);
  /* The cap is on the COUNT too: 50 distinct reasons show the first 10 and say how many were left out. */
  const many = nextAction({ ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: hostile[5][1] }, { starvedLimit: 5 });
  assert.match(many.why, /, and 40 more\. /, '(a): 50 reasons were not cut to 10 plus a count');
  /* Positive first: the 10th IS printed (as its capped prefix); then the 11th is not. */
  assert.ok(many.why.includes('9rrrr'), '(a): premise: the 10th reason is not shown');
  assert.ok(!many.why.includes('10rrrr'), '(a): the 11th reason was printed');
});

/*
 * ═══ T-316 r4 / T-324 F1: A REAL ARRAY CAN STILL BE HOSTILE ═══
 *
 * r3 called Array.prototype.filter on the input, which builds its result
 * through `constructor[Symbol.species]`, and then spread `new Set(result)`,
 * which runs the result's own iterator -- so a real Array (isArray true)
 * delivered 5n, null, an object and a Symbol into capText, OUTSIDE the
 * guard. At 8a8e136 four of those returned STARVED: a new throw. The fix
 * is the matcher, not these inputs (rule 8): an index loop into a fresh
 * array, no method the input can override, everything inside the guard.
 */
const STARVED_WITH = (reasons) => nextAction(
  { ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: reasons }, { starvedLimit: 5 },
);
const hostileArrays = () => {
  const yields = [5n, null, { toString() { return 'objreason'; } }, 7, Symbol('s')];
  const species = ['real_code'];
  species.constructor = {
    [Symbol.species]: function Species() {
      const out = [];
      out[Symbol.iterator] = function* it() { yield* yields; };
      return out;
    },
  };
  const ownIterator = ['real_code'];
  ownIterator[Symbol.iterator] = function* it() { yield* yields; };
  const ownMethods = ['real_code'];
  for (const m of ['filter', 'map', 'slice', 'join', 'includes', 'forEach', 'concat', 'indexOf', 'some', 'every', 'reduce']) {
    ownMethods[m] = () => { throw new Error(`own ${m} called`); };
  }
  const getterElement = ['real_code'];
  Object.defineProperty(getterElement, 1, { get() { throw new Error('element getter'); }, enumerable: true });
  const lengthTrap = new Proxy(['real_code'], { get(t, k) { if (k === 'length') throw new Error('length trap'); return Reflect.get(t, k); } });
  const protoSwapped = ['real_code'];
  Object.setPrototypeOf(protoSwapped, { get length() { return 1; }, filter() { throw new Error('proto filter'); } });
  return [
    ['a species array yielding 5n, null, {toString}, 7 and a Symbol', species],
    ['an array with its own iterator', ownIterator],
    ['an array with its own methods', ownMethods],
    ['an array with a throwing element getter', getterElement],
    ['an array proxy whose length throws', lengthTrap],
    ['an array with a swapped prototype', protoSwapped],
  ];
};

test('T-316 r4 (2): A SPECIES OR ITERATOR-HOSTILE REAL ARRAY NEVER THROWS IN THE STARVED REASON', () => {
  for (const [label, value] of hostileArrays()) {
    let r;
    try { r = STARVED_WITH(value); } catch (e) {
      assert.fail(`r4: ${label} THREW in the STARVED reason: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.code, LOOP_STOP.STARVED, `r4: ${label} did not stop as STARVED`);
    assert.ok(r.why.length <= 3000, `r4: the reason for ${label} is UNBOUNDED`);
  }
  /* What is PRINTED comes from the array's own elements, never from what an
   * override hands back: the species array's one real element is shown, and
   * none of the species iterator's yields are. */
  const [[, species]] = hostileArrays();
  const why = STARVED_WITH(species).why;
  assert.match(why, /The dispatcher refused them for: real_code\. /,
    'r4: the reasons were not read from the array\'s own elements');
  assert.ok(!why.includes('objreason'), 'r4: a value yielded by an attacker iterator reached the reason');
  /* An element that cannot be read makes the list unreadable, and says so. */
  const [, , , [, getterElement]] = hostileArrays();
  assert.match(STARVED_WITH(getterElement).why, /could not be read/, 'r4: an unreadable element was not reported');
  /* RULE 11: with the join inside the guard, two UNCAPPED near-max reasons
   * overflow IN the join, are caught, and read as "could not be read" -- no
   * throw, so nothing above would notice the per-element cap going. (One
   * near-max reason overflows later, in nextAction's template, which the r3
   * test catches as a throw.) Both are SHOWN, cut. */
  let pair;
  try { pair = STARVED_WITH([NEAR_MAX, `${NEAR_MAX}y`]).why; } catch (e) {
    assert.fail(`r4: two near-max reasons THREW: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
  }
  assert.ok(/The dispatcher refused them for: x{200}…, x{200}…\. /.test(pair),
    `r4: a near-max reason was not shown capped: ${pair.slice(0, 160)}`);
});

test('T-316 r4 (2): A HUGE SPARSE unplacedReasons IS READ UP TO A BOUND, NOT FOR EVER', () => {
  /*
   * Found while building the index loop: `a.length = 2 ** 32 - 1` made the
   * filter walk four billion holes -- over 20 s at 8a8e136 and at r3,
   * measured. An index loop inherits that unless it is bounded. Run in a
   * child with a timeout, so a regression is a named failure, not a hang.
   */
  const code = `const L = await import(${JSON.stringify(new URL('../src/auditLoop.mjs', import.meta.url).href)});
const a = ['real_code']; a.length = 2 ** 32 - 1;
const r = L.nextAction({ ticksUsed: 1, consecutiveNoProgress: 5, queueDepth: 7, unplacedReasons: a }, { starvedLimit: 5 });
process.stdout.write(JSON.stringify({ code: r.code, why: r.why }));`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST/i.test(k)) delete env[k];
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, env });
  assert.equal(child.signal, null, `r4: a sparse 2**32-1 array ran past 10 s (${child.signal}): the scan is unbounded`);
  assert.equal(child.status, 0, `r4: the child failed: ${child.stderr.slice(0, 200)}`);
  const r = JSON.parse(child.stdout);
  assert.equal(r.code, LOOP_STOP.STARVED);
  assert.match(r.why, /refused them for: real_code/, 'r4: the readable prefix of a huge array was not shown');
  assert.match(r.why, /only the first \d+ of 4294967295 entries were read/, 'r4: a cut-short scan did not say so');
});

/*
 * ═══ T-316 r5 / T-326 F1: DESCRIBING A VALUE MUST NOT WALK IT ═══
 *
 * r4 routed three more sites through describeValue, whose String() fallback
 * joins every hole of a sparse length-2**32-1 array (~66 s, measured by
 * T-326); at 8a8e136 those sites threw in under 50 ms. And JSON.stringify
 * itself walks a sparse 1e8 array for ~4 s at every site, base included
 * (live/T-316/work/r5/timing-*.json). So this pins TIME at every
 * describeValue site, one child per site with a hard timeout, on the huge
 * shapes -- a regression is a named failure, never a hang.
 */
const DESCRIBE_SITES = {
  backoffServed: 'L.nextAction({ queueDepth: 5, consecutiveNoProgress: 1, backoffServed: V }).why',
  deadlineMs: 'L.nextAction({ queueDepth: 5 }, { deadlineMs: V }).why',
  review_attempts: 'D.proposeAudit({ jobs: [job({ review_attempts: V })], sessions: [seat], now: 1e6, isLive: () => true }).unassigned[0].why',
  'last cause at the bound': 'D.proposeAudit({ jobs: [job({ review_attempts: 3, last_review: { not_recorded_because: V } })], sessions: [seat], now: 1e6, isLive: () => true }).unassigned[0].why',
  'isClaimable clock': "(() => { try { D.isClaimable(job({ state: JOB.CLAIMED, claimed_at: 1 }), { now: V }); return 'ACCEPTED'; } catch (e) { return e.message; } })()",
  capText: 'L.capText(V)',
};
const HUGE = {
  'sparse 2**32-1': "(() => { const a = ['real_code']; a.length = 2 ** 32 - 1; return a; })()",
  '[sparse 2**32-1]': "(() => { const a = ['real_code']; a.length = 2 ** 32 - 1; return [a]; })()",
  'sparse 1e8': "(() => { const a = ['real_code']; a.length = 1e8; return a; })()",
  'Uint8Array(2e6)': 'new Uint8Array(2e6)',
  'object of 1e6 keys': '(() => { const o = {}; for (let i = 0; i < 1e6; i += 1) o[`k${i}`] = i; return o; })()',
  /* Every array here is SHORT, so only the visit budget stops JSON walking 1e9 shared values. */
  'shared 1000**3 arrays': '(() => { const a = Array(1000).fill(0); const b = Array(1000).fill(a); return Array(1000).fill(b); })()',
  /* JSON throws on the 1n FIRST, so this reaches the fallback -- where String() would join the sparse array. */
  '[1n, sparse 2**32-1]': "(() => { const a = ['real_code']; a.length = 2 ** 32 - 1; return [1n, a]; })()",
};

/*
 * T-356 r2 (V1-F2): THE GATE IS THE SHAPE OF THE ANSWER, NOT THE CLOCK. The
 * first version asserted `ms < 2000` on every (site, case) cell, and went red
 * in a loaded full suite on a CORRECT tree: the backoffServed site took
 * 3.8 s on 'object of 1e6 keys', because auditLoop's own sites open plain
 * objects by design (keys: true; the daemon's values, not the store's) and
 * JSON collects every key before the visit budget can stop it. That cell is
 * proportional to the object, so no absolute bar on it is load-proof. Every
 * cell now has an EXPECTED TEXT per site mode, measured (r2/f1matrix.mjs):
 * the text differs for every mechanism a mutant can remove (the length
 * pre-check, the visit budget, the store-mode refusal, the typed-array
 * getters), so removing one changes the answer, whatever the load. The
 * 2 s bar stays only on cells whose cost is O(1) or O(1000) by construction,
 * where it is a thousand times the honest cost; the opened-object cell is
 * bounded by RATIO to an Object.keys of the same object in the same child
 * (both scale with load together), and the child's 60 s limit is a hang
 * guard, not a measurement.
 */
const OPENS = new Set(['backoffServed', 'deadlineMs', 'capText']);   // keys: true sites (auditLoop's own values)
const EXPECTED_TEXT = {
  'sparse 2**32-1': () => '<array of length 4294967295>',
  '[sparse 2**32-1]': () => '<array holding an array of length 4294967295>',
  'sparse 1e8': () => '<array of length 100000000>',
  'Uint8Array(2e6)': () => '<Uint8Array of length 2000000>',
  'object of 1e6 keys': (opens) => (opens ? '<object with more than 1000 values>' : '<object: its keys were not read>'),
  'shared 1000**3 arrays': () => '<array with more than 1000 values>',
  '[1n, sparse 2**32-1]': () => '<array of length 2>',
};

test('T-316 r5 F1: NO describeValue SITE WALKS A HUGE CONTAINER -- pinned by the shape of every answer, with a clock only where the cost is O(1)', () => {
  const src = (f) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST/i.test(k)) delete env[k];
  assert.deepEqual(Object.keys(EXPECTED_TEXT), Object.keys(HUGE), 'premise: every huge case has an expected text');
  for (const [site, expr] of Object.entries(DESCRIBE_SITES)) {
    const opens = OPENS.has(site);
    const code = `const L = await import(${src('auditLoop.mjs')}); const D = await import(${src('auditDispatch.mjs')});
const { JOB } = await import(${src('auditJob.mjs')});
const job = (x) => ({ audit_id: 'a', candidate_sha: 'a'.repeat(40), state: JOB.PENDING, claimed_by: null, claimed_at: null, first_seen_at: 'x', ...x });
const seat = { session_id: 'r', agent_id: 'r', capacity: 'idle' };
const out = {};
${Object.entries(HUGE).map(([k, build]) => `{ const V = ${build}; const t = Date.now(); let w; try { w = ${expr}; } catch (e) { w = 'THREW ' + e.message; }
  out[${JSON.stringify(k)}] = { ms: Date.now() - t, why: String(w).slice(0, 400) };
  if (${JSON.stringify(k)} === 'object of 1e6 keys') { let best = Infinity; for (let i = 0; i < 3; i += 1) { const t2 = Date.now(); Object.keys(V); best = Math.min(best, Date.now() - t2); } out[${JSON.stringify(k)}].keysMs = best; } }`).join('\n')}
process.stdout.write(JSON.stringify(out));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000, env, maxBuffer: 1 << 24 });
    assert.equal(child.signal, null, `r5: the ${site} site did not finish all huge cases within 60 s (${child.signal}): it walks the container`);
    assert.equal(child.status, 0, `r5: the ${site} child failed: ${child.stderr.slice(0, 200)}`);
    const got = JSON.parse(child.stdout);
    assert.deepEqual(Object.keys(got), Object.keys(HUGE), `r5: the ${site} child did not answer every case`);
    for (const [kase, { ms, why, keysMs }] of Object.entries(got)) {
      assert.ok(!why.startsWith('THREW'), `r5: the ${site} site threw on ${kase}: ${why}`);
      /* THE SHAPE: named by kind and length, by the budget, or as not read -- never a bare placeholder,
       * never the walked JSON. Anchored to the site's mode, so a store site that opened the object, or an
       * auditLoop site that suddenly refused it, both read as the wrong text. */
      const want = EXPECTED_TEXT[kase](opens);
      assert.ok(why.includes(want), `r5: the ${site} site did not answer ${JSON.stringify(want)} on ${kase}: ${why.slice(0, 160)}`);
      /* THE BAR. An opened object (auditLoop's own sites, V1-F4, recorded) costs one key collection plus 1000
       * visits by design, so its bar is a multiple of Object.keys on the SAME object in the SAME child, never a
       * wall-clock number; every other cell is O(1) or O(1000) and 2 s is a thousand-fold margin. */
      const walkedByDesign = kase === 'object of 1e6 keys' && opens;
      const bar = walkedByDesign ? 4 * keysMs + 250 : 2000;
      assert.ok(Number.isFinite(bar), `r5: no Object.keys baseline for the ${site} site on ${kase}`);
      assert.ok(ms < bar, `r5: the ${site} site took ${ms} ms on ${kase}${walkedByDesign ? `, more than 4x its Object.keys baseline of ${keysMs} ms: something walks the object twice, or more` : ''}`);
    }
  }
});

test('T-356 r2: THE VISIT BUDGET STOPS THE WALK -- proved by a trap the walk would spring, not by the clock', () => {
  /*
   * r5's proof of the budget was the 20 s child timeout on 'shared 1000**3
   * arrays' (1e9 values): a time catch, load-dependent in the safe direction
   * but a catch by exhaustion. This one plants ACCESSORS past the budget:
   * every array here is short (so the length pre-check cannot refuse it, and
   * only the budget can stop the walk), and the elements JSON would reach
   * only after visit 1000 count their own reads. With the budget in place
   * they are never read; with it removed they are read 500 times.
   */
  let reads = 0;
  const inner = (trap) => {
    const a = [0, 0];
    if (trap) Object.defineProperty(a, 1, { get() { reads += 1; return 0; }, enumerable: true });
    return a;
  };
  /* Root visit 1, then 3 visits per element ([x, y] and its two values): the budget of 1000 is spent inside
   * the first 334 elements; traps sit from element 500 on. */
  const v = Array.from({ length: 1000 }, (_, i) => inner(i >= 500));
  const shown = nextAction({ queueDepth: 50, consecutiveNoProgress: 1, backoffServed: v }, { intervalMs: 1000 }).why;
  assert.match(shown, /^backoffServed is <array with more than 1000 values> \(array\), /,
    `T-356 r2: the walk was not stopped by the visit budget: ${shown.slice(0, 120)}`);
  assert.equal(reads, 0, `T-356 r2: the walk read ${reads} trapped values past the visit budget`);
  /* THE POSITIVE (rule 5): the traps DO fire when something walks the array whole, so a zero above is a
   * stopped walk and not a trap that cannot spring. */
  JSON.stringify(v);
  assert.equal(reads, 500, `premise: a full walk should have read the 500 traps, read ${reads}`);
});

test('T-316 r5 F1: SMALL VALUES ARE STILL SHOWN AS THEY ARE -- the bound is not an off switch', () => {
  /* Rule 5: a describer that says "<array of length N>" for everything would
   * pass the timing test above. Ordinary values keep their JSON form. */
  const small = 'r5: a small value was not shown as it is';
  assert.equal(capText([1, 'a', null]), '[1,"a",null] (array)', small);
  assert.equal(capText({ a: 1, b: [2] }), '{"a":1,"b":[2]} (object)', small);
  assert.equal(capText(Array.from({ length: 50 }, () => 0)), `[${Array(50).fill(0).join(',')}] (array)`, small);
  assert.equal(capText(10n), '10n (bigint)', small);
});

test('T-316 r5 F3: A LENGTH THAT IS NOT A NON-NEGATIVE SAFE INTEGER IS UNREADABLE, NEVER "none reported"', () => {
  /* Only a Proxy can do this -- a real array's length is always a number.
   * T-326 F3: '5' read as EMPTY, so 8a8e136's "refused them for: real_code"
   * became "No reason was reported". Checklist U: a read that cannot be
   * trusted is reported as unreadable. */
  for (const [label, len] of [['"5"', '5'], ['5n', 5n], ['NaN', NaN], ['-1', -1], ['1.5', 1.5], ['2**53', 2 ** 53],
    ['Infinity', Infinity], ['{valueOf throws}', { valueOf() { throw new Error('valueOf'); } }], ['null', null]]) {
    const reasons = new Proxy(['real_code'], { get(t, k) { return k === 'length' ? len : Reflect.get(t, k); } });
    let r;
    try { r = STARVED_WITH(reasons); } catch (e) {
      assert.fail(`r5 F3: a length of ${label} THREW: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.match(r.why, /could not be read/, `r5 F3: a length of ${label} was read as "${r.why.slice(90, 170)}", not as unreadable`);
  }
  /* THE POSITIVE (rule 5): a proxy with an honest length still prints its reasons. */
  const honest = new Proxy(['real_code'], {});
  assert.match(STARVED_WITH(honest).why, /The dispatcher refused them for: real_code\. /);
});

test('T-316 r4 (1): capText IS TOTAL -- a non-string never throws, and the result is bounded', () => {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  for (const v of [5n, null, undefined, 7, NaN, Symbol('s'), { toString() { throw new Error('t'); } }, revoked,
    { toJSON() {}, toString() { return NEAR_MAX; } }, [1n], () => 1]) {
    let out;
    try { out = capText(v); } catch (e) {
      assert.fail(`r4: capText THREW on a ${typeof v}: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(typeof out, 'string', `r4: capText returned a ${typeof out} for a ${typeof v}`);
    assert.ok(out.length <= 230, `r4: capText of a ${typeof v} is UNBOUNDED (${out.length})`);
  }
  /* THE POSITIVE (rule 5): a string is still cut exactly as before -- the author form depends on it. */
  assert.equal(capText('sess-1'), 'sess-1');
  assert.equal(capText('a'.repeat(201)), `${'a'.repeat(200)}…`);
});

test('T-316 r2 F2: THE deadlineMs REASON IS TOTAL, BOUNDED, AND THE SAME HELPER', () => {
  /*
   * T-320 F2: `deadlineMs is ${JSON.stringify(o.deadlineMs)}` threw on 17 of
   * 33 hostile values (BigInt, cycles, throwing toJSON, trap/revoked proxies,
   * near-max strings) and was uncapped. Generated from the same shapes as the
   * backoffServed reason, and each answer compared with that reason's, so the
   * two sites cannot describe one value two ways.
   */
  const cyclic = {}; cyclic.self = cyclic;
  const cyclicArr = []; cyclicArr.push(cyclicArr);
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const hostile = [
    ['bigint', 2n], ['bigint', 10n ** 400n], ['object', Object(3n)], ['array', [1n]], ['object', { b: 2n }],
    ['object', cyclic], ['array', cyclicArr], ['object', { toJSON() { throw new Error('toJSON bomb'); } }],
    ['object', new Proxy({}, { get() { throw new Error('get trap'); } })], ['object', revoked],
    ['object', { get x() { throw new Error('getter bomb'); } }],
    ['string', NEAR_MAX], ['object', { toJSON() { return NEAR_MAX; } }], ['array', [NEAR_MAX]],
    ['string', 'z'.repeat(250)], ['symbol', Symbol('d')], ['string', '600000'],
  ];
  const past = { queueDepth: 50, startedAt: 0, now: 10 };
  for (const [type, value] of hostile) {
    let r;
    try { r = nextAction(past, { deadlineMs: value, maxTicks: 99 }); } catch (e) {
      assert.fail(`F2: a ${type} deadlineMs THREW in the reason builder: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.action, LOOP_ACTION.STOP, `F2: a ${type} deadlineMs did not stop the loop`);
    assert.equal(r.code, LOOP_STOP.DEADLINE);
    const m = /^deadlineMs is ([\s\S]*) \((\w+)\), which is not a duration in milliseconds\. /.exec(r.why);
    assert.ok(m, `F2: the deadlineMs reason lost its subject or type: ${String(r.why).slice(0, 120)}`);
    assert.equal(m[2], type, `F2: a ${type} deadlineMs was described as ${m[2]}`);
    assert.ok(m[1].length <= 201, `F2: the described ${type} deadlineMs is UNBOUNDED (${m[1].length} chars)`);
    const other = shownFor(value);
    assert.equal(`${m[1]} (${m[2]})`, `${other.text} (${other.type})`,
      `F2: deadlineMs and backoffServed describe a ${type} differently`);
  }
});

test('T-316 B-28 F-A: THE CAP IS 200 CHARACTERS PLUS AN ELLIPSIS, and short values are shown whole', () => {
  /* Exactly at the cap: a 198-char string is 200 chars once JSON-quoted. */
  const at = 'a'.repeat(198);
  assert.equal(shownFor(at).text, JSON.stringify(at), 'F-A: a value exactly at the cap was cut');
  /* One over: cut to 200 and marked, so a reader knows it was cut. */
  const over = 'a'.repeat(199);
  assert.equal(shownFor(over).text, `${JSON.stringify(over).slice(0, 200)}…`,
    'F-A: a value one over the cap was not cut to 200 plus an ellipsis');
  assert.equal(shownFor({ a: 1 }).text, '{"a":1}');
  assert.equal(shownFor(10n).text, '10n');
  /* A CUT NEVER SPLITS A SURROGATE PAIR: the high half lands at index 199. */
  const pair = shownFor(`${'a'.repeat(198)}\u{1F600}`).text;
  assert.ok(pair.isWellFormed(), 'F-A: the cut left a lone surrogate in the reason');
  assert.equal(pair, `"${'a'.repeat(198)}…`, 'F-A: the cut did not stop before the surrogate pair');
});

test('T-305 B-25 F4 LIMIT: boolean false written after every WAIT waits WITHOUT BOUND in nextAction', () => {
  /*
   * A LIMIT, PINNED, NOT FIXED (T-302 F4; semantics deliberately unchanged).
   * `false` is a legal marker meaning "not served", so a caller that writes
   * it after every WAIT -- instead of `true` after sleeping -- presents the
   * same counters for ever and nextAction answers WAIT for ever. nextAction
   * cannot tell that caller from a first call, so no STOP code exists for it.
   * The ONLY bound is a caller-supplied deadlineMs against an advancing
   * clock. If this test goes red because a bound appeared, re-argue it.
   *
   * The caller contract is in src/auditLoop.mjs above the marker check; the
   * one real caller is pinned to it at the end of this test.
   */
  const drive = (marker, opts) => {
    let now = 0; let waits = 0; let ticks = 0; let last = null;
    for (let i = 0; i < 1000; i += 1) {
      last = nextAction({ ticksUsed: 1, consecutiveNoProgress: 1, queueDepth: 40, backoffServed: marker, startedAt: 0, now },
        { intervalMs: 1000, maxTicks: 50, ...opts });
      if (last.action === LOOP_ACTION.STOP) return { last, waits, ticks, steps: i + 1 };
      if (last.action === LOOP_ACTION.WAIT) { waits += 1; now += last.waitMs; continue; }
      ticks += 1;
    }
    return { last, waits, ticks, steps: 1000 };
  };

  /* THE POSITIVE FIRST (rule 5): the marker true, same counters, ticks. */
  assert.equal(drive(true).ticks, 1000, 'premise: served=true no longer ticks on these counters');

  /* THE LIMIT: no deadline -> 1000 waits, 0 ticks, no STOP. */
  const unbounded = drive(false);
  assert.equal(unbounded.waits, 1000, `F4: false-after-every-WAIT is now bounded (${JSON.stringify(unbounded.last)})`);
  assert.equal(unbounded.ticks, 0);
  assert.equal(unbounded.last.action, LOOP_ACTION.WAIT);

  /* THE ONLY BOUND: a deadline, reached by the waits themselves. */
  const bounded = drive(false, { deadlineMs: 10_000 });
  assert.equal(bounded.last.action, LOOP_ACTION.STOP);
  assert.equal(bounded.last.code, LOOP_STOP.DEADLINE);
  assert.equal(bounded.ticks, 0);
  assert.ok(bounded.waits >= 1 && bounded.waits < 1000, `deadline bound took ${bounded.waits} waits`);

  /* THE ONE REAL CALLER KEEPS THE CONTRACT: after the WAIT sleep it writes
   * the boolean true. Comment-blanked first (rule 13). */
  const daemon = stripComments(readFileSync(new URL('../scripts/audit-daemon.mjs', import.meta.url), 'utf8'));
  assert.match(daemon, /setTimeout\(r, decision\.waitMs\);\s*\}\);\s*backoffServed = true;/,
    'F4: scripts/audit-daemon.mjs no longer writes backoffServed = true after the WAIT sleep');
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
