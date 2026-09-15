import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOwnerDecision, activeDecisions, validateDecision, createDecision,
  revokeDecision, capabilityMatches, SCOPE_PRECEDENCE,
} from '../src/ownerDecisions.mjs';

/**
 * THE OWNER DECISION LEDGER — the eleven proofs the feature was specified with.
 *
 * The product promise is "tell your AI team once": a builder states a rule and
 * every worker, including workers that join later, inherits it without asking
 * again. The risk that comes free with that promise is the reason most of this
 * file exists -- a ledger that remembers authority too GENEROUSLY is worse than
 * no ledger, because the builder believes they are being asked and they are
 * not.
 *
 * So the widening cases are tested harder than the happy path. "Deploy staging
 * for task-123" must never become "agents may deploy production", and that is
 * not one check but several: the action must not widen, the scope must not
 * widen, and a decision must not outlive its revocation.
 */

const OWNER = 'danny';
const T0 = '2026-09-15T06:00:00.000Z';

/** Build a valid decision without repeating the whole shape each time. */
const decide = (over = {}) => createDecision({
  decision_id: 'd1',
  owner_id: OWNER,
  statement: 'a rule the builder stated',
  scope_type: 'bridge',
  effect: 'allow',
  capabilities: ['build'],
  created_by: OWNER,
  created_at: T0,
  ...over,
});

// ── proof 1 ────────────────────────────────────────────────────────────────
test('five workers asking the same approved question produce ZERO owner questions', () => {
  // The product promise, stated as a test. Five separate workers, five separate
  // sessions, one decision.
  const ledger = [decide({
    decision_id: 'd-lane-work',
    statement: 'Agents may build/test/commit inside delegated lanes.',
    scope_type: 'bridge',
    effect: 'allow',
    capabilities: ['build', 'test', 'commit'],
  })];

  const workers = ['code-a', 'code-b', 'code-c', 'code-d', 'code-e'];
  const asks = workers.map(() => resolveOwnerDecision(ledger, 'commit', { repo: 'agentbridge' }));

  assert.equal(asks.filter((r) => r.outcome === 'no_decision').length, 0,
    'a worker would have gone to the builder with a question already answered');
  assert.ok(asks.every((r) => r.outcome === 'allowed'));
  // Every worker must cite the SAME decision, or the builder cannot tell that
  // five agents are acting on one instruction.
  assert.equal(new Set(asks.map((r) => r.decision_id)).size, 1);
  assert.equal(asks[0].decision_id, 'd-lane-work');
});

// ── proof 2 ────────────────────────────────────────────────────────────────
test('a worker joining LATER inherits decisions made before it existed', () => {
  // Nothing about resolution is per-worker, which is the point: there is no
  // registration step a new agent can miss.
  const ledger = [decide({ decision_id: 'd-old', capabilities: ['test'], effect: 'allow' })];
  const latecomer = resolveOwnerDecision(ledger, 'test', { repo: 'agentbridge' });
  assert.equal(latecomer.outcome, 'allowed');
  assert.equal(latecomer.decision_id, 'd-old');
});

// ── proof 3 ────────────────────────────────────────────────────────────────
test('a task-scoped approval CANNOT leak to another task', () => {
  // "Danny approving `deploy staging for task-123` must not become
  //  `agents may deploy production`" -- the narrow-to-broad leak, which is the
  // single most dangerous failure this ledger could have.
  const ledger = [decide({
    decision_id: 'd-staging-123',
    statement: 'Deploy staging for task-123.',
    scope_type: 'task',
    scope_id: 'task-123',
    effect: 'allow',
    capabilities: ['deploy.staging'],
  })];

  assert.equal(resolveOwnerDecision(ledger, 'deploy.staging', { task: 'task-123' }).outcome, 'allowed');

  // A different task is a different decision.
  assert.equal(resolveOwnerDecision(ledger, 'deploy.staging', { task: 'task-124' }).outcome, 'no_decision');
  // No task context at all must not match a task-scoped grant.
  assert.equal(resolveOwnerDecision(ledger, 'deploy.staging', { repo: 'agentbridge' }).outcome, 'no_decision');
  // And the action must not widen: staging is not production.
  assert.equal(resolveOwnerDecision(ledger, 'deploy.production', { task: 'task-123' }).outcome, 'no_decision');
});

