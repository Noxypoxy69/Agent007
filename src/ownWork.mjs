/**
 * WHAT A WORKER MAY READ ABOUT ITS OWN WORK, AND NOTHING ELSE.
 *
 * ═══ THE GAP THIS EXISTS TO CLOSE ═══
 *
 * `eventsFor` emits an assignment carrying the task id and a comment saying
 * "enough to know WHICH task, never enough to act without reading it". That is
 * the right design — the outbox is at-least-once by construction, so an event
 * body is never trustworthy and the worker must re-read the authority.
 *
 * EXCEPT THERE WAS NOWHERE TO READ IT FROM.
 *
 *   /wait      returns { ok, events, cursor, waited_ms }. Events only.
 *   /register  registration state, not tasks.
 *   /return    write-only.
 *   MCP        takes coordinator or reader tokens; 401s a registration token.
 *
 * So a worker was told which task it held, told it must read it before acting,
 * and had no way to do either. Found the same way the lease-token delivery gap
 * was found: by building the consumer and discovering the producer was missing.
 *
 * ═══ WHY A SEPARATE READ RATHER THAN FATTENING THE EVENT ═══
 *
 * Putting the row in the event would collapse the doorbell into a dispatch. The
 * point of re-reading is that the worker reads WHEN IT DECIDES TO ACT, not when
 * it is told — a duplicate event delivered twenty minutes late carries a
 * snapshot, and a snapshot is exactly what must not be acted on.
 *
 * ═══ AN EXPLICIT FIELD LIST, FOR THE REASON THIS PROJECT ALREADY LEARNED ═══
 *
 * `select *` on a view cost a PGRST204 outage when the table grew and the view
 * did not. The same argument applies to a response shape: a row spread into a
 * response hands out every column somebody adds later, forever, without anybody
 * deciding to. So the fields are named, and adding one is a decision.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * The fields a worker needs to do the work and return it.
 *
 * `lease_token` IS here and that is deliberate: it is the worker's own
 * credential for its own task, it is already delivered on the assigned event,
 * and a worker that lost the event must be able to recover it rather than
 * holding work it cannot hand back. Withholding it here would only mean a
 * restarted worker abandons work it still legitimately owns.
 */
export const WORKER_TASK_FIELDS = Object.freeze([
  'task_id', 'state', 'title', 'notes',
  'lane_id', 'repo_id', 'allowed_paths', 'base_sha', 'depends_on',
  'attempt', 'assigned_at', 'assigned_session',
  'lease_token', 'lease_expires_at', 'leased_at',
]);

/**
 * THE GUARD. A worker sees its own assigned work and nothing else.
 *
 * NOT "tasks in its lane", NOT "tasks for its agent id". The session is the
 * unit, because the session is what the lease is minted for — an agent that
 * died and came back under a new session must not read the old session's work,
 * which is the same argument that makes a fencing token a fencing token.
 *
 * RETURNS A NEW OBJECT, never the row. A row passed through by reference is one
 * refactor away from carrying a column nobody reviewed.
 */
export function ownTask(tasks, { task_id, session_id } = {}) {
  if (!nonEmpty(task_id) || !nonEmpty(session_id)) return null;

  const row = arr(tasks).find((t) => t?.task_id === task_id);
  if (!row) return null;

  /*
   * NOT FOUND AND NOT YOURS ARE THE SAME ANSWER, deliberately. Distinguishing
   * them would let a worker enumerate which task ids exist by watching whether
   * it gets a 404 or a 403 — a small leak, but a free one to close, and the
   * caller has nothing to do differently in either case.
   */
  if (row.assigned_session !== session_id) return null;

  const out = {};
  for (const f of WORKER_TASK_FIELDS) out[f] = row[f] ?? null;
  return out;
}

/**
 * Every task this session currently holds.
 *
 * A worker restarting after a crash has no event to replay — the cursor is
 * gone with the process — so it needs to ask what it already holds, or it will
 * sit idle while its lease runs down on work nobody else can take.
 */
export function ownTasks(tasks, { session_id } = {}) {
  if (!nonEmpty(session_id)) return [];
  return arr(tasks)
    .filter((t) => t?.assigned_session === session_id)
    .map((t) => {
      const out = {};
      for (const f of WORKER_TASK_FIELDS) out[f] = t[f] ?? null;
      return out;
    });
}
