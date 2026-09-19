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
const COMMIT_TAKES_VALUE = /^(-m|-F|-C|-c|-t|--message|--file|--author|--date|--cleanup|--template|--reuse-message|--reedit-message|--squash|--fixup|--pathspec-from-file|--trailer)$/;

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
const COMMIT_WIDENS = /^(-a|--all|-i|--include|--amend|-[A-Za-z]*[ai][A-Za-z]*)$/;

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
   * EVERYTHING AFTER `--` IS A PATHSPEC AND NOTHING BEFORE IT IS WIDENED BY
   * ACCIDENT. git's own rule, and the rail already applies it elsewhere: after
   * the separator nothing is a flag at all, so a file legitimately named `-a`
   * is a path rather than a sweep.
   */
  const sep = rest.indexOf('--');
  const head = sep === -1 ? rest : rest.slice(0, sep);

  let widened = false;
  let named = false;
  for (let j = 0; j < head.length; j += 1) {
    const t = head[j];
    if (COMMIT_TAKES_VALUE.test(t)) { j += 1; continue; }   // a value, not a flag
    if (t.startsWith('-')) {
      // `--opt=value` carries its value inline and consumes nothing after it.
      if (COMMIT_WIDENS.test(t)) widened = true;
      continue;
    }
    if (t.trim() !== '') named = true;                      // a bare operand
  }
  if (sep !== -1 && rest.slice(sep + 1).some((t) => t.trim() !== '')) named = true;

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
