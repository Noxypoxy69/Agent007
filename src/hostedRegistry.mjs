/**
 * THE CROSS-MACHINE HALF OF THE REGISTRY.
 *
 * Local registrations answer "who is running on THIS machine". They cannot
 * answer "is code-b alive on the other machine", which is the question a
 * delegation across machines actually asks. That answer lives in the dedicated
 * Agent Bridge Supabase project and nowhere else.
 *
 * FAIL CLOSED, AND THIS IS THE WHOLE POINT OF THE MODULE.
 *
 * When the hosted registry cannot be read, the tempting behaviour is to carry
 * on with whatever local state exists and record the target as unverified. That
 * would mean an outage silently downgrades every delegation from verified to
 * accepted-on-trust -- turning a broken dependency into a permissive one, at
 * precisely the moment nobody is watching. Worse, it is indistinguishable from
 * normal operation on a machine that has no hosted config.
 *
 * So the two cases are kept apart and named differently:
 *
 *   NOT CONFIGURED   no hosted project set up. Local-only is honest and fine.
 *   UNREACHABLE      configured and failing. REFUSE. Do not downgrade.
 *
 * READ-ONLY HERE. Writes go through the registering process, which is the only
 * thing that can see git.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Release node's HTTP connection pool before the process exits.
 *
 * WHY THIS EXISTS. `fetch` is undici, which keeps a global dispatcher with
 * pooled sockets. A CLI calls process.exit() the instant it has printed, and on
 * Windows exiting while that pool still holds handles trips a libuv assertion:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * The command printed the correct answer and then died with exit 127, so every
 * caller checking an exit code saw a failure that had not happened. Setting
 * `connection: close` on the request is not sufficient -- the dispatcher itself
 * is the handle.
 *
 * Awaiting close() drains it properly. Failures are swallowed on purpose: this
 * runs on the way out, and a tidy-up that can fail a command is worse than the
 * untidiness it prevents.
 */
export async function closeHttp() {
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch { /* exiting anyway */ }
}

/** Distinguishable outcomes. `unreachable` must never be treated as `absent`. */
/**
 * ANY HTTP RESPONSE IS AN ANSWER. `UNREACHABLE` MEANS NOBODY ANSWERED.
 *
 * ═══ THE THIRD TIME THIS BUG WAS FOUND IN THIS FILE ═══
 *
 * b6 ran `return-task` three times over twenty minutes and got
 * "the Bridge is unreachable (d-claims-authz-b6)". It reported to Danny that
 * the Bridge was down. It was not — `wait-for-work` answered the whole time.
 * What the Bridge actually said was:
 *
 *     404  {"error":"no-such-task","detail":"d-claims-authz-b6"}
 *
 * b6's tell is the best part of the report and belongs here: **UNREACHABLE
 * details are "timeout", "no fetch available", "http 500". A detail that is an
 * IDENTIFIER means the far end answered and formed an opinion about it.**
 *
 * ═══ WHY IT KEPT COMING BACK: I FIXED INSTANCES, NOT THE CLASS ═══
 *
 * 401 was fixed after b6 found it live. Then 409. Then 400, on a branch. Each
 * fix was a new `if (res.status === N)` branch bolted onto a ladder whose
 * FALLBACK still said UNREACHABLE — so every status nobody had been bitten by
 * yet kept the bug, and 404 walked straight past three fixes.
 *
 * And it was never one ladder. There are FOUR call sites in this file, each
 * with its own `if (!res.ok) return UNREACHABLE`. Every one had the same hole.
 * Patching a fifth status would have left the other thirty.
 *
 * This is rule 8 in CLAUDE.md turned on me: *an adversarial probe bounds
 * nothing; fix the matcher, not the strings the prober happened to try.* I
 * wrote that this morning about somebody else's finding.
 *
 * ═══ THE RULE, ONCE, FOR EVERY CALL SITE ═══
 *
 *   401 / 403   REJECTED    the credential was refused — fix the credential
 *   other 4xx   REFUSED     the far end understood and said no — read the reason
 *   5xx         UNREACHABLE it answered but cannot serve — retry may help
 *   no response UNREACHABLE timeout, abort, no fetch — check the transport
 *
 * The specific branches that remain at the call sites are SPECIALISATIONS that
 * must agree with this function, not alternatives to it. A test asserts they
 * agree on every status they overlap on, so the ladder cannot drift again.
 *
 * @returns null when the response is OK, otherwise the state to report.
 */
