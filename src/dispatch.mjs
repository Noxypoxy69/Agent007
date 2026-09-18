import { canAssign, canAccept } from './coordination.mjs';

/**
 * THE SUPERVISED DISPATCHER: it PREPARES, it does not decide.
 *
 * The coordinator polls hourly at best, so every handoff waited on a human to
 * relay it. An always-running dispatcher fixes the latency and raises an
 * obvious question: may it assign work by itself?
 *
 * The owner's answer was no. It prepares an assignment; the coordinator
 * confirms on its pass. So this module produces PROPOSALS, and a proposal is a
 * suggestion with a timestamp -- never a stored permission.
 *
 * THAT DISTINCTION IS THE WHOLE DESIGN, and it is easy to lose.
 *
 * The tempting shortcut is to record the verdict at proposal time and let
 * confirmation trust it. Then the dispatcher's judgment, formed minutes or an
 * hour earlier against a world that has since moved, becomes the authority --
 * and "supervised" degrades into "autonomous, with a delay". The worker may
 * have gone offline, taken other work, or had its lane reassigned; the task may
 * have been cancelled or already returned.
 *
 * So canConfirm RE-RUNS the guard against live state and ignores the recorded
 * verdict entirely. The stored reasoning exists to be READ by whoever confirms,
 * not to be relied on by the code.
 *
 * ROUTING IS BY LANE, NOT BY A CHAIN. A fixed C -> B -> D -> A rotation was
 * proposed; it describes today's roster rather than a rule, and canAssign
 * already refuses on lane and repo mismatch, so most hops in such a chain would
 * produce refusals instead of handoffs. The registry records which lane a
 * session holds. That is the routing table.
 *
 * PURE. Rows and the clock arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/** How long a proposal is worth looking at before the world has moved. */
export const PROPOSAL_STALE_AFTER_MS = 60 * 60 * 1000;

export const PROPOSAL_KINDS = ['assign', 'review'];

/**
 * What the dispatcher would suggest, given the world as it is now.
 *
 * @returns {{proposals: object[], idle: object[], blocked: object[]}}
 */
