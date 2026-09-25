/**
 * THE DAEMON'S ARGUMENT PARSING, WATCHED FOR THE FIRST TIME.
 *
 * `scripts/audit-daemon.mjs` has no test file and cannot have one --
 * importing it consumes a job. So four findings across two blind audits
 * lived in its argument handling and every one was found by READING:
 *
 *   M-6  a trailing `--max-ticks` silently became the default spend.
 *   M-3  the fix for M-6 went inside the numeric parser, leaving `--by`
 *        with the old behaviour -- and `--by` is the identity the daemon
 *        claims work AS, so a trailing one defeats the
 *        author-cannot-audit check entirely.
 *   L3   a malformed attempt counter reset the bound permanently.
 *
 * Each is pinned below in the direction it was wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  flagValue, posIntArg, nextAttempt, ARG_ERROR,
} from '../src/daemonArgs.mjs';
/* Namespace import for the presence helpers, so a tree that lacks them
 * goes red on an ASSERTION rather than on a failed import (hollow 9). */
import * as ARGS from '../src/daemonArgs.mjs';
import { stripComments } from '../src/moduleGraph.mjs';

test('THE POSITIVE FIRST: an ordinary flag yields its value (rule 5)', () => {
  assert.deepEqual(flagValue(['--by', 'sess-1'], '--by'), { ok: true, value: 'sess-1' });
  assert.deepEqual(flagValue(['--max-ticks', '3'], '--max-ticks'), { ok: true, value: '3' });

  /* Absent means the default, which is not an error. */
  assert.deepEqual(flagValue(['--launch'], '--by', 'fallback'), { ok: true, value: 'fallback' });
});

test('A TRAILING FLAG IS AN ERROR FOR EVERY FLAG, NOT JUST THE NUMERIC ONES (M-3)', () => {
  /*
   * The guard first lived inside the numeric parser, so it covered
   * --interval, --max-ticks and --deadline and left --by alone.
   *
   * --by is who the daemon claims work AS. claimJob refuses a claim on
   * `author === who`; an operator passing their own session id precisely
   * so that exclusion fires gets the synthetic daemon id instead, which
   * equals no commit trailer, so the check CANNOT FIRE AT ALL. Fail-open
   * on rule 20's core property, reachable by a plausible typing order.
   *
   * Generated over every flag the daemon takes a value for, so adding one
   * extends the coverage without anybody remembering (rule 7).
   */
  for (const name of ['--by', '--max-ticks', '--interval', '--deadline']) {
    const r = flagValue([name], name, 'THE-DEFAULT');
    assert.equal(r.ok, false, `a trailing ${name} silently returned its default`);
    assert.equal(r.code, ARG_ERROR);
    assert.match(r.why, /no value/);

    /* And through the numeric path too, which is where the guard used to be. */
    const n = posIntArg(['--supervise', name], name, 5);
    assert.equal(n.ok, false, `a trailing ${name} silently returned 5`);
  }
});

test('A MALFORMED NUMBER IS FATAL, not the default', () => {
  for (const bad of ['abc', '', '  ', '-1', '1.5', '1e3', '0x10']) {
    const r = posIntArg(['--max-ticks', bad], '--max-ticks', 5);
    assert.equal(r.ok, false, `--max-ticks ${JSON.stringify(bad)} was accepted`);
    assert.match(r.why, /whole number/);
  }

  /* THE POSITIVE (rule 5): real numbers pass, including zero, which is a
   * meaningful dry-run request and must not be mistaken for absent. */
  assert.deepEqual(posIntArg(['--max-ticks', '0'], '--max-ticks', 5), { ok: true, value: 0 });
  assert.deepEqual(posIntArg(['--max-ticks', '12'], '--max-ticks', 5), { ok: true, value: 12 });
  assert.deepEqual(posIntArg([], '--max-ticks', 5), { ok: true, value: 5 });
});

