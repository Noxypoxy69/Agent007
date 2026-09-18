import { ACTORS } from '../src/coordination.mjs';
import { OWNER_IDS, resolveOwnerDecision } from '../src/ownerDecisions.mjs';
import { classifyRequest, DECIDER } from '../src/permissionRequest.mjs';

const P = (k, v) => console.log(`${k} :: ${JSON.stringify(v)}`);

console.log('=== A. WHY THE o.includes(want) MUTATION WAS CAUGHT ===');
const ROSTER = ACTORS.filter((a) => a.actor_type !== 'owner')
  .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])]);
P('A1 non-owner roster names', ROSTER);
P('A2 roster names that are a SUBSTRING of an owner name (this is what catches o.includes)',
  ROSTER.filter((n) => OWNER_IDS.some((o) => o.includes(String(n).toLowerCase()))));
P('A3 roster names that an owner name STARTS WITH',
  ROSTER.filter((n) => OWNER_IDS.some((o) => o.startsWith(String(n).toLowerCase()))));
P('A4 owner rows in ACTORS', ACTORS.filter((a) => a.actor_type === 'owner'));

console.log('=== B. BLAST RADIUS: what a suppressed owner DENY routes to ===');
const AT = '2026-09-18T19:00:00.000Z';
const deny = (caps, scope = 'bridge') => ({
  decision_id: 'd-owner-deny', owner_id: 'danny', decision_type: 'policy',
  statement: 'the owner says no', scope_type: scope, scope_id: null, effect: 'deny',
  capabilities: caps, constraints: {}, created_at: AT, created_by: 'danny',
  supersedes: null, revoked_at: null,
});
const junk = { supersedes: 'd-owner-deny' };

for (const action of ['deploy.production', 'merge.main', 'review.accept', 'task.return',
  'file.write', 'test.run', 'spend.money']) {
  for (const reversible of [true, false]) {
    const withDeny = classifyRequest({ action, reversible }, [deny(['*'])], { now: AT });
    const suppressed = classifyRequest({ action, reversible }, [deny(['*']), junk], { now: AT });
    if (withDeny.decider !== suppressed.decider || withDeny.allowed !== suppressed.allowed) {
      P(`B! ${action} reversible=${reversible}`, {
        withOwnerDeny: { decider: withDeny.decider, allowed: withDeny.allowed, risk: withDeny.risk },
        afterJunkSuppresses: { decider: suppressed.decider, allowed: suppressed.allowed, risk: suppressed.risk },
      });
    } else {
      P(`B  ${action} reversible=${reversible} unchanged`, { decider: withDeny.decider, allowed: withDeny.allowed });
    }
  }
}
P('B2 DECIDER values', DECIDER);

console.log('=== C. SUB-MILLISECOND CURSOR DROP (server side is Date.parse + strict >) ===');
{
  const cur = '2026-09-18T19:30:00.123456+00:00';
  const later = '2026-09-18T19:30:00.123999+00:00';
  P('C1 cursor ms', Date.parse(cur));
  P('C2 a LATER microsecond event ms', Date.parse(later));
  P('C3 server predicate `t > after` delivers it?', Date.parse(later) > Date.parse(cur));
}