export async function interpretHttp(res, { credential = 'registration token' } = {}) {
  if (res.ok) return null;

  let errors = [];
  let parsed = null;
  try {
    const b = await res.json();
    if (Array.isArray(b?.errors) && b.errors.length) {
      errors = b.errors;
      parsed = b.errors.join('; ');
    } else if (b?.error && b?.detail) {
      parsed = `${b.error}: ${String(b.detail).slice(0, 200)}`;
    } else if (b?.detail) {
      parsed = String(b.detail).slice(0, 200);
    } else if (b?.error) {
      parsed = String(b.error).slice(0, 200);
    }
  } catch { /* a body we cannot read does not change the STATE */ }

  if (res.status === 401 || res.status === 403) {
    return { state: HOSTED.REJECTED, detail: `${credential} rejected (${res.status})`, errors };
  }
  if (res.status >= 400 && res.status < 500) {
    return { state: HOSTED.REFUSED, detail: parsed ?? `http ${res.status}`, errors };
  }
  /*
   * 5xx stays UNREACHABLE, and its detail keeps the status in front. The server
   * answered but cannot serve, so retrying is reasonable and the worker has
   * nothing to fix -- which is what UNREACHABLE is for. Leading with "http 500"
   * preserves b6's tell: a detail that is an identifier means a decision.
   */
  return {
    state: HOSTED.UNREACHABLE,
    detail: parsed ? `http ${res.status}: ${parsed}` : `http ${res.status}`,
    errors,
  };
}

export const HOSTED = {
  NOT_CONFIGURED: 'not-configured',
  OK: 'ok',
  UNREACHABLE: 'unreachable',
  MALFORMED: 'malformed',
  /*
   * REFUSED is not UNREACHABLE, and the difference is the whole point.
   *
   * The Bridge answered, understood the request, and said no -- the task is not
   * yours, or it is not in a state that can be returned. Collapsing that into
   * "unreachable" would send a worker to check its network for a decision the
   * server made deliberately, and it would invite a retry that can only ever
   * be refused again.
   */
  REFUSED: 'refused',
  /*
   * REJECTED is not UNREACHABLE either, and this one was WRONG IN THE CODE
   * WHILE THE COMMENT NEXT TO IT SAID OTHERWISE.
   *
   * Found by b6 probing live: `register-session` with a reader token printed
   * "registered", wrote a local roster row, reported the hosted half as
   * "UNREACHABLE (401)", and EXITED 0. Anything scripting the CLI reads exit 0
   * as success.
   *
   * Two separate wrongs. A 401 means somebody answered and said no -- it is a
   * decision, not a transport failure -- so calling it unreachable sends the
   * reader to check a network they cannot fix instead of a credential they can.
   * And a command whose central act was refused must not exit 0.
   *
   * The comment at the 401 branch already said "a rejected credential is NOT
   * the same as an unreachable service". It then returned UNREACHABLE. Prose
   * describing an intention as though it were a behaviour, which is the same
   * failure as the reviewer lease whose columns nothing wrote.
   *
   * REJECTED IS PERMANENT UNTIL SOMEBODY CHANGES A CREDENTIAL. That is the
   * operational difference that matters: unreachable is worth retrying, and
   * rejected is not. A watcher should survive the first and stop on the second.
   */
  REJECTED: 'rejected',
};

