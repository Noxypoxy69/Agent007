import { resolveOwnerDecision, activeDecisions, createDecision } from './src/ownerDecisions.mjs';
import * as H from './supabase/functions/mcp/_shared.js';

const T = '2026-01-01T00:00:00Z';
function D(id, { effect = 'deny', caps = ['deploy.production'], supersedes = null, scope_type = 'bridge', scope_id = null, created_by = 'danny', owner_id = 'danny', created_at = T } = {}) {
  return {
    decision_id: id, owner_id, decision_type: 'policy',
    statement: `statement for ${id}`,
    scope_type, scope_id, effect, capabilities: caps,
    constraints: {}, created_at, created_by, supersedes,
    revoked_at: null, revoked_by: null,
    history: [{ event: 'created', at: created_at, by: created_by }],
  };
}

function run(name, rows, action = 'deploy.production', ctx = {}) {
  const a = resolveOwnerDecision(rows, action, ctx);
  const b = H.resolveOwnerDecision(rows, action, ctx);
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${name.padEnd(42)} src=${a.outcome.padEnd(14)} id=${String(a.decision_id).padEnd(6)} hosted=${b.outcome.padEnd(14)} ${same ? 'AGREE' : '*** DIVERGE ***'}`);
  if (!same) { console.log('   src   ', JSON.stringify(a)); console.log('   hosted', JSON.stringify(b)); }
  return a;
}

console.log('--- ordinary supersession chains ---');
// A <- B : B in force
run('chain2 (A<-B, B allow)', [D('A', { effect: 'deny' }), D('B', { effect: 'allow', supersedes: 'A' })]);
// A <- B <- C : C in force. ORDINARY. Should be allowed (C).
run('chain3 (A<-B<-C, C allow)', [D('A', { effect: 'deny' }), D('B', { effect: 'deny', supersedes: 'A' }), D('C', { effect: 'allow', supersedes: 'B' })]);
run('chain4 (A<-B<-C<-D, D allow)', [D('A'), D('B', { supersedes: 'A' }), D('C', { supersedes: 'B' }), D('D', { effect: 'allow', supersedes: 'C' })]);
run('chain5', [D('A'), D('B', { supersedes: 'A' }), D('C', { supersedes: 'B' }), D('E', { supersedes: 'C' }), D('F', { effect: 'allow', supersedes: 'E' })]);

console.log('\nactiveDecisions chain3 ->', activeDecisions([D('A'), D('B', { supersedes: 'A' }), D('C', { effect: 'allow', supersedes: 'B' })]).map((d) => d.decision_id));

console.log('\n--- shapes the commit claims it closes ---');
run('self-supersession', [D('S', { effect: 'deny', supersedes: 'S' })]);
run('cycle of 2', [D('A', { supersedes: 'B' }), D('B', { supersedes: 'A' })]);
run('cycle of 3', [D('A', { supersedes: 'C' }), D('B', { supersedes: 'A' }), D('C', { supersedes: 'B' })]);
run('invalid superseder (junk)', [D('A', { effect: 'deny' }), { decision_id: 'J', supersedes: 'A' }]);
run('non-owner superseder', [D('A', { effect: 'deny' }), D('J', { owner_id: 'c8', created_by: 'c8', supersedes: 'A' })]);

console.log('\n--- revocation must still restore ---');
const revoked = D('B', { effect: 'allow', supersedes: 'A' });
revoked.revoked_at = '2026-02-01T00:00:00Z'; revoked.revoked_by = 'danny';
run('revoked superseder restores A(deny)', [D('A', { effect: 'deny' }), revoked]);

console.log('\n--- diamonds ---');
run('diamond: B1 live, B2 superseded', [D('A'), D('B1', { effect: 'allow', supersedes: 'A' }), D('B2', { supersedes: 'A' }), D('X', { supersedes: 'B2' })]);
run('diamond: both superseders dead', [D('A'), D('B1', { supersedes: 'A' }), D('B2', { supersedes: 'A' }), D('X', { supersedes: 'B1' }), D('Y', { supersedes: 'B2' })]);

console.log('\n--- phantom / duplicate ids ---');
run('superseder of phantom id', [D('A', { effect: 'deny' }), D('B', { effect: 'allow', supersedes: 'ghost' })]);
run('duplicate decision_ids', [D('A', { effect: 'deny' }), D('A', { effect: 'allow' })]);
run('dup ids one superseded', [D('A', { effect: 'deny' }), D('A', { effect: 'allow' }), D('Z', { supersedes: 'A' })]);

console.log('\n--- masking: narrow DENY orphaned, broad ALLOW live ---');
run('narrow deny killed by junk, broad allow live',
  [D('N', { effect: 'deny', scope_type: 'task', scope_id: 't1' }),
    { decision_id: 'J', supersedes: 'N' },
    D('W', { effect: 'allow', scope_type: 'bridge' })],
  'deploy.production', { task: 't1' });

console.log('\n--- orphan whose victim does not match action/scope ---');
run('orphan not matching action', [D('A', { caps: ['other.thing'] }), { decision_id: 'J', supersedes: 'A' }]);
run('orphan not matching scope', [D('A', { scope_type: 'task', scope_id: 'tX' }), { decision_id: 'J', supersedes: 'A' }], 'deploy.production', { task: 'tOTHER' });
