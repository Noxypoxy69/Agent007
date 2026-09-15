/**
 * The read store, over Supabase's REST surface instead of a Postgres socket.
 *
 * WHY THIS EXISTS RATHER THAN REUSING bridge/store.mjs. `pg` is a node driver
 * speaking the Postgres wire protocol over a raw TCP socket. Cloudflare Workers
 * have no TCP sockets and no node net module, so store.mjs cannot be imported
 * there at all -- not "runs slowly", does not load. PostgREST speaks HTTP, and
 * `fetch` is the one thing a Worker definitely has.
 *
 * READ-ONLY BY CONSTRUCTION, not by intention. Every method here issues GET.
 * There is no insert, update or delete path in this file, so a Worker built
 * from it cannot write to the database even if something upstream asked it to.
 * The ingest endpoint stays on the node bridge, which is where the HMAC
 * verification and nonce store already live.
 *
 * CONTRACTS ARE ABSENT ON PURPOSE. There is no listDelegations here: the
 * delegation ledger is machine-local by decision, so the hosted surface serves
 * state and not contracts. toolDefs registers the contract tools only when a
 * store provides the method, so their absence here is what makes the hosted
 * tool list honestly shorter rather than broken.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {object} env   { SUPABASE_URL, SUPABASE_SERVICE_KEY }  — a Worker's env
 * @param {object} opts  { fetchImpl, timeoutMs } for tests
 */
export function createHttpStore(env, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(env?.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env?.SUPABASE_SERVICE_KEY ?? '';
  if (!base || !key) {
    throw new TypeError('createHttpStore: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new TypeError('createHttpStore: no fetch available');

  /**
   * One PostgREST GET.
   *
   * A non-2xx is thrown rather than returned as an empty array. An empty array
   * means "no agents are registered", which is a real and calm answer; a failed
   * query that returned [] would render as exactly that, and a model reading
   * "no agents" cannot tell it apart from a database outage. The body is not
   * echoed into the error -- it can contain row data.
   */
  async function get(pathAndQuery) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/rest/v1/${pathAndQuery}`, {
        method: 'GET',
        signal: ac.signal,
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`supabase-read-failed:${res.status}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('supabase-read-failed:not-an-array');
      return rows;
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('supabase-read-failed:timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Latest session rows, shaped exactly as bridge/store.mjs returns them.
     *
     * The tools read `s.git?.branch`, `s.locks`, `s.processes` and so on; if
     * this returned PostgREST's raw column names the same tool would answer
     * differently depending on which transport served it, which is the whole
     * failure the shared toolDefs exists to prevent.
     */
    async listSessions() {
      const rows = await get('sessions_latest?select=*');
      return rows.map((r) => ({
        agentId: r.agent_id,
        lane: r.lane,
        machineLabel: r.machine_label ?? null,
        worktree: r.worktree ?? null,
        git: r.git ?? null,
        locks: r.locks ?? [],
        processes: r.processes ?? [],
        processProbeOk: r.process_probe_ok !== false,
        lastSeenAt: r.last_seen_at ?? null,
      }));
    },

    /**
     * The Owner Decision Ledger, whole — dead records included.
     *
     * Revoked and superseded rows are NOT filtered here. Resolution lives in
     * src/ownerDecisions.mjs, shared by every transport; filtering in the store
     * would put the precedence rules in two places, and the hosted copy would
     * be the one nobody could attach a debugger to when they drifted.
     *
     * READ ONLY, and there is no write counterpart in this file or on the tool
     * surface. An agent that could record a decision could grant itself
     * permission. Recording happens on the machine, through `agentbridge
     * owner-decide`, behind an authorship check.
     */
    async listDecisions() {
      const rows = await get('owner_decisions?select=*');
      return rows.map((r) => ({
        decision_id: r.decision_id,
        owner_id: r.owner_id,
        decision_type: r.decision_type ?? 'policy',
        statement: r.statement,
        scope_type: r.scope_type,
        scope_id: r.scope_id ?? null,
        effect: r.effect,
        capabilities: r.capabilities ?? [],
        constraints: r.constraints ?? {},
        created_at: r.created_at,
        created_by: r.created_by,
        supersedes: r.supersedes ?? null,
        revoked_at: r.revoked_at ?? null,
        revoked_by: r.revoked_by ?? null,
        history: r.history ?? [],
      }));
    },

    async getLanes() {
      const rows = await get('lanes_latest?select=lanes&limit=1');
      const lanes = rows[0]?.lanes;
      // {} rather than null: a caller iterating lanes should not have to
      // special-case "no lanes file" against "lanes unknown".
      return lanes && typeof lanes === 'object' ? lanes : {};
    },

    /**
     * Reader tokens are compared by DIGEST, never by value.
     *
     * The plaintext token is never sent to the database and never stored there,
     * so a dump of this table does not yield working credentials. Digesting
     * uses WebCrypto, which a Worker has and which node has too.
     */
    async checkReaderToken(token) {
      if (typeof token !== 'string' || token.length < 16) return null;
      const bytes = new TextEncoder().encode(token);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const rows = await get(
        `reader_tokens?select=label,disabled&token_sha256=eq.${hex}&disabled=is.false&limit=1`,
      );
      return rows[0]?.label ?? null;
    },
  };
}
