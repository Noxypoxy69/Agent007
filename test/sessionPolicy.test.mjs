/**
 * THE PROFILE SPLIT, TESTED FROM THE DIRECTION IT CAN HURT.
 *
 * The interesting assertions here are not "a manual session is trusted". They
 * are the four ways a session could become trusted WITHOUT anybody trusting it:
 * no evidence at all, an attestation naming somebody else, an attestation held
 * by a session that is running assigned work, and an attestation inside an audit
 * clone. CLAUDE.md rule 5 -- a negative needs the positive first -- so the
 * positive case is asserted before each negative, or "not trusted" would pass
 * against a resolver that trusts nothing.
 *
 * THE STORE IS A TEMP DIRECTORY. CLAUDE.md rule 20 requires it and `8ecc2e1`,
 * three commits ago, was a fix for exactly this: "The last resolve assertion
 * still read the operator's live store". The repo ROOT is real, because that is
 * what keys the store and deriving it is the point; only the HOME moves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MANUAL_TRUSTED, AUTONOMOUS_TASK, REVIEW_ONLY, PROFILES, DEFAULT_PROFILE,
  CAPABILITIES, permits, resolveSessionProfile,
} from '../src/sessionPolicy.mjs';

/**
 * The whole capability row, built through the accessor production uses.
 *
 * This was `capabilitiesOf`, an exported convenience with no production caller
 * -- which the dead-export ratchet correctly flagged. Reading the row through
 * `permits` is strictly better as a test: it exercises the function the guard
 * actually calls, rather than a sibling that could drift away from it.
 */
const rowOf = (profile) => Object.fromEntries(CAPABILITIES.map((k) => [k, permits(profile, k)]));
import {
  pendingPath, bindingPath, writePendingAttestation, bindSessionProfile,
  readSessionBinding, holdsTaskLease, isAuditWorkspace, gatherSessionEvidence,
  PENDING_MAX_AGE_MS,
} from '../src/sessionEvidence.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

function withHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'agentbridge-profile-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

/* ───────────────────────── the resolver, pure ───────────────────────── */

test('the default profile is the contained one', () => {
  /*
   * PINNED AS A VALUE, NOT AS A BEHAVIOUR, because this is the single
   * assumption the whole split rests on. Danny's brief: "Unknown/unclassified
   * sessions fail toward AUTONOMOUS_TASK, NOT toward MANUAL_TRUSTED."
   */
  assert.equal(DEFAULT_PROFILE, AUTONOMOUS_TASK);
});

test('no evidence at all is contained, not trusted', () => {
  const r = resolveSessionProfile({});
  assert.equal(r.profile, AUTONOMOUS_TASK);
  assert.equal(r.source, 'no-evidence');
});

test('a launcher attestation naming THIS session is trusted', () => {
  // The positive. Every negative below is the same call with one field changed,
  // so a negative cannot pass by accidentally failing to construct the case.
  const r = resolveSessionProfile({
    sessionId: 's-1',
    attestation: { profile: MANUAL_TRUSTED, sessionId: 's-1' },
  });
  assert.equal(r.profile, MANUAL_TRUSTED);
  assert.equal(r.source, 'launcher-attestation');
});

test('an attestation naming a DIFFERENT session does not promote this one', () => {
  const r = resolveSessionProfile({
    sessionId: 's-1',
    attestation: { profile: MANUAL_TRUSTED, sessionId: 's-2' },
  });
  assert.equal(r.profile, AUTONOMOUS_TASK);
  assert.equal(r.source, 'attestation-session-mismatch');
});

test('a task lease outranks the attestation', () => {
  /*
   * THE BRANCH THAT KEEPS THE ATTESTATION HONEST. Without it, `agent code-a`
   * followed by claiming a task is a route from the launcher into an
   * uncontained worker.
   */
  const r = resolveSessionProfile({
    sessionId: 's-1',
    attestation: { profile: MANUAL_TRUSTED, sessionId: 's-1' },
    holdsTaskLease: true,
  });
  assert.equal(r.profile, AUTONOMOUS_TASK);
  assert.equal(r.source, 'task-lease');
});

test('an audit workspace is REVIEW_ONLY even when the launcher attested it', () => {
  const r = resolveSessionProfile({
    sessionId: 's-1',
    attestation: { profile: MANUAL_TRUSTED, sessionId: 's-1' },
    auditWorkspace: true,
  });
  assert.equal(r.profile, REVIEW_ONLY);
  assert.equal(r.source, 'audit-workspace');
});