/*
 * hostedConfig() USED TO LIVE HERE AND IS DELETED ON PURPOSE.
 *
 * It read AGENTBRIDGE_SUPABASE_URL and AGENTBRIDGE_SUPABASE_KEY, and once the
 * read path moved to a reader token and the write path to a registration token,
 * nothing called it. It survived as an orphan whose only remaining effect was
 * to ADVERTISE a requirement that no longer existed: a worker reading this file
 * would conclude it needed a database key, and the error message that named
 * those variables was, as c8 put it, an instruction to go and find one.
 *
 * An orphan that tells people to install a production credential is worse than
 * an orphan. Deleted rather than deprecated, so the wrong answer cannot be
 * copied from it.
 *
 *   read  -> readerConfig()        AGENTBRIDGE_READER_TOKEN
 *   write -> registrationConfig()  AGENTBRIDGE_REGISTRATION_TOKEN
 *
 * Neither is a database key, and no worker machine holds one.
 */

/**
 * Where a worker PUBLISHES its own liveness.
 *
 * NO SERVICE KEY ON WORKER MACHINES. The previous design needed
 * AGENTBRIDGE_SUPABASE_KEY -- a full read/write database credential on every
 * laptop, to write one row about itself. The blast radius of that was the whole
 * database; the need was one row.
 *
 * Now the worker holds a scoped REGISTRATION token and posts to the Edge
 * Function, which performs the write with the key Supabase injects into it. The
 * service key never leaves Supabase, a compromised worker can publish liveness
 * and nothing else, and revoking one machine is flipping one column.
 *
 * The endpoint defaults to the deployed function, so a worker needs exactly one
 * environment variable rather than three.
 */
export function registrationConfig(env = {}) {
  const token = env.AGENTBRIDGE_REGISTRATION_TOKEN ?? '';
  if (!token) return null;
  const url = String(
    env.AGENTBRIDGE_REGISTER_URL
    ?? 'https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp/register',
  );
  return { url, token };
}

/**
 * Where a worker HANDS ITS OWN WORK BACK.
 *
 * Same credential as a heartbeat: a worker already holds a registration token,
 * and returning its own assigned task is the same class of act as publishing
 * its own liveness -- a statement about itself, verified against the registry
 * rather than trusted.
 *
 * The URL is DERIVED from the registration endpoint so a worker still needs
 * exactly one environment variable. If the register URL has been overridden to
 * something that does not end in /register, this REFUSES rather than guessing:
 * posting a return to whatever path happened to be there is how a worker
 * reports success into a void.
 */
export function returnConfig(env = {}) {
  const reg = registrationConfig(env);
  if (!reg) return null;

  const override = env.AGENTBRIDGE_RETURN_URL;
  if (typeof override === 'string' && override.trim()) {
    return { url: override.trim(), token: reg.token };
  }
  if (!/\/register$/.test(reg.url)) return null;
  return { url: reg.url.replace(/\/register$/, '/return'), token: reg.token };
}

/**
 * Where a worker WAITS to be woken.
 *
 * Derived from the registration endpoint on the same rule as returnConfig: one
 * environment variable for a worker, and a refusal rather than a guess when the
 * base URL is not the shape this expects. A wait posted to the wrong path hangs
 * until it times out and reports "nothing happened", which is the most
 * expensive possible way to be wrong.
 */
export function waitConfig(env = {}) {
  const reg = registrationConfig(env);
  if (!reg) return null;

  const override = env.AGENTBRIDGE_WAIT_URL;
  if (typeof override === 'string' && override.trim()) {
    return { url: override.trim(), token: reg.token };
  }
  if (!/\/register$/.test(reg.url)) return null;
  return { url: reg.url.replace(/\/register$/, '/wait'), token: reg.token };
}

/**
 * Hold a request open until something is addressed to this session.
 *
 * The timeout here is the CLIENT's patience and must exceed the server's, or
 * every wait ends as a client-side abort and the worker can never tell "nothing
 * happened" from "the connection broke".
 */
