/**
 * A FAST-FEEDBACK RAIL. NOT A SECURITY BOUNDARY. Read this before trusting it.
 *
 * Two independent reviews converged on the same verdict and the evidence is in
 * this repository's own history. The first version tokenised filenames; node -e,
 * python3 -c, eval, find -delete and perl -e all walked past it. The second
 * approved binaries and subtracted dangerous sub-commands; nine of ten known
 * writers walked past that. The third -- exact command shapes -- was handed
 * `sort -o package.json package.json`, which contains no metacharacter, matches
 * an approved shape, carries only plain-looking arguments, and rewrites the file
 * in place. A thirty-second audit of the remaining approved binaries then found
 * five more: sort --output=, jq -f, jq --argfile, diff --to-file=, column -o.
 *
 * THAT IS NOT A LIST OF BUGS. It is what filtering a programming language looks
 * like from the inside. Every round closed the reported instances and the next
 * round produced new ones in minutes, because the writer surface of POSIX is
 * open-ended and the agent runs as the same user with the same permissions.
 *
 * SO THE BOUNDARY IS NOT HERE. It is the Stop gate, which compares CONTENT
 * against a pre-session snapshot. Measured on the same attack: PreToolUse
 * allowed `sort -o package.json package.json`, the file was rewritten, and the
 * Stop gate blocked -- knowing nothing about `sort` or about `-o`. A check that
 * inspects the RESULT does not need to enumerate the ways of producing it.
 *
 * WHAT THIS FILE IS FOR, THEN. Catching the honest mistake early, while the
 * agent can still act on the feedback, instead of at the end of a turn. That is
 * worth having and it is all this is.
 *
 * AND IT IS DELIBERATELY PERMISSIVE ABOUT TEST RUNNING. A previous version
 * refused node and npm outright. That makes iterative debugging impossible, and
 * a guard that makes ordinary work impossible gets disabled by the first person
 * in a hurry -- which removes every guarantee at once, including the Stop gate.
 * An override incentive is a vulnerability. `node --test` and `npm test` execute
 * repository JavaScript and can do anything; they are allowed anyway, because
 * the boundary that catches them is Stop, and refusing them buys nothing except
 * a reason to turn the rail off.
 *
 * REAL CONTAINMENT lives outside this checkout: an ephemeral container or a
 * read-only mount where the agent works in scratch space and only a patch comes
 * back. Nothing in this file substitutes for that, and this header exists so
 * nobody reads a green run here as if it did.
 */

/** Tokens that make a command unjudgeable wherever they appear. */
const FORBIDDEN_CHARS = /[$`;|&<>(){}\n\\]/;

/**
 * Arguments a read-only command may carry. No absolute-path writes, no output
 * redirection flags, nothing that names an executable.
 */
const SAFE_ARG = /^[A-Za-z0-9._/@:=+,^~[\]?*%-]+$/;

/**
 * Write flags on tools that are otherwise read-only. Named instances, and the
 * header is explicit that naming instances is not closing the class: `sort -o`
 * rewrites in place, and five siblings turned up in the audit that found it.
 */
const WRITE_FLAGS = /(^|\s)(-o|--output|--output-file|--to-file|--from-file|-f|--argfile|--rawfile|--slurpfile)(=|\s|$)/;

/** Flags that turn an otherwise-read-only git invocation into something else. */
const GIT_POISON = /(^|\s)(-c|--exec-path|--upload-pack|--receive-pack|--output|-o|--config-env|--git-dir|--work-tree|--namespace)(=|\s|$)/;

/**
 * Exact shapes. Each entry is [first-token, allowed-second-token or null].
 * A null second token means the command takes no sub-command.
 */
const SHAPES = Object.freeze([
  // git, read-only porcelain and plumbing only. `branch` only in --list form.
  ['git', /^(status|diff|log|show|rev-parse|rev-list|ls-remote|ls-files|ls-tree|merge-base|cat-file|for-each-ref|blame|describe|shortlog|symbolic-ref|var)$/],
  // Plain file and text reading.
  ['ls', null], ['cat', null], ['head', null], ['tail', null], ['wc', null],
  ['file', null], ['stat', null], ['pwd', null], ['basename', null], ['dirname', null],
  ['date', null], ['which', null], ['echo', null], ['printf', null],
  ['true', null], ['false', null], ['test', null],
  ['grep', null], ['rg', null], ['sort', null], ['uniq', null], ['cut', null],
  ['tr', null], ['comm', null], ['diff', null], ['column', null], ['jq', null],
  /*
   * TEST RUNNING IS ALLOWED, AND IT EXECUTES REPOSITORY CODE.
   *
   * `node --test <paths>` and `npm test` can do anything a .mjs file can do,
   * including deleting this guard. They are here because refusing them makes
   * iterative debugging impossible and the first person in a hurry disables the
   * rail entirely -- losing the Stop gate too. The boundary that catches a
   * malicious test is Stop, not this list.
   */
  ['node', /^--test$/],
  ['npm', /^test$/],
]);

/**
 * `git branch` is a WRITER unless it is explicitly listing.
 *
 * A first version allowed optional trailing arguments without --list, so
 * `git branch newref` -- which creates a ref -- passed. A positional argument is
 * only safe once --list has made the invocation a query.
 */
const GIT_BRANCH_LIST = /^git\s+branch$|^git\s+branch\s+--list(\s+[A-Za-z0-9._/@:=+,^~*-]+)?$/;

export function segments(command) {
  return String(command ?? '')
    .split(/(?:\|\||&&|[;|&\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Returns { allowed } or { allowed: false, reason }. */
export function judgeShellCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allowed: false, reason: 'no command string was supplied' };
  }
  if (FORBIDDEN_CHARS.test(command)) {
    return {
      allowed: false,
      reason: 'the command contains a shell metacharacter (substitution, redirection, chaining or escaping)',
    };
  }

  if (WRITE_FLAGS.test(command)) {
    return { allowed: false, reason: 'a flag that writes or reads a side file (-o, --output, --to-file, -f, --argfile, ...)' };
  }

  const tokens = command.trim().split(/\s+/);
  const first = tokens[0];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
    return { allowed: false, reason: 'a leading environment assignment can change what the command resolves to' };
  }

  if (first === 'git') {
    if (GIT_POISON.test(command)) {
      return { allowed: false, reason: 'a git flag that can execute or redirect (-c, --upload-pack, --output, --git-dir, ...)' };
    }
    if (tokens[1] === 'branch') {
      return GIT_BRANCH_LIST.test(command.trim())
        ? { allowed: true }
        : { allowed: false, reason: 'git branch writes a ref unless it is listing' };
    }
  }

  const shape = SHAPES.find(([name]) => name === first);
  if (!shape) {
    return { allowed: false, reason: `"${first}" has no approved read-only shape` };
  }
  const [, subPattern] = shape;
  if (subPattern) {
    const sub = tokens[1] ?? '';
    if (!subPattern.test(sub)) {
      return { allowed: false, reason: `"${first} ${sub || '(none)'}" is not an approved read-only shape` };
    }
  }

  for (const t of tokens.slice(subPattern ? 2 : 1)) {
    const bare = t.replace(/^['"]|['"]$/g, '');
    if (bare === '') continue;
    if (!SAFE_ARG.test(bare)) {
      return { allowed: false, reason: `argument ${JSON.stringify(t)} is not a plain path or flag` };
    }
  }
  return { allowed: true };
}
