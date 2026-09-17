import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProvable, verifyProof, proofDigest, PROOF_VERSION } from '../src/verificationProof.mjs';

/**
 * BOTH DIRECTIONS, because a gate that only refuses is an outage and one that
 * only permits is decoration.
 *
 * The refusal cases here are not hypothetical failure modes. `dirty-source` is
 * the one its author tripped twice in the session that wrote it: a green suite
 * in a tree carrying uncommitted changes, and a commit pushed on the strength
 * of it. `zero-tests` is the run whose glob stopped matching and reported a
 * pass. `digest-mismatch` is REVIEW_TEXT != REVIEW_PROOF made checkable.
 */

const GOOD = Object.freeze({
  depsInstalled: true,
  sha: 'a'.repeat(40),
  repo: 'https://github.com/Noxypoxy69/agent007',
  sourceClean: true,
  checkoutHead: 'a'.repeat(40),
  tests: 1631,
  pass: 1616,
  fail: 0,
  skip: 15,
  suiteCommand: 'npm test',
});

test('POSITIVE: a clean checkout at the exact sha with a real suite mints a proof', () => {
  const r = assertProvable(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.proof.sha, GOOD.sha);
  assert.equal(r.proof.version, PROOF_VERSION);
  assert.match(r.proof.digest, /^[0-9a-f]{64}$/);
  assert.equal(verifyProof(r.proof).ok, true, 'a freshly minted proof must verify');
});

test('POSITIVE: two honest verifications of one sha agree on the digest', () => {
  // Timings and runner labels are excluded from the digest on purpose: a proof
  // that cannot be compared with another proof of the same commit is not a proof.
  const a = assertProvable({ ...GOOD }).proof;
  const b = assertProvable({ ...GOOD }).proof;
  assert.equal(a.digest, b.digest);
});

test('REFUSAL: a dirty source tree cannot mint a proof', () => {
  const r = assertProvable({ ...GOOD, sourceClean: false });
  assert.equal(r.ok, false);
  assert.equal(r.proof, null, 'a refused verification must not hand back an artifact');
  assert.ok(r.refusals.some((x) => x.code === 'dirty-source'));
});

test('REFUSAL: sourceClean must be TRUE, not merely truthy or absent', () => {
  for (const v of [undefined, null, 'yes', 1, {}]) {
    const r = assertProvable({ ...GOOD, sourceClean: v });
    assert.equal(r.ok, false, `sourceClean=${JSON.stringify(v)} must refuse`);
    assert.ok(r.refusals.some((x) => x.code === 'dirty-source'));
  }
});

test('REFUSAL: the checkout must land on the sha that was asked for', () => {
  const wrong = assertProvable({ ...GOOD, checkoutHead: 'b'.repeat(40) });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.refusals.some((x) => x.code === 'sha-mismatch'));

  // ABSENT IS NOT MATCHING. "could not confirm" carries the same risk as "wrong".
  const absent = assertProvable({ ...GOOD, checkoutHead: undefined });
  assert.equal(absent.ok, false);
  assert.ok(absent.refusals.some((x) => x.code === 'sha-mismatch'));
});

test('REFUSAL: a run of zero tests is not a pass', () => {
  const r = assertProvable({ ...GOOD, tests: 0, pass: 0, fail: 0, skip: 0 });
  assert.equal(r.ok, false, 'zero failures out of zero tests satisfies "no failures" and proves nothing');
  assert.ok(r.refusals.some((x) => x.code === 'zero-tests'));
});

test('REFUSAL: any failing test refuses, and counts that do not reconcile refuse', () => {
  assert.ok(assertProvable({ ...GOOD, fail: 1 }).refusals.some((x) => x.code === 'suite-failed'));
  const bad = assertProvable({ ...GOOD, tests: 10, pass: 9, fail: 0, skip: 5 });
  assert.ok(bad.refusals.some((x) => x.code === 'suite-not-run'), '9+0+5 cannot come out of 10');
});

test('REFUSAL: a short or absent sha is refused rather than padded', () => {
  for (const v of ['abc1234', '', undefined, 'A'.repeat(40)]) {
    const r = assertProvable({ ...GOOD, sha: v, checkoutHead: v });
    assert.equal(r.ok, false, `sha=${JSON.stringify(v)} must refuse`);
  }
});

test('REFUSAL: every reason at once, never just the first', () => {
  const r = assertProvable({ ...GOOD, sourceClean: false, fail: 3, checkoutHead: 'c'.repeat(40) });
  const codes = r.refusals.map((x) => x.code);
  assert.ok(codes.includes('dirty-source'));
  assert.ok(codes.includes('suite-failed'));
  assert.ok(codes.includes('sha-mismatch'));
  assert.ok(r.refusals.length >= 3, 'four restarts to learn three facts is a maze, not a diagnostic');
});

/* --------------------------------------------- THE READER'S HALF */

