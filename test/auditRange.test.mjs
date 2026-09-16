import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRange,
  auditWithRange,
  formatAudit,
  RANGE_OK,
  STALE_BASE,
  UNRELATED_HISTORY,
  NO_HEAD,
} from '../src/auditRange.mjs';

/**
 * THE REAL CASE, AS A FIXTURE.
 *
 * d-orphan-modules: recorded base fa9d5dc, delegate branched from master
 * 8a4704d because the recorded base was five commits stale, returned 7599d27.
 * The old behaviour diffed fa9d5dc..7599d27 and reported 14 files with three
 * violations including bin/agentbridge.mjs forbidden. Twelve of those files are
 * the integrator's own commits. The delegate's commit touches two.
 *
 * Nothing here is invented. The graph below is the graph that happened.
 */

const BASE = 'fa9d5dc451c75d28bc083e9a59d6ee7c00a7ad79'; // contract base
const TIP = '8a4704d8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // integration tip when work started
const HEAD = '7599d27ce3b8cfe79c53f8317b8b09783e851f28'; // the delegate's commit
const UNRELATED = 'ffffffffffffffffffffffffffffffffffffffff';

const MINE = ['src/moduleGraph.mjs', 'test/noOrphanModules.test.mjs'];
const INTEGRATORS = [
  'bin/agentbridge.mjs',
  'src/hostedRegistry.mjs',
  'src/leadWork.mjs',
  'src/coordination.mjs',
  'mcp/tools.mjs',
  'mcp/toolDefs.mjs',
  'bridge/worker.mjs',
  'bridge/httpStore.mjs',
  'src/provenanceStore.mjs',
  'test/leadWork.test.mjs',
  'test/coordination.test.mjs',
  'test/hostedRegistry.test.mjs',
];

/** The real graph: BASE is an ancestor of TIP, which is an ancestor of HEAD. */
const git = {
  isAncestor: (a, b) => {
    if (a === b) return true;
    if (a === BASE && (b === TIP || b === HEAD)) return true;
    if (a === TIP && b === HEAD) return true;
    return false;
  },
  mergeBase: (a, b) => {
    if (a === UNRELATED || b === UNRELATED) return null;
    if (a === HEAD && b === TIP) return TIP;
    if (a === HEAD && b === HEAD) return HEAD;
    return TIP;
  },
  changedPathsBetween: (from, to) => {
    if (to !== HEAD) return [];
    if (from === TIP) return [...MINE];
    if (from === BASE) return [...INTEGRATORS, ...MINE];
    return [];
  },
};

const contract = {
  id: 'd-orphan-modules',
  base_sha: BASE,
  allowed_paths: ['test/noOrphanModules.test.mjs', 'src/moduleGraph.mjs'],
  forbidden_paths: ['bin/agentbridge.mjs', 'src/provenanceStore.mjs', 'mcp/**', 'bridge/**'],
};

/* ── the regression, stated as the numbers that actually happened ────── */

test('THE REAL CASE: the range is the branch point, and the delegate owns two files', () => {
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, git);
  assert.equal(v.effectiveBase, TIP);
  assert.deepEqual(v.changedPaths.sort(), [...MINE].sort());
  assert.deepEqual(v.violations, [], 'the delegate changed nothing outside the contract');
});

test('THE REAL CASE: the twelve misattributed files are named, not merely excluded', () => {
  /*
   * The number that proves the fix. Excluding them quietly would leave nobody
   * able to see that the old behaviour was wrong, or by how much.
   */
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, git);
  assert.equal(v.misattributed.length, 12);
  assert.ok(v.misattributed.includes('bin/agentbridge.mjs'));
  assert.match(v.reasons.join(' '), /would have blamed 12 file/);
});

