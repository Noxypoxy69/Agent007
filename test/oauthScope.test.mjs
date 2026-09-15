import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler, scopeGrantsWrite } from '../bridge/oauthWorker.mjs';
import { sha256Hex } from '../bridge/oauth.mjs';

/**
 * WHICH CREDENTIAL THE WORKER FORWARDS IS WHICH TOOLS EXIST.
 *
 * The data plane resolves scope by looking the bearer up in coordinator_tokens,
 * then reader_tokens, and registers a tool only when its method exists for that
 * scope. So a reader is not REFUSED `assign_task` -- the tool is never defined,
 * and `tools/list` simply comes back shorter.
 *
 * callDataPlane hardcoded the reader token. Every OAuth caller was therefore
 * forwarded as a reader regardless of the scope it had been granted, and the
 * write tools were invisible to a correctly authorized coordinator. From the
 * client it looked like a stale tool list, so the obvious remedies were to
 * redeploy the data plane and refresh the app -- neither of which could ever
 * have worked, because the list was CORRECT for the credential being sent. A
 * whole debugging session went into the wrong half of the system.
 *
 * Nothing in this repository tested the worker. These assertions exist so that
 * the next person to touch the proxy finds out from a test rather than from a
 * coordinator that can see the fleet and cannot speak to it.
 */

const READER = 'reader-token-xyz';
const COORD = 'coordinator-token-abc';
const DATA_PLANE = 'https://data-plane.invalid/mcp';

/** The smallest thing that behaves like a Workers KV namespace. */
function kv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    _map: m,
  };
}

/** Capture what the worker forwards upstream, and answer plausibly. */
function captureFetch(t) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization, body: init?.body });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

const envWith = (over = {}) => ({
  OAUTH: kv(),
  DATA_PLANE_URL: DATA_PLANE,
  BRIDGE_READER_TOKEN: READER,
  BRIDGE_COORDINATOR_TOKEN: COORD,
  ...over,
});

/** Put a live access token in KV carrying `scope`, and return the bearer. */
async function grant(env, scope) {
  const bearer = 'aba_test_token';
  await env.OAUTH.put(`tok:${await sha256Hex(bearer)}`,
    JSON.stringify({ client_id: 'c1', scope }));
  return bearer;
}

const mcpCall = (bearer) => new Request('https://bridge.invalid/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

// ── the bug ────────────────────────────────────────────────────────────────
test('a READ grant is forwarded with the reader token', async (t) => {
  const env = envWith();
  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:read');

  const res = await createOAuthHandler(env)(mcpCall(bearer));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'the call must actually reach the data plane');
  assert.equal(calls[0].authorization, `Bearer ${READER}`);
});

