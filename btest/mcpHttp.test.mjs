import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createBridgeApp } from '../bridge/server.mjs';

/**
 * THE ENDPOINT A HOSTED CLIENT ACTUALLY CONNECTS TO.
 *
 * /mcp had no test of any kind. Its reader-token check is the only thing
 * between a token and what THREAT_MODEL.md calls "a complete map of the
 * engineering state", and nothing exercised it -- because bridge/server.mjs
 * imported `pg` at module scope, so the whole HTTP surface was unreachable
 * without a live Postgres and a socket.
 *
 * Real HTTP, real JSON-RPC, a fake store. No database, nothing listening
 * beyond the test.
 */

const SHA = 'b364b84489a9e5cd0860e60f56ac5302634dc1bb';
const TOKEN = 'reader-token-value';

const session = (over = {}) => ({
  agentId: 'code-b', lane: 'x', worktree: '~/wt',
  git: { branch: 'b/x', head: SHA, baseSha: SHA, unpushed: 0, dirty: [] },
  locks: [], processes: [], lastSeenAt: '2026-09-15T00:00:00.000Z', ...over,
});

const delegation = (over = {}) => ({
  id: 'd-x', assigning_session: 'lead', assigned_session: 'worker',
  task: 'a bounded task', lane_id: 'agentbridge', base_sha: SHA,
  allowed_paths: ['src/x.mjs'], shared_paths: [], forbidden_paths: ['package.json'],
  state: 'assigned', head_sha: null, audit: null, history: [], ...over,
});

function fakeStore({ delegations } = {}) {
  const s = {
    getMachine: async () => null,
    consumeNonce: async () => true,
    bumpRate: async () => ({ allowed: true }),
    recordHeartbeat: async () => {},
    listSessions: async () => [session()],
    getLanes: async () => ({}),
    // The whole point: a valid token and nothing else gets in.
    checkReaderToken: async (t) => (t === TOKEN ? 'test-reader' : null),
  };
  if (delegations) s.listDelegations = async () => delegations;
  return s;
}

/** Start the app on an ephemeral port; closed when the test ends. */
async function serve(t, store) {
  const server = http.createServer(createBridgeApp(store));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** One JSON-RPC call over streamable HTTP. */
async function rpc(base, token, body) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, text, json: null };
  // Streamable HTTP may answer as SSE; pull the data frame back out.
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const raw = line ? line.slice(5).trim() : text;
  let json = null;
  try { json = JSON.parse(raw); } catch { /* leave null */ }
  return { status: res.status, text, json };
}

const INIT = {
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

test('/mcp refuses with no token', async (t) => {
  const base = await serve(t, fakeStore());
  const r = await rpc(base, null, INIT);
  assert.equal(r.status, 401, `unauthenticated request was served: ${r.text.slice(0, 200)}`);
});

test('/mcp refuses a wrong token, and says nothing else', async (t) => {
  const base = await serve(t, fakeStore());
  const r = await rpc(base, 'not-the-token', INIT);
  assert.equal(r.status, 401);
  // A 401 body that varies with the token would make this an oracle.
  assert.doesNotMatch(r.text, /code-b|agentId|worktree/, 'the refusal leaked state');
});

test('/mcp accepts a valid token and completes the handshake', async (t) => {
  // The loud half: a gate that only refuses is an outage.
  const base = await serve(t, fakeStore());
  const r = await rpc(base, TOKEN, INIT);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.json?.result?.serverInfo, `no serverInfo: ${r.text.slice(0, 300)}`);
});

test('/mcp carries the operating rule in its instructions', async (t) => {
  // This is the only instruction a hosted client receives. If it is absent
  // here, the rule does not exist for ChatGPT no matter what stdio says.
  const base = await serve(t, fakeStore());
  const r = await rpc(base, TOKEN, INIT);
  const instr = r.json?.result?.instructions ?? '';
  assert.match(instr, /QUERY THIS SERVER BEFORE ASKING A PERSON/);
  assert.match(instr, /NEVER ABBREVIATED/);
});

test('/mcp lists tools, and a state tool returns real rows', async (t) => {
  const base = await serve(t, fakeStore());
  await rpc(base, TOKEN, INIT);
  const list = await rpc(base, TOKEN, { method: 'tools/list', params: {} });
  const names = (list.json?.result?.tools ?? []).map((x) => x.name);
  assert.ok(names.includes('list_agents'), `tools: ${names.join(',')}`);

  const call = await rpc(base, TOKEN, {
    method: 'tools/call', params: { name: 'list_agents', arguments: {} },
  });
  const rows = JSON.parse(call.json.result.content[0].text);
  assert.equal(rows[0].agentId, 'code-b');
});

test('a backend WITHOUT delegations does not advertise contract tools over HTTP', async (t) => {
  // Honest surface: Postgres has no delegation table, so the hosted endpoint
  // genuinely offers fewer tools than stdio. Asserted so the difference is a
  // decision on record rather than a surprise to a connected client.
  const base = await serve(t, fakeStore());
  await rpc(base, TOKEN, INIT);
  const list = await rpc(base, TOKEN, { method: 'tools/list', params: {} });
  const names = (list.json?.result?.tools ?? []).map((x) => x.name);
  assert.equal(names.includes('list_delegations'), false);
});

test('a backend WITH delegations serves contracts over HTTP', async (t) => {
  // And when a backend does have them, the wiring carries them through --
  // proving the omission above is the backend's, not a broken forward.
  const base = await serve(t, fakeStore({ delegations: [delegation({ id: 'd-live' })] }));
  await rpc(base, TOKEN, INIT);
  const list = await rpc(base, TOKEN, { method: 'tools/list', params: {} });
  const names = (list.json?.result?.tools ?? []).map((x) => x.name);
  assert.ok(names.includes('list_delegations'), `tools: ${names.join(',')}`);

  const call = await rpc(base, TOKEN, {
    method: 'tools/call', params: { name: 'list_delegations', arguments: {} },
  });
  const rows = JSON.parse(call.json.result.content[0].text);
  assert.equal(rows[0].id, 'd-live');
  assert.equal(rows[0].baseSha, SHA);
});

test('/v1/state is token-gated too, and /v1/health is not', async (t) => {
  const base = await serve(t, fakeStore());
  assert.equal((await fetch(`${base}/v1/state`)).status, 401);
  assert.equal((await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/health`)).status, 200, 'health must not need a token');
});

test('an unknown path is 404 and reveals nothing', async (t) => {
  const base = await serve(t, fakeStore());
  const res = await fetch(`${base}/v1/../secret`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /code-b|worktree/);
});
