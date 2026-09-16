// @ts-nocheck
import {
  // assignmentRecord and returnRecord are gone from here on purpose: claim_task
  // and return_with_lease set every column those two built, and more, inside one
  // transaction. Both still exist in _shared.js and are still tested there; they
  // are simply no longer how this file writes those two transitions.
  toolDefs, INSTRUCTIONS, canAssign, validateMessage, negotiateProtocol,
  messagesQuery, canReturn, canAccept, acceptRecord, canCancel, cancelRecord,
  eventsFor, nextCursor, proposeWork, canConfirm, supervisoryReport,
  resolveLiveAgent, registryFromSessions, isLive, createDecision, validateDecision,
  taskWriteFilter, writeLanded, TASK_WRITE_EXPECTS, observedCapacity,
  classifyRequest, pendingRequests, pausedTasks, canDecidePermission, DECIDER,
  ownTask, ownTasks,
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

/**
/**
 * A LEASE TOKEN IS A uuid, AND A MALFORMED ONE IS A REFUSAL.
 *
 * `renew_lease(p_lease_token uuid)` and `return_with_lease(p_lease_token uuid)`
 * both take a typed parameter. Validating only "non-empty string" and handing it
 * to Postgres fails the cast, PostgREST answers non-2xx, and the caller sees a
 * 500 — while a SUPERSEDED token returns a clean 409.
 *
 * Those read oppositely. A 409 is final; a 500 is transient and invites a retry.
 * And the worker most likely to send a damaged token is one that crashed or
 * resumed from a stale file — the same population as the zombies. So the one
 * refusal shaped like "try again later" would be aimed precisely at the caller
 * that must not retry. That is the fencing property leaking out through an
 * error code.
 *
 * Found by code-d on /return and fixed by c8 at d3ff685. This constant exists on
 * master so /renew is born with the guard rather than acquiring it after the
 * same 500 is reported a second time — the class, not the instance.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CALL ONE OF THE SECURITY DEFINER FUNCTIONS, AND REFUSE TO INVENT AN ANSWER.
 *
 * These functions do in ONE TRANSACTION what this file used to do in three
 * round trips: lock the row, check the state, mint a fencing token, bump the
 * attempt counter and write the outbox event. That is why the call moved here
 * -- a read-decide-write over HTTP cannot be atomic no matter how carefully
 * the predicate is written, and the predicate was only ever a patch over the
 * window.
 *
 * THE SHAPE CHECK IS NOT PARANOIA. A `revoke` binds to a signature, and any
 * migration that drops one of these and recreates it with different arguments
 * gets a brand-new function -- PostgREST then answers 404, or worse, resolves a
 * DIFFERENT overload and returns something that is not our { ok } object.
 * `out.ok !== boolean` catches both. Without it a null body reads as falsy and
 * every claim silently "fails", or an unexpected object reads as truthy and
 * every claim silently "succeeds"; the second one hands out work nobody holds.
 */
async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: restHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`supabase-rpc-failed:${fn}:${res.status}:${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  const out = text ? JSON.parse(text) : null;
  if (!out || typeof out !== 'object' || Array.isArray(out) || typeof out.ok !== 'boolean') {
    throw new Error(`supabase-rpc-failed:${fn}:unreadable-answer`);
  }
  return out;
}

/**
 * Turn a refusal into one line a human can act on.
 *
 * The reason codes are deliberately coarse -- 'not-claimable' merges "no such
 * task" and "another transaction holds it" because retrying is right for both
 * -- so the `detail` is where the actionable part lives and dropping it would
 * leave the caller staring at a slug. One refusal carries no detail at all:
 * the lease_seconds bounds check returns a whole sentence AS the reason, so
 * this must not assume a slug plus a detail.
 */
const rpcRefusal = (out) =>
  out?.detail ? `${out.reason}: ${out.detail}` : String(out?.reason ?? 'refused');

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
    /*
     * DERIVED, NOT REPORTED. A worker that claimed "idle" and then died says
     * "idle" in its last row forever -- code-b sat in this roster for fifteen
     * hours as idle, 898 minutes stale, and it was the only real agent among
     * the stale rows. The write paths already derived this through
     * registryFromSessions; only the READ surface handed the stored column
     * straight out, so the bug could never cause a bad assignment and could
     * only ever misinform whoever was reading.
     */
    capacity: observedCapacity(r, { now: new Date().toISOString() }),
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

  /**
   * FILING A QUESTION, AND WHY A READER MAY DO IT.
   *
   * The thing that is blocked on a permission is a WORKER, and a worker holds
   * no coordinator token. If asking required coordinator scope, the tool would
   * be unreachable by every process it exists for, and the "permission system"
   * would be a keypress with extra steps -- which is the defect, not the fix.
   *
   * What makes that safe is that a filed row DOES NOTHING. It carries no grant.
   * Crucially, `decider` and `risk` are computed HERE from the action and are
   * never read off the request: a caller that could name its own decider would
   * file "deploy.production" as routine and have a coordinator wave it through,
   * which is the exact escalation this whole design exists to prevent.
   *
   * POLICY FIRST, AND THEN NOTHING IS FILED AT ALL. Most asks have already been
   * answered. Filing them anyway would fill the owner's list with settled
   * questions and teach him that the list is noise.
   */
  async submitPermissionRequest(a = {}) {
    const now = new Date().toISOString();
    if (!a.action || typeof a.action !== 'string' || !a.action.trim()) {
      return { ok: false, errors: ['action is required'] };
    }
    if (!a.requested_by || typeof a.requested_by !== 'string' || !a.requested_by.trim()) {
      // Named rather than defaulted: a question whose asker is unknown cannot
      // be answered, because nobody knows who is waiting on the answer.
      return {
        ok: false,
        errors: ['requested_by is required: an anonymous question has nobody to answer to'],
      };
    }

    const decisions = await get('owner_decisions?select=*');
    const verdict = classifyRequest({
      action: a.action,
      task_id: a.task_id ?? null,
      scope_id: a.scope_id ?? null,
      reversible: a.reversible,
      project: a.project,
      repo: a.repo,
      lane: a.lane,
    }, decisions, { now });

    if (verdict.decider === DECIDER.POLICY) {
      return {
        ok: true,
        decided: true,
        decider: 'policy',
        allowed: verdict.allowed,
        risk: verdict.risk,
        decision_id: verdict.decision_id,
        reason: verdict.reason,
        constraints: verdict.constraints ?? {},
        filed: false,
        note: 'the owner has already decided this; nothing was filed and nobody was asked',
      };
    }

    const key = verdict.key;

    /*
     * ONE OUTSTANDING ASK PER QUESTION. The unique partial index enforces it in
     * the database; this read is the cheap path that avoids provoking it, and
     * the 409 handler below is what makes the enforcement real when two workers
     * ask in the same instant.
     */
    const seen = await get(
      `permission_requests?select=*&key=eq.${encodeURIComponent(key)}&decided_at=is.null&limit=1`,
    );
    if (seen.length) {
      return {
        ok: true, decided: false, filed: false, already_outstanding: true,
        request_id: seen[0].request_id,
        decider: seen[0].decider, risk: seen[0].risk,
        requested_at: seen[0].requested_at,
        reason: `this exact question is already waiting on the ${seen[0].decider}; `
          + 'poll list_permission_requests rather than asking again',
      };
    }

    const record = {
      key,
      action: a.action.trim(),
      task_id: a.task_id ?? null,
      scope_id: a.scope_id ?? null,
      decider: verdict.decider,
      risk: verdict.risk,
      requested_by: a.requested_by.trim(),
      arguments_summary: a.arguments_summary ?? null,
      environment: a.environment ?? null,
      reversible: typeof a.reversible === 'boolean' ? a.reversible : null,
    };

    let row;
    try {
      [row] = await write('permission_requests', record);
    } catch (e) {
      /*
       * A 409 HERE IS SOMEBODY ELSE ASKING THE SAME THING, WHICH IS SUCCESS.
       *
       * The unique index fired, so an identical open question exists. Re-read
       * and hand back THAT one. The re-read is ASSERTED rather than assumed: if
       * the row is not there, the 409 meant something else, and reporting
       * success would be inventing a request that does not exist.
       */
      if (!String(e?.message ?? e).includes(':409')) throw e;
      const raced = await get(
        `permission_requests?select=*&key=eq.${encodeURIComponent(key)}&decided_at=is.null&limit=1`,
      );
      if (!raced.length) {
        return { ok: false, errors: [`permission request rejected: ${String(e?.message ?? e)}`] };
      }
      return {
        ok: true, decided: false, filed: false, already_outstanding: true,
        request_id: raced[0].request_id, decider: raced[0].decider, risk: raced[0].risk,
        reason: 'an identical question was filed by another agent at the same moment',
      };
    }

    if (!row) {
      return { ok: false, errors: ['the permission request did not come back from the write'] };
    }

    return {
      ok: true,
      decided: false,
      filed: true,
      request_id: row.request_id,
      decider: verdict.decider,
      risk: verdict.risk,
      paused_task: a.task_id ?? null,
      reason: verdict.reason,
      next: verdict.decider === DECIDER.OWNER
        ? 'this is the owner’s to answer; he answers by recording a standing decision, '
          + 'which also stops it being asked again'
        : 'a coordinator may answer this with decide_permission_request',
    };
  },

  /**
   * WHAT IS WAITING, AND ON WHOM.
   *
   * pendingRequests() collapses repeats by key, so the request_id is attached
   * back here from the newest undecided row for that key -- the pure module
   * answers "what is outstanding", and the transport is what knows which row a
   * decider would actually write to.
   */
  async listPermissionRequests({ decider = null, includeDecided = false } = {}) {
    const now = new Date().toISOString();
    const rows = await get('permission_requests?select=*&order=requested_at.desc&limit=500');

    if (includeDecided) {
      return { requests: rows, paused_tasks: pausedTasks(rows, { now }) };
    }

    const newestOpen = new Map();
    for (const r of rows) {
      if (r.decided_at) continue;
      const prev = newestOpen.get(r.key);
      if (!prev || String(r.requested_at) > String(prev.requested_at)) newestOpen.set(r.key, r);
    }

    let pending = pendingRequests(rows, { now }).map((p) => ({
      request_id: newestOpen.get(p.key)?.request_id ?? null,
      requested_by: newestOpen.get(p.key)?.requested_by ?? null,
      arguments_summary: newestOpen.get(p.key)?.arguments_summary ?? null,
      environment: newestOpen.get(p.key)?.environment ?? null,
      ...p,
    }));
    if (decider) pending = pending.filter((p) => p.decider === decider);

    return {
      counts: {
        waiting_on_owner: pending.filter((p) => p.decider === DECIDER.OWNER).length,
        waiting_on_coordinator: pending.filter((p) => p.decider === DECIDER.COORDINATOR).length,
      },
      pending,
      paused_tasks: pausedTasks(rows, { now }),
    };
  },
};

/**
 * A STANDING DECISION SETTLES THE QUESTIONS IT ANSWERS.
 *
 * Without this, an owner-routed request would sit open forever: the owner
 * answers by writing a decision into the ledger, nothing would connect that
 * answer back to the question, and the owner's "waiting on you" list would grow
 * monotonically with things he had already dealt with. A list like that is one
 * people stop reading, and then the one that matters is buried in it.
 *
 * ONE SOURCE OF TRUTH, DELIBERATELY. The answer lives in the decision ledger and
 * the request row is closed as a consequence -- not answered independently. A
 * second place where permissions are granted is a second place to audit, and
 * they would disagree the first time somebody wrote to one of them.
 *
 * REQUESTS ARE ONLY EVER CLOSED BY A DECISION THAT COVERS THEM. classifyRequest
 * is re-run per row against the full ledger; only rows that come back POLICY are
 * touched. A row that is still owner_required or unresolved stays open, which is
 * why revoking a decision cannot close anything.
 *
 * The write carries `decided_at=is.null` in its filter, so a request a
 * coordinator answered in the same instant is not overwritten here.
 */
async function settleOpenRequestsAgainstPolicy({ decided_by }) {
  const [decisions, open] = await Promise.all([
    get('owner_decisions?select=*'),
    get('permission_requests?select=*&decided_at=is.null&limit=500'),
  ]);

  const now = new Date().toISOString();
  const settled = [];

  for (const r of open) {
    let verdict;
    try {
      verdict = classifyRequest({
        action: r.action,
        task_id: r.task_id,
        scope_id: r.scope_id,
        reversible: typeof r.reversible === 'boolean' ? r.reversible : undefined,
      }, decisions, { now });
    } catch {
      continue; // an unclassifiable stored row is left alone, never guessed at
    }

    if (verdict.decider !== DECIDER.POLICY) continue;

    const rows = await patch(
      `permission_requests?request_id=eq.${encodeURIComponent(r.request_id)}&decided_at=is.null`,
      {
        decided_at: new Date().toISOString(),
        decided_by,
        outcome: verdict.allowed ? 'allowed' : 'denied',
        decision_note: `settled by standing decision ${verdict.decision_id}: ${verdict.reason}`,
      },
    );
    // An empty array is a lost race -- somebody answered it first. Not recorded
    // as settled here, because this call did not settle it.
    if (rows.length) {
      settled.push({
        request_id: r.request_id,
        action: r.action,
        outcome: verdict.allowed ? 'allowed' : 'denied',
        by_decision: verdict.decision_id,
      });
    }
  }

  return settled;
}

/**
 * The COORDINATOR store: the read store plus four write methods.
 *
 * Every refusal below comes from src/coordination.mjs, the same pure guard the
 * CLI uses and the one with the mutation table behind it. The transport decides
 * WHO may call; it does not get its own opinion about WHAT is allowed.
 */
function coordinatorStore(label) {
  /*
   * NAMED, NOT ANONYMOUS, AND THAT IS A BUG FIX RATHER THAN A STYLE CHOICE.
   *
   * confirmProposal has to call assignTask and acceptTask. It used `this`, and
   * `this` was ALWAYS undefined at the point it ran: toolDefs DESTRUCTURES the
   * store --
   *
   *     const { listProposals, confirmProposal, ... } = store;
   *     run: async (a) => jsonResult(await confirmProposal(a))
   *
   * -- which detaches every method from its object. So confirm_proposal threw
   * "Cannot read properties of undefined (reading 'assignTask')" on EVERY CALL
   * IT HAS EVER RECEIVED.
   *
   * That is why 393 proposals had been prepared and ZERO ever confirmed. It was
   * read all day as the coordinator not doing its job. It was this.
   *
   * Nothing caught it because nothing called it: index.ts cannot be imported by
   * the suite, the tool was present in tools/list and correctly described, and
   * every test that touched it checked the DEFINITION rather than an
   * invocation. A tool can be listed, documented, scope-gated and completely
   * broken at the same time.
   *
   * Binding to the object by name removes the dependence on the call site
   * entirely -- a destructured reference and a method call now behave
   * identically, which is the only version that survives toolDefs.
   */
  const store = {
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
       * THE CLAIM IS THE WRITE, AND THE WRITE IS ATOMIC.
       *
       * This was a read-decide-PATCH with a state predicate bolted on. The
       * predicate closed the double-assignment race and nothing more: it could
       * refuse a stale decision, but it could not mint a fencing token, could
       * not bump the attempt counter, and could not put the assignment and its
       * outbox event in the same transaction.
       *
       * claim_task does all of that under `for update skip locked`, and it has
       * been applied and live in Postgres the whole time with nothing calling
       * it -- the safe implementation existing and unreachable while the
       * reachable one was unguarded. canAssign still runs first, because it
       * checks things Postgres cannot see from a row: whether the target
       * session is LIVE in the registry, and lane collisions across tasks.
       * claim_task is the authority on the row; canAssign is the authority on
       * the world around it.
       */
      const claim = await rpc('claim_task', {
        p_task_id: task_id,
        p_agent_id: resolved.agent_id,
        p_session_id: resolved.session_id,
        p_by: label,
      });
      if (!claim.ok) {
        // Surface the reason AND the detail. A caller that only sees
        // "assignment failed" cannot tell "retry, somebody else had it for a
        // moment" from "this task is cancelled and never coming back".
        return {
          ok: false,
          errors: [rpcRefusal(claim)],
          reason: claim.reason ?? null,
          detail: claim.detail ?? null,
        };
      }

      /*
       * THE ROW IS ADVISORY; THE LEASE IS THE FACT. This read happens AFTER the
       * transaction, so if the row moves between the claim and the read-back
       * the response can carry a task row that contradicts the lease just
       * minted. Nothing depends on it -- the token, expiry and attempt all come
       * from the function's own return value, inside the transaction. Do not
       * add a decision that reads the row instead. (code-d)
       */
      const claimed = await get(`tasks?select=*&task_id=eq.${encodeURIComponent(task_id)}&limit=1`);
      const row = claimed[0] ?? null;

      // The assignment is announced on the message log too, so a worker sees it
      // in one place rather than having to poll the task table.
      await write('messages', {
        task_id, from_agent: label, to_agent: resolved.agent_id,
        type: 'assignment',
        body: `Assigned ${task_id}: ${task.title}`,
      }, 'return=minimal');

      /*
       * THE LEASE TOKEN HAS TO REACH THE WORKER OR NONE OF THIS IS REAL.
       *
       * It is a fencing token, minted fresh on every claim, and it is the only
       * credential that renew_lease and return_with_lease accept. A worker that
       * is never told its token cannot renew and cannot return -- so it would
       * either be reaped mid-flight or be refused at submission after doing all
       * the work. The atomic claim without this field is a lock whose key was
       * thrown away.
       */
      return {
        ok: true,
        task: row,
        resolved_session: resolved.session_id,
        lease: {
          token: claim.lease_token,
          expires_at: claim.lease_expires_at,
          attempt: claim.attempt,
        },
      };
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
        ? await store.assignTask({ task_id: p.task_id, agent_id: p.agent_id })
        : await store.acceptTask({ task_id: p.task_id, note });

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
      /*
       * THE ROSTER IS FETCHED, AND UNTIL NOW IT WAS NOT.
       *
       * validateMessage has taken a `sessions` option since it was written, and
       * this -- its only caller -- never passed one. So the "unknown recipient
       * is refused" check has never run in production: the one branch that
       * could refuse an unreadable address was unreachable from the only path
       * that reaches it. A guard whose caller withholds its input is not a
       * weaker guard, it is an absent one.
       *
       * The clock goes with it. Without `now` liveness cannot be computed, and
       * validateMessage says so in a note rather than staying quiet, because
       * silence there is indistinguishable from "the recipient is fine".
       */
      const now = new Date().toISOString();
      let sessions = [];
      try {
        const regs = await get('session_registrations?select=*');
        sessions = regs.map((r) => ({
          agent_id: r.agent_id, session_id: r.session_id, lane_id: r.lane_id,
          capacity: r.capacity, heartbeat_at: r.heartbeat_at,
        }));
      } catch (e) {
        /*
         * A ROSTER WE COULD NOT READ MUST NOT REFUSE THE MESSAGE. Passing an
         * empty array would make every recipient look unknown and turn a
         * registry hiccup into a total coordination outage. Passing null skips
         * the recipient checks entirely, and the note below says the check did
         * not happen -- an unchecked send is reported, never silently blessed.
         */
        sessions = null;
      }

      const v = validateMessage(m, { sessions, now });
      if (!v.ok) return { ok: false, errors: v.errors };

      const notes = [...(v.notes ?? [])];
      if (sessions === null) {
        notes.push('the roster could not be read, so the recipient was not checked for '
          + 'existence or liveness; this message may be addressed to nobody');
      }

      const [row] = await write('messages', {
        task_id: m.task_id ?? null,
        from_agent: m.from_agent,
        to_agent: m.to_agent,
        type: m.type,
        body: m.body,
      });

      /*
       * THE NOTE TRAVELS WITH THE SUCCESS. `ok: true` on its own is what let
       * five reports land in a dead inbox and read as delivered.
       */
      return notes.length ? { ok: true, message: row, notes } : { ok: true, message: row };
    },


    /**
     * ANSWERING A QUESTION THE COORDINATOR IS ALLOWED TO ANSWER.
     *
     * THE REFUSAL IS THE FEATURE. If a coordinator could answer an owner-routed
     * request, the routing would be advisory, and "irreversible actions are the
     * owner's" would be a sentence in a comment rather than a property of the
     * system. Everything below this line would be decoration.
     *
     * THE ROUTING IS READ FROM THE ROW, NOT RECOMPUTED. The row records who it
     * was routed to when it was asked. Recomputing from the action here would
     * mean a later edit to the prefix table could hand the coordinator a
     * question that was escalated to the owner at the time it was filed --
     * silently, with no record that the routing had moved.
     */
    async decidePermissionRequest({ request_id, outcome, decided_by, note = null } = {}) {
      if (typeof request_id !== 'string' || !request_id.trim()) {
        return { ok: false, errors: ['request_id is required'] };
      }

      const rows = await get(
        `permission_requests?select=*&request_id=eq.${encodeURIComponent(request_id)}&limit=1`,
      );
      const r = rows[0] ?? null;

      /*
       * THE GUARD IS canDecidePermission IN src/permissionRequest.mjs, NOT HERE.
       *
       * It was here first, and that was the confirm_proposal mistake repeating:
       * index.ts cannot be imported by the test suite, so a guard written inside
       * it is a guard nobody can watch fail. The refusal that makes this whole
       * design worth having -- a coordinator may not answer an owner-routed
       * request -- is the last thing that should live untested.
       */
      const allowed = canDecidePermission(r, { as: DECIDER.COORDINATOR, outcome, decided_by });
      if (!allowed.ok) {
        return {
          ok: false,
          errors: allowed.errors,
          request: r
            ? { request_id: r.request_id, action: r.action, risk: r.risk, decider: r.decider }
            : null,
        };
      }

      /*
       * THE PREDICATE IS THE GUARD, NOT THE READ ABOVE.
       *
       * decided_at=is.null is in the filter, so a second decider writing between
       * the read and this line loses the race and PostgREST returns 200 with an
       * empty array. An empty array is a lost race, never a success -- the same
       * mistake the four task writes carried until 7d908a5.
       */
      const updated = await patch(
        `permission_requests?request_id=eq.${encodeURIComponent(request_id)}&decided_at=is.null`,
        {
          decided_at: new Date().toISOString(),
          decided_by: decided_by.trim(),
          outcome,
          decision_note: note,
        },
      );

      if (!updated.length) {
        return {
          ok: false,
          errors: ['the request was decided by somebody else between reading it and answering it'],
        };
      }

      return { ok: true, request: updated[0] };
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
      /*
       * THE ANSWER CLOSES THE QUESTION. An owner-routed request that the owner
       * has now decided must leave his list, or the list grows with things he
       * has already handled and stops being read.
       */
      const settled = await settleOpenRequestsAgainstPolicy({ decided_by: rec.owner_id });
      return { ok: true, decision: row, settled_requests: settled };
    },
  };

  return store;
}

const SHA40 = /^[0-9a-f]{40}$/i;
const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];
const SEGMENT = /^[^\\/]+$/;

/**
 * A lease token, which is a uuid because `return_with_lease(p_lease_token uuid)`
 * says so.
 *
 * WHY THIS EXISTS: A REFUSAL WAS WEARING TRANSPORT CLOTHING. `/return` checked
 * only that the token was a non-empty string and handed it to a uuid
 * parameter. A malformed token failed the cast in Postgres, PostgREST answered
 * non-2xx, `rpc()` threw, and the worker got a 500 -- while a well-formed but
 * SUPERSEDED token returned a clean 409.
 *
 * Those two read oppositely to a caller. A 409 is final; a 500 is transient and
 * invites a retry. And the worker most likely to send a damaged token is one
 * that crashed or resumed from a stale file -- the same population as the
 * zombies. So the single refusal shaped like "try again later" was aimed
 * precisely at the caller that must not retry. The fencing property was leaking
 * out through an error code. Found by code-d reviewing the implementation
 * rather than the gate.
 *
 * IT IS THE ONLY GUARD OF ITS KIND NEEDED HERE, and that was checked rather
 * than assumed -- one guard for one parameter is the shape that produced the
 * earlier 404. Every other argument this file hands an RPC is declared `text`:
 * claim_task takes five text parameters, and return_with_lease's `p_head_sha`
 * is text and is validated inside the function, which answers with a clean
 * `reason: 'head-sha'`. `p_lease_token` is the only non-text parameter on any
 * call site in this file.
 */
// UUID is declared once at the top of this file and used by both call sites.

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

    /*
     * THE TOKEN IS REQUIRED, AND THAT IS THE POINT.
     *
     * return_with_lease compares the token against the row and refuses a stale
     * one -- that refusal IS the zombie catch: a worker whose lease expired
     * while it kept working is stopped here, before its commit is recorded as
     * the answer to a task somebody else now holds.
     *
     * So there is deliberately NO fallback to the old predicate write when the
     * token is absent. A path that accepts a return without a token is a path
     * every zombie can take by simply not sending one, and a control that can
     * be skipped by omitting a field cannot be distinguished from its own
     * absence.
     */
    const leaseToken = typeof body?.lease_token === 'string' ? body.lease_token.trim() : '';
    if (!leaseToken) {
      return json({
        error: 'invalid_request',
        detail: 'lease_token is required. It is the fencing token handed back by assign_task '
          + 'as lease.token; without it a return cannot be told apart from one by a worker '
          + 'whose lease already expired.',
      }, 400);
    }

    /*
     * A MALFORMED TOKEN IS A REFUSAL, NOT A SERVER ERROR. See UUID above: this
     * shape used to reach Postgres, fail the uuid cast, and surface as a 500 --
     * the one answer that invites a retry, handed to the one caller that must
     * not retry. It answers 409 now, the same shape and status as a superseded
     * token, because to a worker those two mean the same thing: the credential
     * you hold is not one this task will accept, and trying again will not
     * change that.
     */
    if (!UUID.test(leaseToken)) {
      return json({
        error: 'return-refused',
        reason: 'stale-lease',
        detail: 'lease_token is not a well-formed lease token, so it cannot be the current '
          + 'lease for this task. Re-read it from the assignment rather than retrying.',
        errors: ['stale-lease: malformed lease_token'],
      }, 409);
    }

    /*
     * A task assigned BEFORE this wiring holds no token at all, so every token
     * fails the comparison and return_with_lease answers 'stale-lease' -- which
     * reads as "you lost the race" when the truth is "this task predates
     * leases". Name it, because the remedy is different: re-assign it to mint
     * one, rather than retry.
     */
    if (!task.lease_token) {
      return json({
        error: 'no-lease',
        detail: `${taskId} was assigned before the lease wiring and carries no lease token, `
          + 'so it cannot be returned through the lease path. Re-assign it to mint one.',
        state: task.state,
      }, 409);
    }

    const submitted = await rpc('return_with_lease', {
      p_task_id: taskId,
      p_lease_token: leaseToken,
      p_head_sha: body.head_sha,
      p_notes: typeof body?.notes === 'string' ? body.notes : null,
    });
    if (!submitted.ok) {
      return json({
        error: 'return-refused',
        reason: submitted.reason ?? null,
        detail: submitted.detail ?? null,
        errors: [rpcRefusal(submitted)],
      }, 409);
    }

    /*
     * THE ROW IS ADVISORY; THE LEASE IS THE FACT. This read happens AFTER the
     * transaction, so if the row moves between the claim and the read-back
     * the response can carry a task row that contradicts the lease just
     * minted. Nothing depends on it -- the token, expiry and attempt all come
     * from the function's own return value, inside the transaction. Do not
     * add a decision that reads the row instead. (code-d)
     */
    const after = await get(`tasks?select=*&task_id=eq.${encodeURIComponent(taskId)}&limit=1`);
    const updated = after[0] ?? null;

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

  // ── the REVIEWER's two verbs ─────────────────────────────────────────────
  /*
   * THE REVIEW LEASE HAS EXISTED SINCE 2026-09-15 AND NOTHING HAS EVER CLAIMED
   * IT. claim_review, renew_review_lease and expire_dead_reviews were written,
   * granted and scheduled with no caller anywhere -- the migration that added
   * them says so itself. These two routes are the caller.
   *
   * THEY TAKE A REGISTRATION TOKEN, the same credential a worker already holds,
   * and NOT a fifth token class. A reviewer is a registered session doing a
   * review; the credential says "this machine is one of ours", and every rule
   * that decides whether THIS session may review THIS task lives in
   * claim_review: the work must be 'returned', the returning session may not
   * review its own work, and a live lease held by somebody else refuses. None
   * of those is re-implemented here, because a copy of a rule is a copy that
   * can disagree, and this is the one rule whose violation leaves no trace --
   * an accepted task does not record who reviewed it against who wrote it.
   *
   * SO THIS FILE DECIDES NOTHING. It authenticates, resolves the session from
   * the registry rather than from the body, forwards, and maps a refusal to a
   * status. Everything that judges the work is in src/reviewRunner.mjs and
   * src/reviewDecision.mjs, where the test suite can import it -- a guard that
   * cannot be imported is a guard nobody has watched fail.
   */
  if (path === '/review/claim' || path === '/review/submit') {
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

    /*
     * THE REVIEWER IS RESOLVED FROM THE REGISTRY, NOT TAKEN FROM THE BODY.
     * Same rule as /return: a session that is not registered cannot review
     * anything, and a caller does not get to name itself. It matters more here
     * than there -- claim_review's self-review refusal compares this string to
     * returned_by, so a caller that could choose it could review its own work
     * by typing a different name.
     */
    const claimed = typeof body?.reviewer_session === 'string' ? body.reviewer_session.trim() : '';
    const regs = await get('session_registrations?select=*');
    const row = regs.find((r) => r?.session_id === claimed);
    if (!row) {
      return json({
        error: 'unknown-session',
        detail: `session "${claimed}" is not registered; register before reviewing work`,
      }, 409);
    }

    if (path === '/review/claim') {
      const seconds = Number.isInteger(body?.lease_seconds) ? body.lease_seconds : 1800;
      const claimed_ = await rpc('claim_review', {
        p_task_id: taskId,
        p_reviewer_session: row.session_id,
        p_lease_seconds: seconds,
      });
      if (!claimed_.ok) {
        return json({
          error: 'review-claim-refused',
          reason: claimed_.reason ?? null,
          detail: claimed_.detail ?? null,
        }, 409);
      }
      return json(claimed_);
    }

    /*
     * THE FENCED SUBMIT. The token travels with the decision and submit_review
     * compares it inside the write.
     *
     * A MALFORMED TOKEN IS 409, NOT 500 AND NOT 400. Identical reasoning to the
     * lease_token guard on /return: this shape used to reach Postgres, fail the
     * uuid cast and surface as a 500 -- the one answer that invites a retry,
     * handed to the one caller that must not retry. To a reviewer, malformed
     * and superseded mean the same thing: the credential you hold is not one
     * this task will accept, and trying again will not change that.
     */
    const reviewToken = typeof body?.review_lease_token === 'string'
      ? body.review_lease_token.trim() : '';
    if (!reviewToken) {
      return json({
        error: 'invalid_request',
        detail: 'review_lease_token is required. It is the fencing token handed back by '
          + '/review/claim; without it a decision cannot be told apart from one by a reviewer '
          + 'whose lease already expired.',
      }, 400);
    }
    if (!UUID.test(reviewToken)) {
      return json({
        error: 'review-submit-refused',
        reason: 'review-lease-not-current',
        detail: 'review_lease_token is not a well-formed lease token, so it cannot be the '
          + 'current review lease for this task. Re-read it from the claim rather than retrying.',
      }, 409);
    }

    const recorded = await rpc('submit_review', {
      p_task_id: taskId,
      p_review_token: reviewToken,
      p_decision: typeof body?.decision === 'string' ? body.decision : null,
      p_reasons: Array.isArray(body?.reasons) ? body.reasons : [],
      p_reviewer_session: row.session_id,
      p_head_sha: typeof body?.head_sha === 'string' ? body.head_sha : null,
      p_fix_task: body?.fix_task ?? null,
    });
    if (!recorded.ok) {
      return json({
        error: 'review-submit-refused',
        reason: recorded.reason ?? null,
        detail: recorded.detail ?? null,
      }, 409);
    }
    return json(recorded);
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
  /**
   * /task — A WORKER READS ITS OWN WORK, AND ITS OWN FENCING TOKEN.
   *
   * ═══ THE OMISSION THIS CLOSES ═══
   *
   * `eventsFor` emits an assignment and says, in its own comment, that it is
   * "enough to know WHICH task, never enough to act without reading it". That
   * is correct: the outbox is at-least-once by construction, so an event body
   * is never trustworthy and the worker must re-read the authority.
   *
   * There was nowhere to read it from. /wait returns events, /register is
   * registration state, /return is write-only, and the MCP surface 401s a
   * registration token. A worker was told which task it held, told to read it
   * before acting, and could do neither.
   *
   * ═══ WHY THE LEASE TOKEN COMES FROM HERE AND NOT FROM THE EVENT ═══
   *
   * c8's argument, and it changed a decision already committed at 0f47999,
   * which put the token on the assigned event instead. That version worked and
   * this one is better, for three reasons that only became visible once both
   * existed:
   *
   *   THE WORKER MUST CALL THIS ANYWAY. The event is deliberately not
   *   sufficient to act on, so the second call is not a cost this avoids -- it
   *   is a call that always happens. Putting the token on the event made it
   *   redundant rather than convenient.
   *
   *   A CREDENTIAL DOES NOT BELONG IN A REPLAYABLE FEED. Events are
   *   at-least-once and cursor-driven; the same event can arrive twice, or
   *   late. This is a point-in-time authenticated read that returns the CURRENT
   *   token or nothing.
   *
   *   IT ERODED THE DOORBELL. An event carrying a credential is an event that
   *   is ALMOST enough to act on, and "almost enough" is the property the
   *   doorbell design exists to refuse.
   *
   * ═══ THE GUARD IS ownTask/ownTasks IN src/ownWork.mjs ═══
   *
   * Not here. index.ts cannot be imported by the suite, so a guard written in
   * it is a guard nobody has watched fail -- which is exactly where
   * confirm_proposal sat while it threw on every call for its whole life. The
   * scope rule, the field list and the "not found and not yours are the same
   * answer" behaviour are all tested in test/ownWork.test.mjs.
   *
   * THE SESSION IS RESOLVED FROM THE REGISTRY, never taken from the body, for
   * the same reason /wait does it: a session that never checked in has no work
   * to read. The registration token is shared across workers, so the identity
   * that matters is the assignment itself -- which only a coordinator could
   * have arranged.
   */
  /**
   * /renew — HOLD THE LEASE WHILE THE WORK IS STILL RUNNING.
   *
   * ═══ THE THIRD OMISSION IN THE SAME FAMILY ═══
   *
   * `renew_lease` has existed as a SECURITY DEFINER function, granted to
   * service_role, since the lease migration. NOTHING EXPOSED IT. Reachable from
   * no endpoint, no CLI command, and no test outside the migration.
   *
   * That is not cosmetic. The default lease is 900 seconds and the default run
   * timeout is 1800. A worker doing a normal-length task on a normal-length
   * lease would lose it EVERY TIME, discard completed work as a zombie result,
   * and be entirely right to — the runtime's whole design assumes renewal
   * works, and renewal could not be called.
   *
   * Three omissions found the same way, by building the consumer: the lease
   * token was never delivered, a worker had nowhere to read its own task, and
   * renewal had no route. All three existed as correct, tested, unreachable
   * code. Nothing had noticed because nothing had ever been a worker.
   *
   * ═══ THE SQL FUNCTION IS THE AUTHORITY, NOT THIS HANDLER ═══
   *
   * It would be shorter to do a conditional PATCH here with the token in the
   * predicate. That would be a SECOND implementation of "may this lease be
   * extended", and they would disagree the first time one changed. renew_lease
   * already encodes compare-and-set against the token and refuses an expired
   * lease; canRenew in src/leases.mjs is its tested pure twin. This handler
   * authenticates, validates shape, and calls them.
   */
  if (path === '/renew') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let renewLabel = null;
    try {
      renewLabel = await tokenLabel('registration_tokens', bearer);
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    if (!renewLabel) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_request', detail: 'body must be JSON' }, 400); }

    const taskId = typeof body?.task_id === 'string' ? body.task_id.trim() : '';
    if (!taskId) return json({ error: 'invalid_request', detail: 'task_id is required' }, 400);

    const leaseToken = typeof body?.lease_token === 'string' ? body.lease_token.trim() : '';
    if (!leaseToken) {
      return json({ error: 'invalid_request', detail: 'lease_token is required' }, 400);
    }

    /*
     * A MALFORMED TOKEN IS A REFUSAL, NOT A SERVER ERROR, and it answers with
     * the SAME shape and status as a superseded one. To a worker the two mean
     * the same thing: this credential is not one the task will accept, and
     * retrying will not change that.
     */
    if (!UUID.test(leaseToken)) {
      return json({
        ok: false,
        reason: 'stale-lease',
        detail: 'lease_token is not a valid token; re-read the task with /task',
      }, 409);
    }

    const asked = Number.parseInt(body?.lease_seconds ?? '900', 10);
    const seconds = Number.isFinite(asked) ? asked : 900;

    let out;
    try {
      out = await rpc('renew_lease', {
        p_task_id: taskId, p_lease_token: leaseToken, p_lease_seconds: seconds,
      });
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }

    /*
     * THE FUNCTION'S OWN VERDICT IS THE ANSWER. A refusal is a decision the
     * authority made, so it comes back as 409 rather than 500 — the same
     * distinction as everywhere else on this surface: an answer is not a
     * transport failure.
     */
    if (out?.ok === false) return json(out, 409);
    return json(out ?? { ok: false, reason: 'no-answer' }, out?.ok ? 200 : 409);
  }

  if (path === '/task') {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

    let taskLabel = null;
    try {
      taskLabel = await tokenLabel('registration_tokens', bearer);
    } catch (e) {
      return json({ error: 'upstream-unavailable', detail: String(e?.message ?? e) }, 502);
    }
    if (!taskLabel) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_request', detail: 'body must be JSON' }, 400); }

    const claimed = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
    if (!claimed) return json({ error: 'invalid_request', detail: 'session_id is required' }, 400);

    const regs = await get('session_registrations?select=*');
    const me = regs.find((r) => r?.session_id === claimed);
    if (!me) {
      return json({
        error: 'unknown-session',
        detail: `session "${claimed}" is not registered; register before reading work`,
      }, 409);
    }

    const rows = await get('tasks?select=*');
    const wanted = typeof body?.task_id === 'string' ? body.task_id.trim() : '';

    if (wanted) {
      const task = ownTask(rows, { task_id: wanted, session_id: me.session_id });
      /*
       * NOT FOUND AND NOT YOURS ARE THE SAME 404, deliberately. Splitting them
       * would let a worker enumerate which task ids exist by watching for a 404
       * versus a 403, and the caller does nothing differently either way.
       */
      if (!task) return json({ error: 'no-such-task', detail: wanted }, 404);
      return json({ ok: true, task });
    }

    /*
     * NO task_id MEANS "WHAT AM I HOLDING". A worker restarting after a crash
     * has lost its cursor with the process, so there is no event to replay --
     * without this it sits idle while its lease runs down on work nobody else
     * can take until the reaper frees it.
     */
    return json({ ok: true, tasks: ownTasks(rows, { session_id: me.session_id }) });
  }

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
