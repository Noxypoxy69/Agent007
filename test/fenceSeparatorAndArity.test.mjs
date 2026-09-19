/**
 * THREE TOKENS DEFEATED THE SHARED-INDEX FENCE, AND THE THIRD WAS `--`.
 *
 * Measured through the shipped rail by a blind audit and reproduced by the
 * author before it was believed. git printed the amend's own staged list:
 *
 *     git commit --dry-run -m -- --amend
 *       Changes to be committed:
 *         (use "git restore --source=HEAD^1 --staged <file>..." to unstage)
 *
 * `--source=HEAD^1` is git telling you it is amending. The fence saw nothing.
 *
 * THE CAUSE WAS A PRE-PASS THAT COULD NOT TELL A SEPARATOR FROM A VALUE.
 * `rest.indexOf('--')` ran over the raw token list before the arity walk. A
 * commit message of exactly `--` is legal, so `-m --` put the "separator" at
 * index 1; everything after it counted as a pathspec and NOTHING was ever
 * examined for widening. The function's own header claimed the walk was
 * single-pass precisely to stop a value being read as a flag -- and the
 * pre-pass was a second pass doing that in reverse, five lines above it.
 *
 * ALL FOUR DEFECTS IN THIS FILE ARE THE SAME MISTAKE: a question asked of a
 * token before asking the arity table what that token IS. The rail's own
 * operand walk already gets this right, which is what makes it a mistake
 * rather than an unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { commitFence } from '../src/gitIndexLease.mjs';
import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const argv = (s) => s.split(' ');
const judge = (c) => judgeShellCommand(c, { pathspecCovers: () => [] });

/* ── the separator ────────────────────────────────────────────────────── */

test('A `--` THAT IS A FLAG VALUE IS NOT THE PATHSPEC SEPARATOR', () => {
  /*
   * The measured bypass, and the three shapes around it. Every one of these
   * has a `--` consumed by `-m`, so the tokens after it are ordinary options
   * and must be judged as such.
   */
  assert.equal(commitFence(argv('git commit -m -- --amend')).why, 'widened',
    'an amend hidden behind a message of "--" was not seen');
  assert.equal(commitFence(argv('git commit -m -- -i README.md')).why, 'widened',
    'include mode hidden behind a message of "--" was not seen');
  assert.equal(commitFence(argv('git commit -m -- -a')).why, 'widened');
  // And with no pathspec anywhere, it is still unnamed rather than named.
  assert.equal(commitFence(argv('git commit -m --')).why, 'unnamed',
    'a message of "--" manufactured a pathspec out of nothing');
});

test('BUT A REAL SEPARATOR STILL SEPARATES, or the fix broke git\'s own rule', () => {
  /*
   * Rule 5. Refusing every `--` would satisfy the tests above and break the
   * documented way to commit a file whose name looks like an option.
   */
  assert.equal(commitFence(argv('git commit -m msg -- README.md')).why, 'named');
  assert.equal(commitFence(argv('git commit -- README.md')).why, 'named');
  // A file legitimately named `-a`, after the separator, is a path.
  assert.equal(commitFence(argv('git commit -m msg -- -a')).why, 'named');
});

test('THE SEPARATOR IS THE FIRST ONE THE WALK REACHES, not the first in the list', () => {
  // `-m` eats the first `--`; the second is the real separator.
  assert.equal(commitFence(argv('git commit -m -- -- README.md')).why, 'named');
});

/* ── prefixed value-taking options ────────────────────────────────────── */

test('A PREFIXED VALUE-TAKING OPTION EATS ITS VALUE, so the value is not a pathspec', () => {
  /*
   * git resolves `--messag` to `--message` and swallows the next token. The
   * arity table did not, so it counted that token as a PATHSPEC and let a
   * commit of the entire shared index through. Measured:
   *
   *     git commit --messag wip     ALLOWED  ("nothing to commit, working tree clean")
   *     git commit --autho nobody   ALLOWED  (git complained about the author format)
   *     git commit -m wip           DENY     the identical command to git
   *
   * The commit that introduced this was titled "the prefix was the next one,
   * on the same two lines". It fixed two lines and left this one.
   */
  for (const cmd of ['git commit --messag wip', 'git commit --autho nobody',
    'git commit --dat today', 'git commit --fil notes.txt', 'git commit --templat t.txt',
    'git commit --cleanu strip', 'git commit --squas abc123', 'git commit --fixu abc123']) {
    assert.equal(commitFence(argv(cmd)).why, 'unnamed',
      `${cmd} -- the option's value was counted as a pathspec`);
  }
});