// ── proof 4 ────────────────────────────────────────────────────────────────
test('a repo-scoped rule applies to every worker in that repo', () => {
  const ledger = [decide({
    decision_id: 'd-seed',
    statement: 'Seed data stays.',
    scope_type: 'repo',
    scope_id: 'social-sparks-app',
    effect: 'deny',
    capabilities: ['data.delete'],
  })];

  for (const lane of ['messaging', 'booking', 'voice']) {
    const r = resolveOwnerDecision(ledger, 'data.delete', { repo: 'social-sparks-app', lane });
    assert.equal(r.outcome, 'denied', `lane ${lane} escaped a repo-scoped rule`);
    assert.equal(r.matched_scope, 'repo');
  }
  // A different repo is untouched by it.
  assert.equal(resolveOwnerDecision(ledger, 'data.delete', { repo: 'agentbridge' }).outcome, 'no_decision');
});

// ── proof 5 ────────────────────────────────────────────────────────────────
test('an explicit deny beats a broader allow', () => {
  const ledger = [
    decide({ decision_id: 'd-broad', scope_type: 'bridge', effect: 'allow', capabilities: ['deploy.*'] }),
    decide({ decision_id: 'd-narrow', scope_type: 'repo', scope_id: 'social-sparks-app',
             effect: 'deny', capabilities: ['deploy.production'] }),
  ];

  const r = resolveOwnerDecision(ledger, 'deploy.production', { repo: 'social-sparks-app' });
  assert.equal(r.outcome, 'denied');
  assert.equal(r.matched_scope, 'repo');
  assert.equal(r.decision_id, 'd-narrow');

  // The broad allow still governs where the narrow deny does not reach.
  assert.equal(resolveOwnerDecision(ledger, 'deploy.production', { repo: 'agentbridge' }).outcome, 'allowed');
});

test('precedence is strictly task > lane > repo > project > bridge', () => {
  assert.deepEqual(
    Object.entries(SCOPE_PRECEDENCE).sort((a, b) => a[1] - b[1]).map(([k]) => k),
    ['bridge', 'project', 'repo', 'lane', 'task'],
  );

  // Built bottom-up so each narrower scope must actually override the last.
  const ledger = [
    decide({ decision_id: 'd-bridge', scope_type: 'bridge', effect: 'deny', capabilities: ['x'] }),
    decide({ decision_id: 'd-project', scope_type: 'project', scope_id: 'wl', effect: 'allow', capabilities: ['x'] }),
    decide({ decision_id: 'd-repo', scope_type: 'repo', scope_id: 'app', effect: 'deny', capabilities: ['x'] }),
    decide({ decision_id: 'd-lane', scope_type: 'lane', scope_id: 'voice', effect: 'allow', capabilities: ['x'] }),
    decide({ decision_id: 'd-task', scope_type: 'task', scope_id: 't1', effect: 'deny', capabilities: ['x'] }),
  ];
  const ctx = { project: 'wl', repo: 'app', lane: 'voice', task: 't1' };

  assert.equal(resolveOwnerDecision(ledger, 'x', ctx).decision_id, 'd-task');
  assert.equal(resolveOwnerDecision(ledger, 'x', { ...ctx, task: null }).decision_id, 'd-lane');
  assert.equal(resolveOwnerDecision(ledger, 'x', { ...ctx, task: null, lane: null }).decision_id, 'd-repo');
  assert.equal(resolveOwnerDecision(ledger, 'x', { project: 'wl' }).decision_id, 'd-project');
  assert.equal(resolveOwnerDecision(ledger, 'x', {}).decision_id, 'd-bridge');
});

// ── proof 6 ────────────────────────────────────────────────────────────────
test('a revoked decision stops applying immediately', () => {
  const original = decide({ decision_id: 'd-rev', effect: 'allow', capabilities: ['deploy.staging'] });
  assert.equal(resolveOwnerDecision([original], 'deploy.staging', {}).outcome, 'allowed');

  const r = revokeDecision(original, { at: '2026-09-15T07:00:00.000Z', by: OWNER, reason: 'no longer true' });
  assert.ok(r.ok, r.errors?.join('; '));
  assert.equal(resolveOwnerDecision([r.record], 'deploy.staging', {}).outcome, 'no_decision');

  // And the record is still there, with the original words intact.
  assert.equal(r.record.statement, original.statement);
  assert.equal(r.record.created_at, T0);
  assert.equal(r.record.revoked_by, OWNER);
  assert.deepEqual(r.record.history.map((h) => h.event), ['created', 'revoked']);
});

