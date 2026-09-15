/**
 * WHAT IS NEW FOR ONE WORKER, SINCE IT LAST LOOKED.
 *
 * THE SHAPE, AND WHY IT IS INVERTED.
 *
 * The obvious event-driven design is a webhook: the Bridge POSTs to a URL when
 * something changes. It is wrong here twice over.
 *
 *   It cannot work. The workers are local Claude Code sessions and ChatGPT is a
 *   hosted client; none of them has an inbound address. There is nothing to
 *   POST to.
 *
 *   It should not work. "There is no path from this server to a command on any
 *   machine" is the property this whole system is built around, and a data
 *   plane that makes outbound requests to a URL supplied with a registration
 *   token is an SSRF engine aimed at whatever that token holder names.
 *
 * So the client waits and the server answers. The latency is the same, the
 * outbound capability is zero, and no new credential exists.
 *
 * THE PAYLOAD IS A DOORBELL, NOT A DISPATCH. An event says "this changed, at
 * this time, with this id". It never carries the instruction itself: a worker
 * reads the task or the message through the authenticated path it already has,
 * so nothing in a wake-up is capable of being mistaken for a command.
 *
 * PURE. Rows and the clock arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/** Event kinds a worker can be woken for. */
export const EVENT_KINDS = ['assigned', 'cancelled', 'message'];

const parse = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Events for one session, strictly AFTER `since`.
 *
 * @param {object} args
 *   tasks     task rows
 *   messages  message rows
 *   agent_id  the durable identity messages are addressed to
 *   session_id the runtime messages' work is assigned to
 *   since     ISO timestamp, exclusive; omit for "everything current"
 */
export function eventsFor({ tasks = [], messages = [], agent_id, session_id, since = null }) {
  if (!nonEmpty(session_id)) {
    throw new TypeError('eventsFor requires a session_id: an event feed for nobody is a bug');
  }

  /*
   * AN UNPARSEABLE CURSOR IS NOT "FROM THE BEGINNING".
   *
   * Treating a bad `since` as null would replay the entire history as new
   * work, and a worker waking to a hundred stale assignments is worse than one
   * that never wakes at all -- it acts on them.
   */
  let after = null;
  if (since !== null && since !== undefined) {
    after = parse(since);
    if (after === null) throw new TypeError(`since is not a timestamp: ${since}`);
  }

  const newer = (v) => {
    const t = parse(v);
    if (t === null) return false;          // undateable rows are never "new"
    return after === null || t > after;
  };

  const out = [];

  for (const t of arr(tasks)) {
    if (!t || t.assigned_session !== session_id) continue;

    if (t.state === 'assigned' && newer(t.assigned_at)) {
      out.push({
        kind: 'assigned',
        at: t.assigned_at,
        task_id: t.task_id,
        // Enough to know WHICH task, never enough to act without reading it.
        lane_id: t.lane_id ?? null,
        repo_id: t.repo_id ?? null,
      });
    }

    if (t.state === 'cancelled' && newer(t.cancelled_at)) {
      out.push({ kind: 'cancelled', at: t.cancelled_at, task_id: t.task_id });
    }
  }

  for (const m of arr(messages)) {
    if (!m || !nonEmpty(agent_id) || m.to_agent !== agent_id) continue;
    if (!newer(m.created_at)) continue;
    out.push({
      kind: 'message',
      at: m.created_at,
      message_id: m.message_id,
      from: m.from_agent ?? null,
      type: m.type ?? null,
      task_id: m.task_id ?? null,
      /*
       * THE BODY IS DELIBERATELY ABSENT.
       *
       * A wake-up that delivers the coordinator's prose straight into a
       * worker's loop is a dispatch wearing a doorbell's clothes. The worker
       * fetches the body through the read path, where it is plainly something
       * it chose to go and read.
       */
    });
  }

  // Oldest first: a worker processes what happened in the order it happened.
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out;
}

/**
 * The cursor to pass back next time.
 *
 * The newest event's timestamp, or the previous cursor when nothing happened --
 * NEVER "now". Using the clock would silently skip anything written between the
 * last row read and the moment the answer was composed, and a skipped
 * assignment is indistinguishable from one that was never made.
 */
export function nextCursor(events, previous = null) {
  const list = arr(events).filter((e) => nonEmpty(e?.at));
  if (!list.length) return previous;
  return list.reduce((max, e) => (String(e.at) > String(max) ? String(e.at) : max), String(list[0].at));
}