export async function waitForEvents(env = {}, body, { fetchImpl, timeoutMs = 40000 } = {}) {
  const cfg = waitConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      return { state: HOSTED.REJECTED, detail: 'registration token rejected (401)' };
    }
    if (res.status === 409 || res.status === 400) {
      let detail = `http ${res.status}`;
      try { detail = (await res.json())?.detail ?? detail; } catch { /* keep it */ }
      return { state: HOSTED.REFUSED, detail };
    }
    const answered = await interpretHttp(res, { credential: 'registration token' });
    if (answered) return answered;

    const b = await res.json().catch(() => null);
    if (!b || !Array.isArray(b.events)) {
      // A malformed answer must not read as "nothing happened": that is the one
      // interpretation that makes a worker sleep through its own work.
      return { state: HOSTED.MALFORMED, detail: 'no events array in the reply' };
    }
    return { state: HOSTED.OK, events: b.events, cursor: b.cursor ?? null, waited_ms: b.waited_ms ?? null };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return one assigned task, with the commit that carries the work.
 *
 * @returns {{state: string, detail?: string, task?: object, errors?: string[]}}
 */
export async function returnWork(env = {}, body, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = returnConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        // See closeHttp: a pooled socket outliving the process trips a libuv
        // assertion on Windows.
        connection: 'close',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      return { state: HOSTED.REJECTED, detail: 'registration token rejected (401)' };
    }

    /*
     * 409 IS AN ANSWER, NOT A FAILURE TO REACH.
     *
     * The guard refused: wrong session, wrong state, no commit. Those reasons
     * are the useful part of the response and are passed through verbatim
     * rather than flattened into a status line -- a worker that is told only
     * "refused" will retry, and a worker told "this is assigned to
     * danny-win-10, not you" will stop.
     */
    if (res.status === 409) {
      let errors = [];
      let detail = 'refused';
      try {
        const b = await res.json();
        if (Array.isArray(b?.errors)) errors = b.errors;
        if (typeof b?.detail === 'string') detail = b.detail;
      } catch { /* keep the default */ }
      return { state: HOSTED.REFUSED, errors, detail };
    }

    const answered = await interpretHttp(res, { credential: 'registration token' });
    if (answered) return answered;

    const b = await res.json().catch(() => ({}));
    return { state: HOSTED.OK, task: b?.task ?? null };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch hosted registrations.
 *
 * @returns {{state: string, rows?: Array, detail?: string}}
 */
/**
 * Where a client READS the hosted roster.
 *
 * Through the MCP surface with a READER token -- the same credential and the
 * same endpoint ChatGPT uses. The previous version queried PostgREST directly
 * with the service key, which meant `agentbridge workers` could only see hosted
 * state on a machine holding a full database credential. That is exactly the
 * key the registration write path exists to eliminate, so reading it back
 * through the front door removes the last reason to have one locally.
 */
export function readerConfig(env = {}) {
  const token = env.AGENTBRIDGE_READER_TOKEN ?? '';
  if (!token) return null;
  const url = String(
    env.AGENTBRIDGE_MCP_URL
    ?? 'https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp',
  );
  return { url, token };
}

