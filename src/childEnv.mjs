/**
 * WHAT A SPAWNED BUILDER IS ALLOWED TO INHERIT.
 *
 * ═══ THE HOLE THIS CLOSES ═══
 *
 * `startRun` spawned the agent with no `env` option, so the child inherited
 * `process.env` entire: the registration token, the Supabase service key, the
 * coordinator credential, AGENTBRIDGE_HOME. Everything the daemon holds.
 *
 * And the repository reads as though that were handled. THREE tests assert a
 * credential cannot reach the agent:
 *
 *   THE EVENT CARRIES NO CREDENTIAL            (leaseTokenIsDelivered)
 *   THE BRIEF CANNOT CONTAIN A CREDENTIAL,     (workerRuntime) -- and it is a
 *     BY CONSTRUCTION                           structural argument, not a habit:
 *                                               the token is not a parameter
 *   THE BRIEF HANDED TO THE AGENT CARRIES      (workerRuntime)
 *     NO CREDENTIAL
 *
 * All three are correct and all three guard the ARGV/PROMPT/EVENT channel. The
 * environment is wider, was never examined, and is inherited by default. That
 * is the house failure exactly: a narrow channel closed with care while the
 * broad one stays open, and the test names make the subject sound settled.
 *
 * It matters more than it would have a week ago, because the builder is NOT
 * one of our agents. It is whatever the platform dispatches into the worktree
 * -- code we do not write and cannot instrument -- and it was being handed a
 * coordinator token.
 *
 * ═══ AN ALLOW-LIST, BECAUSE A DENY-LIST OF SECRETS LOSES ═══
 *
 * The tempting shape is to strip names matching /TOKEN|KEY|SECRET/. That is
 * the roster-of-names mistake this repository has now lost to three times in
 * one day on the shell rail alone, and it fails the same way: the next
 * credential is called something else. `SUPABASE_URL` carries no secret and
 * `AGENTBRIDGE_HOME` is not a token, yet both hand a child the ability to act
 * as this daemon.
 *
 * So the question is inverted: what does a process legitimately need in order
 * to RUN, on this OS? That list is short, stable, and owned by the operating
 * system rather than by us. Everything else is dropped, including things that
 * look harmless, and a caller that needs one more variable passes it
 * explicitly and says why.
 *
 * ═══ NOT AN OUTAGE ═══
 *
 * Strip PATH and the spawn fails; strip APPDATA on Windows and node tooling
 * breaks in ways that look like the agent is broken. Rule 19: an over-block
 * here means every run fails and the fix gets reverted wholesale. The
 * essentials below are the ones a child actually needs, and there is a test
 * that PATH survives.
 *
 * PURE. The parent environment is an argument, so a test can hand it a
 * credential without one existing.
 */

/**
 * Variables a process needs to start and behave normally.
 *
 * DERIVED FROM WHAT THE OS PROVIDES, not from what our code happens to read.
 * Both the Windows and POSIX spellings are present on purpose: this list is
 * applied on whichever platform is running, and a name absent from the parent
 * is simply not copied.
 */
export const OS_ESSENTIALS = Object.freeze([
  /* Finding and running programs. */
  'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'SHELL',
  /* Windows system roots. Absent these, a great deal simply does not start. */
  'SystemRoot', 'SystemDrive', 'windir', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  /* Where a process may write scratch. */
  'TEMP', 'TMP', 'TMPDIR',
  /* Home, which node, git and npm all resolve against. */
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  /* npm and node put caches here on Windows; without them tooling misbehaves. */
  'APPDATA', 'LOCALAPPDATA',
  /* Locale and terminal shape. Cosmetic, but their absence produces confusing output. */
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLUMNS', 'LINES',
  /* Hardware facts some runtimes read for pool sizing. */
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

/**
 * NODE_OPTIONS IS DELIBERATELY NOT AN ESSENTIAL.
 *
 * It is not a credential, and it is worse than one: it carries `--require` and
 * `--import`, so inheriting it hands the child arbitrary module execution
 * chosen by whatever set it. The shell rail already refuses those exact flags
 * on a node command line; passing them through an inherited variable would be
 * the same execution by another route.
 *
 * A caller that genuinely needs it passes it in `allow` and owns the decision.
 */
export const NEVER_INHERITED = Object.freeze(['NODE_OPTIONS']);

/**
 * Build the environment for a spawned builder.
 *
 * @param {object} parentEnv  usually process.env
 * @param {object} opts
 *   allow  extra variable NAMES this caller has decided the child may have.
 *          Explicit, per call site, so the decision is visible in the diff.
 *   add    literal values to set, for things the child needs that the parent
 *          does not have.
 */
export function childEnv(parentEnv = {}, { allow = [], add = {} } = {}) {
  const src = parentEnv && typeof parentEnv === 'object' ? parentEnv : {};
  const extra = Array.isArray(allow) ? allow.filter((k) => typeof k === 'string' && k.trim() !== '') : [];

  const permitted = new Set([...OS_ESSENTIALS, ...extra].map((k) => k.trim()));
  for (const never of NEVER_INHERITED) permitted.delete(never);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (permitted.has(k) && typeof v === 'string') out[k] = v;
  }

  /*
   * `add` IS APPLIED LAST AND IS NOT FILTERED. It is a value this caller chose
   * to set rather than one the child inherited by accident, which is a
   * different decision with a different author.
   */
  if (add && typeof add === 'object') {
    for (const [k, v] of Object.entries(add)) {
      if (typeof k === 'string' && k.trim() !== '' && typeof v === 'string') out[k] = v;
    }
  }
  return out;
}
