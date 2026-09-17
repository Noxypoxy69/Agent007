/**
 * STEP 4A BOUNDARY REGRESSIONS.
 *
 * Every test here corresponds to a measured defect in the Gemini prototype or to
 * one found while correcting it. Each is mutation-proved: weakening the specific
 * mechanism turns THIS test red and nothing else has to notice.
 *
 * The invariants these defend, stated once:
 *
 *   The candidate filesystem is not authoritative. Its index, .gitignore,
 *   .git/config, hooks, fsmonitor and refs are untrusted input.
 *
 *   The tested tree is the approved tree. Validation runs from
 *   materializeTree(candidateTreeSha), never from the candidate's working
 *   directory.
 *
 *   The promoted tree is the approved tree. Promotion builds from the exact git
 *   tree object; it never reconstructs the candidate from a mutable worktree.
 *
 *   Separate process is NOT hostile-code isolation. Same OS user means the
 *   approval store and the runner remain prototype mechanics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore } from '../src/jobStore.mjs';
import { createVerifier, POLICY_VERSION } from '../src/verifier.mjs';
import { candidateIdentity, materializeTree } from '../src/candidateTree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const NUL = String.fromCharCode(0);
const blankComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 's4a-auth-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'test'), { recursive: true });
  writeFileSync(path.join(dir, 'CLAUDE.md'), 'rules\n');
  writeFileSync(path.join(dir, 'src', 'feature.mjs'), 'export const v = 1;\n');
  writeFileSync(path.join(dir, 'test', 'baseline.test.mjs'), 'import test from "node:test"; test("ok", () => {});\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '-A'); git('commit', '-qm', 'base');
  return dir;
}
const clone = (a) => { const d = mkdtempSync(path.join(tmpdir(), 's4a-cand-')); execFileSync('git', ['clone', '-q', a, d], { stdio: 'ignore' }); return d; };

function harness(t) {
  const a = fixture(); const c = clone(a); const s = mkdtempSync(path.join(tmpdir(), 's4a-appr-'));
  /* The job store became file-backed when the real path grew three processes.
   * These tests drive the verifier directly, so they hold their own store dir. */
  const jobs = createJobStore(s);
  const verifier = createVerifier({ jobStore: jobs, approvalStoreDir: s });
  const jobId = jobs.createJob({ repoRoot: a, baselineRef: 'HEAD', candidateWorkspace: c });
  t.after(() => { for (const d of [a, c, s]) rmSync(d, { recursive: true, force: true }); });
  return { a, c, s, jobs, verifier, jobId };
}
const idOf = (a, c) => candidateIdentity({ repoRoot: a, baselineRef: 'HEAD', candidateWorkspace: c, policyVersion: POLICY_VERSION });

/* ---- candidate identity (mutations 1-6) ---- */

test('M1 identity includes untracked files', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 2;\n');
  const before = idOf(h.a, h.c).candidateId;
  writeFileSync(path.join(h.c, 'src', 'SMUGGLED.mjs'), 'export const evil = true;\n');
  assert.notEqual(idOf(h.a, h.c).candidateId, before, 'an untracked file must change the candidate id');
});

test('M2 identity includes gitignored files', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, '.gitignore'), 'src/HIDDEN.mjs\n');
  writeFileSync(path.join(h.c, 'src', 'HIDDEN.mjs'), 'export const sneaky = true;\n');
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', idOf(h.a, h.c).candidateTreeSha], { cwd: h.c, encoding: 'utf8' });
  assert.ok(listing.includes('src/HIDDEN.mjs'), '.gitignore must not hide candidate bytes from identity');
});