export function proposeWork({ tasks = [], sessions = [], now, isLive }) {
  if (!nonEmpty(now)) throw new TypeError('proposeWork requires a `now` timestamp');
  if (typeof isLive !== 'function') {
    /*
     * Liveness is INJECTED, as it is everywhere else in this system. A
     * dispatcher that decided for itself whether a worker was alive would be
     * the second opinion on the question the registry exists to answer.
     */
    throw new TypeError('proposeWork requires an isLive predicate');
  }

  const live = arr(sessions).filter((s) => s && isLive(s) && s.capacity !== 'offline');
  const taken = new Set(
    arr(tasks).filter((t) => t?.state === 'assigned').map((t) => t.assigned_session),
  );

  const proposals = [];
  const idle = live
    .filter((s) => !taken.has(s.session_id))
    .map((s) => ({ agent_id: s.agent_id, session_id: s.session_id, lane_id: s.lane_id ?? null }));

  const blocked = [];

  for (const task of arr(tasks)) {
    if (!task || !nonEmpty(task.task_id)) continue;

    /*
     * RETURNED WORK IS A REVIEW, NOT A REASSIGNMENT.
     *
     * The dispatcher must never propose handing returned work to somebody
     * else: it has been done, and what it needs is a coordinator to look at
     * the commit. Proposing a reassignment here would quietly discard a
     * worker's finished contract.
     */
    if (task.state === 'returned') {
      const verdict = canAccept(task, { at: now });
      proposals.push({
        kind: 'review',
        task_id: task.task_id,
        // Who did it, and what to look at. The dispatcher forms no opinion on
        // whether the work is GOOD -- it cannot read a diff.
        returned_by: task.returned_by ?? null,
        head_sha: task.returned_head_sha ?? null,
        notes: task.returned_notes ?? null,
        would_be_accepted: verdict.ok,
        reasons: verdict.ok ? [] : verdict.errors,
        prepared_at: now,
      });
      continue;
    }

    if (task.state === 'blocked') {
      blocked.push({ task_id: task.task_id, reason: task.blocked_reason ?? null });
      continue;
    }

    if (task.state !== 'runnable') continue;

    // ── routing, by lane ────────────────────────────────────────────────────
    const lane = task.lane_id ?? null;
    const candidates = live.filter((s) => {
      if (taken.has(s.session_id)) return false;
      if (nonEmpty(lane) && nonEmpty(s.lane_id) && s.lane_id !== lane) return false;
      if (nonEmpty(task.repo_id) && nonEmpty(s.repo_id) && s.repo_id !== task.repo_id) return false;
      return true;
    });

    if (candidates.length === 0) {
      blocked.push({
        task_id: task.task_id,
        reason: nonEmpty(lane)
          ? `no idle live worker holds lane "${lane}"`
          : 'no idle live worker is available',
      });
      continue;
    }

    /*
     * AMBIGUITY IS REPORTED, NOT BROKEN BY A TIE-RULE.
     *
     * Picking "the first" would be a decision about who does the work, made by
     * the component explicitly told not to make those. Two eligible workers is
     * something a supervisor should see.
     */
    if (candidates.length > 1) {
      blocked.push({
        task_id: task.task_id,
        reason: `${candidates.length} idle workers are eligible; choose one`,
        candidates: candidates.map((s) => s.agent_id),
      });
      continue;
    }

    const worker = candidates[0];
    const verdict = canAssign(task, worker, {
      tasks,
      assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
      isLive,
    });

    proposals.push({
      kind: 'assign',
      task_id: task.task_id,
      agent_id: worker.agent_id,
      session_id: worker.session_id,
      lane_id: lane,
      // RECORDED TO BE READ, NOT TRUSTED. canConfirm re-runs this against live
      // state; a stale ok here confirms nothing.
      would_be_accepted: verdict.ok,
      reasons: verdict.ok ? [] : verdict.errors,
      prepared_at: now,
    });
  }

  return { proposals, idle, blocked };
}

/**
 * MAY THIS PROPOSAL BE CONFIRMED, RIGHT NOW?
 *
 * Re-runs the guard against live rows. The proposal's own `would_be_accepted`
 * is deliberately ignored: it was formed against a world that has since moved,
 * and trusting it would turn a supervised dispatcher into an autonomous one
 * with an hour of lag.
 */
export function canConfirm(proposal, { task, worker, tasks = [], now, isLive, staleAfterMs = PROPOSAL_STALE_AFTER_MS } = {}) {
  const errors = [];

  if (!proposal || !PROPOSAL_KINDS.includes(proposal.kind)) {
    return { ok: false, errors: ['no such proposal'] };
  }
  if (!nonEmpty(now)) return { ok: false, errors: ['a timestamp is required'] };

  /*
   * A PROPOSAL GOES STALE.
   *
   * An hour-old suggestion confirmed without a fresh look is the dispatcher
   * deciding late rather than the supervisor deciding now. Past the window it
   * must be re-prepared, which costs nothing and forces the guard to run
   * against the present.
   *
   * AGE IS MEASURED FROM THE LAST REAFFIRMATION, NOT THE FIRST PREPARATION, and
   * the two are different dates for a reason. reconcileProposals keeps a row
   * alive while the dispatcher keeps deriving it unchanged, so `prepared_at`
   * becomes "how long has this been waiting", which is the number that makes a
   * stuck queue visible -- 676 review proposals were written about one task
   * precisely because nothing ever surfaced that it had been waiting four hours.
   * Bumping prepared_at on every heartbeat would make every entry look sixty
   * seconds old forever: the churn would stop and the symptom it was shouting
   * would go quiet with it, which is a worse outcome than the churn.
   *
   * So freshness reads reaffirmed_at and falls back to prepared_at for any row
   * written before that column existed.
   */
  const prepared = Date.parse(proposal.reaffirmed_at ?? proposal.prepared_at);
  const t = Date.parse(now);
  if (Number.isNaN(prepared) || Number.isNaN(t)) {
    errors.push('the proposal cannot be dated, so its age cannot be checked');
  } else if (t - prepared > staleAfterMs) {
    errors.push(`prepared ${Math.round((t - prepared) / 60000)} minutes ago and is stale; re-prepare it`);
  } else if (t < prepared) {
    errors.push('the proposal is dated in the future');
  }

  if (!task) {
    errors.push(`no such task: ${proposal.task_id}`);
    return { ok: false, errors };
  }

  if (proposal.kind === 'review') {
    const verdict = canAccept(task, { at: now });
    if (!verdict.ok) errors.push(...verdict.errors);
    return { ok: errors.length === 0, errors };
  }

  // kind === 'assign'
  if (!worker) {
    errors.push(`${proposal.agent_id} has no live session now; it may have gone offline since`);
    return { ok: false, errors };
  }
  if (worker.session_id !== proposal.session_id) {
    /*
     * The session is part of the proposal. A worker that restarted has a new
     * runtime, and confirming onto it would be assigning to something nobody
     * proposed -- the same session/agent confusion the registry exists to
     * prevent.
     */
    errors.push(`proposed for session "${proposal.session_id}" but ${proposal.agent_id} is now "${worker.session_id}"`);
  }

  const verdict = canAssign(task, worker, {
    tasks,
    assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
    isLive,
  });
  if (!verdict.ok) errors.push(...verdict.errors);

  return { ok: errors.length === 0, errors };
}

