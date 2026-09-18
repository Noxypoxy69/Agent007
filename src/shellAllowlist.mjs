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

/*
 * THE VERB LIST IS DERIVED FROM GIT_WRITE, AND THE DERIVATION IS ASSERTED.
 *
 * Enumerating these by hand produced the same gap twice. A circulating proposal
 * named nine verbs and two, leaving fetch, push, switch and tag unassigned; the
 * first correction of that error reported three, still missing switch. So the
 * classification below is checked against GIT_WRITE at module load: a verb added
 * to GIT_WRITE and to no bucket throws on import rather than silently becoming
 * the next hole. A guard that can be extended into a gap is not a guard.
 */
const GIT_WRITE_VERBS = Object.freeze(
  GIT_WRITE.source.replace(/^\^\(|\)\$$/g, '').split('|'),
);

/* Sweeps the WORKING TREE: can reach a protected file without ever naming it. */
const GIT_SWEEPS_TREE = new Set(['add', 'commit', 'restore', 'checkout', 'switch']);
/* Writes refs only. Cannot alter a tracked file's content in the worktree. */
const GIT_REF_ONLY = new Set(['fetch', 'tag']);
/* Has its own branch above, with its own reasons. */
const GIT_JUDGED_ABOVE = new Set(['push']);
/*
 * Imports somebody else's commits over the tree. These remain ALLOWED and that
 * is a deliberate, documented gap rather than an oversight: refusing merge,
 * rebase and pull outright is a workflow outage for every session in the clone,
 * and this repository has already paid for two over-blocks. The residual is
 * real -- a merge can carry a weakened guard in -- and it is Stop's protected
 * drift that is supposed to catch it. Recorded here so the next reader does not
 * mistake silence for safety.
 */
const GIT_IMPORTS_HISTORY = new Set(['merge', 'rebase', 'stash', 'cherry-pick', 'apply', 'revert', 'pull']);

/*
 * VERBS THAT OVERWRITE THE FILE THEY NAME, as against verbs that merely RECORD
 * it. The distinction matters because the baseline-test clause below is about
 * overwriting and was applied to both.
 *
 * `git restore test/a.test.mjs` replaces that test with whatever HEAD holds, and
 * protecting an inherited test from that is the clause's stated purpose. `git add`
 * and `git commit` cannot alter a file's content at all -- they record it. Because
 * the clause did not distinguish them, and because the sweep spellings were closed
 * at the same time, the two checks together left NO permitted spelling for staging
 * any test file from a guarded session: not the five orphaned ones, not a test
 * written sixty seconds ago. That is an outage, and an outage is how a guard gets
 * switched off, which loses every layer at once.
 *
 * isProtectedRelPath stays UNCONDITIONAL below. test/claudeGuard.test.mjs is a
 * protected path and must remain unstageable by every verb; this narrows only the
 * broader test glob.
 */
const GIT_OVERWRITES_NAMED_PATH = new Set(['restore', 'checkout', 'switch']);

{
  const classified = new Set([
    ...GIT_SWEEPS_TREE, ...GIT_REF_ONLY, ...GIT_JUDGED_ABOVE, ...GIT_IMPORTS_HISTORY,
  ]);
  const unassigned = GIT_WRITE_VERBS.filter((v) => !classified.has(v));
  const phantom = [...classified].filter((v) => !GIT_WRITE_VERBS.includes(v));
  if (unassigned.length || phantom.length) {
    throw new Error(
      `shellAllowlist: git verb classification is out of step with GIT_WRITE — `
      + `unassigned: [${unassigned}], not in GIT_WRITE: [${phantom}]`,
    );
  }
}

/*
 * A SELECTOR THAT MEANS "EVERYTHING DIRTY", which is how a protected file gets
 * staged, committed or reverted without appearing anywhere in the command.
 *
 * `git add -A` and `git commit -am` were ALLOW while `git add src/claudeGuard.mjs`
 * was DENY -- the guard refused the spelling CLAUDE.md mandates and permitted the
 * one that sweeps. Measured 2026-09-17 at 1489931.
 *
 * The single-dash cluster is matched so `-am` is caught; `--amend` is not, because
 * it is two dashes and amending is not a sweep.
 */