test('THE OLD BEHAVIOUR IS REPRODUCED, so the regression is visible', () => {
  // Diffing from the recorded base is what produced 14 files and 3 violations.
  const all = git.changedPathsBetween(BASE, HEAD);
  assert.equal(all.length, 14);
  const wouldViolate = all.filter(
    (p) => p === 'bin/agentbridge.mjs' || p === 'src/provenanceStore.mjs' || p.startsWith('mcp/') || p.startsWith('bridge/'),
  );
  assert.ok(wouldViolate.length >= 3, 'the old range really did manufacture violations');
});

/* ── a stale base is REPORTED, never absorbed ────────────────────────── */

test('A STALE BASE REFUSES A CLEAN PASS even when the files are innocent', () => {
  /*
   * The third option, and the whole argument. Refusing outright means correct
   * work cannot be audited and the ledger learns nothing; auditing silently
   * against the wider range is what slandered the work. This reports no false
   * violations AND no silent pass.
   */
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, git);
  assert.equal(v.stale_base, true);
  assert.equal(v.ok, false, 'a stale base must not read as contract-held');
  assert.equal(v.status, STALE_BASE);
  assert.match(v.reasons[0], /stale/);
  assert.deepEqual(v.violations, [], 'and still no false violations');
});

test('NEAREST CLEAN: a base that IS the branch point passes cleanly', () => {
  const fresh = { ...contract, base_sha: TIP };
  const v = auditWithRange(fresh, { head: HEAD, integrationTip: TIP }, git);
  assert.equal(v.stale_base, false);
  assert.equal(v.ok, true);
  assert.equal(v.status, RANGE_OK);
  assert.deepEqual(v.misattributed, [], 'nothing to misattribute when the base is right');
});

test('a recorded base that is not an ancestor of head is the worse fault', () => {
  const wrong = { ...contract, base_sha: UNRELATED };
  const v = resolveRange({ recordedBase: UNRELATED, head: HEAD, integrationTip: TIP }, git);
  assert.equal(v.ok, false);
  assert.match(v.reasons[0], /NOT an ancestor/);
});

/* ── real violations still caught, in the correct range ──────────────── */

test('A GENUINE VIOLATION IS STILL CAUGHT once the range is right', () => {
  /*
   * The control that matters most. A range fix that stopped reporting real
   * breaches would be worse than the bug: it would make every audit pass.
   */
  const naughty = {
    ...git,
    changedPathsBetween: (from, to) =>
      from === TIP && to === HEAD ? [...MINE, 'bin/agentbridge.mjs'] : git.changedPathsBetween(from, to),
  };
  const v = auditWithRange({ ...contract, base_sha: TIP }, { head: HEAD, integrationTip: TIP }, naughty);
  assert.equal(v.ok, false);
  assert.deepEqual(v.violations, [{ path: 'bin/agentbridge.mjs', kind: 'forbidden' }]);
});

test('a file outside the allow-list is caught as outside-allowed', () => {
  const extra = {
    ...git,
    changedPathsBetween: (from, to) => (from === TIP && to === HEAD ? [...MINE, 'src/somethingElse.mjs'] : []),
  };
  const v = auditWithRange({ ...contract, base_sha: TIP }, { head: HEAD, integrationTip: TIP }, extra);
  assert.deepEqual(v.violations, [{ path: 'src/somethingElse.mjs', kind: 'outside-allowed' }]);
});

test('forbidden beats outside-allowed when a path is both', () => {
  const both = {
    ...git,
    changedPathsBetween: () => ['mcp/tools.mjs'],
  };
  const v = auditWithRange({ ...contract, base_sha: TIP }, { head: HEAD, integrationTip: TIP }, both);
  assert.equal(v.violations[0].kind, 'forbidden');
});

test('a ** glob spans separators, so a NESTED forbidden path is still caught', () => {
  /*
   * Found by a mutation that legitimately stayed green: every forbidden glob in
   * the fixtures — mcp/**, bridge/** — was only ever tested against a path one
   * level deep, which `[^/]*` matches just as well as `.*`. So nothing required
   * `**` to span separators at all, and narrowing it would have passed.
   *
   * It matters because the real contracts forbid whole trees. A delegate
   * editing bridge/routes/admin/handler.mjs must be caught by `bridge/**`, and
   * under the narrowed glob it would not have been.
   */
  const nested = { ...git, changedPathsBetween: () => ['bridge/routes/admin/handler.mjs'] };
  const v = auditWithRange({ ...contract, base_sha: TIP }, { head: HEAD, integrationTip: TIP }, nested);
  assert.deepEqual(v.violations, [{ path: 'bridge/routes/admin/handler.mjs', kind: 'forbidden' }]);
});

