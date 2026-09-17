/**
 * WHO IS ACTUALLY WORKING, ASKED OF THE ONE SOURCE THAT CANNOT BE FORGOTTEN.
 *
 * On 2026-09-16 the roster reported fourteen sessions, every one `offline`,
 * `idle_workers: 0`, two "went stale". Read plainly that says the fleet is
 * down. It was not: three agents were committing and pushing throughout, and
 * one of them landed the dispatcher fix while the report said nobody was there.
 * The owner asked whether an agent was working and the system's own answer was
 * wrong in the direction that stops work being assigned.
 *
 * THE REGISTRY IS NOT AT FAULT AND MUST NOT BE "FIXED". liveRegistry's rule --
 * a missing heartbeat is offline, never live -- is what stops a delegation
 * being addressed to nobody, and loosening it to make the roster look busier
 * would trade a visible gap for an invisible one. The registry answers "who may
 * be given work". That question has to fail closed.
 *
 * THIS MODULE ANSWERS A DIFFERENT QUESTION: who has recently PRODUCED work.
 * It reads commits, which every session writes whether or not it runs a daemon,
 * and which no session can forget to send. That is observed evidence in the
 * same sense the Bridge means it -- a commit is a side effect, not a claim.
 *
 * AND IT MUST NEVER BE USED TO ROUTE. That is the whole risk of writing it: a
 * second thing that looks like a roster becomes a second identity system, and
 * liveRegistry's header already says what happens then -- two implementations
 * that disagree the first time one is fixed. So nothing here emits an agent id,
 * a lane or a session in the registry's namespace. The output is deliberately
 * the wrong SHAPE to hand to resolveWorker, and a test asserts that rather than
 * a comment asking nicely.
 *
 * THE TWO NAMESPACES DO NOT JOIN, AND THAT IS THE FINDING. The registry keys
 * sessions as `danny-win-10`. A commit trailer carries `session_01BoVyXdq4...`.
 * There is no table mapping one to the other and this module does not invent
 * one -- inventing it is precisely the manufactured identity liveRegistry
 * refuses. `reconcile` reports the two counts side by side and says they cannot
 * be joined, because "the registry sees nobody while four sessions are
 * committing" is the actionable fact, and a fabricated mapping would bury it.
 *
 * THIS MODULE IS PURE. The clock is a parameter, for the same reason it is one
 * in liveRegistry: recency is the entire point and a wall-clock read in here
 * makes every test a race.
 */

/** Newer than this, and a session is still at the keyboard. */
export const RECENT_MS = 30 * 60 * 1000;

/** Field and record separators, chosen because neither occurs in a subject line. */
export const FIELD_SEP = '\x1f';
export const RECORD_SEP = '\x1e';

/**
 * The `git log` format this module parses. Exported so the caller cannot drift
 * from it: a format string in one file and a parser in another is the splice
 * problem in miniature.
 */
export const LOG_FORMAT = `%H${FIELD_SEP}%cI${FIELD_SEP}%(trailers:key=Claude-Session,valueonly)${FIELD_SEP}%s${RECORD_SEP}`;

const str = (v) => (typeof v === 'string' && v.trim().length ? v.trim() : null);

/** The session id out of a trailer value, which is a URL, not an id. */
export function sessionFromTrailer(value) {
  const s = str(value);
  if (!s) return null;
  const m = s.match(/session_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

/**
 * Parse the log into records. Malformed lines are DROPPED, not defaulted:
 * a record with no sha is not a commit, and guessing one would put a fiction
 * into a report whose only purpose is being trustworthy.
 */
export function parseLog(text) {
  const out = [];
  for (const raw of String(text ?? '').split(RECORD_SEP)) {
    const chunk = raw.replace(/^[\r\n]+/, '');
    if (!chunk.trim()) continue;
    const [sha, at, trailer, subject] = chunk.split(FIELD_SEP);
    if (!str(sha) || !str(at)) continue;
    out.push({
      sha: str(sha),
      at: str(at),
      session: sessionFromTrailer(trailer),
      subject: str(subject) ?? '',
    });
  }
  return out;
}

function ageMsOf(at, now) {
  const t = Date.parse(at);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return n - t;
}

/**
 * Group commits by the session that authored them.
 *
 * A COMMIT WITH NO TRAILER IS `unattributed`, NOT "NOBODY". Absent is not zero:
 * a hand-made commit, or one from a client that does not write the trailer, is
 * evidence that SOMEBODY worked and no evidence of who. Folding those into a
 * count of zero sessions would report an idle fleet on the strength of a
 * missing line, which is the bug this module exists to stop, one level down.
 */
export function workEvidence(commits, { now, recentMs = RECENT_MS } = {}) {
  const bySession = new Map();
  let unattributed = 0;
  let unattributedRecent = 0;

  for (const c of commits ?? []) {
    const age = ageMsOf(c?.at, now);
    if (age === null) continue;
    const recent = age >= 0 && age <= recentMs;
    if (!c?.session) {
      unattributed += 1;
      if (recent) unattributedRecent += 1;
      continue;
    }
    const prev = bySession.get(c.session);
    if (!prev) {
      bySession.set(c.session, { session: c.session, commits: 1, lastAt: c.at, lastAgeMs: age, lastSubject: c.subject });
    } else {
      prev.commits += 1;
      if (age < prev.lastAgeMs) {
        prev.lastAt = c.at;
        prev.lastAgeMs = age;
        prev.lastSubject = c.subject;
      }
    }
  }

  const sessions = [...bySession.values()]
    .map((s) => ({ ...s, recent: s.lastAgeMs >= 0 && s.lastAgeMs <= recentMs }))
    .sort((a, b) => a.lastAgeMs - b.lastAgeMs);

  return {
    sessions,
    recent: sessions.filter((s) => s.recent),
    quiet: sessions.filter((s) => !s.recent),
    unattributed,
    unattributedRecent,
  };
}

/**
 * Put the two answers beside each other WITHOUT joining them.
 *
 * `registryLive` is however many sessions the registry considers live. It is a
 * number, not a list of names mapped onto commit authors, because no mapping
 * exists. `joinable` is false and is returned rather than assumed, so a caller
 * that later gains a mapping has somewhere to put it instead of inventing one.
 *
 * `disagrees` is the whole reason to run this: the registry says nobody is
 * there and the repository says otherwise. That is not a contradiction to
 * resolve by picking a side -- it means the workers are not registering, and
 * the fix is registration, not a looser liveness rule.
 */
export function reconcile(evidence, registryLiveCount) {
  const live = Number.isInteger(registryLiveCount) && registryLiveCount >= 0 ? registryLiveCount : null;
  const producing = evidence?.recent?.length ?? 0;
  return {
    registryLive: live,
    producingNow: producing,
    joinable: false,
    disagrees: live !== null && live === 0 && producing > 0,
    note:
      'registry sessions and commit-trailer sessions are different identifier spaces; this is not a mapping',
  };
}
