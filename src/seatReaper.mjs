/**
 * WHICH REGISTRATION SEATS ARE RECLAIMABLE.
 *
 * WHY THIS IS A MODULE AND NOT JUST SQL. The sweep itself has to run in the
 * database — a reaper that is not scheduled is a comment, and this project has
 * shipped that exact defect. But the PREDICATE is where a mistake deletes
 * something it shouldn't, and the predicate could not be tested in the database
 * at all. Three separate attempts to prove it with in-transaction fixtures were
 * each vacuous for a different reason:
 *
 *   1. `FOR UPDATE SKIP LOCKED` skips rows the probing transaction just
 *      inserted, because the insert holds a lock on them. Every planted row
 *      "survived" the sweep for the wrong reason.
 *   2. A TRIGGER on session_registrations rewrites `heartbeat_at` on write, so
 *      a row inserted with a nine-hour-old heartbeat is born fresh. The one
 *      column the predicate reads cannot be fabricated.
 *   3. Which meant the only case reachable in-database was "sweep every
 *      committed row", proving the happy path and none of the safety ones.
 *
 * So the decision lives here, where the suite can watch it fail — CLAUDE.md
 * rule 10, the same move that put canAssign and canDecidePermission in src/.
 * The SQL mirrors this shape and the migration says so.
 *
 * THE THREE PROPERTIES THAT MUST NOT BREAK, and they are all refusals:
 *   unknown liveness is not death
 *   a live seat is not death
 *   a dead seat holding live work is not ours to take
 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * The liveness window, in milliseconds. Matches STALE_AFTER_MS elsewhere: a
 * session is shown offline after this long without a heartbeat.
 */
export const STALE_WINDOW_MS = 600 * 1000;

/**
 * How many consecutive missed windows before a seat is reclaimable.
 *
 * DERIVED, NOT TYPED. Six windows is an hour of silence from a session that
 * polls every ten minutes — six missed cycles in a row is not jitter. And it is
 * deliberately far looser than the threshold for SHOWING a seat offline:
 * being displayed offline is recoverable the moment a heartbeat lands, and
 * being deleted costs a re-registration. The asymmetry in the cost should be
 * the asymmetry in the threshold.
 */
export const REAP_AFTER_WINDOWS = 6;

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Is this session holding work that is still leased to it?
 *
 * A dead seat can still own an assigned task with an unexpired lease. Deleting
 * its registration would orphan that work — and `reconcile_leases` is already
 * the mechanism that recovers it, on its own schedule. Two reapers acting on
 * one lifecycle is how the reviewer-lease asymmetry happened; this one defers.
 */
export function holdsLiveWork(sessionId, tasks, now) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  return arr(tasks).some((t) => {
    if (!isPlainObject(t)) return false;
    if (t.assigned_session !== sessionId) return false;
    if (t.state !== 'assigned') return false;
    const expires = ms(t.lease_expires_at);
    return expires !== null && expires > now;
  });
}

/**
 * Which of these seats may be reclaimed right now?
 *
 * @param {object[]} sessions  registration rows
 * @param {object[]} tasks     task rows, to check for held work
 * @param {{now:number, staleWindowMs?:number, windows?:number}} ctx
 * @returns {{session_id:string, reason:string}[]}
 */
export function reapableSeats(sessions, tasks, {
  now,
  staleWindowMs = STALE_WINDOW_MS,
  windows = REAP_AFTER_WINDOWS,
} = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return [];
  const cutoff = now - (staleWindowMs * Math.max(1, windows));
  const out = [];

  for (const s of arr(sessions)) {
    if (!isPlainObject(s)) continue;
    const id = s.session_id;
    if (typeof id !== 'string' || id === '') continue;

    /*
     * UNKNOWN LIVENESS IS NOT DEATH. A null heartbeat means nobody ever
     * stamped this row — which is exactly the state a session is in for its
     * first moments. Sweeping it deletes a session that is starting up.
     * Evidence of death, never absence of evidence; the same judgement the
     * null-is-unknown contract makes everywhere else in this system.
     */
    const beat = ms(s.heartbeat_at);
    if (beat === null) continue;

    if (beat >= cutoff) continue;                       // still within tolerance
    if (holdsLiveWork(id, tasks, now)) continue;        // not ours to take

    out.push({
      session_id: id,
      reason: `no heartbeat for ${Math.round((now - beat) / 1000)}s, `
        + `past ${windows} windows of ${Math.round(staleWindowMs / 1000)}s`,
    });
  }
  return out;
}