/*
 * ═══ THE CHURN ═══════════════════════════════════════════════════════════
 *
 * THE DISPATCHER WROTE 676 REVIEW PROPOSALS ABOUT ONE TASK. Measured on the
 * live database at 05:41Z on 2026-09-17: 185 of a 200-row page were review
 * proposals on t-wire-gate-scripts, one a minute without a break from 23:38Z
 * to 03:20Z, every one identical to the last.
 *
 * IT IS NOT RUNNING RIGHT NOW, AND THAT IS NOT A FIX. Zero were prepared after
 * 03:20:37Z, which is the second code-b accepted that task. The dispatcher did
 * not stop; it ran out of returned work to re-propose. Nothing here changed,
 * so the next worker that returns anything restarts it at sixty rows an hour,
 * and it cannot stop on its own because no consumer claims a review proposal.
 * The missing consumer is a different slice. This is the writer.
 *
 * WHAT THE WRITER DOES, and its comment is RIGHT about the part it defends:
 * every tick supersedes the entire open set and inserts fresh rows. Replacing
 * the set is correct -- an old proposal open beside a newer one lets somebody
 * confirm a suggestion the dispatcher has already withdrawn, which is stale
 * authority wearing a different hat. But that argument covers replacing a row
 * whose CONTENT changed. Replacing a row with a byte-identical row defends
 * nothing; it records that the dispatcher had nothing new to say, once a
 * minute, forever.
 *
 * SO THE DISTINCTION IS SEMANTIC, NOT TEMPORAL. A proposal that says exactly
 * what the open one says is the same proposal, still current, and what it
 * wants is a heartbeat. A proposal that differs in any field a reader would
 * act on -- the verdict, the commit to read, who returned it -- is news, and
 * news gets a row.
 *
 * WHY IT IS HERE RATHER THAN IN THE EDGE FUNCTION. This is a decision, and
 * supabase/functions/mcp/index.ts cannot be imported by the suite, so anything
 * decided there is untested by construction. CLAUDE.md rule 10. The caller
 * keeps the effects: it reads the open rows, calls this, and performs the three
 * lists.
 */

/**
 * The fields that make two proposals the SAME proposal.
 *
 * Everything a reader would act on, and nothing else. `prepared_at` is
 * deliberately absent -- it is the clock, not the content, and including it
 * would make every proposal differ from every other one, which is the bug.
 */
const PROPOSAL_IDENTITY = [
  'kind', 'task_id', 'agent_id', 'session_id', 'lane_id',
  'returned_by', 'head_sha', 'notes', 'would_be_accepted', 'reasons',
];

