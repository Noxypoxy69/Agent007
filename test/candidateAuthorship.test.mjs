/**
 * P0-1: AUTHORSHIP BOUND BY AGENT007, NOT ASSERTED BY THE AUTHOR.
 *
 * The audit queue refused a claimant matching the candidate's Claude-Session
 * trailer. Danny's correction: the author WRITES that trailer, so it can carry
 * any session string including another agent's, and the comparison then passes.
 * Author-controlled evidence cannot establish that a reviewer is not the
 * author.
 *
 * So authorship is bound at candidate creation from the active authenticated
 * session. The load-bearing assertion in this file is FIRST BINDING WINS --
 * without it, an author who wanted to audit its own candidate would re-bind it
 * to somebody else's principal and become eligible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindAuthorship, authorOf, isAuthoritative, IDENTITY,
} from '../src/candidateAuthorship.mjs';

const CAND = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const NOW = '2026-09-20T01:00:00Z';

const good = {
  candidate_sha: CAND,
  candidate_tree_sha: TREE,
  base_sha: BASE,
  session_id: 'session_AUTHOR',
  principal_id: 'principal_AUTHOR',
  worker_id: 'worker-1',
  task_id: 't-1',
  attempt: 1,
  lease_token: 'L1',
  identity_source: IDENTITY.CREDENTIAL,
};

const bind = (patch = {}, opts = {}) => bindAuthorship({ ...good, ...patch }, { now: NOW, ...opts });

/* ── the property the module exists for ──────────────────────────────── */

test('A CANDIDATE CANNOT BE RE-BOUND TO A DIFFERENT AUTHOR', () => {
  /*
   * THE WHOLE SECURITY ARGUMENT. Re-binding is how an author would make itself
   * eligible to audit its own work: write the candidate, then rewrite the
   * record to name somebody else, then claim the audit.
   */
  const first = bind().record;
  const r = bindAuthorship({ ...good, session_id: 'session_SOMEBODY_ELSE', principal_id: 'principal_ELSE' },
    { existing: first, now: NOW });
  assert.equal(r.ok, false, 'a candidate was re-bound to a different principal');
  assert.match(r.errors.join(' '), /already bound to a different author/);
  assert.match(r.errors.join(' '), /eligible to audit its own work/);
});

test('AN IDENTICAL RE-BIND IS AN IDEMPOTENT NO-OP', () => {
  /*
   * Rule 5, and a practical necessity: a runtime that retries must not have to
   * remember whether it already recorded this. Refusing here would make the
   * honest caller carry state the store already has.
   */
  const first = bind().record;
  const again = bindAuthorship({ ...good }, { existing: first, now: NOW });
  assert.equal(again.ok, true);
  assert.equal(again.unchanged, true);
  assert.equal(again.record, first, 'the stored record was replaced rather than kept');
});

test('EVERY BOUND FIELD IS COMPARED, ALONE', () => {
  /*
   * Rule 7 and rule 2 together: a loop that only ever changes one field cannot
   * show the others are read, so each is moved by itself. The tree sha is in
   * here deliberately -- a commit and its content are different claims.
   */
  const first = bind().record;
  for (const [field, value] of Object.entries({
    session_id: 'other', principal_id: 'other', worker_id: 'other',
    task_id: 't-2', attempt: 9, lease_token: 'L9', candidate_tree_sha: 'd'.repeat(40),
  })) {
    const r = bindAuthorship({ ...good, [field]: value }, { existing: first, now: NOW });
    assert.equal(r.ok, false, `${field} changed and the re-bind was accepted`);
    assert.match(r.errors.join(' '), new RegExp(field));
  }
});

/* ── what makes it a record rather than a guess ──────────────────────── */

