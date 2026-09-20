/**
 * THE OWNER BOOTSTRAP WAIVER: IT STOPS A BLOCK AND IT CLEARS NOTHING.
 *
 * Danny, 2026-09-20, choosing this over paying for 14 reviews that could not
 * have counted: "make it a bootstrap exception record, not an audit
 * substitute ... Do not add fake {commit, auditor:'OWNER WAIVER'} rows if the
 * ledger parser could mistake those for review clearance."
 *
 * HE WAS RIGHT, AND THE LEDGER ALREADY CONTAINED THE MISTAKE. Rows reading
 * `"auditor": "OWNER WAIVER (Danny) -- NOT AN AUDIT"` were present and
 * `check-audit-coverage --json` reported `"audited": true` for them, because
 * `audited` is `Boolean(entry)` and nothing reads the string. The disclaimer
 * was addressed to a human; every consumer saw a clearance.
 *
 * So the distinction here is STRUCTURAL. A waiver is its own row type, it
 * never sets `audited`, and the commits it names go on being reported as
 * unaudited for as long as they are unaudited. The only thing it changes is
 * whether the Stop gate stops the turn.
 *
 * The four things it must never become are each a test below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseLedger, auditEscalation, isWaived, WAIVER_TYPE } from '../src/auditLedger.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const waiver = (over = {}) => JSON.stringify({
  type: WAIVER_TYPE,
  commits: [SHA_A],
  reason: 'PRE_GENESIS backlog cannot obtain gate-satisfying independent review',
  audit_performed: false,
  grants_audit_pass: false,
  scope: 'existing escaped backlog only',
  expires_when: 'P0-5 server-backed reviewer identity is operational',
  ...over,
});

/** A coverage object shaped the way auditCoverage really produces one. */
const coverage = (commits) => ({ commits, malformed: [], error: null });
const commit = (sha, over = {}) => ({
  sha, subject: 's', touched: ['src/guardSession.mjs'], audited: false, auditor: null, waived: false, ...over,
});

test('A WAIVED COMMIT STOPS BLOCKING, and is STILL REPORTED AS UNAUDITED', () => {
  /*
   * Both halves in one test on purpose: they are the whole contract, and a
   * change that satisfies one by breaking the other is the failure mode.
   */
  const blocked = auditEscalation(coverage([commit(SHA_A)]), []);
  assert.ok(blocked.block, 'the fixture does not block to begin with, so the test below proves nothing');
  assert.match(blocked.block, /audit-escaped/);

  const waivedCoverage = coverage([commit(SHA_A, { waived: true })]);
  const after = auditEscalation(waivedCoverage, []);
  assert.equal(after.block, null, 'the waiver did not stop the block');

  /* and the far end (rule 4): it is still counted and named as unaudited. */
  assert.match(String(after.notice), /unaudited/i,
    'the waiver silenced the REPORT as well as the block, so a reader can no longer '
    + 'tell these commits were never reviewed');
});

test('A WAIVER DOES NOT SET audited, WHICH IS THE WHOLE POINT', () => {
  const led = parseLedger(waiver());
  assert.equal(led.audited.size, 0,
    'the waiver landed in the audited map, so every consumer now reads it as a clearance');
  assert.equal(led.rows.length, 0, 'the waiver was filed as an ordinary audit row');
  assert.equal(led.malformed.length, 0, 'a well-formed waiver was rejected');
  assert.equal(isWaived(led, SHA_A), true);
});

test('IT IS BOUND TO EXPLICIT SHAS: no wildcard, no glob, no ref, no range', () => {
  /*
   * Rule 7: generated from the real refusal surface rather than three strings
   * I happened to think of, and every one of these is a spelling somebody
   * would reasonably reach for.
   */
  const notShas = ['*', '', '   ', 'HEAD', 'HEAD~50..HEAD', 'main', 'refs/heads/main',
    'a'.repeat(6), 'a'.repeat(41), 'g'.repeat(40), '../etc', 'a*', 'a'.repeat(39) + 'Z'];

  for (const bad of notShas) {
    const led = parseLedger(waiver({ commits: [bad] }));
    assert.equal(led.waived.size, 0, `"${bad}" was accepted as a waived commit`);
    assert.equal(led.malformed.length, 1,
      `"${bad}" was silently ignored rather than reported malformed, so a typo in a `
      + 'waiver reads as "the owner waived nothing" while looking waived to a human');
  }

  /* THE POSITIVE BESIDE THE NEGATIVES (rule 5): a real sha is still accepted. */
  assert.equal(parseLedger(waiver({ commits: ['abc1234'] })).waived.size, 1,
    'the shortest legal sha is refused, so the refusals above prove nothing');
});