test('AND THE FULL SPELLINGS STILL BEHAVE, so the prefix rule did not replace them', () => {
  assert.equal(commitFence(argv('git commit --message wip')).why, 'unnamed');
  assert.equal(commitFence(argv('git commit --message wip README.md')).why, 'named');
  // `--opt=value` is self-contained and consumes nothing after it.
  assert.equal(commitFence(argv('git commit --message=wip README.md')).why, 'named');
  assert.equal(commitFence(argv('git commit --messag=wip')).why, 'unnamed');
});

/* ── glued short values, which were an OVER-block ─────────────────────── */

test('A GLUED SHORT VALUE IS A VALUE, NOT A CLUSTER OF FLAGS', () => {
  /*
   * THE DIRECTION THAT GETS A RAIL SWITCHED OFF. `-mfix` is `-m fix`, and the
   * cluster matchers read it as flags: the `f` made it a FORCE flag on a
   * subcommand that has no force flag at all, and the `i` made it a widening
   * flag. So an ordinary one-word commit message was refused, with a reason
   * naming a mechanism that does not apply -- "you cannot honestly describe a
   * flag fix in its own commit", returning inside the commit that claimed to
   * repair it.
   */
  for (const msg of ['fix', 'guard', 'update', 'test', 'all', 'amend', 'include']) {
    assert.equal(commitFence(argv(`git commit README.md -m${msg}`)).why, 'named',
      `a glued message "-m${msg}" was read as the flags its letters spell`);
  }
});

test('THE GLUED FORM DOES NOT LAUNDER A REAL FLAG BESIDE IT', () => {
  /*
   * The control for the test above: skipping a glued value must not skip the
   * NEXT token, and must not make a genuine sweep invisible.
   */
  assert.equal(commitFence(argv('git commit README.md -mfix -a')).why, 'widened');
  assert.equal(commitFence(argv('git commit README.md -a -mfix')).why, 'widened');
  assert.equal(commitFence(argv('git commit -mfix')).why, 'unnamed',
    'a glued message manufactured a pathspec');
});

/* ── the wiring, because the module is not the rail ───────────────────── */

test('THE RAIL CARRIES ALL FOUR, and names the right mechanism for each', () => {
  /*
   * Rule 17: the wiring is a separate claim. And rule 18 -- each refusal has
   * to come from the check that owns it, or a later fix will "close" a hole
   * that a different layer was quietly covering.
   */
  const amend = judge('git commit -m -- --amend');
  assert.equal(amend.allowed, false, 'the rail still allows the separator bypass');
  assert.match(amend.reason, /--amend/, 'the refusal does not name the flag it objects to');

  const messag = judge('git commit --messag wip');
  assert.equal(messag.allowed, false, 'the rail still allows a prefixed value-taking option');
  assert.match(messag.reason, /no pathspec/);

  const glued = judge('git commit README.md -mfix');
  assert.equal(glued.allowed, true, `a glued one-word message was refused: ${glued.reason}`);

  // And the mandated spelling is untouched throughout.
  assert.equal(judge('git commit src/a.mjs -m "handle --force flag"').allowed, true);
});

test('THE CONTROL: these assertions can actually fail', () => {
  /*
   * Rule 1, held permanently. Every test above is satisfied by a function that
   * returns 'widened' for everything, and most by one returning 'named'. One
   * of each verdict is demanded here.
   */
  assert.equal(commitFence(argv('git commit README.md -m msg')).why, 'named');
  assert.equal(commitFence(argv('git commit -m msg')).why, 'unnamed');
  assert.equal(commitFence(argv('git commit -a README.md -m msg')).why, 'widened');
  assert.equal(commitFence(argv('git status')).why, 'not-a-commit');
});
