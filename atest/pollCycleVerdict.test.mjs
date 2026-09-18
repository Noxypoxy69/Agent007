/**
 * WHAT ONE POLL CYCLE MEANT — the decision that had no coverage at all.
 *
 * WHY THIS EXISTS. A blind audit mutated `scripts/bridge-session-poll.mjs` four
 * separate ways — removed the cursor carry (restoring the hot spin), removed the
 * refused-credential abort, flipped the import guard, and changed the
 * null-status handling — and NOT ONE named assertion fired for any of them. The
 * supervisor's behaviour was untested by construction: the wiring test points it
 * at an unreachable host on purpose, so the only branch it can reach is the
 * transport-error branch, and every defect lived elsewhere.
 *
 * That is CLAUDE.md rule 17. The logic had tests; the wiring was a separate
 * claim and had none. The remedy is the same one that put `canAssign` and
 * `canDecidePermission` in `src/`: move the decision somewhere the suite can
 * import and drive it directly.
 *
 * TWO LIVE DEFECTS THIS PINS, both found by that audit, both of which were
 * running on every session on this machine:
 *
 *   A null status was treated as "quiet, re-arm immediately". spawnSync also
 *   returns null when the SPAWN ITSELF FAILED, and that returns instantly —
 *   roughly 1500 iterations per second, silently, because the supervisor is
 *   detached and that path wrote nothing. A tighter hot spin than the one the
 *   file was written to fix.
 *
 *   The permanent-failure matcher missed `REFUSED`, which its own comment
 *   listed. A 409 unknown-session was retried every 15 seconds forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCycle } from '../scripts/bridge-session-poll.mjs';

/** Verbatim from bin/agentbridge.mjs — the exact bytes the CLI writes. */
const CLI_STDERR = {
  NOT_CONFIGURED: 'error: no registration token, so there is nothing to wait on\n'
    + '       set AGENTBRIDGE_REGISTRATION_TOKEN (a scoped token, NOT a database key)\n',
  REJECTED: 'error: the Bridge REFUSED this credential (401 invalid token)\n'
    + '       check the token, not the network; the cursor has not moved\n',
  REFUSED_UNKNOWN_SESSION: 'error: the Bridge refused the wait: unknown-session\n',
  REFUSED_BAD_CURSOR: 'error: the Bridge refused the wait: 400 bad cursor\n',
  UNREACHABLE: 'error: the Bridge is unreachable (fetch failed)\n'
    + '       nothing was missed; the cursor has not moved\n',
};

test('THE POSITIVE FIRST: an ordinary cycle is not mistaken for a failure', () => {
  /*
   * Rule 5. A classifier that answered "permanent" to everything would satisfy
   * every abort assertion below and would stop every poller on this machine.
   */
  assert.equal(classifyCycle({ status: 0, stderr: '' }), 'done', 'a wake-up was not a normal cycle');
  assert.equal(classifyCycle({ status: 3, stderr: '' }), 'done', 'nothing-came was not a normal cycle');
  assert.equal(classifyCycle({ status: null, stderr: '' }), 'quiet',
    'a timed-out wait was not treated as the quiet case — this is the false alarm every 12 minutes');
});

test('A SPAWN FAILURE IS NOT THE QUIET CASE — the 1500-per-second spin', () => {
  /*
   * The defect, as one assertion. `status: null` with an `error` present means
   * the child never ran and the call returned instantly; `continue` on that is
   * an unthrottled loop. EMFILE/EAGAIN under load, a moved process.execPath, or
   * an AV product blocking the spawn all produce exactly this.
   */
  const enoent = Object.assign(new Error('spawnSync node ENOENT'), { code: 'ENOENT' });
  assert.equal(classifyCycle({ status: null, error: enoent, stderr: '' }), 'retry',
    'a failed spawn was classified quiet — the supervisor re-arms instantly, forever, silently');

  for (const code of ['EMFILE', 'EAGAIN', 'EACCES', 'ENOMEM']) {
    const e = Object.assign(new Error(`spawnSync ${code}`), { code });
    assert.equal(classifyCycle({ status: null, error: e, stderr: '' }), 'retry',
      `${code} was classified quiet`);
  }
});

