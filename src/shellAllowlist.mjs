import { isProtectedRelPath } from './guardSession.mjs';
import { commitFence } from './gitIndexLease.mjs';

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
const WRITE_FLAG_NAMES = Object.freeze([
  '-o', '--output', '--output-file', '--to-file', '--from-file',
  '-f', '--argfile', '--rawfile', '--slurpfile',
]);

/*
 * ONE LIST, ONE CHECK. THE RAW-STRING TWIN IS GONE, AND SO IS THE ONE THAT
 * REPLACED IT.
 *
 * `WRITE_FLAGS` survived as "the raw-string form for callers that have no
 * tokenizer" -- a comment asserting a caller that did not exist. A blind audit
 * grepped the whole tree and found no `.test()` call for it, nor for
 * `GIT_SWEEP_SELECTOR` or `GIT_FORCE_SELECTOR`, in the same week as a commit one
 * file over titled "three exports called by nothing: delete them". They are
 * module-private, so the dead-export ratchet cannot see them, which is exactly
 * how they survived.
 *
 * Then I replaced `WRITE_FLAG_TOKEN` with the function below and left IT dead
 * too -- a fourth one, created by the fix for the third. Deleting them here
 * rather than after the next audit.
 */
const WRITE_FLAG_SHORT = WRITE_FLAG_NAMES.filter((f) => /^-[A-Za-z]$/.test(f));
const WRITE_FLAG_LONG = WRITE_FLAG_NAMES.filter((f) => f.startsWith('--'));

/**
 * Is this token a write flag, in any spelling the option actually has?
 *
 * A SHORT OPTION CARRIES ITS VALUE GLUED ON, AND MISSING THAT LET A FILE BE
 * WRITTEN. Measured through the shipped rail by blind audit, then reproduced:
 *
 *     sort -o<path> <input>      ALLOWED, exit 0, and the file was written
 *     sort '-o' <path> <input>   DENY
 *     sort -o <path> <input>     DENY
 *
 * `-o<FILE>` is the canonical POSIX short-option form and exactly what GNU
 * `sort` documents. The previous token matcher accepted the flag alone or glued
 * with `=`, which are the two spellings I happened to think of -- the third
 * enumeration on this line in two days, after the raw-string one and the
 * exact-alternation one. Past this check `sort` meets only SAFE_ARG, whose
 * character class accepts a glued flag naming a repository path.
 *
 * So the RULE is asked instead of the spellings: a short option takes a glued
 * value, a long option takes an `=` value. Both lists are derived from
 * WRITE_FLAG_NAMES, so adding a flag there covers every form at once.
 *
 * ERRING TOWARD REFUSAL IS RIGHT HERE. `-ofoo` and `-ffoo` are refused whether
 * or not the tool would have read them as a flag; the cost is a command
 * spelled another way, and the cost of the other direction is a file written
 * where nothing could see the path.
 */
function isWriteFlagToken(token) {
  if (typeof token !== 'string') return false;
  if (WRITE_FLAG_SHORT.some((f) => token.startsWith(f))) return true;
  const name = token.split('=')[0];
  return WRITE_FLAG_LONG.includes(name);
}

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

/*
 * WHICH FLAGS CONSUME THE NEXT TOKEN, PER VERB.
 *
 * Generated from `git <verb> -h`: a flag consumes the following token iff its
 * help line ends in `<something>`. A bracketed `[=<...>]` is an OPTIONAL value,
 * which git only accepts glued with `=`, so those consume NOTHING and are
 * deliberately absent -- that is why -S (--gpg-sign) and -t (--track) are not
 * here despite looking like they take values.
 *
 * test/gitFlagArity.test.mjs rebuilds this from the installed git and asserts
 * equality in BOTH directions, so a git upgrade that adds or removes a value
 * flag turns that test red rather than silently changing what this rail skips.
 *
 * EVERY VERB THAT TAKES A -m IS LISTED, and that is not cosmetic. "An unlisted
 * verb skips nothing" is the safe default against SWALLOWING a pathspec, but it
 * over-blocks a flag VALUE -- and merge, tag and stash all take -m, so omitting
 * them refused every short one-word message that happened to be a tracked path:
 *
 *   git merge -m test topic  ->  DENY: "git merge" names test/claudeGuard.test.mjs
 *
 * which is the exact defect this table was created to fix for commit, recreated
 * on three other verbs by leaving them out. Found by blind audit on the commit
 * that introduced it.
 *
 * `add` and `stash` are listed too, now that the derivation is trustworthy for
 * them: the test reads a value only where git prints its own <placeholder>,
 * which stopped it mistaking one-space-away DESCRIPTION prose ("keep index",
 * "(same as --no-all)") for a value.
 */
