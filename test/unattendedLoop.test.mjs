import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runAttempt } from '../src/attemptPipeline.mjs';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { run as execRun } from '../src/exec.mjs';
import { createFakeReviewer } from './fakeReviewer.mjs';
import { createLoopState } from '../src/loopDetector.mjs';
import { createReadCache } from '../src/readCache.mjs';
import { isInside } from '../src/workspaceManager.mjs';

/**
 * THE ACCEPTANCE TEST FOR "ZERO INTERACTIVE PROMPTS", RUN FOR REAL.
 *
 * Every other test in this repository injects the runner, the git layer or the
 * workspace. This one does not: a real repository on disk, a real child
 * process, real git, real commits. It is slower and it is the only test here
 * that can fail for a reason the mocks agree is impossible.
 *
 * WHAT IT ASSERTS IS NOT "THE AGENT WORKED". It is that a task which reads
 * files, edits files, runs a test, stages and commits, with nobody at a
 * keyboard, produces a commit and reaches a verdict WITHOUT ANY PROCESS EVER
 * WAITING FOR INPUT. The failure it exists to catch is the one from the
 * screenshot: a worker sitting on "Do you want to proceed?" until its lease
 * expires, on a machine nobody is watching.
 *
 * AND IT ASSERTS THE OPPOSITE DIRECTION IN THE SAME FILE. A gate that only ever
 * sees the good case cannot distinguish "no prompt happened" from "prompts are
 * invisible to me", so the second scenario runs an agent that DOES prompt and
 * requires the attempt to fail with the prompt named. A negative needs the
 * positive first, and this is the positive.
 */

const git = async (cwd, ...args) => {
  const r = await execRun('git', args, { cwd, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
};

/** A repository with one commit, and the identity git needs to make another. */
async function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'unattended-'));
  await git(dir, 'init', '--quiet', '-b', 'work/t1');
  await git(dir, 'config', 'user.email', 'harness@example.invalid');
  await git(dir, 'config', 'user.name', 'harness');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'value.txt'), '1\n');
  writeFileSync(path.join(dir, 'check.mjs'),
    "import {readFileSync} from 'node:fs';\n" +
    "const v = Number(readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim());\n" +
    // a real node --test summary shape: parseTestSummary requires `# tests` too,
    // and returns null without it, which is correct -- absent is not zero
    "console.log(v === 2 ? '# tests 1\\n# pass 1\\n# fail 0' : '# tests 1\\n# pass 0\\n# fail 1');\n" +
    'process.exit(v === 2 ? 0 : 1);\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', 'base');
  return { dir, sha: await git(dir, 'rev-parse', 'HEAD') };
}

/**
 * The workspace manager, wired to the real repository rather than mocked.
 * runAttempt only needs create/destroy/quarantine, and using the task's own
 * directory keeps this about the loop rather than about worktree plumbing.
 */
const workspacesFor = (dir) => ({
  create: async () => ({ path: dir, id: 'ws' }),
  destroy: async () => ({ ok: true, reason: 'kept by the harness' }),
  quarantine: async () => dir,
});

