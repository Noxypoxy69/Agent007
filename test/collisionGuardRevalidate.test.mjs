import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaneRegistry } from '../src/laneRegistry.mjs';
import { revalidateStart, evaluateCommit, EXIT_ALLOW } from '../src/collisionGuard.mjs';

/**
 * START-TIME REVALIDATION — the check assignment-time cannot be.
 *
 * evaluateCommit runs at commit, on PATHS, and has no notion of a lease, an
 * attempt or a baseline. revalidateStart runs the instant before mutation work
 * begins and revalidates the same tuple the terminal write fences on. Every
 * blocking case here has a silent twin: the nearest state differing in ONE field
 * that must stay OK, so a version of the guard that refuses every start fails
 * this suite instead of passing it (a start-guard nobody can pass gets removed,
 * which is worse than none).
 */

const REG = parseLaneRegistry(`
lanes:
  - lane_id: messaging
    owned_paths:
      - "src/lib/reply/**"
  - lane_id: onboarding
    owned_paths:
      - "src/lib/merchantPhone.server.ts"
`);

const FUTURE = '2026-09-20T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const NOW = '2026-09-19T00:00:00.000Z';
const SHA = 'a'.repeat(40);

const liveTask = (over = {}) => ({
  lease_token: 'tok-1',
  lease_expires_at: FUTURE,
  assigned_session: 'sess-a',
  attempt: 3,
  base_sha: SHA,
  state: 'assigned',
  ...over,
});
const AUTHORISED = Object.freeze({
  leaseToken: 'tok-1', session: 'sess-a', attempt: 3, baseSha: SHA, state: 'assigned',
});

const good = (over = {}) => revalidateStart({
  task: liveTask(),
  expected: AUTHORISED,
  reservedPaths: ['src/lib/reply/x.ts'],
  registry: REG,
  laneId: 'messaging',
  now: NOW,
  ...over,
});
const hasRule = (r, rule) => r.findings.some((f) => f.rule === rule);

/* ── the positive control: a still-current claim starts ─────────────────── */

test('POSITIVE: a claim whose lease, token, session, attempt, baseline, state and paths are all current is OK', () => {
  const r = good();
  assert.equal(r.ok, true, `a current claim was refused: ${r.findings.map((f) => f.rule).join(', ')}`);
  assert.equal(r.stale, false);
  assert.equal(r.findings.length, 0);
});

/* ── one field stale at a time; each is a real reassign/expiry/move ─────── */

test('an expired lease is STALE', () => {
  const r = good({ task: liveTask({ lease_expires_at: PAST }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'lease'));
});

test('a missing now fails CLOSED (leaseState throws; not-live, never a throw past the caller)', () => {
  const r = good({ now: null });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'lease'));
});

test('a superseded lease token is STALE (re-assigned under a new token)', () => {
  const r = good({ task: liveTask({ lease_token: 'tok-2' }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'lease-token'));
});

test('a task re-assigned to another session is STALE', () => {
  const r = good({ task: liveTask({ assigned_session: 'sess-b' }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'session'));
});

test('a superseding attempt is STALE', () => {
  const r = good({ task: liveTask({ attempt: 4 }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'attempt'));
});

test('a moved baseline is STALE (workspace would sit on a different commit)', () => {
  const r = good({ task: liveTask({ base_sha: 'b'.repeat(40) }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'baseline'));
});

test('a changed task state (superseded or terminal) is STALE', () => {
  const r = good({ task: liveTask({ state: 'done' }) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'state'));
});

test('a reserved path now owned by another lane is STALE, and names the new owner', () => {
  const r = good({ reservedPaths: ['src/lib/merchantPhone.server.ts'] });
  assert.equal(r.ok, false);
  const f = r.findings.find((x) => x.rule === 'reservation');
  assert.ok(f, 'the lost reservation must be reported');
  assert.deepEqual(f.owners, ['onboarding']);
});

/* ── fail-closed on unknowable state ────────────────────────────────────── */

test('an unreadable task fails CLOSED', () => {
  const r = revalidateStart({ task: null, expected: AUTHORISED, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'task'));
});

test('a missing authorised tuple fails CLOSED', () => {
  const r = revalidateStart({ task: liveTask(), expected: null, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'expected'));
});

/* ── the audit's fail-OPEN, closed: an empty AUTHORISED FIELD is STALE, not skipped ── */

test('AUDIT D2 REGRESSION: an all-empty authorised tuple does NOT clear a fully re-assigned terminal task', () => {
  // The exact input the blind audit traced to ok:true before the fix.
  const r = revalidateStart({
    task: liveTask({ lease_token: 'tok-99', assigned_session: 'sess-EVIL', attempt: 99, base_sha: 'b'.repeat(40), state: 'done' }),
    expected: { leaseToken: '', session: '', attempt: null, baseSha: '', state: '' },
    reservedPaths: [],
    registry: REG, laneId: 'messaging', now: NOW,
  });
  assert.equal(r.ok, false, 'an empty authorised tuple must never clear a reassigned terminal task');
});

test('an empty expected lease token is STALE, not skipped', () => {
  const r = good({ expected: { ...AUTHORISED, leaseToken: '' } });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'lease-token'));
});

test('an empty expected session is STALE, not skipped', () => {
  const r = good({ expected: { ...AUTHORISED, session: '' } });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'session'));
});

