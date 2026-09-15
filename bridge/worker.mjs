import { toolDefs, INSTRUCTIONS } from '../mcp/toolDefs.mjs';
import { detectCollisions } from './collisions.mjs';
import { createHttpStore } from './httpStore.mjs';

/**
 * The hosted read surface, on Cloudflare Workers.
 *
 * WHY THIS IS NOT bridge/server.mjs WITH A DIFFERENT LISTENER. Two node
 * dependencies are load-bearing there and neither exists here:
 *
 *   `pg`                              a TCP driver; Workers have no sockets
 *   StreamableHTTPServerTransport     written against IncomingMessage/ServerResponse
 *
 * So the transport is hand-rolled and the store speaks HTTP. What is NOT
 * duplicated is the part that would actually hurt to duplicate: the tools
 * themselves come from mcp/toolDefs.mjs, the same module the node bridge and
 * stdio use. A reimplemented tool is how a hosted surface and a local one begin
 * answering differently about the same machine.
 *
 * MCP over plain HTTP JSON-RPC, statelessly. Every request carries its own
 * method call and gets its own answer; nothing is held between requests, so
 * concurrent readers cannot observe each other and a Worker isolate being
 * recycled loses nothing. `initialize` is answered but establishes no session.
 *
 * READ-ONLY, AND INGEST IS DELIBERATELY ABSENT. /v1/heartbeat stays on the node
 * bridge where HMAC verification, the nonce store and the rate limiter already
 * live. A Worker that cannot write is a smaller thing to get wrong.
 */

const PROTOCOL_VERSION = '2024-11-05';
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

/** JSON-RPC error codes, as the spec numbers them. */
const rpcError = (id, code, message) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const bearer = (request) =>
  (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

/**
 * Handle one MCP method.
 *
 * Only the three methods this surface actually serves are implemented; anything
 * else returns method-not-found rather than a generic 500, so a client can tell
 * an unsupported method from a broken server.
 */
async function handleRpc(msg, defs) {
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

  if (method === 'notifications/initialized') {
    // A notification has no id and takes no response body.
    return new Response(null, { status: 202 });
  }

  if (method === 'tools/list') {
    return json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        tools: defs.map((d) => ({
          name: d.name,
          title: d.title,
          description: d.description,
          inputSchema: d.input,
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
      const result = await def.run(params?.arguments ?? {});
      return json({ jsonrpc: '2.0', id: id ?? null, result });
    } catch (e) {
      /*
       * A tool failure is an MCP-level error, not an HTTP one: the request was
       * well-formed and authorised. The message is the thrown one -- these are
       * our own strings ("supabase-read-failed:503"), never a database body,
       * and a model that cannot tell "the backend is down" from "there are no
       * agents" will report the wrong thing with confidence.
       */
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

/**
 * @param {object} env  { SUPABASE_URL, SUPABASE_SERVICE_KEY }
 * @param {object} deps { storeFactory } for tests
 */
export function createWorkerHandler(env, { storeFactory = createHttpStore } = {}) {
  return async function fetchHandler(request) {
    const url = new URL(request.url);

    // Unauthenticated on purpose: a health check that needs a credential is a
    // health check nobody wires up. It reveals no state.
    if (url.pathname === '/v1/health') {
      return json({ ok: true, service: 'agentbridge', runtime: 'worker' });
    }

    let store;
    try {
      store = storeFactory(env);
    } catch {
      // Misconfiguration must not read as "unauthorized" -- that would send
      // somebody hunting for a bad token when the binding is missing.
      return json({ error: 'not-configured' }, 503);
    }

    const label = await store.checkReaderToken(bearer(request)).catch(() => null);
    if (!label) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/v1/state' && request.method === 'GET') {
      try {
        const [sessions, lanes] = await Promise.all([store.listSessions(), store.getLanes()]);
        return json({ sessions, collisions: detectCollisions(sessions, { lanes }) });
      } catch {
        return json({ error: 'upstream-unavailable' }, 502);
      }
    }

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
      let msg;
      try { msg = await request.json(); }
      catch { return rpcError(null, -32700, 'parse error'); }
      // Contracts are machine-local, so this store has no listDelegations and
      // toolDefs therefore omits the contract tools. The shorter hosted list is
      // a decision, not a fault.
      return handleRpc(msg, toolDefs(store));
    }

    return json({ error: 'not-found' }, 404);
  };
}

export default {
  fetch(request, env) {
    return createWorkerHandler(env)(request);
  },
};