export const GIT_FLAG_TAKES_VALUE = {
  commit: new Set(['-C', '-F', '-U', '-c', '-m', '-t', '--author', '--cleanup',
    '--date', '--file', '--inter-hunk-context', '--message',
    '--pathspec-from-file', '--reedit-message', '--reuse-message', '--squash',
    '--template', '--trailer', '--unified']),
  restore: new Set(['-U', '-s', '--conflict', '--inter-hunk-context',
    '--pathspec-from-file', '--source', '--unified']),
  checkout: new Set(['-B', '-U', '-b', '--conflict', '--inter-hunk-context',
    '--orphan', '--pathspec-from-file', '--unified']),
  switch: new Set(['-C', '-c', '--conflict', '--create', '--force-create',
    '--orphan']),
  merge: new Set(['-F', '-X', '-m', '-s', '--cleanup', '--file', '--into-name',
    '--message', '--strategy', '--strategy-option']),
  tag: new Set(['-F', '-m', '-u', '--cleanup', '--contains', '--file',
    '--format', '--local-user', '--merged', '--message', '--no-contains',
    '--no-merged', '--points-at', '--sort', '--trailer']),
  stash: new Set(['-U', '-m', '--inter-hunk-context', '--message',
    '--pathspec-from-file', '--unified']),
  add: new Set(['-U', '--inter-hunk-context', '--pathspec-from-file',
    '--unified']),
};
const EMPTY_FLAG_SET = new Set();

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
/*
 * THE SWEEP AND FORCE SELECTORS ARE ANCHORED TO ONE TOKEN, BECAUSE THE RAW-STRING
 * FORM LOST TO A SINGLE QUOTE CHARACTER.
 *
 * Measured through the shipped rail by blind audit, 2026-09-18, and reproduced
 * by the author before believing it -- two commands, both harmless dry runs:
 *
 *   git add --dry-run -A      DENY   "an everything selector reaches every
 *                                     dirty file, protected ones included"
 *   git add --dry-run '-A'    ALLOW  exit 0
 *
 * The trailing anchor above is `(\s|$)`. In `git add '-A'` the character after
 * the `A` is a quote, so the pattern simply does not match, and `git add '-A'`
 * stages every dirty file including every protected control. The tokenizer has
 * stripped quotes since it was written -- the stripped values were used one
 * line below for the `=== '.'` comparison and nowhere else, so the two halves
 * of one check disagreed about quoting for as long as both existed.
 *
 * THIS IS THE `git restore :/` LESSON AGAIN, ONE LAYER DOWN. That one was a
 * spelling of "everything" nobody enumerated; this is a spelling of `-A`
 * nobody enumerated. The answer is the same: stop pattern-matching the command
 * TEXT and ask the structure. The tokenizer already owns the question "what
 * are the arguments", so it is what gets asked.
 *
 * AND IT CLOSES THE OTHER DIRECTION AT THE SAME TIME, which is why this is a
 * repair rather than a tightening. Testing the raw string also matched a
 * selector inside a quoted COMMIT MESSAGE, so
 * `git commit src/x.mjs -m "handle --force flag"` was refused for containing
 * the word it was fixing -- you could not honestly describe a flag change in
 * its own commit. A flag's VALUE is skipped here using the arity table this
 * file already maintains, so a message is never mistaken for an option.
 */
