import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommand, guardExecution, OUTCOME, REFUSAL, PROTECTED_BRANCHES,
} from '../src/preExecutionGuard.mjs';
import { run, interactivePrompt } from '../src/exec.mjs';

const now = '2026-09-16T08:00:00Z';
const worker = { isDisposable: true, branch: 'work/t1', leaseValid: true, fenceCurrent: true };
const guard = (file, args, place = worker, decisions = []) =>
  guardExecution({ file, args }, place, decisions, { now });

/*
 * THE SCREENSHOT. A coding agent stopped on "Do you want to proceed?" for a
 * local commit, on a machine nobody was sitting at. The policy had classified
 * `commit` as routine since the day it was written -- nothing ever translated
 * an argv into that word, so the policy was never asked.
 */
test('A LOCAL COMMIT IN A TASK WORKTREE RUNS WITHOUT ASKING ANYBODY', () => {
  for (const args of [['commit', '-m', 'x'], ['add', '-A'], ['-C', '/w', 'commit', '-m', 'x']]) {
    const r = guard('git', args);
    assert.equal(r.outcome, OUTCOME.ALLOW, `${args.join(' ')} -- ${r.reason}`);
    assert.equal(r.action, 'commit');
  }
});

test('reads run, and a global option before the subcommand does not hide it', () => {
  assert.equal(normalizeCommand('git', ['-C', '/repo', 'status']), 'git.status');
  assert.equal(normalizeCommand('git', ['--git-dir', '/r/.git', 'log']), 'git.log');
  assert.equal(guard('git', ['-C', '/repo', 'diff']).outcome, OUTCOME.ALLOW);
  // reading -C as the subcommand would send every routine command to an
  // approval queue, which is how an allow-list gets widened out of annoyance
  assert.notEqual(normalizeCommand('git', ['-C', '/repo', 'push']), null);
});

test('PUSH IS NOT ROUTINE, AND IT IS THE COORDINATOR RATHER THAN DANNY', () => {
  const r = guard('git', ['push', '-u', 'origin', 'work/t1']);
  assert.equal(r.outcome, OUTCOME.OWNER_GATE);
  assert.equal(r.code, REFUSAL.COORDINATOR_REQUIRED, 'filing this as the owner\'s is how his queue becomes noise');
  assert.equal(r.decider, 'coordinator');
});

test('AN UNRECOGNISED COMMAND IS NOT GUESSED INTO A CLASS', () => {
  for (const [file, args] of [['curl', ['https://x']], ['node', ['deploy.mjs']], ['git', ['gc', '--prune']]]) {
    const r = guard(file, args);
    assert.equal(r.outcome, OUTCOME.OWNER_GATE, `${file} ${args.join(' ')}`);
    assert.equal(r.code, REFUSAL.UNCLASSIFIED_COMMAND);
  }
  assert.equal(normalizeCommand('git', []), null);
  assert.equal(normalizeCommand('', ['commit']), null);
});

test('PLACEMENT IS CHECKED SEPARATELY, SO A ROUTINE ACTION CANNOT PAY FOR A BAD ONE', () => {
  for (const branch of PROTECTED_BRANCHES) {
    const r = guard('git', ['commit', '-m', 'x'], { ...worker, branch });
    assert.equal(r.outcome, OUTCOME.OWNER_GATE, branch);
    assert.equal(r.code, REFUSAL.PROTECTED_BRANCH);
  }
  assert.equal(guard('git', ['commit'], { ...worker, branch: 'MAIN' }).code, REFUSAL.PROTECTED_BRANCH,
    'a capital letter is not a different branch');
  assert.equal(guard('git', ['commit'], { ...worker, isDisposable: false }).code, REFUSAL.OUTSIDE_WORKSPACE);
  // a READ on a protected branch is still fine; the rule is about writing
  assert.equal(guard('git', ['status'], { ...worker, branch: 'main' }).outcome, OUTCOME.ALLOW);
});