test('M3 identity neither reads nor writes the candidate index', (t) => {
  /*
   * THE FIRST VERSION OF THIS TEST WAS UNFALSIFIABLE. It compared identity with
   * the candidate's index staged vs unstaged -- but `git add -A` restages from
   * disk either way, so the tree matched whether or not the verifier used its
   * own index. The mutation that removes GIT_INDEX_FILE left it green.
   *
   * The observable consequence of trusting the candidate's index is that the
   * verifier WRITES to it. So the property is: computing identity leaves the
   * candidate's index byte-for-byte untouched.
   */
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 9;\n');
  execFileSync('git', ['reset', '-q'], { cwd: h.c, stdio: 'ignore' });
  const indexPath = path.join(h.c, '.git', 'index');
  const before = readFileSync(indexPath);
  const unstaged = idOf(h.a, h.c).candidateTreeSha;
  const after = readFileSync(indexPath);
  assert.equal(Buffer.compare(before, after), 0, "computing identity must not touch the candidate's index");
  execFileSync('git', ['add', '-A'], { cwd: h.c, stdio: 'ignore' });
  assert.equal(idOf(h.a, h.c).candidateTreeSha, unstaged, 'and the index must not change the answer');
});

test('M4 identity includes executable-bit changes', (t) => {
  const h = harness(t);
  const before = idOf(h.a, h.c).candidateTreeSha;
  chmodSync(path.join(h.c, 'src', 'feature.mjs'), 0o755);
  assert.notEqual(idOf(h.a, h.c).candidateTreeSha, before, 'a mode change must change the tree');
});

test('M5 identity includes symlink / object type', (t) => {
  const h = harness(t);
  const before = idOf(h.a, h.c).candidateTreeSha;
  rmSync(path.join(h.c, 'src', 'feature.mjs'));
  symlinkSync('/etc/passwd', path.join(h.c, 'src', 'feature.mjs'));
  const after = idOf(h.a, h.c);
  assert.notEqual(after.candidateTreeSha, before, 'file -> symlink must change the tree');
  const types = execFileSync('git', ['ls-tree', '-r', after.candidateTreeSha], { cwd: h.c, encoding: 'utf8' });
  assert.match(types, /^120000 /m, 'and must be recorded as a symlink object');
  /*
   * AND THE TYPE MUST SURVIVE MATERIALIZATION. The tree records 120000
   * regardless of configuration, so the tree assertion alone could not be
   * weakened by any mutation -- it was structurally true and therefore proved
   * nothing about the verifier. core.symlinks=false is where the type is
   * actually lost: the checkout writes a regular file containing the target
   * path, and validation would then test something the tree does not describe.
   */
  const checkout = materializeTree(h.c, after.candidateTreeSha);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  assert.equal(lstatSync(path.join(checkout, 'src', 'feature.mjs')).isSymbolicLink(), true,
    'the materialized checkout must preserve the symlink, not flatten it to a regular file');
});

test('M6 identity includes deletions', (t) => {
  const h = harness(t);
  const before = idOf(h.a, h.c).candidateTreeSha;
  rmSync(path.join(h.c, 'src', 'feature.mjs'));
  assert.notEqual(idOf(h.a, h.c).candidateTreeSha, before, 'a deletion must change the tree');
});

/* ---- identity failure (mutation 7) ---- */

test('M7 an unresolvable baseline produces no identity and no approval', (t) => {
  const h = harness(t);
  const jobId = h.jobs.createJob({ repoRoot: h.a, baselineRef: 'refs/nope/nope', candidateWorkspace: h.c });
  const r = h.verifier.verifyJob(jobId);
  assert.equal(r.decision, 'error', 'a broken baseline must not approve');
  assert.equal(r.approvalId, undefined, 'and must mint no approval');
});

/* ---- approval authority (mutations 8-10) ---- */

test('M8 approvals cannot be derived from public values', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 2;\n');
  const real = h.verifier.verifyJob(h.jobId);
  assert.equal(real.decision, 'approve');
  const id = idOf(h.a, h.c);
  for (const guess of [
    id.candidateId,
    id.candidateTreeSha,
    sha256(id.candidateId + NUL + id.candidateTreeSha + NUL + POLICY_VERSION),
    sha256(`${id.candidateId}${id.baselineCommitSha}${POLICY_VERSION}`),
  ]) {
    assert.equal(h.verifier.promoteApproval(guess, { jobId: h.jobId }).ok, false, `derived value must not promote: ${guess.slice(0, 12)}`);
  }

  /*
   * AND THE PROPERTY THAT GUESSING CANNOT TEST. Any fixed list of derivations is
   * a list of the ones I happened to think of -- a mutation using a formula not
   * on the list leaves it green, which is exactly what happened the first time.
   * The structural property is that the id is not a FUNCTION of the candidate:
   * verifying the same candidate twice must yield two different ids. A derived
   * id, by any formula, yields the same one.
   */
  const again = h.verifier.verifyJob(h.jobId);
  assert.equal(again.decision, 'approve', 'control: the same candidate verifies again');
  assert.notEqual(again.approvalId, real.approvalId,
    'the approval id must not be derivable from the candidate -- two verifications must differ');
});