test('a WRITE grant is forwarded with the COORDINATOR token', async (t) => {
  // THE REGRESSION. This forwarded the reader token, so ChatGPT held a write
  // grant and still saw nine read tools and no way to act on any of them.
  const env = envWith();
  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:read agentbridge:write');

  const res = await createOAuthHandler(env)(mcpCall(bearer));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${COORD}`,
    'a write grant forwarded as a reader makes every write tool silently non-existent');
});

test('the scope comes from the stored grant, never from the request', async (t) => {
  /*
   * A client holding a read grant must not be able to widen it by asking
   * differently on a later call. The only way to hold write is to have been
   * issued it at the consent page, against the coordinator secret.
   */
  const env = envWith();
  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:read');

  const req = new Request('https://bridge.invalid/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      // Both of these are ignored: scope lives in KV, not on the wire.
      scope: 'agentbridge:write',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', scope: 'agentbridge:write' }),
  });
  await createOAuthHandler(env)(req);

  assert.equal(calls[0].authorization, `Bearer ${READER}`);
});

test('a write grant with no coordinator token configured REFUSES rather than downgrading', async (t) => {
  /*
   * Falling back to the reader here would answer every write tool with
   * "no such tool" and send whoever is debugging it to the client's tool list,
   * where there is nothing to find. That is the exact failure this file exists
   * to document, reintroduced as a fallback.
   */
  const env = envWith({ BRIDGE_COORDINATOR_TOKEN: '' });
  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:write');

  const res = await createOAuthHandler(env)(mcpCall(bearer));

  assert.equal(res.status, 503);
  assert.equal(calls.length, 0, 'nothing may be forwarded when the grant cannot be honoured');
});

// ── scope parsing ──────────────────────────────────────────────────────────
test('scopeGrantsWrite matches an exact scope, not a substring', () => {
  assert.equal(scopeGrantsWrite('agentbridge:write'), true);
  assert.equal(scopeGrantsWrite('agentbridge:read agentbridge:write'), true);
  assert.equal(scopeGrantsWrite('agentbridge:read'), false);
  assert.equal(scopeGrantsWrite(''), false);
  assert.equal(scopeGrantsWrite(null), false);
  assert.equal(scopeGrantsWrite(undefined), false);
  // A scope that merely CONTAINS the word must not promote a reader.
  assert.equal(scopeGrantsWrite('agentbridge:write-nothing'), false);
  assert.equal(scopeGrantsWrite('notagentbridge:write'), false);
});

// ── the consent gate ───────────────────────────────────────────────────────
const client = { client_id: 'c1', client_name: 'Test Client', redirect_uris: ['https://app.invalid/cb'] };

async function withClient(over = {}) {
  const env = envWith(over);
  await env.OAUTH.put('client:c1', JSON.stringify(client));
  return env;
}

const authorizePost = (bridge_token, scope) => new Request('https://bridge.invalid/authorize', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: 'c1',
    redirect_uri: 'https://app.invalid/cb',
    response_type: 'code',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    scope,
    bridge_token,
  }),
});

test('the READER token cannot approve a WRITE grant', async () => {
  // Approving "this client may direct my agents" must not be possible with the
  // credential that only ever meant "this client may look".
  const env = await withClient();
  const res = await createOAuthHandler(env)(authorizePost(READER, 'agentbridge:write'));

  assert.equal(res.status, 200, 'the consent page is re-rendered, not redirected');
  const html = await res.text();
  assert.match(html, /not the coordinator token/);
  // No code was issued.
  assert.equal([...env.OAUTH._map.keys()].filter((k) => k.startsWith('code:')).length, 0);
});

test('the COORDINATOR token approves a write grant, and the code carries the scope', async () => {
  const env = await withClient();
  const res = await createOAuthHandler(env)(authorizePost(COORD, 'agentbridge:read agentbridge:write'));

  assert.equal(res.status, 302);
  const codes = [...env.OAUTH._map.entries()].filter(([k]) => k.startsWith('code:'));
  assert.equal(codes.length, 1);
  assert.equal(JSON.parse(codes[0][1]).scope, 'agentbridge:read agentbridge:write');
});

test('the reader token still approves a read grant, unchanged', async () => {
  // The read path is what everything already working depends on.
  const env = await withClient();
  const res = await createOAuthHandler(env)(authorizePost(READER, 'agentbridge:read'));
  assert.equal(res.status, 302);
});

test('the COORDINATOR token is not accepted for a read grant either', async () => {
  /*
   * Each secret approves its own scope. Letting the stronger credential stand
   * in for the weaker one sounds harmless, but it means the coordinator token
   * gets typed into this page routinely -- and the whole point of separating
   * them is that it should be rare and deliberate.
   */
  const env = await withClient();
  const res = await createOAuthHandler(env)(authorizePost(COORD, 'agentbridge:read'));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /does not match/);
});

// ── what the server tells clients it supports ──────────────────────────────
test('BOTH metadata documents advertise the write scope', async () => {
  /*
   * A spec-compliant client reads these to decide what it may request, so a
   * write scope that is implemented but not ADVERTISED is one nobody can
   * obtain. Both documents said read-only while the worker was being taught to
   * forward a coordinator token, and the symptom would have been a coordinator
   * that completes OAuth and still sees only the read tools -- identical from
   * outside to the forwarding bug that had just been fixed.
   *
   * Found by auditing the change rather than by running it, which is the only
   * way this one surfaces before a deploy.
   */
  const env = envWith();
  const handler = createOAuthHandler(env);

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
    const res = await handler(new Request(`https://bridge.invalid${path}`));
    assert.equal(res.status, 200, path);
    const doc = await res.json();
    assert.ok(doc.scopes_supported.includes('agentbridge:read'), `${path} must still offer read`);
    assert.ok(doc.scopes_supported.includes('agentbridge:write'),
      `${path} does not advertise write, so no client will ever ask for it`);
  }
});

