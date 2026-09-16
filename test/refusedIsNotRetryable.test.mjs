import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HOSTED, classifyStatus, interpretHttp } from '../src/hostedRegistry.mjs';

/**
 * A REFUSED CREDENTIAL IS NOT A TRANSIENT FAILURE, AND BACKOFF SAID IT WAS.
 *
 * THE DEFECT. `src/daemon.mjs` treated every publish failure the same way:
 *
 *     backoff = Math.min(backoff ? backoff * 2 : 5_000, 120_000);
 *     log(`publish failed (...); backoff ${backoff / 1000}s`);
 *
 * The heartbeat authenticates with an HMAC signature, so a 401 there means the
 * machine secret or the registration is wrong. An operator has to fix it; no
 * amount of waiting will. The daemon retried it every two minutes forever,
 * logging an identical line each time, while backing off -- which is a promise
 * that waiting is the remedy.
 *
 * THIS WAS THE FIFTH HOSTED PATH. `interpretHttp` was written after the same
 * bug was fixed three times by status -- 401, then 409, then 400 -- each a new
 * branch on a ladder whose FALLBACK still said UNREACHABLE, so 404 walked past
 * all three. It converted the call sites in hostedRegistry.mjs. `publish()` in
 * client.mjs is another outbound call to the same bridge and was never
 * converted: it returns a bare `ok` and a status, and left the caller to
 * interpret. The caller did not.
 *
 * WHY THE RULE IS EXTRACTED RATHER THAN REUSED WHOLE, and this is the part
 * worth keeping. The first attempt routed publish()'s `reason` through
 * interpretHttp, which builds its detail FROM THE RESPONSE BODY. An existing
 * security test caught it immediately: publish() reads exactly two scalars from
 * a bridge response and asserts its own return has exactly four keys, because a
 * compromised bridge must not be able to widen what a client reads from it.
 * Its comment says so -- "a refactor that widened response handling would be
 * invisible" -- and it was written for precisely that mistake.
 *
 * So the RULE lives in `classifyStatus`, which sees only a number, and
 * interpretHttp is a specialisation of it for callers that also want the
 * detail. The agreement test below is what stops them drifting apart again,
 * because two copies of this rule is how it came back three times.
 */

/* ── the rule, both directions ────────────────────────────────────────── */

test('a refused credential is REJECTED, not something to retry', () => {
  assert.equal(classifyStatus(401), HOSTED.REJECTED);
  assert.equal(classifyStatus(403), HOSTED.REJECTED);
});

test('a decision that is not about the credential is REFUSED', () => {
  /*
   * 404 is the one that walked past three per-status fixes. It means the far
   * end understood and formed an opinion -- b6's tell: an UNREACHABLE detail is
   * "timeout" or "http 500", so a detail that is an IDENTIFIER means a decision.
   */
  for (const s of [400, 404, 409, 422, 429]) {
    assert.equal(classifyStatus(s), HOSTED.REFUSED, `${s} should be REFUSED`);
  }
});

test('THE POSITIVE CONTROL: a server that cannot serve is still UNREACHABLE', () => {
  /*
   * Load-bearing. A fix that turned every failure into "do not retry" would
   * pass every assertion above and would strand a daemon through an outage it
   * should simply have waited out. Retrying is the RIGHT reflex for 5xx.
   */
  for (const s of [500, 502, 503, 504]) {
    assert.equal(classifyStatus(s), HOSTED.UNREACHABLE, `${s} should be UNREACHABLE`);
  }
});

/* ── the two consumers cannot drift ───────────────────────────────────── */

test('interpretHttp AGREES with classifyStatus on every status', async () => {
  /*
   * The whole reason the rule was extracted. interpretHttp adds a body-derived
   * detail; it must not add a different OPINION. Two copies of this rule is how
   * the bug returned three times, and a second copy that agrees today is still
   * a second copy.
   */
  const disagreements = [];
  for (const status of [400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503]) {
    const res = new Response('{}', { status });
    const answered = await interpretHttp(res);
    const expected = classifyStatus(status);
    if (answered?.state !== expected) {
      disagreements.push(`${status}: interpretHttp=${answered?.state} classifyStatus=${expected}`);
    }
  }
  assert.deepEqual(disagreements, [], `the two copies of the rule disagree:\n  ${disagreements.join('\n  ')}`);
});