test('AN UNATTENDED TASK READS, EDITS, TESTS AND COMMITS WITH NO PROMPT', async (t) => {
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /*
   * A real agent: reads a file, edits it, runs the check, stages and commits.
   * Everything a coding task does and nothing that needs a person.
   *
   * IT LIVES OUTSIDE THE WORKSPACE, and the first run of this test is why. With
   * the script inside the repository the agent committed itself, the path
   * contract reported a violation for `agent.mjs`, and the attempt was
   * correctly refused. The contract was right and the harness was wrong -- an
   * executor's own binary is not part of the tree it is working on.
   */
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'agent.mjs');
  writeFileSync(agent, `
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const cwd = process.cwd();
const v = Number(readFileSync(cwd + '/value.txt', 'utf8').trim());
writeFileSync(cwd + '/value.txt', String(v + 1) + '\\n');
const out = execFileSync(process.execPath, [cwd + '/check.mjs'], {cwd, encoding: 'utf8'});
process.stdout.write(out);
execFileSync('git', ['add', '-A'], {cwd});
execFileSync('git', ['commit', '--quiet', '-m', 'raise the value'], {cwd});
`);

  const result = await runAttempt({
    task: {
      task_id: 't1-unattended', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 60000,
      // THE EXECUTOR HANDS THE CHILD ONLY WHAT THE SPEC NAMES, on purpose: an
      // agent that inherits the daemon's environment inherits its credentials.
      // So a task that shells out to git has to say so. The first run of this
      // test failed with exit 1 for exactly that reason, which is the design
      // working rather than a defect.
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      commands: [{ file: 'git', args: ['add', '-A'] }, { file: 'git', args: ['commit', '-m', 'x'] }],
    },
    contract: { allowed: ['value.txt'], forbidden: [] },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    io: {
      now: () => Date.now(),
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => (await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
      },
    },
  });

  assert.notEqual(result.verdict, undefined, `blocked before running: ${JSON.stringify(result.blocked ?? null)}`);
  assert.equal(result.envelope.outcome, 'exited', `outcome was ${result.envelope.outcome}`);
  assert.equal(result.envelope.exitCode, 0);

  // the work actually happened, in git rather than in a report
  assert.notEqual(result.envelope.commit, sha, 'no new commit was produced');
  assert.equal(readFileSync(path.join(dir, 'value.txt'), 'utf8').trim(), '2');
  assert.deepEqual(result.envelope.filesChanged, ['value.txt']);
  assert.deepEqual(result.envelope.tests, { passed: 1, failed: 0, skipped: 0, total: 1 });

  // and the whole point: nobody was asked anything
  assert.equal(result.verdict.verdict, 'accept', `rejected: ${result.verdict.reasons.join(', ')}`);
});

test('AND AN AGENT THAT ASKS FAILS THE ATTEMPT INSTEAD OF WAITING', async (t) => {
  /*
   * The negative, and it needs the positive above to mean anything: a harness
   * that cannot see a prompt would pass the first test for the wrong reason.
   * This agent prints a prompt and would, with an open standard input, sit
   * there until the lease expired.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'asks.mjs');
  writeFileSync(agent, `
process.stdout.write('Do you want to proceed? [y/n] ');
let answer = '';
process.stdin.on('data', (d) => { answer += d; });
process.stdin.on('end', () => { process.exit(0); });
`);

  const started = Date.now();
  const result = await runAttempt({
    task: {
      task_id: 't1-asks', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 30000,
      argv: [process.execPath, agent],
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    io: { now: () => Date.now(), git: { headSha: async () => git(dir, 'rev-parse', 'HEAD') } },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.envelope.outcome, 'prompted', 'a prompt was reported as an ordinary run');
  assert.equal(result.verdict.verdict, 'reject');
  assert.ok(result.verdict.reasons.includes('outcome:prompted'));
  assert.equal(result.accepted, false);
  assert.ok(elapsed < 15000, `waited ${elapsed}ms: the run hung instead of failing`);
  assert.equal(result.disposal.outcome, 'quarantined', 'a refused attempt must not destroy its evidence');
});

test('THE REVIEWER HALF RUNS TOO, AND BOTH SIDES HAVE TO AGREE', async (t) => {
  /*
   * The second half of T1, which has never run. A reviewer reads the packet,
   * decides from evidence, and the attempt is accepted only if the machine and
   * the reviewer agree. Asserted in both directions in one test, because a
   * review stage proven only to accept is decoration and one proven only to
   * reject is an outage.
   */
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'agent.mjs');
  writeFileSync(agent, `
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const cwd = process.cwd();
const v = Number(readFileSync(cwd + '/value.txt', 'utf8').trim());
writeFileSync(cwd + '/value.txt', String(v + 1) + '\\n');
process.stdout.write(execFileSync(process.execPath, [cwd + '/check.mjs'], {cwd, encoding: 'utf8'}));
execFileSync('git', ['add', '-A'], {cwd});
execFileSync('git', ['commit', '--quiet', '-m', 'raise the value'], {cwd});
`);

  /*
   * A FRESH REPOSITORY PER ATTEMPT, and the first version of this test is why.
   * Reusing one tree meant the second run raised the value from 2 to 3, the
   * check correctly failed, and the machine rejected -- so the case meant to
   * isolate the REVIEWER was being refused by the evidence instead. An attempt
   * starts from the accepted base; that is the retry invariant, and a harness
   * that ignores it tests something else.
   */
  const attempt = async (reviewer) => {
    const fresh = await scratchRepo();
    t.after(() => rmSync(fresh.dir, { recursive: true, force: true }));
    return attemptIn(fresh, reviewer);
  };
  const attemptIn = ({ dir, sha }, reviewer) => runAttempt({
    task: {
      task_id: 't1-reviewed', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 60000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
    },
    contract: { allowed: ['value.txt'], forbidden: [] },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    reviewer,
    io: {
      now: () => Date.now(),
      diffRef: 'cas:diff',
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => (await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
      },
    },
  });

  const accepted = await attempt(createFakeReviewer());
  assert.equal(accepted.envelope.outcome, 'exited');
  assert.equal(accepted.verdict.verdict, 'accept', accepted.verdict.reasons.join(', '));
  assert.equal(accepted.review.decision, 'accept',
    `reviewer refused a good attempt: ${accepted.review.findings.join(', ')}`);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.disposal.outcome, 'destroyed');

  /*
   * THE OTHER DIRECTION, ON EVIDENCE THE MACHINE IS HAPPY WITH. A policy the
   * attempt genuinely fails -- one file changed against a two-file minimum --
   * so the reviewer is the only thing refusing it. That is the case that proves
   * a reviewer can actually stop an attempt rather than rubber-stamping one the
   * machine had already passed.
   */
  const refused = await attempt(createFakeReviewer({ maxFilesChanged: 0 }));
  assert.equal(refused.verdict.verdict, 'accept', 'the machine still accepts; only the reviewer objects');
  assert.equal(refused.review.decision, 'request-changes');
  assert.ok(refused.review.findings.some((f) => f.startsWith('policy:too-many-files')));
  assert.equal(refused.accepted, false, 'a reviewer that cannot refuse is decoration');
  assert.equal(refused.disposal.outcome, 'quarantined');
});

