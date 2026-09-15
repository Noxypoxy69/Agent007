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

/** Distinguishable outcomes. `unreachable` must never be treated as `absent`. */
export const HOSTED = {
  NOT_CONFIGURED: 'not-configured',
  OK: 'ok',
  UNREACHABLE: 'unreachable',
  MALFORMED: 'malformed',
};

export function hostedConfig(env = {}) {
  const url = String(env.AGENTBRIDGE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.AGENTBRIDGE_SUPABASE_KEY ?? '';
  return url && key ? { url, key } : null;
}

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
 * Fetch hosted registrations.
 *
 * @returns {{state: string, rows?: Array, detail?: string}}
 */
export async function fetchHostedRegistrations(env = {}, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = hostedConfig(env);
  if (!cfg) return { state: HOSTED.NOT_CONFIGURED };

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: HOSTED.UNREACHABLE, detail: 'no fetch available' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(`${cfg.url}/rest/v1/session_registrations?select=*`, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        apikey: cfg.key,
        authorization: `Bearer ${cfg.key}`,
        accept: 'application/json',
      },
    });
    if (!res.ok) return { state: HOSTED.UNREACHABLE, detail: `http ${res.status}` };

    const body = await res.json();
    // Not an array is MALFORMED, not empty. An empty array is a real and calm
    // answer ("nobody is registered"); a malformed body is a broken dependency,
    // and rendering the two identically is how an outage becomes "no workers".
    if (!Array.isArray(body)) return { state: HOSTED.MALFORMED, detail: 'response was not an array' };

    return { state: HOSTED.OK, rows: body.map(toRegistration) };
  } catch (e) {
    if (e?.name === 'AbortError') return { state: HOSTED.UNREACHABLE, detail: 'timeout' };
    return { state: HOSTED.UNREACHABLE, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
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