const GIT_SWEEP_SELECTOR = /(^|\s)(-[A-Za-z]*[aAuU][A-Za-z]*|--all|--update)(\s|$)/;

/*
 * FORCE, IN EVERY SPELLING IT ACTUALLY HAS.
 *
 * `git checkout -f` denied only by coincidence: WRITE_FLAGS carries -f meaning
 * --file, with no idea it means --force here. `checkout --force`, `switch --force`
 * and `switch --discard-changes` were all ALLOW. If anyone narrows WRITE_FLAGS to
 * the flags it was written for -- a reasonable tidy-up -- that accidental refusal
 * disappears and nobody would know it had been load-bearing.
 */
const GIT_FORCE_SELECTOR = /(^|\s)(-f|--force|--discard-changes|--hard|--theirs|--ours)(=|\s|$)/;

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

function splitSegments(command) {
  const input = String(command ?? '');
  const out = [];
  let quote = null;
  let buf = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      if (quote === null) quote = ch;
      else if (quote === ch) quote = null;
      buf += ch;
      continue;
    }
    if (quote === null && (ch === ';' || ch === '|' || ch === '&' || ch === '\n')) {
      const part = buf.trim();
      if (part) out.push(part);
      buf = '';
      if ((ch === '&' || ch === '|') && input[i + 1] === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return { parts: out, balanced: quote === null };
}

export function segments(command) {
  return splitSegments(command).parts;
}

export function tokenize(command) {
  const input = String(command ?? '');
  const tokens = [];
  let quote = null;
  let quoted = false;
  let buf = '';
  const push = () => {
    if (buf !== '' || quoted) tokens.push({ value: buf, quoted });
    buf = '';
    quoted = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      if (quote === null) { quote = ch; quoted = true; continue; }
      if (quote === ch) { quote = null; continue; }
    }
    if (quote === null && /\s/.test(ch)) { push(); continue; }
    buf += ch;
  }
  push();
  return { tokens, balanced: quote === null };
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
/*
 * THE OVERRIDE IS INJECTED, NOT IMPORTED, AND THAT IS THE WHOLE DESIGN.
 *
 * This rail is PURE -- it sees a command string and nothing else, which is why
 * it is testable and why the standing instruction is not to plumb session state
 * into it. It also needs to honour an operator's grant, or a granted repair can
 * be made and not committed, which is the deadlock the override channel was
 * built to end and only half ended.
 *
 * So the caller hands in a predicate. The rail asks a question; it does not go
 * looking for an answer. With no predicate supplied the behaviour is exactly
 * what it was, which keeps every existing test and caller honest.
 */
export function judgeShellCommand(command, { isOverridden = () => false, mayExecute = () => 'inherited', pathspecCovers = () => [] } = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allowed: false, reason: 'no command string was supplied' };
  }
  /*
   * STRIPPED BEFORE SPLITTING, NOT AFTER. segments() splits on `&`, so `2>&1`
   * is torn into "... 2>" and "1" and the strip below never matches it -- which
   * left `npm test 2>&1` refused for containing a redirect it no longer had.
   */
  const split = splitSegments(String(command).replace(FD_REDIRECTS, ' '));
  if (!split.balanced) {
    return { allowed: false, reason: 'the command contains an unbalanced quoted string' };
  }
  const parts = split.parts;
  if (parts.length === 0) {
    return { allowed: false, reason: 'no command string was supplied' };
  }
  /*
   * THE OVERRIDDEN PATHS SURVIVE AGGREGATION. Collapsing every segment to a bare
   * `{allowed:true}` discarded which path a grant had opened, so the caller could
   * not announce it and the permit went out silent -- the same silence the Stop
   * gate and PreToolUse were both just fixed for, arriving one layer lower.
   */
  const overriddenPaths = [];
  for (const part of parts) {
    const verdict = judgeOneSegment(part, isOverridden, mayExecute, pathspecCovers);
    if (!verdict.allowed) {
      return parts.length === 1
        ? verdict
        : { allowed: false, reason: `${verdict.reason} (in "${part}")` };
    }
    if (verdict.overriddenPath) overriddenPaths.push(verdict.overriddenPath);
  }
  return overriddenPaths.length
    ? { allowed: true, overriddenPath: overriddenPaths[0], overriddenPaths }
    : { allowed: true };
}

