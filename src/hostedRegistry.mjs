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
      return { state: HOSTED.UNREACHABLE, detail: 'registration token rejected (401)' };
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

    if (!res.ok) {
      let detail = `http ${res.status}`;
      try {
        const b = await res.json();
        if (b?.errors?.length) detail = b.errors.join('; ');
        else if (b?.detail) detail = String(b.detail).slice(0, 200);
      } catch { /* keep the status */ }
      return { state: HOSTED.UNREACHABLE, detail };
    }

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
      return { state: HOSTED.UNREACHABLE, detail: 'reader token rejected (401)' };
    }
    if (!res.ok) return { state: HOSTED.UNREACHABLE, detail: `http ${res.status}` };

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
      // fix instead of rotating a token they can.
      return { state: HOSTED.UNREACHABLE, detail: 'registration token rejected (401)' };
    }
    if (!res.ok) {
      let detail = `http ${res.status}`;
      try {
        const body = await res.json();
        if (body?.errors?.length) detail = body.errors.join('; ');
        else if (body?.detail) detail = String(body.detail).slice(0, 200);
      } catch { /* keep the status */ }
      return { state: HOSTED.UNREACHABLE, detail };
    }
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
 * Merge local and hosted registrations into one roster.
 *
 * A session present in both is ONE worker, and the hosted row wins on liveness
 * because its heartbeat is server-stamped and therefore the one a second
 * machine can trust. The local row wins on nothing; it is the same worker seen
 * from closer up.
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
    bySession.set(r.session_id, existing ? { ...existing, ...r, origin: 'hosted' } : r);
  }
  return [...bySession.values()].sort((a, b) =>
    String(a.session_id).localeCompare(String(b.session_id)));
}