test('M9 approvals are single use', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 3;\n');
  const v = h.verifier.verifyJob(h.jobId);
  assert.equal(h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId }).ok, true, 'control: first promotion works');
  assert.equal(h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId }).ok, false, 'replay must be refused');
});

test('M10 an approval for candidate A cannot promote candidate B', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 2;\n');
  const v = h.verifier.verifyJob(h.jobId);
  assert.equal(v.decision, 'approve', 'control: A is approved');
  /* B: same workspace, different content, never verified. */
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 666;\n');
  const p = h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId });
  assert.equal(p.ok, false, "A's approval must not promote B");
  assert.match(p.error, /candidate-changed-since-verification/);
});

/* ---- authorization and trusted inputs (mutations 11-13) ---- */

test('M11 no caller-supplied role grants promotion', (t) => {
  const src = blankComments(readFileSync(path.join(here, '..', 'src', 'verifier.mjs'), 'utf8'));
  assert.equal(/actorRole/.test(src), false, 'actorRole must not appear in verifier code');
  const workerBin = readFileSync(path.join(here, '..', 'bin', 'agentbridge-verify.mjs'), 'utf8');

  /*
   * THIS CLAUSE USED TO READ "the worker entrypoint must import nothing", AND
   * THAT WAS A PROXY FOR THE REAL PROPERTY.
   *
   * It was satisfiable only while this binary was an unwired prototype that
   * inlined its own logic; a binary actually reachable from production has to
   * import the capability it runs. Left as it was, it would have failed for the
   * wiring rather than for a defect -- and a check that is red for a reason you
   * must ignore is one you learn to ignore.
   *
   * So it is replaced by the property it was standing in for, stated directly
   * and more strictly: the worker may import exactly ONE thing, the narrowed
   * worker plane. Enumerating what it imports is stronger than forbidding
   * imports outright, because it also rejects a second import that would reach
   * the verifier, the approval store or the integration plane -- which
   * "imports nothing" only prevented by accident.
   */
  const imports = [...workerBin.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';$/gm)]
    .map(([, what, where]) => `${what.replace(/\s+/g, ' ')} from ${where}`);
  assert.deepEqual(imports, ["{ workerPlane } from ../src/verificationControl.mjs"],
    'the worker entrypoint may import only the narrowed worker plane');
  assert.equal(/promoteApproval/.test(blankComments(workerBin)), false, 'and must not name promoteApproval at all');
  assert.equal(/integrationPlane|approvalStore|createVerifier/.test(blankComments(workerBin)), false,
    'nor reach promotion by another door');
});

test('M12 a candidate cannot declare itself authoritative', (t) => {
  const h = harness(t);
  const selfJob = h.jobs.createJob({ repoRoot: h.a, baselineRef: 'HEAD', candidateWorkspace: h.a });
  const r = h.verifier.verifyJob(selfJob);
  assert.equal(r.decision, 'error', 'candidate === authoritative must refuse');
  assert.equal(r.approvalId, undefined);
  assert.equal(h.verifier.verifyJob.length, 1, 'verifyJob must take only a job id');
});

test('M13 no production path can skip validation', (t) => {
  const src = blankComments(readFileSync(path.join(here, '..', 'src', 'verifier.mjs'), 'utf8'));
  assert.equal(/skipSuite/.test(src), false, 'skipSuite must not appear in verifier code');
  const h = harness(t);
  rmSync(path.join(h.c, 'test', 'baseline.test.mjs'));
  const r = h.verifier.verifyJob(h.jobId);
  assert.equal(r.decision, 'reject', 'deleting the suite must reject, not pass');
});

/* ---- TOCTOU and promotion (mutations 14-16) ---- */

test('M14 promotion refuses after the authoritative baseline moves', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 9;\n');
  const v = h.verifier.verifyJob(h.jobId);
  assert.equal(v.decision, 'approve', 'control: approved before the base moved');
  writeFileSync(path.join(h.a, 'src', 'other.mjs'), 'export const other = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: h.a, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'moved'], { cwd: h.a, stdio: 'ignore' });
  const p = h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId });
  assert.equal(p.ok, false);
  assert.match(p.error, /authoritative-baseline-moved-since-verification/, 'and must name the baseline, not the candidate');
});