test('A WAIVER CANNOT BE EDITED INTO A BLANKET PASS', () => {
  /*
   * The dangerous edit is not a wildcard, it is a plausible-looking field
   * flip. `grants_audit_pass: true` must make the row MALFORMED rather than
   * stronger -- a shape that can be upgraded in place is a hole with a polite
   * name on it.
   */
  for (const over of [
    { grants_audit_pass: true },
    { audit_performed: true },
    { grants_audit_pass: 'no' },
    { audit_performed: null },
    { reason: '' },
    { commits: [] },
    { commits: SHA_A },
  ]) {
    const led = parseLedger(waiver(over));
    assert.equal(led.waived.size, 0, `${JSON.stringify(over)} still granted a waiver`);
    assert.equal(led.audited.size, 0, `${JSON.stringify(over)} granted an AUDIT`);
    assert.equal(led.malformed.length, 1, `${JSON.stringify(over)} was ignored instead of refused`);
  }
});

test('IT DOES NOT COVER ANYTHING IT DOES NOT NAME', () => {
  /*
   * Danny: "Once the automatic path works, new audit-missing / audit-escaped
   * entries must block normally." A waiver that leaked forward would quietly
   * end the control instead of unblocking a backlog.
   */
  const led = parseLedger(waiver());
  assert.equal(isWaived(led, SHA_B), false, 'a commit the waiver never names came back waived');

  const mixed = coverage([commit(SHA_A, { waived: true }), commit(SHA_B)]);
  const r = auditEscalation(mixed, []);
  assert.ok(r.block, 'an unwaived control commit alongside a waived one stopped blocking');
  assert.match(r.block, new RegExp(SHA_B.slice(0, 8)),
    'the block fired but does not name the commit that caused it');
  assert.doesNotMatch(r.block, new RegExp(SHA_A.slice(0, 8)),
    'the waived commit is still being blocked on');
});

test('SHORT AND LONG SPELLINGS MATCH, because the ledger uses both', () => {
  /*
   * The house style in docs/audit-ledger.jsonl is 7-character shas; git log
   * hands auditCoverage 40. An exact-equality check would make every
   * hand-written waiver cover nothing -- invisible, and in the direction that
   * looks like the waiver was never written.
   */
  const short = parseLedger(waiver({ commits: [SHA_A.slice(0, 7)] }));
  assert.equal(isWaived(short, SHA_A), true, 'a 7-char waiver does not cover the full sha');

  const long = parseLedger(waiver({ commits: [SHA_A] }));
  assert.equal(isWaived(long, SHA_A.slice(0, 8)), true, 'a full-sha waiver does not cover the short form');

  assert.equal(isWaived(long, SHA_B), false, 'prefix matching went too wide');
  assert.equal(isWaived(long, ''), false, 'an empty sha matched a waiver by prefix');
});

test('THE REAL LEDGER CARRIES EXACTLY ONE WAIVER, and it grants no pass', () => {
  /*
   * Rule 17: the shipped file is a separate claim from the parser. A waiver
   * that parses in a fixture and is malformed on disk would leave the gate
   * blocking with everybody believing it was handled.
   */
  const text = readFileSync(new URL('../docs/audit-ledger.jsonl', import.meta.url), 'utf8');
  const led = parseLedger(text);

  assert.equal(led.waivers.length, 1,
    `expected exactly one owner waiver on disk, found ${led.waivers.length}`);
  const w = led.waivers[0];
  assert.equal(w.audit_performed, false);
  assert.equal(w.grants_audit_pass, false);
  assert.equal(w.commits.length, 14, 'the waiver no longer names the fourteen escaped commits');
  assert.equal(led.malformed.length, 0,
    `the shipped ledger has ${led.malformed.length} malformed line(s): ${JSON.stringify(led.malformed)}`);
});