test('A WORKER KILLED MID-RUN PRODUCES NO COMMIT AND NO VERDICT OF SUCCESS', async (t) => {
  /*
   * The first kill-at-a-boundary case. The process is shot at its deadline
   * after it has already written to the tree, which is the state a crashed
   * worker really leaves: a half-finished workspace that git will happily
   * report a sha from.
   *
   * NOTHING MAY REPORT A COMMIT HERE. The evidence collector asks git only when
   * the process exited, precisely so a killed run cannot acquire a
   * plausible-looking result from a tree nobody chose to leave that way.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'hangs.mjs');
  writeFileSync(agent, `
import {writeFileSync} from 'node:fs';
writeFileSync(process.cwd() + '/value.txt', '99\\n');
setInterval(() => {}, 1000);
`);

  const result = await runAttempt({
    task: {
      task_id: 't1-killed', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 1500,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    reviewer: createFakeReviewer(),
    io: {
      now: () => Date.now(),
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => ['value.txt'],
      },
    },
  });

  assert.equal(result.envelope.outcome, 'timeout');
  assert.equal(result.envelope.exitCode, null, 'a killed process has no exit code, and zero is not none');
  assert.equal(result.envelope.commit, null, 'a sha was read out of a half-written tree');
  assert.equal(result.verdict.verdict, 'reject');
  assert.ok(result.verdict.reasons.includes('outcome:timeout'));
  assert.equal(result.accepted, false);
  assert.equal(result.disposal.outcome, 'quarantined', 'the evidence of a killed run was thrown away');

  // the tree really was left half-written: the assertion above is about what we
  // REPORT, not about the mess being absent
  assert.equal(readFileSync(path.join(dir, 'value.txt'), 'utf8').trim(), '99');
});

test('THE ATTEMPT IS DURABLE BEFORE THE WORK RUNS, AND CARRIES ALL FOUR VERDICTS', async (t) => {
  /*
   * The record existed and nothing ever wrote one. Routing and environment
   * identity is the part that cannot be filled in afterwards -- engine, model,
   * slot, lease, fence, base sha, runtime and executor versions can only be
   * observed while the attempt is being created. So the row is written BEFORE
   * the executor starts, and a crash after that point leaves something behind
   * saying what was running. A record written at the end describes only the
   * attempts that survived to write one, which is the set that needed no record.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'agent.mjs');
  writeFileSync(agent, `
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const cwd = process.cwd();
const v = Number(readFileSync(cwd + '/value.txt', 'utf8').trim());
writeFileSync(cwd + '/value.txt', String(v + 1) + '\\n');
process.stdout.write(execFileSync(process.execPath, [cwd + '/check.mjs'], {cwd, encoding: 'utf8'}));
execFileSync('git', ['add', '-A'], {cwd});
execFileSync('git', ['commit', '--quiet', '-m', 'raise the value'], {cwd});
`);

  const written = [];
  const records = {
    start: async (r) => { written.push(['start', r]); },
    finish: async (r) => { written.push(['finish', r]); },
  };

  const result = await runAttempt({
    task: {
      task_id: 't1-recorded', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 60000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      context_digest: 'a'.repeat(64),
      routing: {
        engine: 'local', model: 'none', roleProfile: 'builder',
        workerSlotId: 'slot-1', sessionId: 'sess-1', leaseId: 'lease-1',
        fenceToken: '1', repo: 'agentbridge', baseSha: sha,
        taskClass: 'code', riskClass: 'routine', environmentDigest: 'b'.repeat(64),
      },
    },
    contract: { allowed: ['value.txt'], forbidden: [] },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    reviewer: createFakeReviewer(),
    records,
    io: {
      now: () => Date.now(),
      records,
      diffRef: 'cas:diff',
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => (await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
      },
    },
  });

  assert.deepEqual(written.map((w) => w[0]), ['start', 'finish'], 'the row must exist before the work');
  const [, started] = written[0];
  assert.equal(started.state, 'running', 'the first row describes an attempt in flight, not a finished one');
  assert.equal(started.engine, 'local');
  assert.equal(started.leaseId, 'lease-1');
  assert.equal(started.fenceToken, '1');
  assert.equal(started.baseSha, sha, 'the base is recorded, so a retry can start from it');
  assert.equal(started.finishedAt, null);

  // all four verdicts, in four fields, never collapsed into one status
  const done = result.record;
  assert.equal(done.agentClaimedSuccess, true, "what the work said about itself");
  assert.equal(done.verificationVerdict, 'verified', 'what the machine observed');
  assert.equal(done.reviewVerdict, 'accept', 'what the reviewer decided');
  assert.equal(done.finalState, 'done', 'what the task became');
  assert.equal(done.resultSha, result.envelope.commit);
  assert.equal(Object.prototype.hasOwnProperty.call(done, 'status'), false, 'never a status column');
});

test('A FALSE DONE IS VISIBLE: THE AGENT CLAIMED SUCCESS AND THE MACHINE DID NOT', async (t) => {
  /*
   * The case the four columns exist for. The agent exits zero having changed
   * nothing and committed nothing, so its own claim is success and verification
   * rejects. A single status column would keep one of those and throw away the
   * disagreement, which IS the signal.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'liar.mjs');
  writeFileSync(agent, "process.stdout.write('# tests 1\\n# pass 1\\n# fail 0\\nAll done!');process.exit(0);");

  const written = [];
  const records = { start: async (r) => written.push(r), finish: async (r) => written.push(r) };

  const result = await runAttempt({
    task: {
      task_id: 't1-false-done', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 30000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      context_digest: 'a'.repeat(64),
      routing: {
        engine: 'local', model: 'none', roleProfile: 'builder',
        workerSlotId: 'slot-1', sessionId: 'sess-1', leaseId: 'lease-1',
        fenceToken: '1', repo: 'agentbridge', baseSha: sha,
        taskClass: 'code', riskClass: 'routine', environmentDigest: 'b'.repeat(64),
      },
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    reviewer: createFakeReviewer(),
    records,
    io: {
      now: () => Date.now(),
      records,
      git: { headSha: async () => sha, changedFiles: async () => [] },
    },
  });

  assert.equal(result.record.agentClaimedSuccess, true, 'it exited zero and said All done');
  assert.equal(result.record.verificationVerdict, 'rejected', 'and produced no commit');
  assert.equal(result.record.finalState, 'failed');
  assert.notEqual(result.record.failureCode, null, 'a failure with no code cannot be grouped later');
  assert.equal(result.accepted, false);
});

test('THE CONTEXT DIGEST IS COMPUTED, AND A CALLER\'S CLAIM DOES NOT WIN', async (t) => {
  /*
   * The loop detector compares context digests to decide whether a retry saw
   * the same prompt. If the caller supplies that digest it is a CLAIM, and a
   * retry that quietly sent less context still compares identical -- which is
   * precisely the case the comparison exists to catch.
   *
   * So this task hands in a digest that is deliberately wrong AND the files it
   * was supposedly computed from. The record must carry what was actually
   * assembled.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'noop.mjs');
  writeFileSync(agent, "process.stdout.write('# tests 1\\n# pass 1\\n# fail 0');process.exit(0);");

  const LIE = 'f'.repeat(64);
  let saved = null;
  const records = { start: async (r) => { saved = r; }, finish: async () => {} };

  await runAttempt({
    task: {
      task_id: 't1-context', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 30000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      context_digest: LIE,
      context_files: [{ path: 'value.txt', load: async () => '1\n' }],
      routing: {
        engine: 'local', model: 'none', roleProfile: 'builder',
        workerSlotId: 'slot-1', sessionId: 'sess-1', leaseId: 'lease-1',
        fenceToken: '1', repo: 'agentbridge', baseSha: sha,
        taskClass: 'code', riskClass: 'routine', environmentDigest: 'b'.repeat(64),
      },
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    records,
    io: { now: () => Date.now(), records, git: { headSha: async () => sha, changedFiles: async () => [] } },
  });

  assert.notEqual(saved, null, 'no attempt row was written');
  assert.notEqual(saved.contextDigest, LIE, "the caller's claim was recorded as fact");
  assert.match(saved.contextDigest, /^[0-9a-f]{64}$/);
});

test('A REPEATED FAILURE IS CAUGHT AS A LOOP EVEN THOUGH THE CONTEXT DIGEST MOVED', async (t) => {
  /*
   * A DECISION PINNED, BECAUSE THE OBVIOUS IMPROVEMENT WOULD BREAK IT.
   *
   * The attempt fingerprint covers task, base, files changed, outcome, exit
   * code, test counts and the normalised failure. It does NOT cover the context
   * digest, and now that the pipeline computes one, adding it looks like an
   * upgrade: two attempts are "the same" only if they were given the same
   * thing.
   *
   * It would disable loop detection completely. The context compiler sends an
   * unchanged file as a reference on the second read, so the sent form -- and
   * therefore the digest -- differs between attempt one and attempt two BY
   * DESIGN. A fingerprint including it never repeats, `observe` never fires,
   * and an agent burns every attempt it has on the identical failure while the
   * detector reports nothing. Silent, and exactly backwards.
   *
   * So this test asserts both halves: the digests really do differ, and the
   * loop is caught anyway.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'fails.mjs');
  // fails the same way every time, which is what a stuck agent looks like
  writeFileSync(agent, "process.stderr.write('TypeError: cannot read x of undefined');process.exit(3);");

  const cache = createReadCache();
  const rows = [];
  const records = { start: async (r) => rows.push(r), finish: async () => {} };
  let loopState = createLoopState();

  const once = (attemptNo) => runAttempt({
    task: {
      task_id: 't1-loops', base_sha: sha, branch: 'work/t1', attempt: attemptNo,
      lease_ms: 120000, timeout_ms: 30000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      context_files: [{ path: 'value.txt', load: async () => '1\n' }],
      routing: {
        engine: 'local', model: 'none', roleProfile: 'builder',
        workerSlotId: 'slot-1', sessionId: 'sess-1', leaseId: 'lease-1',
        fenceToken: '1', repo: 'agentbridge', baseSha: sha,
        taskClass: 'code', riskClass: 'routine', environmentDigest: 'b'.repeat(64),
      },
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    loopState,
    io: {
      now: () => Date.now(), records, readCache: cache,
      git: { headSha: async () => sha, changedFiles: async () => [] },
    },
  });

  const first = await once(0);
  loopState = first.loopState;
  const second = await once(1);
  loopState = second.loopState;

  assert.equal(first.envelope.outcome, 'exited');
  assert.equal(first.envelope.exitCode, 3);
  assert.equal(first.fingerprint, second.fingerprint, 'the same failure fingerprinted differently');

  /*
   * TWO IS NOT YET A LOOP, and the threshold of three is a judgement worth
   * pinning from both sides: two identical failures can be one flaky thing
   * happening twice, and declaring a loop there burns an attempt an agent might
   * have needed. A test that only checks the firing side would pass just as
   * happily against a detector that fires on the first failure.
   */
  assert.equal(second.loop, null, 'two identical failures were called a loop');

  const third = await once(2);
  assert.equal(third.fingerprint, first.fingerprint);

  // the premise: the context digest really did move across the attempts
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0].contextDigest, rows[1].contextDigest,
    'the dedupe did not kick in, so this test is not exercising what it claims');

  // and the loop is caught regardless of that
  assert.notEqual(third.loop, null, 'three identical failures were not recognised as a loop');
  assert.equal(third.loop.kind, 'repeat');
  assert.equal(third.loop.count, 3);
});

