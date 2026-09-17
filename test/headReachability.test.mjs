import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HEAD_REACHABILITY, classifyReturnedHead, canReviewReturn } from '../src/headReachability.mjs';
import { probeReturnedHead } from '../src/probeReturnedHead.mjs';

/**
 * THE ROW THAT MOTIVATED THIS, KEPT AS A FIXTURE RATHER THAN A MEMORY.
 *
 * t-wire-gate-scripts, assigned by the pg_cron dispatcher at 2026-09-17T01:12:00
 * with no human in the path, returned at 01:12:04 by danny-win-d1 with
 * returned_notes "worker: wired check:edge-deploy, deploy:check into
 * package.json / worker: committed d8c1e0e". The sha is in no remote ref and
 * the scripts are on no branch. reviewer was null: nothing looked.
 */
const THE_ROW = Object.freeze({
  task_id: 't-wire-gate-scripts',
  base_sha: '6b05f1c557198fb568fd39186fe5f9564a9d6237',
  returned_head_sha: 'd8c1e0ee7db2f45156e03794949e0753fafb7362',
  returned_notes: 'worker: wired check:edge-deploy, deploy:check into package.json\nworker: committed d8c1e0e',
});

const FETCHED_AND_ABSENT = Object.freeze({ ran: true, existsLocally: false, remoteRefs: [] });

/* ── the regression, both directions ──────────────────────────────────── */

test('THE POSITIVE FIRST: a commit on a remote ref is reviewable', () => {
  const found = classifyReturnedHead({
    task: { ...THE_ROW, returned_head_sha: 'a'.repeat(40) },
    probe: { ran: true, existsLocally: true, remoteRefs: ['origin/master'] },
  });
  assert.equal(found.reachability, HEAD_REACHABILITY.REACHABLE);
  assert.equal(found.reviewable, true, 'the check refuses everything, which proves nothing');
});

test('t-wire-gate-scripts IS REFUSED, AND NAMED UNPUSHED RATHER THAN MISSING', () => {
  const found = classifyReturnedHead({ task: THE_ROW, probe: FETCHED_AND_ABSENT });
  assert.equal(found.reachability, HEAD_REACHABILITY.UNPUSHED);
  assert.equal(found.reviewable, false);
  assert.match(found.reason, /d8c1e0ee7db2/, 'the refusal does not name the commit it is about');
  assert.match(found.reason, /no remote ref/);
});

test('THE PROXY TRAP: EXISTING LOCALLY IS NOT BEING REACHABLE', () => {
  /*
   * The case that makes this module worth having. `git cat-file -t` says
   * "commit" on the machine that authored it, so a check built on existence
   * passes on its own motivating row when run by its own author. Reachability
   * from a remote ref is a different question and this asserts the difference.
   */
  const found = classifyReturnedHead({
    task: THE_ROW,
    probe: { ran: true, existsLocally: true, remoteRefs: [] },
  });
  assert.equal(found.reachability, HEAD_REACHABILITY.UNPUSHED,
    'a commit present in this clone but on no remote ref was treated as reviewable');
  assert.match(found.reason, /only that this machine has it/);
});

/* ── the refusals that are not the same refusal ───────────────────────── */

test('A RETURN THAT NAMES NO COMMIT IS ABSENT, NOT UNPUSHED', () => {
  for (const head of [null, '', '   ', undefined]) {
    const found = classifyReturnedHead({ task: { ...THE_ROW, returned_head_sha: head }, probe: FETCHED_AND_ABSENT });
    assert.equal(found.reachability, HEAD_REACHABILITY.ABSENT, `head ${JSON.stringify(head)}`);
  }
});

test('AN ABBREVIATED SHA IS MALFORMED AND SAYS WHY AN ABBREVIATION IS NOT ENOUGH', () => {
  const found = classifyReturnedHead({ task: { ...THE_ROW, returned_head_sha: 'd8c1e0e' }, probe: FETCHED_AND_ABSENT });
  assert.equal(found.reachability, HEAD_REACHABILITY.MALFORMED);
  assert.match(found.reason, /ambiguous/);
});

test('RETURNING THE BASE IS UNMOVED, AND IS CHECKED BEFORE THE PROBE CAN BLESS IT', () => {
  /*
   * The base is reachable by definition -- it is what the worker was told to
   * start from -- so a probe answers REACHABLE and a check that trusted the
   * probe would call "committed nothing" a good review. The probe here says
   * exactly that, and the verdict must still be UNMOVED.
   */
  const found = classifyReturnedHead({
    task: { ...THE_ROW, returned_head_sha: THE_ROW.base_sha },
    probe: { ran: true, existsLocally: true, remoteRefs: ['origin/master'] },
  });
  assert.equal(found.reachability, HEAD_REACHABILITY.UNMOVED);
  assert.equal(found.reviewable, false, 'an attempt that committed nothing was called reviewable');
});

/* ── the unknown case, which is where a hollow gate would live ────────── */

