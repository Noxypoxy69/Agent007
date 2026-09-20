/**
 * `npm test --prefix <anywhere>` WAS ARBITRARY CODE EXECUTION IN ONE CALL.
 *
 * The node branch of this rail was hardened over five rounds so that a
 * session cannot execute a file it wrote itself: the file must be tracked and
 * unmodified first. CLAUDE.md records the one remaining hole -- `npm test`
 * expands its glob inside node, so an untracked file in `test/` runs unjudged
 * -- and calls it the boundary of the model.
 *
 * This was a second hole, and a worse one, because the payload did not have
 * to be in the repository at all:
 *
 *     npm test --prefix C:/anywhere      ALLOW      <- measured, end to end
 *
 * npm resolves package.json relative to --prefix and runs THAT file's script
 * in THAT directory. No commit, no metacharacter, no `--`, one call.
 *
 * It reached that verdict because the branch judged `tokens[1]` and then
 * inspected only the tokens after a literal `--`. `--prefix` is not `--`, so
 * the scan never ran.
 *
 * ═══ AND A PRIOR AUDIT RECORDED THE OPPOSITE ═══
 *
 * docs/GUARD_FINDINGS_2026-09-17_fixer.md:94 states that npm "fails CLOSED
 * (`npm --prefix /elsewhere ...`)". It failed open, and it failed open when
 * that sentence was written. That is the worst state for a control: a
 * document asserting it holds, so nobody looks again. This file exists so the
 * next reader does not have to take anybody's word for it.
 *
 * Found by a blind auditor that had been sent to a clone it could not reach,
 * went looking for any way to run anything at all, and found this instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const allowed = (cmd) => judgeShellCommand(cmd).allowed;

test('AN ABBREVIATION IS A SPELLING, and npm expands them', () => {
  /*
   * THE FIRST VERSION OF THIS FIX WAS ONE CHARACTER FROM OPEN, and its own
   * comment claimed it was "routed on shape, not a roster of names". It was a
   * roster of three names. npm's parser expands unambiguous abbreviations and
   * says so out loud -- "Expanding --prefi to --prefix" -- so:
   *
   *   npm ls   --prefix C:/x     DENY
   *   npm test --prefi  C:/x     ALLOW      <- measured, same execution
   *
   * Hollow gate 8 shipped inside the commit that cited hollow gate 8. Found
   * by the auditor of that commit.
   *
   * GENERATED FROM THE FLAG NAME, not typed: every prefix of every
   * redirecting flag, so a new redirect added to the list arrives with its
   * abbreviations already covered.
   */
  for (const full of ['prefix', 'cwd']) {
    for (let n = 1; n <= full.length; n += 1) {
      const abbrev = `--${full.slice(0, n)}`;
      assert.equal(allowed(`npm test ${abbrev} C:/anywhere`), false,
        `ARBITRARY EXECUTION via abbreviation: npm test ${abbrev} C:/anywhere`);
      assert.equal(allowed(`npm test ${abbrev}=C:/anywhere`), false,
        `ARBITRARY EXECUTION via abbreviation: npm test ${abbrev}=C:/anywhere`);
    }
  }
  /* Case, because npm's config keys are case-insensitive in practice. */
  assert.equal(allowed('npm test --PREFIX C:/x'), false);
  assert.equal(allowed('npm test --Prefi C:/x'), false);
});

test('THE ESCAPE IS CLOSED, in every spelling of the redirect', () => {
  /*
   * Rule 8: fix the matcher, not the string the prober happened to try.
   * `-C` is npm's own alias and the `=` form is the spelling that has slipped
   * past filters in this file more than once, so both are generated here
   * rather than hoped for.
   */
  const dirs = ['C:/anywhere', '"C:/with space/x"', '../..', '.', '~/elsewhere'];
  const flags = ['--prefix', '--cwd', '-C'];
  for (const verb of ['test', 'run build', 'ci', 'install']) {
    for (const flag of flags) {
      for (const dir of dirs) {
        for (const cmd of [`npm ${verb} ${flag} ${dir}`, `npm ${verb} ${flag}=${dir}`]) {
          assert.equal(allowed(cmd), false, `ARBITRARY EXECUTION: ${cmd}`);
        }
      }
    }
  }
});

test('THE REDIRECT IS REFUSED WHEREVER IT SITS, not only where it was first seen', () => {
  /*
   * Position mattered in the original bug -- the branch stopped looking at a
   * literal `--`. So the flag is tried before the verb's other arguments,
   * after them, and on the far side of a `--`.
   */
  for (const cmd of [
    'npm --prefix C:/x test',
    'npm test --prefix C:/x',
    'npm run build --prefix C:/x',
    'npm test --silent --prefix C:/x',
    'npm test -- --prefix C:/x',
  ]) {
    assert.equal(allowed(cmd), false, `the redirect escaped at this position: ${cmd}`);
  }
});

test('THE REFUSAL NAMES THE MECHANISM AND THIS LAYER (rule 18)', () => {
  /*
   * A refusal a reader cannot attribute is indistinguishable from the
   * auto-mode classifier, and three sessions once scored a dead guard as
   * working for exactly that reason.
   */
  const v = judgeShellCommand('npm test --prefix C:/anywhere');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /relocates where npm resolves/);
  assert.match(v.reason, /arbitrary execution/);
});

test('THE POSITIVE CONTROL: ordinary npm still works, or this is an outage', () => {
  /*
   * RULE 19, AND IT IS NOT DECORATION. An over-block here gets the hook
   * switched off, and then every layer is lost at once -- the failure mode
   * that cost this repository a real deletion. A refusal that also refused
   * `npm test` would satisfy every assertion above perfectly.
   */
  for (const cmd of ['npm test', 'npm run build', 'npm ci', 'npm install', 'npm test -- test/a.test.mjs']) {
    assert.equal(allowed(cmd), true, `ORDINARY npm WAS REFUSED, which is the outage: ${cmd}`);
  }
});

test('A FLAG THAT MERELY CONTAINS THE LETTERS IS NOT A REDIRECT', () => {
  /*
   * The other direction of rule 8: a matcher that is too eager is an outage
   * wearing a fix. `--prefer-offline` starts with the same five characters as
   * `--prefix` up to the x, and `-c` is not `-C`.
   */
  for (const cmd of [
    'npm install --prefer-offline',
    'npm test --color',
    'npm run build --config x',
    'npm install --production',
    'npm test --coverage',
    'npm ci --cache C:/x',
  ]) {
    assert.equal(allowed(cmd), true, `an unrelated flag was caught by the redirect matcher: ${cmd}`);
  }
});

test('THE MATCHER CANNOT BE OUT-SPELLED, and it is asked rather than enumerated', () => {
  /*
   * The property, stated directly: a token is a redirect if its name is a
   * PREFIX of a redirecting flag's name. That is what npm's own expansion
   * does, so it cannot be defeated by a spelling nobody here thought of --
   * which is the failure both previous versions of this matcher had.
   *
   * Both directions, because a matcher that says yes to everything would
   * satisfy the abbreviation test above perfectly.
   */
  const isRedirect = (flag) => !allowed(`npm test ${flag} C:/x`);
  for (const yes of ['--p', '--pr', '--pre', '--pref', '--prefi', '--prefix', '--c', '--cw', '--cwd', '-C']) {
    assert.equal(isRedirect(yes), true, `${yes} was not treated as a redirect`);
  }
  for (const no of ['--prefer-offline', '--production', '--color', '--cache', '--config', '--silent', '-c']) {
    assert.equal(isRedirect(no), false, `${no} was wrongly treated as a redirect`);
  }
});
