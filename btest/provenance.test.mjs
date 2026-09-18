import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDelegation, validateDelegation, transition, auditChangedPaths,
  attributeCommit, validateAttribution, conflictingAttributions, summariseProvenance,
  TRANSITIONS,
} from '../src/provenance.mjs';

/**
 * Both directions for every rule. A fires-only suite passes completely against
 * a validator that rejects everything and an auditor that flags every path, so
 * each refusal below is paired with the nearest case that must be allowed.
 */

const BASE = 'b364b84489a9e5cd0860e60f56ac5302634dc1bb';
const HEAD = '1111111111111111111111111111111111111111';

const del = (over = {}) => createDelegation({
  id: 'd-collision-guard',
  assigning_session: 'danny-win-10',
  assigned_session: 'danny-win-f1',
  task: 'pre-commit collision guard',
  lane_id: 'agentbridge',
  base_sha: BASE,
  allowed_paths: ['src/collisionGuard.mjs', 'test/collisionGuard*.test.mjs', 'bin/agentbridge-precommit.mjs', 'hooks/**'],
  forbidden_paths: ['package.json', 'bin/agentbridge.mjs', 'src/laneRegistry.mjs', 'bridge/**', 'mcp/**'],
  shared_paths: ['package.json', 'bin/agentbridge.mjs'],
  now: '2026-09-15T02:00:00Z',
  ...over,
});

// ── the control ─────────────────────────────────────────────────────────────

test('provenance: a well-formed delegation validates', () => {
  // If this fails every rejection below is meaningless.
  const v = validateDelegation(del());
  assert.equal(v.ok, true, `valid delegation rejected: ${v.errors.join('; ')}`);
});

// ── validation, both directions ─────────────────────────────────────────────

test('provenance: validation rejects real mistakes', () => {
  const cases = [
    ['missing base sha', { base_sha: '' }, /base_sha is required/],
    ['bad sha', { base_sha: 'not-a-sha' }, /not a valid git sha/],
    ['no task', { task: '   ' }, /task is required/],
    ['self-delegation', { assigned_session: 'danny-win-10' }, /same session/],
    ['allowed and forbidden overlap', { allowed_paths: ['package.json'], forbidden_paths: ['package.json'] }, /both allowed and forbidden/],
  ];
  for (const [what, over, pattern] of cases) {
    const v = validateDelegation(del(over));
    assert.equal(v.ok, false, `${what} was accepted`);
    assert.ok(v.errors.some((e) => pattern.test(e)), `${what}: wrong error: ${v.errors.join('; ')}`);
  }
});

