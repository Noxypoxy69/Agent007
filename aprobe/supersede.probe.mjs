/* AUDIT PROBE — claim 1/2/3. Depth 1 so ../src and ../supabase resolve. */
import * as SRC from '../src/ownerDecisions.mjs';
import * as HOSTED from '../supabase/functions/mcp/_shared.js';

const ok = (id, extra = {}) => ({
  decision_id: id,
  owner_id: 'danny',
  decision_type: 'policy',
  statement: `statement for ${id}`,
  scope_type: 'bridge',
  scope_id: null,
  effect: 'deny',
  capabilities: ['deploy.*'],
  constraints: {},
  created_at: '2026-09-01T00:00:00.000Z',
  created_by: 'danny',
  supersedes: null,
  revoked_at: null,
  ...extra,
});

const run = (label, rows, action = 'deploy.production', ctx = {}) => {
  const a = SRC.resolveOwnerDecision(rows, action, ctx);
  let b;
  try { b = HOSTED.resolveOwnerDecision(rows, action, ctx); } catch (e) { b = { outcome: `THREW ${e.message}` }; }
  const same = a.outcome === b.outcome && String(a.decision_id) === String(b.decision_id);
  console.log(`${label.padEnd(58)} src=${String(a.outcome).padEnd(14)} hosted=${String(b.outcome).padEnd(14)} ${same ? '' : '  <<< SURFACES DISAGREE'}`);
  return a;
};

console.log('=== 1. the headline case: junk {supersedes} over a standing DENY ===');
run('bare {supersedes} kills DENY?', [ok('D1'), { supersedes: 'D1' }]);

console.log('\n=== 2. ordering: a surviving valid ALLOW must not mask the deleted DENY ===');
run('junk kills DENY, unrelated valid ALLOW still matches',
  [ok('D1'), { supersedes: 'D1' }, ok('A1', { effect: 'allow' })]);

console.log('\n=== 3. invalid for a DIFFERENT reason than ownership ===');
run('superseder missing statement', [ok('D1'), ok('J', { statement: '', supersedes: 'D1' })]);
run('superseder empty capabilities', [ok('D1'), ok('J', { capabilities: [], supersedes: 'D1' })]);
run('superseder bad scope_type', [ok('D1'), ok('J', { scope_type: 'galaxy', supersedes: 'D1' })]);
run('superseder created_by not owner', [ok('D1'), ok('J', { created_by: 'code-b', supersedes: 'D1' })]);

console.log('\n=== 4. non-objects / junk types as superseders ===');
for (const j of [null, undefined, 'D1', 42, ['D1'], true]) {
  run(`superseder is ${JSON.stringify(j)}`, [ok('D1'), j]);
}

console.log('\n=== 5. revoked superseder ===');
run('junk superseder that is REVOKED', [ok('D1'), { supersedes: 'D1', revoked_at: '2026-09-02T00:00:00Z' }]);
run('valid superseder that is REVOKED', [ok('D1'), ok('V', { supersedes: 'D1', revoked_at: '2026-09-02T00:00:00Z' })]);

console.log('\n=== 6. self-supersession ===');
run('valid row supersedes ITSELF', [ok('D1', { supersedes: 'D1' })]);
run('invalid row supersedes ITSELF, plus valid DENY same id',
  [ok('D1'), { decision_id: 'D1', supersedes: 'D1' }]);

console.log('\n=== 7. cycles ===');
run('two valid rows supersede each other',
  [ok('D1', { supersedes: 'D2' }), ok('D2', { supersedes: 'D1' })]);
run('valid DENY <-> invalid row cycle',
  [ok('D1', { supersedes: 'J' }), { decision_id: 'J', supersedes: 'D1' }]);

console.log('\n=== 8. chains of 3+ ===');
run('D1 <- D2(valid) <- D3(junk); D2 matches action',
  [ok('D1'), ok('D2', { supersedes: 'D1' }), { supersedes: 'D2' }]);
run('D1 <- D2(valid ALLOW, different capability) <- D3(junk)',
  [ok('D1'), ok('D2', { supersedes: 'D1', effect: 'allow', capabilities: ['spend.*'] }), { supersedes: 'D2' }]);
run('D1 <- D2(junk) <- D3(junk)',
  [ok('D1'), { decision_id: 'D2', supersedes: 'D1' }, { supersedes: 'D2' }]);