test('A PROBE THAT DID NOT RUN REFUSES, AND SAYS IT IS REFUSING BLIND', () => {
  for (const probe of [null, undefined, {}, { ran: false, error: 'network down' }]) {
    const found = classifyReturnedHead({ task: THE_ROW, probe });
    assert.equal(found.reachability, HEAD_REACHABILITY.UNKNOWN, `probe ${JSON.stringify(probe)}`);
    assert.equal(found.reviewable, false);
  }
  assert.match(
    classifyReturnedHead({ task: THE_ROW, probe: { ran: false, error: 'network down' } }).reason,
    /network down/,
    'the probe error was swallowed, so nobody can tell why it could not run',
  );
});

test('ASKED-AND-NONE AND NOBODY-ASKED MUST NOT READ THE SAME', () => {
  /*
   * [] is a finding. A missing list is a caller that forgot. Collapsing them is
   * how a forgetful caller gets a clean bill of health -- or, in the other
   * direction, how a working remote gets accused.
   */
  const asked = classifyReturnedHead({ task: THE_ROW, probe: { ran: true, existsLocally: false, remoteRefs: [] } });
  const nobody = classifyReturnedHead({ task: THE_ROW, probe: { ran: true, existsLocally: false } });
  assert.equal(asked.reachability, HEAD_REACHABILITY.UNPUSHED);
  assert.equal(nobody.reachability, HEAD_REACHABILITY.UNKNOWN);
  assert.notEqual(asked.reachability, nobody.reachability);
});

test('canReviewReturn CARRIES THE REASON, BECAUSE A BARE FALSE IS UNACTIONABLE', () => {
  const no = canReviewReturn({ task: THE_ROW, probe: FETCHED_AND_ABSENT });
  assert.equal(no.ok, false);
  assert.equal(no.reachability, HEAD_REACHABILITY.UNPUSHED);
  assert.ok(no.reason.length > 40, 'the refusal reason is too short to act on');
});

/* ── real git, because the fixtures above are my own model of it ──────── */

test('REAL GIT: THE SAME COMMIT REFUSES UNPUSHED AND PASSES ONCE PUSHED', async (t) => {
  /*
   * A RED NOBODY HAS SHOWN CAN GO GREEN IS A COUNTDOWN, NOT A RATCHET. One
   * commit, one probe, two answers, with a `git push` as the only thing that
   * changed between them. This is also the only test here that can catch me
   * modelling git wrongly in every fixture above.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'reach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

  execFileSync('git', ['init', '--bare', '-b', 'master', bare], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'master', work], { stdio: 'pipe' });
  g(work, 'config', 'user.email', 'a@example.invalid');
  g(work, 'config', 'user.name', 'reachability test');
  g(work, 'remote', 'add', 'origin', bare);
  await writeFile(path.join(work, 'base.txt'), 'base\n');
  g(work, 'add', 'base.txt');
  g(work, 'commit', '-m', 'base');
  const baseSha = g(work, 'rev-parse', 'HEAD');
  g(work, 'push', '-u', 'origin', 'master');

  await writeFile(path.join(work, 'work.txt'), 'the work\n');
  g(work, 'add', 'work.txt');
  g(work, 'commit', '-m', 'the work a return would claim');
  const headSha = g(work, 'rev-parse', 'HEAD');

  const task = { task_id: 't-real', base_sha: baseSha, returned_head_sha: headSha };

  /* Committed, not pushed -- exactly the shape t-wire-gate-scripts is in. */
  const before = probeReturnedHead(headSha, { cwd: work });
  assert.equal(before.existsLocally, true, 'precondition: git lost the commit it just made');
  const refused = classifyReturnedHead({ task, probe: before });
  assert.equal(refused.reachability, HEAD_REACHABILITY.UNPUSHED,
    'a real, freshly committed, unpushed commit was not caught');

  /* The one thing that changes. */
  g(work, 'push', 'origin', 'master');
  const after = probeReturnedHead(headSha, { cwd: work });
  const allowed = classifyReturnedHead({ task, probe: after });
  assert.equal(allowed.reachability, HEAD_REACHABILITY.REACHABLE,
    'a pushed commit is still refused, so the demand this gate makes is unreachable');
  assert.deepEqual(after.remoteRefs, ['origin/master']);
});

test('REAL GIT: A PROBE THAT CANNOT FETCH REPORTS UNKNOWN, NOT UNPUSHED', async (t) => {
  /*
   * The offline reviewer. Pointing the remote at a path that does not exist
   * makes the fetch fail for real rather than by stubbing, and the probe must
   * decline to conclude -- otherwise every reviewer with a broken network
   * becomes a generator of false accusations against working workers.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'reach-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const g = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-b', 'master', work], { stdio: 'pipe' });
  g('config', 'user.email', 'a@example.invalid');
  g('config', 'user.name', 'reachability test');
  g('remote', 'add', 'origin', path.join(root, 'does-not-exist.git'));
  await writeFile(path.join(work, 'f.txt'), 'x\n');
  g('add', 'f.txt');
  g('commit', '-m', 'only commit');
  const sha = g('rev-parse', 'HEAD');

  const probe = probeReturnedHead(sha, { cwd: work });
  assert.equal(probe.ran, false, 'a failed fetch was reported as a completed probe');
  const found = classifyReturnedHead({ task: { base_sha: 'b'.repeat(40), returned_head_sha: sha }, probe });
  assert.equal(found.reachability, HEAD_REACHABILITY.UNKNOWN,
    'an unreachable REMOTE was reported as an unpushed COMMIT, which blames the wrong party');
});
