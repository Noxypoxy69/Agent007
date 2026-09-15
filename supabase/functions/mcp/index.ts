// @ts-nocheck
import { toolDefs, INSTRUCTIONS } from './_shared.js';

/**
 * THE HOSTED MCP SURFACE, RUNNING INSIDE SUPABASE.
 *
 * WHY HERE RATHER THAN ONLY ON CLOUDFLARE. The Cloudflare Worker needs the
 * project's service_role key as a secret, which means a full read/write
 * database credential has to be revealed in a dashboard, copied, and pasted
 * somewhere. An Edge Function runs inside the project and receives
 * SUPABASE_SERVICE_ROLE_KEY from the platform, so the credential never leaves
 * Supabase at all -- no copy, no paste, nothing to leak in a transcript, and
 * nothing to rotate in two places.
 *
 * THE TOOLS ARE NOT REIMPLEMENTED. _shared.js is a mechanical concatenation of
 * src/glob.mjs, bridge/collisions.mjs, src/ownerDecisions.mjs and
 * mcp/toolDefs.mjs -- the exact bytes that run locally, with only the local
 * import lines stripped because concatenation puts the symbols in scope. A
 * hosted surface that rewrites its own tools is how it begins answering
 * differently from the local one about the same machine.
 *
 * AUTHENTICATION IS THE CLIENT'S OWN TOKEN, NOT THE DATABASE KEY. Callers send
 * a reader token; it is SHA-256'd and compared against agentbridge.
 * reader_tokens. The plaintext is never stored, so a dump of that table yields
 * no working credential, and revoking one client is flipping one column. The
 * service key stays here and is never handed to a client.
 *
 * verify_jwt is DISABLED for this function on purpose: callers authenticate
 * with the reader token above, not with a Supabase JWT. That is the sanctioned
 * case for disabling it -- the function implements its own authentication --
 * and the check below is that authentication.
 */

const PROTOCOL_VERSION = '2024-11-05';
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function get(pathAndQuery: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      accept: 'application/json',
    },
  });
  // A non-2xx THROWS rather than returning []. An empty array means "nothing is
  // registered", which is a real and calm answer; a failed query rendered as []
  // is indistinguishable from it, and a model cannot tell "the backend is down"
  // from "there are no agents".
  if (!res.ok) throw new Error(`supabase-read-failed:${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('supabase-read-failed:not-an-array');
  return rows;
}

const sha256Hex = async (s: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * The store, shaped exactly as bridge/store.mjs returns rows, so the shared
 * toolDefs hands every transport the same object.
 */
const store = {
  async listSessions() {
    // Live worker identity first; fall back to the state snapshot table so this
    // keeps answering on a machine that publishes heartbeats but has not yet
    // adopted session registration.
    const rows = await get('session_registrations?select=*');
    return rows.map((r: any) => ({
      agentId: r.agent_id,
      lane: r.lane_id ?? null,
      machineLabel: r.machine_id ?? null,
      worktree: r.worktree_id ?? null,
      git: r.head_sha ? { ok: true, head: r.head_sha } : null,
      locks: [],
      processes: [],
      processProbeOk: true,
      lastSeenAt: r.heartbeat_at ?? null,
      sessionId: r.session_id,
      repoId: r.repo_id ?? null,
      capacity: r.capacity ?? null,
    }));
  },

  async getLanes() {
    const rows = await get('lanes_latest?select=lanes&limit=1');
    const lanes = rows[0]?.lanes;
    return lanes && typeof lanes === 'object' ? lanes : {};
  },

  async listDecisions() {
    return get('owner_decisions?select=*');
  },

  async checkReaderToken(token: string | null) {
    if (typeof token !== 'string' || token.length < 16) return null;
    const hex = await sha256Hex(token);
    const rows = await get(
      `reader_tokens?select=label,disabled&token_sha256=eq.${hex}&disabled=is.false&limit=1`,
    );
    return rows[0]?.label ?? null;
  },
};

async function handleRpc(msg: any, defs: any[]) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentbridge', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      },
    });
  }

  if (method === 'notifications/initialized') return new Response(null, { status: 202 });

  if (method === 'tools/list') {
    return json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        tools: defs.map((d) => ({
          name: d.name, title: d.title, description: d.description, inputSchema: d.input,
        })),
      },
    });
  }

  if (method === 'tools/call') {
    const def = defs.find((d) => d.name === params?.name);
    // -32602 invalid params, not -32601: the METHOD exists, the tool named in
    // its arguments does not.
    if (!def) return rpcError(id, -32602, `no such tool: ${params?.name}`);
    try {
      return json({ jsonrpc: '2.0', id: id ?? null, result: await def.run(params?.arguments ?? {}) });
    } catch (e) {
      // A tool failure is an MCP-level error, not an HTTP one: the request was
      // well formed and authorised. The message is our own string, never a
      // database body.
      return json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message ?? e) }) }],
          isError: true,
        },
      });
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/mcp/, '') || '/';

  // Unauthenticated on purpose: a health check needing a credential is one
  // nobody wires up. It reveals no state.
  if (path === '/health' || path === '/v1/health') {
    return json({ ok: true, service: 'agentbridge', runtime: 'supabase-edge' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    // Misconfiguration must not read as "unauthorized", or somebody hunts a
    // credential that was never the problem.
    return json({ error: 'not-configured' }, 503);
  }

  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
  let label: string | null = null;
  try {
    label = await store.checkReaderToken(bearer);
  } catch (e) {
    // The token store itself is unreachable. That is NOT an auth failure and
    // must not be reported as one -- 401 would send somebody to rotate a
    // perfectly good token.
    return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
  }
  if (!label) return json({ error: 'unauthorized' }, 401);

  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  let msg: unknown;
  try { msg = await request.json(); }
  catch { return rpcError(null, -32700, 'parse error'); }

  return handleRpc(msg, toolDefs(store));
});
