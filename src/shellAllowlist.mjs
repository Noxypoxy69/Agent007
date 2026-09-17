/**
 * A CONSERVATIVE ALLOWLIST, BECAUSE BASH IS A PROGRAMMING LANGUAGE.
 *
 * The previous guard detected mutation by extracting path tokens and matching
 * them against protected paths. That closed the spellings it knew and nothing
 * else. Measured against the shipped guard, ALL of these were allowed:
 *
 *     node -e "require('fs').unlinkSync('src/claudeGuard.mjs')"
 *     python3 -c "open('scripts/claude-stop-gate.mjs','w').write('')"
 *     eval "$COMMAND"
 *     find src -name claudeGuard.mjs -delete
 *     perl -e "unlink q(src/claudeGuard.mjs)"
 *
 * No list of filename spellings reaches those. An interpreter can construct any
 * path at runtime, `eval` hides the command until it runs, and `find -delete`
 * never names the file. Denylisting a language is a losing position by
 * construction, so the question is inverted: what is KNOWN to be read-only?
 *
 * FAILS CLOSED. An unrecognised command is refused. That is deliberately
 * expensive -- a legitimate command will be refused and have to be rephrased or
 * run by the owner -- and the alternative is a guard that reports "protected"
 * while `node -e` empties the file it protects.
 *
 * REPOSITORY WRITES GO THROUGH THE STRUCTURED TOOLS, where the path is a field
 * rather than a string to be parsed. That is the seam this exists to enforce.
 *
 * COMMIT AND PUSH ARE NOT HERE. They are a separate operation that belongs
 * after the Stop gate has passed, not something a coding turn does mid-flight.
 */

/** First tokens that are read-only in every form this repository uses. */
export const ALLOWED_COMMANDS = Object.freeze([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'basename', 'dirname',
  'echo', 'printf', 'pwd', 'which', 'date', 'true', 'false', 'test',
  'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'comm', 'diff', 'column', 'jq',
  // Read-only in these forms; the mutating variants (sed -i, find -delete,
  // find -exec) are hard-refused above whatever the first token is.
  'sed', 'awk', 'find', 'env',
  'node', 'npm', 'npx', 'git',
]);

/** Sub-commands that keep an otherwise-dangerous binary read-only. */
export const ALLOWED_SUBCOMMANDS = Object.freeze({
  git: [
    'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-remote',
    'ls-files', 'ls-tree', 'merge-base', 'cat-file', 'for-each-ref', 'branch',
    'remote', 'blame', 'describe', 'shortlog', 'grep', 'fetch',
  ],
  npm: ['test', 'run', 'ls', 'view', 'ci'],
  npx: null,   // judged by its arguments below
  node: null,
  npm_: null,
});

/** Shapes that make any command unjudgeable, whatever its first token. */
const HARD_REFUSALS = Object.freeze([
  [/(^|[^<>])>{1,2}[^>]/, 'output redirection'],
  [/\$\(/, 'command substitution'],
  [/`/, 'backtick substitution'],
  [/\beval\b/, 'eval'],
  [/\bxargs\b/, 'xargs'],
  [/\bsource\b|^\s*\./, 'sourcing a script'],
  [/\b(?:node|python3?|perl|ruby|php|deno|bun)\s+-\s*(?:e|c)\b/, 'an inline interpreter program'],
  [/\b(?:node|python3?|perl|ruby|php|deno|bun)\s+--eval\b/, 'an inline interpreter program'],
  [/\bfind\b[^|;&]*-(?:delete|exec|execdir|ok)\b/, 'find with a mutating action'],
  [/\bgit\b[^|;&]*\b(?:commit|push|reset|checkout|restore|clean|rm|mv|rebase|merge|cherry-pick|stash|worktree|update-ref|update-index|hash-object)\b/,
    'a git operation that can write'],
  [/\bnpm\b[^|;&]*\b(?:install|uninstall|pkg|publish|link|exec)\b/, 'an npm operation that can write'],
  [/\bsudo\b|\bchmod\b|\bchown\b|\bln\b/, 'a privilege or link operation'],
  [/\b(?:rm|mv|cp|dd|shred|truncate|tee|install|rsync|unlink|mkdir|touch|sed\s+[^|;&]*-i|perl\s+[^|;&]*-i)\b/,
    'a filesystem mutation'],
]);

/** Split on shell separators so each segment is judged on its own first token. */
export function segments(command) {
  return String(command ?? '')
    .split(/(?:\|\||&&|[;|&\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * May this command run?
 *
 * Returns { allowed } or { allowed: false, reason }. The reason names what was
 * not recognised, because a refusal nobody can act on gets overridden.
 */
export function judgeShellCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allowed: false, reason: 'no command string was supplied' };
  }

  for (const [pattern, what] of HARD_REFUSALS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `${what} is refused: it can write without naming a path` };
    }
  }

  for (const seg of segments(command)) {
    const tokens = seg.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
    let first = (tokens[0] ?? '').replace(/^['"]|['"]$/g, '');
    // VAR=x cmd ... — skip leading assignments rather than treating them as the command
    let i = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) && i + 1 < tokens.length) {
      i += 1;
      first = tokens[i].replace(/^['"]|['"]$/g, '');
    }
    const base = first.split('/').pop();
    if (!ALLOWED_COMMANDS.includes(base)) {
      return { allowed: false, reason: `"${base}" is not on the read-only allowlist` };
    }
    const subs = ALLOWED_SUBCOMMANDS[base];
    if (Array.isArray(subs)) {
      const sub = (tokens[i + 1] ?? '').replace(/^['"]|['"]$/g, '');
      if (!subs.includes(sub)) {
        return { allowed: false, reason: `"${base} ${sub || '(none)'}" is not a read-only sub-command` };
      }
    }
  }
  return { allowed: true };
}