export async function fetchHostedRegistrations(env = {}, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = readerConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        // DO NOT POOL THIS SOCKET. A CLI process calls process.exit() the
        // instant it has printed, and on Windows exiting while undici holds a
        // keep-alive socket trips a libuv assertion in async.c -- the command
        // printed the right answer and then died with exit 127, so anything
        // checking the exit code saw a failure. A short-lived command has
        // nothing to gain from connection reuse anyway.
        connection: 'close',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_agents', arguments: {} },
      }),
    });
    if (res.status === 401) {
      // A rejected credential is not an unreachable service. Collapsing them
      // has somebody restarting a network they cannot fix instead of rotating
      // a token they can.
      return { state: HOSTED.REJECTED, detail: 'reader token rejected (401)' };
    }
    const answered = await interpretHttp(res, { credential: 'reader token' });
    if (answered) return answered;

    const body = await res.json();
    const text = body?.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      return { state: HOSTED.MALFORMED, detail: 'no tool result in the response' };
    }

    let rows;
    try { rows = JSON.parse(text); } catch { rows = null; }
    // Not an array is MALFORMED, not empty. An empty array is a real and calm
    // answer ("nobody is registered"); a malformed body is a broken dependency,
    // and rendering the two identically is how an outage becomes "no workers".
    if (!Array.isArray(rows)) return { state: HOSTED.MALFORMED, detail: 'tool result was not an array' };

    return { state: HOSTED.OK, rows: rows.map(fromToolResult) };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape a list_agents row like a local registration.
 *
 * `origin: 'hosted'` is added rather than folded in: a local-only registration
 * and a hosted one must stay distinguishable, because the second is a claim
 * another machine can check and the first is not.
 */
function fromToolResult(r) {
  return {
    session_id: r?.sessionId ?? null,
    agent_id: r?.agentId ?? null,
    machine_id: r?.machine ?? null,
    repo_id: r?.repoId ?? null,
    worktree_id: r?.worktree ?? null,
    lane_id: r?.lane ?? null,
    capacity: r?.capacity ?? 'idle',
    head_sha: r?.head ?? null,
    verification: 'runtime-self-registration',
    heartbeat_at: r?.lastSeenAt ?? null,
    origin: 'hosted',
  };
}

/**
 * Publish this session's registration.
 *
 * WHAT IS SENT AND WHAT IS NOT. heartbeat_at, created_at and updated_at are
 * deliberately absent from the body: the database stamps them in a trigger, and
 * sending them would be sending a value the server is about to discard. That is
 * not merely redundant -- a caller who believes its timestamp matters will
 * eventually be written to depend on it.
 *
 * Returns the same state vocabulary as the read path, so a caller never has to
 * tell an outage from a misconfiguration by inspecting an error string.
 */
export async function publishRegistration(env = {}, row, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = registrationConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };
  }

  /*
   * WHAT IS SENT AND WHAT IS NOT. heartbeat_at, created_at and updated_at are
   * absent deliberately: a database trigger stamps all three, and sending one
   * would be sending a value the server discards. That is not merely redundant
   * -- a caller who believes its timestamp matters will eventually be written
   * to depend on it, and a worker able to set its own heartbeat could keep a
   * dead session live forever.
   */
  const body = {
    session_id: row.session_id,
    agent_id: row.agent_id,
    machine_id: row.machine_id,
    repo_id: row.repo_id ?? null,
    worktree_id: row.worktree_id ?? null,
    lane_id: row.lane_id ?? null,
    capacity: row.capacity ?? 'idle',
    head_sha: row.head_sha ?? null,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        // See fetchHostedRegistrations: a pooled socket outliving process.exit()
        // trips a libuv assertion on Windows. --watch reuses nothing between
        // heartbeats either, so there is no cost.
        connection: 'close',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      // A rejected credential is NOT the same as an unreachable service, and
      // collapsing them would have somebody restarting a network they cannot
      // fix instead of rotating a token they can. This comment said so while
      // the line below returned UNREACHABLE; b6 found it by probing live.
      return { state: HOSTED.REJECTED, detail: 'registration token rejected (401)' };
    }
    const answered = await interpretHttp(res, { credential: 'registration token' });
    if (answered) return answered;
    return { state: HOSTED.OK };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape a hosted row like a local registration, so src/liveRegistry.mjs can
 * consume both without caring where a worker came from.
 *
 * `origin` is added rather than folded in: a local-only registration and a
 * hosted-verified one must remain visibly distinguishable, because the second
 * is a claim another machine can check and the first is not.
 */
