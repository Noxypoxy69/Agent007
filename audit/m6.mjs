import { validateDecision, resolveOwnerDecision, isOwnerId } from '../src/ownerDecisions.mjs';
const AT = '2026-09-18T19:00:00.000Z';
const dec = (who) => ({
  decision_id: 'd-x', owner_id: who, decision_type: 'policy', statement: 's',
  scope_type: 'bridge', scope_id: null, effect: 'allow', capabilities: ['*'],
  constraints: null, created_at: AT, created_by: who, supersedes: null, revoked_at: null,
});
for (const who of ['not-danny', 'danny-impostor', 'c8-danny', 'downer', 'chatgpt-owner', 'xownerx']) {
  console.log(`${who.padEnd(16)} isOwnerId=${isOwnerId(who)} valid=${validateDecision(dec(who)).ok}` +
    ` resolve(deploy.production)=${resolveOwnerDecision([dec(who)], 'deploy.production').outcome}`);
}