test('THE NEXT FLAG IS NOT A VALUE -- FOR EVERY FLAG, not just the numeric ones (M-A)', () => {
  /*
   * `--max-ticks --launch` was caught all along, but only because
   * `/^\d+$/` rejects `--launch`. That made the numeric flags LOOK
   * covered while `--by` -- which takes a free-form string -- had no
   * equivalent check at all:
   *
   *     node scripts/audit-daemon.mjs --supervise --launch --by --once
   *
   * gave BY = '--once', which matches no commit trailer, so the
   * author-cannot-audit exclusion could not fire, while `has('--once')`
   * and `has('--launch')` still read argv independently so the run
   * proceeded in launch mode. Fail-open on rule 20's core property from a
   * typing order.
   *
   * Generated over every flag the daemon takes a value for (rule 7).
   */
  for (const name of ['--by', '--max-ticks', '--interval', '--deadline']) {
    for (const next of ['--launch', '--once', '--supervise', '-v']) {
      const r = flagValue([name, next], name, 'THE-DEFAULT');
      assert.equal(r.ok, false, `${name} ${next} was accepted as a value`);
      assert.match(r.why, /another flag/);
    }
  }

  /* Still caught through the numeric path, which is where it was already
   * covered -- the rework must not lose that. */
  const n = posIntArg(['--max-ticks', '--launch'], '--max-ticks', 5);
  assert.equal(n.ok, false);
  assert.match(n.why, /--launch/);

  /*
   * THE POSITIVE (rule 5), and it is the one that stops this becoming an
   * over-block: a value that merely STARTS with a dash is not a flag. A
   * negative number and a lone dash must still pass through, or an
   * operator with a legitimate value is refused.
   */
  assert.deepEqual(flagValue(['--by', '-'], '--by'), { ok: true, value: '-' });
  assert.deepEqual(flagValue(['--by', '-5'], '--by'), { ok: true, value: '-5' });
  assert.deepEqual(flagValue(['--by', 'sess-1'], '--by'), { ok: true, value: 'sess-1' });
});

test('AN UNREADABLE ATTEMPT COUNTER IS AT THE BOUND, NOT ZERO (L3)', () => {
  /*
   * `Number(x ?? 0) + 1` produced NaN, JSON.stringify writes NaN as null,
   * and the next read turned that back into 0 -- so ONE corrupt value
   * reset the bound permanently and REVIEW_EXHAUSTED could never fire.
   */
  const BOUND = 3;
  for (const bad of ['', '  ', 'three', {}, [], true, NaN, -1, Infinity]) {
    assert.equal(nextAttempt(bad, BOUND), BOUND,
      `${JSON.stringify(bad)} did not count as exhausted`);
  }

  /* ABSENT IS ZERO, and that is not the same thing: every row written
   * before this field existed looks like this, and treating them as
   * exhausted would stall the whole historical queue -- the over-block
   * direction that gets a bound switched off.
   *
   * T-291 / B-12: ABSENT means NO KEY, which reads back as `undefined`.
   * This line used to pin `nextAttempt(null) === 1` as absent too, and a
   * JSON null is exactly what the NaN corruption above leaves behind, so it
   * pinned the reset. null is now asserted at the bound in the table below. */
  assert.equal(nextAttempt(undefined, BOUND), 1);

  /* THE POSITIVE (rule 5): a readable counter increments, from both the
   * number and the string shapes a JSON round trip really produces. */
  assert.equal(nextAttempt(0, BOUND), 1);
  assert.equal(nextAttempt(2, BOUND), 3);
  assert.equal(nextAttempt('2', BOUND), 3);
});

test('T-291 B-12: A NULL COUNTER IS THE NaN CORRUPTION, SO IT IS AT THE BOUND; ABSENT IS FRESH', () => {
  /*
   * The premise, asserted rather than remembered: JSON writes NaN as null,
   * so a counter that went NaN comes back as null on the next read. If this
   * ever stops holding, the null row below loses its reason and must be
   * re-argued, not silently kept.
   */
  const roundTrip = JSON.parse(JSON.stringify({ review_attempts: NaN }));
  assert.equal(roundTrip.review_attempts, null, 'premise: NaN no longer round-trips to null');
  /* And a row that never had the field reads back as undefined, not null. */
  assert.equal(JSON.parse('{}').review_attempts, undefined, 'premise: an absent key is not undefined');

  const BOUND = 3;
  const table = [
    // [stored, expected, what it is]
    [undefined, 1, 'absent: a fresh row'],
    [null, BOUND, 'null: what JSON.stringify(NaN) left behind'],
    [roundTrip.review_attempts, BOUND, 'the round-tripped NaN itself'],
    [0, 1, 'a readable zero'],
    [1, 2, 'a readable one'],
    ['1', 2, 'a readable string one'],
    ['', BOUND, 'blank'],
    ['null', BOUND, 'the string null'],
    [NaN, BOUND, 'NaN before it was written'],
  ];
  for (const [stored, want, what] of table) {
    assert.equal(nextAttempt(stored, BOUND), want,
      `B-12: nextAttempt(${String(stored)}) [${what}] gave ${nextAttempt(stored, BOUND)}, want ${want}`);
  }
});

