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

test('THE REDIRECT IS REFUSED WHEREVER npm WOULD READ IT', () => {
  /*
   * Position mattered in the original bug -- the branch stopped looking at a
   * literal `--`. So the flag is tried before the verb's other arguments and
   * after them.
   */
  for (const cmd of [
    'npm --prefix C:/x test',
    'npm test --prefix C:/x',
    'npm run build --prefix C:/x',
    'npm test --silent --prefix C:/x',
  ]) {
    assert.equal(allowed(cmd), false, `the redirect escaped at this position: ${cmd}`);
  }
});

test('BUT NOT PAST A BARE --, BECAUSE npm STOPS READING ITS OWN FLAGS THERE', () => {
  /*
   * CORRECTED BY MEASUREMENT, and the version this replaces asserted the
   * opposite. It required `npm test -- --prefix C:/x` to be refused. npm does
   * not redirect on it. Against npm 11.16.0, marker file as the evidence:
   *
   *     npm test --prefix <attacker>                  REDIRECTED
   *     npm test -- --prefix <attacker>               no
   *     npm test --node-options=--require=<evil>      REDIRECTED
   *     npm test -- --node-options=--require=<evil>   no
   *
   * After a bare -- the words belong to the script, and refusing them is an
   * outage for the ordinary business of passing an argument through. Rule 16:
   * an outage is how a rail gets switched off. The version BEFORE the one
   * being corrected scanned ONLY after the --, which is the opposite error
   * and is the hole 1f29e438 was written to close; both directions are
   * asserted here so neither can come back.
   */
  assert.equal(allowed('npm run build -- --prefix somearg'), true,
    'an argument passed to the script was refused, and npm does not read it as its own');
  assert.equal(allowed('npm test -- --node-options=--require=C:/x/evil.js'), true,
    'likewise for node-options: past the -- it is the script\'s argument, not npm\'s');

  /* And the same flags BEFORE the -- are still refused, so this is not a hole. */
  assert.equal(allowed('npm run build --prefix somearg -- --safe'), false,
    'a redirect before the -- must still be caught');
});

test('THE REFUSAL NAMES THE MECHANISM AND THIS LAYER (rule 18)', () => {
  /*
   * Establish WHICH layer refused. This matters more than it looks: the
   * backslash spelling of the node-options escape,
   * --node-options=--require=C:\\x\\evil.js, is refused by the shell
   * METACHARACTER matcher reacting to the backslash -- a different layer, for
   * a different reason, on a spelling the attacker chooses. Reading that as
   * "the surface is covered" is how the forward-slash form stayed open.
   */
  const v = judgeShellCommand('npm test --prefix C:/x');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /npm flags decide what code runs/,
    `refused by some other layer, not the npm matcher: ${v.reason}`);

  const n = judgeShellCommand('npm test --node-options=--require=C:/x/evil.js');
  assert.equal(n.allowed, false);
  assert.match(n.reason, /npm flags decide what code runs/,
    `the node-options escape was refused by the wrong layer: ${n.reason}`);
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

test('THE INERT FLAGS STILL PASS, or this rail is an outage', () => {
  /*
   * The list is inverted now -- npm's own flags must be known-inert rather
   * than known-dangerous -- so the cost of that inversion is what needs
   * asserting. These are real npm flags that decide nothing about what runs.
   *
   * --config IS NO LONGER HERE, and the version this replaces asserted it
   * must be allowed. Measured against npm 11.16.0: "npm warn Unknown cli
   * config \"--config\". This will stop working in the next major version."
   * It is not an npm flag, so allowing it was never a requirement, and
   * under a fail-closed list it is refused like any other unknown.
   */
  for (const cmd of [
    'npm ci --prefer-offline',
    'npm ci --production',
    'npm test --color',
    'npm test --silent',
    'npm ci --no-audit --no-fund',
    'npm test --loglevel=warn',
  ]) {
    assert.equal(allowed(cmd), true, `an inert flag was refused, which is an outage: ${cmd}`);
  }
});

test('THE LIST IS INVERTED, so a redirect nobody enumerated is still refused', () => {
  /*
   * THE THIRD ROUND ON THIS MATCHER. Round one listed three spellings.
   * Round two asked `'prefix'.startsWith(name)` and called that "shape" -- but
   * it was a roster of two CONCEPTS, and npm has others. MEASURED, judging
   * and executing the same string, marker file as evidence:
   *
   *     npm test --node-options=--require=C:/x/evil.js
   *         rail = ALLOW      the file RAN
   *
   * Same outcome as --prefix, reached by injecting a module into every node
   * the script spawns instead of relocating package.json -- and the payload
   * is outside the repository, so the node gate never sees it.
   *
   * Enumerating what redirects is a game this matcher lost three times,
   * because npm's config system means almost any --key sets something. What
   * cannot hurt is short and stable, so that is the list now.
   */
  for (const cmd of [
    'npm test --node-options=--require=C:/x/evil.js',
    'npm test --script-shell C:/x/evil.exe',
    'npm test --userconfig C:/x/.npmrc',
    'npm test --globalconfig C:/x/.npmrc',
    'npm test --cache C:/x/poisoned',
    'npm test -CC:/x',
    'npm test -w C:/x',
  ]) {
    assert.equal(allowed(cmd), false,
      `a flag that can reach execution was allowed: ${cmd}`);
  }

  /*
   * ABBREVIATIONS ARE REFUSED TOO, and deliberately. npm expands --silen to
   * --silent, and rather than model nopt's expansion -- which is what round
   * two tried -- the exact spelling is required. There is always an exact
   * spelling, so this costs a caller nothing they cannot write.
   */
  assert.equal(allowed('npm test --silen'), false,
    'an abbreviation was accepted; the inert list requires exact spellings');
  assert.equal(allowed('npm test --silent'), true,
    'and the exact spelling must work, or the rule is just a refusal');
});
