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

import {
  parseLedger, auditEscalation, isWaived, WAIVER_TYPE, standingAudit,
} from '../src/auditLedger.mjs';

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

  /*
   * AND THE FAR END (rule 4): it is still NAMED in the report as having no
   * audit. Asserted on the sha rather than on the word "unaudited" -- the
   * first version of this matched /unaudited/i and went red against a notice
   * reading "1 commit(s) changed a control with no audit recorded", which is
   * the same statement in the formatter's own words. The assertion was wrong,
   * not the code, and matching prose would have kept breaking on rewording.
   * What must be true is that the commit is still listed.
   */
  const notice = String(after.notice);
  assert.match(notice, /no audit recorded/,
    'the waiver silenced the REPORT as well as the block, so a reader can no longer '
    + 'tell these commits were never reviewed');
  assert.match(notice, new RegExp(SHA_A.slice(0, 8)),
    'the waived commit vanished from the report entirely');
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

test('AN owner_waiver:true ROW IS A WAIVER, NOT AN AUDIT -- the eight already on disk', () => {
  /*
   * These were written before the typed waiver existed, and written well:
   * owner_waiver:true, an auditor string saying NOT AN AUDIT, and a note
   * stating that nobody examined the commit. The parser ignored all of it,
   * filed them under `audited`, and eight commits reported as reviewed.
   *
   * The rows were honest; the parser was not listening. This pins that it
   * now does.
   */
  const line = JSON.stringify({
    commit: '6b33d7d2',
    auditor: 'OWNER WAIVER (Danny) -- NOT AN AUDIT',
    owner_waiver: true,
    note: 'no auditor examined this commit',
  });
  const led = parseLedger(line);

  assert.equal(led.audited.size, 0,
    'an owner_waiver row is still counted as an audit, so the commit reports as reviewed');
  assert.equal(led.rows.length, 0, 'it was kept as an ordinary audit row');
  assert.equal(led.malformed.length, 0, 'a well-formed owner_waiver row was rejected outright');
  assert.equal(isWaived(led, '6b33d7d2'), true, 'it suppresses nothing, so the gate still blocks');

  /*
   * THE POSITIVE BESIDE IT (rule 5): an ordinary audit row on the same shape
   * must still register, or this test passes because nothing registers.
   */
  const real = parseLedger(JSON.stringify({ commit: 'abc1234', auditor: 'somebody-else' }));
  assert.equal(real.audited.size, 1, 'an ordinary audit row stopped counting as an audit');
  assert.equal(isWaived(real, 'abc1234'), false, 'an ordinary audit row was treated as a waiver');
});

test('owner_waiver MUST BE EXACTLY true, not merely truthy', () => {
  /*
   * `"owner_waiver": "no"` is truthy. A loose check would turn a row whose
   * author was saying the OPPOSITE into a waiver -- and the rows this feature
   * exists for are hand-written, which is where that typo lives.
   */
  for (const v of ['no', 'false', 1, {}, 'true']) {
    const led = parseLedger(JSON.stringify({ commit: 'abc1234', auditor: 'x', owner_waiver: v }));
    assert.equal(led.waived.size, 0, `owner_waiver:${JSON.stringify(v)} granted a waiver`);
    assert.equal(led.audited.size, 1, `owner_waiver:${JSON.stringify(v)} lost the audit row entirely`);
  }
});