test('an attestation with no session id on either side is not honoured', () => {
  for (const evidence of [
    { sessionId: null, attestation: { profile: MANUAL_TRUSTED, sessionId: null } },
    { sessionId: '', attestation: { profile: MANUAL_TRUSTED, sessionId: '' } },
    { sessionId: '   ', attestation: { profile: MANUAL_TRUSTED, sessionId: '   ' } },
  ]) {
    assert.equal(resolveSessionProfile(evidence).profile, AUTONOMOUS_TASK);
  }
});

test('a malformed attestation is no attestation', () => {
  for (const attestation of [
    { profile: 'root', sessionId: 's-1' },
    { profile: null, sessionId: 's-1' },
    { profile: MANUAL_TRUSTED.toUpperCase(), sessionId: 's-1' },
    {},
  ]) {
    const r = resolveSessionProfile({ sessionId: 's-1', attestation });
    assert.equal(r.profile, AUTONOMOUS_TASK, `${JSON.stringify(attestation)} must not promote`);
  }
});

/* ─────────────────────── the capability table ─────────────────────── */

test('no profile may relax a hard boundary', () => {
  /*
   * GENERATED FROM THE REAL PROFILE LIST, not from three hand-written cases --
   * CLAUDE.md rule 7. A profile added later is covered without anybody
   * remembering to extend this.
   */
  for (const profile of PROFILES) {
    assert.equal(permits(profile, 'ownerActionsGated'), true, `${profile} must gate owner actions`);
    assert.equal(permits(profile, 'gateSelfConfigImmutable'), true, `${profile} must not touch the gate config`);
  }
});

test('MANUAL_TRUSTED relaxes exactly the three checks it is meant to', () => {
  assert.equal(permits(MANUAL_TRUSTED, 'protectedPathsApply'), false);
  assert.equal(permits(MANUAL_TRUSTED, 'baselineTestsImmutable'), false);
  assert.equal(permits(MANUAL_TRUSTED, 'shellAllowlistApplies'), false);
  assert.equal(permits(MANUAL_TRUSTED, 'mayWriteRepoFiles'), true);
  assert.equal(permits(MANUAL_TRUSTED, 'stopFindingsAutoRepair'), false);
});

test('AUTONOMOUS_TASK is byte-for-byte the model that shipped before the split', () => {
  // Nothing was weakened; something was scoped. If this row ever changes, the
  // split has started eating the thing it was supposed to leave alone.
  assert.deepEqual(rowOf(AUTONOMOUS_TASK), {
    protectedPathsApply: true,
    baselineTestsImmutable: true,
    shellAllowlistApplies: true,
    mayWriteRepoFiles: true,
    stopFindingsAutoRepair: true,
    ownerActionsGated: true,
    gateSelfConfigImmutable: true,
  });
});

test('REVIEW_ONLY cannot write the candidate it is reviewing', () => {
  assert.equal(permits(REVIEW_ONLY, 'mayWriteRepoFiles'), false);
  assert.equal(permits(REVIEW_ONLY, 'protectedPathsApply'), true);
});

test('an unknown capability throws rather than reading as false', () => {
  /*
   * A TYPO MUST NOT BE ABLE TO DISARM A CONTROL. `permits(p, 'protectedPathApply')`
   * -- singular -- would answer undefined, which the guard would read as "the
   * protection does not apply".
   */
  assert.throws(() => permits(MANUAL_TRUSTED, 'protectedPathApply'), /unknown capability/);
  assert.ok(CAPABILITIES.includes('protectedPathsApply'));
});

test('an unknown profile is answered with the contained row', () => {
  for (const key of CAPABILITIES) {
    assert.equal(permits('something-nobody-defined', key), permits(DEFAULT_PROFILE, key));
  }
});

/* ───────────────────── the bind-once mechanism ───────────────────── */

test('a pending attestation binds once and is consumed', () => withHome((home) => {
  const w = writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  assert.equal(w.ok, true);
  assert.ok(existsSync(pendingPath(REPO, home)), 'the launcher left a pending attestation');

  const bound = bindSessionProfile(REPO, 's-1', Date.now(), home);
  assert.equal(bound.ok, true);
  assert.equal(bound.record.profile, MANUAL_TRUSTED);

  // CONSUMED. A pending file left behind is an ambient flag the next session picks up.
  assert.equal(existsSync(pendingPath(REPO, home)), false, 'the pending attestation must be consumed');

  assert.equal(readSessionBinding(REPO, 's-1', home).profile, MANUAL_TRUSTED);
}));

test('a second session cannot reuse a consumed attestation', () => withHome((home) => {
  writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  assert.equal(bindSessionProfile(REPO, 's-1', Date.now(), home).ok, true);

  const second = bindSessionProfile(REPO, 's-2', Date.now(), home);
  assert.equal(second.ok, false);
  assert.match(second.reason, /no launcher attestation/);
  assert.equal(readSessionBinding(REPO, 's-2', home), null);
}));

