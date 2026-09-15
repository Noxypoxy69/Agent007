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
<p><strong>${params.client_name || 'An application'}</strong> is requesting <code>read-only</code>
access to live coordination state: agents, lanes, branches, worktrees, locks and owner decisions.
It cannot assign work, send messages, or change anything.</p>
<div class="c">
  <form method="POST">
    ${Object.entries(params).map(([k, v]) =>
    `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`).join('')}
    <label for="t">Bridge token</label>
    <input id="t" name="bridge_token" type="password" autocomplete="off" autofocus
           placeholder="the reader token from agentbridge-secrets">
    ${error ? `<p class="e">${error}</p>` : ''}
    <button type="submit">Authorize</button>
  </form>
</div>
<p style="color:#777;font-size:13px">Approving grants this client read access until you revoke it.
Nothing here can write to the database.</p>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
);

/** Proxy one MCP JSON-RPC call to the Supabase data plane. */
async function callDataPlane(env, body) {
  const res = await fetch(env.DATA_PLANE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.BRIDGE_READER_TOKEN}`,
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

      // POST: the operator submitted the consent form.
      if (!timingSafeEqual(q.bridge_token ?? '', env.BRIDGE_READER_TOKEN)) {
        // Re-render rather than redirect. A wrong token is the operator
        // mistyping, not the client misbehaving.
        return consentPage(params, 'That token does not match. Check agentbridge-secrets.');
      }

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

      if (!env.BRIDGE_READER_TOKEN || !env.DATA_PLANE_URL) {
        // Misconfiguration must not read as an auth failure.
        return json({ error: 'not-configured' }, 503, CORS);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400, CORS); }

      return callDataPlane(env, body);
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
