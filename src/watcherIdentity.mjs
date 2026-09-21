/**
 * WHO IS THIS SESSION, WHEN NOBODY SET AGENTBRIDGE_AGENT_ID?
 *
 * ═══ THE DEFECT, MEASURED ON THIS MACHINE 2026-09-21 ═══
 *
 *     node scripts/bridge-session-poll.mjs --status
 *     no poll records in %USERPROFILE%\.agentbridge\polls
 *     NOTHING IS WATCHING. No session is registered to be polled, though 2 log
 *     file(s) from earlier sessions remain.                          exit 1
 *
 * At that moment an agent was working in this worktree, and `0641a6b` had been
 * committed three hours earlier. The bridge reported that agent's last
 * heartbeat as 2026-09-18 -- two days stale -- while it was demonstrably
 * committing. That is the shape CLAUDE.md's liveness section is about, and this
 * is the entry point where it starts: `sessionStart()` reads
 * AGENTBRIDGE_AGENT_ID, finds it empty, says NOT POLLING, and returns.
 *
 * A session started outside `agent.cmd` -- a teleport, a fresh terminal, an IDE
 * -- therefore has no watcher at all, forever, and the operator finds out when
 * somebody asks why the roster says everyone is dead.
 *
 * ═══ WHY THE OLD REFUSAL WAS RIGHT AND STAYS RIGHT ═══
 *
 * The comment it is replacing said: "An agent id is never invented here,
 * because a fabricated identity on the roster is what work gets routed by."
 * That is correct and this module does not weaken it. Inventing `code-b`
 * because the branch looks like code-b's would put a name on the roster that
 * assign_task resolves against, and the first wrong guess sends somebody's work
 * to a session that never agreed to do it.
 *
 * So this RESOLVES rather than invents, and the distinction is the whole
 * module: every source below is a place the identity was ALREADY DECLARED by
 * the party it names. Nothing is derived from a branch name, a directory, a
 * lane, or a heuristic about who usually works here.
 *
 * ═══ THE ORDER, AND WHY EACH RUNG IS EVIDENCE ═══
 *
 *   1 DECLARED     AGENTBRIDGE_AGENT_ID. The operator said so. Unchanged.
 *
 *   2 THIS-SESSION a prior registration carrying THIS EXACT session_id. Not a
 *                  guess about who is here -- it is this session's own earlier
 *                  statement about itself, read back. A teleported or resumed
 *                  session is the same session; that is what the id means.
 *
 *   3 SOLE-OCCUPANT  every prior registration for this repo + worktree +
 *                  machine names ONE agent. Weaker than 2 and deliberately
 *                  last: it is an inference about the WORKTREE, not a statement
 *                  by the session. It is admitted only when there is nothing to
 *                  be ambiguous about, and on this machine it correctly
 *                  REFUSES, because Agent007 has hosted code-a, code-b and
 *                  fixer.
 *
 *   otherwise      REFUSE, and NAME THE CANDIDATES. The old refusal told the
 *                  operator a variable was unset; this one can say "three
 *                  agents have worked here, pick one", which is the difference
 *                  between a message you can act on and one you read twice.
 *
 * ═══ WHAT IT REFUSES, AND WHY EACH IS A REAL ATTACK ═══
 *
 * A row from ANOTHER MACHINE never resolves. Registrations are shared state;
 * without the machine check, a session on a laptop could adopt the identity of
 * an agent that has only ever run on the desktop.
 *
 * A row from another WORKTREE never resolves, for the same reason one rung
 * down: the same machine runs several checkouts and they are different lanes.
 *
 * An id that fails SAFE never resolves, even from the environment. The id goes
 * into a filename and an argv, and this module is upstream of both.
 *
 * PURE. No fs, no network, no clock. The caller reads the store and passes
 * rows in, which is what lets every branch above be tested against a fixture
 * instead of against a machine that has to be in the right state.
 */