test('STALE AUTHORITY IS ANSWERED BEFORE THE ACTION CLASS IS', () => {
  /*
   * Order is the property, not politeness. A worker whose lease expired is
   * still stale while asking to do something routine, and answering "that
   * action is fine" first is how an expired lease commits.
   */
  for (const place of [{ ...worker, leaseValid: false }, { ...worker, fenceCurrent: false }]) {
    const r = guard('git', ['commit', '-m', 'x'], place);
    assert.equal(r.outcome, OUTCOME.DENY);
    assert.equal(r.code, REFUSAL.STALE_AUTHORITY);
  }
  // even a command nobody recognises: stale is the answer, not unclassified
  assert.equal(guard('curl', ['x'], { ...worker, leaseValid: false }).code, REFUSAL.STALE_AUTHORITY);
});

test('a deploy is the owner\'s and no placement makes it routine', () => {
  assert.equal(normalizeCommand('npm', ['run', 'deploy:audited']), null);
  assert.equal(guard('npm', ['run', 'deploy:audited']).outcome, OUTCOME.OWNER_GATE);
  assert.equal(normalizeCommand('npm', ['run', 'check:jeff']), 'run.tests');
  assert.equal(guard('npm', ['test']).outcome, OUTCOME.ALLOW);
});

/*
 * THE RUNNER RULE. stdin closed, no prompt may stop a worker, and a prompt that
 * happens anyway is recorded rather than waited on.
 */
test('A CHILD THAT READS STDIN GETS END-OF-FILE INSTEAD OF THE WHOLE TIMEOUT', async () => {
  const reader = 'process.stdin.on("data",()=>{});process.stdin.on("end",()=>{process.exit(0)})';
  const started = Date.now();
  const r = await run(process.execPath, ['-e', reader], { timeoutMs: 5000 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true, 'it must finish, not be killed');
  assert.equal(r.killed, false);
  assert.ok(elapsed < 2500, `waited ${elapsed}ms: stdin was left open`);
});

test('A PROMPT IS REPORTED EVEN WHEN THE COMMAND EXITS ZERO', async () => {
  /*
   * The case that closing stdin does NOT fix, and the reason prevention and
   * detection are separate here: a tool that asks, gets EOF and takes its
   * default exits cleanly having made a choice nobody made. A green result
   * carrying this field is the one worth looking at.
   */
  const asks = 'process.stdout.write("Do you want to proceed? [y/n] ");process.exit(0)';
  const r = await run(process.execPath, ['-e', asks], { timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.notEqual(r.interactivePrompt, null, 'a clean exit hid the prompt');
  assert.match(r.interactivePrompt.token, /proceed/i);
});

test('ordinary output is not read as a prompt', () => {
  // a detector that fires on normal text gets switched off, taking the real
  // ones with it
  for (const clean of ['3 files changed', 'ok 12 - passes', 'Your branch is up to date.',
    'warning: LF will be replaced', 'proceeding with the merge']) {
    assert.equal(interactivePrompt(clean), null, clean);
  }
  assert.notEqual(interactivePrompt('Overwrite? [y/N]'), null);
  assert.notEqual(interactivePrompt('Password for https://x:'), null);
});

test('an interactive caller still gets its pipe', async () => {
  // input-on-stdin is how secrets avoid argv, and it must keep working
  const echo = 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>process.stdout.write(b))';
  const r = await run(process.execPath, ['-e', echo], { input: 'secret-value', timeoutMs: 5000 });
  assert.equal(r.stdout, 'secret-value');
});

test('THE PIPELINE STOPS BEFORE IT BUILDS ANYTHING IT WOULD HAVE TO CLEAN UP', async () => {
  /*
   * WAITING_APPROVAL is a queue entry that survives a restart. A prompt is a
   * blocker on a laptop. The whole point of deciding before launch is that the
   * attempt never reaches a state somebody has to tidy.
   */
  const { runAttempt } = await import('../src/attemptPipeline.mjs');
  let created = 0;
  const workspaces = { create: async () => { created++; return { path: '/w', destroy: async () => {} }; } };
  const executor = { name: 'never', run: async () => { throw new Error('the executor must not start'); } };

  const blocked = await runAttempt({
    task: { task_id: 't1', lease_ms: 900000, timeout_ms: 60000, branch: 'main',
            commands: [{ file: 'git', args: ['commit', '-m', 'x'] }] },
    executor, workspaces, io: { now },
  });
  assert.equal(blocked.verdict, 'blocked');
  assert.equal(blocked.blocked.state, 'WAITING_APPROVAL');
  assert.equal(blocked.blocked.code, 'PROTECTED_BRANCH');
  assert.equal(created, 0, 'a workspace was created for an attempt that may not run');
});
