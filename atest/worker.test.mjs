import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerHandler } from '../bridge/worker.mjs';
import { createHttpStore } from '../bridge/httpStore.mjs';
import { toolDefs } from '../mcp/toolDefs.mjs';

/**
 * THE EDGE SURFACE, AND THAT IT ANSWERS THE SAME AS THE OTHERS.
 *
 * The Worker cannot reuse `pg` or the SDK's HTTP transport, so its transport is
 * hand-rolled. The risk that creates is not a crash -- it is DRIFT: a hosted
 * surface that quietly answers differently about the same machine than stdio
 * does. So the tools are asserted to come from the one shared module, and the
 * hand-rolled bits are asserted against the protocol.
 *
 * No network. A stub fetch stands in for Supabase so the store's real
 * behaviour -- including how it fails -- is exercised rather than mocked away.
 */

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' };
const TOKEN = 'reader-token-value-long-enough';

const sessionRow = {
  agent_id: 'code-b', lane: 'x', machine_label: 'dev', worktree: '~/wt',
  git: { branch: 'b/x', head: 'a'.repeat(40), unpushed: 0, dirty: [] },
  locks: [], processes: [], process_probe_ok: true, last_seen_at: '2026-09-15T00:00:00.000Z',
};

/** SHA-256 hex, the same way httpStore computes it. */
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A stub PostgREST. Records what was asked so the token path can be checked. */
function stubFetch({ tokenHex, sessions = [sessionRow], fail = false } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (fail) return new Response('nope', { status: 503 });
    const u = String(url);
    if (u.includes('/reader_tokens')) {
      const ok = tokenHex && u.includes(`token_sha256=eq.${tokenHex}`);
      return Response.json(ok ? [{ label: 'test-reader', disabled: false }] : []);
    }
    if (u.includes('/sessions_latest')) return Response.json(sessions);
    if (u.includes('/lanes_latest')) return Response.json([{ lanes: {} }]);
    return Response.json([]);
  };
  f.calls = calls;
  return f;
}

async function handlerWith(opts = {}) {
  const tokenHex = await sha256Hex(TOKEN);
  const fetchImpl = stubFetch({ tokenHex, ...opts });
  const handler = createWorkerHandler(ENV, {
    storeFactory: (env) => createHttpStore(env, { fetchImpl }),
  });
  return { handler, fetchImpl };
}

const rpc = (handler, token, body) => handler(new Request('https://w/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
}));

const INIT = { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } };

test('worker: /mcp refuses without a token', async () => {
  const { handler } = await handlerWith();
  const res = await rpc(handler, null, INIT);
  assert.equal(res.status, 401);
});

test('worker: /mcp refuses a wrong token and leaks no state', async () => {
  const { handler } = await handlerWith();
  const res = await rpc(handler, 'wrong-token-but-long-enough', INIT);
  assert.equal(res.status, 401);
  assert.doesNotMatch(await res.text(), /code-b|worktree/);
});

test('worker: a valid token initializes and carries the operating rule', async () => {
  const { handler } = await handlerWith();
  const res = await rpc(handler, TOKEN, INIT);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.protocolVersion, '2024-11-05');
  assert.match(body.result.instructions, /QUERY THIS SERVER BEFORE ASKING A PERSON/);
  assert.match(body.result.instructions, /NEVER ABBREVIATED/);
});

test('worker: the reader token is compared by digest, never sent in the clear', async () => {
  // A dump of reader_tokens must not yield working credentials.
  const { handler, fetchImpl } = await handlerWith();
  await rpc(handler, TOKEN, INIT);
  const asked = fetchImpl.calls.join('\n');
  assert.ok(asked.includes('token_sha256=eq.'), 'token was not looked up by digest');
  assert.equal(asked.includes(TOKEN), false, 'the plaintext token reached the database');
});

test('worker: tools/list returns JSON Schema the wire can carry', async () => {
  const { handler } = await handlerWith();
  await rpc(handler, TOKEN, INIT);
  const res = await rpc(handler, TOKEN, { method: 'tools/list', params: {} });
  const { result } = await res.json();
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  assert.ok(byName.list_agents, 'list_agents missing');
  assert.equal(byName.get_agent_state.inputSchema.type, 'object');
  assert.deepEqual(byName.get_agent_state.inputSchema.required, ['agentId']);
});