test('M15 changing the candidate after verification invalidates the approval', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 2;\n');
  const v = h.verifier.verifyJob(h.jobId);
  writeFileSync(path.join(h.c, 'src', 'LATE.mjs'), 'export const late = true;\n');
  const p = h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId });
  assert.equal(p.ok, false, 'a post-verification edit must invalidate the approval');
});

test('M16 promoted tree is the exact approved tree', (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.c, 'src', 'feature.mjs'), 'export const v = 2;\n');
  writeFileSync(path.join(h.c, 'test', 'featureNew.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict"; import {v} from "../src/feature.mjs"; test("v2", () => { assert.equal(v, 2); });\n');
  const v = h.verifier.verifyJob(h.jobId);
  assert.equal(v.decision, 'approve', v.reason);
  const p = h.verifier.promoteApproval(v.approvalId, { jobId: h.jobId });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.promotedTreeSha, v.candidateTreeSha, 'promoted tree must equal validated tree');
  /*
   * READ THE REF, NOT THE RETURN VALUE. The first version trusted
   * p.promotedTreeSha, which is copied from the approval record -- so a
   * promotion that COMMITTED a different tree would still report the right one.
   * A check that asks the actor what it did is not a check.
   */
  const writtenTree = execFileSync('git', ['rev-parse', `${p.promotedRef}^{tree}`], { cwd: h.a, encoding: 'utf8' }).trim();
  assert.equal(writtenTree, v.candidateTreeSha, 'the tree actually committed must be the approved tree');
  const promoted = execFileSync('git', ['ls-tree', '-r', '--name-only', p.promotedRef], { cwd: h.a, encoding: 'utf8' });
  assert.ok(promoted.includes('test/featureNew.test.mjs'), 'a newly created file must reach the promoted output');
});

/* ---- validation execution (mutations 17-19) ---- */

test('M17 candidate code cannot see the authority process or its environment', (t) => {
  /*
   * AN EARLIER VERSION OF THIS TEST ASSERTED ONLY A DIFFERENT PID, AND WAS
   * HOLLOW. The Gemini prototype ALSO spawned a child, so that assertion would
   * have passed against the exact defect this test is named for. A test that
   * cannot fail on the thing it describes is decoration.
   *
   * What actually separates the two is what the child is handed. The prototype
   * ran candidate tests in the candidate's own workspace with process.env
   * inherited wholesale -- so candidate code received every token, key and path
   * the authority was started with. This asserts the child is a different
   * process AND that the authority's environment did not travel with it.
   */
  const h = harness(t);
  const marker = path.join(tmpdir(), `s4a-authority-${randomBytes(6).toString('hex')}`);
  const secret = `s4a-secret-${randomBytes(8).toString('hex')}`;
  t.after(() => { rmSync(marker, { force: true }); delete process.env.AGENTBRIDGE_AUTHORITY_SECRET; });
  process.env.AGENTBRIDGE_AUTHORITY_SECRET = secret;

  writeFileSync(path.join(h.c, 'test', 'payload.test.mjs'),
    'import test from "node:test";\nimport { writeFileSync } from "node:fs";\n'
    + `test("p", () => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, sawSecret: process.env.AGENTBRIDGE_AUTHORITY_SECRET ?? null })); });\n`);

  h.verifier.verifyJob(h.jobId);
  assert.ok(existsSync(marker), 'control: validation must actually have run the candidate test');
  const seen = JSON.parse(readFileSync(marker, 'utf8'));
  assert.notEqual(seen.pid, process.pid, 'candidate code must not run in the authority process');
  assert.equal(seen.sawSecret, null, "the authority's environment must not travel to candidate code");
});