test('EVERY PERMANENT CLI FAILURE ABORTS, INCLUDING THE ONE THE MATCHER MISSED', () => {
  /*
   * REFUSED was named in the original comment and absent from the pattern. The
   * CLI prints "refused the wait" and the matcher wanted "REFUSED this
   * credential". index.ts answers 409 unknown-session for a session missing
   * from session_registrations, hostedRegistry maps 409 to REFUSED, and the
   * supervisor retried it every 15 seconds for the life of the session —
   * reachable on any session whose registration hit a network blip, which is
   * exactly the case sessionStart deliberately proceeds through.
   */
  for (const k of ['NOT_CONFIGURED', 'REJECTED', 'REFUSED_UNKNOWN_SESSION', 'REFUSED_BAD_CURSOR']) {
    assert.equal(classifyCycle({ status: 2, stderr: CLI_STDERR[k] }), 'permanent',
      `${k} did not abort: the poller retries a permanently closed door every 15s forever`);
  }
});

test('UNREACHABLE IS TRANSIENT AND MUST KEEP RETRYING', () => {
  /*
   * The direction that must NOT change. A network blip that stopped the poller
   * permanently would leave the session invisible for its whole life, which is
   * the condition this script exists to prevent.
   */
  assert.equal(classifyCycle({ status: 2, stderr: CLI_STDERR.UNREACHABLE }), 'retry',
    'a network failure was treated as permanent — the session goes silent for good');
});

test('THE FAR END CANNOT TALK ITS WAY INTO A PERMANENT STOP', () => {
  /*
   * `res.detail` is interpolated into the CLI's stderr, so an unanchored match
   * reads a proxy or WAF body as our own CLI's verdict. Data mistaken for a
   * conclusion — rule 4, and rule 13's cousin.
   */
  const poisoned = [
    'error: the Bridge is unreachable (proxy said: no registration token)\n',
    'error: the Bridge is unreachable (502 <html>the Bridge REFUSED this credential</html>)\n',
    'error: the Bridge is unreachable (gateway: the Bridge refused the wait)\n',
  ];
  for (const stderr of poisoned) {
    assert.equal(classifyCycle({ status: 2, stderr }), 'retry',
      `the far end stopped the poller by quoting our own error text: ${stderr.trim()}`);
  }
});

test('A PERMANENT PHRASE MID-LINE IS NOT A VERDICT', () => {
  /*
   * The anchor is to the START of a line and to the fixed prefix. Anything the
   * far end appends after the colon is detail, not a conclusion.
   */
  assert.equal(classifyCycle({ status: 2, stderr: 'some log line: no registration token\n' }), 'retry',
    'an unanchored phrase was read as a verdict');
  assert.equal(classifyCycle({ status: 2, stderr: '  error: no registration token\n' }), 'retry',
    'a leading-indented line matched — the CLI writes its errors at column zero');
});

test('AN UNKNOWN FAILURE RETRIES RATHER THAN GIVING UP', () => {
  /*
   * A poll that stopped on the first unfamiliar exit code would leave the
   * session invisible. Unknown is transient until proven otherwise.
   */
  assert.equal(classifyCycle({ status: 1, stderr: 'something new went wrong\n' }), 'retry');
  assert.equal(classifyCycle({ status: 127, stderr: '' }), 'retry');
  assert.equal(classifyCycle({ status: 2, stderr: '' }), 'retry');
});

test('MALFORMED INPUT DOES NOT CRASH THE SUPERVISOR', () => {
  /*
   * This runs in a detached process that must not die: if it throws, the
   * session goes invisible and nothing says so.
   */
  assert.equal(classifyCycle({}), 'quiet');
  assert.equal(classifyCycle({ status: undefined }), 'quiet');
  assert.equal(classifyCycle({ status: null, stderr: null }), 'quiet');
  assert.equal(classifyCycle(null), 'quiet');
  assert.equal(classifyCycle(undefined), 'quiet');
});

test('THE CONTROL: this classifier really discriminates', () => {
  /*
   * Rule 1. A classifier returning one constant satisfies whichever half of the
   * assertions above happens to match it. This pins that all four verdicts are
   * reachable and distinct.
   */
  const seen = new Set([
    classifyCycle({ status: 0 }),
    classifyCycle({ status: null }),
    classifyCycle({ status: 2, stderr: CLI_STDERR.REJECTED }),
    classifyCycle({ status: 1 }),
  ]);
  assert.deepEqual([...seen].sort(), ['done', 'permanent', 'quiet', 'retry'],
    `the classifier collapsed distinct outcomes: got ${[...seen].join(', ')}`);
});