test('worker: tools/call returns real rows from the store', async () => {
  const { handler } = await handlerWith();
  await rpc(handler, TOKEN, INIT);
  const res = await rpc(handler, TOKEN, {
    method: 'tools/call', params: { name: 'list_agents', arguments: {} },
  });
  const { result } = await res.json();
  const rows = JSON.parse(result.content[0].text);
  assert.equal(rows[0].agentId, 'code-b');
  assert.equal(rows[0].branch, 'b/x');
});

test('worker: contracts are NOT served from the hosted surface', async () => {
  // Machine-local by decision. The absence is the point, and is asserted so a
  // future store that quietly gains listDelegations fails this test loudly.
  const { handler } = await handlerWith();
  await rpc(handler, TOKEN, INIT);
  const res = await rpc(handler, TOKEN, { method: 'tools/list', params: {} });
  const names = (await res.json()).result.tools.map((t) => t.name);
  assert.equal(names.includes('list_delegations'), false);
  assert.equal(names.includes('get_delegation'), false);
});

test('worker: the tool list IS the shared definition list — no drift', async () => {
  // The whole reason toolDefs was extracted. If the Worker ever grows its own
  // tool, or loses one, this fails.
  const { handler, fetchImpl } = await handlerWith();
  await rpc(handler, TOKEN, INIT);
  const res = await rpc(handler, TOKEN, { method: 'tools/list', params: {} });
  const served = (await res.json()).result.tools.map((t) => t.name).sort();
  const expected = toolDefs(createHttpStore(ENV, { fetchImpl })).map((d) => d.name).sort();
  assert.deepEqual(served, expected);
});

test('worker: an unknown method is method-not-found, not a 500', async () => {
  const { handler } = await handlerWith();
  const res = await rpc(handler, TOKEN, { method: 'tools/explode', params: {} });
  const body = await res.json();
  assert.equal(body.error.code, -32601);
});

test('worker: an unknown TOOL is invalid-params, distinct from unknown method', async () => {
  const { handler } = await handlerWith();
  const res = await rpc(handler, TOKEN, {
    method: 'tools/call', params: { name: 'no_such_tool', arguments: {} },
  });
  assert.equal((await res.json()).error.code, -32602);
});

test('worker: a backend outage is reported as an error, not as "no agents"', async () => {
  // The dangerous silent failure: [] renders as a calm, wrong answer.
  const { handler } = await handlerWith({ fail: true });
  const res = await rpc(handler, TOKEN, INIT);
  assert.equal(res.status, 401, 'a failed token lookup must not authenticate');

  // And with auth working but reads failing, /v1/state says upstream, not empty.
  const tokenHex = await sha256Hex(TOKEN);
  let calls = 0;
  const flaky = async (url) => {
    calls += 1;
    if (String(url).includes('/reader_tokens')) {
      return Response.json([{ label: 'test-reader', disabled: false }]);
    }
    return new Response('down', { status: 503 });
  };
  const h2 = createWorkerHandler(ENV, {
    storeFactory: (env) => createHttpStore(env, { fetchImpl: flaky }),
  });
  const r2 = await h2(new Request('https://w/v1/state', { headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(r2.status, 502, `expected upstream failure, got ${r2.status}`);
  assert.ok(tokenHex && calls > 0);
});

test('worker: missing bindings read as not-configured, never as unauthorized', async () => {
  const handler = createWorkerHandler({});
  const res = await handler(new Request('https://w/mcp', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 503, 'a missing binding looked like a bad token');
  assert.equal((await res.json()).error, 'not-configured');
});

test('worker: /v1/health needs no token and reveals no state', async () => {
  const { handler } = await handlerWith();
  const res = await handler(new Request('https://w/v1/health'));
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /code-b|worktree/);
});

test('worker: GET /mcp is refused — this transport is POST-only', async () => {
  const { handler } = await handlerWith();
  const res = await handler(new Request('https://w/mcp', { headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(res.status, 405);
});

test('worker: ingest is absent, so a Worker cannot write', async () => {
  // /v1/heartbeat stays on the node bridge with the HMAC and nonce store.
  const { handler } = await handlerWith();
  const res = await handler(new Request('https://w/v1/heartbeat', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}',
  }));
  assert.equal(res.status, 404);
});