// ── an unconfigured deployment approves nothing ────────────────────────────
test('an EMPTY expected secret approves nothing, on either path', async () => {
  /*
   * timingSafeEqual compares after a length check, so '' === '' is a match: a
   * blank field would approve the grant against a deployment whose secret was
   * never set. On Workers, "never set" and "set to empty" are the same state.
   *
   * The guard originally covered the coordinator token only, leaving the READ
   * path approvable by anyone on an unconfigured deployment. The weaker path is
   * the one nobody re-reads, which is exactly why it is asserted here.
   */
  for (const [scope, over] of [
    ['agentbridge:read', { BRIDGE_READER_TOKEN: '' }],
    ['agentbridge:write', { BRIDGE_COORDINATOR_TOKEN: '' }],
  ]) {
    const env = await withClient(over);
    const res = await createOAuthHandler(env)(authorizePost('', scope));

    assert.equal(res.status, 200, `${scope}: must re-render, not redirect`);
    assert.match(await res.text(), /no (coordinator|bridge) token configured/);
    assert.equal([...env.OAUTH._map.keys()].filter((k) => k.startsWith('code:')).length, 0,
      `${scope}: a blank submission issued a code against an unconfigured secret`);
  }
});

// ── revocation: making the consent page's promise true ─────────────────────
test('the operator can revoke a client, and its live token stops working', async (t) => {
  /*
   * The page has always said a grant lasts "until you revoke it" and there was
   * no way to revoke it. Access tokens expire but refresh rotates forever, so
   * the only lever was rotating the bridge secret -- which cuts off every
   * client at once. Tolerable while every grant was read-only; not once a
   * grant can carry write.
   */
  const env = await withClient();
  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:read agentbridge:write');
  const handler = createOAuthHandler(env);

  // Positive control first: the grant works before it is revoked, or the
  // assertion below proves nothing.
  assert.equal((await handler(mcpCall(bearer))).status, 200);
  assert.equal(calls.length, 1);

  const rev = await handler(new Request('https://bridge.invalid/revoke', {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'c1', bridge_token: COORD }),
  }));
  assert.equal(rev.status, 200);

  const after = await handler(mcpCall(bearer));
  assert.equal(after.status, 401, 'a revoked client must not still be served');
  assert.equal(calls.length, 1, 'nothing may be forwarded on behalf of a revoked client');
});

test('revoking someone else\'s client needs a bridge secret', async () => {
  const env = await withClient();
  const res = await createOAuthHandler(env)(new Request('https://bridge.invalid/revoke', {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'c1', bridge_token: 'guess' }),
  }));
  assert.equal(res.status, 401);
  assert.equal(await env.OAUTH.get('revoked:c1'), null);
});

test('authorizing a revoked client lets it back in', async (t) => {
  // Otherwise the operator re-approves a client, it gets a token, and it is
  // refused at /mcp with no explanation anywhere.
  const env = await withClient();
  const handler = createOAuthHandler(env);
  await env.OAUTH.put('revoked:c1', new Date().toISOString());

  assert.equal((await handler(authorizePost(READER, 'agentbridge:read'))).status, 302);
  assert.equal(await env.OAUTH.get('revoked:c1'), null);

  const calls = captureFetch(t);
  const bearer = await grant(env, 'agentbridge:read');
  assert.equal((await handler(mcpCall(bearer))).status, 200);
  assert.equal(calls.length, 1);
});

