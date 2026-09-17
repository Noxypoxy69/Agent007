/**
 * EVERY GIT INVOCATION ON THE AUTHORITY PATH CARRIES THE SAME HARDENING.
 *
 * WRITTEN BECAUSE A REVIEWER FOUND THIS, NOT A TEST. The hardening flags existed
 * as two byte-identical copies -- SAFE_GIT in verifier.mjs and SAFE_GIT_CONFIG
 * in candidateTree.mjs -- while a third call site in verificationControl.mjs
 * carried none at all. One concept, three places, two different values. The
 * commit that shipped it argued in its own message against exactly that shape.
 *
 * Collapsing the copies fixed the instances. It does not stop the next call site
 * being added without them, and "remember to pass the flags" is not a control.
 * So this enumerates the call sites instead: a new `execFileSync('git', ...)`
 * anywhere on the authority path either spreads the shared constant or fails
 * here, and adding a module to the list below is a deliberate act.
 *
 * FIXING THE FOUR SITES FOUND A FIFTH. The review named two; collapsing them
 * revealed `candGit` in verifier.mjs still referencing the constant that had
 * just been deleted. That is the argument for a gate in one line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_GIT_CONFIG } from '../src/candidateTree.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The modules that run git as part of deciding or promoting. guardSession.mjs is
 * deliberately NOT here: it reads the DEVELOPER's own repository to describe it
 * back to them, and is not on the path that grants anything.
 */
const AUTHORITY_MODULES = [
  'src/candidateTree.mjs',
  'src/verifier.mjs',
  'src/verificationControl.mjs',
];

const blankComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the hardening list exists once, with the flags that matter', () => {
  assert.deepEqual(SAFE_GIT_CONFIG, [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.ext.allow=never',
  ]);

  /* A SECOND COPY IS THE DEFECT ITSELF, so it is a failure, not a style note. */
  for (const m of AUTHORITY_MODULES) {
    const src = blankComments(readFileSync(path.join(repoRoot, m), 'utf8'));
    const declarations = [...src.matchAll(/const\s+(SAFE_GIT\w*)\s*=/g)].map((x) => x[1]);
    const expected = m === 'src/candidateTree.mjs' ? ['SAFE_GIT_CONFIG'] : [];
    assert.deepEqual(declarations, expected, `${m} must not declare its own copy of the hardening flags`);
  }
});

test('every git invocation on the authority path spreads the shared constant', () => {
  let sites = 0;
  for (const m of AUTHORITY_MODULES) {
    const src = blankComments(readFileSync(path.join(repoRoot, m), 'utf8'));
    for (const match of src.matchAll(/execFileSync\(\s*'git'\s*,\s*([^,]*)/g)) {
      sites += 1;
      /* The capture stops at the first comma, so the anchor is the OPENING of
       * the argument list, not a trailing comma that is never in it. */
      assert.match(
        match[1],
        /^\s*\[\s*\.\.\.SAFE_GIT_CONFIG\s*$/,
        `${m}: a git call whose arguments do not begin with ...SAFE_GIT_CONFIG -- ${match[0].slice(0, 90)}`,
      );
    }
  }
  /*
   * ABSENT IS NOT ZERO. If a refactor renames the call or moves it behind a
   * helper, this test would otherwise pass by finding nothing to check.
   */
  assert.ok(sites >= 4, `expected the known git call sites to still be here, found ${sites}`);
});
