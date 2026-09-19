/**
 * THE INDEX IS SHARED, AND A COMMIT THAT NAMES NOTHING TAKES ALL OF IT.
 *
 * CLAUDE.md has carried this hazard as advice for as long as the
 * two-agents-one-clone section has existed: "The index is shared and another
 * session can stage between your `add` and your `commit`." The advice is to
 * commit by pathspec. It is correct, it is free, and it is advice -- which
 * rule 17 is the whole file's answer to: a control that is never consulted is
 * not a control.
 *
 * `.git/index.lock` DOES NOT CLOSE THIS, and its existence is most of why
 * nobody did. git holds that lock for the duration of ONE invocation. The
 * window that bites spans two:
 *
 *     session A   git add src/a.mjs          index.lock taken and released
 *     session B   git add src/b.mjs          index.lock taken and released
 *     session A   git commit -m "..."        commits BOTH
 *
 * Every individual command was correctly serialised. The transaction was not,
 * because git did not know there was one.
 *
 * ── WHY A PATHSPEC AND NOT A LOCK ────────────────────────────────────────
 *
 * A session lease over the index was designed and rejected, and the reason is
 * worth keeping because the rejected design is the obvious one. A lease has to
 * be acquired, released, expired and stolen; the rail that would enforce it is
 * a JUDGE, and a judge that acquires state as a side effect of judging is a new
 * class of thing to get wrong. Every failure mode it adds -- a stale lease
 * wedging the clone, a steal racing a live holder, an expiry tuned wrong -- is
 * a failure this repository has already shipped in some other form.
 *
 * A pathspec needs none of it. Naming the paths IS the lock: scoped to exactly
 * those files, held for exactly the length of one command, released by the
 * process exiting, and impossible to leak. It cannot deadlock because it is
 * never held. Owner's call, 2026-09-18.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * A cooperation fence between agents that are all trying to do the right
 * thing, not a boundary against one that is not. Nothing here stops a session
 * that shells out some other way, and the rail's own header says it is fast
 * feedback rather than a security boundary. Claiming more for it would be the
 * hollow gate this project is named after.
 *
 * ── WHY IT IS A MODULE ───────────────────────────────────────────────────
 *
 * Rule 10. PURE -- no imports, no clock, no filesystem, no repository. The
 * wiring in src/shellAllowlist.mjs is a separate claim with its own tests,
 * because the wiring is what was missing the last three times a guard here was
 * found to be inert.
 *
 * ── THE FILENAME IS WRONG AND CANNOT BE FIXED FROM HERE ───────────────────
 *
 * This file was written for the lease design and should be called something
 * like `sharedIndex.mjs`. No guarded session can rename it: the rail refuses
 * `rm`, `Remove-Item` and `Move-Item`, and there is no structured tool that
 * deletes a file. The rename is a one-line job from a terminal and is in the
 * handoff. Recording that here rather than quietly leaving a misleading name
 * is the same judgement as the corrections kept visible in CLAUDE.md.
 */

