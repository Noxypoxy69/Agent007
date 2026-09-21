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

import {
  flagValue, posIntArg, nextAttempt, ARG_ERROR,
} from '../src/daemonArgs.mjs';

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

test('THE NEXT FLAG IS NOT A VALUE -- it fails the digit test, loudly', () => {
  /* `--max-ticks --launch` was already caught before M-6, because the next
   * token is not digits. Pinned so the M-3 rework cannot lose it. */
  const r = posIntArg(['--max-ticks', '--launch'], '--max-ticks', 5);
  assert.equal(r.ok, false);
  assert.match(r.why, /--launch/);
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
   * direction that gets a bound switched off. */
  assert.equal(nextAttempt(null, BOUND), 1);
  assert.equal(nextAttempt(undefined, BOUND), 1);

  /* THE POSITIVE (rule 5): a readable counter increments, from both the
   * number and the string shapes a JSON round trip really produces. */
  assert.equal(nextAttempt(0, BOUND), 1);
  assert.equal(nextAttempt(2, BOUND), 3);
  assert.equal(nextAttempt('2', BOUND), 3);
});
