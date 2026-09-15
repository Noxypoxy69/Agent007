// @ts-nocheck
import {
  toolDefs, INSTRUCTIONS, canAssign, validateMessage, assignmentRecord,
  resolveLiveAgent, registryFromSessions, isLive, createDecision, validateDecision,
} from './_shared.js';

/**
 * THE DATA PLANE: a read surface, a narrow registration write, and coordination.
 *
 * THREE TOKEN CLASSES, IN THREE TABLES, NONE INTERCHANGEABLE.
 *
 *   reader_tokens        read coordination state. ChatGPT-the-observer.
 *   registration_tokens  a worker publishes its OWN liveness. Nothing else.
 *   coordinator_tokens   assign tasks, send structured messages, record owner
 *                        decisions. NOT deploy, NOT shell, NOT SQL.
 *
 * Separate tables rather than one with a scope column, because a scope column
 * is one typo away from promoting a reader to a coordinator, and a promotion
 * that happens by typo is one nobody reviews.
 *
 * SCOPE DECIDES WHICH TOOLS EXIST, NOT WHICH ONES REFUSE. The store handed to
 * toolDefs carries write methods only for a coordinator, and toolDefs registers
 * a tool only when its method is present. So for a reader, assign_task is
 * absent from tools/list and answers "no such tool" identically to a name that
 * was never defined. A refusal string is something a model argues with; a
 * missing tool is not.
 *
 * WHAT IS DELIBERATELY ABSENT AT EVERY SCOPE: shell, SQL, file writes, deploy,
 * merge, command execution. Their absence is the control.
 */

const PROTOCOL_VERSION = '2024-11-05';
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...CORS } });

const rpcError = (id, code, message) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const restHeaders = (extra = {}) => ({
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  accept: 'application/json',
  ...extra,
});