test('provenance: a delegation with no allow-list is still valid', () => {
  // "forbid these, everything else is fine" is a normal shape.
  assert.equal(validateDelegation(del({ allowed_paths: [] })).ok, true);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('provenance: the happy path runs assigned -> returned -> accepted', () => {
  const a = del();
  const r = transition(a, 'returned', { head_sha: HEAD, now: 't1' });
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.equal(r.record.state, 'returned');
  assert.equal(r.record.head_sha, HEAD);

  const acc = transition(r.record, 'accepted', { audit: { ok: true }, now: 't2' });
  assert.equal(acc.ok, true);
  assert.equal(acc.record.state, 'accepted');
  assert.deepEqual(acc.record.history.map((h) => h.state), ['assigned', 'returned', 'accepted']);
});

test('provenance: accepting work that was never returned is refused', () => {
  // The shape of recording an audit for a SHA nobody produced.
  const r = transition(del(), 'accepted', { now: 't' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /cannot go from "assigned" to "accepted"/);
});

test('provenance: returning the base sha is refused as an empty delivery', () => {
  const r = transition(del(), 'returned', { head_sha: BASE, now: 't' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /nothing was committed/);
});

test('provenance: returning requires a real sha', () => {
  assert.equal(transition(del(), 'returned', { head_sha: null }).ok, false);
  assert.equal(transition(del(), 'returned', { head_sha: 'nope' }).ok, false);
});

test('provenance: a rejected delegation can be returned again', () => {
  // The delegate fixes it and hands back. Terminal-on-reject would force a new
  // contract for every round of review.
  const returned = transition(del(), 'returned', { head_sha: HEAD }).record;
  const rejected = transition(returned, 'rejected', { audit: { ok: false } }).record;
  const again = transition(rejected, 'returned', { head_sha: '2222222222222222222222222222222222222222' });
  assert.equal(again.ok, true);
});

test('provenance: accepted is terminal', () => {
  const returned = transition(del(), 'returned', { head_sha: HEAD }).record;
  const accepted = transition(returned, 'accepted', {}).record;
  for (const next of ['returned', 'rejected', 'withdrawn', 'accepted']) {
    assert.equal(transition(accepted, next, { head_sha: HEAD }).ok, false, `accepted -> ${next} was allowed`);
  }
  assert.deepEqual(TRANSITIONS.accepted, []);
});

test('provenance: a corrupted record claiming "returned" with no sha cannot be accepted', () => {
  // NOT reachable through transition() -- the lifecycle check stops
  // assigned -> accepted first. It is reachable from the STORE: delegations
  // live in a JSON file on disk that a person can edit, and a record hand-set
  // to state:"returned" with head_sha:null would otherwise be acceptable,
  // recording an audit for a SHA that never existed.
  //
  // This test exists because the mutation harness caught the guard being
  // vacuous: disabling it changed nothing, since no test reached it.
  const corrupt = { ...del(), state: 'returned', head_sha: null };
  const r = transition(corrupt, 'accepted', { now: 't' });
  assert.equal(r.ok, false, 'accepted a delegation with no head_sha');
  assert.match(r.errors[0], /never returned/);

  const rj = transition(corrupt, 'rejected', { now: 't' });
  assert.equal(rj.ok, false, 'rejected a delegation with no head_sha');
});

test('provenance: a properly returned record IS acceptable', () => {
  // The silent half of the test above: the guard must not refuse the normal case.
  const returned = transition(del(), 'returned', { head_sha: HEAD }).record;
  assert.equal(transition(returned, 'accepted', {}).ok, true);
});

test('provenance: transition never mutates the record it was given', () => {
  const a = del();
  const before = JSON.stringify(a);
  transition(a, 'returned', { head_sha: HEAD });
  assert.equal(JSON.stringify(a), before, 'transition mutated its input');
});

// ── THE AUDIT: the reason this is a contract and not a note ─────────────────

test('provenance: a return that honoured the contract passes', () => {
  const r = auditChangedPaths(del(), [
    'src/collisionGuard.mjs',
    'test/collisionGuard.test.mjs',
    'test/collisionGuardCli.test.mjs',
    'bin/agentbridge-precommit.mjs',
    'hooks/pre-commit',
  ]);
  assert.equal(r.ok, true, `clean return flagged: ${JSON.stringify(r.violations)}`);
  assert.equal(r.checked, 5);
  assert.deepEqual(r.shared, []);
});

test('provenance: touching a forbidden shared file is caught', () => {
  const r = auditChangedPaths(del(), ['src/collisionGuard.mjs', 'package.json']);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.deepEqual(r.violations[0], {
    path: 'package.json', reason: 'forbidden', detail: 'explicitly outside this delegation',
  });
  assert.deepEqual(r.shared, ['package.json'], 'a forbidden file that is also shared is reported as both');
});

test('provenance: editing the module the delegate may only consume is caught', () => {
  const r = auditChangedPaths(del(), ['src/laneRegistry.mjs']);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].reason, 'forbidden');
});

test('provenance: a file outside the allow-list is caught even when not forbidden', () => {
  // src/collect.mjs is nobody's forbidden entry here, but it is not B's either.
  const r = auditChangedPaths(del(), ['src/collect.mjs']);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].reason, 'outside-allowed');
});

test('provenance: with no allow-list, anything not forbidden is permitted', () => {
  // Silent half. An auditor that flags everything passes all three tests above.
  const r = auditChangedPaths(del({ allowed_paths: [] }), ['src/anything.mjs', 'docs/notes.md']);
  assert.equal(r.ok, true, `no-allow-list contract flagged ${JSON.stringify(r.violations)}`);
});