/*
 * ═══ WHAT THIS FENCE DOES NOT COVER, AND WHY THE CODE FOR IT IS GONE ═══
 *
 * BLIND AUDIT FINDINGS D3 AND D5, 2026-09-18, and the second is the reason the
 * first existed.
 *
 * D5: `commit` is not the only subcommand that records the shared index.
 * `git rebase --continue`, `git cherry-pick --continue` and
 * `git revert --continue` all commit whatever is staged, and a bare `git stash`
 * removes another session's staged work from the tree -- the same hazard, and
 * louder. None of them is fenced. They are not in GIT_SWEEPS_TREE either, so
 * they get neither check.
 *
 * D3: this file shipped `INDEX_WRITERS`, `gitSubcommand` and `writesIndex` --
 * three exports that would identify exactly those verbs -- with NO PRODUCTION
 * CALLER. Tested, correct, consulted by nothing, in a file that is a protected
 * guard dependency. `gitSubcommand`'s own header lectured about the
 * `tokens[1]`-only mistake while the rail two files over read `tokens[1]`
 * directly. Rule 17, in the same commit whose message invoked rule 17.
 *
 * SO THEY ARE DELETED RATHER THAN WIRED, AND THAT IS THE ARGUABLE PART.
 * Extending the fence to those verbs would refuse `git rebase --continue`, and
 * there is NO compliant spelling of that -- you cannot name paths on it. A
 * refusal with no alternative is an outage, an outage gets the hook switched
 * off, and that loses every layer at once. So the honest position is that these
 * verbs stay unfenced and the residual is written down here, where the next
 * person to widen the fence will read it, rather than kept as dead code that
 * makes the gap look handled.
 *
 * The thing that would actually close D5 is a different control: `git stash`
 * and the `--continue` family are cheap to detect and expensive to refuse, so
 * they want a WARNING, and this rail only says allow or deny.
 *
 * `git --no-pager commit` and `git -C <dir> commit` -- the shapes `gitSubcommand`
 * existed to catch -- are already refused by GIT_POISON and by the approved-shape
 * default, verified through the shipped rail by the audit. Wiring it would have
 * risked LOOSENING that: a global option resolving to a GIT_WRITE verb enters
 * the write branch instead of falling through to deny.
 */

/**
 * Options of `git commit` that consume the token after them, so that token is
 * a value and not a pathspec.
 *
 * DERIVED FROM THE SAME SOURCE AS THE REST OF THE RAIL'S ARITY TABLE -- git's
 * own documented arity. The failure this prevents is the one the rail already
 * measured on `-m`: a message token read as an operand made `git commit -m
 * test` name test/claudeGuard.test.mjs, and a one-word commit message was
 * refused as if it were a protected path.
 *
 * `--gpg-sign` and `-S` take an OPTIONAL value, so the token after them may be
 * a pathspec. They are deliberately absent: treating them as consuming would
 * SWALLOW a real pathspec and turn a narrow commit into a wide one, which is
 * the direction that loses here. The cost of the other direction is that
 * `git commit -S <key> -m x` reads <key> as a pathspec and is permitted; a
 * permitted commit is not the failure this module exists to stop.
 */
const COMMIT_VALUE_SHORT = Object.freeze(['-m', '-F', '-C', '-c', '-t']);
const COMMIT_VALUE_LONG = Object.freeze([
  '--message', '--file', '--author', '--date', '--cleanup', '--template',
  '--reuse-message', '--reedit-message', '--squash', '--fixup',
  '--pathspec-from-file', '--trailer',
]);

/**
 * Does this token consume the one after it?
 *
 * PREFIXES RESOLVE HERE TOO, AND LEAVING THEM OUT WAS A MEASURED HOLE. The
 * commit that gave prefix resolution to `commitWidens` left this table an exact
 * alternation five lines above it, in the same function's support code -- so
 * git resolved `--messag` and ate the next token as the message, while this
 * did not and counted that token as a PATHSPEC. Measured through the shipped
 * rail by blind audit:
 *
 *     git commit --messag wip     ALLOWED, and it commits the whole index
 *     git commit --autho nobody   ALLOWED
 *     git commit -m wip           DENY, "no pathspec" -- the same command
 *
 * Every value-taking long option was affected: --messag, --autho, --dat, --fil,
 * --templat, --cleanu, --squas, --traile, --fixu and both --re*-message forms.
 *
 * THE ERROR DIRECTION IS DELIBERATE AND IS THE OPPOSITE OF commitWidens'. Over-
 * matching here SWALLOWS a token that might have been a pathspec, which refuses
 * a commit that named something -- an over-block with a compliant alternative.
 * Under-matching turns a flag's VALUE into a pathspec and lets the whole shared
 * index through, which is the hole this module exists to close. So a prefix
 * resolves, and the ambiguous ones resolve too, exactly as git would refuse
 * them.
 *
 * A GLUED VALUE CONSUMES NOTHING EXTRA. `-mfix` and `--message=x` carry their
 * value inside the token; only the separated form eats the next one.
 */