test('REFUSAL: a proof edited after minting stops verifying', () => {
  const proof = assertProvable(GOOD).proof;
  const tampered = { ...proof, fail: 0, tests: 99999 };
  const r = verifyProof(tampered);
  assert.equal(r.ok, false, 'REVIEW_TEXT != REVIEW_PROOF: an edited artifact must be detectable');
  assert.ok(r.refusals.some((x) => x.code === 'digest-mismatch'));
});

test('REFUSAL: a failing result cannot be laundered by rewriting the digest', () => {
  // The forger recomputes the digest so it is internally consistent. The
  // content is still a failing run, and the reader checks the CONTENT too.
  const forged = { version: PROOF_VERSION, sha: 'a'.repeat(40), repo: '', sourceClean: true,
    checkoutHead: 'a'.repeat(40), tests: 10, pass: 9, fail: 1, skip: 0, suiteCommand: 'npm test' };
  forged.digest = proofDigest(forged);
  const r = verifyProof(forged);
  assert.equal(r.ok, false, 'a self-consistent proof of a FAILING run is still not promotable');
  assert.ok(r.refusals.some((x) => x.code === 'suite-failed'));
});

test('REFUSAL: a proof carrying no digest at all is refused', () => {
  const proof = assertProvable(GOOD).proof;
  delete proof.digest;
  assert.equal(verifyProof(proof).ok, false);
  assert.equal(verifyProof(null).ok, false);
});

test('REFUSAL: a run that never installed dependencies is not a clean-clone proof', () => {
  /*
   * MEASURED WHILE BUILDING THIS. A fresh clone of a sound commit reported two
   * failures, both "Cannot find package '@modelcontextprotocol/sdk'". A verifier
   * that shrugged at a missing install would fail good commits for a reason that
   * says nothing about them -- or, if the imports happened not to surface, pass a
   * commit whose lockfile does not resolve.
   */
  for (const v of [undefined, false, 'yes', 1]) {
    const r = assertProvable({ ...GOOD, depsInstalled: v });
    assert.equal(r.ok, false, `depsInstalled=${JSON.stringify(v)} must refuse`);
    assert.ok(r.refusals.some((x) => x.code === 'deps-unavailable'));
  }
});

test('REFUSAL: a proof must name the command that ran', () => {
  /*
   * The CLI once recorded suiteCommand "npm test" while executing
   * `node --test test/`, which resolves test/ as a module path and dies at once.
   * The proof would have attested, inside its own digest, to a command that
   * never ran. An empty command is refused rather than defaulted.
   */
  for (const v of ['', '   ', undefined, null, 42]) {
    const r = assertProvable({ ...GOOD, suiteCommand: v });
    assert.equal(r.ok, false, `suiteCommand=${JSON.stringify(v)} must refuse`);
    assert.ok(r.refusals.some((x) => x.code === 'suite-not-run'));
  }
});

test('the reader refuses a proof whose deps were never installed', () => {
  const proof = assertProvable(GOOD).proof;
  const forged = { ...proof, depsInstalled: false };
  forged.digest = proofDigest(forged);
  const r = verifyProof(forged);
  assert.equal(r.ok, false, 'self-consistent is not the same as promotable');
  assert.ok(r.refusals.some((x) => x.code === 'deps-unavailable'));
});

/* ------------------------------------------------- THE CLI CONTRACT */

test('verify-sha accepts any revision git understands, and says why when it cannot', async () => {
  /*
   * REGRESSION, 2026-09-17. A hex-only guard refused `verify-sha HEAD` while
   * git rev-parse resolves HEAD, branches, tags and master~3 without trouble.
   * The guard existed to give a clean error instead of a raw git one and ended
   * up rejecting the most obvious invocation there is. Found by typing it.
   */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
  const REPO = fileURLToPath(new URL('../', import.meta.url));

  const call = async (argv) => {
    try {
      const { stdout } = await run(process.execPath, [CLI, 'verify-sha', ...argv], { cwd: REPO, maxBuffer: 8e6 });
      return { code: 0, stdout, stderr: '' };
    } catch (e) { return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
  };

  const missing = await call([]);
  assert.equal(missing.code, 2, 'no revision must refuse, not default to HEAD');
  assert.match(missing.stderr, /name a commit/);

  const bogus = await call(['zz-no-such-revision']);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /did not resolve to a commit/);
  assert.match(bogus.stderr, /git said:/, 'the cause must survive, not be swallowed');
});

test('verify-sha reads the revision as a positional, not as a flag value', async () => {
  /*
   * REGRESSION. The first parser used find(a => !a.startsWith('--')), so
   * `verify-sha --repo /path HEAD` resolved to "/path" -- the exact trap
   * check-first documents twenty lines away in the same file.
   */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
  const REPO = fileURLToPath(new URL('../', import.meta.url));

  let stderr = '';
  try {
    await run(process.execPath, [CLI, 'verify-sha', '--repo', REPO, 'zz-no-such-revision'],
      { cwd: REPO, maxBuffer: 8e6, timeout: 60000 });
  } catch (e) { stderr = e.stderr ?? ''; }
  assert.match(
    stderr,
    /zz-no-such-revision/,
    'the positional after a flag VALUE must be the revision, not the flag value',
  );
});