function toRegistration(r) {
  return {
    session_id: r?.session_id ?? null,
    agent_id: r?.agent_id ?? null,
    machine_id: r?.machine_id ?? null,
    repo_id: r?.repo_id ?? null,
    worktree_id: r?.worktree_id ?? null,
    lane_id: r?.lane_id ?? null,
    capacity: r?.capacity ?? 'idle',
    head_sha: r?.head_sha ?? null,
    verification: r?.verification_state ?? 'runtime-self-registration',
    heartbeat_at: r?.heartbeat_at ?? null,
    origin: 'hosted',
  };
}

/**
 * FIELDS WHERE A DISAGREEMENT MEANS THE TWO REGISTRIES DESCRIBE DIFFERENT
 * WORKERS, NOT THE SAME ONE FROM DIFFERENT ANGLES.
 *
 * Liveness legitimately differs -- the hosted heartbeat is server-stamped and
 * the local one is not, so one being fresher is normal and says nothing. These
 * four decide ROUTING. If local thinks a session belongs to `code-b` and hosted
 * thinks it belongs to `b6`, an assignment goes to one of them and the operator
 * is looking at the other.
 */
export const IDENTITY_FIELDS = Object.freeze(['agent_id', 'lane_id', 'repo_id', 'worktree_id']);

/**
 * Merge local and hosted registrations into one roster.
 *
 * A session present in both is ONE worker, and the hosted row wins on liveness
 * because its heartbeat is server-stamped and therefore the one a second
 * machine can trust. The local row wins on nothing; it is the same worker seen
 * from closer up.
 *
 * ═══ BUT A DISAGREEMENT ABOUT IDENTITY IS NOT A MERGE, IT IS A FAULT ═══
 *
 * This did `{ ...existing, ...r, origin: 'hosted' }` and nothing else, so hosted
 * silently overwrote local and the disagreement vanished in the same expression
 * that created it. Nothing downstream could report what it never saw.
 *
 * Found by c8 the way these things always surface -- a WRITE refused:
 *
 *     unregister-session -> session_owned_by_another_agent,
 *                           'social-sparks-app-b6' held by agent 'b6'
 *
 * The hosted registry had that session as `b6`; the local store had it as
 * `code-b`. Both had been wrong about each other for hours, every read was
 * silently consistent, and the first thing to notice was a refusal at the far
 * end of an unrelated command.
 *
 * TWO SOURCES WITH NO COMPARISON IS NOT TWO SOURCES, IT IS ONE SOURCE AND A
 * DECOY. The hosted row still wins -- it is the cross-machine authority and
 * picking the other way would be worse -- but the conflict is now attached to
 * the row it happened on, so a roster can show it and a person can see it
 * before a write fails.
 *
 * NOT AN EXCEPTION, DELIBERATELY. A roster that throws is a roster nobody can
 * read during exactly the incident it is describing. The conflict travels as
 * data and the caller decides how loud to be about it.
 */
export function mergeRegistrations(local = [], hosted = []) {
  const bySession = new Map();
  for (const r of local) {
    if (!r?.session_id) continue;
    bySession.set(r.session_id, { ...r, origin: r.origin ?? 'local' });
  }
  for (const r of hosted) {
    if (!r?.session_id) continue;
    const existing = bySession.get(r.session_id);
    if (!existing) { bySession.set(r.session_id, { ...r, origin: 'hosted' }); continue; }

    /*
     * COMPARED BEFORE IT IS OVERWRITTEN. Once the spread has run the two values
     * are one value and the disagreement is unrecoverable, so the check has to
     * happen here or not at all.
     *
     * A field the local row simply does not carry is NOT a conflict -- absence
     * is not disagreement, and treating it as one would make every partial
     * local record look like a fault.
     */
    const conflicts = IDENTITY_FIELDS
      .filter((f) => existing[f] != null && r[f] != null && existing[f] !== r[f])
      .map((f) => ({ field: f, local: existing[f], hosted: r[f] }));

    bySession.set(r.session_id, {
      ...existing,
      ...r,
      origin: 'hosted',
      ...(conflicts.length ? { conflicts } : {}),
    });
  }
  return [...bySession.values()].sort((a, b) =>
    String(a.session_id).localeCompare(String(b.session_id)));
}

