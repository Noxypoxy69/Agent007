/**
 * A TASK RECORD, VALIDATED BEFORE IT EXISTS.
 *
 * WHY THIS EXISTS. There is no way to create a task on this bridge. `assign_task`
 * assigns an EXISTING task and refuses otherwise, the CLI has no create command,
 * and `agentbridge.tasks` is written only by the edge function and by
 * migrations. So the tasks table — which CLAUDE.md names as the one mechanism
 * that would have caught the sixty-five-minute and the nine-minute duplication —
 * cannot be populated by anybody coordinating work. Sixteen real items were
 * handed out tonight as prose in messages because prose was the only channel
 * available.
 *
 * PURE, AND THAT IS THE POINT. No filesystem, no network, no clock, no id
 * generation: every one of those arrives as an argument, the way
 * src/ownerDecisions.mjs already works. It means the refusal rules — the part
 * where a mistake quietly lets a bad assignment through — are testable offline
 * and exhaustively.
 *
 * THE REFUSALS ARE BUILT FROM assign_task's OWN LIST, not invented here.
 * That tool refuses when the worker is stale, offline or ambiguous; the task is
 * not runnable or returned; a dependency is unsatisfied; a path collides with
 * another assignment; the repo or lane does not match; or the base commit is
 * stale. Half of those are properties of the WORKER at assign time and are not
 * ours. The other half are properties of the RECORD, and a record that cannot
 * satisfy them is a task that will be refused forever by the only tool that can
 * assign it. Catching that here turns a permanent silent failure into a message
 * at the moment somebody typed it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: decide WHO gets the task. Assignment is a
 * separate act with its own authority and its own refusals, and folding creation
 * into it is how a coordinator ends up assigning work nobody validated.
 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** The states `claim_task` will admit. Anything else can never be picked up. */
export const RUNNABLE_STATES = Object.freeze(['runnable', 'returned']);

/**
 * The states a task may be CREATED in, which is not the same set.
 *
 * `returned` is claimable and not creatable. The table carries
 * `returned_carries_evidence CHECK (state <> 'returned' OR (returned_by IS NOT
 * NULL AND returned_head_sha IS NOT NULL))`, and a create path writes neither —
 * so a record with `state: 'returned'` passed every check here, passed the
 * duplicate and collision checks in the route, and then failed the INSERT with
 * a 400 that surfaces to the caller as a 500.
 *
 * That is precisely the failure this module's header says it exists to prevent:
 * a permanent silent failure discovered hours later instead of a message at the
 * moment somebody typed it. Conflating "claimable" with "creatable" is how it
 * got in — the two sets overlap and are not the same, and only the database
 * knew.
 */
export const CREATABLE_STATES = Object.freeze(['runnable']);

/**
 * A commit sha, matching the table's own `tasks_base_sha_check`:
 * `base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'`.
 *
 * LOWERCASE ONLY, because that is what the constraint says. `HEAD`, a short
 * sha, a branch name and a 40-character UPPERCASE sha were all accepted here
 * and all rejected by the database.
 */
export const BASE_SHA = /^[0-9a-f]{40}$/;

/**
 * A task id is a file-name-safe token, for the same reason a session id is:
 * it ends up in paths, in URLs and in query predicates.
 */
export const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * A path in `allowed_paths` is repo-relative and forward-slashed.
 *
 * REFUSED: absolute paths, drive letters, backslashes, and any `..` segment. A
 * task whose allowed paths can escape the repository is a collision guard that
 * cannot guard — `collisionGuard` compares PATHS, and two agents agreeing they
 * may both touch `../` agree on nothing.
 */
export const REPO_PATH = /^(?!\/)(?![A-Za-z]:)[^\\\0]+$/;

const hasDotDot = (p) => String(p).split('/').includes('..');

/**
 * Validate a task record. Returns {ok, errors}.
 *
 * AMBIGUOUS OR MALFORMED MEANS UNUSABLE, NOT LENIENT — the same judgement
 * validateDecision makes, and for the same reason: a typo in a lane or a repo
 * produces a task that looks assignable and is refused forever by the tool that
 * would assign it, with the refusal arriving hours later and pointing at the
 * worker rather than at the record.
 */