function commitTakesValue(token) {
  if (typeof token !== 'string') return false;
  if (token.includes('=')) return false;            // --opt=value is self-contained
  if (COMMIT_VALUE_SHORT.includes(token)) return true;
  if (token.length <= 2) return false;
  if (COMMIT_VALUE_LONG.some((f) => f.startsWith(token))) return true;
  return false;
}

/**
 * A short option with its value glued on, POSIX style: `-mfix` is `-m fix`.
 *
 * Measured as a FALSE REFUSAL introduced by the prefix commit: `-mfix` matched
 * the rail's force-cluster matcher and `-mguard` matched its sweep matcher, so
 * a glued one-word commit message was refused as a force flag -- and
 * `git commit` has no force flag at all. That is "you cannot honestly describe
 * a flag fix in its own commit" returning in a different spelling, inside the
 * commit that claimed to repair it, with a refusal naming the wrong mechanism.
 */
function commitGluesValue(token) {
  return typeof token === 'string'
    && COMMIT_VALUE_SHORT.some((f) => token.startsWith(f) && token.length > f.length);
}

/**
 * Flags that re-open the window a pathspec would have closed.
 *
 * `-a`/`--all` commits every tracked modification whether it was named or not.
 * `-i`/`--include` commits the named paths IN ADDITION TO whatever is already
 * staged, which is precisely the other session's work. `--amend` rewrites a
 * commit that already exists rather than recording the named paths.
 *
 * So a pathspec sitting next to any of them is not the narrow commit it looks
 * like, and accepting it would make the fence satisfiable by adding a file
 * name to the exact command that breaks it.
 */
const COMMIT_WIDEN_LONG = Object.freeze(['--all', '--include', '--amend']);

/*
 * A SHORT CLUSTER CARRIES ITS FLAGS TOGETHER. `-am`, `-ia`, `-qa` are all the
 * widening flag with company, and an exact alternation of `-a` and `-i` misses
 * every one of them.
 */
const COMMIT_WIDEN_SHORT = /^-[A-Za-z]*[ai][A-Za-z]*$/;

/**
 * Does this token widen the commit past the paths it names?
 *
 * GIT ACCEPTS ANY UNAMBIGUOUS PREFIX OF A LONG OPTION, AND THE FIRST VERSION OF
 * THIS MATCHED SPELLINGS INSTEAD OF THE RULE. `--amen` and `--includ` are the
 * same commands as `--amend` and `--include` to git, and neither matched an
 * exact alternation, so `git commit --amen README.md` was ALLOWED and amended.
 * Found by an independent audit hours after I shipped it.
 *
 * That is the enumeration mistake this repository has now made on four separate
 * matchers: the sweep spellings, the pathspec-file flags, the sweep selectors,
 * and this. Every time, the fix was to ask what the thing MEANS rather than how
 * it is written. Here the meaning is "a prefix git would resolve to one of
 * these", so that is what is asked.
 *
 * ERRING TOWARD REFUSAL IS CORRECT HERE AND IS NOT AN ACCIDENT. `--a` is a
 * prefix of both `--all` and `--amend`, so git itself calls it ambiguous and
 * refuses; matching it costs a caller nothing they could have run anyway. The
 * asymmetry runs the other way from rule 19's outage warning, because every
 * refusal here has a compliant alternative one word away -- drop the flag and
 * name the paths.
 */
function commitWidens(token) {
  if (typeof token !== 'string') return false;
  const name = token.split('=')[0];
  if (COMMIT_WIDEN_SHORT.test(name)) return true;
  // `--` alone is the pathspec separator, never an option.
  if (name.length <= 2) return false;
  return COMMIT_WIDEN_LONG.some((f) => f.startsWith(name));
}

