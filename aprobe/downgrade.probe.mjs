/* AUDIT PROBE 2 — does the new escalation DOWNGRADE a standing DENY? */
import * as SRC from '../src/ownerDecisions.mjs';
import * as HOSTED from '../supabase/functions/mcp/_shared.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const base = (id, extra = {}) => ({
  decision_id: id, owner_id: 'danny', decision_type: 'policy',
  statement: `s-${id}`, scope_type: 'bridge', scope_id: null,
  effect: 'deny', capabilities: ['deploy.*'], constraints: {},
  created_at: '2026-09-01T00:00:00.000Z', created_by: 'danny',
  supersedes: null, revoked_at: null, ...extra,
});

const CTX = { task: 't7' };
const show = (label, rows, action = 'deploy.production', ctx = CTX) => {
  const a = SRC.resolveOwnerDecision(rows, action, ctx);
  const b = HOSTED.resolveOwnerDecision(rows, action, ctx);
  console.log(`${label.padEnd(60)} ${String(a.outcome).padEnd(14)} (${a.decision_id})  hosted=${b.outcome}`);
};

const TASK_DENY = base('T_DENY', { scope_type: 'task', scope_id: 't7' });
const BRIDGE_ALLOW = base('B_ALLOW', { effect: 'allow' });

console.log('=== the DOWNGRADE: junk names a BROADER allow, narrowest DENY is the real answer ===');
show('control  : task DENY + bridge ALLOW, no junk', [TASK_DENY, BRIDGE_ALLOW]);
show('WITH JUNK: + {supersedes:"B_ALLOW"}', [TASK_DENY, BRIDGE_ALLOW, { supersedes: 'B_ALLOW' }]);

console.log('\n=== the same shape, other way round (tightening, expected/benign) ===');
const BRIDGE_DENY = base('B_DENY');
const TASK_ALLOW = base('T_ALLOW', { effect: 'allow', scope_type: 'task', scope_id: 't7' });
show('control  : bridge DENY + task ALLOW', [BRIDGE_DENY, TASK_ALLOW]);
show('WITH JUNK: + {supersedes:"B_DENY"}', [BRIDGE_DENY, TASK_ALLOW, { supersedes: 'B_DENY' }]);

console.log('\n=== how MANY junk rows does it take? one, and it needs no fields at all ===');
show('minimal junk row is the empty object with one key', [TASK_DENY, BRIDGE_ALLOW, { supersedes: 'B_ALLOW' }]);

console.log('\n=== self-supersession and cycles of VALID rows (unhandled) ===');
show('valid DENY whose supersedes == its own id', [base('S1', { supersedes: 'S1' })]);
show('two valid rows in a cycle', [base('C1', { supersedes: 'C2' }), base('C2', { supersedes: 'C1' })]);
show('3-cycle of valid rows',
  [base('C1', { supersedes: 'C2' }), base('C2', { supersedes: 'C3' }), base('C3', { supersedes: 'C1' })]);

console.log('\n=== is the hosted WRITE path able to store an invalid row at all? ===');
const shared = fs.readFileSync('supabase/functions/mcp/_shared.js', 'utf8');
for (const needle of ['validateDecision(', 'record_owner_decision', 'resolve_owner_decision', 'settleOpenRequestsAgainstPolicy']) {
  const n = shared.split(needle).length - 1;
  console.log(`  _shared.js mentions ${needle.padEnd(34)} ${n} time(s)`);
}
const idx = fs.readFileSync('supabase/functions/mcp/index.ts', 'utf8');
for (const needle of ['validateDecision', 'supersedes', 'record_owner_decision', 'revokeDecision']) {
  const n = idx.split(needle).length - 1;
  console.log(`  index.ts   mentions ${needle.padEnd(34)} ${n} time(s)`);
}

console.log('\n=== how does permissionRequest route owner_required vs no_decision? ===');
const pr = fs.readFileSync('src/permissionRequest.mjs', 'utf8');
for (const m of pr.split('\n').entries()) {
  const [i, line] = m;
  if (/owner_required|no_decision|resolveOwnerDecision/.test(line)) console.log(`  src/permissionRequest.mjs:${i + 1}: ${line.trim().slice(0, 130)}`);
}
console.log('\n(git describe of the tree under probe)');
console.log(execFileSync('git', ['log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim());