/**
 * Same shape the poll supervisor already enforces. Kept identical rather than
 * loosened: this decides a filename and an argv downstream.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const SOURCE = Object.freeze({
  DECLARED: 'declared',
  THIS_SESSION: 'this-session',
  SOLE_OCCUPANT: 'sole-occupant',
});

const str = (v) => (typeof v === 'string' && v.trim().length ? v.trim() : null);

/**
 * Do two session ids name the same session?
 *
 * The supervisor stores `claude-<raw>` while `register-session` may have been
 * called with the bare id, so the SAME session appears under two spellings --
 * measured in the live store, where this session's row reads
 * `session_01Y8...` with no prefix while the hook would look for
 * `claude-session_01Y8...`. Comparing raw strings would miss the one row that
 * is strongest evidence.
 *
 * ONE PREFIX, NOT A FUZZY MATCH. Stripping a known prefix is reversible and
 * exact; substring or startsWith matching would let `claude-a` resolve against
 * `claude-abc`, which is a different session.
 */
export function sameSession(a, b) {
  const norm = (v) => {
    const s = str(v);
    if (!s) return null;
    return s.startsWith('claude-') ? s.slice('claude-'.length) : s;
  };
  const x = norm(a);
  const y = norm(b);
  return x !== null && x === y;
}

/**
 * Resolve the agent id for a session, or refuse and say what it would take.
 *
 * @param {object}  o
 * @param {object}  o.env            process.env, or a fixture
 * @param {string}  o.sessionId      this session's id, from the hook payload
 * @param {Array}   o.registrations  rows from the local registration store
 * @param {string}  o.repoId         this worktree's repo id
 * @param {string}  o.worktreeId     this worktree's id
 * @param {string}  o.machineId      this machine's id
 * @returns {{agentId: string|null, source: string|null, why: string,
 *            candidates: string[]}}
 */
