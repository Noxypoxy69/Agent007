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

/**
 * NUL, BECAUSE A COMMIT MESSAGE CANNOT CONTAIN ONE AND I HAD TO BE SHOWN THAT.
 *
 * The first version of this used \x1f and \x1e, with a comment asserting that
 * "neither occurs in a subject line". That was an assumption written as a fact,
 * and it was wrong in the worst available direction. A commit SUBJECT carrying
 * a \x1e ended the record early and the rest of the subject was parsed as a
 * fresh commit -- so anyone able to write a commit message to this repository
 * could make `agentbridge who` report a session that never existed, or pad
 * another session's count. A subject carrying a \x1f silently truncated.
 * Demonstrated, not theorised: a crafted subject produced two records, the
 * second attributed to session_EVIL.
 *
 * This report exists to be believed, and its entire input is text that other
 * agents write. A delimiter that can appear in the data is therefore not a
 * formatting choice, it is a forgery surface.
 *
 * NUL cannot appear. Git refuses it at object creation --
 * `error: a NUL byte in commit log message not allowed` -- which was checked by
 * trying to make one with git commit-tree rather than by reading documentation.
 * So every field is NUL-terminated and records are read in fixed groups of
 * four. There is no record delimiter to forge, because there are no records:
 * there are fields, counted.
 */
export const FIELD_SEP = '\x00';

/**
 * The `git log` format this module parses. Exported so the caller cannot drift
 * from it: a format string in one file and a parser in another is the splice
 * problem in miniature.
 */
export const FIELDS_PER_RECORD = 4;
export const LOG_FORMAT = '%H%x00%cI%x00%(trailers:key=Claude-Session,valueonly)%x00%s%x00';

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
  const fields = String(text ?? '').split(FIELD_SEP);
  const out = [];
  // Fixed groups of four. A trailing partial group is a truncated stream --
  // dropped, never padded, because a half-read record is not a commit.
  for (let i = 0; i + FIELDS_PER_RECORD - 1 < fields.length; i += FIELDS_PER_RECORD) {
    // git separates commits with a newline, so the first field of each record
    // after the first carries it. Trimming is safe: none of these fields may
    // contain leading or trailing whitespace that means anything.
    const sha = str(fields[i]);
    const at = str(fields[i + 1]);
    if (!sha || !at) continue;
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    out.push({
      sha,
      at,
      session: sessionFromTrailer(fields[i + 2]),
      subject: str(fields[i + 3]) ?? '',
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