/* ── THE REVIEW STAGE, ON A REAL WORKTREE AND A REAL LEASE ───────────── */

/*
 * Everything above proves an attempt runs unattended. These prove the half that
 * follows it, and they belong in this file for the reason this file exists: the
 * reviewer runtime's unit tests inject the workspace and the git layer, so they
 * cannot catch a reviewer that edits a tree git actually reports on, and they
 * cannot catch a worktree that was never fresh.
 *
 * REAL: the repository, the child process, git, `git worktree add`, the commit
 * the review is based on, and the porcelain status that catches a meddler.
 * MODELLED: the database, by test/fakeBridge.mjs, which is a model of the SQL
 * and not the SQL. Nothing here is evidence that a migration is applied.
 */

const workspaceManagerFor = async (repoDir, root) => {
  const { createWorkspaceManager } = await import('../src/workspaceManager.mjs');
  const { mkdir, rename, rm, stat, writeFile } = await import('node:fs/promises');
  return createWorkspaceManager({
    root,
    git: {
      addWorktree: ({ path: p, baseSha, detach }) =>
        git(repoDir, 'worktree', 'add', ...(detach ? ['--detach'] : []), p, baseSha),
      removeWorktree: ({ path: p, force }) =>
        git(repoDir, 'worktree', 'remove', ...(force ? ['--force'] : []), p).catch(() => {}),
      isDirty: async (p) => (await execRun('git', ['status', '--porcelain'], { cwd: p, timeoutMs: 20000 }))
        .stdout.trim().length > 0,
    },
    fs: {
      exists: (p) => stat(p).then(() => true).catch(() => false),
      mkdirp: (p) => mkdir(p, { recursive: true }),
      rename,
      writeFile: (p, body) => writeFile(p, body),
      rm: (p) => rm(p, { recursive: true, force: true }),
    },
  });
};