/**
 * Judge a `git commit` against the shared index.
 *
 * @returns {{ok:boolean, why:'not-a-commit'|'named'|'unnamed'|'widened'}}
 *
 * TWO REASONS, NOT ONE, AND THE MESSAGE HAS TO SAY WHICH -- rule 15 asks a
 * gate to name the half that is still open. The first version returned a bare
 * boolean, so the rail told a caller that wrote
 * `git commit --amend README.md` there was "no pathspec". README.md was right
 * there; the real objection was `--amend`, and the advice was to add something
 * already present. Found by blind audit.
 *
 * THE WALK IS SINGLE-PASS BECAUSE THE TWO-PASS VERSION READ A MESSAGE AS A
 * FLAG. `COMMIT_WIDENS` was applied to every token before the arity walk knew
 * that `-m` consumes the next one, so `git commit src/x.mjs -m "-a"` was
 * refused as if `-a` had been passed. The function's own header warned about
 * exactly that class for the resolver and then committed it here -- the same
 * trap the raw-string selectors in shellAllowlist.mjs fell into, one file over
 * and on the same night. A value is skipped before anything is asked of it.
 */
export function commitFence(argv) {
  if (!Array.isArray(argv)) return { ok: false, why: 'not-a-commit' };
  const start = argv[0] === 'git' ? 1 : 0;
  const i = argv.indexOf('commit', start);
  if (i === -1) return { ok: false, why: 'not-a-commit' };
  const rest = argv.slice(i + 1).filter((t) => typeof t === 'string');

  /*
   * THE SEPARATOR IS FOUND DURING THE WALK, NEVER BEFORE IT, AND THE PRE-PASS
   * THAT USED TO FIND IT DEFEATED THIS ENTIRE FENCE IN THREE TOKENS.
   *
   * `rest.indexOf('--')` cannot tell a pathspec separator from a `--` that is
   * some option's VALUE. A commit message of exactly `--` is legal, so:
   *
   *     git commit -m -- --amend        ALLOWED, and git ran it as an amend
   *     git commit -m -- -i README.md   ALLOWED, include mode
   *
   * Measured through the shipped rail by blind audit and reproduced here: the
   * second token pair sets the "separator", everything after it is counted as a
   * pathspec, and no token is ever examined for widening. The function header
   * above claims the walk is single-pass precisely to avoid reading a value as
   * a flag -- and the pre-pass was a second pass doing exactly that, in the
   * opposite direction. shellAllowlist's two loops already consult the arity
   * table before honouring `--`; this one did not.
   *
   * So the arity table is asked FIRST, every time. A token that is some
   * option's value is consumed and never inspected -- not as a flag, not as a
   * separator, not as a pathspec. Only a `--` the walk actually reaches is the
   * separator, and after it git says nothing is an option, so a file named
   * `-a` is a path rather than a sweep.
   */
  let widened = false;
  let named = false;
  let j = 0;
  for (; j < rest.length; j += 1) {
    const t = rest[j];
    if (commitTakesValue(t)) { j += 1; continue; }   // its value is not anything else
    if (commitGluesValue(t)) continue;               // `-mfix`: flag and value in one token
    if (t === '--') { j += 1; break; }               // the real separator
    if (t.startsWith('-')) {
      // `--opt=value` and `-mfix` carry their value inside the token.
      if (commitWidens(t)) widened = true;
      continue;
    }
    if (t.trim() !== '') named = true;               // a bare operand
  }
  for (; j < rest.length; j += 1) {
    if (rest[j].trim() !== '') named = true;         // past the separator: all pathspec
  }

  /*
   * WIDENED BEATS NAMED. `-i`/`--include` commits the named paths IN ADDITION
   * TO whatever is already staged, `-a` commits every tracked modification,
   * and `--amend` rewrites a commit that already exists. If a pathspec were
   * enough on its own, the fence would be satisfiable by adding a file name to
   * the exact command that breaks it.
   */
  if (widened) return { ok: false, why: 'widened' };
  return named ? { ok: true, why: 'named' } : { ok: false, why: 'unnamed' };
}