/**
 * Do these two proposals say the same thing?
 *
 * NULL AND ABSENT ARE THE SAME THING HERE, and that is load-bearing rather than
 * lenient. A row read back from the database carries `agent_id: null` on a
 * review proposal; the freshly-derived one simply has no such key. Comparing
 * those raw makes every review proposal differ from its own stored copy, so
 * nothing would ever match and the churn would survive the fix looking exactly
 * like it had been fixed.
 */
export function proposalsMatch(a, b) {
  if (!a || !b) return false;
  for (const key of PROPOSAL_IDENTITY) {
    const l = a[key] ?? null;
    const r = b[key] ?? null;
    if (Array.isArray(l) || Array.isArray(r)) {
      const la = arr(l);
      const ra = arr(r);
      if (la.length !== ra.length) return false;
      if (la.some((v, i) => String(v) !== String(ra[i]))) return false;
      continue;
    }
    if (l !== r) return false;
  }
  return true;
}

/**
 * What the writer should do this tick: keep, close, or record.
 *
 * @param open  the proposals currently in state `open`, as stored (with ids)
 * @param fresh what proposeWork just derived
 * @returns {{reaffirm: string[], reaffirmed_at: string, supersede: string[], insert: object[]}}
 *
 * REAFFIRM CARRIES A TIMESTAMP, AND LEAVING IT OUT WOULD HAVE BEEN AN OUTAGE.
 * canConfirm refuses any proposal older than PROPOSAL_STALE_AFTER_MS. Keep a
 * row alive for an hour without touching its clock and it becomes unconfirmable
 * while still being the dispatcher's current opinion -- a queue entry nobody may
 * act on and nothing replaces, because the writer is now content to leave it
 * there. That trades sixty harmless rows an hour for a queue that is quietly
 * dead, which is the worse of the two. So an unchanged proposal is not merely
 * spared; its clock is reset, and a test asserts the reset rather than trusting
 * the caller to remember.
 */
/*
 * WHETHER THE OPEN READ WAS TRUNCATED IS A DECISION, SO IT LIVES HERE.
 *
 * reconcileProposals already refuses to reconcile a partial set. The refusal was
 * sound and it was fed by a guess: the caller computed truncation as
 * `rows.length >= limit`, in a file the suite cannot import, so nothing could
 * test the one line that decides whether the guard ever engages.
 *
 * THE GUESS IS WRONG WHENEVER THE SERVER CAPS BELOW THE LIMIT WE ASKED FOR.
 * PostgREST returns min(limit, db-max-rows). With db-max-rows below the
 * requested limit the response is capped there, `length >= limit` is never true,
 * and a partial set reconciles while believing itself complete -- the exact bug
 * reconcileProposals exists to prevent.
 *
 * Measured on this project 2026-09-18: db-max-rows is set in no role config and
 * appears in no pg_settings row, so it is the platform default, documented as
 * 1000, which happens to equal the limit the caller requests. The current code
 * is therefore correct BY COINCIDENCE and stops being correct the moment anyone
 * lowers Max rows in the dashboard -- silently, with no test and no error.
 *
 * AND THE OBVIOUS REPAIR IS WORSE THAN THE BUG. "Request limit+1 and treat
 * length > limit as truncated" fails at exactly the default: asking for 1001
 * against a cap of 1000 returns 1000, `1000 > 1000` is false, and a 1000-row
 * slice of a 5000-row set reads as complete. It introduces the bug it repairs.
 *
 * So the total is READ rather than inferred, from the Content-Range header
 * PostgREST returns for `Prefer: count=exact`, and an unknown total is UNSAFE
 * rather than assumed complete -- with no count there is no way to tell a whole
 * set from one the server capped. Fail closed: degrade to replacing the set,
 * which is noisy and visible and was the behaviour a week ago.
 */