/** The real git probe the CLI uses: both halves must answer or the photo is null. */
const realWorkspaceGit = {
  async headSha(p) {
    const r = await execRun('git', ['rev-parse', 'HEAD'], { cwd: p, timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.stderr || r.error);
    return r.stdout.trim();
  },
  async dirtyFiles(p) {
    const r = await execRun('git', ['status', '--porcelain'], { cwd: p, timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.stderr || r.error);
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  },
};

/** Run the attempt from the tests above, and hand back its envelope. */
const attemptForReview = async (t) => {
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'agent.mjs');
  writeFileSync(agent, `
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const cwd = process.cwd();
const v = Number(readFileSync(cwd + '/value.txt', 'utf8').trim());
writeFileSync(cwd + '/value.txt', String(v + 1) + '\\n');
process.stdout.write(execFileSync(process.execPath, [cwd + '/check.mjs'], {cwd, encoding: 'utf8'}));
execFileSync('git', ['add', '-A'], {cwd});
execFileSync('git', ['commit', '--quiet', '-m', 'raise the value'], {cwd});
`);
  const result = await runAttempt({
    task: {
      task_id: 't1-for-review', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 60000,
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      // the agent's own account of itself, which no decision below may read
      },
    contract: { allowed: ['value.txt'], forbidden: [] },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    io: {
      now: () => Date.now(),
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => (await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
      },
    },
  });
  assert.equal(result.envelope.outcome, 'exited', 'the attempt this review depends on did not run');
  assert.notEqual(result.envelope.commit, null, 'the attempt produced no commit to review');

  /*
   * A REAL REMOTE, AND THE ATTEMPT'S COMMIT PUSHED TO IT.
   *
   * These repos had no remote at all, so the reachability gate answered UNKNOWN
   * for them -- correctly: with nothing to fetch from, "unpushed" and "my clone
   * is stale" cannot be told apart. Giving them one makes the test say more
   * than it did before, not less: the reviewer now reviews a commit a second
   * machine could fetch, which is the property the gate exists to require.
   */
  const bare = mkdtempSync(path.join(tmpdir(), 'reviewremote-')) + '/remote.git';
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'master', bare], { stdio: 'pipe' });
  t.after(() => rmSync(path.dirname(bare), { recursive: true, force: true }));
  await git(dir, 'remote', 'add', 'origin', bare);
  await git(dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/master');

  return { dir, sha, result };
};

