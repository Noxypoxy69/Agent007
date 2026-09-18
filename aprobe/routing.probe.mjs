/* AUDIT PROBE 9 — what the escalation actually changes for a REQUESTER,
 * through src/permissionRequest.mjs, which is what consumes the outcome. */
import { classifyRequest } from '../src/permissionRequest.mjs';

const dec = (id, extra = {}) => ({
  decision_id: id, owner_id: 'danny', decision_type: 'policy',
  statement: `s-${id}`, scope_type: 'bridge', scope_id: null,
  effect: 'deny', capabilities: ['deploy.*'], constraints: {},
  created_at: '2026-09-01T00:00:00.000Z', created_by: 'danny',
  supersedes: null, revoked_at: null, ...extra,
});

const ask = (label, decisions, request) => {
  const r = classifyRequest(request, decisions, { now: Date.parse('2026-09-18T21:00:00Z') });
  console.log(`${label.padEnd(56)} decider=${String(r.decider).padEnd(12)} allowed=${String(r.allowed)}  ${String(r.reason).slice(0, 70)}`);
};

const REQ = { action: 'deploy.production', reversible: false, agent: 'code-b' };
const REV = { action: 'review.accept', reversible: true, agent: 'code-b' };

console.log('=== the headline: junk over a standing DENY ===');
ask('DENY alone, irreversible action', [dec('D1')], REQ);
ask('DENY + junk {supersedes}', [dec('D1'), { supersedes: 'D1' }], REQ);

console.log('\n=== the reversible class, which is where a COORDINATOR can approve ===');
const RD = dec('D2', { capabilities: ['review.*'] });
ask('DENY alone, reversible action', [RD], REV);
ask('DENY + junk {supersedes}', [RD, { supersedes: 'D2' }], REV);

console.log('\n=== self-supersession and cycles of VALID rows: still deleted ===');
ask('valid DENY whose supersedes == own id', [dec('S1', { capabilities: ['review.*'], supersedes: 'S1' })], REV);
ask('two valid rows in a cycle',
  [dec('C1', { capabilities: ['review.*'], supersedes: 'C2' }), dec('C2', { capabilities: ['review.*'], supersedes: 'C1' })], REV);

console.log('\n=== the DOWNGRADE introduced by d8f6d2b: junk over an UNRELATED allow ===');
const TASK_DENY = dec('T', { scope_type: 'task', scope_id: 't7', capabilities: ['review.*'] });
const BRIDGE_ALLOW = dec('B', { effect: 'allow', capabilities: ['review.*'] });
ask('task DENY + bridge ALLOW (no junk)', [TASK_DENY, BRIDGE_ALLOW], { ...REV, task: 't7' });
ask('+ junk {supersedes:"B"}', [TASK_DENY, BRIDGE_ALLOW, { supersedes: 'B' }], { ...REV, task: 't7' });
