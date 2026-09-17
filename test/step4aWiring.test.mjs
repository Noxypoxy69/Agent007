/**
 * PRODUCTION REACHABILITY. Does the SHIPPED path actually reach Step 4A?
 *
 * The repo's orphan and dead-export gates said no: approvalStore, candidateTree
 * and jobStore existed only for tests. Those gates were right, and the fix was
 * wiring rather than an entry in KNOWN.
 *
 * So these tests deliberately DO NOT import the verifier. They spawn the real
 * binaries -- bin/agentbridge-verify.mjs and bin/agentbridge-integrate.mjs --
 * exactly as a worker or an integration owner would run them. A test that
 * imported the module would prove the module works, which was never in doubt;
 * what was in doubt is whether anything shipped can get to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_BIN = path.join(repoRoot, 'bin', 'agentbridge-verify.mjs');
const INTEGRATE_BIN = path.join(repoRoot, 'bin', 'agentbridge-integrate.mjs');
const blankComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function authoritative() {
  const dir = mkdtempSync(path.join(tmpdir(), 's4w-auth-'));
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
const cloneOf = (a) => { const d = mkdtempSync(path.join(tmpdir(), 's4w-cand-')); execFileSync('git', ['clone', '-q', a, d], { stdio: 'ignore' }); return d; };

/** Run a shipped binary the way an operator would: argv in, JSON out. */
function runBin(bin, args, stateDir) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', AGENTBRIDGE_STATE_DIR: stateDir },
  });
  let json = null;
  try { json = JSON.parse(r.stdout || '{}'); } catch { json = null; }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function scenario(t) {
  const auth = authoritative();
  const cand = cloneOf(auth);
  const state = mkdtempSync(path.join(tmpdir(), 's4w-state-'));
  t.after(() => { for (const d of [auth, cand, state]) rmSync(d, { recursive: true, force: true }); });
  return { auth, cand, state };
}

/**
 * The controller step, invoked the way bin/agentbridge-attempt.mjs invokes it.
 * Imported here because THIS is the controller side -- the point of the test is
 * that the WORKER cannot reach it, not that nothing can.
 */
async function openJob({ auth, cand, state }) {
  const { openVerificationJob } = await import('../src/verificationControl.mjs');
  return openVerificationJob({ repoRoot: auth, baselineRef: 'HEAD', candidateWorkspace: cand, sessionId: 's', workerId: 'w', dir: state });
}

test('A the controller creates a durable job record the worker can be handed', async (t) => {
  const s = scenario(t);
  const jobId = await openJob(s);
  assert.match(jobId, /^[0-9a-f]{32}$/, 'a job id is opaque');
  const files = readdirSync(path.join(s.state, 'jobs'));
  assert.equal(files.length, 1, 'exactly one job record was written');
  const record = JSON.parse(readFileSync(path.join(s.state, 'jobs', files[0]), 'utf8'));
  assert.equal(record.repoRoot, path.resolve(s.auth), 'the record binds the authoritative repo');
  /*
   * THE RECORD BINDS THE COMMIT, NOT THE WORD. This asserted `'HEAD'` while the
   * store kept the caller's ref verbatim -- so a job created against one
   * baseline could be verified against another simply because the repository
   * moved, and every check downstream would have agreed with itself.
   */
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.auth, encoding: 'utf8' }).trim();
  assert.equal(record.baselineRef, head, 'the baseline is resolved to an immutable commit at job creation');
  assert.match(record.repoIdentity ?? '', /^[0-9a-f]{64}$/, 'and the repository itself is identified, not just pathed');
  /*
   * THE RECORD BINDS A SNAPSHOT, NOT THE ATTEMPT'S WORKSPACE, and that is the
   * whole reason this edge works at all: the attempt pipeline destroys an
   * accepted workspace, so a record naming it would name a directory that no
   * longer exists by the time a worker is handed the id.
   */
  assert.notEqual(path.resolve(record.candidateWorkspace), path.resolve(s.cand), 'the candidate is snapshotted, not referenced');
  assert.ok(existsSync(record.candidateWorkspace), 'and the snapshot exists');
  assert.equal(existsSync(path.join(record.candidateWorkspace, 'src', 'feature.mjs')), true, 'carrying the candidate content');
  /* A snapshot that still carried the candidate's own .git would be carrying its
   * hooks and fsmonitor config with it. */
  rmSync(path.join(s.cand, 'src', 'feature.mjs'), { force: true });
  assert.equal(existsSync(path.join(record.candidateWorkspace, 'src', 'feature.mjs')), true,
    'and is independent of later edits to the workspace it came from');
});

