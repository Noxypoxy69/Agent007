/* Auditor probe. Not part of the audited work. */
import assert from 'node:assert/strict';
import {
  validateDecision, activeDecisions, resolveOwnerDecision, createDecision,
  isOwnerId, OWNER_IDS, revokeDecision,
} from '../src/ownerDecisions.mjs';
import {
  validateDecision as hValidate,
  activeDecisions as hActive,
  resolveOwnerDecision as hResolve,
  isOwnerId as hIsOwnerId,
  OWNER_IDS as H_OWNER_IDS,
  ACTORS as H_ACTORS,
} from '../supabase/functions/mcp/_shared.js';
import { ACTORS } from '../src/coordination.mjs';
import { classifyRequest, DECIDER } from '../src/permissionRequest.mjs';

const AT = '2026-09-18T19:00:00.000Z';
const line = (t) => console.log(t);

const dec = (o) => ({
  decision_id: 'd-x', owner_id: 'danny', decision_type: 'policy',
  statement: 'statement', scope_type: 'bridge', scope_id: null,
  effect: 'allow', capabilities: ['*'], constraints: null,
  created_at: AT, created_by: 'danny', supersedes: null, revoked_at: null, ...o,
});

line('=== 0. SANITY: module loaded, positive works ===');
line('  valid danny decision ok? ' + validateDecision(dec({})).ok);
line('  resolves? ' + resolveOwnerDecision([dec({})], 'deploy.production').outcome);

line('');
line('=== 1. SUPERSEDE RESURRECTION (claim 4: "a dropped decision fails SAFE") ===');
{
  // A real owner decision that ALLOWS everything, bridge-wide.
  const old = dec({ decision_id: 'd-old', effect: 'allow', capabilities: ['*'], created_at: '2026-09-16T00:00:00Z' });
  // Its replacement, which DENIES. Written under the name "main" -- exactly the
  // shape the commit message says is really in the production ledger.
  const repl = dec({
    decision_id: 'd-new', owner_id: 'main', created_by: 'main',
    effect: 'deny', capabilities: ['*'], supersedes: 'd-old',
    created_at: '2026-09-17T00:00:00Z',
  });
  const rows = [old, repl];

  // PARENT-EQUIVALENT: before f7ae118, "main" validated, so it superseded d-old.
  const parentOwners = ['danny', 'owner', 'main'];
  const before = resolveOwnerDecision(rows, 'deploy.production', {}, { owners: parentOwners });
  const after = resolveOwnerDecision(rows, 'deploy.production');
  line('  parent-equivalent (main counts as an owner): outcome=' + before.outcome + ' via ' + before.decision_id);
  line('  tip (main is refused):                       outcome=' + after.outcome + ' via ' + after.decision_id);
  line('  active ids parent: ' + JSON.stringify(activeDecisions(rows, { owners: parentOwners }).map((d) => d.decision_id)));
  line('  active ids tip:    ' + JSON.stringify(activeDecisions(rows).map((d) => d.decision_id)));
  line('  >>> RESURRECTION: ' + (before.outcome === 'denied' && after.outcome === 'allowed'
    ? 'YES - dropping the invalid row UN-superseded an older ALLOW. FAIL OPEN.'
    : 'no'));
  line('  hosted surface same? ' + (hResolve(rows, 'deploy.production').outcome === after.outcome));
}

line('');
line('=== 1b. Same thing through classifyRequest (the call settleOpenRequests makes) ===');
{
  const old = dec({ decision_id: 'd-old', effect: 'allow', capabilities: ['deploy.*'], created_at: '2026-09-16T00:00:00Z' });
  const repl = dec({
    decision_id: 'd-new', owner_id: 'main', created_by: 'main',
    effect: 'deny', capabilities: ['deploy.*'], supersedes: 'd-old',
    created_at: '2026-09-17T00:00:00Z',
  });
  const v = classifyRequest({ action: 'deploy.production' }, [old, repl], { now: AT });
  line('  decider=' + v.decider + ' allowed=' + v.allowed + ' via ' + v.decision_id);
  line('  >>> ' + (v.decider === DECIDER.POLICY && v.allowed === true
    ? 'settleOpenRequestsAgainstPolicy would AUTO-CLOSE deploy.production as ALLOWED'
    : 'not auto-allowed'));
}

line('');
line('=== 2. revokeDecision still compares the record against itself ===');
{
  const mainRow = dec({ decision_id: 'd-main', owner_id: 'main', created_by: 'main' });
  const r = revokeDecision(mainRow, { at: AT, by: 'main' });
  line('  revokeDecision(owner_id=main, by=main).ok = ' + r.ok + '  <-- no isOwnerId anywhere');
  const alias = revokeDecision(dec({}), { at: AT, by: 'owner' });
  line('  owner alias may revoke a "danny" decision? ' + alias.ok + '  errors=' + JSON.stringify(alias.errors || []));
  const dannyRevokesOwner = revokeDecision(dec({ owner_id: 'owner', created_by: 'owner' }), { at: AT, by: 'danny' });
  line('  "danny" may revoke an "owner"-authored decision? ' + dannyRevokesOwner.ok);
}

line('');
line('=== 3. Case / whitespace: validate is lenient, created_by is strict ===');
for (const [oid, cby] of [['danny', 'danny'], ['DANNY', 'danny'], ['owner', 'danny'],
  ['danny', 'owner'], ['  danny  ', 'danny'], ['Danny', 'Danny'], ['danny\n', 'danny\n']]) {
  const v = validateDecision(dec({ owner_id: oid, created_by: cby }));
  line(`  owner_id=${JSON.stringify(oid)} created_by=${JSON.stringify(cby)} -> ok=${v.ok}` +
    (v.ok ? '' : '  [' + v.errors.join(' | ') + ']'));
}