/*
 * A LONG OPTION IS WHATEVER PREFIX GIT WOULD RESOLVE, NOT THE FULL SPELLING.
 *
 * git accepts any unambiguous prefix of a long option, so `--al` is `--all`,
 * `--up` is `--update`, and `--forc` is `--force`. An exact alternation misses
 * every one of them -- found by an independent audit within hours of the
 * token-anchored rewrite that was itself the fix for a quoting bypass. Two
 * enumerations in one night on one matcher, which is the argument for asking
 * what a flag MEANS rather than listing how it is written.
 *
 * ERRING TOWARD REFUSAL IS RIGHT ON THIS SIDE. `--a` is a prefix of several of
 * these, so git calls it ambiguous and refuses it too; matching it costs a
 * caller nothing they could have run. And every refusal here has a compliant
 * alternative one word away -- name the paths -- so rule 19's outage asymmetry
 * does not apply the way it does to a tool-name roster.
 *
 * The short forms stay CLUSTERS. `-qf` is force with company, `-am` is a sweep
 * with company, and an exact `-f` misses both.
 */
/*
 * `--no-ignore-removal` IS `-A`, AND GIT SAYS SO ITSELF.
 *
 * `git add -h` prints:  --[no-]ignore-removal  ... (same as --no-all)
 *
 * so the NEGATED form is the all selector. Measured through the shipped rail by
 * blind audit, with a behavioural control rather than a reading of the help:
 * a bare dry-run add, `--no-all`, `--ignore-removal` and `--renormalize` all
 * print "Nothing specified, nothing added"; `--no-ignore-removal` prints
 * NOTHING, meaning git took the implicit whole-tree pathspec exactly as it does
 * for `-A`. It was ALLOWED, and so was its abbreviation.
 *
 * git's `--[no-]` convention was simply outside the model -- the list held the
 * positive spellings and resolved prefixes of those. And the pathspec resolver
 * is NOT a backstop here, because there is no operand for it to resolve.
 *
 * `--no-all` is deliberately absent: it is the OPPOSITE, and it is not a prefix
 * of the entry below, so it stays allowed.
 */
const GIT_SWEEP_LONG = Object.freeze(['--all', '--update', '--no-ignore-removal']);
const GIT_FORCE_LONG = Object.freeze(['--force', '--discard-changes', '--hard', '--theirs', '--ours']);

/*
 * A SHORT OPTION CAN BE A DIGIT, AND BOTH CLUSTER CLASSES WERE LETTERS ONLY.
 *
 * `git checkout -h` and `git restore -h` both print `-2, --ours` and
 * `-3, --theirs`. So `--ours` -- which IS in the force list, spelled out -- has
 * a one-character alias that the matcher could not see, and any cluster
 * containing a digit escaped entirely. Measured through the shipped rail by
 * blind audit and reproduced here:
 *
 *     git checkout -2  -- <path>   ALLOWED  (git then refused the pathspec)
 *     git checkout -f2 -- <path>   ALLOWED  -- and the refusal came from GIT,
 *                                  not from us: "--ours/--theirs, --force and
 *                                  --merge are incompatible"
 *     git checkout -qf -- <path>   DENY     (control: all-letter cluster works)
 *
 * The second is the one that matters. `--force` reached git through a token the
 * force matcher cannot see, and git happened to reject the combination. A
 * refusal from the far end is not this rail working.
 *
 * Exploitability is limited -- `-2` against a protected path is still caught by
 * the pathspec resolver -- but the commit that wrote this list called it "force,
 * in every spelling it actually has", and it was two spellings short.
 */
const GIT_SWEEP_SHORT = /^-[A-Za-z0-9]*[aAuU][A-Za-z0-9]*$/;
const GIT_FORCE_SHORT = /^-[A-Za-z0-9]*[f23][A-Za-z0-9]*$/;

const flagMatches = (token, short, long) => {
  if (typeof token !== 'string') return false;
  const name = token.split('=')[0];
  if (short.test(name)) return true;
  if (name.length <= 2) return false;          // `--` is the separator, not an option
  return long.some((f) => f.startsWith(name));
};

const GIT_SWEEP_TOKEN = { test: (t) => flagMatches(t, GIT_SWEEP_SHORT, GIT_SWEEP_LONG) };
const GIT_FORCE_TOKEN = { test: (t) => flagMatches(t, GIT_FORCE_SHORT, GIT_FORCE_LONG) };

