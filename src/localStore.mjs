import { collect } from './collect.mjs';
import { loadConfig, loadRegistry, machineInfo } from './config.mjs';

/**
 * The MCP tool surface, backed by THIS MACHINE instead of a hosted database.
 *
 * WHY IT EXISTS. The tools were written against bridge/store.mjs, which is
 * Postgres. That made the whole read surface untestable until a database, a
 * public host and a token all existed at once -- three decisions deep before
 * anyone could see whether the seven tools returned anything useful.
 *
 * This store answers the same two questions from the local collector, so the
 * tools can be proven over stdio on one machine with no database, no network
 * and nothing exposed.
 *
 * IT IS ALSO WHAT THE WORKER NEEDS. `pg` does not run on Cloudflare Workers --
 * it is a node driver over raw TCP. So the hosted read service cannot import
 * bridge/store.mjs either, and needed a store boundary regardless. Injecting
 * the store rather than importing it keeps `pg` out of the module graph
 * entirely unless the Postgres entry point is the one being used, which is the
 * difference between a Worker that builds and one that fails at import.
 *
 *   mcp/stdio.mjs      -> this store        local proof, no DB
 *   bridge/server.mjs  -> bridge/store.mjs  node hosting, Postgres
 *   worker             -> an HTTP store     Workers, Supabase REST
 *
 * LOCAL OUTPUT KEEPS REAL PATHS. Home-directory redaction exists so an
 * operator's name does not reach a hosted database; nothing here leaves the
 * machine, and a path the operator cannot paste into their own terminal is a
 * worse tool. The transmitted path stays redacted -- see collect.mjs.
 */
export function createLocalStore({ redactHomePaths = false } = {}) {
  /** One collection per call. No caching: a stale answer about who holds a lock
   *  is worse than a slow one, and these are human-speed queries. */
  async function snapshot() {
    const cfg = await loadConfig();
    if (!cfg) throw new Error('not initialised — run: agentbridge init');
    return collect({ ...cfg, redactHomePaths }, await loadRegistry());
  }

  return {
    async listSessions() {
      const payload = await snapshot();
      const machine = machineInfo(payload.machine ? { machineId: payload.machine.id } : {});
      return payload.sessions.map((s) => ({
        ...s,
        // The hosted store stamps these from its own rows; locally they are
        // "now", because the observation IS this instant rather than the last
        // heartbeat somebody sent.
        lastSeenAt: payload.sentAt,
        machineLabel: payload.machine?.name ?? machine.name,
      }));
    },

    /**
     * Task contracts, so the read surface can answer "what does this agent
     * owe" and not only "what is it doing".
     *
     * Read straight from the delegation store rather than through a snapshot:
     * contracts are not observed state, they are a ledger, and collecting git
     * across every worktree to answer a question about a JSON file would be
     * seconds of work for nothing.
     *
     * Imported lazily so this module still loads where the store is absent or
     * unreadable — the six state tools must keep working when the ledger is
     * broken, since that is exactly when somebody is debugging it.
     */
    async listDelegations() {
      const { readDelegations } = await import('./provenanceStore.mjs');
      return readDelegations();
    },

    /**
     * The Owner Decision Ledger — what the builder has already decided.
     *
     * Read-only here, and there is no write counterpart anywhere on the tool
     * surface. An agent that could record a decision could grant itself
     * permission, which would make the ledger certify the exact thing it exists
     * to constrain. Recording goes through `agentbridge owner-decide`, where
     * validateDecision refuses any record whose created_by is not the owner.
     *
     * Lazy import for the same reason as listDelegations: the state tools must
     * keep answering when the ledger file is unreadable, because that is
     * precisely when somebody is looking into it.
     */
    async listDecisions() {
      const { readDecisions } = await import('./provenanceStore.mjs');
      return readDecisions();
    },

    async getLanes() {
      const payload = await snapshot();
      if (payload.lanes && typeof payload.lanes === 'object') return payload.lanes;
      // null means no lanes file was configured. Return an empty map rather
      // than null so a caller iterating it does not have to special-case the
      // difference between "no lanes" and "lanes unknown" -- lanesError on the
      // payload carries that distinction when it matters.
      return {};
    },
  };
}