/**
 * ═══ THE THREE ROUTES A WORKER RUNTIME NEEDS, AND WHY THEY WERE MISSING ═══
 *
 * A worker holds a REGISTRATION token, which reaches only /register, /wait and
 * /return. Building the runtime turned up three things it had to do and could
 * not:
 *
 *   READ ITS OWN TASK    the assigned event says "enough to know WHICH task,
 *                        never enough to act without reading it" — and there
 *                        was nothing to read from. /task.
 *   RENEW ITS LEASE      renew_lease existed as a granted SECURITY DEFINER
 *                        function reachable from no endpoint at all. The
 *                        default lease is 900s and the default run timeout
 *                        1800s, so a worker doing a normal task would have lost
 *                        its lease EVERY TIME. /renew.
 *   RETURN ITS WORK      /return, which already existed.
 *
 * All three configs derive from the register URL for the same reason
 * returnConfig does: one hosted base, and an override per route for the tests
 * and for anyone running a split deployment.
 */

const derived = (env, suffix, override) => {
  const reg = registrationConfig(env);
  if (!reg) return null;
  const raw = env[override];
  if (typeof raw === 'string' && raw.trim()) return { url: raw.trim(), token: reg.token };
  if (!/\/register$/.test(reg.url)) return null;
  return { url: reg.url.replace(/\/register$/, suffix), token: reg.token };
};

export function taskConfig(env = {}) { return derived(env, '/task', 'AGENTBRIDGE_TASK_URL'); }
export function renewConfig(env = {}) { return derived(env, '/renew', 'AGENTBRIDGE_RENEW_URL'); }

/**
 * Read the caller's own task, or everything it holds when no id is given.
 *
 * The "everything it holds" form is the one a restarted worker needs: after a
 * crash the cursor is gone with the process, so there is no event to replay,
 * and without it the worker sits idle while its lease runs down on work nobody
 * else can take.
 */
export async function fetchOwnTask(env = {}, { session_id, task_id = null } = {},
  { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = taskConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify(task_id ? { session_id, task_id } : { session_id }),
    });

    const answered = await interpretHttp(res, { credential: 'registration token' });
    if (answered) return answered;

    const b = await res.json().catch(() => ({}));
    return { state: HOSTED.OK, task: b?.task ?? null, tasks: Array.isArray(b?.tasks) ? b.tasks : null };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extend the lease on work still in progress.
 *
 * A REFUSAL HERE IS FINAL AND MUST NOT BE RETRIED. It means this process is no
 * longer the holder — the task was reaped and re-claimed, or the token is not
 * one the task will accept. The runtime treats it as ABANDON, discards the
 * result, and stops; retrying would at best succeed against a lease it does not
 * own. That is why a malformed token answers 409 like a superseded one rather
 * than 500: a 500 reads as transient and invites exactly the retry that must
 * not happen.
 */
export async function renewLease(env = {}, { task_id, lease_token, lease_seconds = 900 } = {},
  { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = renewConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ task_id, lease_token, lease_seconds }),
    });

    const answered = await interpretHttp(res, { credential: 'registration token' });
    if (answered) return answered;

    const b = await res.json().catch(() => ({}));
    /*
     * A 200 CARRYING ok:false IS STILL A REFUSAL. The function answers with its
     * own verdict; treating any 2xx as success would renew nothing and report
     * that it had, which is the worst possible outcome here — the worker keeps
     * working on a lease it has lost.
     */
    if (b?.ok === false) return { state: HOSTED.REFUSED, detail: b?.reason ?? 'refused', errors: [] };
    return { state: HOSTED.OK, lease_expires_at: b?.lease_expires_at ?? null };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
