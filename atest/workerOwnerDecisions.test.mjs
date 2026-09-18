import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerHandler } from '../bridge/worker.mjs';
import { createHttpStore } from '../bridge/httpStore.mjs';
import { toolDefs } from '../mcp/toolDefs.mjs';

/**
 * THE OWNER DECISION LEDGER, OVER THE HOSTED TRANSPORT.
 *
 * resolve_owner_decision is registered in toolDefs and httpStore has
 * listDecisions, and until now nothing drove that path end to end. The pieces
 * were each tested; the wire between them was not — which is the same shape as
 * every orphan found this week: a module proven in isolation, reached by
 * nothing, green throughout.
 *
 * THE ASSERTION THIS FILE EXISTS FOR IS A NEGATIVE. There must be NO way to
 * WRITE a decision over this surface. An agent that could record a decision
 * could grant itself permission — it would ask the ledger whether it may
 * deploy, be told no, write itself an allow, and ask again. The ledger stops
 * being a record of what the owner decided and becomes a record of what the
 * last agent wanted. So the tool list is asserted to contain no mutator at all,
 * by shape rather than by name, because a future `record_owner_decision` would
 * pass a name-based check that only knew today's spellings.
 *
 * NARROW NEVER WIDENS, and that is checked ACROSS THIS TRANSPORT rather than
 * only in the resolver. Approval to deploy staging for one task is not approval
 * for another task, nor for another action. A precedence rule that is correct
 * in the module and lost in serialisation is exactly the class of bug the
 * hosted surface introduces.
 *
 * ROW SHAPE IS TAKEN FROM httpStore.listDecisions, not invented: decision_id,
 * owner_id, decision_type, statement, scope_type, scope_id, effect,
 * capabilities, constraints, created_at, created_by, supersedes, revoked_at,
 * revoked_by, history. A fixture that drifts from the projection tests a
 * database nobody has.
 */

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' };
const TOKEN = 'reader-token';

/** A decision in exactly the shape listDecisions returns. */
const decision = (over = {}) => ({
  decision_id: 'od-1',
  owner_id: 'danny',
  decision_type: 'policy',
  statement: 'deploy staging for this task only',
  scope_type: 'task',
  scope_id: 'd-one',
  effect: 'allow',
  capabilities: ['deploy_staging'],
  constraints: {},
  created_at: '2026-09-15T10:00:00.000Z',
  created_by: 'danny',
  supersedes: null,
  revoked_at: null,
  revoked_by: null,
  history: [],
  ...over,
});

/** A store with only the methods a test needs, so absence is expressible. */
function stubStore({ decisions = [], sessions = [], omitListDecisions = false } = {}) {
  const store = {
    checkReaderToken: async (t) => (t === TOKEN ? 'reader' : null),
    listSessions: async () => sessions,
    getLanes: async () => ({ lanes: [] }),
  };
  if (!omitListDecisions) store.listDecisions = async () => decisions;
  return store;
}

