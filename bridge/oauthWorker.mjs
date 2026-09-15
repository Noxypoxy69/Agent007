import {
  sha256Hex, randomToken, timingSafeEqual, protectedResourceMetadata,
  authorizationServerMetadata, verifyPkce, redirectAllowed,
} from './oauth.mjs';

/**
 * THE PUBLIC FRONT DOOR: OAuth 2.1 + MCP, on an origin we control.
 *
 * ChatGPT will not accept a raw bearer key. It discovers an authorization
 * server at the origin root, registers itself, and runs an authorization-code
 * flow with PKCE. Supabase Edge Functions are served under /functions/v1/<name>
 * and can never answer at an origin root, so discovery had to move here.
 *
 *   this Worker            OAuth + MCP facade, public
 *   Supabase Edge Function data plane, reached with the bridge reader token
 *
 * The Worker holds ONE credential -- the reader token -- and it is the same
 * least-privilege token any other client would get. The database service key
 * stays inside Supabase and is never copied here, so a compromise of this
 * Worker yields read access to coordination state and nothing else.
 *
 * TOKENS ARE STORED AS DIGESTS. KV holds sha256(token), never the token. A dump
 * of the namespace yields nothing usable.
 */

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });

const ACCESS_TTL = 60 * 60;            // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 300;                  // 5 minutes — codes are single use and short

/*
 * CORS, deliberately narrow in what it permits and wide in who may ask.
 *
 * A preflight carries no Authorization header by definition, so it MUST be
 * answerable without auth or every browser-based client fails before it starts.
 * Answering it leaks nothing: no body, no state. What is NOT done here is
 * echoing arbitrary headers back -- only the ones this API actually reads.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

/**
 * The 401 that TEACHES A CLIENT WHERE TO GO.
 *
 * RFC 9728: an unauthenticated request must be answered with a WWW-Authenticate
 * naming the resource metadata document. Without it a compliant client has no
 * way to discover the authorization server and simply reports "unauthorized",
 * which is the failure that looks like a broken server and is actually a
 * missing header.
 */
