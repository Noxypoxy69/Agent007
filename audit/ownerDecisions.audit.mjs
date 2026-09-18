/* AUDIT PROBE for 62b3158 / f7ae118 / 065ee23. Depth-1 so ../src/... resolves. */
import {
  validateDecision, activeDecisions, resolveOwnerDecision, revokeDecision, isOwnerId, OWNER_IDS,
} from '../src/ownerDecisions.mjs';
import {
  validateDecision as hValidate, activeDecisions as hActive,
  resolveOwnerDecision as hResolve, revokeDecision as hRevoke, isOwnerId as hIsOwnerId,
} from '../supabase/functions/mcp/_shared.js';

const AT = '2026-09-18T19:00:00.000Z';
const ids = (a) => a.map((d) => d.decision_id);
const D = (o) => ({
  decision_id: 'd-x', owner_id: 'danny', decision_type: 'policy',
  statement: 's', scope_type: 'bridge', scope_id: null, effect: 'allow',
  capabilities: ['*'], constraints: null, created_at: AT, created_by: 'danny',
  supersedes: null, revoked_at: null, ...o,
});
const P = (k, v) => console.log(`${k} :: ${JSON.stringify(v)}`);

console.log('=== 1. SUPPRESSION BY AN UNVALIDATED ROW ===');
{
  const real = D({ decision_id: 'd-owner-deny-prod', effect: 'deny', capabilities: ['deploy.*'] });
  // Not a decision at all. No id, no owner, no statement, no capabilities.
  const junk = { supersedes: 'd-owner-deny-prod' };
  P('1a owner DENY alone -> active', ids(activeDecisions([real])));
  P('1a owner DENY alone -> resolve deploy.production', resolveOwnerDecision([real], 'deploy.production').outcome);
  P('1b junk row {supersedes} added -> active', ids(activeDecisions([real, junk])));
  P('1b junk row added -> resolve deploy.production', resolveOwnerDecision([real, junk], 'deploy.production').outcome);
  P('1c hosted twin agrees', {
    active: ids(hActive([real, junk])),
    outcome: hResolve([real, junk], 'deploy.production').outcome,
  });
  P('1d validateDecision(junk).ok', validateDecision(junk).ok);
  // Even emptier: supersedes only, as a prototype-less object
  const bare = Object.create(null); bare.supersedes = 'd-owner-deny-prod';
  P('1e null-prototype junk suppresses', ids(activeDecisions([real, bare])));
}

console.log('=== 2. CHAINS, CYCLES, SELF, DUPLICATES, NON-OBJECTS ===');
{
  const a = D({ decision_id: 'a', effect: 'deny', capabilities: ['deploy.*'] });
  const b = D({ decision_id: 'b', effect: 'allow', capabilities: ['deploy.*'], supersedes: 'a' });
  const c = D({ decision_id: 'c', effect: 'deny', capabilities: ['deploy.*'], supersedes: 'b' });
  P('2a chain a<-b<-c active', ids(activeDecisions([a, b, c])));
  P('2a chain resolve', resolveOwnerDecision([a, b, c], 'deploy.production').outcome);

  const x = D({ decision_id: 'x', supersedes: 'y', effect: 'deny', capabilities: ['deploy.*'] });
  const y = D({ decision_id: 'y', supersedes: 'x', effect: 'allow', capabilities: ['deploy.*'] });
  P('2b cycle x<->y active', ids(activeDecisions([x, y])));
  P('2b cycle resolve', resolveOwnerDecision([x, y], 'deploy.production').outcome);

  const self = D({ decision_id: 'self', supersedes: 'self', effect: 'deny', capabilities: ['deploy.*'] });
  P('2c self-supersession active', ids(activeDecisions([self])));

  const dup1 = D({ decision_id: 'dup', effect: 'deny', capabilities: ['deploy.*'] });
  const dup2 = D({ decision_id: 'dup', owner_id: 'main', created_by: 'main', effect: 'allow' });
  P('2d duplicate ids (one valid deny, one invalid) active', ids(activeDecisions([dup1, dup2])));

  P('2e non-objects tolerated', ids(activeDecisions([null, 'str', 42, [], undefined, D({ decision_id: 'ok' })])));
  // an ARRAY carrying supersedes
  const arr = []; arr.supersedes = 'ok';
  P('2f array carrying supersedes', ids(activeDecisions([arr, D({ decision_id: 'ok' })])));

  // a REVOKED superseder revives its predecessor
  const older = D({ decision_id: 'o1', effect: 'deny', capabilities: ['deploy.*'] });
  const revoked = D({ decision_id: 'n1', supersedes: 'o1', effect: 'allow', revoked_at: AT });
  P('2g revoked superseder -> predecessor revives', ids(activeDecisions([older, revoked])));
  // an INVALID superseder does NOT revive, but a revoked VALID one does: asymmetric
  const invalidSup = D({ decision_id: 'n2', owner_id: 'main', created_by: 'main', supersedes: 'o1' });
  P('2g invalid superseder -> predecessor stays dead', ids(activeDecisions([older, invalidSup])));
}

console.log('=== 3. WHAT THE LEDGER *REPORTS* AFTER AN INVALID ROW SUPPRESSES ===');
{
  const real = D({ decision_id: 'd-real', effect: 'deny', capabilities: ['deploy.*'] });
  const junk = { supersedes: 'd-real' };
  const r = resolveOwnerDecision([real, junk], 'deploy.production');
  P('3a reason given to the worker', r.reason);
  P('3a outcome / decision_id / candidates', { o: r.outcome, id: r.decision_id, c: r.candidates });
  // the get_owner_decisions / CLI label
  const live = new Set(activeDecisions([real, junk]).map((d) => d.decision_id));
  P('3b state label the owner would see for d-real',
    real.revoked_at ? 'revoked' : (live.has('d-real') ? 'active' : 'superseded'));
}

