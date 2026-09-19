/**
 * THE GRANT KEY HAS NO INDEPENDENT PIN, AND A BLIND AUDIT MEASURED THAT.
 *
 * `repoStorePath` now computes the filename for BOTH the override grants and the
 * findings store: `sha256(canonical git-common-dir)[0:16]`. The auditor verified
 * the refactor is output-identical across 35 (repoRoot, home) combinations with
 * zero mismatches -- and then mutated `.slice(0, 16)` to `.slice(0, 15)` and ran
 * the three grant test files:
 *
 *     node --test test/grantKeyIsRepoWide.test.mjs test/guardOverride.test.mjs \
 *                 test/baselineTestGrant.test.mjs
 *     -> tests 35   pass 35   fail 0
 *
 * NOT CAUGHT. Every one of those tests WRITES through `overridePath` and READS
 * through `overridePath`, so they agree with themselves under any key whatsoever.
 * That is hollow gate #2 in its purest form: a gate that reconstructs the rule
 * agrees with itself through the regression.
 *
 * WHAT THAT MUTATION ACTUALLY DOES: it relocates every grant file on every
 * machine and makes every existing grant invisible. CLAUDE.md records what that
 * costs -- the key was undocumented and unprintable for a week, it resolved
 * differently in every worktree, and across 17 roots on one machine exactly one
 * had a grant and it was not the one anybody was working in. A grant at the wrong
 * key fails EXACTLY like the guard being strict, which is why it was
 * re-diagnosed three times.
 *
 * So this asks about the FILENAME, which is the thing that has to stay put,
 * rather than about a round trip through the function that produces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { repoStorePath, overridePath, overrideKeySource } from '../src/guardSession.mjs';

const REPO = process.cwd();
const HOME = path.join('C:', 'tmp', 'agentbridge-key-test');

/** Everything before the extension: the part that has to stay put. */
const keyOf = (p) => path.basename(p).split('.')[0];

test('THE KEY IS 16 HEX CHARACTERS, and that width is the thing that moves', () => {
  /*
   * The exact mutation the audit got past three files: 16 -> 15. Asserting the
   * WIDTH catches it without this test having to know the value, which is a
   * property of whichever machine is running.
   */
  const key = keyOf(overridePath(REPO, HOME));
  assert.match(key, /^[0-9a-f]{16}$/, `the grant key is not 16 hex characters: ${key}`);
  assert.equal(key.length, 16);
});

test('THE KEY IS sha256 OF WHAT overrideKeySource REPORTS, computed independently', () => {
  /*
   * DERIVED FROM THE MACHINE AT RUN TIME, NOT TYPED (rule 21). The key source is
   * the canonical git-common-dir, which differs per checkout, per drive letter
   * and per 8.3 alias -- a literal here would be a fact about one directory's
   * history, which is the defect that broke the 8.3 test for every clone.
   *
   * This is the one place a reconstruction is right rather than hollow: the
   * round-trip tests already prove the function agrees with itself, and what is
   * missing is exactly an assertion that does NOT go through it.
   */
  const expected = createHash('sha256').update(overrideKeySource(REPO)).digest('hex').slice(0, 16);
  assert.equal(keyOf(overridePath(REPO, HOME)), expected,
    'the grant filename is not the documented digest of the key source');
});

test('EVERY STORE KEYED THIS WAY AGREES, so a grant and its findings share a repo', () => {
  /*
   * `repoStorePath` exists so there is ONE derivation rather than two copies of
   * an expression. If they ever diverge, a session would hold a grant under one
   * key and write findings under another for the same repository -- the two-lists
   * failure this repository has a header about, in the one place it is hardest
   * to notice.
   */
  const grant = keyOf(repoStorePath(REPO, 'overrides', '.json', HOME));
  const findings = keyOf(repoStorePath(REPO, 'findings', '.jsonl', HOME));
  assert.equal(grant, findings);
  assert.equal(grant, keyOf(overridePath(REPO, HOME)),
    'overridePath no longer routes through repoStorePath');
});

test('THE KIND AND THE EXTENSION DECIDE THE DIRECTORY AND THE SUFFIX, nothing else', () => {
  const p = repoStorePath(REPO, 'findings', '.jsonl', HOME);
  assert.equal(path.basename(path.dirname(p)), 'findings');
  assert.ok(p.endsWith('.jsonl'));
  assert.ok(p.startsWith(HOME), 'the store escaped the home it was given');
});

test('A DIFFERENT REPOSITORY GETS A DIFFERENT KEY -- the negative control', () => {
  /*
   * Rule 5. Every assertion above passes against an implementation that returns
   * one constant. The parent directory is outside this checkout, so its key
   * source differs; if it somehow does not, this test says so rather than
   * passing vacuously.
   */
  const outside = path.resolve(REPO, '..');
  const here = overrideKeySource(REPO);
  const there = overrideKeySource(outside);
  assert.notEqual(here, there,
    'the key SOURCE is identical for two different roots, so this cannot prove the key differs');
  assert.notEqual(keyOf(overridePath(REPO, HOME)), keyOf(overridePath(outside, HOME)));
});

test('THE HOME IS HONOURED, so an isolated run cannot touch the operator store', () => {
  /*
   * Rule 20 requires an auditor to redirect AGENTBRIDGE_HOME. If this argument
   * were ignored, every isolated audit would write fixtures into the live store
   * -- which is a documented incident here, not a hypothetical.
   */
  const a = repoStorePath(REPO, 'findings', '.jsonl', path.join('C:', 'tmp', 'home-a'));
  const b = repoStorePath(REPO, 'findings', '.jsonl', path.join('C:', 'tmp', 'home-b'));
  assert.notEqual(a, b);
  assert.equal(keyOf(a), keyOf(b), 'the key changed with the home; it must depend only on the repo');
});