test('A RETURNED TASK IS REVIEWED IN A FRESH WORKTREE AND ACCEPTED ON THE LEASE', async (t) => {
  const { runReview } = await import('../src/reviewRunner.mjs');
  const { REVIEW_DECISION } = await import('../src/reviewDecision.mjs');
  const { createFakeBridge } = await import('./fakeBridge.mjs');

  const { dir, sha, result } = await attemptForReview(t);
  const head = result.envelope.commit;

  const root = mkdtempSync(path.join(tmpdir(), 'reviewroot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = await workspaceManagerFor(dir, root);

  const task = {
    task_id: 't1-for-review', state: 'returned', lane_id: 'agentbridge',
    base_sha: sha, returned_by: 'worker-session',
    returned_head_sha: head, attempt: 1, depends_on: [],
  };
  const bridge = createFakeBridge({ tasks: [task] });

  let reviewedIn = null;
  const review = await runReview({
    task,
    reviewerSession: 'reviewer-session',
    reviewer: {
      id: 'reads-the-tree',
      async review(packet, { path: p, readOnly }) {
        reviewedIn = { p, readOnly, value: readFileSync(path.join(p, 'value.txt'), 'utf8').trim() };
        return { reviewer: 'reads-the-tree', decision: 'accept', findings: [] };
      },
    },
    workspaces,
    bridge,
    envelopeFor: async () => result.envelope,
    repoPath: dir,
    contract: { allowed: ['value.txt'], forbidden: [] },
    io: { workspaceGit: realWorkspaceGit, now: () => Date.now() },
  });

  assert.equal(review.ok, true, `${review.stage}/${review.reason}: ${review.detail}`);
  assert.equal(review.decision.decision, REVIEW_DECISION.ACCEPT, review.decision.reasons.join(', '));

  /*
   * THE WORKTREE WAS REAL AND IT WAS FRESH. Not asserted from the return value:
   * the reviewer read a file out of it, the path is under the review root and
   * not the worker's directory, and the content is the committed value rather
   * than whatever the worker's tree happened to hold.
   */
  assert.notEqual(reviewedIn, null, 'the reviewer never ran');
  assert.equal(reviewedIn.readOnly, true);
  /*
   * isInside, NOT startsWith. Two reasons, and the second is the one that bit.
   * A raw prefix test says `/work/ab-evil` is inside `/work/ab`, which is the
   * trap workspaceManager's header is written about -- asserting containment
   * with the naive check here while the module refuses it there is how a test
   * agrees with a bug. And `root` comes from mkdtemp, so on Windows it arrives
   * with backslashes while a resolved workspace path uses forward slashes;
   * startsWith compared the two spellings and failed on a path that was
   * genuinely contained.
   */
  assert.ok(isInside(root, reviewedIn.p), `reviewed in ${reviewedIn.p}, which is not a fresh workspace`);
  assert.notEqual(reviewedIn.p, dir, 'the reviewer was handed the worker\'s own tree');
  assert.equal(reviewedIn.value, '2', 'the review workspace is not at the reviewed commit');

  // and the far end moved
  assert.equal(bridge.rows.get('t1-for-review').state, 'accepted');
  assert.equal(bridge.rows.get('t1-for-review').accepted_head_sha, head);
  assert.equal(review.disposal.outcome, 'destroyed');
  assert.equal(existsSync(reviewedIn.p), false, 'the review workspace was left behind');
});

test('A REVIEWER THAT COMMITS IN ITS OWN WORKTREE IS CAUGHT BY GIT, NOT BY TRUST', async (t) => {
  /*
   * THE NEGATIVE, AND IT NEEDS THE POSITIVE ABOVE. "No mutation was detected"
   * passes against a harness that cannot see one, so this reviewer really does
   * edit and commit in the worktree it was given, and real `git rev-parse` is
   * what notices.
   */
  const { runReview, STAGE } = await import('../src/reviewRunner.mjs');
  const { createFakeBridge } = await import('./fakeBridge.mjs');

  const { dir, sha, result } = await attemptForReview(t);
  const root = mkdtempSync(path.join(tmpdir(), 'reviewroot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = await workspaceManagerFor(dir, root);

  const task = {
    task_id: 't1-for-review', state: 'returned', lane_id: 'agentbridge', base_sha: sha,
    returned_by: 'worker-session', returned_head_sha: result.envelope.commit,
    attempt: 1, depends_on: [],
  };
  const bridge = createFakeBridge({ tasks: [task] });

  const review = await runReview({
    task,
    reviewerSession: 'reviewer-session',
    reviewer: {
      id: 'meddler',
      async review(packet, { path: p }) {
        writeFileSync(path.join(p, 'value.txt'), '3\n');
        await git(p, 'add', '-A');
        await git(p, 'commit', '--quiet', '-m', 'I fixed it myself');
        return { reviewer: 'meddler', decision: 'accept', findings: [] };
      },
    },
    workspaces,
    bridge,
    envelopeFor: async () => result.envelope,
    repoPath: dir,
    io: { workspaceGit: realWorkspaceGit, now: () => Date.now() },
  });

  assert.equal(review.ok, false, 'a reviewer that rewrote the code had its verdict recorded');
  assert.equal(review.stage, STAGE.REVIEW);
  assert.equal(review.reason, 'reviewer:mutated-workspace');
  assert.equal(review.mutation.kind, 'head', `caught as ${review.mutation.kind}, not as a new commit`);
  assert.equal(review.submitted, null);

  // the task is untouched and still reviewable by somebody who will not edit it
  assert.equal(bridge.rows.get('t1-for-review').state, 'returned');
  assert.equal(bridge.rows.get('t1-for-review').review_decision, undefined);
  // and the meddling is kept as evidence rather than tidied away
  assert.ok(existsSync(review.quarantined), 'the edited tree was destroyed instead of quarantined');
  assert.equal(
    readFileSync(path.join(review.quarantined, 'value.txt'), 'utf8').trim(), '3',
    'the quarantined tree does not contain the edit; the wrong thing was kept',
  );
});

test('FIX_REQUIRED MAKES A SEPARATE TASK OFF THE REVIEWED COMMIT, AND THE ORIGINAL IS NOT RETRIED', async (t) => {
  const { runReview } = await import('../src/reviewRunner.mjs');
  const { REVIEW_DECISION } = await import('../src/reviewDecision.mjs');
  const { createFakeBridge } = await import('./fakeBridge.mjs');

  const { dir, sha, result } = await attemptForReview(t);
  const head = result.envelope.commit;
  const root = mkdtempSync(path.join(tmpdir(), 'reviewroot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = await workspaceManagerFor(dir, root);

  const task = {
    task_id: 't1-for-review', state: 'returned', lane_id: 'agentbridge', repo_id: 'agentbridge',
    base_sha: sha, returned_by: 'worker-session', returned_head_sha: head, attempt: 1, depends_on: [],
  };
  const bridge = createFakeBridge({ tasks: [task] });

  const review = await runReview({
    task,
    reviewerSession: 'reviewer-session',
    // the machine is happy; only the reviewer objects, which is the only case
    // that proves a reviewer can stop work rather than echo the evidence
    reviewer: createFakeReviewer({ maxFilesChanged: 0 }),
    workspaces,
    bridge,
    envelopeFor: async () => result.envelope,
    repoPath: dir,
    contract: { allowed: ['value.txt'], forbidden: [] },
    io: { workspaceGit: realWorkspaceGit, now: () => Date.now() },
  });

  assert.equal(review.ok, true, `${review.stage}/${review.reason}: ${review.detail}`);
  assert.equal(review.decision.decision, REVIEW_DECISION.FIX_REQUIRED);

  const fix = bridge.rows.get(review.fixTask.task_id);
  assert.ok(fix, 'fix_required left the findings with nowhere to go');
  assert.notEqual(fix.task_id, 't1-for-review', 'the fix is the same task again under a new name');
  assert.equal(fix.state, 'runnable');
  assert.equal(fix.base_sha, head, 'the fixer would start from the original base and lose the work');
  assert.equal(fix.attempt, 0);

  const original = bridge.rows.get('t1-for-review');
  assert.equal(original.attempt, 1, 'the reviewed task was retried in place');
  assert.deepEqual(original.depends_on, [fix.task_id]);

  /*
   * AND THE FIX TASK IS A REAL BASE. Not asserted from the string: a worktree
   * really can be made at it, which is what a fixer will do next. A base_sha
   * that is a plausible-looking sha nothing can check out is the shape of this
   * whole file's failure mode.
   */
  const fixWorkspace = await workspaces.create({ taskId: fix.task_id, baseSha: fix.base_sha, attempt: 0 });
  t.after(async () => { await workspaces.destroy(fixWorkspace, { force: true }).catch(() => {}); });
  assert.equal(readFileSync(path.join(fixWorkspace.path, 'value.txt'), 'utf8').trim(), '2');
});
