/**
 * ONE QUOTE CHARACTER DEFEATED THE SWEEP SELECTOR.
 *
 * MEASURED THROUGH THE SHIPPED RAIL, 2026-09-18, by a blind audit and then
 * reproduced by the author before it was believed. Two commands, both harmless
 * dry runs, one character apart:
 *
 *     git add --dry-run -A      DENY   "an everything selector reaches every
 *                                       dirty file, protected ones included"
 *     git add --dry-run '-A'    ALLOW  exit 0
 *
 * `git add '-A'` stages every dirty file, every protected guard control
 * included, and the rail said nothing.
 *
 * THE CAUSE IS ONE LINE DISAGREEING WITH ITSELF. `GIT_SWEEP_SELECTOR` was
 * tested against the RAW COMMAND STRING with a trailing `(\s|$)` anchor; in
 * `'-A'` the next character is a quote, so the pattern never matched. The
 * tokenizer had stripped quotes since the day it was written -- and the
 * stripped values were used one line below, for the `=== '.'` comparison, and
 * nowhere else. Two halves of one check, disagreeing about quoting, for as
 * long as both existed.
 *
 * THIS IS `git restore :/` AGAIN, ONE LAYER DOWN. That was a spelling of
 * "everything" nobody enumerated and the answer was to ask git what a pathspec
 * covers. This is a spelling of `-A` nobody enumerated and the answer is the
 * same move: stop matching the command TEXT, ask the structure that already
 * owns the question.
 *
 * AND THE SAME DEFECT FIRED IN THE OTHER DIRECTION, which is why the fix is a
 * repair rather than a tightening -- see the last test in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const judge = (c) => judgeShellCommand(c, { pathspecCovers: () => [] });

/**
 * QUOTING IS GENERATED, NOT ENUMERATED -- rule 7, and rule 8's warning that a
 * probe bounds nothing. The audit found ONE spelling. Listing that spelling
 * would fix the five strings the prober happened to try; the property is that
 * quoting an argument must not change a verdict, for ANY quoting of ANY
 * selector, so the fixtures are built from the selector list and the quote
 * characters rather than typed out.
 */
const QUOTES = ['', "'", '"'];

/*
 * `-U` IS NOT IN THIS LIST, AND FINDING OUT WHY IS THE POINT OF GENERATING IT.
 *
 * It was, on the first run, because the raw-string selector matches any
 * single-dash cluster containing `a`, `A`, `u` or `U` and I copied that reading
 * across. The arity table in shellAllowlist.mjs says otherwise: `-U` on `add`
 * is `--unified`, a diff-context flag that takes a value, not `--update`. So
 * `git add -U 3` was being refused as a sweep and never was one.
 *
 * The fixture was wrong, not the code -- which is the whole reason to ask the
 * table rather than restate what a regex appeared to mean.
 */
/*
 * PREFIXES AND CLUSTERS ARE IN THE LIST BECAUSE GIT TREATS THEM AS THE FLAG.
 *
 * git resolves any unambiguous prefix of a long option, so `--al` IS `--all`
 * and `--forc` IS `--force`, and a short cluster carries its flags together, so
 * `-qf` IS force. An independent audit found all three classes walking past the
 * token-anchored matchers within hours of my writing them -- the second
 * enumeration mistake on the same two lines in one night.
 */
const SWEEPS = ['-A', '-a', '-u', '--all', '--update', '-am', '-Av', '--al', '--up', '--upd', '-qa', '-vu'];
/*
 * THE DIGIT SPELLINGS ARE HERE BECAUSE git PRINTS THEM AS ALIASES.
 *
 * `git checkout -h` and `git restore -h` both list `-2, --ours` and
 * `-3, --theirs`. `--ours` was in the force list spelled out while its
 * one-character alias was invisible, and a cluster containing a digit escaped
 * both matchers entirely -- the classes were `[A-Za-z]` only.
 *
 * The sharp one was `-f2`: measured ALLOWED, and the refusal that followed came
 * from GIT ("--ours/--theirs, --force and --merge are incompatible"), not from
 * us. `--force` reached git through a token the force matcher could not see,
 * and git happened to reject the combination. A refusal from the far end is not
 * this rail working -- rule 18.
 */
const FORCES = ['-f', '--force', '--hard', '--theirs', '--ours', '--discard-changes',
  '--forc', '--har', '--thei', '--discard', '-qf', '-fq',
  '-2', '-3', '-f2', '-2q', '-q3'];

/* ── the positive, first ──────────────────────────────────────────────── */

test('THE POSITIVE FIRST: naming a path is still allowed, quoted or not', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a rail that denies everything,
   * and a rail that denies everything gets switched off inside an hour --
   * which loses every layer at once, not just this one.
   */
  for (const q of QUOTES) {
    const v = judge(`git add ${q}src/collect.mjs${q}`);
    assert.equal(v.allowed, true, `a named path was refused when quoted with ${q || 'nothing'}: ${v.reason}`);
  }
  assert.equal(judge('git commit src/collect.mjs -m "a message"').allowed, true,
    'the mandated commit spelling was refused');
});