test('B the shipped verify binary reaches verifyJob with only a job id', async (t) => {
  const s = scenario(t);
  writeFileSync(path.join(s.cand, 'src', 'feature.mjs'), 'export const v = 2;\n');
  const jobId = await openJob(s);
  const r = runBin(VERIFY_BIN, ['--job', jobId], s.state);
  assert.equal(r.status, 0, `verify should approve; stderr=${r.stderr}`);
  assert.ok(r.json, 'the binary emits JSON');
  assert.equal(r.json.decision, 'approve');
  assert.match(r.json.candidateTreeSha ?? '', /^[0-9a-f]{40,64}$/, 'and reports the tree it validated');
});

test('C a successful verify through the shipped route yields an opaque approval id', async (t) => {
  const s = scenario(t);
  writeFileSync(path.join(s.cand, 'src', 'feature.mjs'), 'export const v = 3;\n');
  const jobId = await openJob(s);
  const r = runBin(VERIFY_BIN, ['--job', jobId], s.state);
  assert.match(r.json?.approvalId ?? '', /^[0-9a-f]{64}$/, 'approval id is 256 bits');
  /* And the store's own paths must not travel to the worker. */
  assert.equal(/approvals|consumed|\/tmp\//.test(JSON.stringify(r.json)), false,
    'verification output must not leak approval-store paths');
});

test('D the trusted integration binary consumes the approval and promotes the exact tree', async (t) => {
  const s = scenario(t);
  writeFileSync(path.join(s.cand, 'src', 'feature.mjs'), 'export const v = 4;\n');
  writeFileSync(path.join(s.cand, 'test', 'new.test.mjs'), 'import test from "node:test"; test("n", () => {});\n');
  const jobId = await openJob(s);
  const v = runBin(VERIFY_BIN, ['--job', jobId], s.state);
  assert.equal(v.json?.decision, 'approve', v.stderr);

  const p = runBin(INTEGRATE_BIN, ['--approval', v.json.approvalId, '--job', jobId], s.state);
  assert.equal(p.status, 0, `integrate should succeed; stderr=${p.stderr}`);
  assert.equal(p.json?.ok, true);
  assert.equal(p.json.promotedTreeSha, v.json.candidateTreeSha, 'promoted tree === validated tree');

  const written = execFileSync('git', ['rev-parse', `${p.json.promotedRef}^{tree}`], { cwd: s.auth, encoding: 'utf8' }).trim();
  assert.equal(written, v.json.candidateTreeSha, 'and the ref actually written carries that tree');
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', p.json.promotedRef], { cwd: s.auth, encoding: 'utf8' });
  assert.ok(listing.includes('test/new.test.mjs'), 'a newly created file reaches the promoted output');

  /* Replay through the shipped route is refused too. */
  const again = runBin(INTEGRATE_BIN, ['--approval', v.json.approvalId, '--job', jobId], s.state);
  assert.equal(again.json?.ok, false, 'an approval is single use through the real path as well');
});