test('a single * does NOT span separators', () => {
  // The other direction, or `**` and `*` would be the same thing.
  const oneLevel = { ...contract, base_sha: TIP, allowed_paths: ['src/*.mjs'], forbidden_paths: [] };
  const g = { ...git, changedPathsBetween: () => ['src/deep/nested.mjs'] };
  const v = auditWithRange(oneLevel, { head: HEAD, integrationTip: TIP }, g);
  assert.deepEqual(v.violations, [{ path: 'src/deep/nested.mjs', kind: 'outside-allowed' }]);
});

test('a shared path is not a violation', () => {
  const withShared = { ...contract, base_sha: TIP, shared_paths: ['package.json'] };
  const g = { ...git, changedPathsBetween: () => ['package.json'] };
  const v = auditWithRange(withShared, { head: HEAD, integrationTip: TIP }, g);
  assert.deepEqual(v.violations, []);
});

/* ── histories that cannot be audited refuse rather than guess ───────── */

test('UNRELATED HISTORY REFUSES rather than diffing both trees', () => {
  /*
   * Falling back to the recorded base here would produce a confident diff
   * across unrelated histories: every file in both trees, reported as the
   * delegate's work.
   */
  const v = auditWithRange(contract, { head: UNRELATED, integrationTip: TIP }, git);
  assert.equal(v.ok, false);
  assert.equal(v.status, UNRELATED_HISTORY);
  assert.deepEqual(v.changedPaths, []);
  assert.match(v.reasons[0], /shares no history/);
});

test('no head at all refuses', () => {
  const v = auditWithRange(contract, { head: null, integrationTip: TIP }, git);
  assert.equal(v.status, NO_HEAD);
  assert.equal(v.ok, false);
});

/* ── purity and shape ────────────────────────────────────────────────── */

test('it performs no git calls of its own — every fact is injected', () => {
  // Called with NO git helpers at all, it must refuse rather than reach for a
  // repository. A module that shells out cannot be tested on the awkward cases.
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, {});
  assert.equal(v.ok, false);
  assert.equal(v.status, UNRELATED_HISTORY, 'no mergeBase supplied means it cannot know the range');
});

test('it never mutates the delegation or the range it is given', () => {
  const d = { ...contract };
  const r = { head: HEAD, integrationTip: TIP };
  const before = JSON.stringify([d, r]);
  auditWithRange(d, r, git);
  assert.equal(JSON.stringify([d, r]), before);
});

test('the verdict separates violations from misattribution', () => {
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, git);
  assert.ok(Array.isArray(v.violations));
  assert.ok(Array.isArray(v.misattributed));
  assert.equal(v.violations.length, 0);
  assert.equal(v.misattributed.length, 12);
});

test('the rendered report names the base substitution', () => {
  const v = auditWithRange(contract, { head: HEAD, integrationTip: TIP }, git);
  const text = formatAudit(v);
  assert.match(text, /recorded base .* -> effective/);
  assert.match(text, /stale/);
});

test('resolveRange reports the branch point as the effective base', () => {
  const r = resolveRange({ recordedBase: BASE, head: HEAD, integrationTip: TIP }, git);
  assert.equal(r.effectiveBase, TIP);
  assert.equal(r.recordedBase, BASE);
});

test('a contract with no recorded base is not treated as stale', () => {
  // Self-directed work carries no contract base; that is not a defect.
  const r = resolveRange({ recordedBase: null, head: HEAD, integrationTip: TIP }, git);
  assert.equal(r.stale_base, false);
  assert.equal(r.ok, true);
});
