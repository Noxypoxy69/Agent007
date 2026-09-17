import { isProtectedRelPath } from './guardSession.mjs';

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

/*
 * Tokens that make a command unjudgeable wherever they appear.
 *
 * `;` `|` and `&` USED TO BE IN HERE AND THAT WAS THE WRONG CALL. They do not
 * make a command unjudgeable, they make it SEVERAL commands -- and refusing the
 * whole line meant `git status ; ls` and `npm test 2>&1` were refused as though
 * they were attacks. That is the false-positive rate that gets a rail switched
 * off, and switching it off loses the Stop gate with it. They are split points
 * now (see judgeShellCommand) and every segment is judged on its own, so
 * `git status && rm CLAUDE.md` still dies on its second half.
 *
 * What remains is genuinely unjudgeable: substitution and expansion build the
 * command at runtime, redirection writes a file that never appears as an
 * argument, and a backslash escapes whatever analysis follows it.
 */
const FORBIDDEN_CHARS = /[$`<>(){}\n\\]/;

/*
 * Redirection to a file DESCRIPTOR rather than a file. `2>&1` writes nothing,
 * and refusing it made every attempt to capture output look hostile. Stripped
 * before the check above; a redirect to a PATH is still refused.
 */
const FD_REDIRECTS = /\s*\d?>&\d\s*/g;

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

/*
 * ORDINARY WRITES. THE ORIGINAL CRITERION WAS WRONG.
 *
 * This rail refused everything not provably READ-ONLY, which also refused
 * `git pull`, `git commit`, `git checkout` and `npm install` -- the things
 * agents do all day. On 2026-09-17 that stopped all work on the operator's
 * machine. A guard that blocks Tuesday is not a guard; it is an outage waiting
 * for the first person in a hurry to switch it off.
 *
 * What actually needed stopping was DESTRUCTION OF THE CONTROL FILES, not
 * writing in general. These shapes can touch the repository, and two of them
 * (checkout, restore) can overwrite a protected file -- which is caught at Stop
 * by protected-file drift, the same posture `npm test` and MCP writes already
 * have. Caught afterwards, not blocked.
 *
 * What stays out: rm, mv, cp, Remove-Item and the other destructive verbs, and
 * every interpreter, because an interpreter builds its target at runtime and
 * cannot be judged from the command string.
 */
const GIT_WRITE = /^(pull|fetch|push|add|commit|checkout|switch|merge|rebase|stash|restore|cherry-pick|tag|apply|revert)$/;

const NPM_SHAPE = /^(test|install|ci|run|list|ls|view|why|outdated|audit|version)$/;

/*
 * `node <file>` is allowed and `node -e` is not, which looks inconsistent until
 * you notice `npm test` already runs arbitrary repository JavaScript. A script
 * in the repo is visible, reviewable, and covered by baseline-test drift at
 * Stop. A -e string is composed on the spot and is none of those things.
 */
const NODE_EVAL = /^(-e|--eval|-p|--print)$/;

/**
 * `git branch` is a WRITER unless it is explicitly listing.
 *
 * A first version allowed optional trailing arguments without --list, so
 * `git branch newref` -- which creates a ref -- passed. A positional argument is
 * only safe once --list has made the invocation a query.
 */
/*
 * POWERSHELL IS THE PRIMARY SHELL ON THE OPERATOR'S MACHINE AND THIS LIST WAS
 * POSIX-ONLY. Measured 2026-09-17 on Windows: Get-Content, Get-ChildItem,
 * Select-String, Test-Path and Get-Location were all refused. Those are reads.
 * Refusing the only way to read a file on the machine the guard runs on is how
 * a rail gets switched off, and switching it off loses the Stop gate too.
 *
 * Cmdlet names are case-insensitive in PowerShell, so these are matched
 * lower-cased. Writers stay out by omission: Set-Content, Add-Content,
 * Out-File, Remove-Item, Move-Item, Copy-Item, New-Item, Invoke-Expression and
 * Start-Process are not here and therefore refused. Piping a read into a writer
 * cannot help either -- a pipe is a forbidden metacharacter before this point.
 *
 * Alias coverage is deliberately partial. A missing alias is a LOUD one-line
 * fix; a wrongly included writer is silent. Weigh additions on that.
 */
const PS_READ_ONLY = new Set([
  'get-content', 'get-childitem', 'get-item', 'get-location', 'get-command',
  'select-string', 'test-path', 'resolve-path', 'split-path', 'join-path',
  'measure-object', 'compare-object', 'select-object', 'format-list', 'format-table',
  // the common read-only aliases
  'gc', 'gci', 'gi', 'gl', 'gcm', 'sls',
]);

/*
 * SED IS ALLOWED ONLY IN ONE SHAPE, AND NOT BECAUSE SED IS SAFE.
 *
 * `sed -n '1,20p' CLAUDE.md` is named in src/claudeGuard.mjs as the read that
 * justified removing a path check -- but sed was never added here, so it stayed
 * refused in every quoting form. The comment described a repair that did not
 * exist. Measured 2026-09-17.
 *
 * A blanket `sed` entry would be a WRITE primitive: the `w` command and the
 * `s///w file` flag both create files, with no metacharacter and no write flag
 * for the checks above to see. So only a line-range print is accepted, which is
 * the documented use and nothing else.
 */
const SED_READ = /^sed\s+-n\s+(['"]?)\$?[0-9]+(?:,(?:\$|[0-9]+))?p\1\s+[^\s]+$/;

const GIT_BRANCH_LIST = /^git\s+branch$|^git\s+branch\s+--list(\s+[A-Za-z0-9._/@:=+,^~*-]+)?$/;

export function segments(command) {
  return String(command ?? '')
    .split(/(?:\|\||&&|[;|&\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/*
 * THE ALLOWLIST, EXPORTED SO A GATE CAN GENERATE FROM IT RATHER THAN RESTATE IT.
 *
 * CLAUDE.md rule 2: a check that RECONSTRUCTS the rule agrees with itself
 * straight through the regression it exists to catch. A gate that carried its
 * own copy of these names would keep passing after somebody added a writer here.
 *
 * And rule 8: an adversarial probe bounds nothing. Listing the destructive verbs
 * we happen to have thought of proves nothing about the ones we have not. The
 * only total property available is the COMPLEMENT of this set -- everything not
 * named here is refused -- and that property is only testable if the set itself
 * is readable.
 */
export const ALLOWED_FIRST_TOKENS = Object.freeze([
  ...SHAPES.map(([name]) => name),
  ...PS_READ_ONLY,
  'sed',
]);

/**
 * Returns { allowed } or { allowed: false, reason }.
 *
 * EVERY SEGMENT MUST PASS, AND THE VERDICT IS THE STRICTEST OF THEM. A chained
 * line is several commands, so it is judged as several commands. `segments()`
 * sat in this file unused for weeks while the separators it splits on were being
 * refused outright one function below -- the answer was already written down and
 * nothing called it.
 */
export function judgeShellCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allowed: false, reason: 'no command string was supplied' };
  }
  /*
   * STRIPPED BEFORE SPLITTING, NOT AFTER. segments() splits on `&`, so `2>&1`
   * is torn into "... 2>" and "1" and the strip below never matches it -- which
   * left `npm test 2>&1` refused for containing a redirect it no longer had.
   */
  const parts = segments(String(command).replace(FD_REDIRECTS, ' '));
  if (parts.length === 0) {
    return { allowed: false, reason: 'no command string was supplied' };
  }
  for (const part of parts) {
    const verdict = judgeOneSegment(part);
    if (!verdict.allowed) {
      return parts.length === 1
        ? verdict
        : { allowed: false, reason: `${verdict.reason} (in "${part}")` };
    }
  }
  return { allowed: true };
}

function judgeOneSegment(segment) {
  const command = String(segment).replace(FD_REDIRECTS, ' ').trim();
  if (command === '') {
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
    if (tokens[1] === 'push') {
      /*
       * PUSH IS A WRITE TO SOMEBODY ELSE'S HISTORY. Allowing `git push` wholesale
       * let `git push origin master` and `git push --force origin feature`
       * through -- caught by a baseline test that has asserted both since before
       * this rail existed, and it was right. Nothing here owns the default branch,
       * and a force push destroys work that is not this session's to destroy.
       *
       * --force is checked explicitly because WRITE_FLAGS only carries `-f`, and
       * a leading `+` on a refspec is the same thing spelled differently.
       */
      if (/(^|\s)(--force|--force-with-lease|--mirror|--delete)(=|\s|$)/.test(command)) {
        return { allowed: false, reason: 'a force, mirror or delete push rewrites history that is not this session\'s to rewrite' };
      }
      const badRef = tokens.slice(2).find((t) => /^\+/.test(t) || /^(master|main)$/.test(t) || /:(master|main)$/.test(t));
      if (badRef) {
        return { allowed: false, reason: `pushing "${badRef}" targets the default branch or forces a refspec; nothing here owns main` };
      }
    }
    if (GIT_WRITE.test(tokens[1] ?? '')) {
      /*
       * A GIT WRITE MAY NOT NAME A PROTECTED PATH. `git restore
       * src/claudeGuard.mjs` and `git checkout <old> -- src/guardSession.mjs`
       * overwrite the guard's own source, and the hook re-reads that module on
       * every invocation -- so the guard is disarmed for the rest of the session
       * the moment the command returns. "Caught at Stop" is the right posture for
       * `npm test`, which nobody can do without; it is the wrong posture for a
       * command whose entire effect is to replace the control being evaded.
       *
       * This is path detection, which the header above says loses -- and it does,
       * AS A BOUNDARY. Here it is not the boundary: the shape had to be approved
       * first, and the general case is still Stop's job. It closes the one route
       * that turns a permitted write into a disarm.
       */
      const named = tokens.slice(2)
        .map((t) => t.replace(/^['"]|['"]$/g, ''))
        .map((t) => t.split('\\').join('/'))
        /*
         * BASELINE TESTS COUNT TOO. `git restore test/real.test.mjs` overwrites
         * a test the session inherited, and only test/claudeGuard.test.mjs is a
         * PROTECTED path -- so the protected check alone let every other one
         * through. Same omission the Stop gate's git check had, found the same
         * way: a baseline test that has asserted this for longer than this rail
         * has existed.
         */
        .find((t) => t !== '' && t !== '--'
          && (isProtectedRelPath(t) || /^test\/.+\.test\.mjs$/i.test(t)));
      if (named) {
        return {
          allowed: false,
          reason: `"git ${tokens[1]}" names ${named}, which is a guard or completion control`,
        };
      }
      return { allowed: true };
    }
  }

  if (first === 'npm') {
    return NPM_SHAPE.test(tokens[1] ?? '')
      ? { allowed: true }
      : { allowed: false, reason: `"npm ${tokens[1] ?? '(none)'}" is not an approved shape` };
  }

  if (first === 'node') {
    return NODE_EVAL.test(tokens[1] ?? '')
      ? { allowed: false, reason: 'node -e composes its target at runtime and cannot be judged from the command string' }
      : { allowed: true };
  }

  if (first.toLowerCase() === 'sed') {
    return SED_READ.test(command.trim())
      ? { allowed: true }
      : { allowed: false, reason: 'sed is accepted only as a line-range print (sed -n <range>p <file>); its w command writes files' };
  }

  if (PS_READ_ONLY.has(first.toLowerCase())) {
    for (const t of tokens.slice(1)) {
      const bare = t.replace(/^['"]|['"]$/g, '');
      if (bare === '') continue;
      if (!SAFE_ARG.test(bare)) {
        return { allowed: false, reason: `argument ${JSON.stringify(t)} is not a plain path or flag` };
      }
    }
    return { allowed: true };
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
