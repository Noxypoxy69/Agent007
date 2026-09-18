import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMcpServer } from '../mcp/tools.mjs';

/**
 * THE READ SURFACE MUST ANSWER "WHAT DOES THIS AGENT OWE".
 *
 * The seven original tools answer what each agent is DOING, from git and the
 * process table. None answered what it owes -- the contracts and their bounds.
 * A client that cannot read those has one way to learn them: ask a person to
 * paste a brief, restating what the machine already holds and going stale the
 * moment it is pasted.
 *
 * Both directions asserted, because the interesting failure is silent: a tool
 * that exists but returns nothing looks identical to an agent with no work.
 */

const SHA = 'b364b84489a9e5cd0860e60f56ac5302634dc1bb';

const del = (over = {}) => ({
  id: 'd-x',
  assigning_session: 'lead',
  assigned_session: 'worker',
  task: 'a bounded task',
  lane_id: 'agentbridge',
  base_sha: SHA,
  allowed_paths: ['src/x.mjs'],
  shared_paths: ['bin/agentbridge.mjs'],
  forbidden_paths: ['package.json'],
  state: 'assigned',
  head_sha: null,
  audit: null,
  history: [],
  ...over,
});

/** Minimal store; delegations optional so absence can be tested. */
function storeWith(delegations) {
  const s = { listSessions: async () => [], getLanes: async () => ({}) };
  if (delegations) s.listDelegations = async () => delegations;
  return s;
}

/** Registered tool names, read off the server the SDK actually built. */
function toolNames(server) {
  const reg = server._registeredTools ?? server.registeredTools ?? {};
  return Object.keys(reg);
}

/** Invoke a registered tool and parse the JSON payload back out. */
async function call(server, name, args = {}) {
  const reg = server._registeredTools ?? server.registeredTools ?? {};
  const tool = reg[name];
  assert.ok(tool, `tool ${name} is not registered`);
  // `handler`, not `callback` — the SDK renamed it. Asserted rather than
  // optional-chained: a helper that silently finds no function would make
  // every test below pass on undefined.
  assert.equal(typeof tool.handler, 'function', `tool ${name} has no handler`);
  const res = await tool.handler(args, {});
  return JSON.parse(res.content[0].text);
}

test('a store WITHOUT delegations does not advertise the tools', () => {
  // The loud half of conditional registration. A tool that always exists and
  // throws for half its callers is worse than an absent one: the model cannot
  // tell a broken server from an unsupported backend.
  const names = toolNames(buildMcpServer(storeWith(null)));
  assert.equal(names.includes('list_delegations'), false);
  assert.equal(names.includes('get_delegation'), false);
  assert.ok(names.includes('list_agents'), 'the state tools must still be there');
});

test('a store WITH delegations advertises both tools', () => {
  const names = toolNames(buildMcpServer(storeWith([del()])));
  assert.ok(names.includes('list_delegations'));
  assert.ok(names.includes('get_delegation'));
});

test('list_delegations defaults to outstanding work only', async () => {
  const server = buildMcpServer(storeWith([
    del({ id: 'd-open', state: 'assigned' }),
    del({ id: 'd-rework', state: 'rejected' }),
    del({ id: 'd-done', state: 'accepted' }),
    del({ id: 'd-gone', state: 'withdrawn' }),
  ]));
  const ids = (await call(server, 'list_delegations')).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['d-open', 'd-rework']);
});

test('list_delegations includeAll shows finished work too', async () => {
  const server = buildMcpServer(storeWith([
    del({ id: 'd-open' }), del({ id: 'd-done', state: 'accepted' }),
  ]));
  const ids = (await call(server, 'list_delegations', { includeAll: true })).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['d-done', 'd-open']);
});

test('list_delegations filters by session and never returns another session\'s contract', async () => {
  const server = buildMcpServer(storeWith([
    del({ id: 'd-mine', assigned_session: 'worker' }),
    del({ id: 'd-theirs', assigned_session: 'worker-2' }),
  ]));
  const ids = (await call(server, 'list_delegations', { session: 'worker' })).map((d) => d.id);
  assert.deepEqual(ids, ['d-mine']);
});

test('the contract bounds are carried, not summarised away', async () => {
  // These four fields are the whole reason to read this instead of a pasted
  // brief. A row without them would send an agent to look somewhere else.
  const server = buildMcpServer(storeWith([del()]));
  const [row] = await call(server, 'list_delegations');
  assert.equal(row.baseSha, SHA);
  assert.deepEqual(row.allowedPaths, ['src/x.mjs']);
  assert.deepEqual(row.sharedPaths, ['bin/agentbridge.mjs']);
  assert.deepEqual(row.forbiddenPaths, ['package.json']);
});

test('get_delegation returns the full record including audit evidence', async () => {
  const audit = { ok: false, violations: ['package.json'], checked: 3 };
  const server = buildMcpServer(storeWith([del({ id: 'd-bad', audit })]));
  const got = await call(server, 'get_delegation', { id: 'd-bad' });
  assert.deepEqual(got.audit, audit, 'audit evidence was abbreviated');
  assert.ok(Array.isArray(got.history));
});

test('get_delegation reports a miss as a miss, not as an empty contract', async () => {
  const server = buildMcpServer(storeWith([del()]));
  const got = await call(server, 'get_delegation', { id: 'nope' });
  assert.equal(got.error, 'no such delegation');
});

test('the server instructions tell a client to query before asking a person', () => {
  // This string is the only instruction a hosted client ever receives. If the
  // operating rule is not in it, it does not exist for ChatGPT.
  const server = buildMcpServer(storeWith([del()]));
  const text = server.server?._instructions ?? server._instructions ?? '';
  assert.match(text, /QUERY THIS SERVER BEFORE ASKING A PERSON/);
  assert.match(text, /SPEAK ONLY TO WHAT CHANGED/);
  assert.match(text, /NEVER ABBREVIATED/, 'the evidence exemption is missing');
});