export function validateTask(t) {
  const errors = [];
  if (!isPlainObject(t)) return { ok: false, errors: ['task must be an object'] };

  if (!isNonEmptyString(t.task_id)) errors.push('task_id is required');
  else if (!TASK_ID.test(t.task_id.trim())) {
    errors.push(`task_id "${t.task_id}" must be a file-safe token: letters, digits, dot, dash, underscore, 64 max`);
  }

  if (!isNonEmptyString(t.title)) {
    errors.push('title is required — a task nobody can identify from the roster is one nobody picks up');
  }

  if (!isNonEmptyString(t.lane_id)) errors.push('lane_id is required — assign_task refuses a lane mismatch');
  if (!isNonEmptyString(t.repo_id)) errors.push('repo_id is required — assign_task refuses a repo mismatch');

  if (!CREATABLE_STATES.includes(t.state)) {
    errors.push(`state must be one of ${CREATABLE_STATES.join(', ')} at creation — `
      + `${RUNNABLE_STATES.join(' and ')} are both CLAIMABLE, but "returned" additionally requires `
      + 'returned_by and returned_head_sha, which nothing sets at creation, so the database refuses it');
  }

  /*
   * base_sha IS CHECKED AGAINST THE CONSTRAINT THE TABLE ACTUALLY CARRIES.
   * Unvalidated, "HEAD", a branch name, a short sha and an uppercase sha all
   * passed here and were rejected by the INSERT — a 400 the caller sees as 500.
   */
  if (t.base_sha !== null && t.base_sha !== undefined) {
    if (!isNonEmptyString(t.base_sha) || !BASE_SHA.test(t.base_sha)) {
      errors.push(`base_sha "${t.base_sha}" must be a full lowercase 40-character commit sha, `
        + 'or null — the table refuses anything else');
    }
  }

  /*
   * ALLOWED PATHS ARE REQUIRED AND MAY NOT BE EMPTY.
   *
   * An empty list reads as "no restriction" to a human and as "nothing is
   * permitted" to a path check, and the two demo fixtures in this table have
   * carried `[]` for days without anybody noticing which one it meant. Say it.
   */
  if (!Array.isArray(t.allowed_paths) || t.allowed_paths.length === 0) {
    errors.push('allowed_paths must be a non-empty array — an empty list means "unrestricted" to a '
      + 'reader and "nothing" to a collision check, and the difference is a race nobody sees');
  } else {
    for (const p of t.allowed_paths) {
      if (!isNonEmptyString(p)) { errors.push('every allowed path must be a non-empty string'); break; }
      if (!REPO_PATH.test(p) || hasDotDot(p)) {
        errors.push(`allowed path "${p}" must be repo-relative with forward slashes and no ".." segment`);
      }
    }
  }

  for (const field of ['forbidden_paths', 'shared_paths', 'depends_on']) {
    if (t[field] !== undefined && !Array.isArray(t[field])) errors.push(`${field} must be an array when present`);
  }

  /*
   * A DEPENDENCY ON ITSELF IS A TASK THAT CAN NEVER RUN, and assign_task
   * refuses an unsatisfied dependency without saying the cycle is the reason.
   */
  if (Array.isArray(t.depends_on) && isNonEmptyString(t.task_id)
      && t.depends_on.includes(t.task_id)) {
    errors.push(`task "${t.task_id}" depends on itself, so it can never become assignable`);
  }

  if (!isNonEmptyString(t.created_at)) errors.push('created_at is required');
  if (!isNonEmptyString(t.created_by)) {
    errors.push('created_by is required — an unattributed assignment is one nobody can ask about');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a task record. The caller supplies the clock and the id; this module has
 * neither, so two callers on two machines cannot disagree about either.
 */
export function createTask({
  task_id, title, lane_id, repo_id,
  state = 'runnable',
  allowed_paths = [],
  forbidden_paths = [],
  shared_paths = [],
  depends_on = [],
  base_sha = null,
  created_at,
  created_by,
  notes = null,
}) {
  /*
   * COPIED WHEN IT IS A LIST, PASSED THROUGH WHEN IT IS NOT.
   *
   * The first version spread these unconditionally and THREW on a non-array —
   * so `createTask({allowed_paths: null})` died before `validateTask` could
   * refuse it, and the refusal that exists for exactly that input was
   * unreachable through the constructor every caller is told to use. A builder
   * that rejects by crashing hands the caller a stack trace where the validator
   * would have handed them a sentence.
   *
   * Copying matters on its own account: aliasing the caller's array means a
   * later `push` rewrites a task that has already been stored.
   */
  const copy = (v) => (Array.isArray(v) ? [...v] : v);

  /*
   * TRIMMED HERE, BECAUSE IT WAS VALIDATED TRIMMED AND STORED RAW.
   *
   * `validateTask` tests `task_id.trim()` and the record kept the original, so
   * `"  abc  "` and `"abc"` both validated and became two rows a human reads as
   * one id — and the route's duplicate check compares the stored value, so it
   * would not catch the second. No injection (encodeURIComponent holds), but
   * TASK_ID's stated purpose is that this value is file-name-safe because it
   * ends up in paths and predicates, and a leading space defeats that.
   */
  const id = typeof task_id === 'string' ? task_id.trim() : task_id;

  return {
    task_id: id, title, lane_id, repo_id, state,
    allowed_paths: copy(allowed_paths),
    forbidden_paths: copy(forbidden_paths),
    shared_paths: copy(shared_paths),
    depends_on: copy(depends_on),
    base_sha,
    created_at,
    created_by,
    notes,
    assigned_agent: null,
    assigned_session: null,
    assigned_at: null,
    assigned_by: null,
    lease_token: null,
    lease_expires_at: null,
    attempt: 0,
  };
}

/**
 * Would these two tasks be refused for colliding?
 *
 * assign_task refuses "a path collides with another assignment", and it does so
 * at ASSIGN time — hours after somebody wrote two tasks that were always going
 * to fight. This answers the same question at creation, where it is cheap.
 *
 * PREFIX-AWARE, because `src/` and `src/events.mjs` collide and a string
 * comparison says they do not. Compared on segment boundaries so `src/a` and
 * `src/ab` do not — the same judgement `segmentSuffixes` already makes in the
 * permission matcher, for the same reason.
 */
/**
 * One spelling of a repo-relative path.
 *
 * FIVE TRIVIAL ALIASES DEFEATED THE COLLISION CHECK, and every one of them was
 * accepted by `validateTask`, so two coordinator-created tasks could claim the
 * same file with the gate silent:
 *
 *   ./src/a   src//a   SRC/a   src/./a   "src/a "
 *
 * On Windows and macOS the case one is literally the same file. Fixed at the
 * MATCHER rather than by listing the five the audit happened to try (rule 8) —
 * an adversarial probe is evidence that a specific attack works, never evidence
 * that the remaining ones do not.
 *
 * CASE IS FOLDED, and that is a judgement rather than an oversight. This
 * project runs on NTFS, where `SRC/a` and `src/a` are one file, and the cost of
 * folding is a false collision on a case-sensitive filesystem holding two paths
 * differing only in case — which would be a trap for humans long before it was
 * a problem for this check.
 */
const canonPath = (p) => String(p ?? '')
  .trim()
  .replace(/\\/g, '/')        // a backslash is a separator on the platform this runs on
  .replace(/\/{2,}/g, '/')    // src//a is src/a
  .replace(/(^|\/)\.(?=\/)/g, '$1') // drop interior "./" segments
  .replace(/^\.\//, '')       // and a leading one
  .replace(/\/+$/, '')        // a trailing slash names the same directory
  .toLowerCase();

export function pathsCollide(a = [], b = []) {
  const covers = (x, y) => x === y || y.startsWith(`${x}/`);
  const hits = [];
  for (const p of (Array.isArray(a) ? a : []).map(canonPath)) {
    if (!p) continue;
    for (const q of (Array.isArray(b) ? b : []).map(canonPath)) {
      if (!q) continue;
      if (covers(p, q) || covers(q, p)) hits.push([p, q]);
    }
  }
  return hits;
}