/* ── the defect ───────────────────────────────────────────────────────── */

test('QUOTING A SWEEP SELECTOR DOES NOT CHANGE THE VERDICT', () => {
  /*
   * The bare form is asserted alongside the quoted one deliberately. If the
   * matcher were ever removed entirely, a test that only checked the quoted
   * spelling would report the bug as fixed -- both spellings would be allowed
   * and the assertion would be about agreement rather than about refusal.
   */
  for (const verb of ['add', 'commit', 'restore', 'checkout', 'switch']) {
    for (const sel of SWEEPS) {
      for (const q of QUOTES) {
        const v = judge(`git ${verb} ${q}${sel}${q}`);
        assert.equal(
          v.allowed, false,
          `git ${verb} ${q}${sel}${q} was ALLOWED -- a sweep reaches every protected `
            + 'control without naming one',
        );
      }
    }
  }
});

test('QUOTING A FORCE FLAG DOES NOT CHANGE THE VERDICT EITHER', () => {
  /*
   * Not executed against a real repository anywhere: demonstrating
   * `git restore --force` for real destroys another session's uncommitted
   * work in this shared clone, which is the hazard, not the proof. The audit
   * that found the sweep case said the same and declined for the same reason.
   */
  for (const verb of ['restore', 'checkout', 'switch']) {
    for (const sel of FORCES) {
      for (const q of QUOTES) {
        const v = judge(`git ${verb} ${q}${sel}${q} a-branch`);
        assert.equal(v.allowed, false, `git ${verb} ${q}${sel}${q} was ALLOWED`);
      }
    }
  }
});

test('AND THE REFUSAL IS THE SWEEP REFUSAL, not some other layer saying no', () => {
  /*
   * Rule 18. A quoted token could be refused by the unbalanced-quote check,
   * by WRITE_FLAGS, or by the protected-path walk, and any of those would make
   * this file green while the sweep check stayed blind. Name the mechanism.
   */
  const v = judge("git add '-A'");
  assert.equal(v.allowed, false);
  assert.match(v.reason, /everything selector/,
    `the quoted sweep was refused by something else: ${v.reason}`);
});

/* ── the other direction, which is the same cause ─────────────────────── */

test('A SELECTOR INSIDE A COMMIT MESSAGE IS NOT A SELECTOR', () => {
  /*
   * The raw-string test matched a flag quoted inside the MESSAGE, so you could
   * not honestly describe a flag change in the commit that made it:
   *
   *   git commit src/x.mjs -m "handle --force flag"   -> DENY
   *
   * That is the same defect wearing the opposite sign, and it is why this
   * change is a repair rather than a tightening. The arity table this file
   * already maintains says `-m` consumes the next token, so a message is never
   * examined as an option.
   */
  for (const msg of ['handle --force flag', 'close the -A sweep', 'stop --hard resets',
    'document -am', 'fix --all handling', 'the --theirs case']) {
    const v = judge(`git commit src/collect.mjs -m "${msg}"`);
    assert.equal(v.allowed, true,
      `a commit message describing a flag was refused as if it were one: ${msg} -- ${v.reason}`);
  }
});

test('A MESSAGE THAT IS EXACTLY A SELECTOR IS STILL A MESSAGE', () => {
  /*
   * RULE 11, AND THIS TEST EXISTS BECAUSE A MUTATION WENT GREEN.
   *
   * Deleting the flag-value skip from `gitOptionTokens` changed NOTHING in the
   * suite. The reason is that the tokenizer hands back a whole quoted message
   * as one token -- `handle --force flag` -- and the token patterns are
   * ANCHORED, so a selector embedded in a longer string never matched anyway.
   * The value skip was redundant for every fixture I had written.
   *
   * Redundant today is not redundant tomorrow, and "untested because currently
   * redundant" is how a protection quietly stops being one. The value skip
   * stops being a no-op exactly here: when the message IS the selector,
   * character for character. Without it, `-m "-a"` reads as `git commit -a`.
   *
   * The same trap is live one file over -- the audit found `COMMIT_WIDENS` in
   * src/gitIndexLease.mjs applying its flag test before the arity walk, so a
   * message of exactly `-a` is read as a widening flag there. That one is not
   * fixed here; it is in the handoff. This test at least stops the sweep half
   * from regressing silently.
   */
  for (const msg of ['-a', '-A', '--all', '--force', '--hard', '-am', '--update']) {
    const v = judge(`git commit src/collect.mjs -m "${msg}"`);
    assert.equal(v.allowed, true,
      `a commit message of exactly "${msg}" was read as the flag it names: ${v.reason}`);
  }
});