export function decideOpenReadTruncation({ returned, total = null, limit } = {}) {
  if (!Number.isInteger(returned) || returned < 0) {
    throw new TypeError('decideOpenReadTruncation requires the number of rows returned');
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('decideOpenReadTruncation requires the limit that was requested');
  }
  if (total === null || total === undefined) {
    return {
      truncated: true,
      reason: 'the server returned no row count, so a complete read cannot be told apart from '
        + `one capped below the requested limit of ${limit}; treating ${returned} rows as possibly partial`,
    };
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError(`decideOpenReadTruncation got an unusable total: ${String(total)}`);
  }
  if (total > returned) {
    return {
      truncated: true,
      reason: `the open set holds ${total} rows and the read returned ${returned}`,
    };
  }
  return { truncated: false, reason: null };
}

export function reconcileProposals({ open = [], fresh = [], now, openTruncated = false } = {}) {
  if (!nonEmpty(now)) throw new TypeError('reconcileProposals requires a `now` timestamp');

  /*
   * A TRUNCATED READ CANNOT RECONCILE, AND MUST NOT PRETEND TO.
   *
   * FOUND BY AUDITING MY OWN DIFF AFTER THE SUITE WENT GREEN, which is the only
   * reason it is here: 1611 tests passed over this bug, because no test can see
   * a PostgREST `limit` in a file the suite cannot import.
   *
   * The caller reads the open set with a limit. The old writer did not care --
   * `patch(state=eq.open)` closed every open row whether or not anybody had
   * counted them. Reconciling does care: a row past the limit is invisible, so
   * it is never matched and never superseded, and the fresh proposal that would
   * have matched it gets INSERTED instead. Two open proposals for one task, one
   * of them unreachable. That is the stale-authority bug the original writer
   * existed to prevent, reintroduced by the fix for its other half.
   *
   * So a saturated read degrades to exactly what the code did before: replace
   * the whole open set. The churn comes back until somebody raises the limit,
   * which is noisy, visible, and correct -- and strictly better than the
   * alternative, which is silent and wrong. `replaceAll` says which happened so
   * the caller cannot confuse the two.
   */
  if (openTruncated) {
    return {
      replaceAll: true,
      reason: 'the open proposal set was read up to its limit, so it may be incomplete; '
        + 'reconciling a partial set would leave unseen rows open forever and insert duplicates '
        + 'beside them. Falling back to replacing the whole set.',
      reaffirm: [],
      reaffirmed_at: now,
      supersede: [],
      insert: arr(fresh).filter(Boolean),
    };
  }

  const openRows = arr(open).filter(Boolean);
  const claimed = new Set();
  const reaffirm = [];
  const insert = [];

  for (const candidate of arr(fresh).filter(Boolean)) {
    /*
     * One open row may satisfy one fresh proposal, never two. Without the
     * claimed set, two identical fresh proposals would both reaffirm the same
     * row and the second would silently vanish instead of being written.
     */
    const hit = openRows.find((o) => !claimed.has(o.proposal_id) && proposalsMatch(o, candidate));
    if (hit) {
      claimed.add(hit.proposal_id);
      reaffirm.push(hit.proposal_id);
      continue;
    }
    insert.push(candidate);
  }

  /*
   * ANYTHING THE DISPATCHER NO LONGER PROPOSES MUST CLOSE. This is the half the
   * original writer got right and the half a naive "only insert when changed"
   * fix would drop: when the task was accepted at 03:20:37Z the correct answer
   * was not "stop writing", it was "close the open row". A proposal left open
   * after the dispatcher stopped meaning it is the stale authority the table
   * exists to prevent.
   */
  const supersede = openRows
    .filter((o) => !claimed.has(o.proposal_id))
    .map((o) => o.proposal_id);

  return { replaceAll: false, reason: null, reaffirm, reaffirmed_at: now, supersede, insert };
}