test('NO ROW THAT DISCLAIMS BEING AN AUDIT IS COUNTED AS ONE -- any spelling', () => {
  /*
   * Blind audit H1, MEASURED, and the gate below could not have caught it:
   * it reads `led.waivers`, and the offending rows were not waivers. A
   * correction row carrying audit_performed:false, grants_audit_pass:false
   * and an auditor reading "NONE -- ... not an audit" landed in `audited`
   * and cleared 2a86d27, the commit that rewrote the re-review bound.
   *
   * So this asks the question the other gate cannot: over the SHIPPED
   * file, is there any row at all whose own fields say it is not a review
   * and which the parser nevertheless treats as one? Third instance of
   * this exact defect -- code-a's owner_waiver rows, then mine -- so it is
   * asserted on the SHAPE rather than on the three spellings seen so far
   * (rule 8: fix the matcher, not the strings).
   */
  const text = readFileSync(new URL('../docs/audit-ledger.jsonl', import.meta.url), 'utf8');
  const led = parseLedger(text);

  const leaked = led.rows.filter(
    (r) => r?.audit_performed === false || r?.grants_audit_pass === false,
  );
  assert.deepEqual(leaked.map((r) => `${r.commit}: ${r.auditor}`), [],
    'a row declaring itself not an audit is being counted as one');

  /* And it must not become the STANDING verdict either (L1): a correction
   * written after a real audit carries a newer `at`, so if it reached
   * `rows` it would replace genuine findings with found:0. */
  for (const r of led.notAudits) {
    const standing = standingAudit(led, String(r.commit).trim().toLowerCase());
    if (standing) {
      assert.notEqual(standing.auditor, r.auditor,
        `the disclaiming row for ${r.commit} became the standing audit`);
    }
  }

  /*
   * THE POSITIVE (rule 5), and it is what stops this passing by the parser
   * simply dropping everything. The shipped file must still yield real
   * audits, and the disclaiming rows must actually have been recognised
   * rather than silently absent.
   */
  assert.ok(led.rows.length > 0, 'the parser returned no audit rows at all');
  assert.ok(led.notAudits.length > 0,
    'no disclaiming row was recognised on disk -- this gate is not exercising anything');
});

test('A DISCLAIMING ROW DOES NOT CLEAR ITS COMMIT, and does not waive it either', () => {
  /*
   * The fixture form of the above, and the part that names the intended
   * behaviour: not audited, AND not waived. A correction suppresses
   * nothing, because nobody waived anything -- the commit stays blocked,
   * which is the fail-closed reading of "this row grants nothing".
   *
   * Generated from the field list rather than from the one spelling I
   * happened to write (rule 7), so a row disclaiming either way is covered.
   */
  for (const field of ['audit_performed', 'grants_audit_pass']) {
    const led = parseLedger(JSON.stringify({
      commit: 'abc1234', auditor: 'NONE -- a correction, not an audit', [field]: false,
    }));
    assert.equal(led.audited.size, 0, `${field}:false still cleared the commit`);
    assert.equal(led.rows.length, 0, `${field}:false reached rows, so standingAudit can pick it`);
    assert.equal(led.waived.size, 0, `${field}:false silently became a WAIVER`);
    assert.equal(led.notAudits.length, 1, `${field}:false was not recorded anywhere`);
    assert.equal(led.malformed.length, 0, `${field}:false was treated as malformed`);
  }

  /* THE POSITIVE (rule 5): an ordinary row with neither field still audits. */
  const real = parseLedger(JSON.stringify({ commit: 'abc1234', auditor: 'a-real-reader' }));
  assert.equal(real.audited.size, 1, 'an ordinary audit row stopped counting');
  assert.equal(real.notAudits.length, 0);
});

test('THE REAL LEDGER CARRIES EXACTLY ONE WAIVER, and it grants no pass', () => {
  /*
   * Rule 17: the shipped file is a separate claim from the parser. A waiver
   * that parses in a fixture and is malformed on disk would leave the gate
   * blocking with everybody believing it was handled.
   */
  const text = readFileSync(new URL('../docs/audit-ledger.jsonl', import.meta.url), 'utf8');
  const led = parseLedger(text);

  /*
   * ONE TYPED waiver plus the eight owner_waiver ROWS that predate it. The
   * count is asserted rather than the shape alone, because the number is the
   * thing that silently drifts -- and a ninth appearing unnoticed is how a
   * waiver stops being an exception and becomes the default.
   */
  const typed = led.waivers.filter((w) => w.type === WAIVER_TYPE);
  const rowForm = led.waivers.filter((w) => w.type === 'owner_waiver_row');
  assert.equal(typed.length, 1,
    `expected exactly one TYPED owner waiver on disk, found ${typed.length}`);
  assert.equal(rowForm.length, 8,
    `expected the eight pre-existing owner_waiver rows, found ${rowForm.length}`);

  for (const w of led.waivers) {
    assert.equal(w.audit_performed, false, 'a waiver on disk claims an audit was performed');
    assert.equal(w.grants_audit_pass, false, 'a waiver on disk claims to grant a pass');
  }

  const w = typed[0];
  assert.equal(w.audit_performed, false);
  assert.equal(w.grants_audit_pass, false);
  assert.equal(w.commits.length, 14, 'the waiver no longer names the fourteen escaped commits');
  assert.equal(led.malformed.length, 0,
    `the shipped ledger has ${led.malformed.length} malformed line(s): ${JSON.stringify(led.malformed)}`);
});
