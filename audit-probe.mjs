import { resolveOwnerDecision } from './src/ownerDecisions.mjs';
import * as H from './supabase/functions/mcp/_shared.js';

const T = '2026-01-01T00:00:00Z';
function D(id, o = {}) {
  const { effect = 'deny', caps = ['deploy.production'], supersedes = null, scope_type = 'bridge', scope_id = null, created_by = 'danny', owner_id = 'danny', created_at = T } = o;
  return {
    decision_id: id, owner_id, decision_type: 'policy', statement: `s ${id}`,
    scope_type, scope_id, effect, capabilities: caps, constraints: {},
    created_at, created_by, supersedes, revoked_at: null, revoked_by: null,
    history: [{ event: 'created', at: created_at, by: created_by }],
  };
}

// ---------- COST ----------
function chain(n) {
  const rows = [D('d0', { effect: 'allow' })];
  for (let i = 1; i < n; i++) rows.push(D(`d${i}`, { effect: 'allow', supersedes: `d${i - 1}` }));
  return rows;
}
console.log('=== COST: src vs hosted, resolveOwnerDecision on an N-row chain ===');
for (const n of [100, 400, 1600, 3200]) {
  const rows = chain(n);
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < 3; k++) resolveOwnerDecision(rows, 'deploy.production', {});
  const srcMs = Number(process.hrtime.bigint() - t0) / 3e6;
  t0 = process.hrtime.bigint();
  for (let k = 0; k < 3; k++) H.resolveOwnerDecision(rows, 'deploy.production', {});
  const hostMs = Number(process.hrtime.bigint() - t0) / 3e6;
  console.log(`n=${String(n).padStart(5)}  src=${srcMs.toFixed(1)}ms  hosted=${hostMs.toFixed(1)}ms  ratio=${(srcMs / hostMs).toFixed(1)}x`);
}

// ---------- DIFFERENTIAL: 400 random hostile ledgers ----------
console.log('\n=== DIFFERENTIAL src vs _shared over random hostile ledgers ===');
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
const IDS = ['a', 'b', 'c', 'd', 'e', 'ghost', '', null, undefined, 42];
const SCOPES = ['bridge', 'project', 'repo', 'lane', 'task'];
const CTXS = [{}, { task: 't1' }, { lane: 'l1', task: 't1', repo: 'r1', project: 'p1' }];
let diverge = 0; const outcomes = {};
for (let i = 0; i < 400; i++) {
  const n = 1 + Math.floor(rnd() * 5);
  const rows = [];
  for (let j = 0; j < n; j++) {
    const kind = rnd();
    const id = pick(IDS);
    const sup = rnd() < 0.6 ? pick(IDS) : null;
    if (kind < 0.15) { rows.push({ decision_id: id, supersedes: sup }); continue; }
    if (kind < 0.25) { rows.push(D(id, { supersedes: sup, owner_id: 'c8', created_by: 'c8' })); continue; }
    if (kind < 0.30) { const r = D(id, { supersedes: sup }); r.revoked_at = T; rows.push(r); continue; }
    if (kind < 0.35) { rows.push(null); continue; }
    if (kind < 0.40) { const r = D(id, { supersedes: sup }); r.capabilities = 'nope'; rows.push(r); continue; }
    const st = pick(SCOPES);
    rows.push(D(id, {
      effect: pick(['allow', 'deny', 'require_owner']),
      caps: pick([['deploy.production'], ['deploy.*'], ['*'], ['other.x'], []]),
      supersedes: sup, scope_type: st, scope_id: st === 'bridge' ? null : pick(['t1', 'l1', 'r1', 'p1', 'zz']),
    }));
  }
  const ctx = pick(CTXS);
  let a; let b;
  try { a = resolveOwnerDecision(rows, 'deploy.production', ctx); } catch (e) { a = { outcome: 'THROW:' + e.message }; }
  try { b = H.resolveOwnerDecision(rows, 'deploy.production', ctx); } catch (e) { b = { outcome: 'THROW:' + e.message }; }
  outcomes[a.outcome] = (outcomes[a.outcome] || 0) + 1;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diverge++;
    if (diverge <= 3) {
      console.log('DIVERGE ledger:', JSON.stringify(rows));
      console.log('  src   ', JSON.stringify(a));
      console.log('  hosted', JSON.stringify(b));
    }
  }
}
console.log('ledgers=400 divergences=' + diverge, 'outcome histogram:', JSON.stringify(outcomes));