function judgeOneSegment(segment, isOverridden = () => false, mayExecute = () => 'inherited', pathspecCovers = () => []) {
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

  const parsed = tokenize(command);
  if (!parsed.balanced) {
    return { allowed: false, reason: 'the command contains an unbalanced quoted string' };
  }
  const tokenInfo = parsed.tokens;
  const tokens = tokenInfo.map((t) => t.value);
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
      const verb = tokens[1];
      /*
       * A SWEEP REACHES A PROTECTED FILE WITHOUT NAMING IT, WHICH IS WHY THE
       * NAMED-PATH CHECK BELOW COULD NOT SEE IT.
       *
       * That check is sound for what it covers and it covered the wrong half.
       * `git add src/claudeGuard.mjs` was refused -- the spelling CLAUDE.md
       * mandates -- while `git add -A`, `git add .`, `git commit -am` and
       * `git restore .` were all allowed, and every one of them stages, commits
       * or reverts the guard's own source. `git restore .` is the sharpest of
       * them: the hook re-imports that module on every call, so reverting the
       * tree disarms PreToolUse for the rest of the session.
       *
       * Refusing the sweep does not refuse the workflow. Committing by pathspec
       * is what this repository already requires, so the shape that remains
       * allowed is the documented one.
       */
      if (GIT_SWEEPS_TREE.has(verb)) {
        if (GIT_FORCE_SELECTOR.test(command)) {
          return {
            allowed: false,
            reason: `"git ${verb}" with a force or discard flag overwrites the tree wholesale, `
              + 'including the guard source the hook re-reads on every call',
          };
        }
        const sweepsEverything = GIT_SWEEP_SELECTOR.test(command)
          || tokens.slice(2).some((t) => t.replace(/^['"]|['"]$/g, '') === '.');
        if (sweepsEverything) {
          return {
            allowed: false,
            reason: `"git ${verb}" with an everything selector reaches every dirty file, `
              + 'protected ones included, without naming any of them; name the paths instead',
          };
        }
      }
      /*
       * A BARE BRANCH SWITCH STAYS ALLOWED and that is the same documented
       * residual as GIT_IMPORTS_HISTORY: `git checkout other-branch` does
       * replace the guard source, but refusing branch switches is a workflow
       * outage, and Stop's protected drift is the layer that owns it.
       */

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
      /*
       * A FLAG CAN CARRY THE PATHSPEC LIST OUT OF THE COMMAND ENTIRELY.
       *
       * The resolver is only ever asked about literal operand tokens, and git
       * has flags that take the pathspecs from a FILE instead. So the list
       * never appears in the command string, git is never asked, and every
       * check below sees nothing:
       *
       *   printf 'src/claudeGuard.mjs\\nsrc/shellAllowlist.mjs\\n' > ps.txt
       *   git restore --source=2829c0a --pathspec-from-file=ps.txt   ALLOWED
       *
       * Measured: that rolled the guard and the rail back fifteen commits, to
       * before the node and pathspec hardening, in one permitted command -- and
       * the hook re-imports claudeGuard on every call, so PreToolUse is the old
       * version for the rest of the session. 29c0957 claimed "a spelling nobody
       * has thought of is answered correctly for free, because git answers it".
       * Git is never asked when the spelling is not an operand. Same
       * option-value laundering the node branch closed in its round three,
       * left open in the git branch by the commit that claimed the class.
       *
       * These two flags are refused rather than resolved: they are git's only
       * documented way to source pathspecs from outside the argument list, so
       * this is a closed set defined by git's semantics, not a guess at
       * spellings. Reading the file to resolve it would mean trusting a file
       * the session can rewrite between the check and the command.
       */
      const pathspecFromFile = tokens.find((t) => /^--pathspec-from-file(=|$)/.test(t) || t === '--pathspec-file-nul');
      if (pathspecFromFile) {
        return {
          allowed: false,
          reason: `"${pathspecFromFile}" takes the pathspec list out of the command, so what it would touch `
            + 'cannot be judged from the command string. Name the paths as operands instead',
        };
      }
      /*
       * AND A FLAG'S VALUE IS NOT A PATHSPEC. Feeding every token to the
       * resolver refused ordinary one-word commit messages, because the message
       * is a tracked path: `git commit -m test` named test/claudeGuard.test.mjs,
       * `-m docs` named docs/CLAUDE_GUARD_PROVENANCE.md, `-m bin` named the hook
       * binary. Longer messages passed, so it bit exactly the shortest ones, and
       * the refusal text was unintelligible to whoever hit it.
       */
      const VALUE_TAKING = /^(-m|--message|-F|--file|-C|--reuse-message|-c|--reedit-message|--author|--date|--source|-S|--gpg-sign|-b|-B|--orphan)$/;
      const operandTokens = [];
      for (let i = 2; i < tokens.length; i += 1) {
        if (VALUE_TAKING.test(tokens[i])) { i += 1; continue; }
        operandTokens.push(tokens[i]);
      }
      const named = operandTokens
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
        .filter((t) => t !== '' && t !== '--')
        /*
         * ASK GIT WHAT THE PATHSPEC COVERS. DO NOT ENUMERATE SPELLINGS.
         *
         * This compared each operand against the literal string "." and nothing
         * else, so every other way of saying "everything" walked through. All of
         * these were ALLOW and every one sweeps protected controls -- measured
         * against the shipped rail:
         *
         *   git restore :/   ./   .//   "./"   *   src   src/   ..   :!nothing
         *   git add     :/   *    src   ..           git commit :/ -m msg
         *
         * A git pathspec is RECURSIVE and has its own grammar -- magic prefixes,
         * negation, globs, bare directories. `git restore src` reverts
         * src/claudeGuard.mjs without naming it, and isProtectedRelPath('.claude')
         * is false because the list entry carries a trailing slash. Adding these
         * spellings to the literal-dot list is the enumeration that has already
         * lost here four times on the node branch and twice on this one.
         *
         * So the question is handed to the thing that owns the grammar. The
         * caller injects a resolver backed by git itself; an operand is treated
         * as naming every protected file git says it covers. Measured on this
         * repo: ":/" and "./" and "*" each cover 329 tracked files of which 17
         * are protected, "src" covers 85 of which 6 are, and ":!nothing" and
         * ":^nonexistent" cover all 329 because they exclude nothing. A spelling
         * nobody has thought of is answered correctly for free, because git
         * answers it.
         *
         * With no resolver the behaviour is the old literal check, so callers
         * with no repository context are unchanged.
         */
        .flatMap((t) => {
          const covered = pathspecCovers(t);
          if (covered.length) return covered;
          if (isProtectedRelPath(t)) return [t];
          if (GIT_OVERWRITES_NAMED_PATH.has(verb) && /^test\/.+\.test\.mjs$/i.test(t)) return [t];
          return [];
        });
      /*
       * EVERY PROTECTED PATH IN THE COMMAND MUST BE GRANTED, NOT THE FIRST ONE.
       *
       * This used .find(), so it saw only the FIRST protected token and returned
       * allowed on it -- the rest were never examined. Ordering the granted path
       * first was the entire attack. Measured by audit:
       *
       *   grant names src/guardSession.mjs only
       *   git checkout HEAD -- src/guardSession.mjs src/claudeGuard.mjs .claude/settings.json
       *     -> ALLOWED, and it reverts the guard source and the hook config
       *
       * The comment above this block is explicit that reverting that module
       * disarms PreToolUse for the rest of the session. It did. One grant opened
       * every protected path that shared a command line with it, and the
       * announcement named only the granted one, so no layer could report the
       * others.
       */
      /*
       * A GRANT PERMITS RECORDING THE FILE, NOT OVERWRITING IT.
       *
       * The two are different permissions and this did not distinguish them. A
       * grant written so an agent could REPAIR src/guardSession.mjs also
       * permitted `git checkout -- src/guardSession.mjs`, which discards the
       * repair. Reported while another session had exactly that repair sitting
       * uncommitted: its work was one allowed command from gone, under a grant
       * issued to protect it.
       *
       * `add` and `commit` record what is already in the tree and cannot change
       * a file's content. `restore`, `checkout` and `switch` replace it with
       * whatever some other commit holds -- and for the guard's own source that
       * disarms PreToolUse for the rest of the session, which is the reason this
       * check exists at all. An override relaxes the first class and never the
       * second; nobody grants permission to destroy the thing they are asking to
       * have fixed.
       */
      const ungranted = named.filter((t) => !isOverridden(t));
      if (GIT_OVERWRITES_NAMED_PATH.has(verb) && named.length > 0) {
        const first = named[0];
        return {
          allowed: false,
          reason: `"git ${verb}" would OVERWRITE ${first}, which is a guard or completion control. `
            + 'An override permits recording a protected path (add, commit); it does not permit '
            + 'replacing one, which would discard the very repair a grant is issued for',
        };
      }
      if (named.length > 0 && ungranted.length === 0) {
        return { allowed: true, overriddenPath: named[0], overriddenPaths: [...named] };
      }
      if (ungranted.length) {
        const first = ungranted[0];
        return {
          allowed: false,
          reason: `"git ${tokens[1]}" names ${first}, which is a guard or completion control`,
        };
      }
      return { allowed: true };
    }
  }

  if (first === 'npm') {
    if (!NPM_SHAPE.test(tokens[1] ?? '')) {
      return { allowed: false, reason: `"npm ${tokens[1] ?? '(none)'}" is not an approved shape` };
    }
    /*
     * npm FORWARDS EVERYTHING AFTER `--` TO THE SCRIPT, so judging tokens[1]
     * alone left the node gate one spelling away from useless:
     *
     *   npm test -- pwn.mjs
     *     -> node --test "test/**\/*.test.mjs" pwn.mjs
     *     -> PAYLOAD EXECUTED
     *
     * Measured. The sibling branch had just been hardened to refuse
     * `node --test <inherited> pwn.mjs`, and the identical execution went
     * through here unjudged because nothing looked past the verb. Forwarded
     * operands are operands, so they get the same question the node branch
     * asks: a file this session could have written is not runnable.
     */
    const sep = tokens.indexOf('--');
    if (sep !== -1) {
      const forwarded = tokens.slice(sep + 1).filter((t) => !t.startsWith('-'));
      const smuggled = forwarded.find((t) => mayExecute(t) === 'untracked-file');
      if (smuggled) {
        return {
          allowed: false,
          reason: `"${smuggled}" is forwarded to the script npm runs and is not part of the repository `
            + 'this session inherited, so running it would execute code this session wrote',
        };
      }
    }
    return { allowed: true };
  }

  if (first === 'node') {
    if (NODE_EVAL.test(tokens[1] ?? '')) {
      return { allowed: false, reason: 'node -e composes its target at runtime and cannot be judged from the command string' };
    }
    /*
     * A SCRIPT THIS SESSION JUST WROTE IS NOT A SCRIPT THE REPOSITORY SHIPS.
     *
     * This branch allowed `node <anything>`, which made the whole rail
     * decorative -- disarming the guard took two ordinary calls with no grant,
     * no metacharacter and nothing exotic:
     *
     *   Write helper.mjs  (an ordinary path -- allowed)
     *   node helper.mjs   (allowed)      helper.mjs then rewrites claudeGuard.mjs
     *                                    and .claude/settings.json
     *
     * Measured end to end through the shipped binary: afterwards the same hook
     * answered {} to a Write of CLAUDE.md. The header's claim that "everything
     * else is refused" was false for node, and the declared shape
     * ['node', /^--test$/] was unreachable dead code sitting below this block.
     *
     * REFUSING `node <file>` OUTRIGHT WAS THE WRONG FIX AND I NEARLY SHIPPED IT.
     * `node bin/agentbridge.mjs` is how every command in this repository runs --
     * check-first, register-session, observe-sha, delegate. Refusing it is a
     * bigger outage than the hole, and rule 17 is about exactly that.
     *
     * The line that actually separates them is the one isSessionBaselineTest
     * already draws for tests: a file the session INHERITED versus a file the
     * session WROTE. bin/agentbridge.mjs is the first. helper.mjs, written one
     * tool call earlier, is the second, and it is the entire attack.
     *
     * WHAT THIS DOES NOT CLAIM. An agent can still write a script, commit it,
     * and run it, because a committed file is inherited by the NEXT session.
     * That is three calls and a commit that a reader can see, instead of two
     * calls and nothing -- cost and visibility, not closure. Execution cannot be
     * bounded from a command string; the boundary is still Stop, as the header
     * says. This removes the free route, not the class.
     *
     * With no predicate supplied the behaviour is unchanged, so callers that
     * have no session context are not broken by this.
     */
    /*
     * EVERY NON-FLAG TOKEN IS JUDGED. NOTHING IS EXEMPT.
     *
     * The first version of this gate exempted the whole command when `--test`
     * appeared ANYWHERE in it, via tokens.includes. That exemption WAS the
     * bypass, and it re-opened the exact two-call disarm the gate was written to
     * close -- `node` passes `--test` after the script path straight through to
     * the script as argv, so:
     *
     *   Write helper.mjs  <payload>      allowed
     *   node helper.mjs --test           ALLOWED, and the payload ran
     *
     * Measured end to end through the shipped binary at 2812d8a. The commit's
     * own proof table listed `node --test test/a.test.mjs` and `node helper.mjs`
     * and never ran `node --test helper.mjs`; six true lines offered as evidence
     * for a property none of them tested.
     *
     * AND THE REASON GIVEN FOR THE EXEMPTION WAS FALSE. It claimed a test the
     * session wrote is covered by baseline-test drift at Stop. baselineTestDrift
     * iterates snapshot.tests, which holds only files present at SESSION START,
     * so a test created during the session is never hashed and never compared.
     * The asymmetry the exemption rested on does not exist.
     *
     * So `--test` now only means what the declared shape ['node', /^--test$/]
     * always said it meant: the token IMMEDIATELY after `node`. It suppresses
     * nothing -- every remaining non-flag token still goes through mayExecute,
     * which is also what removes the option-value laundering below.
     */
    /*
     * AN ALLOWLIST OF FLAGS, BECAUSE ENUMERATING THE BAD ONES LOST THREE TIMES.
     *
     * Round 1: `node <anything>` was allowed outright.
     * Round 2: I exempted the line when `--test` appeared anywhere, and the
     *          exemption became the bypass -- `node helper.mjs --test`.
     * Round 3: I judged operands, and `--import=./pwn.mjs` walked past because
     *          it starts with a dash, so my own isFlag stripped it out before
     *          anything looked at it. The header I wrote said "EVERY NON-FLAG
     *          TOKEN IS JUDGED. NOTHING IS EXEMPT" while every payload-bearing
     *          flag token was exempt. Also live: --eval=, --require=,
     *          --experimental-loader=, and -r= -- and --eval= needs no script
     *          argument at all.
     *
     * That is the same loop this file's header opens with: "Every round closed
     * the reported instances and the next round produced new ones in minutes."
     * node's flag surface is open-ended and grows every release, so a denylist
     * of dangerous flags cannot be finished. A FOURTH enumeration would be the
     * same mistake with a longer regex.
     *
     * So the question becomes what shape is KNOWN safe. Exactly one flag is
     * permitted and it carries no value; every other flag is refused, including
     * ones that do not exist yet. An unknown flag is not assumed harmless --
     * that assumption is what each of the three rounds above was made of.
     *
     * WITH NO VALUE-TAKING FLAG PERMITTED, operands[0] is unambiguously the
     * program. That also retires the "no later operand may be an untracked
     * file" rule, which was there only to stop an option value laundering the
     * script -- and which refused ordinary work: passing a file you just created
     * to a repository tool, `node bin/agentbridge.mjs check-first notes.txt`,
     * was denied even though node never executes it. Arguments are arguments.
     */
    /*
     * NODE'S ARGUMENT GRAMMAR, WRITTEN DOWN, BECAUSE GUESSING IT FAILED FOUR
     * TIMES IN A ROW AND EACH GUESS SHIPPED WITH A PROOF TABLE THAT MISSED THE
     * SHAPE IT GOT WRONG.
     *
     *   node [node-flags] [program] [args-for-the-program]
     *
     * node stops interpreting its OWN flags at the first non-flag token. Tokens
     * after that belong to the program and node never looks at them -- so
     * refusing them refuses the repository's own CLI, which is what round 4 did:
     * `node bin/agentbridge.mjs status --json`, the documented machine-readable
     * form, was denied. Round 3 had allowed it.
     *
     * AND `--test` CHANGES THE GRAMMAR. In test-runner mode node executes EVERY
     * path operand as a module, not just the first. So round 4's stated premise,
     * "with no value-taking flag permitted, operands[0] is unambiguously the
     * program", is false for the single flag round 4 permitted -- and on the
     * strength of that premise it DELETED the check that caught it. Measured:
     *
     *   node --test test/actionAuthority.test.mjs pwn.mjs   ALLOWED, and pwn.mjs ran
     *
     * The parent denied that. Round 4 was a regression in both directions at
     * once: it reopened the disarm it was written to close and refused ordinary
     * work it had not measured.
     *
     * So the split is explicit rather than assumed. Flags BEFORE the program are
     * node's and must be allowlisted; the program must be inherited; tokens
     * AFTER the program are argv and are none of this gate's business. With
     * --test present every path operand is a module, so every one is judged.
     */
    const NODE_PERMITTED_FLAG = /^--test$/;
    const argv = tokens.slice(1);
    const programIndex = argv.findIndex((t) => !t.startsWith('-'));
    const nodeFlags = programIndex === -1 ? argv : argv.slice(0, programIndex);
    const operands = programIndex === -1 ? [] : argv.slice(programIndex);

    const rejectedFlag = nodeFlags.find((t) => !NODE_PERMITTED_FLAG.test(t));
    if (rejectedFlag) {
      return {
        allowed: false,
        reason: `"${rejectedFlag}" is not an approved node flag. node flags can carry code or a file `
          + '(--eval=, --import=, --require=, --experimental-loader=), so this accepts one known shape '
          + 'rather than trying to list the dangerous ones -- an unknown flag is refused, not assumed safe',
      };
    }

    /*
     * IN TEST MODE EVERY OPERAND IS EXECUTED, so every operand is judged. Outside
     * it only the program is executed and the rest is the program's own argv.
     */
    const executed = nodeFlags.some((t) => t === '--test') ? operands : operands.slice(0, 1);
    const notInherited = executed.find((t) => mayExecute(t) !== 'inherited');
    if (notInherited) {
      return {
        allowed: false,
        reason: `"${notInherited}" is not part of the repository this session inherited, so running it would `
          + 'execute code this session wrote -- which is how a guard gets disarmed in two calls. '
          + 'Commit it first, or run it outside the repository',
      };
    }
    return { allowed: true };
  }

  if (first.toLowerCase() === 'sed') {
    return SED_READ.test(command.trim())
      ? { allowed: true }
      : { allowed: false, reason: 'sed is accepted only as a line-range print (sed -n <range>p <file>); its w command writes files' };
  }

  if (PS_READ_ONLY.has(first.toLowerCase())) {
    for (const info of tokenInfo.slice(1)) {
      const bare = info.value;
      if (bare === '') continue;
      if (info.quoted) continue;
      if (!SAFE_ARG.test(bare)) {
        return { allowed: false, reason: `argument ${JSON.stringify(bare)} is not a plain path or flag` };
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

  for (const info of tokenInfo.slice(subPattern ? 2 : 1)) {
    const bare = info.value;
    if (bare === '') continue;
    if (info.quoted) {
      /* Separators and whitespace inside a balanced quote are data, not shell syntax.
       * Expansion/redirection/backslash remain refused earlier by FORBIDDEN_CHARS. */
      continue;
    }
    if (!SAFE_ARG.test(bare)) {
      return { allowed: false, reason: `argument ${JSON.stringify(bare)} is not a plain path or flag` };
    }
  }
  return { allowed: true };
}
