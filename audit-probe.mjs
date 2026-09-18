import { toolDefs as hostedDefs } from './supabase/functions/mcp/_shared.js';
import { toolDefs as twinDefs } from './mcp/toolDefs.mjs';
import { resolveOwnerDecision, activeDecisions } from './src/ownerDecisions.mjs';
import { routePermissionRequest } from './src/permissionRequest.mjs';

/* ---- D8: the contradiction list_locks was supposed to remove, at b53581b ---- */
// index.ts:402 hardcodes `locks: null` for every session on the deployed surface.
const DEPLOYED_ROW = {
  agentId: 'code-b', sessionId: 'danny-win-b1', lane: 'agentbridge', worktree: null,
  capacity: null, git: null, locks: null, processes: null, processProbeOk: null,
  lastSeenAt: '2026-09-18T20:00:00.000Z',
};
const storeOf = (sessions) => ({
  listSessions: async () => sessions, getLanes: async () => ({}),
  listDecisions: async () => [], listMessages: async () => [],
});
const call = async (defs, name, store) => {
  const def = defs(store).find((d) => d.name === name);
  const out = await def.run({});
  return JSON.parse(out.content[0].text);
};
for (const [surface, defs] of [['hosted', hostedDefs], ['twin', twinDefs]]) {
  const store = storeOf([DEPLOYED_ROW]);
  const agents = await call(defs, 'list_agents', store);
  const locks = await call(defs, 'list_locks', store);
  const row = (Array.isArray(agents) ? agents : agents.agents ?? agents.rows)[0];
  console.log(`${surface}: list_agents.locksHeld = ${JSON.stringify(row.locksHeld)} | `
    + `list_locks = ${JSON.stringify(locks)}  <- still two answers about one session`);
  const d = defs(store).find((x) => x.name === 'list_locks');
  console.log(`${surface}: list_locks description = ${JSON.stringify(d.description)}`);
}

/* ---- D1: an ordinary 3-step revision history ---- */
const T = '2026-01-01T00:00:00Z';
const D = (id, effect, supersedes) => ({
  decision_id: id, owner_id: 'danny', decision_type: 'policy', statement: `s ${id}`,
  scope_type: 'bridge', scope_id: null, effect, capabilities: ['deploy.*'],
  constraints: {}, created_at: T, created_by: 'danny', supersedes,
  revoked_at: null, revoked_by: null, history: [{ event: 'created', at: T, by: 'danny' }],
});
const ledger = [
  D('d-deploy-20260916', 'deny', null),
  D('d-deploy-20260917', 'deny', 'd-deploy-20260916'),
  D('d-deploy-corrected-20260918', 'allow', 'd-deploy-20260917'),
];
console.log('\nactiveDecisions  ->', activeDecisions(ledger).map((x) => `${x.decision_id}:${x.effect}`));
const r = resolveOwnerDecision(ledger, 'deploy.production', {});
console.log('resolveOwnerDecision ->', r.outcome, '|', r.reason.slice(0, 120));
console.log('candidates ->', JSON.stringify(r.candidates));

const routed = routePermissionRequest({
  action: 'deploy.production', requested_by: 'code-b', risk: 'elevated',
  reversible: true, decisions: ledger, context: {},
});
console.log('routePermissionRequest ->', JSON.stringify({
  decider: routed.decider, outcome: routed.outcome ?? routed.state ?? null,
}));