test('M18 a protected-path candidate is refused BEFORE its code runs', (t) => {
  const h = harness(t);
  const marker = path.join(tmpdir(), `s4a-ordering-${randomBytes(6).toString('hex')}`);
  t.after(() => rmSync(marker, { force: true }));
  writeFileSync(path.join(h.c, 'CLAUDE.md'), 'tampered\n');
  writeFileSync(path.join(h.c, 'test', 'payload.test.mjs'),
    `import test from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("p", () => { writeFileSync(${JSON.stringify(marker)}, "ran"); });\n`);
  const r = h.verifier.verifyJob(h.jobId);
  assert.equal(r.decision, 'reject', 'editing a protected control must reject');
  assert.equal(existsSync(marker), false, 'and must reject before executing candidate code');
});

test('M19 an uninterpretable runner result is an error, not a pass', (t) => {
  const h = harness(t);
  const jobs = createJobStore(h.s);
  const jobId = jobs.createJob({ repoRoot: h.a, baselineRef: 'HEAD', candidateWorkspace: h.c });
  for (const bad of [undefined, null, {}, { ok: true }, { ok: 'yes', counts: { tests: 1 } }]) {
    const v = createVerifier({ jobStore: jobs, approvalStoreDir: h.s, validationRunner: () => bad });
    const r = v.verifyJob(jobId);
    assert.notEqual(r.decision, 'approve', `runner result ${JSON.stringify(bad)} must not approve`);
  }
});

/* ---- git execution hardening (mutations 20-22) ---- */

test('M20/M21/M22 verifier git calls neutralize candidate-controlled config', (t) => {
  /*
   * THE FLAGS MOVED, THE REQUIREMENT DID NOT.
   *
   * This read candidateTree.mjs, because that is where the list lived. It lived
   * there AND in verifier.mjs, byte-identical, while seven other git
   * invocations in this repository had none -- including the two in
   * guardSession.mjs that the Stop gate depends on. src/safeGit.mjs is the
   * single artifact now, so the assertion reads the shipped artifact rather
   * than one of its former copies.
   *
   * The routing assertion below is what makes this STRONGER than it was: the
   * old check could only prove one file mentioned the flags, and said nothing
   * about whether that file's git calls actually used them or whether anybody
   * else's did. test/safeGit.test.mjs proves no module invokes git any other
   * way at all.
   */
  const src = blankComments(readFileSync(path.join(here, '..', 'src', 'safeGit.mjs'), 'utf8'));
  assert.match(src, /core\.hooksPath=\/dev\/null/, 'hooksPath must be neutralized');
  assert.match(src, /core\.fsmonitor=false/, 'fsmonitor must be neutralized');
  assert.match(src, /protocol\.ext\.allow=never/, 'ext protocol must be refused');

  const tree = blankComments(readFileSync(path.join(here, '..', 'src', 'candidateTree.mjs'), 'utf8'));
  assert.match(tree, /from '\.\/safeGit\.mjs'/, 'candidateTree must route its git calls through safeGit');
  assert.doesNotMatch(tree, /execFileSync\(\s*'git'/, 'candidateTree must not invoke git directly');

  /*
   * BEHAVIOURAL, NOT JUST TEXTUAL. A hostile core.fsmonitor in the candidate's
   * own .git/config is executable configuration; if the verifier inherited it,
   * building the candidate tree would run it.
   */
  const h = harness(t);
  const marker = path.join(tmpdir(), `s4a-hook-${randomBytes(6).toString('hex')}`);
  t.after(() => rmSync(marker, { force: true }));
  const hookDir = path.join(h.c, 'evil-hooks');
  mkdirSync(hookDir, { recursive: true });
  const fsm = path.join(hookDir, 'fsmonitor-watchman');
  writeFileSync(fsm, `#!/bin/sh\necho ran > ${marker}\nexit 1\n`);
  chmodSync(fsm, 0o755);
  execFileSync('git', ['config', 'core.fsmonitor', fsm], { cwd: h.c, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', hookDir], { cwd: h.c, stdio: 'ignore' });
  idOf(h.a, h.c);
  assert.equal(existsSync(marker), false, 'candidate-configured executable must not run under the verifier');
});
