/**
 * THE THIRD SEAM. Execution and review both exist; this is the one that stops
 * the same work being done twice.
 *
 * Without it, a correctly guarded runtime would safely duplicate the same work
 * -- every control in place, every lease honoured, two agents building the same
 * thing. That is not hypothetical here. It happened twice in one week:
 *
 *   code-a fixed the CI failure at 5083feb. I pushed the same fix 65 minutes
 *   later at 066d32e. Both correct, both tested, both green.
 *   code-b fixed roster liveness. I duplicated it nine minutes later.
 *
 * Neither was a comms failure -- both fixes were pushed and visible to anyone
 * who looked. Nobody looked, because there was nothing to look AT: no record
 * that said "this work is claimed" in a form a machine could compare.
 *
 * PURE ON PURPOSE, like collisionGuard.mjs. No database, no git, no clock. Rows
 * arrive as arguments and a verdict comes back. The caller does the I/O and
 * turns a verdict into an exit code or an RPC. That split is what lets the
 * refusal contract be tested in a millisecond, and the refusal contract is the
 * whole product here.
 *
 * TWO MECHANISMS, DELIBERATELY NOT ONE, and the reason is the measurement above.
 *
 *   workFingerprint() is EXACT. It catches the same work being PROPOSED again
 *   -- a dispatcher regenerating a task, an agent re-reading a brief. It is
 *   what the unique index in the map is keyed on.
 *
 *   overlapping() is FUZZY and works on paths alone. It catches two agents
 *   walking toward the same FILES while describing the work differently.
 *
 * The honest part: an exact fingerprint would have caught NEITHER of the two
 * duplications above, because I described the work differently from code-a and
 * code-b both times. Prose is the thing that varies; the files are the thing
 * that does not. So the fingerprint is path-dominant and the overlap check is
 * the one that would actually have fired. Anyone tempted to collapse these into
 * one value should read that sentence again first.
 *
 * ABSENT IS NOT ZERO. A caller that could not read the active set passes
 * ok:false, and every verdict in that case is UNKNOWN. A failed lookup must
 * never resolve as "nothing found", because "nothing found" is indistinguishable
 * from "clear to proceed" at the call site, and that is how a duplicate gets
 * created by a query that never ran.
 */

import { createHash } from 'node:crypto';

/** Clear to create a new work item: nothing equivalent, nothing overlapping. */
export const CREATE = 'create';
/** Equivalent work is ALIVE. Attach to it rather than starting a second one. */
export const ATTACH = 'attach';
/** Equivalent work is COMPLETE and not invalidated. Do not rebuild it. */
export const REFUSE = 'refuse';
/** The lookup failed. Not clear, not blocked -- unknown, and the caller stops. */
export const UNKNOWN = 'unknown';

/** States in which a work item is live enough that a second one is a duplicate. */
export const ACTIVE_STATES = Object.freeze([
  'runnable',
  'assigned',
  'returned',
  'reviewing',
]);

/*
 * Words that carry no identity. Dropped so that "fix the CI failure" and "fix
 * CI failure" fingerprint alike -- rewording is the single most common way one
 * piece of work acquires two descriptions, and it is exactly what defeated the
 * discovery tooling both times.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'is', 'it',
  'that', 'this', 'with', 'at', 'by', 'from', 'be', 'as', 'we', 'our', 'its',
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * One repository path, in the one spelling everything else compares against.
 *
 * Backslashes become slashes because half this fleet runs on Windows and
 * `src\completion.mjs` and `src/completion.mjs` are the same file. A leading
 * `./` goes for the same reason. Case is folded because the two duplications
 * above crossed a case-insensitive filesystem and a case-sensitive one.
 */
export function normalisePath(p) {
  if (typeof p !== 'string') return '';
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The path contract as a set: deduped, sorted, empties dropped. */
export function normalisePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map(normalisePath).filter((p) => p !== ''))].sort();
}

/**
 * Goal prose reduced to the tokens that carry identity.
 *
 * WEAK SIGNAL, AND TREATED AS ONE. Sorting the token set means word order does
 * not matter, which is right; it also means two genuinely different tasks that
 * happen to share a vocabulary collide, which is why this is never the only
 * input and why paths dominate below.
 */