test('E the worker route structurally cannot promote', () => {
  /*
   * STRUCTURAL, NOT BEHAVIOURAL. "I did not call it" is a statement about the
   * line I wrote; "it cannot be reached from here" is a statement about the
   * binary. The seam hands the worker a plane with verifyJob and no promote
   * function, so there is nothing for this file to find.
   */
  const workerSrc = blankComments(readFileSync(VERIFY_BIN, 'utf8'));
  assert.equal(/promoteApproval/.test(workerSrc), false, 'the worker binary must not name promoteApproval');
  assert.equal(/integrationPlane/.test(workerSrc), false, 'nor reach the integration plane');
  assert.match(workerSrc, /workerPlane/, 'it uses the narrowed worker capability');

  const seam = blankComments(readFileSync(path.join(repoRoot, 'src', 'verificationControl.mjs'), 'utf8'));
  const workerPlaneBody = seam.slice(seam.indexOf('export function workerPlane'), seam.indexOf('export function integrationPlane'));
  assert.equal(/promote/.test(workerPlaneBody), false, 'the worker plane exposes no promotion capability');

  /* And no CLI flag can assert an identity. */
  for (const bin of [VERIFY_BIN, INTEGRATE_BIN]) {
    const src = blankComments(readFileSync(bin, 'utf8'));
    assert.equal(/actorRole|--role|integration-owner/.test(src), false, `${path.basename(bin)} must not accept a role claim`);
  }
});

test('F the three formerly orphaned modules are REACHABLE from shipped entry points', async () => {
  /*
   * ASSERTS THE POSITIVE, AND THAT CHOICE IS THE WHOLE TEST.
   *
   * The first version of this test asserted a negative -- that the modules did
   * not appear among the gate's findings. That assertion passes just as happily
   * when somebody silences the gate by adding a KNOWN entry, which is precisely
   * the shortcut this work was told not to take, so the test would have been
   * green for the forbidden outcome.
   *
   * `status === 'reachable'` cannot be produced by an allowlist. The repo's own
   * "the known list may only SHRINK" test asserts the opposite for every KNOWN
   * module, so the two cannot both be satisfied by the same entry: an allowlisted
   * module must NOT be reachable, and these must be.
   *
   * (It also read JSON.stringify of the whole result, which carries a row for
   * every module in the repo -- so every name it looked for was always present
   * and the check could only ever have failed. "Absent is not zero" has a twin:
   * present in the wrong container is not present.)
   */
  const { DEFAULT_ENTRY_POINTS, classifyModules } = await import('../src/moduleGraph.mjs');
  assert.ok(DEFAULT_ENTRY_POINTS.includes('bin/agentbridge-verify.mjs'), 'verify is a declared entry point');
  assert.ok(DEFAULT_ENTRY_POINTS.includes('bin/agentbridge-integrate.mjs'), 'integrate is a declared entry point');

  const { rows } = classifyModules(repoRoot, {});
  for (const m of [
    'src/approvalStore.mjs',
    'src/candidateTree.mjs',
    'src/jobStore.mjs',
    'src/verifier.mjs',
    'src/policy.mjs',
    'src/validationRunner.mjs',
    'src/verificationControl.mjs',
  ]) {
    const row = rows.find((r) => r.module === m);
    assert.ok(row, `${m} is missing from the module graph entirely`);
    assert.equal(row.status, 'reachable', `${m} must be reachable from a shipped entry point, not allowlisted`);
  }
});

/*
 * SKIPPED OFF POSIX, NOT FAILED. The task argv below runs /bin/sh, which does not
 * exist on Windows, so this fails there for the shell rather than for the wiring
 * it is about. Rewriting it portably is worth doing; reporting a red suite on the
 * machine the operator actually uses is not, because rule 17 is that an outage is
 * how a guard gets switched off.
 */