test('a binding is never replaced once it exists', () => withHome((home) => {
  writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  assert.equal(bindSessionProfile(REPO, 's-1', Date.now(), home).ok, true);

  // A session that plants a fresh pending file cannot rebind itself.
  writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  const again = bindSessionProfile(REPO, 's-1', Date.now(), home);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already exists/);
}));

test('a stale pending attestation is refused', () => withHome((home) => {
  const now = Date.now();
  writePendingAttestation(REPO, MANUAL_TRUSTED, now - PENDING_MAX_AGE_MS - 1000, home);
  const bound = bindSessionProfile(REPO, 's-1', now, home);
  assert.equal(bound.ok, false);
  assert.match(bound.reason, /outside the/);
  assert.equal(readSessionBinding(REPO, 's-1', home), null);
}));

test('a future-dated pending attestation is refused too', () => withHome((home) => {
  // Clock skew is not a permission. A far-future created_at would otherwise
  // never age out.
  const now = Date.now();
  writePendingAttestation(REPO, MANUAL_TRUSTED, now + PENDING_MAX_AGE_MS + 1000, home);
  assert.equal(bindSessionProfile(REPO, 's-1', now, home).ok, false);
}));

test('binding with no pending attestation leaves the session contained', () => withHome((home) => {
  const bound = bindSessionProfile(REPO, 's-1', Date.now(), home);
  assert.equal(bound.ok, false);
  assert.equal(readSessionBinding(REPO, 's-1', home), null);
  assert.equal(resolveSessionProfile(gatherSessionEvidence({
    repoRoot: REPO, sessionId: 's-1', cwd: REPO, env: {}, home,
  })).profile, AUTONOMOUS_TASK);
}));

test('a session id cannot traverse out of the profile store', () => withHome((home) => {
  /*
   * agent.cmd already carries a scar about an id that executed as script
   * because it became a directory name. The same class arrives here: an id of
   * `../overrides/<key>` would aim this store at the grant file.
   */
  const hostile = bindingPath(REPO, '../../overrides/e09139d77b22755b', home);
  assert.ok(hostile === null || !hostile.includes('..'), `traversal survived: ${hostile}`);
  for (const id of ['..', '../..', '/etc/passwd', '']) {
    const p = bindingPath(REPO, id, home);
    assert.ok(p === null || !p.includes('..'), `traversal survived for ${JSON.stringify(id)}`);
  }
}));

test('a binding whose content names another session is not honoured', () => withHome((home) => {
  /*
   * The filename is derived from a SANITISED id, so the path alone is not proof
   * of whose binding this is. Same move as matching a grant on every spelling
   * the protection used.
   */
  writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  assert.equal(bindSessionProfile(REPO, 's-1', Date.now(), home).ok, true);

  const file = bindingPath(REPO, 's-1', home);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.sessionId = 's-9';
  writeFileSync(file, JSON.stringify(record), 'utf8');

  assert.equal(readSessionBinding(REPO, 's-1', home), null);
}));

/* ─────────────── the signals that may only contain ─────────────── */

test('the lease signal only ever moves a session towards containment', () => {
  assert.equal(holdsTaskLease({}), false);
  assert.equal(holdsTaskLease({ AGENTBRIDGE_TASK_LEASE: '' }), false);
  assert.equal(holdsTaskLease({ AGENTBRIDGE_TASK_LEASE: '   ' }), false);
  assert.equal(holdsTaskLease({ AGENTBRIDGE_TASK_LEASE: 'lease-abc' }), true);
});

test('the review marker is read from the clone, not only the environment', () => withHome((home) => {
  assert.equal(isAuditWorkspace(home, {}), false);
  writeFileSync(path.join(home, '.agentbridge-review'), 'audit clone\n', 'utf8');
  assert.equal(isAuditWorkspace(home, {}), true);
}));

test('gatherSessionEvidence reports what the resolver needs, end to end', () => withHome((home) => {
  writePendingAttestation(REPO, MANUAL_TRUSTED, Date.now(), home);
  bindSessionProfile(REPO, 's-1', Date.now(), home);

  const trusted = gatherSessionEvidence({ repoRoot: REPO, sessionId: 's-1', cwd: REPO, env: {}, home });
  assert.equal(resolveSessionProfile(trusted).profile, MANUAL_TRUSTED);

  // The SAME binding, with a lease in the environment, is contained.
  const leased = gatherSessionEvidence({
    repoRoot: REPO, sessionId: 's-1', cwd: REPO, env: { AGENTBRIDGE_TASK_LEASE: 'l-1' }, home,
  });
  assert.equal(resolveSessionProfile(leased).profile, AUTONOMOUS_TASK);
}));