test('a 2xx is not a failure state at all', async () => {
  // interpretHttp returns null before touching the body when the response is
  // ok. Callers rely on that ordering to read the body themselves afterwards.
  assert.equal(await interpretHttp(new Response('{}', { status: 200 })), null);
});

/* ── the daemon actually uses it ──────────────────────────────────────── */

/** Blank comments so nothing below can be satisfied by the prose explaining it. */
function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const daemon = codeOnly(
  await readFile(fileURLToPath(new URL('../src/daemon.mjs', import.meta.url)), 'utf8'),
);

test('POSITIVE CONTROL: the daemon source is readable and is the daemon', () => {
  // Every assertion below is a negative, and a negative passes against an empty
  // file. A non-match is not evidence the search ran.
  assert.ok(daemon.length > 500, `daemon.mjs is ${daemon.length} bytes; that is not the real file`);
  assert.match(daemon, /publish\(/, 'this file does not call publish at all');
});

test('the daemon branches on the shared rule, not on a status of its own', () => {
  assert.match(
    daemon,
    /classifyStatus\s*\(/,
    'daemon.mjs does not use classifyStatus. Hardcoding `status === 401` here would be a '
      + 'sixth private copy of the rule, which is how this bug came back three times.',
  );
});

test('THE REGRESSION: a refused credential must not escalate backoff', () => {
  /*
   * The defect, stated as source. Backoff means "waiting will help". For a
   * credential the bridge refused it will not, and the daemon said so every two
   * minutes for as long as it ran.
   *
   * Scoped to the REJECTED branch rather than the whole file, because the other
   * branch must keep escalating -- that is the 5xx path and it is correct.
   */
  const at = daemon.search(/classifyStatus\s*\([^)]*\)\s*===\s*HOSTED\.REJECTED/);
  assert.notEqual(at, -1, 'there is no branch for a refused credential');

  const nextBranch = daemon.indexOf('} else', at);
  const branch = daemon.slice(at, nextBranch === -1 ? daemon.length : nextBranch);

  assert.doesNotMatch(
    branch,
    /backoff\s*\*\s*2|backoff\s*\?\s*backoff/,
    'the refused-credential branch still escalates backoff, which tells the operator that '
      + 'waiting is the remedy for a credential only they can fix.',
  );
  assert.match(
    branch,
    /backoff\s*=\s*0/,
    'the refused-credential branch does not reset backoff, so a refusal inherits whatever '
      + 'delay a previous outage had built up.',
  );
});

test('and it says so ONCE, not every interval', () => {
  const at = daemon.search(/classifyStatus\s*\([^)]*\)\s*===\s*HOSTED\.REJECTED/);
  const nextBranch = daemon.indexOf('} else', at);
  const branch = daemon.slice(at, nextBranch === -1 ? daemon.length : nextBranch);
  assert.match(
    branch,
    /if\s*\(\s*!\w+\s*\)/,
    'the refusal is logged unconditionally, so the log fills with identical lines -- which '
      + 'is what made the original defect invisible rather than obvious.',
  );
});

test('and the latch clears on success, so recovery is automatic', () => {
  /*
   * Without this the daemon announces a refusal once, the operator fixes the
   * secret, publishing resumes -- and a LATER refusal is silent forever because
   * the latch was never reset. A one-shot warning that cannot re-arm is a
   * warning you get once per process lifetime.
   */
  const okBranch = daemon.slice(
    daemon.indexOf('r.ok && r.accepted'),
    daemon.search(/classifyStatus\s*\(/),
  );
  assert.match(
    okBranch,
    /=\s*false/,
    'the success path does not clear the announced-refusal latch, so a second refusal after '
      + 'a recovery would never be reported.',
  );
});
