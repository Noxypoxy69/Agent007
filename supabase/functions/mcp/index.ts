// @ts-nocheck
import {
  toolDefs, INSTRUCTIONS, canAssign, validateMessage, assignmentRecord, negotiateProtocol,
  messagesQuery, canReturn, returnRecord, canAccept, acceptRecord, canCancel, cancelRecord,
  eventsFor, nextCursor, proposeWork, canConfirm, supervisoryReport,
  resolveLiveAgent, registryFromSessions, isLive, createDecision, validateDecision,
  taskWriteFilter, writeLanded, TASK_WRITE_EXPECTS,
} from './_shared.js';

/**
 * THE DATA PLANE: a read surface, a narrow registration write, and coordination.
 *
 * FOUR TOKEN CLASSES, IN FOUR TABLES, NONE INTERCHANGEABLE.
 *
 *   reader_tokens        read coordination state. ChatGPT-the-observer.
 *   registration_tokens  a worker publishes its OWN liveness, returns its OWN
 *                        work, and waits for its OWN events. Nothing else.
 *   coordinator_tokens   assign, accept, cancel, message, record owner
 *                        decisions, confirm proposals. NOT deploy, NOT shell,
 *                        NOT SQL.
 *   dispatcher_tokens    PREPARE PROPOSALS, via POST /dispatch. Nothing else.
 *                        It cannot assign what it proposes -- that is the
 *                        owner's "prepare, do not decide" ruling enforced by
 *                        capability rather than by good behaviour.
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

  /**
   * THE INBOX. A COORDINATOR THAT CAN ONLY SPEAK IS A MEGAPHONE.
   *
   * send_message existed from the start and nothing could read the log back, so
   * the command centre could issue instructions to four agents and had no way
   * to see a single reply. One-way command is not coordination; it is
   * broadcasting with extra steps.
   *
   * This is a READ tool and lives on the read store, so a reader gets it too.
   * Reading the coordination log is the same kind of act as reading the roster
   * or the decision ledger, and withholding it from readers would leave the
   * observer role able to see who exists but not what anyone said.
   *
   * The query itself is built by messagesQuery() in _shared.js, where a test
   * can reach it.
   */
  async listMessages(args = {}) { return get(messagesQuery(args)); },
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

      /*
       * THE WRITE REVALIDATES WHAT THE GUARD JUDGED.
       *
       * canAssign ran against rows fetched in an EARLIER request. Without a
       * state predicate here, two coordinators both read "runnable", both
       * pass, and both write -- last writer wins, silently, across a window as
       * wide as a network round trip. Raised by code-d; structural, not
       * probabilistic, because a write with no predicate cannot refuse a stale
       * decision under any interleaving.
       */
      const rec = assignmentRecord(task, resolved, { by: label, at: now });
      const landed = writeLanded(
        await patch(taskWriteFilter(task_id, TASK_WRITE_EXPECTS.assign), rec),
        { task_id, expected: TASK_WRITE_EXPECTS.assign },
      );
      // An empty result is a LOST RACE, not a success with an absent task.
      if (!landed.ok) return { ok: false, errors: landed.errors };
      const row = landed.row;

      // The assignment is announced on the message log too, so a worker sees it
      // in one place rather than having to poll the task table.
      await write('messages', {
        task_id, from_agent: label, to_agent: resolved.agent_id,
        type: 'assignment',
        body: `Assigned ${task_id}: ${task.title}`,
      }, 'return=minimal');

      return { ok: true, task: row, resolved_session: resolved.session_id };
    },

    /**
     * ACCEPT WHAT A WORKER RETURNED. Never what it did not.
     *
     * canAccept refuses on any state but `returned`, so this cannot sign off
     * work nobody handed in, and the accepted sha is pinned from the RETURN
     * rather than re-read -- the reviewer accepted a specific commit.
     */
    async acceptTask({ task_id, note }) {
      const tasks = await get(`tasks?select=*&task_id=eq.${encodeURIComponent(task_id)}&limit=1`);
      const task = tasks[0];
      if (!task) return { ok: false, errors: [`no such task: ${task_id}`] };

      const at = new Date().toISOString();
      const verdict = canAccept(task, { at });
      if (!verdict.ok) return { ok: false, errors: verdict.errors, state: task.state };

      const landed = writeLanded(
        await patch(taskWriteFilter(task_id, TASK_WRITE_EXPECTS.accept),
          acceptRecord(task, { by: label, at })),
        { task_id, expected: TASK_WRITE_EXPECTS.accept },
      );
      if (!landed.ok) return { ok: false, errors: landed.errors };
      const row = landed.row;

      // Announced on the log, so the worker learns its work landed without
      // polling the task table.
      await write('messages', {
        task_id,
        from_agent: label,
        to_agent: task.assigned_agent ?? task.returned_by,
        type: 'review',
        body: `Accepted ${task_id} at ${String(task.returned_head_sha).slice(0, 12)}`
          + (note ? `: ${note}` : ''),
      }, 'return=minimal');

      return { ok: true, task: row };
    },

    async cancelTask({ task_id, reason }) {
      const tasks = await get(`tasks?select=*&task_id=eq.${encodeURIComponent(task_id)}&limit=1`);
      const task = tasks[0];
      if (!task) return { ok: false, errors: [`no such task: ${task_id}`] };

      const verdict = canCancel(task, { reason });
      if (!verdict.ok) return { ok: false, errors: verdict.errors, state: task.state };

      const at = new Date().toISOString();
      const landed = writeLanded(
        await patch(taskWriteFilter(task_id, TASK_WRITE_EXPECTS.cancel),
          cancelRecord(task, { by: label, at, reason })),
        { task_id, expected: TASK_WRITE_EXPECTS.cancel },
      );
      if (!landed.ok) return { ok: false, errors: landed.errors };
      const row = landed.row;

      if (task.assigned_agent) {
        await write('messages', {
          task_id,
          from_agent: label,
          to_agent: task.assigned_agent,
          type: 'status',
          body: `Cancelled ${task_id}: ${reason}`,
        }, 'return=minimal');
      }

      return { ok: true, task: row };
    },

    async listProposals({ state } = {}) {
      const want = typeof state === 'string' && state.trim() ? state.trim() : 'open';
      return get(`proposals?select=*&state=eq.${encodeURIComponent(want)}&order=prepared_at.desc&limit=200`);
    },

    /**
     * CONFIRM A PROPOSAL, RE-VERIFYING IT FIRST.
     *
     * The recorded would_be_accepted is NOT consulted. canConfirm re-runs the
     * guard against live rows, because the proposal was formed against a world
     * that has since moved -- the worker may have gone offline, taken other
     * work, or restarted under a new session; the task may have been cancelled
     * or returned by somebody else.
     *
     * Trusting the stored verdict is how "supervised" becomes "autonomous with
     * an hour of lag", which is the one thing this design exists to prevent.
     */
    async confirmProposal({ proposal_id, note }) {
      const rows = await get(
        `proposals?select=*&proposal_id=eq.${encodeURIComponent(proposal_id)}&limit=1`);
      const p = rows[0];
      if (!p) return { ok: false, errors: [`no such proposal: ${proposal_id}`] };
      if (p.state !== 'open') {
        return { ok: false, errors: [`proposal is "${p.state}", not open`], state: p.state };
      }

      const now = new Date().toISOString();
      const [tasks, regs] = await Promise.all([
        get('tasks?select=*'),
        get('session_registrations?select=*'),
      ]);
      const task = tasks.find((t) => t.task_id === p.task_id) ?? null;

      const reg = registryFromSessions(regs.map((r) => ({
        agent_id: r.agent_id, session_id: r.session_id, repo_id: r.repo_id,
        worktree_id: r.worktree_id, lane_id: r.lane_id, capacity: r.capacity,
        head_sha: r.head_sha, heartbeat_at: r.heartbeat_at,
      })), { now });
      const resolved = p.kind === 'assign' ? resolveLiveAgent(reg.sessions, p.agent_id) : null;

      const verdict = canConfirm(p, {
        task,
        worker: resolved?.ok ? resolved : null,
        tasks,
        now,
        isLive: (row) => isLive(row, { now }),
      });
      if (!verdict.ok) {
        return {
          ok: false,
          errors: verdict.errors,
          // What the dispatcher thought, shown BESIDE the live refusal so the
          // difference between then and now is visible rather than implied.
          prepared_verdict: { would_be_accepted: p.would_be_accepted, reasons: p.reasons },
        };
      }

      const done = p.kind === 'assign'
        ? await this.assignTask({ task_id: p.task_id, agent_id: p.agent_id })
        : await this.acceptTask({ task_id: p.task_id, note });

      if (!done.ok) return { ok: false, errors: done.errors, stage: 'apply' };

      /*
       * THE FIFTH SITE OF THE SAME SHAPE, on proposals rather than tasks.
       *
       * code-d found this while verifying the four task writes. The read above
       * checked `state === 'open'`; this write was pinned to the proposal id
       * alone, so a proposal the dispatcher SUPERSEDED between the read and the
       * write could still be flipped to confirmed -- a transition no guard
       * admits. The predicate makes the write refuse it.
       *
       * LOWER SEVERITY THAN THE TASK WRITES, and worth being accurate about
       * why: the task write now serialises the real damage. A second confirmer
       * is refused at the apply stage above and never reaches this line, so
       * what remains is a RECORD that disagrees with what happened, not two
       * assignments.
       *
       * WHICH IS EXACTLY WHY A LOST RACE HERE MUST NOT FAIL THE CALL. The
       * assignment or acceptance ALREADY HAPPENED and already landed. Returning
       * ok:false now would report failure for work that completed -- the same
       * defect as the 204 empty-body bug documented in write(), where the
       * retry is what corrupts the picture. So the action is reported as the
       * success it was, with the bookkeeping discrepancy named beside it.
       */
      const marked = await patch(
        `proposals?proposal_id=eq.${encodeURIComponent(proposal_id)}&state=eq.open`,
        { state: 'confirmed', confirmed_at: now, confirmed_by: label });

      const recorded = Array.isArray(marked) && marked.length > 0;

      return {
        ok: true,
        kind: p.kind,
        task: done.task,
        ...(recorded ? {} : {
          proposal_record: 'stale',
          note: `the ${p.kind} was applied, but proposal ${proposal_id} was no longer open `
            + 'when the confirmation was recorded -- the dispatcher superseded it, or another '
            + 'coordinator confirmed it first. The work is done; only the proposal row is behind.',
        }),
      };
    },

    async supervisoryReport() {
      const now = new Date().toISOString();
      const [tasks, regs, open] = await Promise.all([
        get('tasks?select=*'),
        get('session_registrations?select=*'),
        get('proposals?select=*&state=eq.open&limit=200'),
      ]);
      // head_sha travels with the row: wentStale reports the commit a lost
      // worker was last publishing, and a frozen one is the tell.
      const sessions = regs.map((r) => ({
        agent_id: r.agent_id, session_id: r.session_id, lane_id: r.lane_id,
        repo_id: r.repo_id, capacity: r.capacity, heartbeat_at: r.heartbeat_at,
        head_sha: r.head_sha,
      }));
      const { idle, blocked } = proposeWork({
        tasks, sessions, now, isLive: (row) => isLive(row, { now }),
      });
      return supervisoryReport({ proposals: open, idle, blocked, tasks, sessions, now });
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
        protocolVersion: negotiateProtocol(params?.protocolVersion),
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

    /*
     * PROVENANCE, NOT AUTHORIZATION.
     *
     * registered_by is the authenticated token label, taken from the bearer and
     * never from the payload -- a worker does not get to say who wrote its row.
     *
     * It is NOT what stops one agent overwriting another's session. There is a
     * single registration token shared by every worker, so this value is the
     * same for all of them and a check against it would pass for every accident
     * it looks like it prevents. Ownership is enforced in the database, by
     * guard_session_owner, on (agent_id, machine_id).
     */
    v.row.registered_by = label;

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
      const detail = String(e?.message ?? e);
      /*
       * A REFUSED TAKEOVER IS NOT A MALFORMED REQUEST.
       *
       * guard_session_owner refuses an update that would move a session to a
       * different agent or machine. Reporting that as a generic 400 would tell
       * the worker its payload was wrong -- it was not; the payload was fine
       * and the session simply belongs to somebody else. 409 plus the hint the
       * trigger raises is the difference between "fix your JSON" and
       * "deregister it first, then register under the new identity".
       */
      if (detail.includes('session_owned_by_another_agent')) {
        return json({
          error: 'session-owned-by-another-agent',
          detail: detail.slice(0, 400),
          hint: 'deregister the session first, then register it under the new identity',
        }, 409);
      }
      return json({ error: 'registration-rejected', detail: detail.slice(0, 400) }, 400);
    }
  }

  // ── the worker's RETURN path ─────────────────────────────────────────────
  /*
   * A WORKER HANDS ITS OWN WORK BACK. NOBODY HANDS IT BACK FOR THEM.
   *
   * This is the only write a worker has besides its own liveness, and it exists
   * so that `returned` is written by the party that did the work. A coordinator
   * tool that marked tasks returned would let the same actor author the
   * evidence and then sign it off, which is one party on both sides of a review
   * and makes the whole state meaningless.
   *
   * It takes a REGISTRATION token -- the same credential a worker already holds
   * for heartbeats -- and the return is bound to the session the task was
   * assigned to. The token is shared across workers, exactly as it is for
   * /register, so the identity check that matters is the one below: the task
   * must already be assigned to this session, which only the coordinator could
   * have arranged.
   */
  if (path === '/return') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let regLabel = null;
    try {
      regLabel = await tokenLabel('registration_tokens', bearer);
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    if (!regLabel) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_request', detail: 'body must be JSON' }, 400); }

    const taskId = typeof body?.task_id === 'string' ? body.task_id.trim() : '';
    if (!taskId) return json({ error: 'invalid_request', detail: 'task_id is required' }, 400);

    const [tasks, regs] = await Promise.all([
      get(`tasks?select=*&task_id=eq.${encodeURIComponent(taskId)}&limit=1`),
      get('session_registrations?select=*'),
    ]);
    const task = tasks[0];
    if (!task) return json({ error: 'no-such-task', detail: taskId }, 404);

    /*
     * THE WORKER IS RESOLVED FROM THE REGISTRY, NOT TAKEN FROM THE BODY.
     *
     * A session that is not registered cannot return anything: the row is what
     * ties a claimed session id to a machine that actually checked in.
     */
    const claimed = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
    const row = regs.find((r) => r?.session_id === claimed);
    if (!row) {
      return json({
        error: 'unknown-session',
        detail: `session "${claimed}" is not registered; register before returning work`,
      }, 409);
    }

    const verdict = canReturn(task, { agent_id: row.agent_id, session_id: row.session_id },
      { headSha: body?.head_sha });
    if (!verdict.ok) {
      return json({ error: 'return-refused', errors: verdict.errors, state: task.state }, 409);
    }

    const at = new Date().toISOString();
    // THE FOURTH SITE. code-d's finding named assign, accept and cancel; the
    // return path has the identical shape and the identical race, so it gets
    // the identical fix rather than waiting to be reported separately.
    const returned = writeLanded(
      await patch(taskWriteFilter(taskId, TASK_WRITE_EXPECTS.return),
        returnRecord(task, { agent_id: row.agent_id, session_id: row.session_id },
          { headSha: body.head_sha, notes: body?.notes, at })),
      { task_id: taskId, expected: TASK_WRITE_EXPECTS.return },
    );
    if (!returned.ok) {
      return json({ error: 'return-refused', errors: returned.errors }, 409);
    }
    const updated = returned.row;

    // The return announces itself, so a coordinator sees it in list_messages
    // rather than having to poll the task table for a state change.
    await write('messages', {
      task_id: taskId,
      from_agent: row.agent_id,
      to_agent: task.assigned_by ?? 'coordinator',
      type: 'review',
      body: `Returned ${taskId} at ${String(body.head_sha).slice(0, 12)}`
        + (typeof body?.notes === 'string' && body.notes.trim() ? `: ${body.notes.trim()}` : ''),
    }, 'return=minimal');

    return json({ ok: true, task: updated });
  }

  // ── the DISPATCHER: prepares, never decides ────────────────────────────
  /*
   * THE ONLY ENDPOINT A DISPATCHER TOKEN OPENS.
   *
   * The owner ruled that the dispatcher prepares an assignment and the
   * coordinator confirms it. That ruling is enforced by CAPABILITY, not by
   * convention: a dispatcher token is in neither coordinator_tokens nor
   * reader_tokens, so every MCP tool is 401 to it and this path is all it has.
   * If it held a coordinator token it could assign work, and the only thing
   * stopping it would be that it chooses not to -- which is a habit, not a
   * control.
   *
   * WHAT IT WRITES IS A NOTEBOOK, NOT A WARRANT. Proposals record what the
   * guard said at preparation time so a coordinator can read the reasoning.
   * confirm_proposal re-runs that guard against live rows and ignores the
   * stored verdict entirely.
   */
  if (path === '/dispatch') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let dispatchLabel = null;
    try {
      dispatchLabel = await tokenLabel('dispatcher_tokens', bearer);
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    // A coordinator or reader token lands here and fails: neither is in this
    // table, and a dispatcher token opens nothing else.
    if (!dispatchLabel) return json({ error: 'unauthorized' }, 401);

    const now = new Date().toISOString();
    const [tasks, regs] = await Promise.all([
      get('tasks?select=*'),
      get('session_registrations?select=*'),
    ]);

    const sessions = regs.map((r) => ({
      agent_id: r.agent_id, session_id: r.session_id, lane_id: r.lane_id,
      repo_id: r.repo_id, capacity: r.capacity, heartbeat_at: r.heartbeat_at,
      head_sha: r.head_sha,
    }));

    const { proposals, idle, blocked } = proposeWork({
      tasks, sessions, now, isLive: (row) => isLive(row, { now }),
    });

    /*
     * THE OPEN SET IS REPLACED, NOT APPENDED TO.
     *
     * An old proposal left open beside a fresh one lets a coordinator confirm a
     * suggestion the dispatcher has already replaced -- the stale-authority
     * problem in a different hat. Superseding first also means `open` always
     * means "what the dispatcher thinks now".
     *
     * Confirmed rows are never touched: they are the record of what was
     * actually done.
     */
    await patch('proposals?state=eq.open', { state: 'superseded', superseded_at: now });

    let written = [];
    if (proposals.length) {
      written = await write('proposals', proposals.map((p) => ({
        kind: p.kind,
        task_id: p.task_id,
        agent_id: p.agent_id ?? null,
        session_id: p.session_id ?? null,
        lane_id: p.lane_id ?? null,
        returned_by: p.returned_by ?? null,
        head_sha: p.head_sha ?? null,
        notes: p.notes ?? null,
        would_be_accepted: p.would_be_accepted,
        reasons: p.reasons ?? [],
        prepared_at: p.prepared_at,
        prepared_by: dispatchLabel,
      })));
    }

    return json({
      ok: true,
      prepared: written.length,
      // The dispatcher answers with the report too, so a cron run has something
      // worth logging without a second authenticated call.
      report: supervisoryReport({ proposals, idle, blocked, tasks, sessions, now }),
    });
  }

  // ── the WAIT path: event-driven, without an outbound capability ─────────
  /*
   * THE CLIENT WAITS. THE BRIDGE NEVER CALLS OUT.
   *
   * The coordinator polls hourly at best, so work assigned at 14:00 sat until a
   * worker's next heartbeat -- up to two minutes, or forever with no watcher.
   * The obvious fix is a webhook, and it is wrong twice over: the workers are
   * local sessions with no inbound address, so there is nothing to POST to; and
   * a data plane that POSTs to a URL supplied with a registration token is an
   * SSRF engine aimed wherever that token holder names.
   *
   * Inverting it costs nothing and gives the same latency. The worker holds a
   * request open; this answers the moment something is addressed to it.
   *
   * THE ANSWER IS A DOORBELL. Events carry ids and timestamps, never the
   * instruction itself -- the worker reads the task or the message through the
   * path it already has, so nothing here can be mistaken for a command.
   *
   * BOUNDED ON PURPOSE. A held connection is a function invocation; 25 seconds
   * is long enough that a waiting worker is effectively instant and short
   * enough that a wedged client releases it without anyone intervening.
   */
  if (path === '/wait') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let waitLabel = null;
    try {
      waitLabel = await tokenLabel('registration_tokens', bearer);
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    if (!waitLabel) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_request', detail: 'body must be JSON' }, 400); }

    const claimed = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
    if (!claimed) return json({ error: 'invalid_request', detail: 'session_id is required' }, 400);

    // The agent is resolved from the REGISTRY, never taken from the body: a
    // session that never checked in has no events to be woken for.
    const regs = await get('session_registrations?select=*');
    const me = regs.find((r) => r?.session_id === claimed);
    if (!me) {
      return json({
        error: 'unknown-session',
        detail: `session "${claimed}" is not registered; register before waiting`,
      }, 409);
    }

    const MAX_WAIT_MS = 25000;
    const POLL_MS = 2000;
    const asked = Number.parseInt(body?.timeout_ms ?? MAX_WAIT_MS, 10);
    const budget = Math.min(Math.max(Number.isFinite(asked) ? asked : MAX_WAIT_MS, 1000), MAX_WAIT_MS);

    const started = Date.now();
    let cursor = typeof body?.since === 'string' && body.since.trim() ? body.since.trim() : null;

    for (;;) {
      const [tasks, messages] = await Promise.all([
        get('tasks?select=*'),
        get(`messages?select=*&order=created_at.desc&limit=200`),
      ]);

      let events;
      try {
        events = eventsFor({
          tasks, messages, agent_id: me.agent_id, session_id: me.session_id, since: cursor,
        });
      } catch (e) {
        // An unparseable cursor is the caller's bug and must not be rounded
        // down to "send everything" -- that replays history as new work.
        return json({ error: 'invalid_request', detail: String(e?.message ?? e) }, 400);
      }

      if (events.length) {
        return json({
          ok: true,
          events,
          cursor: nextCursor(events, cursor),
          waited_ms: Date.now() - started,
        });
      }

      if (Date.now() - started + POLL_MS > budget) {
        /*
         * NOTHING HAPPENED, AND THE CURSOR DOES NOT MOVE.
         *
         * Advancing it to "now" on an empty wait would step over anything
         * written between the last read and this reply. The caller passes the
         * same cursor back and loses nothing.
         */
        return json({ ok: true, events: [], cursor, waited_ms: Date.now() - started });
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
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
  // A REGISTRATION or DISPATCHER token lands here and fails: neither is in
  // either table, which is what bounds the dispatcher to /dispatch alone.
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