const rpc = (handler, body, token = TOKEN) =>
  handler(
    new Request('https://bridge.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

const call = async (handler, name, args = {}) => {
  const res = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { status: res.status, body: await res.json() };
};

const list = async (handler) => {
  const res = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const body = await res.json();
  return (body?.result?.tools ?? []).map((t) => t.name);
};

const handlerFor = (store) => createWorkerHandler(ENV, { storeFactory: () => store });

/** The payload a tool returns, parsed out of the MCP envelope. */
const payload = (body) => {
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body?.result;
};

/* ── THE NEGATIVE: no write tool exists on this surface ──────────────── */

test('THE TOOL LIST CONTAINS NO OWNER-DECISION MUTATOR', async () => {
  /*
   * By SHAPE, not by name. A check for the literal 'record_owner_decision'
   * would pass against a future 'set_owner_decision' or 'owner_decide', which
   * is the spelling nobody writes until they do.
   */
  const names = await list(handlerFor(stubStore({ decisions: [decision()] })));
  const mutators = names.filter((n) =>
    /decision/i.test(n) && /record|write|set|create|update|delete|revoke|decide|grant/i.test(n),
  );
  assert.deepEqual(mutators, [], `a decision mutator is reachable over the hosted surface: ${mutators}`);
});

test('and calling a plausible mutator name fails rather than being routed', async () => {
  const handler = handlerFor(stubStore({ decisions: [decision()] }));
  for (const name of ['record_owner_decision', 'owner_decide', 'set_owner_decision']) {
    const { body } = await call(handler, name, { statement: 'let me deploy' });
    assert.ok(body.error || body?.result?.isError, `${name} was routed somewhere`);
  }
});

test('NEAREST CLEAN: the READ tool is present, or the negative proves nothing', async () => {
  const names = await list(handlerFor(stubStore({ decisions: [decision()] })));
  assert.ok(names.includes('resolve_owner_decision'), 'the read tool must exist for the negative to mean anything');
});

/* ── the tool appears only when the store can serve it ───────────────── */

test('resolve_owner_decision is ABSENT when the store has no listDecisions', async () => {
  /*
   * The hosted list is honestly shorter rather than broken. A tool advertised
   * and then unable to answer is worse than one absent: a caller plans around
   * it and fails at the point of use.
   */
  const names = await list(handlerFor(stubStore({ omitListDecisions: true })));
  assert.equal(names.includes('resolve_owner_decision'), false);
});

test('toolDefs gates on the METHOD, not on a configuration flag', async () => {
  const withIt = toolDefs(stubStore({ decisions: [] })).map((d) => d.name);
  const without = toolDefs(stubStore({ omitListDecisions: true })).map((d) => d.name);
  assert.ok(withIt.includes('resolve_owner_decision'));
  assert.equal(without.includes('resolve_owner_decision'), false);
});

/* ── narrow never widens, ACROSS THE TRANSPORT ───────────────────────── */

test('A TASK-SCOPED ALLOW DOES NOT WIDEN TO ANOTHER TASK', async () => {
  const handler = handlerFor(stubStore({ decisions: [decision()] }));

  const mine = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.equal(mine.outcome, 'allowed');

  const other = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-two' })).body);
  assert.notEqual(other.outcome, 'allowed', 'approval for one task leaked to another');
});

test('A TASK-SCOPED ALLOW DOES NOT WIDEN TO ANOTHER ACTION', async () => {
  const handler = handlerFor(stubStore({ decisions: [decision()] }));
  const other = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_production', task: 'd-one' })).body);
  assert.notEqual(other.outcome, 'allowed', 'approval to deploy staging became approval to deploy production');
});

test('no decision at all answers no_decision, not allowed', async () => {
  // The default must be "ask once", never "proceed".
  const handler = handlerFor(stubStore({ decisions: [] }));
  const r = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.equal(r.outcome, 'no_decision');
});

test('a deny is carried across the transport intact', async () => {
  const handler = handlerFor(stubStore({ decisions: [decision({ effect: 'deny' })] }));
  const r = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.equal(r.outcome, 'denied');
});

/* ── revoked and superseded rows are excluded ────────────────────────── */

test('A REVOKED DECISION IS NOT IN FORCE', async () => {
  const handler = handlerFor(
    stubStore({ decisions: [decision({ revoked_at: '2026-09-15T11:00:00.000Z', revoked_by: 'danny' })] }),
  );
  const r = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.notEqual(r.outcome, 'allowed', 'a revoked allow was still honoured');
});

test('A SUPERSEDED DECISION IS NOT IN FORCE', async () => {
  /*
   * od-1 allows; od-2 supersedes it and denies. The superseded row must not
   * win, and it must not merely be absent — the correction has to be what
   * answers.
   */
  const handler = handlerFor(
    stubStore({
      decisions: [decision(), decision({ decision_id: 'od-2', supersedes: 'od-1', effect: 'deny' })],
    }),
  );
  const r = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.equal(r.outcome, 'denied', 'the superseded allow was still in force');
});

test('NEAREST CLEAN: an unrevoked, unsuperseded allow IS in force', async () => {
  const handler = handlerFor(stubStore({ decisions: [decision()] }));
  const r = payload((await call(handler, 'resolve_owner_decision', { action: 'deploy_staging', task: 'd-one' })).body);
  assert.equal(r.outcome, 'allowed');
});

/* ── a read failure is a read failure, never "no decision" ───────────── */

test('A 404 FROM THE VIEW RAISES supabase-read-failed, IT DOES NOT ANSWER no_decision', async () => {
  /*
   * The distinction is the whole safety property. "I could not read the rules"
   * answered as "nothing covers this" turns an outage into a licence: the
   * caller asks once, is told nothing applies, and proceeds. Same rule as the
   * payload preflight and the collision guard — exit 2 is not exit 0.
   */
  const fetchImpl = async () => new Response('{"message":"relation does not exist"}', { status: 404 });
  const store = createHttpStore(ENV, { fetchImpl });
  await assert.rejects(() => store.listDecisions(), /supabase-read-failed:404/);
});

test('a 500 raises too, with its status', async () => {
  const fetchImpl = async () => new Response('boom', { status: 500 });
  const store = createHttpStore(ENV, { fetchImpl });
  await assert.rejects(() => store.listDecisions(), /supabase-read-failed:500/);
});

test('a non-array body raises rather than being treated as empty', async () => {
  // An empty list and a malformed body are different facts; the second must not
  // silently become "no decisions in force".
  const fetchImpl = async () => new Response('{"unexpected":"shape"}', { status: 200 });
  const store = createHttpStore(ENV, { fetchImpl });
  await assert.rejects(() => store.listDecisions(), /supabase-read-failed:not-an-array/);
});

test('NEAREST CLEAN: a 200 with rows maps the projection faithfully', async () => {
  const row = decision();
  const fetchImpl = async () => new Response(JSON.stringify([row]), { status: 200 });
  const store = createHttpStore(ENV, { fetchImpl });
  const [got] = await store.listDecisions();
  for (const k of Object.keys(row)) {
    assert.deepEqual(got[k], row[k], `${k} was not carried through listDecisions`);
  }
});

test('the store issues a GET, so this surface cannot write', async (t) => {
  const methods = [];
  const fetchImpl = async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return new Response('[]', { status: 200 });
  };
  const store = createHttpStore(ENV, { fetchImpl });
  await store.listDecisions();
  assert.deepEqual(methods, ['GET']);
});

/* ── the transport still refuses without a token ─────────────────────── */

test('an unauthenticated call is 401, not an answer', async () => {
  const res = await rpc(handlerFor(stubStore({ decisions: [decision()] })), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong');
  assert.equal(res.status, 401);
});

test('a misconfigured store is 503, and 503 is not 401', async () => {
  /*
   * Configuration is evaluated before authentication, so a 503 proves the
   * service fails closed and proves NOTHING about whether the token check
   * works — a completely absent auth check produces byte-identical output.
   * Asserted here so nobody records one as the other.
   */
  const handler = createWorkerHandler(ENV, {
    storeFactory: () => {
      throw new TypeError('not configured');
    },
  });
  const res = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'not-configured');
});