test('a null expected attempt is STALE, not skipped', () => {
  const r = good({ expected: { ...AUTHORISED, attempt: null } });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'attempt'));
});

test('AUDIT D3 REGRESSION: reserved paths with no registry fail CLOSED, not skipped', () => {
  const r = good({ reservedPaths: ['src/lib/reply/x.ts'], registry: null });
  assert.equal(r.ok, false, 'an unverifiable reservation must not read as current');
  assert.ok(hasRule(r, 'reservation'));
});

test('AUDIT D-A REGRESSION: reservedPaths as a STRING fails CLOSED (no char-by-char iteration passing a foreign path)', () => {
  // A bare string has a .length; the old loop iterated it character by character,
  // every char UNCLAIMED, so a foreign path passed as a string read as still-held.
  const r = good({ reservedPaths: 'src/lib/merchantPhone.server.ts' });
  assert.equal(r.ok, false, 'a string reservedPaths must not read as current');
  assert.ok(hasRule(r, 'reservation'));
});

test('AUDIT D-A REGRESSION: an empty or non-string reserved entry fails CLOSED', () => {
  assert.equal(good({ reservedPaths: [''] }).ok, false, 'an empty reserved entry is not confirmable');
  assert.equal(good({ reservedPaths: [null] }).ok, false, 'a null reserved entry is not confirmable');
  assert.ok(hasRule(good({ reservedPaths: [123] }), 'reservation'), 'a non-string reserved entry is STALE');
});

/* ── D-B: epoch-ms now is accepted, so the natural Date.now() caller is not refused ── */

test('AUDIT D-B: a current claim with an epoch-ms now (Date.now() shape) is OK, not refused', () => {
  const r = good({ now: Date.parse(NOW) }); // a finite number, the shape Date.now() returns
  assert.equal(r.ok, true, `a current claim with a numeric now was wrongly refused: ${r.findings.map((f) => f.rule).join(', ')}`);
});

test('AUDIT D-B: an expired lease with an epoch-ms now is still STALE', () => {
  const r = good({ task: liveTask({ lease_expires_at: PAST }), now: Date.parse(NOW) });
  assert.equal(r.ok, false);
  assert.ok(hasRule(r, 'lease'));
});

/* ── the gap this closes: the commit guard cannot see a stale claim ─────── */

test('THE GAP: evaluateCommit (path-only) passes a clean commit while the claim is already stale; revalidateStart catches it', () => {
  // A commit that touches only an owned path is ALLOW at commit time...
  const commit = evaluateCommit({
    registry: REG, registryError: null, laneId: 'messaging',
    branch: null, worktree: null, stagedPaths: ['src/lib/reply/x.ts'], strictShared: false,
  });
  assert.equal(commit.exitCode, EXIT_ALLOW, 'precondition: the commit-time guard sees nothing wrong with the paths');
  // ...but the very same situation with an expired lease must be refused BEFORE work starts.
  const start = good({ task: liveTask({ lease_expires_at: PAST }) });
  assert.equal(start.ok, false, 'the start-time guard must catch the stale claim the commit guard structurally cannot');
});

/* ── rule 1, held: one of each verdict from the real function ───────────── */

test('CONTROL: the function produces both verdicts, so the suite can actually fail', () => {
  assert.equal(good().ok, true, 'the guard refuses every start');
  assert.equal(good({ task: liveTask({ lease_token: 'tok-2' }) }).ok, false, 'the guard allows every start');
});
