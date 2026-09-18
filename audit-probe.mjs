import { resolveOwnerDecision, activeDecisions } from './src/ownerDecisions.mjs';
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
  console.log(`${name}`);
  console.log(`   active=[${activeDecisions(rows).map((d) => d.decision_id + ':' + d.effect).join(',')}]`);
  console.log(`   src=${a.outcome} id=${a.decision_id} | hosted=${b.outcome} | ${same ? 'AGREE' : '*** DIVERGE ***'}`);
  console.log(`   reason: ${String(a.reason).slice(0, 160)}`);
  return a;
}

console.log('=== ORDINARY CHAINS: the commit claims these are untouched ===');
run('chain3 A<-B<-C, C=ALLOW in force', [D('A', { effect: 'deny' }), D('B', { effect: 'deny', supersedes: 'A' }), D('C', { effect: 'allow', supersedes: 'B' })]);
run('chain3 A<-B<-C, C=DENY in force', [D('A', { effect: 'allow' }), D('B', { effect: 'allow', supersedes: 'A' }), D('C', { effect: 'deny', supersedes: 'B' })]);
run('chain2 control A<-B, B=ALLOW', [D('A', { effect: 'deny' }), D('B', { effect: 'allow', supersedes: 'A' })]);

console.log('\n=== diamond detail ===');
run('diamond B1 live allow, B2 dead', [D('A'), D('B1', { effect: 'allow', supersedes: 'A' }), D('B2', { supersedes: 'A' }), D('X', { effect: 'allow', supersedes: 'B2' })]);

console.log('\n=== duplicate ids ===');
run('dup ids deny+allow', [D('A', { effect: 'deny' }), D('A', { effect: 'allow' })]);

console.log('\n=== MASKING (claim 2) ===');
const narrow = D('N', { effect: 'deny', scope_type: 'task', scope_id: 't1' });
const junk = { decision_id: 'J', supersedes: 'N' };
const broad = D('W', { effect: 'allow', scope_type: 'bridge' });
run('POSITIVE control: broad allow alone matches', [broad], 'deploy.production', { task: 't1' });
run('narrow deny + junk killer + broad allow', [narrow, junk, broad], 'deploy.production', { task: 't1' });
run('NEGATIVE control: narrow deny + broad allow (no junk)', [narrow, broad], 'deploy.production', { task: 't1' });