export function resolveAgentId({
  env = {}, sessionId = null, registrations = [], repoId = null,
  worktreeId = null, machineId = null,
} = {}) {
  /*
   * A NON-ARRAY IS "I WAS HANDED NOTHING USABLE", NOT "THE STORE IS EMPTY",
   * AND THE TWO MUST NOT READ ALIKE.
   *
   * CAUGHT THE HARD WAY, 2026-09-21, minutes after this module went 11/11 green
   * with 9 of 9 mutations killed. `readRegistrations()` in registrationStore is
   * ASYNC, and the first wire called it without await. So `registrations` was a
   * Promise, this line quietly turned it into [], and every session resolved to
   * "no prior registration" -- a refusal identical to the bug being fixed, on a
   * store that was sitting right there with the answer in it.
   *
   * Every unit test passed a plain array, so nothing caught it; a dry run
   * against the real store did, on the first try. Silently coercing the bad
   * input is what made it invisible, so it no longer does.
   */
  const rows = Array.isArray(registrations) ? registrations : null;
  if (rows === null) {
    return {
      agentId: null,
      source: null,
      candidates: [],
      why: `the registration list is a ${registrations === null ? 'null' : typeof registrations}, not an array `
        + '-- the caller did not hand over readable registrations (an un-awaited read returns a Promise). '
        + 'This is NOT the same as an empty store and must not be read as one.',
    };
  }

  /* 1. DECLARED. */
  const declared = str(env.AGENTBRIDGE_AGENT_ID);
  if (declared) {
    if (!SAFE_ID.test(declared)) {
      return {
        agentId: null,
        source: null,
        candidates: [],
        why: `AGENTBRIDGE_AGENT_ID is set to ${JSON.stringify(declared)}, which is not a usable `
          + 'agent id. It is refused rather than sanitised: this id becomes a filename and an argv.',
      };
    }
    return { agentId: declared, source: SOURCE.DECLARED, candidates: [], why: 'AGENTBRIDGE_AGENT_ID' };
  }

  /*
   * ROWS THIS MACHINE AND THIS WORKTREE MAY SPEAK FOR.
   *
   * Applied BEFORE the session lookup, not after. A row carrying our session id
   * but another machine's id is the cross-machine case, and it is more
   * suspicious than an ordinary mismatch rather than less.
   */
  /**
   * A ROW THAT DOES NOT STATE WHERE IT IS FROM IS NOT A ROW WE MAY SPEAK FOR.
   *
   * THE BUG THIS REPLACES, which was a presence-guard on the field being
   * compared -- `str(r.machine_id) !== null && str(r.machine_id) !== machineId`.
   * A row whose `machine_id` was absent, null, empty or a non-string skipped the
   * machine check entirely and was admitted FROM ANY MACHINE. Same for worktree
   * and repo. The module's own safety argument -- "a row from ANOTHER MACHINE
   * never resolves" -- was false for exactly the rows that decline to say.
   *
   * AND A SHIPPED WRITER PRODUCES THAT ROW. `bin/agentbridge.mjs` ends
   * register-session with `row.machine_id = cfgForMachine?.machineId ?? null`,
   * and loadConfig() returns null whenever ~/.agentbridge/config.json is absent
   * OR unreadable. So a machine that never ran `agentbridge init`, or one read
   * landing mid-rewrite, writes a permanently machine-unfiltered row. The
   * fixtures never built that shape, which is why twelve green tests missed it:
   * the hostile list was drawn from inputs that already failed (rule 7/8/9).
   *
   * NULL ON OUR SIDE STILL MEANS "DO NOT FILTER", and that half was right. If
   * this machine cannot read its own id we genuinely cannot compare, and
   * refusing every row would take out sessions that have done nothing wrong.
   * The asymmetry is deliberate: not knowing OUR value is a reason not to
   * filter; a row not stating ITS value is a reason not to trust the row.
   *
   * `src/liveRegistry.mjs` already drops a row missing its session_id for the
   * same reason, in the same words: not a worker with an unknown session, a row
   * this registry cannot vouch for.
   */
  const vouches = (ourValue, rowValue) => ourValue === null || str(rowValue) === ourValue;

  const ours = rows.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    const agent = str(r.agent_id);
    if (!agent || !SAFE_ID.test(agent)) return false;
    if (!vouches(machineId, r.machine_id)) return false;
    if (!vouches(worktreeId, r.worktree_id)) return false;
    if (!vouches(repoId, r.repo_id)) return false;
    return true;
  });

  /* 2. THIS SESSION SAID SO EARLIER. */
  const mine = ours.filter((r) => sameSession(r.session_id, sessionId));
  const mineIds = [...new Set(mine.map((r) => str(r.agent_id)))];
  if (mineIds.length === 1) {
    return {
      agentId: mineIds[0],
      source: SOURCE.THIS_SESSION,
      candidates: [],
      why: `this session registered as ${mineIds[0]} before; that is its own earlier declaration, not a guess`,
    };
  }
  if (mineIds.length > 1) {
    /*
     * ONE SESSION ID, TWO AGENT NAMES. Not resolvable and not ignorable: the
     * store disagrees with itself about who this session is, and picking
     * either would put a coin-flip on the roster.
     */
    return {
      agentId: null,
      source: null,
      candidates: mineIds.sort(),
      why: `the registration store names this session as ${mineIds.length} different agents `
        + `(${mineIds.sort().join(', ')}). Refusing rather than picking one.`,
    };
  }

  /* 3. ONE AGENT HAS EVER WORKED HERE. */
  const occupants = [...new Set(ours.map((r) => str(r.agent_id)))].sort();
  if (occupants.length === 1) {
    return {
      agentId: occupants[0],
      source: SOURCE.SOLE_OCCUPANT,
      candidates: [],
      why: `${occupants[0]} is the only agent ever registered in this worktree on this machine`,
    };
  }

  return {
    agentId: null,
    source: null,
    candidates: occupants,
    why: occupants.length
      ? `${occupants.length} agents have registered in this worktree (${occupants.join(', ')}), `
        + 'so which one this session is cannot be established. Set AGENTBRIDGE_AGENT_ID.'
      : 'no prior registration in this worktree on this machine, and AGENTBRIDGE_AGENT_ID is not set.',
  };
}