/** How long a worker may be silent before its absence is a finding, not a gap. */
export const WORKER_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * WHICH WORKERS STOPPED, AS DISTINCT FROM WHICH WERE NEVER THERE.
 *
 * Nothing here could previously tell those apart. Both surfaced only as an
 * absence: the dispatcher reported "no idle live worker holds lane X", which
 * reads as "that lane was never staffed" rather than "the worker on it died".
 *
 * That is precisely what happened on 2026-09-15. Three of four watchers were
 * killed by the host for memory, at unrelated times, and the production line
 * reported itself as merely idle -- a roster that looked healthy because most
 * of it was gone. A worker that STOPS is a failure. A lane nobody staffed is a
 * plan. They need different words.
 *
 * A DECLARED SHUTDOWN IS NOT AN ALERT. capacity 'offline' is a worker saying so
 * on its way out, which is the behaviour we want rather than a fault. Neither
 * is a session that never heartbeated at all: that never started, and reporting
 * it as lost would invent a worker in order to mourn it.
 */
export function wentStale({ sessions = [], now, staleAfterMs = WORKER_STALE_AFTER_MS } = {}) {
  if (!nonEmpty(now)) throw new TypeError('wentStale requires a `now` timestamp');
  const t = Date.parse(now);
  if (Number.isNaN(t)) throw new TypeError(`now is not a timestamp: ${now}`);

  const out = [];
  for (const s of arr(sessions)) {
    if (!s || !nonEmpty(s.session_id)) continue;
    if (s.capacity === 'offline') continue;

    const seen = s.heartbeat_at ? Date.parse(s.heartbeat_at) : NaN;
    if (Number.isNaN(seen)) continue;

    const silent = t - seen;
    if (silent <= staleAfterMs) continue;

    out.push({
      agent_id: s.agent_id ?? null,
      session_id: s.session_id,
      lane_id: s.lane_id ?? null,
      last_heartbeat_at: s.heartbeat_at,
      silent_for_seconds: Math.round(silent / 1000),
      /*
       * THE COMMIT IT WAS LAST PUBLISHING. A head_sha frozen at an old commit
       * is how you tell a worker that died mid-task from one that finished and
       * went quiet -- and it is the field that gave the memory kills away.
       */
      last_head_sha: s.head_sha ?? null,
      capacity_when_last_seen: s.capacity ?? null,
    });
  }

  // Most recently lost first: that is the one still worth chasing.
  out.sort((a, b) => a.silent_for_seconds - b.silent_for_seconds);
  return out;
}

/**
 * The hourly supervisory report: what a person or a coordinator needs to see.
 *
 * Counts first so a quiet hour reads as quiet, then the things that need a
 * decision. A report that buries two blocked tasks in a list of forty healthy
 * ones is a report nobody finishes reading.
 */
export function supervisoryReport({
  proposals = [], idle = [], blocked = [], tasks = [], sessions = [], now,
  staleAfterMs = WORKER_STALE_AFTER_MS,
}) {
  if (!nonEmpty(now)) throw new TypeError('supervisoryReport requires a `now` timestamp');

  const byState = {};
  for (const t of arr(tasks)) {
    if (!t?.state) continue;
    byState[t.state] = (byState[t.state] ?? 0) + 1;
  }

  const lost = wentStale({ sessions, now, staleAfterMs });

  return {
    at: now,
    counts: {
      proposals: arr(proposals).length,
      awaiting_review: arr(proposals).filter((p) => p.kind === 'review').length,
      idle_workers: arr(idle).length,
      blocked: arr(blocked).length,
      workers_went_stale: lost.length,
      tasks: byState,
    },
    /*
     * LOST WORKERS COME FIRST, BECAUSE THEY EXPLAIN THE REST.
     *
     * A blocked task under a dead worker is one fact, not two, and reading them
     * in the other order invites the wrong fix -- re-routing work around a lane
     * whose only problem is that nobody is standing on it.
     */
    worker_went_stale: lost,
    // Everything below needs somebody to act. Nothing here is a status update.
    awaiting_review: arr(proposals).filter((p) => p.kind === 'review'),
    ready_to_assign: arr(proposals).filter((p) => p.kind === 'assign' && p.would_be_accepted),
    would_refuse: arr(proposals).filter((p) => p.kind === 'assign' && !p.would_be_accepted),
    blocked: arr(blocked),
    idle_workers: arr(idle),
  };
}