test('provenance: forbidden beats allowed when a contract is ambiguous', () => {
  // Fails closed. validateDelegation reports the overlap so it gets fixed.
  const d = del({ allowed_paths: ['src/**'], forbidden_paths: ['src/laneRegistry.mjs'] });
  assert.equal(auditChangedPaths(d, ['src/laneRegistry.mjs']).violations[0].reason, 'forbidden');
  assert.equal(auditChangedPaths(d, ['src/other.mjs']).ok, true);
});

test('provenance: an empty diff is clean, not an error', () => {
  const r = auditChangedPaths(del(), []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('provenance: the audit uses the same glob engine as the lane registry', () => {
  // Two engines disagreeing about ** would mean the contract the delegate was
  // audited against is not the contract it was given.
  const d = del({ allowed_paths: ['hooks/**'], forbidden_paths: [] });
  assert.equal(auditChangedPaths(d, ['hooks/pre-commit']).ok, true);
  assert.equal(auditChangedPaths(d, ['hooks/a/b/c']).ok, true);
  assert.equal(auditChangedPaths(d, ['hooksy/x']).ok, false);
});

// ── commit attribution ──────────────────────────────────────────────────────

test('provenance: attribution records what git cannot', () => {
  const a = attributeCommit({ sha: '8b4403c', session_id: 'danny-win-f1', lane_id: 'agentbridge', now: 't' });
  assert.equal(validateAttribution(a).ok, true);
  assert.equal(a.session_id, 'danny-win-f1');
});

test('provenance: attribution validation rejects a non-sha and a missing session', () => {
  assert.equal(validateAttribution({ sha: 'zzz', session_id: 'x' }).ok, false);
  assert.equal(validateAttribution({ sha: '8b4403c' }).ok, false);
});

test('provenance: two sessions claiming one commit is surfaced, not resolved', () => {
  // c3a6313 was committed by one session and amended by another. Last-write
  // would silently pick a winner; this is a question for a person.
  const c = conflictingAttributions([
    attributeCommit({ sha: 'c3a6313', session_id: 'danny-win-51' }),
    attributeCommit({ sha: 'c3a6313', session_id: 'danny-win-f1' }),
    attributeCommit({ sha: '41a0b53', session_id: 'danny-win-10' }),
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0].sha, 'c3a6313');
  assert.deepEqual(c[0].sessions.sort(), ['danny-win-51', 'danny-win-f1']);
});

test('provenance: distinct commits are not reported as conflicting', () => {
  const c = conflictingAttributions([
    attributeCommit({ sha: '8b4403c', session_id: 'danny-win-f1' }),
    attributeCommit({ sha: '41a0b53', session_id: 'danny-win-10' }),
  ]);
  assert.deepEqual(c, []);
});

test('provenance: a branch summary names its sessions and its gaps', () => {
  // The real shape of code-c/messaging-gates: four commits, three sessions.
  const attributions = [
    attributeCommit({ sha: '8b4403c', session_id: 'danny-win-f1' }),
    attributeCommit({ sha: '7765d46', session_id: 'danny-win-51' }),
    attributeCommit({ sha: '6f1c664', session_id: 'danny-win-51' }),
    attributeCommit({ sha: '41a0b53', session_id: 'danny-win-10' }),
  ];
  const s = summariseProvenance(attributions, ['8b4403c', '7765d46', '6f1c664', '41a0b53']);
  assert.equal(s.commits, 4);
  assert.equal(s.attributed, 4);
  assert.deepEqual(s.sessions, ['danny-win-10', 'danny-win-51', 'danny-win-f1']);
  assert.deepEqual(s.unattributed, []);
});

test('provenance: an unattributed commit is named rather than ignored', () => {
  // Silent failure here would report a clean provenance trail with a hole in it.
  const s = summariseProvenance(
    [attributeCommit({ sha: 'aaaaaaa', session_id: 'danny-win-10' })],
    ['aaaaaaa', 'bbbbbbb'],
  );
  assert.equal(s.attributed, 1);
  assert.deepEqual(s.unattributed, ['bbbbbbb']);
});