async function get(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: restHeaders() });
  // A non-2xx THROWS rather than returning []. An empty array means "nothing is
  // registered", a real and calm answer; a failed query rendered as [] is
  // indistinguishable from it.
  if (!res.ok) throw new Error(`supabase-read-failed:${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('supabase-read-failed:not-an-array');
  return rows;
}

async function write(pathAndQuery, body, prefer = 'return=representation') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'POST',
    headers: restHeaders({ 'content-type': 'application/json', prefer }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase-write-failed:${res.status}:${(await res.text()).slice(0, 200)}`);
  /*
   * AN EMPTY BODY IS NOT A FAILURE.
   *
   * PostgREST answers `Prefer: return=minimal` with 204 and no body, and
   * res.json() on that throws "unexpected end of JSON input" -- AFTER the write
   * has already landed. assign_task hit exactly this: the task was assigned,
   * the announcement message was inserted, and then parsing an empty response
   * threw, so the tool reported a failure for work it had completed. The caller
   * retried and was told the task was already assigned, which is the most
   * confusing possible pair of answers.
   *
   * Reporting failure for a completed write is worse than failing outright,
   * because the retry is what corrupts the picture.
   */
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function patch(pathAndQuery, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: restHeaders({ 'content-type': 'application/json', prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase-write-failed:${res.status}:${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sha256Hex = async (s) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Look a token up in ONE table. Each class reads only its own. */
async function tokenLabel(table, token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const hex = await sha256Hex(token);
  const rows = await get(`${table}?select=label,disabled&token_sha256=eq.${hex}&disabled=is.false&limit=1`);
  return rows[0]?.label ?? null;
}

const listSessions = async () => {
  const rows = await get('session_registrations?select=*');
  return rows.map((r) => ({
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
};

/** The READ store. No write method exists on it, so no write tool is built. */
const readStore = {
  listSessions,
  async getLanes() {
    const rows = await get('lanes_latest?select=lanes&limit=1');
    const lanes = rows[0]?.lanes;
    return lanes && typeof lanes === 'object' ? lanes : {};
  },
  async listDecisions() { return get('owner_decisions?select=*'); },
};

/**
 * The COORDINATOR store: the read store plus four write methods.
 *
 * Every refusal below comes from src/coordination.mjs, the same pure guard the
 * CLI uses and the one with the mutation table behind it. The transport decides
 * WHO may call; it does not get its own opinion about WHAT is allowed.
 */
function coordinatorStore(label) {
  return {
    ...readStore,

    async listTasks() { return get('tasks?select=*'); },

    async assignTask({ task_id, agent_id }) {
      const [tasks, regs] = await Promise.all([
        get('tasks?select=*'),
        get('session_registrations?select=*'),
      ]);

      const task = tasks.find((t) => t.task_id === task_id);
      if (!task) return { ok: false, errors: [`no such task: ${task_id}`] };

      // Resolution goes through the live registry, never a typed session id.
      const now = new Date().toISOString();
      const reg = registryFromSessions(regs.map((r) => ({
        agent_id: r.agent_id, session_id: r.session_id, repo_id: r.repo_id,
        worktree_id: r.worktree_id, lane_id: r.lane_id, capacity: r.capacity,
        head_sha: r.head_sha, heartbeat_at: r.heartbeat_at,
      })), { now });

      const resolved = resolveLiveAgent(reg.sessions, agent_id);
      if (!resolved.ok) {
        return {
          ok: false,
          errors: [`cannot resolve "${agent_id}": ${resolved.reason}`],
          candidates: resolved.candidates ?? [],
        };
      }

      const verdict = canAssign(task, resolved, {
        tasks,
        assignments: tasks.filter((t) => t.task_id !== task_id),
        isLive: (row) => isLive(row, { now }),
        // headSha is intentionally NOT supplied: this surface has no worktree
        // and cannot observe the integration tip. Passing a guess would make
        // the staleness check answer confidently from nothing. Base freshness
        // is enforced where a tree exists.
      });
      if (!verdict.ok) return { ok: false, errors: verdict.errors };

      const rec = assignmentRecord(task, resolved, { by: label, at: now });
      const [row] = await patch(`tasks?task_id=eq.${encodeURIComponent(task_id)}`, rec);

      // The assignment is announced on the message log too, so a worker sees it
      // in one place rather than having to poll the task table.
      await write('messages', {
        task_id, from_agent: label, to_agent: resolved.agent_id,
        type: 'assignment',
        body: `Assigned ${task_id}: ${task.title}`,
      }, 'return=minimal');

      return { ok: true, task: row, resolved_session: resolved.session_id };
    },

    async sendMessage(m) {
      const v = validateMessage(m);
      if (!v.ok) return { ok: false, errors: v.errors };
      const [row] = await write('messages', {
        task_id: m.task_id ?? null,
        from_agent: m.from_agent,
        to_agent: m.to_agent,
        type: m.type,
        body: m.body,
      });
      return { ok: true, message: row };
    },

    async recordOwnerDecision(d) {
      /*
       * A COORDINATOR RECORDS WHAT THE OWNER DECIDED. IT DOES NOT DECIDE.
       *
       * created_by is forced to owner_id here, and validateDecision refuses a
       * record where they differ. A coordinator that could set created_by to
       * itself could mint its own permissions, which is precisely the thing the
       * decision ledger exists to constrain.
       */
      const rec = createDecision({
        decision_id: d.decision_id,
        owner_id: d.owner_id,
        statement: d.statement,
        scope_type: d.scope_type,
        scope_id: d.scope_id ?? null,
        effect: d.effect,
        capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
        constraints: d.constraints ?? {},
        created_by: d.owner_id,
        created_at: new Date().toISOString(),
        supersedes: d.supersedes ?? null,
      });

      const v = validateDecision(rec);
      if (!v.ok) return { ok: false, errors: v.errors };

      const existing = await get(
        `owner_decisions?select=decision_id&decision_id=eq.${encodeURIComponent(rec.decision_id)}&limit=1`,
      );
      if (existing.length) {
        return {
          ok: false,
          errors: [`decision "${rec.decision_id}" already exists; decisions are append-only, supersede it instead`],
        };
      }
      if (rec.supersedes) {
        const target = await get(
          `owner_decisions?select=decision_id&decision_id=eq.${encodeURIComponent(rec.supersedes)}&limit=1`,
        );
        if (!target.length) {
          return { ok: false, errors: [`cannot supersede "${rec.supersedes}": no such decision`] };
        }
      }

      const [row] = await write('owner_decisions', {
        decision_id: rec.decision_id,
        owner_id: rec.owner_id,
        decision_type: rec.decision_type,
        statement: rec.statement,
        scope_type: rec.scope_type,
        scope_id: rec.scope_id,
        effect: rec.effect,
        capabilities: rec.capabilities,
        constraints: rec.constraints,
        created_by: rec.created_by,
        supersedes: rec.supersedes,
        history: rec.history,
      });
      return { ok: true, decision: row };
    },
  };
}

const SHA40 = /^[0-9a-f]{40}$/i;
const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];
const SEGMENT = /^[^\\/]+$/;

function validateRegistration(b) {
  const errors = [];
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const session_id = str(b?.session_id);
  const agent_id = str(b?.agent_id);
  if (!session_id) errors.push('session_id is required');
  if (!agent_id) errors.push('agent_id is required');
  // A session id equal to the agent id is the shape a defaulted identity takes,
  // and defaulting would manufacture exactly what this registry verifies.
  if (session_id && agent_id && session_id === agent_id) {
    errors.push('session_id must not equal agent_id');
  }
  if (!str(b?.machine_id)) errors.push('machine_id is required');

  const capacity = str(b?.capacity) ?? 'idle';
  if (!CAPACITIES.includes(capacity)) errors.push(`capacity must be one of ${CAPACITIES.join(', ')}`);

  const head_sha = str(b?.head_sha);
  if (head_sha && !SHA40.test(head_sha)) {
    errors.push('head_sha must be a full 40-character sha, resolved through git and never typed');
  }
  // An absolute path here would publish the operator's disk layout.
  for (const f of ['repo_id', 'worktree_id']) {
    const v = str(b?.[f]);
    if (v && !SEGMENT.test(v)) errors.push(`${f} must be a bare name, not a path`);
  }

  return {
    ok: errors.length === 0,
    errors,
    row: {
      session_id, agent_id,
      machine_id: str(b?.machine_id),
      repo_id: str(b?.repo_id),
      worktree_id: str(b?.worktree_id),
      lane_id: str(b?.lane_id),
      capacity,
      head_sha,
      verification_state: 'runtime-self-registration',
    },
  };
}

async function handleRpc(msg, defs) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agentbridge', version: '0.2.0' },
        instructions: INSTRUCTIONS,
      },
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return new Response(null, { status: 202, headers: CORS });
  }

  if (method === 'ping') return json({ jsonrpc: '2.0', id: id ?? null, result: {} });
  if (method === 'resources/list') return json({ jsonrpc: '2.0', id: id ?? null, result: { resources: [] } });
  if (method === 'prompts/list') return json({ jsonrpc: '2.0', id: id ?? null, result: { prompts: [] } });

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
    /*
     * -32602 invalid params, not -32601: the METHOD exists, the tool named in
     * its arguments does not. A tool the caller's scope does not include lands
     * here too, and is INDISTINGUISHABLE from one that was never defined --
     * which is the intent. "You may not" tells an attacker the tool is there.
     */
    if (!def) return rpcError(id, -32602, `no such tool: ${params?.name}`);
    try {
      return json({ jsonrpc: '2.0', id: id ?? null, result: await def.run(params?.arguments ?? {}) });
    } catch (e) {
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

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/mcp/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

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

  // ── the registration write path ──────────────────────────────────────────
  if (path === '/register') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let label = null;
    try {
      label = await tokenLabel('registration_tokens', bearer);
    } catch (e) {
      // The token store is unreachable. NOT an auth failure; a 401 here would
      // send somebody to rotate a perfectly good token.
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    // A READER or COORDINATOR token lands here and fails: neither is in this
    // table. No anonymous fallback — absent, invalid and revoked are all 401.
    if (!label) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_request', detail: 'body must be JSON' }, 400); }

    const v = validateRegistration(body);
    if (!v.ok) return json({ error: 'invalid_registration', errors: v.errors }, 400);

    try {
      const [row] = await write(
        'session_registrations?on_conflict=session_id', v.row,
        'resolution=merge-duplicates,return=representation',
      );
      return json({
        ok: true,
        session_id: row?.session_id,
        agent_id: row?.agent_id,
        capacity: row?.capacity,
        heartbeat_at: row?.heartbeat_at,
        verification_state: row?.verification_state,
      });
    } catch (e) {
      return json({ error: 'registration-rejected', detail: String(e?.message ?? e).slice(0, 400) }, 400);
    }
  }

  // ── the MCP surface, at whichever scope the token carries ────────────────
  let scope = null;
  let label = null;
  try {
    // Coordinator first: it is the superset. A token in neither table is 401.
    label = await tokenLabel('coordinator_tokens', bearer);
    if (label) scope = 'coordinator';
    else {
      label = await tokenLabel('reader_tokens', bearer);
      if (label) scope = 'reader';
    }
  } catch (e) {
    return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
  }
  // A REGISTRATION token lands here and fails: it is in neither table.
  if (!scope) return json({ error: 'unauthorized' }, 401);

  if (request.method !== 'POST') {
    // Spec-correct: no SSE stream is offered here.
    return json({ error: 'method-not-allowed' }, 405);
  }

  let msg;
  try { msg = await request.json(); }
  catch { return rpcError(null, -32700, 'parse error'); }

  const store = scope === 'coordinator' ? coordinatorStore(label) : readStore;
  return handleRpc(msg, toolDefs(store));
});