test('A CANDIDATE WHOSE AUTHOR CANNOT BE NAMED IS REFUSED', () => {
  const r = bind({ session_id: null, principal_id: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /cannot later be shown independent/);
});

test('THE CANDIDATE IDENTITY IS REQUIRED, BOTH HALVES', () => {
  assert.equal(bind({ candidate_sha: null }).ok, false);
  assert.equal(bind({ candidate_tree_sha: null }).ok, false);
  assert.equal(bind({ candidate_sha: 'abc123' }).ok, false, 'a short sha was accepted');
  /* A commit and its content are separate claims: a rebase or an amend
   * produces a new commit carrying an identical tree. */
  assert.match(bind({ candidate_tree_sha: null }).errors.join(' '), /different claims/);
});

test('A LEASE WITHOUT ITS TASK AND ATTEMPT REFERENCES NO AUTHORITY', () => {
  assert.equal(bind({ lease_token: 'L1', task_id: null }).ok, false);
  assert.equal(bind({ lease_token: 'L1', attempt: null }).ok, false);
  /* And leaseless work is legitimate -- most work here is not under a task. */
  assert.equal(bind({ lease_token: null, task_id: null, attempt: null }).ok, true);
});

test('A MALFORMED OPTIONAL IS AN ERROR, not a silent drop', () => {
  assert.equal(bind({ attempt: 'one' }).ok, false);
  assert.equal(bind({ base_sha: 'nope' }).ok, false);
});

/* ── refusing to overstate itself ────────────────────────────────────── */

test('ONLY A CALLER THAT RESOLVED A CREDENTIAL GETS `credential`', () => {
  /*
   * A field that said 'credential' because the caller asked nicely would be
   * worse than no field. Anything that is not exactly the credential marker
   * records as observed.
   */
  for (const claimed of ['credential ', 'CREDENTIAL', 'authoritative', true, 1, null, undefined, 'observed']) {
    assert.equal(bind({ identity_source: claimed }).record.identity_source, IDENTITY.OBSERVED,
      `${JSON.stringify(claimed)} was accepted as a credential`);
  }
  assert.equal(bind({ identity_source: IDENTITY.CREDENTIAL }).record.identity_source, IDENTITY.CREDENTIAL);
});

test('authorOf CARRIES THE SOURCE, so a caller cannot forget to weigh it', () => {
  /*
   * "Who was it" and "how much does that answer weigh" are different
   * questions. A caller handed only the id would have to guess, and guessing
   * permissively is the failure this exists to prevent.
   */
  assert.deepEqual(authorOf(bind().record), { id: 'principal_AUTHOR', source: 'authoritative' });
  assert.deepEqual(authorOf(bind({ identity_source: IDENTITY.OBSERVED }).record),
    { id: 'principal_AUTHOR', source: 'observed' });
  assert.equal(authorOf(null), null);
  assert.equal(authorOf({}), null);
});

test('THE PRINCIPAL IS PREFERRED OVER THE SESSION, and a session alone still names somebody', () => {
  assert.equal(authorOf(bind({ principal_id: null }).record).id, 'session_AUTHOR');
  assert.equal(authorOf(bind({ principal_id: null }).record).source, 'observed',
    'a record with no principal claimed an authoritative identity');
});

test('isAuthoritative NEEDS BOTH a credential source AND a principal', () => {
  assert.equal(isAuthoritative(bind().record), true);
  assert.equal(isAuthoritative(bind({ identity_source: IDENTITY.OBSERVED }).record), false);
  assert.equal(isAuthoritative(bind({ principal_id: null }).record), false,
    'a credential claim with nobody behind it was called authoritative');
  assert.equal(isAuthoritative(null), false);
});

test('NOTHING THIS MACHINE CAN WRITE TODAY IS AUTHORITATIVE, and that is the honest state', () => {
  /*
   * Rule 9: a fixture must be a shape the system really produces. No session
   * here starts through the launcher, so AGENTBRIDGE_AGENT_ID is unset and
   * there is no authenticated principal to resolve -- every record written now
   * is observed. Pinning it means the day that changes, this changes
   * deliberately rather than silently.
   */
  const asProducedToday = bindAuthorship({
    candidate_sha: CAND, candidate_tree_sha: TREE, session_id: 'session_OBSERVED',
  }, { now: NOW });
  assert.equal(asProducedToday.ok, true);
  assert.equal(isAuthoritative(asProducedToday.record), false);
  assert.equal(authorOf(asProducedToday.record).source, 'observed');
});