line('');
line('=== 4. Unicode / homoglyph / normalisation ===');
for (const s of ['danny', 'DANNY', 'Ｄａｎｎｙ', 'dаnny' /* Cyrillic a */, 'danny​',
  'ＯＷＮＥＲ', 'DANNİ', 'DANNYİ', 'ⅾanny', 'danny ', 'ＤＡＮＮＹ'.normalize('NFKC')]) {
  line(`  isOwnerId(${JSON.stringify(s)}) = ${isOwnerId(s)}   codepoints=${[...s].map((c) => c.codePointAt(0).toString(16)).join(',')}`);
}

line('');
line('=== 5. Roster drift: is the HOSTED ACTORS copy in the chain? ===');
{
  const ownersOf = (roster) => roster.filter((a) => a.actor_type === 'owner')
    .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])]).map((s) => s.toLowerCase()).sort();
  line('  src ACTORS owners:    ' + JSON.stringify(ownersOf(ACTORS)));
  line('  hosted ACTORS owners: ' + JSON.stringify(ownersOf(H_ACTORS)));
  line('  OWNER_IDS:            ' + JSON.stringify([...OWNER_IDS]));
  line('  HOSTED_OWNER_IDS:     ' + JSON.stringify([...H_OWNER_IDS]));
}

line('');
line('=== 6. Is OWNER_IDS actually immune to mutation? (Object.freeze on an array) ===');
{
  const before = [...OWNER_IDS];
  try { OWNER_IDS.push('c8'); } catch (e) { line('  push threw: ' + e.constructor.name); }
  line('  after push attempt: ' + JSON.stringify([...OWNER_IDS]) + ' (was ' + JSON.stringify(before) + ')');
  // But the `owners` ARGUMENT is not frozen and is caller-controlled:
  line('  validateDecision(c8 record, {owners:["c8"]}).ok = '
    + validateDecision(dec({ owner_id: 'c8', created_by: 'c8' }), { owners: ['c8'] }).ok);
}

line('');
line('=== 7. What legitimate shapes does the read path now DROP? ===');
{
  const shapes = {
    'owner_id absent': dec({ owner_id: undefined }),
    'owner_id "main"': dec({ owner_id: 'main', created_by: 'main' }),
    'owner_id "chatgpt"': dec({ owner_id: 'chatgpt', created_by: 'chatgpt' }),
    'owner_id "Danny" created_by "danny"': dec({ owner_id: 'Danny' }),
    'owner_id "owner" created_by "danny"': dec({ owner_id: 'owner' }),
    'owner_id "danny" created_by "c8"': dec({ created_by: 'c8' }),
  };
  for (const [k, v] of Object.entries(shapes)) {
    line(`  ${k.padEnd(40)} -> ${validateDecision(v).ok ? 'KEPT' : 'DROPPED'}`);
  }
}

line('');
line('=== 8. deny/require_owner rows dropped => does anything open? ===');
{
  // A standing DENY written under "main", alone in the ledger.
  const denyRow = dec({ decision_id: 'd-deny', owner_id: 'main', created_by: 'main', effect: 'deny' });
  const v = classifyRequest({ action: 'deploy.production', reversible: false }, [denyRow], { now: AT });
  line('  deploy.production with only a dropped DENY: decider=' + v.decider + ' allowed=' + v.allowed);
  const v2 = classifyRequest({ action: 'status.read', reversible: true }, [denyRow], { now: AT });
  line('  a REVERSIBLE action with only a dropped DENY: decider=' + v2.decider);
  line('  >>> ' + (v2.decider === DECIDER.COORDINATOR
    ? 'a standing owner DENY that is dropped becomes COORDINATOR-approvable'
    : 'still owner'));
}

line('');
line('=== 9. The test file\'s own coverage of the supersede branch ===');
{
  // Reproduce exactly what test/ownerIdentityAnchored.test.mjs asserts for the
  // production row, then add the predecessor it names.
  const live = {
    decision_id: 'd-review-ruling-t-wire-gate-scripts-corrected-20260917',
    owner_id: 'main', decision_type: 'policy',
    statement: 'a review ruling recorded under the name "main"',
    scope_type: 'repo', scope_id: 'agentbridge', effect: 'allow',
    capabilities: ['review.accept'], constraints: {},
    created_at: '2026-09-17T10:14:57.766636+00:00', created_by: 'main',
    supersedes: 'd-review-ruling-t-wire-gate-scripts-20260917', revoked_at: null,
  };
  const predecessor = dec({
    decision_id: 'd-review-ruling-t-wire-gate-scripts-20260917',
    scope_type: 'repo', scope_id: 'agentbridge', effect: 'allow',
    capabilities: ['review.accept', 'review.reject'],
    created_at: '2026-09-17T09:00:00Z',
  });
  line('  test asserts active([live]) == [] : ' + JSON.stringify(activeDecisions([live]).map((d) => d.decision_id)));
  line('  but active([predecessor, live]) == ' + JSON.stringify(activeDecisions([predecessor, live]).map((d) => d.decision_id)));
  line('  resolve(review.accept) = ' + resolveOwnerDecision([predecessor, live], 'review.accept', { repo: 'agentbridge' }).outcome);
}