test('a worker cannot revoke the owner\'s decision', () => {
  const original = decide({ decision_id: 'd-rev2' });
  const r = revokeDecision(original, { at: T0, by: 'code-b' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /not the owner/);
});

// ── proof 7 ────────────────────────────────────────────────────────────────
test('a superseded decision stops applying but stays visible', () => {
  const old = decide({
    decision_id: 'd-v1', statement: 'Agents may deploy staging.',
    effect: 'allow', capabilities: ['deploy.staging'],
  });
  const replacement = decide({
    decision_id: 'd-v2', statement: 'Staging deploys now need me too.',
    effect: 'require_owner', capabilities: ['deploy.staging'],
    created_at: '2026-09-15T08:00:00.000Z', supersedes: 'd-v1',
  });
  const ledger = [old, replacement];

  assert.equal(resolveOwnerDecision(ledger, 'deploy.staging', {}).outcome, 'owner_required');

  // The superseded one is not active...
  const liveIds = activeDecisions(ledger).map((d) => d.decision_id);
  assert.deepEqual(liveIds, ['d-v2']);
  // ...but it is still in the ledger, unedited. The builder must always be able
  // to see what they originally said and what changed it.
  assert.equal(ledger.find((d) => d.decision_id === 'd-v1').statement, 'Agents may deploy staging.');
});

test('revoking a replacement does not resurrect what it replaced', () => {
  // Only a LIVE decision supersedes. Otherwise revoking d-v2 would leave d-v1
  // dead too and the builder would be governed by nothing, while the ledger
  // showed two perfectly good records.
  const old = decide({ decision_id: 'd-v1', effect: 'allow', capabilities: ['x'] });
  // Revoke through the real path. createDecision pins revoked_at to null on
  // purpose -- a decision cannot be born revoked -- so passing it as a field
  // silently does nothing, which is how the first draft of this test "passed"
  // against a replacement that was never actually revoked.
  const made = decide({
    decision_id: 'd-v2', effect: 'deny', capabilities: ['x'],
    created_at: '2026-09-15T08:00:00.000Z', supersedes: 'd-v1',
  });
  const revoked = revokeDecision(made, { at: '2026-09-15T09:00:00.000Z', by: OWNER });
  assert.ok(revoked.ok, revoked.errors?.join('; '));
  assert.ok(revoked.record.revoked_at, 'the fixture did not actually revoke anything');

  assert.deepEqual(activeDecisions([old, revoked.record]).map((d) => d.decision_id), ['d-v1']);
});

// ── proof 8 ────────────────────────────────────────────────────────────────
test('a stale or offline worker cannot fabricate a decision', () => {
  // Forgery is a validation failure, not a weaker decision. A record naming a
  // worker as its author is excluded from resolution entirely.
  const forged = {
    ...decide({ decision_id: 'd-forged', effect: 'allow', capabilities: ['deploy.production'] }),
    created_by: 'code-b-offline',
  };
  const v = validateDecision(forged);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /cannot record a decision on the owner's behalf/);

  // And it must not resolve — an invalid record is not "best effort".
  assert.equal(resolveOwnerDecision([forged], 'deploy.production', {}).outcome, 'no_decision');
});

// ── proof 9 ────────────────────────────────────────────────────────────────
test('a worker cannot write an owner decision on the owner\'s behalf', () => {
  // The same rule from the authoring side: created_by must BE owner_id.
  assert.equal(validateDecision(decide({ created_by: OWNER })).ok, true);
  assert.equal(validateDecision(decide({ created_by: 'code-c' })).ok, false);
});

// ── proof 10 ───────────────────────────────────────────────────────────────
test('malformed or ambiguous decisions FAIL CLOSED', () => {
  // (a) A keyed scope with no scope_id would otherwise apply everywhere.
  assert.equal(validateDecision(decide({ scope_type: 'repo', scope_id: null })).ok, false);

  // (b) A decision with no capabilities is a decision about nothing, which must
  //     not read as a decision about everything.
  assert.equal(validateDecision(decide({ capabilities: [] })).ok, false);

  // (c) Junk in the ledger is skipped, not interpreted.
  const junk = [null, 42, {}, { decision_id: 'x' }];
  assert.deepEqual(activeDecisions(junk), []);
  assert.equal(resolveOwnerDecision(junk, 'anything', {}).outcome, 'no_decision');

  // (d) An unclassified action escalates rather than resolving to allowed.
  const ledger = [decide({ effect: 'allow', capabilities: ['*'] })];
  assert.equal(resolveOwnerDecision(ledger, '', {}).outcome, 'owner_required');
  assert.equal(resolveOwnerDecision(ledger, null, {}).outcome, 'owner_required');

  // (e) Two decisions CONFLICTING at the same scope escalate to the owner. The
  //     strictest is not picked silently: that would hide a contradiction the
  //     builder is the only one who can resolve.
  const conflict = [
    decide({ decision_id: 'd-yes', scope_type: 'repo', scope_id: 'app', effect: 'allow', capabilities: ['x'] }),
    decide({ decision_id: 'd-no', scope_type: 'repo', scope_id: 'app', effect: 'deny', capabilities: ['x'] }),
  ];
  const r = resolveOwnerDecision(conflict, 'x', { repo: 'app' });
  assert.equal(r.outcome, 'owner_required');
  assert.match(r.reason, /conflicting decisions/);
  assert.deepEqual(r.candidates.sort(), ['d-no', 'd-yes']);
});

test('capability matching never widens an approval', () => {
  assert.equal(capabilityMatches('deploy.production', 'deploy.production'), true);
  assert.equal(capabilityMatches('deploy.*', 'deploy.production'), true);
  assert.equal(capabilityMatches('*', 'anything.at.all'), true);

  // The widenings that must NOT happen:
  assert.equal(capabilityMatches('deploy.staging', 'deploy.production'), false);
  assert.equal(capabilityMatches('deploy', 'deploy.production'), false,
    'a bare capability must not act as a prefix wildcard');
  assert.equal(capabilityMatches('deploy.*', 'deployment.teardown'), false,
    'the dot must be a segment boundary, not a character');
  assert.equal(capabilityMatches('deploy.production', 'deploy'), false);
});

// ── the owner's four worked examples ───────────────────────────────────────
test('the builder\'s own four examples resolve as stated', () => {
  const ledger = [
    decide({ decision_id: 'd-lanes', statement: 'Agents may build/test/commit inside delegated lanes.',
             scope_type: 'bridge', effect: 'allow', capabilities: ['build', 'test', 'commit'] }),
    decide({ decision_id: 'd-prod', statement: 'Never deploy production without Danny.',
             scope_type: 'project', scope_id: 'werelocal', effect: 'require_owner',
             capabilities: ['deploy.production'] }),
    decide({ decision_id: 'd-seed', statement: 'Seed data stays.',
             scope_type: 'repo', scope_id: 'social-sparks-app', effect: 'deny',
             capabilities: ['data.delete'] }),
    decide({ decision_id: 'd-money', statement: 'Do not spend money without owner approval.',
             scope_type: 'bridge', effect: 'require_owner', capabilities: ['spend.*'] }),
  ];

  assert.equal(resolveOwnerDecision(ledger, 'commit', { repo: 'agentbridge' }).outcome, 'allowed');
  assert.equal(resolveOwnerDecision(ledger, 'deploy.production', { project: 'werelocal' }).outcome, 'owner_required');
  assert.equal(resolveOwnerDecision(ledger, 'data.delete', { repo: 'social-sparks-app' }).outcome, 'denied');
  assert.equal(resolveOwnerDecision(ledger, 'spend.cloudflare', {}).outcome, 'owner_required');

  // And the one that must still reach the builder, because nothing covers it.
  assert.equal(resolveOwnerDecision(ledger, 'rotate.credentials', {}).outcome, 'no_decision');
});

test('the result carries what a worker needs to explain itself', () => {
  const ledger = [decide({
    decision_id: 'd-cap', statement: 'Do not spend money without owner approval.',
    scope_type: 'bridge', effect: 'require_owner', capabilities: ['spend.*'],
    constraints: { max_usd: 0 },
  })];
  const r = resolveOwnerDecision(ledger, 'spend.cloudflare', {});
  assert.equal(r.decision_id, 'd-cap');
  assert.equal(r.matched_scope, 'bridge');
  assert.deepEqual(r.constraints, { max_usd: 0 });
  assert.match(r.reason, /Do not spend money/);
});