export function normaliseGoal(goal) {
  if (typeof goal !== 'string') return '';
  const tokens = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * The canonical identity of a piece of work, scoped to one repository.
 *
 * repo is NOT normalised away and NOT optional: the map keys its unique index
 * on (repo_id, work_fingerprint), and a fingerprint that collided across
 * repositories would refuse real work in one repo because of a task in another.
 */
export function workFingerprint({ repo, paths = [], goal = '' } = {}) {
  if (!isNonEmptyString(repo)) {
    throw new TypeError('workFingerprint: repo required');
  }
  const parts = [
    `repo:${repo.trim()}`,
    `paths:${normalisePaths(paths).join(',')}`,
    `goal:${normaliseGoal(goal)}`,
  ];
  return sha256(parts.join('\n'));
}

/**
 * Work items whose path contract intersects this one, in the same repository.
 *
 * THE CHECK THAT WOULD ACTUALLY HAVE FIRED. One shared file is enough: two
 * agents editing one file from different branches is the collision, whatever
 * either of them called the task.
 */
export function overlapping({ repo, paths = [], items = [] } = {}) {
  /*
   * COMPARE FOLDED, REPORT AS WRITTEN. The normalised form is a comparison key
   * and must never reach a human: the first live run of this printed
   * "docs/order.md" for a file that is docs/ORDER.md, which does not open on a
   * case-sensitive filesystem. A collision report whose paths cannot be pasted
   * into an editor is a collision report nobody acts on.
   */
  const mine = new Map();
  for (const raw of Array.isArray(paths) ? paths : []) {
    const key = normalisePath(raw);
    if (key !== '' && !mine.has(key)) mine.set(key, typeof raw === 'string' ? raw.trim() : raw);
  }
  if (mine.size === 0 || !Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (!item || item.repo !== repo) continue;
    const theirs = normalisePaths(item.paths);
    const shared = theirs.filter((p) => mine.has(p)).map((p) => mine.get(p));
    if (shared.length > 0) {
      out.push({
        work_item_id: item.work_item_id ?? null,
        state: item.state ?? null,
        held_by: item.agent_id ?? null,
        shared_paths: shared,
      });
    }
  }
  return out;
}

/**
 * Should this work be created, attached to, or refused?
 *
 * THE INVALIDATION CASE IS THE POSITIVE ONE, and it is why `invalidated_at`
 * exists in the schema rather than a boolean. Work that was completed and whose
 * capability was later genuinely invalidated must be able to run AGAIN as a new
 * generation. A completion store that can only ever say "already done" stops
 * being a duplicate guard and becomes a permanent block on re-doing anything.
 */
export function resolveWork({
  repo,
  paths = [],
  goal = '',
  active = [],
  completed = [],
  ok = true,
  errors = [],
} = {}) {
  if (!isNonEmptyString(repo)) {
    return { verdict: UNKNOWN, reasons: ['repo required'], fingerprint: null, overlaps: [] };
  }

  /*
   * ok:false short-circuits before anything is compared. Returning CREATE here
   * because `active` happens to be an empty array would manufacture exactly the
   * duplicate this module exists to prevent, out of a query that failed.
   */
  if (ok !== true) {
    return {
      verdict: UNKNOWN,
      reasons: ['the active/completed lookup failed; this is not evidence of absence', ...errors],
      fingerprint: null,
      overlaps: [],
    };
  }

  const fingerprint = workFingerprint({ repo, paths, goal });
  const activeRows = Array.isArray(active) ? active : [];
  const completedRows = Array.isArray(completed) ? completed : [];
  const overlaps = overlapping({ repo, paths, items: activeRows });

  const liveMatch = activeRows.find(
    (r) =>
      r &&
      r.repo === repo &&
      r.work_fingerprint === fingerprint &&
      ACTIVE_STATES.includes(r.state),
  );
  if (liveMatch) {
    return {
      verdict: ATTACH,
      reasons: [
        `equivalent work is already ${liveMatch.state}` +
          (liveMatch.agent_id ? ` and held by ${liveMatch.agent_id}` : ''),
      ],
      fingerprint,
      attach_to: liveMatch.work_item_id ?? null,
      overlaps,
    };
  }

  const doneMatch = completedRows.find(
    (r) => r && r.repo === repo && r.work_fingerprint === fingerprint,
  );
  if (doneMatch) {
    // Invalidated means the capability it depended on genuinely went away. That
    // is a NEW generation of the same work, not a repeat of it.
    if (doneMatch.invalidated_at) {
      return {
        verdict: CREATE,
        reasons: [`prior completion invalidated at ${doneMatch.invalidated_at}; new generation`],
        fingerprint,
        supersedes: doneMatch.work_item_id ?? null,
        overlaps,
      };
    }
    return {
      verdict: REFUSE,
      reasons: [
        `equivalent work completed at ${doneMatch.completed_at ?? 'an unrecorded time'}`,
      ],
      fingerprint,
      completed_as: doneMatch.work_item_id ?? null,
      overlaps,
    };
  }

  return { verdict: CREATE, reasons: [], fingerprint, overlaps };
}

/**
 * May this work item be recorded as COMPLETE?
 *
 * AGENT PROSE CANNOT ASSERT INTEGRATION. This is the direct fix for a line that
 * read "BUILT AND WIRED" in the order for a full day, naming an agent for
 * wiring that never happened, while the table it claimed to write to held zero
 * rows. A state written once by hand and then believed is indistinguishable
 * from a true one until somebody measures, and nobody measures prose.
 *
 * So completion requires two machine-verified facts and takes no opinion from
 * the worker: a review somebody else accepted, and an integration whose
 * ancestry was verified against the target branch. `claim` may be present for
 * the record; it is never evidence, and passing it ALONE is refused explicitly
 * rather than ignored, so the caller learns the difference.
 */
export function canComplete({
  workItemId,
  acceptedReviewId = null,
  integration = null,
  claim = null,
} = {}) {
  const errors = [];

  if (!isNonEmptyString(workItemId)) errors.push('workItemId required');

  if (!isNonEmptyString(acceptedReviewId)) {
    errors.push('no accepted review: completion requires a review another party accepted');
  }

  if (!integration || typeof integration !== 'object') {
    errors.push('no integration record: completion requires a verified integration');
  } else {
    if (integration.integration_state !== 'verified') {
      errors.push(
        `integration_state is ${integration.integration_state ?? 'absent'}, not verified`,
      );
    }
    if (!isNonEmptyString(integration.ancestry_verified_at)) {
      errors.push('integration has no ancestry_verified_at: nothing proved the commit landed');
    }
    if (isNonEmptyString(workItemId) && integration.work_item_id !== workItemId) {
      errors.push(
        `integration belongs to ${integration.work_item_id ?? 'no work item'}, not ${workItemId}`,
      );
    }
  }

  /*
   * Named separately so the message can say WHY it did not help. An agent that
   * gets "no accepted review" while it is holding what it believes is proof
   * will argue; one that gets "a claim is not evidence" has been told the rule.
   */
  if (claim !== null && errors.length > 0) {
    errors.push('a claim of completion is not evidence of it and was not counted');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * WHAT THE OVERLAP CHECK SHOULD SAY — as a value, so the failure branches can
 * be tested without arranging for git to break.
 *
 * THIS EXISTS BECAUSE A TEST OF THE INLINE VERSION WAS HOLLOW. The CLI decided
 * this in four chained else-ifs, so the only way to reach the "I could not read
 * your paths" branch was to genuinely break git in a child process. The test
 * written instead asserted that a HEALTHY repository reports healthy, passed
 * against the restored bug, and proved nothing -- a gate that only permits.
 *
 * FOUR OUTCOMES, AND THEY ARE NOT THREE. `none` and `unread` are both "no
 * collision reported" and must never collapse: one means nothing overlaps, the
 * other means nobody looked. That distinction is the entire lesson of this
 * repository and it kept being lost at the point of rendering it.
 */
export const OVERLAP_COLLISION = 'collision';
export const OVERLAP_NONE = 'none';
export const OVERLAP_UNREAD = 'unread';
export const OVERLAP_NO_PATHS = 'no-paths';

export function overlapReport({
  overlaps = [],
  myPaths = [],
  myPathsRead = true,
  frontsChecked = 0,
  unreadableFronts = 0,
  pathErrors = [],
} = {}) {
  const base = { frontsChecked, unreadableFronts, pathErrors: [...pathErrors] };

  if (Array.isArray(overlaps) && overlaps.length > 0) {
    return { ...base, state: OVERLAP_COLLISION, overlaps, checked: true };
  }
  // ORDER MATTERS: an unread contract is checked BEFORE emptiness, because a
  // failed read also produces an empty path list and would otherwise render as
  // "your working tree is clean" -- the exact sentence that is false.
  if (myPathsRead !== true) {
    return { ...base, state: OVERLAP_UNREAD, overlaps: [], checked: false };
  }
  if (!Array.isArray(myPaths) || myPaths.length === 0) {
    return { ...base, state: OVERLAP_NO_PATHS, overlaps: [], checked: false };
  }
  return { ...base, state: OVERLAP_NONE, overlaps: [], checked: true, pathCount: myPaths.length };
}