test('G the shipped controller binary opens a job the shipped verifier can actually verify', { skip: process.platform === 'win32' && 'the task argv uses /bin/sh' }, async (t) => {
  /*
   * THE ONE TEST THAT DRIVES THE REAL CHAIN, AND THE ONLY ONE THAT COULD HAVE
   * CAUGHT WHAT IT CAUGHT.
   *
   * Tests A-F were all green while the controller edge was dead. A calls
   * openVerificationJob directly, and every one of them builds its own candidate
   * workspace and keeps it alive -- so none could see that the attempt pipeline
   * destroys an accepted workspace before returning, leaving every real job
   * pointing at a directory that no longer existed.
   *
   * So this spawns bin/agentbridge-attempt.mjs for real -- real worktree, real
   * executor, real disposal -- and then hands the job id it printed to the real
   * verify binary. Nothing in this test creates a job, a workspace or a tree.
   */
  const repo = authoritative();
  const root = mkdtempSync(path.join(tmpdir(), 's4w-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 's4w-gstate-'));
  t.after(() => { for (const d of [repo, root, state]) rmSync(d, { recursive: true, force: true }); });

  /*
   * ABSOLUTE INTERPRETER PATHS. The executor hands the child a minimal
   * environment, so a bare `node` or `git` exits 127 and the attempt is rejected
   * for a reason that has nothing to do with what is being tested.
   */
  const NODE = process.execPath;
  const GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  const taskFile = path.join(root, 'task.json');
  writeFileSync(taskFile, JSON.stringify({
    task_id: 'wiring-g',
    base_sha: baseSha,
    /* The attempt must commit: the pipeline refuses to dispose of a dirty
     * workspace, and files_changed is read with `git diff --name-only`. */
    argv: ['/bin/sh', '-c',
      `printf 'export const v=2;\\n' > src/feature.mjs && ${GIT} add -A && ${GIT} commit -qm change && ${NODE} --test --test-reporter=tap test/baseline.test.mjs`],
    timeout_ms: 120000,
    allowed_paths: ['src/**', 'test/**'],
  }));

  const r = spawnSync(NODE, [
    path.join(repoRoot, 'bin', 'agentbridge-attempt.mjs'),
    '--task', taskFile, '--root', root, '--repo', repo,
  ], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', AGENTBRIDGE_STATE_DIR: state },
  });

  /* THE POSITIVE FIRST: an attempt that was never accepted opens no job either,
   * and that must not be allowed to read as this edge working. */
  assert.equal(r.status, 0, `the attempt itself must be accepted; stdout=${r.stdout.slice(-1200)} stderr=${r.stderr.slice(-800)}`);

  const m = r.stdout.match(/\{[^{}]*"verification"[\s\S]*$/);
  assert.ok(m, `the controller reports its verification step; stdout=${r.stdout.slice(-800)}`);
  const reported = JSON.parse(m[0]).verification;
  assert.equal(reported.error, null, 'opening the job did not fail');
  assert.match(reported.jobId ?? '', /^[0-9a-f]{32}$/, 'the controller opened a real job');

  const files = readdirSync(path.join(state, 'jobs'));
  assert.deepEqual(files, [`${reported.jobId}.json`], 'and a durable record exists in trusted state');
  const record = JSON.parse(readFileSync(path.join(state, 'jobs', files[0]), 'utf8'));
  assert.equal(record.repoRoot, path.resolve(repo), 'bound to the authoritative repo, not the candidate');
  assert.notEqual(path.resolve(record.candidateWorkspace), path.resolve(repo), 'the candidate is separate from the repo');

  /*
   * THE ASSERTION THAT FAILED BEFORE THE FIX. The recorded candidate has to
   * still exist once the pipeline has disposed of its workspace.
   */
  assert.ok(existsSync(record.candidateWorkspace), 'the recorded candidate survives disposal of the attempt workspace');
  assert.equal(existsSync(path.join(record.candidateWorkspace, 'src', 'feature.mjs')), true, 'and carries the attempt\'s work');

  /* END TO END: the job the controller opened is one the shipped verifier can run. */
  const v = runBin(VERIFY_BIN, ['--job', reported.jobId], state);
  assert.equal(v.status, 0, `the shipped verifier must reach a verdict on a real job; stderr=${v.stderr} json=${JSON.stringify(v.json)}`);
  assert.equal(v.json?.decision, 'approve');
  assert.match(v.json?.approvalId ?? '', /^[0-9a-f]{64}$/);
});

test('H a job whose repository was swapped at the same path is refused', async (t) => {
  /*
   * A PATH IS NOT AN IDENTITY, and this is the test that says so.
   *
   * THE IMPOSTOR IS CONSTRUCTED CAREFULLY, BECAUSE THE FIRST VERSION OF IT
   * PROVED NOTHING. It was a second repository built by the same fixture, so it
   * had identical content, author and message and -- created in the same second
   * -- an identical root commit. It was therefore not a different repository in
   * any sense a check could detect, and the test failed while the code was
   * right.
   *
   * A swap that is merely CORRUPT is caught already and caught cheaply: the job
   * binds an immutable baseline commit, so a replacement repository that does
   * not contain that commit cannot resolve it. That makes an arbitrary
   * different repository the easy case and the uninteresting one.
   *
   * The case that isolates this control is a repository which DOES contain the
   * baseline commit -- fetched from the original -- but which is not the
   * original: different lineage, same object present. The baseline resolves, so
   * nothing downstream objects, and the only thing that can tell them apart is
   * the identity the job bound at creation.
   */
  const s = scenario(t);
  writeFileSync(path.join(s.cand, 'src', 'feature.mjs'), 'export const v = 9;\n');
  const jobId = await openJob(s);
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.auth, encoding: 'utf8' }).trim();

  /* THE POSITIVE FIRST: this exact job verifies cleanly while untouched. */
  const before = runBin(VERIFY_BIN, ['--job', jobId], s.state);
  assert.equal(before.json?.decision, 'approve', `the job must verify before the swap; stderr=${before.stderr}`);

  /* Build the impostor: its own lineage, plus the baseline commit fetched in. */
  const impostor = mkdtempSync(path.join(tmpdir(), 's4w-impostor-'));
  const ig = (...a) => execFileSync('git', a, { cwd: impostor, stdio: 'ignore' });
  ig('init', '-q', '.'); ig('config', 'user.name', 'other'); ig('config', 'user.email', 'other@x');
  writeFileSync(path.join(impostor, 'DIFFERENT.md'), 'a different project entirely\n');
  ig('add', '-A'); ig('commit', '-qm', 'a different root commit');
  /*
   * The commit is fetched in, but HEAD STAYS ON THE IMPOSTOR'S OWN LINEAGE.
   * An earlier attempt pointed HEAD at the fetched commit, which made the
   * repository's lineage the original's -- so it was, by every definition
   * available, the same repository. Carrying an object is not the same as
   * being the project that produced it, and that gap is the whole test.
   */
  ig('fetch', '-q', s.auth, baseline);
  ig('update-ref', 'refs/borrowed/baseline', baseline);
  assert.equal(
    execFileSync('git', ['cat-file', '-t', baseline], { cwd: impostor, encoding: 'utf8' }).trim(), 'commit',
    'the impostor really does carry the baseline commit, or this proves nothing',
  );
  assert.notEqual(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: impostor, encoding: 'utf8' }).trim(), baseline,
    'while its own HEAD is a different lineage',
  );

  /* Put it at the authoritative path. */
  const original = mkdtempSync(path.join(tmpdir(), 's4w-orig-'));
  t.after(() => { for (const d of [impostor, original]) rmSync(d, { recursive: true, force: true }); });
  execFileSync('sh', ['-c', `mv ${JSON.stringify(s.auth)}/.git ${JSON.stringify(original)}/git && mv ${JSON.stringify(impostor)}/.git ${JSON.stringify(s.auth)}/.git`]);

  const after = runBin(VERIFY_BIN, ['--job', jobId], s.state);
  assert.notEqual(after.json?.decision, 'approve', 'a swapped repository must not verify');
  assert.match(String(after.json?.reason ?? ''), /repository/i, 'and it must say the repository is the problem');
  assert.equal(after.status, 1, 'and the command must not exit 0');
});
