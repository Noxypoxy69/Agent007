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
import { inboxNames } from './coordination.mjs';

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const fold = (v) => String(v ?? '').trim().toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : []);

/** Event kinds a worker can be woken for. */
export const EVENT_KINDS = ['assigned', 'cancelled', 'message'];

/**
 * A timestamp as MICROSECONDS since the epoch, because milliseconds silently
 * lose mail.
 *
 * THE DEFECT THIS EXISTS FOR. Postgres `timestamptz` is microsecond precision
 * and PostgREST hands it over intact — `2026-09-18T19:30:00.123456+00:00`.
 * `Date.parse` truncates to milliseconds, so `.123456` and `.123999` both
 * became `…123`. The cursor is an event's own `at`, so after delivering the
 * first of those the comparison below (`t > after`, strict on purpose) answered
 * FALSE for the second — and since the cursor only moves forward, that event
 * was never delivered again. A permanent mail drop, inside the mechanism whose
 * entire job is delivering mail. Found by blind audit.
 *
 * It needed two events inside the same millisecond, split across batches, which
 * is rare and is not a reason to leave it: a message that silently never
 * arrives is the failure mode nobody diagnoses, and this system routes work
 * through those events.
 *
 * MICROSECONDS FIT IN A SAFE INTEGER, so this stays plain arithmetic: epoch
 * microseconds are ~1.79e15 against a MAX_SAFE_INTEGER of ~9.0e15. Nanoseconds
 * would not, and Postgres does not produce them.
 *
 * DIGITS BEYOND SIX ARE DROPPED, deliberately. Postgres cannot emit them, and
 * inventing precision the store does not have would be a different lie.
 */
const parse = (v) => {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const frac = /\.(\d+)/.exec(String(v ?? ''));
  // Date.parse already consumed the first three fractional digits.
  const sub = frac ? Number(frac[1].slice(3, 6).padEnd(3, '0')) : 0;
  return ms * 1000 + (Number.isFinite(sub) ? sub : 0);
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
 *   actors    roster override for tests; omit to use the declared one. Injected
 *             rather than read so a test never depends on the shipped table,
 *             and so the alias table stays a single definition.
 */
export function eventsFor({
  tasks = [], messages = [], agent_id, session_id, since = null, actors = undefined,
}) {
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
        /*
         * NO LEASE TOKEN HERE, AND THAT IS A REVERSAL OF 0f47999.
         *
         * The token WAS delivered on this event. It worked, and /task is
         * better -- c8 made the argument and it changed a decision already
         * committed:
         *
         *   THE WORKER MUST CALL /task ANYWAY. This event is deliberately not
         *   sufficient to act on, so the second call is not a cost the event
         *   avoided; it is a call that always happens. The token here was
         *   redundant rather than convenient.
         *
         *   A CREDENTIAL DOES NOT BELONG IN A REPLAYABLE FEED. Events are
         *   at-least-once and cursor-driven, so the same one can arrive twice
         *   or arrive late, carrying a credential that may no longer be
         *   current. /task returns the token only to the session that still
         *   holds the task, at the moment it asks.
         *
         *   AND IT ERODED THE DOORBELL. An event carrying a credential is an
         *   event that is ALMOST enough to act on, and "almost enough" is
         *   precisely what this design refuses. The test below is named
         *   "identifies the task without describing the work"; a credential is
         *   not a description, but it was the first thing ever added here that
         *   made acting-without-reading feel reasonable.
         */
      });
    }

    if (t.state === 'cancelled' && newer(t.cancelled_at)) {
      out.push({ kind: 'cancelled', at: t.cancelled_at, task_id: t.task_id });
    }
  }

  /*
   * A SEAT HAS MORE THAN ONE NAME, AND A MESSAGE IS STORED UNDER THE ONE THE
   * SENDER TYPED.
   *
   * This was `m.to_agent !== agent_id`, a strict inequality, so a message
   * addressed to a REGISTERED ALIAS never became an event. The send path stores
   * the recipient verbatim -- index.ts writes m.to_agent as given, with no
   * canonicalisation -- so the alias is what lands in the table.
   *
   * MEASURED 2026-09-18: fixer addressed code-b as "b", which
   * src/coordination.mjs registers as a real alias of that seat. The long poll
   * would have sat holding the request open while the message it was waiting
   * for was already stored. The pull path has the same hole, one layer up.
   *
   * inboxNames IS THE READ HALF AND ALREADY EXISTED -- pure, spliced into
   * _shared.js, tested, and with no caller anywhere. docs/ORDER.md says so in as
   * many words: "The read half is inboxNames and no reader uses it yet." This is
   * the caller, not a new mechanism, so there is still exactly one alias table.
   *
   * AN UNKNOWN NAME STILL POLLS ITSELF, and this is the regression the change
   * could most easily have shipped. canonicalActor returns an unrecognised name
   * UNCHANGED rather than null -- deliberately, its comment says so -- so
   * inboxNames('fixer') is ['fixer'] and a seat absent from the roster keeps
   * receiving its own mail. Had it returned null, every such seat would have
   * gone silently deaf.
   *
   * FOLDED FOR CASE, because canonicalActor already matches that way and this
   * seat's display name is "B" while its alias is "b". A recipient differing
   * only in case is the same silent miss wearing different clothes.
   */
  const inbox = new Set(inboxNames(agent_id, actors).map(fold));

  for (const m of arr(messages)) {
    if (!m || !nonEmpty(agent_id) || !inbox.has(fold(m.to_agent))) continue;
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
