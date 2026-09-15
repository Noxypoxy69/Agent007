/**
 * OAUTH 2.1 FOR THE HOSTED MCP SURFACE.
 *
 * ChatGPT (and every other MCP client that follows the remote-auth spec) will
 * not take a raw bearer key. It expects to DISCOVER an authorization server,
 * register itself, and complete an authorization-code flow with PKCE. This is
 * that server.
 *
 * WHY IT LIVES ON THE WORKER AND NOT IN THE SUPABASE FUNCTION. Discovery is
 * defined at the ROOT of the origin -- /.well-known/oauth-protected-resource
 * and /.well-known/oauth-authorization-server. A Supabase Edge Function is
 * served under /functions/v1/<name>/, so it can never answer at the origin
 * root, and a client that looks there finds nothing. The Worker owns its whole
 * origin, so it can. The Supabase function remains the DATA plane; this is the
 * front door.
 *
 * WHAT AUTHORISES A GRANT. There are no user accounts here, and inventing some
 * would be a second identity system for one operator. Instead the /authorize
 * step asks for the bridge reader token -- the secret the operator already
 * holds -- and issues a code only if it matches. Possession of that token IS
 * the authorisation to grant access, which is exactly what it means today.
 *
 * PKCE IS REQUIRED, NOT OPTIONAL. Clients here are public (no client secret
 * can be kept in a browser or a connector), so the code challenge is the only
 * thing binding the redeemed code to the client that requested it. `plain` is
 * refused: it is trivially forgeable and its presence in a spec is a
 * compatibility artefact, not a choice.
 *
 * EVERY TOKEN IS STORED AS A DIGEST, never as the value. A dump of the KV
 * namespace yields nothing usable. That is the same rule the reader tokens
 * already follow.
 */

const enc = new TextEncoder();

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64url of raw bytes, no padding. */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomToken = (prefix, bytes = 32) =>
  `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(bytes)))}`;

/**
 * Constant-time string compare.
 *
 * The operator's token is compared here on every /authorize submission. A
 * plain === leaks length and prefix through timing, and while that is a thin
 * channel it costs nothing to close.
 */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** RFC 9728 — protected resource metadata. Points the client at the AS. */
export const protectedResourceMetadata = (origin) => ({
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  bearer_methods_supported: ['header'],
  scopes_supported: ['agentbridge:read'],
  resource_documentation: `${origin}/v1/health`,
});

/** RFC 8414 — authorization server metadata. */
export const authorizationServerMetadata = (origin) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  registration_endpoint: `${origin}/register`,
  scopes_supported: ['agentbridge:read'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  // S256 ONLY. `plain` is a forgeable challenge and is deliberately absent.
  code_challenge_methods_supported: ['S256'],
});

/**
 * Verify a PKCE verifier against the stored challenge.
 *
 * Only S256. A stored challenge with any other method is treated as
 * unverifiable rather than as "no challenge" -- failing closed, because the
 * alternative is accepting a code whose binding was never checked.
 */
export async function verifyPkce(verifier, challenge, method) {
  if (method !== 'S256') return false;
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(new Uint8Array(digest)) === challenge;
}

/**
 * Is this redirect_uri acceptable for this client?
 *
 * EXACT MATCH ONLY, against what the client registered. Prefix matching is how
 * an open redirector becomes an account takeover: a client registering
 * https://example.com/cb would otherwise accept
 * https://example.com/cb.attacker.test. Loopback is allowed to vary by PORT
 * only, which is the one exception RFC 8252 carves out for native apps.
 */
export function redirectAllowed(registered, candidate) {
  if (!Array.isArray(registered) || !candidate) return false;
  if (registered.includes(candidate)) return true;

  let c;
  try { c = new URL(candidate); } catch { return false; }
  if (c.hostname !== '127.0.0.1' && c.hostname !== '::1' && c.hostname !== 'localhost') return false;

  return registered.some((r) => {
    let u;
    try { u = new URL(r); } catch { return false; }
    return u.hostname === c.hostname && u.pathname === c.pathname && u.protocol === c.protocol;
  });
}