console.log('=== 4. SPLICE DIVERGENCE: revokeDecision src vs hosted ===');
{
  const mainRow = D({ decision_id: 'd-main', owner_id: 'main', created_by: 'main' });
  P('4a src  revokeDecision(by="main")', revokeDecision(mainRow, { at: AT, by: 'main' }).ok);
  P('4a host revokeDecision(by="main")', hRevoke(mainRow, { at: AT, by: 'main' }).ok);
  const dannyRow = D({ decision_id: 'd-d', owner_id: 'owner', created_by: 'owner' });
  P('4b src  revoke owner-row by "danny"', revokeDecision(dannyRow, { at: AT, by: 'danny' }).ok);
  P('4b host revoke owner-row by "danny"', hRevoke(dannyRow, { at: AT, by: 'danny' }).ok);
  const noOwner = { decision_id: 'd-n', history: [] };
  P('4c src  revoke a row with NO owner_id by "c8"', revokeDecision(noOwner, { at: AT, by: 'c8' }).ok);
  P('4c host revoke a row with NO owner_id by "c8"', hRevoke(noOwner, { at: AT, by: 'c8' }).ok);
}

console.log('=== 5. isOwnerId WIDENING DIRECTIONS THE CORPUS CAN/CANNOT REACH ===');
{
  const ACT = ['c8', 'code-a', 'code-b', 'fixer', 'chatgpt', 'main'];
  const NEAR = [...OWNER_IDS].flatMap((o) => [
    `not-${o}`, `${o}-impostor`, `x${o}`, `${o}x`, `c8-${o}`, `${o}.evil`,
    `${o} `.repeat(2).trim(), `${o}${o}`,
  ]);
  const CORPUS = [...ACT, ...NEAR];
  const variants = {
    'exact (shipped)': (w, os) => os.some((o) => o.toLowerCase() === w),
    'want.includes(o)': (w, os) => os.some((o) => w.includes(o.toLowerCase())),
    'o.includes(want)': (w, os) => os.some((o) => o.toLowerCase().includes(w)),
    'w.startsWith(o)': (w, os) => os.some((o) => w.startsWith(o.toLowerCase())),
    'o.startsWith(w)': (w, os) => os.some((o) => o.toLowerCase().startsWith(w)),
    'strip non-alpha': (w, os) => os.some((o) => w.replace(/[^a-z]/g, '') === o.toLowerCase()),
  };
  for (const [nm, f] of Object.entries(variants)) {
    const caught = CORPUS.filter((w) => f(String(w).trim().toLowerCase(), OWNER_IDS));
    P(`5 ${nm} -> corpus names it accepts`, caught);
  }
  // Names a corpus-blind widening would let through
  const blind = ['dann', 'ann', 'd', 'own', 'owne', 'nny', 'd-a-n-n-y', 'D.A.N.N.Y'];
  for (const [nm, f] of Object.entries(variants)) {
    const got = blind.filter((w) => f(String(w).trim().toLowerCase(), OWNER_IDS));
    if (got.length) P(`5! ${nm} also admits (NOT in the shipped corpus)`, got);
  }
}

console.log('=== 6. SURFACE PARITY ON activeDecisions AND resolve ===');
{
  const cases = [
    ['junk suppress', [D({ decision_id: 'r', effect: 'deny', capabilities: ['deploy.*'] }), { supersedes: 'r' }]],
    ['chain', [D({ decision_id: 'a', effect: 'deny', capabilities: ['deploy.*'] }),
      D({ decision_id: 'b', supersedes: 'a', effect: 'allow', capabilities: ['deploy.*'] })]],
    ['invalid superseder', [D({ decision_id: 'a', effect: 'deny', capabilities: ['deploy.*'] }),
      D({ decision_id: 'b', owner_id: 'main', created_by: 'main', supersedes: 'a' })]],
  ];
  for (const [nm, rows] of cases) {
    const s = { a: ids(activeDecisions(rows)), o: resolveOwnerDecision(rows, 'deploy.production').outcome };
    const h = { a: ids(hActive(rows)), o: hResolve(rows, 'deploy.production').outcome };
    P(`6 ${nm}`, { src: s, hosted: h, agree: JSON.stringify(s) === JSON.stringify(h) });
  }
  for (const w of ['danny', 'owner', 'DANNY', 'main', 'c8', '', '  ', 'Danny ']) {
    if (isOwnerId(w) !== hIsOwnerId(w)) P('6! isOwnerId disagrees', w);
    if (validateDecision(D({ owner_id: w, created_by: w })).ok !== hValidate(D({ owner_id: w, created_by: w })).ok) {
      P('6! validateDecision disagrees', w);
    }
  }
}

console.log('=== 7. D4: created_by/owner_id spelling combinations ===');
{
  for (const [oi, cb] of [['DANNY', 'danny'], ['owner', 'danny'], ['danny', 'owner'],
    ['danny', 'code-b'], ['code-b', 'danny'], ['main', 'main'], ['danny', 'danny']]) {
    P(`7 owner_id=${oi} created_by=${cb}`, {
      src: validateDecision(D({ owner_id: oi, created_by: cb })).ok,
      hosted: hValidate(D({ owner_id: oi, created_by: cb })).ok,
    });
  }
}