const unauthorized = (origin, detail = 'invalid_token') => json(
  { error: detail },
  401,
  {
    'www-authenticate':
      `Bearer realm="agentbridge", error="${detail}", `
      + `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    ...CORS,
  },
);

/**
 * HTML-escape. Everything interpolated into the consent page goes through this.
 *
 * `client_name` arrives from RFC 7591 dynamic client registration, which is
 * UNAUTHENTICATED -- anyone may register a client and choose its name. It was
 * being written into the page raw. That was already a stored XSS; it became a
 * serious one the moment this page started gating WRITE authority, because the
 * thing an injected script sits next to is the operator typing the coordinator
 * token into a password field.
 */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Does this scope string ask for write?
 *
 * Scope is space-delimited per RFC 6749. Matching on exact membership rather
 * than a substring test, so `agentbridge:write-nothing` or a scope that merely
 * CONTAINS the word cannot promote a reader.
 */
export const scopeGrantsWrite = (scope) =>
  String(scope ?? '').split(/\s+/).filter(Boolean).includes('agentbridge:write');

/** Minimal HTML consent page. No framework, no external assets, no script. */
const consentPage = (params, error = '') => new Response(
  `<!doctype html><meta charset="utf-8"><title>Agent Bridge — authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:6vh auto;padding:0 1.25rem;color:#111}
 h1{font-size:1.25rem;margin:0 0 .25rem} p{color:#444}
 .c{border:1px solid #ddd;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0}
 label{display:block;font-weight:600;margin-bottom:.35rem}
 input{width:100%;padding:.6rem;border:1px solid #bbb;border-radius:7px;font:inherit}
 button{margin-top:.9rem;padding:.6rem 1.1rem;border:0;border-radius:7px;background:#111;color:#fff;font:inherit;cursor:pointer}
 .e{color:#b00020;font-weight:600}
 code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}
</style>
<h1>Authorize access to Agent Bridge</h1>
${scopeGrantsWrite(params.scope) ? `
<p><strong>${esc(params.client_name || 'An application')}</strong> is requesting
<code>read and write</code> access. As well as reading coordination state, it will be able to
<strong>assign work to your agents, send them messages, and record owner decisions</strong>.</p>
<p>This needs the <strong>coordinator</strong> token, not the reader token. If you only meant to
let it look, close this page and authorize again without <code>agentbridge:write</code>.</p>`
: `
<p><strong>${esc(params.client_name || 'An application')}</strong> is requesting <code>read-only</code>
access to live coordination state: agents, lanes, branches, worktrees, locks and owner decisions.
It cannot assign work, send messages, or change anything.</p>`}
<div class="c">
  <form method="POST">
    ${Object.entries(params).map(([k, v]) =>
    `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
    <label for="t">Bridge token</label>
    <input id="t" name="bridge_token" type="password" autocomplete="off" autofocus
           placeholder="${scopeGrantsWrite(params.scope)
             ? 'the COORDINATOR token from agentbridge-secrets'
             : 'the reader token from agentbridge-secrets'}">
    ${error ? `<p class="e">${esc(error)}</p>` : ''}
    <button type="submit">Authorize</button>
  </form>
</div>
<p style="color:#777;font-size:13px">${scopeGrantsWrite(params.scope)
  ? 'Approving grants this client read AND write access until you revoke it. It will be able to change coordination state.'
  : 'Approving grants this client read access until you revoke it. Nothing here can write to the database.'}</p>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
);

/**
 * Proxy one MCP JSON-RPC call to the Supabase data plane, AT THE GRANTED SCOPE.
 *
 * THE BEARER FORWARDED HERE IS WHAT DECIDES WHICH TOOLS EXIST. The data plane
 * resolves scope by looking the token up in coordinator_tokens, then
 * reader_tokens, and toolDefs registers a tool only when its method exists for
 * that scope -- so a reader is not refused `assign_task`, it never sees it.
 *
 * This function used to hardcode the reader token. Every OAuth caller was
 * therefore forwarded as a reader no matter what scope it had been granted, and
 * the write tools were invisible to a correctly authorized coordinator. It read
 * as a stale tool list, and no amount of redeploying or refreshing the client
 * could have changed it: the list was correct for the credential being sent.
 */
async function callDataPlane(env, body, write) {
  /*
   * `write` arrives already DECIDED. It used to be a scope string that this
   * function re-evaluated, which meant the write-ness of a request was computed
   * in two places -- here, and again at the 503 guard in the /mcp handler. They
   * read the same field so they agreed, but nothing made them agree, and a
   * mutation test proved it: breaking the handler's copy left the forwarding
   * untouched. Two answers to one question is one bug away from forwarding a
   * credential the guard above already refused.
   */
  const res = await fetch(env.DATA_PLANE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${write ? env.BRIDGE_COORDINATOR_TOKEN : env.BRIDGE_READER_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Pass the upstream status through rather than flattening it. A 502 from the
  // data plane must not arrive at the client as a 200 with an empty result --
  // "the backend is down" and "there is nothing there" are different answers.
  return new Response(text, {
    status: res.status,
    headers: { ...JSON_HEADERS, ...CORS },
  });
}

export function createOAuthHandler(env) {
  const KV = env.OAUTH;

  return async function fetchHandler(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── discovery ──────────────────────────────────────────────────────────
    if (path === '/.well-known/oauth-protected-resource'
        || path === '/.well-known/oauth-protected-resource/mcp') {
      return json(protectedResourceMetadata(origin), 200, CORS);
    }
    if (path === '/.well-known/oauth-authorization-server'
        || path === '/.well-known/openid-configuration') {
      return json(authorizationServerMetadata(origin), 200, CORS);
    }

    if (path === '/v1/health') {
      return json({ ok: true, service: 'agentbridge', runtime: 'worker-oauth' }, 200, CORS);
    }

    // ── RFC 7591 dynamic client registration ───────────────────────────────
    if (path === '/register' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_request' }, 400, CORS); }

      const redirect_uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
      if (!redirect_uris.length) {
        return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' }, 400, CORS);
      }
      // Every redirect must be https, or loopback. An http:// redirect to a
      // non-loopback host would carry the code over the network in clear.
      for (const r of redirect_uris) {
        let u;
        try { u = new URL(r); } catch { return json({ error: 'invalid_redirect_uri' }, 400, CORS); }
        const loopback = ['127.0.0.1', '::1', 'localhost'].includes(u.hostname);
        if (u.protocol !== 'https:' && !loopback) {
          return json({
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uri must be https, or loopback for native clients',
          }, 400, CORS);
        }
      }

      const client_id = randomToken('abc', 16);
      const record = {
        client_id,
        client_name: String(body?.client_name ?? 'unnamed client').slice(0, 120),
        redirect_uris,
        created_at: new Date().toISOString(),
      };
      await KV.put(`client:${client_id}`, JSON.stringify(record));

      // PUBLIC CLIENT, NO SECRET. A connector cannot keep one, and issuing a
      // secret that cannot be kept invites treating it as a control. PKCE is
      // what binds the code instead.
      return json({
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: record.client_name,
      }, 201, CORS);
    }

    // ── authorization endpoint ─────────────────────────────────────────────
    if (path === '/authorize') {
      const q = request.method === 'POST'
        ? Object.fromEntries(await request.formData())
        : Object.fromEntries(url.searchParams);

      const clientRaw = q.client_id ? await KV.get(`client:${q.client_id}`) : null;
      if (!clientRaw) return json({ error: 'invalid_client' }, 400, CORS);
      const client = JSON.parse(clientRaw);

      /*
       * A BAD redirect_uri IS SHOWN TO THE OPERATOR, NEVER REDIRECTED TO.
       * Redirecting an error to an unverified URI is how an attacker turns this
       * endpoint into an open redirector.
       */
      if (!redirectAllowed(client.redirect_uris, q.redirect_uri)) {
        return json({ error: 'invalid_redirect_uri' }, 400, CORS);
      }
      if (q.response_type !== 'code') {
        return json({ error: 'unsupported_response_type' }, 400, CORS);
      }
      if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
        return json({
          error: 'invalid_request',
          error_description: 'PKCE with S256 is required',
        }, 400, CORS);
      }

      /*
       * EVERY VALIDATED PARAMETER IS CARRIED THROUGH THE FORM.
       *
       * response_type was missing from this object, so the consent page did not
       * round-trip it and the POST failed its own `response_type !== 'code'`
       * check with unsupported_response_type -- a request that had just passed
       * that very check on the GET. The validation is re-run on POST
       * deliberately (a POST can be made directly, without ever loading the
       * page), which means the form has to carry everything the check reads.
       */
      const params = {
        client_id: q.client_id,
        client_name: client.client_name,
        redirect_uri: q.redirect_uri,
        response_type: 'code',
        state: q.state ?? '',
        code_challenge: q.code_challenge,
        code_challenge_method: q.code_challenge_method,
        scope: q.scope ?? 'agentbridge:read',
      };

      if (request.method === 'GET') return consentPage(params);

      /*
       * POST: the operator submitted the consent form.
       *
       * WHICH SECRET APPROVES WHICH SCOPE. A read grant is approved with the
       * reader token; a WRITE grant requires the coordinator token. The two are
       * different secrets on purpose -- approving "this client may direct my
       * agents" must not be possible with the credential that only ever meant
       * "this client may look".
       *
       * The scope is re-derived from the submitted form here rather than
       * trusted from the GET, and that is safe in the only direction that
       * matters: a caller who POSTs directly asking for write is asking to be
       * held to the HIGHER bar, not a lower one.
       */
      const wantsWrite = scopeGrantsWrite(params.scope);
      const expected = wantsWrite ? env.BRIDGE_COORDINATOR_TOKEN : env.BRIDGE_READER_TOKEN;

      /*
       * AN UNCONFIGURED SECRET APPROVES NOTHING.
       *
       * timingSafeEqual compares byte-for-byte after a length check, so an
       * EMPTY expected secret matches an empty submission -- a blank field
       * would approve the grant. That is not hypothetical on a Workers
       * deployment, where a secret that was never set and a secret set to the
       * empty string are the same observable state.
       *
       * This guard originally covered only the coordinator token, which left
       * the read path able to be approved by anyone against an unconfigured
       * deployment. Both are checked here because the asymmetry was the bug:
       * the weaker path is the one nobody re-reads.
       */
      if (!expected) {
        return consentPage(params, wantsWrite
          ? 'This deployment has no coordinator token configured, so write access cannot be granted.'
          : 'This deployment has no bridge token configured, so nothing can be authorized.');
      }
      if (!timingSafeEqual(q.bridge_token ?? '', expected)) {
        // Re-render rather than redirect. A wrong token is the operator
        // mistyping, not the client misbehaving.
        return consentPage(params, wantsWrite
          ? 'That is not the coordinator token. Write access needs the coordinator token, not the reader one.'
          : 'That token does not match. Check agentbridge-secrets.');
      }

      /*
       * AUTHORIZING A CLIENT CLEARS ITS REVOCATION.
       *
       * Otherwise a revoked client that the operator deliberately lets back in
       * would authorize successfully, receive a token, and be refused at /mcp
       * with no explanation anywhere. Revoked means "until you let it back in".
       */
      await KV.delete(`revoked:${params.client_id}`);

      const code = randomToken('abg', 32);
      await KV.put(`code:${await sha256Hex(code)}`, JSON.stringify({
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        scope: params.scope,
      }), { expirationTtl: CODE_TTL });

      const to = new URL(params.redirect_uri);
      to.searchParams.set('code', code);
      if (params.state) to.searchParams.set('state', params.state);
      return new Response(null, { status: 302, headers: { location: to.toString(), ...CORS } });
    }

    // ── token endpoint ─────────────────────────────────────────────────────
    if (path === '/token' && request.method === 'POST') {
      let form;
      try { form = Object.fromEntries(await request.formData()); }
      catch { return json({ error: 'invalid_request' }, 400, CORS); }

      if (form.grant_type === 'authorization_code') {
        const key = `code:${await sha256Hex(form.code ?? '')}`;
        const raw = await KV.get(key);
        if (!raw) return json({ error: 'invalid_grant' }, 400, CORS);
        // SINGLE USE. Delete before issuing, so a replay in flight cannot
        // redeem the same code twice.
        await KV.delete(key);

        const rec = JSON.parse(raw);
        if (rec.client_id !== form.client_id) return json({ error: 'invalid_grant' }, 400, CORS);
        if (rec.redirect_uri !== form.redirect_uri) return json({ error: 'invalid_grant' }, 400, CORS);
        if (!await verifyPkce(form.code_verifier, rec.code_challenge, rec.code_challenge_method)) {
          return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400, CORS);
        }

        const access = randomToken('aba', 32);
        const refresh = randomToken('abr', 32);
        await KV.put(`tok:${await sha256Hex(access)}`,
          JSON.stringify({ client_id: rec.client_id, scope: rec.scope }),
          { expirationTtl: ACCESS_TTL });
        await KV.put(`ref:${await sha256Hex(refresh)}`,
          JSON.stringify({ client_id: rec.client_id, scope: rec.scope }),
          { expirationTtl: REFRESH_TTL });

        return json({
          access_token: access,
          token_type: 'Bearer',
          expires_in: ACCESS_TTL,
          refresh_token: refresh,
          scope: rec.scope,
        }, 200, CORS);
      }

      if (form.grant_type === 'refresh_token') {
        const key = `ref:${await sha256Hex(form.refresh_token ?? '')}`;
        const raw = await KV.get(key);
        if (!raw) return json({ error: 'invalid_grant' }, 400, CORS);
        const rec = JSON.parse(raw);

        // ROTATE. The presented refresh token is retired as it is redeemed, so
        // a stolen one is usable at most once and the theft shows up as the
        // legitimate client being logged out.
        await KV.delete(key);
        const access = randomToken('aba', 32);
        const refresh = randomToken('abr', 32);
        await KV.put(`tok:${await sha256Hex(access)}`, JSON.stringify(rec), { expirationTtl: ACCESS_TTL });
        await KV.put(`ref:${await sha256Hex(refresh)}`, JSON.stringify(rec), { expirationTtl: REFRESH_TTL });

        return json({
          access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL,
          refresh_token: refresh, scope: rec.scope,
        }, 200, CORS);
      }

      return json({ error: 'unsupported_grant_type' }, 400, CORS);
    }

    /*
     * ── revocation ────────────────────────────────────────────────────────
     *
     * The consent page has always said a grant lasts "until you revoke it".
     * There was no way to revoke it. Access tokens expire, but refresh rotates
     * indefinitely, so a client that keeps refreshing keeps its grant forever
     * and the only lever was rotating the bridge secret -- which cuts off every
     * client at once and is nobody's idea of revocation.
     *
     * That was tolerable while every grant was read-only. It stopped being
     * tolerable the moment a grant could carry write.
     *
     * TWO CALLERS, TWO SHAPES:
     *
     *   token=<access or refresh>     RFC 7009. The token is its own credential;
     *                                 a client retires its own grant. Always
     *                                 200, even for an unknown token -- the
     *                                 spec is explicit, and answering
     *                                 differently turns this into an oracle for
     *                                 guessing valid tokens.
     *
     *   client_id + bridge_token      The operator cutting a client off, which
     *                                 is the one that makes the page honest.
     *                                 Needs a bridge secret because it acts on
     *                                 somebody else's grant.
     *
     * Operator revocation is a BLOCK, not a delete: a client's live tokens are
     * not enumerable from KV, so the mark is checked at /mcp instead. It is
     * cleared when that client is authorized again, so "revoked" means "until
     * you let it back in", not "banned forever".
     */
    if (path === '/revoke' && request.method === 'POST') {
      let form;
      try { form = Object.fromEntries(await request.formData()); }
      catch { return json({ error: 'invalid_request' }, 400, CORS); }

      if (form.client_id) {
        const secrets = [env.BRIDGE_COORDINATOR_TOKEN, env.BRIDGE_READER_TOKEN].filter(Boolean);
        const ok = secrets.some((s) => timingSafeEqual(form.bridge_token ?? '', s));
        if (!ok) return json({ error: 'invalid_request' }, 401, CORS);

        await KV.put(`revoked:${form.client_id}`, new Date().toISOString());
        return json({ revoked: form.client_id }, 200, CORS);
      }

      if (form.token) {
        const h = await sha256Hex(form.token);
        // The hint is advisory; delete both rather than trust it.
        await KV.delete(`tok:${h}`);
        await KV.delete(`ref:${h}`);
      }
      return json({}, 200, CORS);
    }

    // ── the MCP resource itself ────────────────────────────────────────────
    if (path === '/mcp') {
      const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!bearer) return unauthorized(origin, 'invalid_request');

      const grant = await KV.get(`tok:${await sha256Hex(bearer)}`);
      if (!grant) return unauthorized(origin, 'invalid_token');

      if (request.method !== 'POST') {
        // Spec-correct: no SSE stream is offered at this endpoint.
        return json({ error: 'method-not-allowed' }, 405, CORS);
      }

      /*
       * THE SCOPE COMES FROM THE STORED GRANT, never from the request.
       *
       * It is what the operator approved at the consent page with the matching
       * secret. A client cannot widen its own access by asking differently on a
       * later call -- the only way to hold a write grant is to have had one
       * issued.
       */
      let granted;
      try { granted = JSON.parse(grant); } catch { return unauthorized(origin, 'invalid_token'); }

      /*
       * A REVOKED CLIENT IS CHECKED HERE, not at the token endpoint.
       *
       * Its outstanding access tokens are not enumerable from KV, so deleting
       * the grant is not available; the mark has to be consulted on use. This
       * is the cost of revocation actually working -- one extra KV read per
       * call -- and it is what makes the consent page's promise true.
       */
      if (granted?.client_id && await KV.get(`revoked:${granted.client_id}`)) {
        return unauthorized(origin, 'invalid_token');
      }

      const write = scopeGrantsWrite(granted?.scope);

      if (!env.BRIDGE_READER_TOKEN || !env.DATA_PLANE_URL) {
        // Misconfiguration must not read as an auth failure.
        return json({ error: 'not-configured' }, 503, CORS);
      }
      if (write && !env.BRIDGE_COORDINATOR_TOKEN) {
        // A write grant with no coordinator token to forward. Refusing loudly
        // beats falling back to the reader, which would answer every write tool
        // with "no such tool" and send whoever is debugging it back to the
        // client's tool list -- where there is nothing to find.
        return json({ error: 'not-configured', detail: 'write grant but no coordinator token' }, 503, CORS);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400, CORS); }

      return callDataPlane(env, body, write);
    }

    // Unknown paths answer identically and reveal no route map.
    return json({ error: 'not-found' }, 404, CORS);
  };
}

export default {
  fetch(request, env) {
    return createOAuthHandler(env)(request);
  },
};