/**
 * The tokens a git command presents as OPTIONS: flag values removed, and
 * everything after `--` removed because git says nothing there is a flag.
 *
 * Quotes are already gone -- `tokens` carries `value`, not the spelling -- so
 * `-A` and `'-A'` and `"-A"` arrive here identically. That is the whole fix.
 */
function gitOptionTokens(tokens, verb) {
  const takesValue = GIT_FLAG_TAKES_VALUE[verb] ?? EMPTY_FLAG_SET;
  /*
   * A SHORT OPTION CAN CARRY ITS VALUE GLUED ON, AND MISSING THAT MADE THIS
   * RAIL REFUSE ORDINARY COMMITS.
   *
   * `-mfix` is `-m fix`. The arity table only recognised the separated form, so
   * the glued message reached the cluster matchers -- and `-mfix` contains an
   * `f`, so it was refused as a FORCE flag on a subcommand that has no force
   * flag at all. Measured by blind audit:
   *
   *     git commit README.md -mfix      DENY "with a force or discard flag"
   *     git commit README.md -mguard    DENY "with an everything selector"
   *     git commit README.md -mtest     ALLOW
   *
   * That is "you cannot honestly describe a flag fix in its own commit"
   * returning in a different spelling, in the commit that claimed to repair it,
   * and the refusal named the wrong mechanism -- rule 18, from the inside.
   *
   * The short flags are DERIVED from the same arity table rather than listed
   * again, so a flag added there is handled in both spellings at once.
   */
  const shortValueFlags = [...takesValue].filter((f) => /^-[A-Za-z]$/.test(f));
  const out = [];
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--') break;
    if (takesValue.has(t)) { i += 1; continue; }
    // `-mfix`: the flag and its value in one token, so nothing follows to skip.
    if (shortValueFlags.some((f) => t.startsWith(f) && t.length > f.length)) continue;
    out.push(t);
  }
  return out;
}

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

  const parsed = tokenize(command);
  if (!parsed.balanced) {
    return { allowed: false, reason: 'the command contains an unbalanced quoted string' };
  }
  const tokenInfo = parsed.tokens;
  const tokens = tokenInfo.map((t) => t.value);

  /*
   * THE WRITE-FLAG CHECK MOVED BELOW THE TOKENIZER, AND IT HAD TO.
   *
   * MEASURED, NOT DERIVED, 2026-09-19. This ran against the raw command string
   * with a trailing `(=|\s|$)` anchor, and quoting the flag defeated it. The
   * attack is the one this file's own header uses to explain why the rail is
   * not a boundary -- `sort -o <file> <file>` rewrites a file in place with no
   * metacharacter and no suspicious argument. Both halves observed through the
   * shipped guard, one character apart:
   *
   *   sort -o   out in     DENY  "a flag that writes or reads a side file"
   *   sort '-o' out in     ALLOW  and the file was written; I read it back
   *
   * Same cause as the git selectors above and found by the same audit: a
   * pattern asked of the command TEXT when a tokenizer that strips quotes was
   * sitting eight lines below it.
   *
   * NO ARITY TABLE HERE, AND THAT IS THE DIFFERENCE FROM THE GIT CASE. This
   * applies to every approved command, so nothing can say whether a token is a
   * flag or some flag's value. It is therefore anchored per token and asks
   * nothing else -- `--output=x` carries its value inline and still matches.
   *
   * WHAT THE NARROWING COSTS, because per-token is strictly tighter than
   * substring-in-raw-string and that direction can open something. What it
   * stops catching is a write flag INSIDE a single quoted argument, such as
   * `echo "a -o b"` -- which writes nothing, and was a false refusal. For it to
   * be a real loss the flag would have to reach a program as part of one
   * argument, and a program that splits its own argument into flags is an
   * interpreter; every interpreter is already refused by the shape list, since
   * an interpreter builds its target at runtime and cannot be judged from the
   * command string at all.
   */
  const writeFlag = tokens.find(isWriteFlagToken);
  if (writeFlag) {
    return {
      allowed: false,
      reason: `"${writeFlag}" writes or reads a side file (-o, --output, --to-file, -f, --argfile, ...), `
        + 'so what it touches never appears as an argument to judge',
    };
  }
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
       * --force is checked explicitly here, and a leading `+` on a refspec is the
       * same thing spelled differently.
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
        /*
         * OPTIONS, NOT THE COMMAND TEXT. See GIT_SWEEP_TOKEN above.
         *
         * THE RAW-STRING TESTS ARE GONE RATHER THAN KEPT AS A FALLBACK, and
         * that is a deliberate narrowing which has to be argued for rather
         * than slipped in. The first version of this fix kept them with `||`,
         * reasoning that a union can only catch more. It does -- and the thing
         * it kept catching was the FALSE POSITIVE:
         * `git commit src/x.mjs -m "handle --force flag"` stayed refused,
         * because the raw string still contained `--force`. A union of a
         * correct check and a broken one is the broken one's behaviour
         * wherever the broken one fires, so the fallback had to go for the
         * repair to be a repair. Watched failing before it was removed.
         *
         * WHAT THE NARROWING COSTS, stated plainly: a selector that appears
         * somewhere other than an option position is no longer refused. The
         * two such positions are a flag's VALUE and everything after `--`, and
         * git says neither is an option -- so in both the old behaviour was
         * wrong, not merely broad. What remains is `.` as a bare operand, kept
         * below, and the pathspec resolver, which asks git what an operand
         * covers and is the real backstop for spellings nobody enumerated.
         */
        const options = gitOptionTokens(tokens, verb);
        if (options.some((t) => GIT_FORCE_TOKEN.test(t))) {
          return {
            allowed: false,
            reason: `"git ${verb}" with a force or discard flag overwrites the tree wholesale, `
              + 'including the guard source the hook re-reads on every call',
          };
        }
        const sweepsEverything = options.some((t) => GIT_SWEEP_TOKEN.test(t))
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
       * A COMMIT THAT NAMES NOTHING TAKES WHATEVER IS IN THE INDEX, INCLUDING
       * ANOTHER SESSION'S STAGING.
       *
       * The sweep check above closes the selectors -- `-a`, `--all`, `.` --
       * and it does not close the quiet one, because `git commit -m "msg"`
       * carries no selector at all. It records the index, and the index is
       * shared. CLAUDE.md has documented that hazard for as long as two agents
       * have worked one clone, and documenting it is all anything did: rule 17,
       * a control that is never consulted is not a control. The measured cost
       * is in that same file -- two sessions answering one question nine
       * minutes apart, and a collision guard that compares paths could not see
       * it because neither had declared any.
       *
       * `.git/index.lock` is not the answer and its existence is most of why
       * nobody looked for one: git holds it for ONE invocation, and the window
       * that bites spans the `add`, the other session's `add`, and the
       * `commit`.
       *
       * REFUSING THIS DOES NOT REFUSE THE WORKFLOW. The spelling that remains
       * allowed is the one this repository already mandates, and the
       * compliant shape never waits for anything -- naming the paths IS the
       * lock, scoped to those files and held for exactly one command. A
       * session lease over the index was designed and rejected for that
       * reason; see src/gitIndexLease.mjs.
       */
      if (verb === 'commit') {
        const fence = commitFence(tokens);
        if (fence.why === 'unnamed') {
          return {
            allowed: false,
            reason: '"git commit" with no pathspec records whatever is staged, and the index is '
              + 'shared with every other session in this clone -- one can stage between your `add` '
              + 'and your `commit`, and both halves land in your commit. Name what you are '
              + 'committing: git commit <path> [<path>...] -m "message"',
          };
        }
        /*
         * A SEPARATE REASON, BECAUSE IT IS A SEPARATE OBJECTION -- rule 15
         * asks a gate to name the half that is actually open.
         *
         * One string covered both refusals, so a caller who wrote
         * `git commit --amend README.md` was told there was "no pathspec".
         * README.md was right there; the real objection was `--amend`, and
         * the advice was to add something already present. Found by blind
         * audit, 2026-09-18.
         */
        if (fence.why === 'widened') {
          return {
            allowed: false,
            reason: '"git commit" with -a, --all, -i or --include is not bounded by the paths you '
              + 'name -- they sweep past them into the shared index -- and --amend rewrites a '
              + 'commit that already exists rather than recording what you named. Drop the flag '
              + 'and commit the paths on their own',
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
      /*
       * AND GIT ACCEPTS ANY UNAMBIGUOUS PREFIX OF A LONG OPTION, so matching the
       * full spelling matched almost none of them. Measured against the shipped
       * rail, 2026-09-18, every one of these was ALLOW and every one works:
       *
       *   git restore --pathspec-from=ps.txt        git add --pathspec-from=ps.txt
       *   git restore --pathspec-fro=ps.txt         git restore --pathspec-file-nu
       *
       *   $ printf 'src/claudeGuard.mjs\n' > ps.txt
       *   $ git restore --pathspec-from=ps.txt   -> exit 0, the edit is gone
       *
       * The commit that introduced the check called it "a closed set defined by
       * git's semantics, not a guess at spellings". The SET of flags is closed;
       * the set of SPELLINGS is open, and the check was written against the
       * spellings. That is the enumeration mistake the same commit message
       * claimed to be correcting, one paragraph earlier.
       *
       * So ask the rule instead of listing its outputs: git resolves a long
       * option by prefix, therefore any token that is a prefix of one of these
       * names IS one of these flags. An ambiguous prefix (--p) is refused too --
       * git would reject it as ambiguous anyway, and refusing is the direction
       * this check already fails in.
       */
      const PATHSPEC_FILE_FLAGS = ['--pathspec-from-file', '--pathspec-file-nul'];
      const pathspecFromFile = tokens.find((t) => {
        if (!t.startsWith('--')) return false;
        const name = t.split('=')[0];
        if (name === '--') return false;
        return PATHSPEC_FILE_FLAGS.some((full) => full.startsWith(name));
      });
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
      /*
       * A FLAG'S NAME DOES NOT DECIDE WHETHER IT TAKES A VALUE. THE VERB DOES.
       *
       * The first version of this was one flat regex containing -m, and it
       * OPENED A HOLE bigger than the over-block it closed. `-m` takes a message
       * for commit, but for restore, checkout and switch it is `--merge`, a
       * BOOLEAN -- so skipping "the value after -m" skipped the PATHSPEC, and
       * the named-path check below never saw it:
       *
       *   git restore -m src/claudeGuard.mjs      ALLOW   (was DENY before)
       *   git checkout -m src/claudeGuard.mjs     ALLOW
       *   git restore -m .claude/settings.json    ALLOW
       *
       * Confirmed against git, not just the parser: append a line to
       * src/claudeGuard.mjs, run `git restore -m src/claudeGuard.mjs`, the edit
       * is gone. That is precisely what the comment above says this check exists
       * to prevent. Found by blind audit, 2026-09-18, one commit after shipping.
       *
       * `-S` was wrong the same way and in both directions: --staged on restore
       * and --gpg-sign[=<key-id>] on commit, which takes an OPTIONAL value and so
       * never consumes the next token either. It was consuming operands for both.
       *
       * THE TABLE IS DERIVED FROM GIT, NOT REMEMBERED. `git <verb> -h` prints
       * `<...>` after exactly those flags that consume the next token, and
       * test/gitFlagArity.test.mjs regenerates this table from that output and
       * fails if the two disagree. So the rail stays pure and synchronous, and
       * git is still the thing that answers -- which is the only version of this
       * check that has ever survived an audit.
       *
       * AN UNLISTED VERB SKIPS NOTHING. Judging a flag value as a pathspec
       * over-blocks; skipping a pathspec lets a protected file be overwritten.
       * Those are not symmetric, so the default is the one that fails loudly.
       */
      /*
       * "--" ENDS THE FLAGS. EVERYTHING AFTER IT IS A PATHSPEC, INCLUDING
       * SOMETHING SPELLED LIKE A FLAG -- that is the entire purpose of "--".
       *
       * The skip loop walked every token and never stopped, so a value-taking
       * flag NAME appearing after "--" still consumed the token behind it, and
       * the token behind it was a real path:
       *
       *   git restore -- -s src/claudeGuard.mjs         ALLOW
       *   git restore -- --source src/claudeGuard.mjs   ALLOW
       *   git restore -- --conflict src/claudeGuard.mjs ALLOW
       *
       * Confirmed against real git: with a tracked file named "-s" present,
       * that first command exits 0 and reverts src/claudeGuard.mjs. And the
       * guard ALLOWED the whole setup chain too -- writing ./-s, adding it,
       * committing it -- so an attacker needs nothing it does not already have.
       *
       * The class predates the per-verb table (the old flat regex did the same
       * thing with -m), but the commit that introduced the table was the one
       * claiming to close "ask git what a flag means", and git's answer here is
       * that after "--" nothing is a flag at all.
       */
      const takesValue = GIT_FLAG_TAKES_VALUE[verb] ?? EMPTY_FLAG_SET;
      const operandTokens = [];
      let flagsEnded = false;
      for (let i = 2; i < tokens.length; i += 1) {
        if (tokens[i] === '--') { flagsEnded = true; continue; }
        // A flag spelled --opt=value carries its value inline and consumes nothing.
        if (!flagsEnded && takesValue.has(tokens[i])) { i += 1; continue; }
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
    /*
     * AND A FLAG CARRIES ITS VALUE AFTER AN `=`, WHERE THE FILTER COULD NOT SEE IT.
     *
     * The filter dropped every token starting with `-`, so the space form was
     * judged and the equals form was invisible:
     *
     *   npm test -- --import ./test/untracked.test.mjs    DENY
     *   npm test -- --import=./test/untracked.test.mjs    ALLOW
     *   npm test -- --require=./x   --test-reporter=./x   --experimental-loader=./x
     *
     * Every one of those is a node flag whose value is a MODULE NODE LOADS, so
     * the same execution the space form was hardened against went through in a
     * spelling one character away. Found by blind audit.
     *
     * NOT AN EXPLOIT TODAY, and the audit said so: this repository's test script
     * is `node --test "test/**\/*.test.mjs"`, and node treats everything after
     * the glob as a test-name pattern, so the loader flags were never honoured.
     * It is fixed anyway, because "harmless because of how the script happens to
     * be written today" is a property of package.json, not of the guard, and the
     * next person to edit that line will not know they were relying on it.
     *
     * THE RULE IS THE SHAPE, NOT A LIST OF FLAG NAMES. Enumerating --import,
     * --require, --experimental-loader and --test-reporter is the mistake this
     * file has lost to repeatedly; node adds loader flags. A flag that carries a
     * value carries it after the first `=`, and that value may be a path, so it
     * gets the same question every other operand gets.
     */
    const sep = tokens.indexOf('--');
    if (sep !== -1) {
      const forwarded = tokens.slice(sep + 1).flatMap((t) => {
        if (!t.startsWith('-')) return [t];
        const eq = t.indexOf('=');
        if (eq === -1) return [];
        const value = t.slice(eq + 1).replace(/^['"]|['"]$/g, '');
        return value === '' ? [] : [value];
      });
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
        /*
         * DO NOT OFFER AN ESCAPE THAT IS ALSO REFUSED.
         *
         * This said "Commit it first, or run it outside the repository". The
         * second half is false: a path outside the repo is not inherited either,
         * so it is refused by the same check. Measured -- /tmp/probe.mjs, an
         * absolute scratchpad path and ../probe.mjs are all DENY with this very
         * message, which then tells the reader to do the thing it just refused.
         *
         * An auditor spent part of a pass following that advice. It is the same
         * defect as the registration recipe no guarded session could execute,
         * and as rule 21 telling authors to run a clone command the rail
         * forbids: guidance whose audience is precisely the people it does not
         * work for. Found 2026-09-18, third instance in one day.
         */
        reason: `"${notInherited}" is not part of the repository this session inherited, so running it would `
          + 'execute code this session wrote -- which is how a guard gets disarmed in two calls. '
          + 'Commit it first; moving it outside the repository does not help, because a path that is '
          + 'not inherited is refused wherever it lives',
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