/*
 * ═══ T-285: THE EQUALS SPELLING, AND THE CLASS RATHER THAN THE STRING ═══
 *
 * T-276 measured it: `--by=sess-1` silently became `audit-daemon@<host>`,
 * `--max-ticks=0` silently became 5, and the M-D "a loop flag without
 * --supervise is refused" check read `argv.includes` and so never saw
 * `--max-ticks=0` at all. The same class was closed three times already
 * for other spellings (M-6 trailing, M-3 `--by` left behind, M-A the next
 * flag as the value). Rule 8: the fix is the matcher, so the table below
 * is GENERATED -- from the flags the script really reads, crossed with
 * every spelling -- rather than listing the strings somebody tried.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/audit-daemon.mjs', import.meta.url));

/** The flags the daemon reads, taken from its code with comments blanked (rule 13). */
function daemonFlags() {
  const code = stripComments(readFileSync(SCRIPT, 'utf8'));
  const grab = (re) => [...new Set([...code.matchAll(re)].map((m) => m[1]))].sort();
  return {
    numeric: grab(/\bposInt\(\s*'(--[a-z][a-z-]*)'/g),
    string: grab(/\bflag\(\s*'(--[a-z][a-z-]*)'/g),
    boolean: grab(/\b(?:has|bool)\(\s*'(--[a-z][a-z-]*)'/g),
  };
}

test('T-285 THE FLAG LIST IS READ FROM THE SCRIPT, not typed here (positive control first)', () => {
  const f = daemonFlags();
  /* Rule 5: the generated tables below are empty -- and pass -- if this
   * extraction finds nothing, so it must find at least the known flags. */
  for (const n of ['--interval', '--max-ticks', '--deadline']) assert.ok(f.numeric.includes(n), `numeric flag ${n} not found in the script: ${JSON.stringify(f)}`);
  assert.ok(f.string.includes('--by'), `--by not found in the script: ${JSON.stringify(f)}`);
  for (const n of ['--once', '--launch', '--supervise']) assert.ok(f.boolean.includes(n), `boolean flag ${n} not found in the script: ${JSON.stringify(f)}`);
});

test('T-285 GENERATED: every value flag x {space, equals, empty, whitespace, a flag as the value, repeated}', () => {
  const f = daemonFlags();
  const valueFlags = [...f.numeric, ...f.string];
  const all = [...valueFlags, ...f.boolean];
  assert.ok(valueFlags.length >= 4, 'the table would be empty');
  let rows = 0;

  for (const name of valueFlags) {
    const numeric = f.numeric.includes(name);
    /* Both parsers a flag can go through; the numeric one only for numeric flags. */
    const parse = (argv) => (numeric ? posIntArg(argv, name, 5) : flagValue(argv, name, 'THE-DEFAULT'));
    const goods = numeric ? ['7', '0'] : ['sess-1', '-5'];

    for (const good of goods) {
      /* THE POSITIVE FIRST: the space form is the reference. */
      const space = parse([name, good]);
      assert.equal(space.ok, true, `space form ${name} ${good} was refused: ${space.why}`);
      assert.equal(space.value, numeric ? Number(good) : good);

      /* THE EQUALS FORM MUST GET THE SAME ANSWER -- not the default. */
      const argvEq = [`${name}=${good}`];
      assert.deepEqual(parse(argvEq), space, `EQUALS FORM DIVERGED: ${JSON.stringify(argvEq)}`);
      assert.deepEqual(flagValue(argvEq, name, 'THE-DEFAULT'), flagValue([name, good], name, 'THE-DEFAULT'),
        `EQUALS FORM DIVERGED in flagValue: ${JSON.stringify(argvEq)}`);
      /* And among other flags, which is how an operator types it. */
      const mixed = ['--supervise', `${name}=${good}`, '--once'];
      assert.deepEqual(parse(mixed), space, `EQUALS FORM DIVERGED: ${JSON.stringify(mixed)}`);
      rows += 3;
    }

    const refused = (argv, re, label) => {
      for (const r of [flagValue(argv, name, 'THE-DEFAULT'), parse(argv)]) {
        assert.equal(r.ok, false, `${label}: ${JSON.stringify(argv)} was accepted as ${JSON.stringify(r.value)}`);
        assert.equal(r.code, ARG_ERROR, `${label}: ${JSON.stringify(argv)} refused without ARG_ERROR`);
        if (re) assert.match(r.why, re, `${label}: ${JSON.stringify(argv)} refused for another reason`);
      }
      rows += 1;
    };

    /* EMPTY and WHITESPACE: refused in both spellings. The numeric parser
     * words it "whole number"; the free-form one must refuse it too, which
     * is T-276 F2 (an empty --by was accepted). */
    for (const blank of ['', '  ', '\t']) {
      refused([name, blank], null, 'BLANK VALUE ACCEPTED (space)');
      refused([`${name}=${blank}`], null, 'BLANK VALUE ACCEPTED (equals)');
    }

    /* A FLAG AS THE VALUE: every flag the script reads, in both of ITS
     * spellings, as the value of this one in both of ours. */
    for (const other of all) {
      for (const v of [other, `${other}=1`]) {
        /* `--by --by` is a repetition, refused as one below. */
        if (other !== name) refused([name, v], /another flag/, 'FLAG AS VALUE ACCEPTED (space)');
        refused([`${name}=${v}`], /another flag/, 'FLAG AS VALUE ACCEPTED (equals)');
      }
    }

    /* REPEATED, in every combination of spellings, same value and different:
     * taking either occurrence is a guess about which one the operator meant. */
    const g = goods[0];
    for (const argv of [
      [name, g, name, g], [name, g, name, '9'],
      [`${name}=${g}`, `${name}=${g}`], [`${name}=${g}`, `${name}=9`],
      [name, g, `${name}=9`], [`${name}=${g}`, name, '9'],
    ]) refused(argv, /given 2 times/, 'REPEATED FLAG ACCEPTED');

    /* A LONGER FLAG SHARING THE PREFIX IS NOT THIS FLAG. */
    const lookalike = parse([`${name}x=1`, `${name}-x=1`]);
    assert.deepEqual(lookalike, { ok: true, value: numeric ? 5 : 'THE-DEFAULT' },
      `a lookalike of ${name} was read as it`);
  }
  assert.ok(rows > 100, `only ${rows} rows ran`);
});

test('T-285 GENERATED: presence sees the equals form, and a boolean flag refuses a value', () => {
  const f = daemonFlags();
  assert.equal(typeof ARGS.flagPresent, 'function', 'daemonArgs exports no flagPresent: presence is still argv.includes');
  assert.equal(typeof ARGS.boolFlag, 'function', 'daemonArgs exports no boolFlag');
  const { flagPresent, boolFlag } = ARGS;

  for (const name of [...f.numeric, ...f.string, ...f.boolean]) {
    /* THE POSITIVE FIRST. */
    assert.equal(flagPresent([name], name), true, `${name} bare not seen`);
    assert.equal(flagPresent(['--x', `${name}=0`], name), true, `PRESENCE MISSED THE EQUALS FORM: ${name}=0`);
    assert.equal(flagPresent([`${name}=`], name), true, `PRESENCE MISSED THE EQUALS FORM: ${name}=`);
    /* The negative, after the positive (rule 5). */
    assert.equal(flagPresent([], name), false);
    assert.equal(flagPresent([`${name}x=0`, `${name}-x`], name), false, `a lookalike counted as ${name}`);
  }

  for (const name of f.boolean) {
    assert.deepEqual(boolFlag([name], name), { ok: true, value: true });
    assert.deepEqual(boolFlag(['--by', 'x'], name), { ok: true, value: false });
    /* `--launch=no` must not launch and `--launch=yes` must not silently
     * not launch. Neither can be honoured without guessing, so both refuse. */
    for (const v of ['', 'yes', 'no', 'true', 'false', '0', '1']) {
      const r = boolFlag(['--supervise', `${name}=${v}`], name);
      assert.equal(r.ok, false, `BOOLEAN WITH A VALUE ACCEPTED: ${name}=${v} read as ${r.value}`);
      assert.equal(r.code, ARG_ERROR);
      assert.match(r.why, /takes no value/);
    }
  }
});

test('T-285 WIRING: the script refuses the equals form itself, and names why', () => {
  /*
   * The module being right is a separate claim from the script calling it
   * (rule 17). The script cannot be imported -- it consumes a job -- but it
   * CAN be run with arguments that are refused before any tick.
   *
   * EVERY CASE CARRIES A BACKSTOP: a trailing `--by --once`, which is refused
   * at the `--by` parse, before `tick()`. So on a tree where the equals
   * handling regressed, the run still stops before touching the queue --
   * and the case goes red because the WRONG refusal fired (rule 18: name
   * which thing refused).
   */
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NODE_TEST/i.test(k)));
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const BACKSTOP = ['--by', '--once'];

  /* THE POSITIVE FIRST: the backstop itself refuses, with its own words. */
  const base = run(BACKSTOP);
  assert.equal(base.status, 2, `backstop exit ${base.status}: ${base.stderr}`);
  assert.match(base.stderr, /another flag/);

  for (const [args, want] of [
    [['--max-ticks=0'], /--max-ticks only applies to --supervise/],
    [['--interval=5'], /--interval only applies to --supervise/],
    [['--deadline=0'], /--deadline only applies to --supervise/],
    [['--supervise', '--max-ticks=abc'], /--max-ticks must be a whole number/],
    [['--supervise', '--interval=0'], /--interval 0 would remove the backoff/],
    [['--launch=yes'], /--launch takes no value/],
    [['--supervise=no'], /--supervise takes no value/],
    [['--by=sess-1'], /--by was given 2 times/],
  ]) {
    const r = run([...args, ...BACKSTOP]);
    assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status}`);
    assert.doesNotMatch(r.stderr, /another flag/, `SCRIPT IGNORED ${args.join(' ')}: only the backstop refused`);
    assert.match(r.stderr, want, `${args.join(' ')} refused for another reason: ${r.stderr}`);
  }
});