run('4-long: D1<-D2<-D3<-D4 all junk but D1',
  [ok('D1'), { decision_id: 'D2', supersedes: 'D1' }, { decision_id: 'D3', supersedes: 'D2' }, { supersedes: 'D3' }]);

console.log('\n=== 9. duplicate decision_ids ===');
run('two valid rows share an id; junk supersedes it',
  [ok('D1'), ok('D1', { effect: 'allow' }), { supersedes: 'D1' }]);
run('valid DENY id X, invalid row ALSO id X (no supersedes)',
  [ok('X'), { decision_id: 'X', owner_id: 'code-b' }]);

console.log('\n=== 10. superseding something that does not exist ===');
run('junk names a phantom id', [ok('D1'), { supersedes: 'GHOST' }]);
run('valid row names a phantom id', [ok('D1'), ok('V', { supersedes: 'GHOST', effect: 'allow' })]);

console.log('\n=== 11. LEGITIMATE paths must be unchanged (claim 2) ===');
run('plain DENY, nothing else', [ok('D1')]);
run('plain ALLOW, nothing else', [ok('A1', { effect: 'allow' })], 'deploy.production');
run('valid supersession: newer ALLOW replaces older DENY',
  [ok('D1'), ok('A1', { effect: 'allow', supersedes: 'D1', created_at: '2026-09-05T00:00:00Z' })]);
run('revocation: the DENY is revoked', [ok('D1', { revoked_at: '2026-09-03T00:00:00Z' })]);
run('no decision covers the action', [ok('D1')], 'spend.money');
run('narrowest wins: task ALLOW under bridge DENY',
  [ok('D1'), ok('T1', { effect: 'allow', scope_type: 'task', scope_id: 't7' })],
  'deploy.production', { task_id: 't7' });
run('conflict at same scope', [ok('D1'), ok('D2', { effect: 'allow' })]);

console.log('\n=== 12. THE DoS / DOWNGRADE probe: junk over an unrelated ALLOW ===');
const dosRows = [
  ok('D1'),                                  // standing bridge DENY
  ok('A1', { effect: 'allow' }),             // standing bridge ALLOW (conflict today)
];
run('control: DENY + ALLOW, no junk', dosRows);
run('junk names the ALLOW only', [...dosRows, { supersedes: 'A1' }]);
run('junk names the DENY only', [...dosRows, { supersedes: 'D1' }]);

console.log('\n=== 13. revokeDecision parity (claim 3) ===');
const rev = [
  ['plain owner revokes', ok('D1'), { at: 't', by: 'danny' }],
  ['alias owner revokes', ok('D1'), { at: 't', by: 'owner' }],
  ['case/space fold', ok('D1'), { at: 't', by: ' DANNY ' }],
  ['worker revokes', ok('D1'), { at: 't', by: 'code-b' }],
  ['row with owner_id main, by main', ok('D1', { owner_id: 'main' }), { at: 't', by: 'main' }],
  ['row with NO owner_id, by anyone', ok('D1', { owner_id: undefined }), { at: 't', by: 'code-b' }],
  ['no timestamp', ok('D1'), { at: '', by: 'danny' }],
  ['already revoked', ok('D1', { revoked_at: 'x' }), { at: 't', by: 'danny' }],
  ['not an object', 'nope', { at: 't', by: 'danny' }],
];
for (const [label, d, args] of rev) {
  const a = SRC.revokeDecision(d, args);
  const b = HOSTED.revokeDecision(d, args);
  const same = a.ok === b.ok && JSON.stringify(a.errors ?? null) === JSON.stringify(b.errors ?? null);
  console.log(`${label.padEnd(34)} src.ok=${String(a.ok).padEnd(5)} hosted.ok=${String(b.ok).padEnd(5)} ${same ? '' : `  <<< DISAGREE src=${JSON.stringify(a.errors)} hosted=${JSON.stringify(b.errors)}`}`);
}
console.log('\nrevoke full-record parity on the SUCCESS path:',
  JSON.stringify(SRC.revokeDecision(ok('D1'), { at: 't', by: 'danny', reason: 'r' }))
  === JSON.stringify(HOSTED.revokeDecision(ok('D1'), { at: 't', by: 'danny', reason: 'r' }))
    ? 'IDENTICAL' : 'DIFFERENT');