test('RFC 7009: a client retires its own token, and an unknown token still answers 200', async () => {
  /*
   * The spec is explicit that revocation answers 200 for a token it does not
   * recognise. Answering differently turns this endpoint into an oracle for
   * guessing valid tokens.
   */
  const env = envWith();
  const handler = createOAuthHandler(env);
  const bearer = await grant(env, 'agentbridge:read');

  const res = await handler(new Request('https://bridge.invalid/revoke', {
    method: 'POST', body: new URLSearchParams({ token: bearer }),
  }));
  assert.equal(res.status, 200);
  assert.equal(await env.OAUTH.get(`tok:${await sha256Hex(bearer)}`), null);

  const unknown = await handler(new Request('https://bridge.invalid/revoke', {
    method: 'POST', body: new URLSearchParams({ token: 'never-issued' }),
  }));
  assert.equal(unknown.status, 200, 'an unknown token must not be distinguishable');
});

test('the revocation endpoint is advertised', async () => {
  const res = await createOAuthHandler(envWith())(
    new Request('https://bridge.invalid/.well-known/oauth-authorization-server'));
  const doc = await res.json();
  assert.equal(doc.revocation_endpoint, 'https://bridge.invalid/revoke');
});

// ── the page that now guards the coordinator secret ────────────────────────
test('client_name is escaped: registration is unauthenticated and the name is attacker-chosen', async () => {
  /*
   * RFC 7591 registration needs no credential, so anyone may register a client
   * called anything. This was rendered raw. It was already a stored XSS; it
   * became a serious one when this page started gating write authority, because
   * what an injected script sits next to is the operator typing the coordinator
   * token into a password field.
   */
  const env = envWith();
  await env.OAUTH.put('client:c1', JSON.stringify({
    ...client,
    client_name: '<script>steal()</script>',
  }));

  /*
   * BOTH BRANCHES. The page renders different copy for a read grant and a
   * write grant, and the first version of this test only exercised the read
   * one -- so a mutation that stopped escaping on the WRITE page passed. The
   * write page is the more dangerous of the two by exactly the margin that
   * matters: it is the one that asks for the coordinator token.
   */
  const handler = createOAuthHandler(env);
  for (const scope of ['agentbridge:read', 'agentbridge:write']) {
    const res = await handler(new Request(
      'https://bridge.invalid/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fapp.invalid%2Fcb'
      + '&response_type=code&code_challenge=' + 'x'.repeat(43)
      + '&code_challenge_method=S256&scope=' + encodeURIComponent(scope)));

    const html = await res.text();
    assert.doesNotMatch(html, /<script>steal/, `unescaped client_name on the ${scope} page`);
    assert.match(html, /&lt;script&gt;/, `expected escaped name on the ${scope} page`);
  }
});

test('the consent page tells the operator which authority it is granting', async () => {
  // A page that says "Nothing here can write to the database" while granting
  // write is worse than no page at all.
  const env = await withClient();
  const handler = createOAuthHandler(env);
  const page = async (scope) => (await handler(new Request(
    'https://bridge.invalid/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fapp.invalid%2Fcb'
    + '&response_type=code&code_challenge=' + 'x'.repeat(43)
    + '&code_challenge_method=S256&scope=' + encodeURIComponent(scope)))).text();

  const read = await page('agentbridge:read');
  assert.match(read, /read-only/);
  assert.match(read, /Nothing here can write/);

  const write = await page('agentbridge:write');
  assert.match(write, /assign work to your agents/);
  assert.match(write, /coordinator/);
  assert.doesNotMatch(write, /Nothing here can write/);
});