test('BUT A REAL SELECTOR BESIDE A MESSAGE STILL DIES', () => {
  /*
   * The obvious way to get the test above passing is to stop looking at
   * anything after `-m`, or at any commit with a message at all. Both would
   * reopen the sweep. This is the control for that.
   */
  for (const cmd of [
    'git commit -a -m "an honest message"',
    'git commit -am "an honest message"',
    "git commit '-a' -m \"an honest message\"",
    'git add -A --dry-run',
    "git add '-A' --dry-run",
  ]) {
    assert.equal(judge(cmd).allowed, false, `ALLOWED: ${cmd}`);
  }
});

test('AFTER `--` NOTHING IS AN OPTION, which is git\'s own rule', () => {
  // A file legitimately named `-A` is a path. git says so; so do we.
  const v = judge('git add -- -A');
  assert.equal(v.allowed, true, `a path after the separator was read as a sweep: ${v.reason}`);
});

/* ── the third and fourth spellings, both measured ────────────────────── */

test('A SHORT WRITE FLAG CARRIES ITS VALUE GLUED, and that wrote a file', () => {
  /*
   * MEASURED THROUGH THE SHIPPED RAIL, then reproduced by the author:
   *
   *     sort -o<path> <input>      ALLOWED, exit 0, and the bytes were read back
   *     sort '-o' <path> <input>   DENY
   *     sort -o <path> <input>     DENY
   *
   * `-o<FILE>` is the canonical POSIX short-option form and exactly what GNU
   * sort documents. The matcher accepted the flag alone and the `=` form --
   * the two spellings I thought of. Third enumeration on this line in two days.
   *
   * This is the attack shellAllowlist's own header uses to explain why the rail
   * is not a boundary: `sort -o package.json package.json` rewrites a file in
   * place with no metacharacter and no suspicious-looking argument.
   */
  for (const flag of ['-o', '-f']) {
    for (const glued of ['out.txt', 'src/claudeGuard.mjs', '=out.txt']) {
      const v = judge(`sort ${flag}${glued} input.txt`);
      assert.equal(v.allowed, false, `sort ${flag}${glued} was ALLOWED -- it writes a side file`);
      assert.match(v.reason, /writes or reads a side file/,
        `${flag}${glued} was refused by something other than the write-flag check`);
    }
  }
  // The separated and quoted forms stay closed too.
  for (const spelling of ['-o out.txt', "'-o' out.txt", '--output=out.txt', '--output out.txt']) {
    assert.equal(judge(`sort ${spelling} input.txt`).allowed, false, `sort ${spelling} was ALLOWED`);
  }
});

test('BUT AN ORDINARY ARGUMENT IS NOT A WRITE FLAG', () => {
  /*
   * Rule 5, and the direction that gets a rail switched off. Refusing every
   * token starting with a dash would satisfy the test above.
   */
  for (const cmd of ['sort input.txt', 'grep -i pattern file.txt', 'ls -la',
    'head -n 5 file.txt', 'git status', 'wc -l file.txt']) {
    assert.equal(judge(cmd).allowed, true, `ordinary work was refused: ${cmd}`);
  }
});

test('git HAS A SECOND SPELLING OF THE EVERYTHING SELECTOR, and it is a negation', () => {
  /*
   * ASKED OF GIT, NOT DERIVED. `git add -h` prints
   *     --[no-]ignore-removal   ... (same as --no-all)
   * so the NEGATED form is `--all`. Behavioural control from the audit: a bare
   * dry-run add, `--no-all`, `--ignore-removal` and `--renormalize` all print
   * "Nothing specified, nothing added"; `--no-ignore-removal` prints nothing,
   * meaning git took the implicit whole-tree pathspec exactly as for `-A`.
   *
   * It was ALLOWED, and so was its abbreviation. git's `--[no-]` convention was
   * simply outside the model, and the pathspec resolver is no backstop here
   * because there is no operand to resolve.
   */
  for (const spelling of ['--no-ignore-removal', '--no-ignore-rem', '--no-ignore']) {
    const v = judge(`git add ${spelling}`);
    assert.equal(v.allowed, false, `git add ${spelling} was ALLOWED -- it is --all`);
    assert.match(v.reason, /everything selector/,
      `${spelling} was refused by a different layer than the sweep check`);
  }
});

test('AND THE OPPOSITE FLAG STAYS ALLOWED, because it is the opposite', () => {
  /*
   * `--no-all` is what `--ignore-removal` means; it NARROWS. Refusing it would
   * be the over-block, and it is not a prefix of the entry above, so the prefix
   * rule leaves it alone. Verified through the real git as well: it prints
   * "Nothing specified, nothing added".
   */
  for (const spelling of ['--no-all', '--ignore-removal', '--renormalize']) {
    assert.equal(judge(`git add ${spelling}`).allowed, true,
      `git add ${spelling} was refused, but it narrows rather than sweeps`);
  }
});

test('THE CONTROL: this file can actually fail', () => {
  /*
   * Rule 1, held permanently rather than watched once. Every assertion above
   * is satisfied by a `judge` that returns a constant, so one of each verdict
   * is demanded here from the real rail.
   */
  assert.equal(judge('git status').allowed, true, 'the rail refuses everything');
  assert.equal(judge('git add -A').allowed, false, 'the rail allows everything');
});
