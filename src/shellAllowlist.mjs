/**
 * EXACT COMMAND SHAPES. The previous version called itself an allowlist and was
 * a first-token allowlist with a subcommand denylist bolted on. Measured against
 * it, nine of ten known writers were allowed:
 *
 *     git fetch origin            writes refs/FETCH_HEAD, supports --upload-pack
 *     git branch newref           writes a ref
 *     git remote set-url ...      writes configuration
 *     npm ci                      writes node_modules, runs lifecycle scripts
 *     npm run build               executes arbitrary repository commands
 *     npx cowsay                  downloads and executes arbitrary programs
 *     node scripts/anything.mjs   executes arbitrary repository code
 *     find . -fprintf out %p      writes a file with no -delete and no -exec
 *     sed -n 'w target' file      writes a file without -i
 *
 * Approving a BINARY and then subtracting its dangerous sub-commands is a
 * denylist wearing the other word: the list of writers is open-ended and every
 * omission is a hole. So nothing is approved by binary. A command must match one
 * of the exact shapes below, anchored end to end, or it is refused.
 *
 * WHAT THIS COSTS, SAID PLAINLY. No `node`, no `npm`, no `npx`, no `env`, no
 * `awk`, no `find`, no `sed`. The agent cannot run the test suite from Bash.
 * That is deliberate: running tests IS executing repository code, and the Stop
 * gate already runs the suite itself, in a process the turn does not control.
 * An agent that wants a suite run gets it at Stop, not on demand.
 *
 * SHELL METACHARACTERS ARE REFUSED OUTRIGHT, including inside quotes. `grep -E
 * 'a|b'` is refused. Deciding whether a metacharacter is quoted means writing a
 * shell parser, and a guard whose correctness depends on out-parsing bash has
 * already lost. A refused command can be rephrased; a mis-parsed one cannot be
 * recalled.
 */

/** Tokens that make a command unjudgeable wherever they appear. */
const FORBIDDEN_CHARS = /[$`;|&<>(){}\n\\]/;

/**
 * Arguments a read-only command may carry. No absolute-path writes, no output
 * redirection flags, nothing that names an executable.
 */
const SAFE_ARG = /^[A-Za-z0-9._/@:=+,^~[\]?*%-]+$/;

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
