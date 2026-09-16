import test from 'node:test';
import assert from 'node:assert/strict';
import {
  permissionScope, agentLaunch, assertNoBlanketGrant, assertRulesDoNotCoverDenied,
  CANDIDATE_COMMANDS, ENGINE_IDS,
} from '../src/agentPermissions.mjs';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { createResultEnvelope, verdictFor, OUTCOMES } from '../src/resultEnvelope.mjs';

const now = '2026-09-16T09:00:00Z';
const worker = { isDisposable: true, branch: 'work/t1', leaseValid: true, fenceCurrent: true };
const actions = (half) => half.map((x) => x.action);

test('THE SCOPE IS DERIVED FROM THE GUARD, NOT WRITTEN OUT BESIDE IT', () => {
  const s = permissionScope(worker, [], { now });
  assert.ok(actions(s.allow).includes('commit'), 'a local commit is the case the screenshot was about');
  assert.ok(actions(s.allow).includes('run.tests'));
  assert.ok(actions(s.deny).includes('git.push'), 'publishing is not a worker action by default');
  assert.equal(s.allow.length + s.deny.length, CANDIDATE_COMMANDS.length, 'every candidate is classified');
});

test('PLACEMENT FLOWS THROUGH: THE SAME AGENT ON MAIN MAY NOT WRITE', () => {
  const s = permissionScope({ ...worker, branch: 'main' }, [], { now });
  assert.equal(actions(s.allow).includes('commit'), false);
  assert.ok(actions(s.allow).includes('git.status'), 'reading is still fine');
  assert.ok(s.deny.some((d) => d.code === 'PROTECTED_BRANCH'));
});

test('A STALE WORKER IS GRANTED NOTHING, AND LAUNCHING IT IS REFUSED', () => {
  const s = permissionScope({ ...worker, leaseValid: false }, [], { now });
  assert.equal(s.allow.length, 0);
  /*
   * An empty allow-list must not launch. Several engines read "no allow-list"
   * as "use your defaults", which is precisely where the prompt lives -- so a
   * scope that denied everything would become a worker with an interactive
   * fallback and full default permissions.
   */
  assert.throws(() => agentLaunch('claude-code', { scope: s }), /allows nothing/);
});

test('NO RULE MAY COVER A COMMAND THE GUARD REFUSED', () => {
  /*
   * THE DEFECT THIS CAUGHT IN ITS OWN AUTHOR. The first renderer took one
   * argument, so `npm run verify` became `npm run:*` -- which also matches
   * `npm run deploy:audited`, a command the guard had refused in the SAME call.
   * The engine would have been configured to allow exactly what the policy
   * denied, and both halves looked correct read separately.
   */
  const s = permissionScope(worker, [], { now });
  const launch = agentLaunch('claude-code', { scope: s });
  assert.ok(launch.rules.includes('Bash(npm run verify:*)'), 'the script has to be in the rule');
  assert.equal(launch.rules.includes('Bash(npm run:*)'), false, 'that rule reaches deploy:audited');

  assert.throws(
    () => assertRulesDoNotCoverDenied(['Bash(npm run:*)'], s.deny, 'claude-code'),
    /also grants/,
  );
  // the assertion must not fire on a rule that only covers allowed commands
  assert.doesNotThrow(() => assertRulesDoNotCoverDenied(launch.rules, s.deny, 'claude-code'));
});

test('A BLANKET GRANT IS REFUSED IN EVERY SPELLING', () => {
  for (const bad of ['*', '**', 'Bash(*)', 'Bash(*:*)', 'all', 'bash( * )']) {
    assert.throws(() => assertNoBlanketGrant([bad]), /grants every command/, bad);
  }
  assert.doesNotThrow(() => assertNoBlanketGrant(['Bash(git commit:*)', 'Bash(npm test:*)']));
});

test('every engine launches non-interactively and carries the rules', () => {
  const s = permissionScope(worker, [], { now });
  for (const engine of ENGINE_IDS) {
    const l = agentLaunch(engine, { scope: s });
    const joined = l.args.join(' ');
    assert.ok(/--print|--full-auto/.test(joined), `${engine} launched without a non-interactive flag`);
    assert.ok(l.rules.length > 0);
    assert.ok(joined.includes(l.rules[0]), `${engine} did not pass its rules`);
  }
  assert.throws(() => agentLaunch('not-an-engine', { scope: s }), /unknown engine/);
});

test('A PROMPT FAILS THE ATTEMPT EVEN WHEN THE PROCESS EXITED ZERO', async () => {
  assert.ok(OUTCOMES.includes('prompted'));
  const executor = createLocalExecutor({
    run: async () => ({
      ok: true, code: 0, killed: false, signal: null,
      stdout: 'Do you want to proceed? [y/n] ', stderr: '',
      interactivePrompt: { pattern: '/proceed/', token: 'Do you want to proceed' },
    }),
  });
  const r = await executor.run({ argv: ['agent'], cwd: '/w', timeoutMs: 1000 });
  assert.equal(r.outcome, 'prompted', 'a clean exit after a prompt read as a clean run');
  assert.equal(r.exitCode, undefined, 'the code describes the default it took, not the work');

  const verdict = verdictFor(createResultEnvelope({ taskId: 't1', attempt: 0, outcome: r.outcome, exitCode: null }));
  assert.equal(verdict.verdict, 'reject');
  assert.ok(verdict.reasons.includes('outcome:prompted'));
});

test('an ordinary clean run is untouched', async () => {
  const executor = createLocalExecutor({
    run: async () => ({ ok: true, code: 0, killed: false, signal: null, stdout: '3 files changed', stderr: '', interactivePrompt: null }),
  });
  const r = await executor.run({ argv: ['agent'], cwd: '/w', timeoutMs: 1000 });
  assert.equal(r.outcome, 'exited');
  assert.equal(r.exitCode, 0);
});

test('A TASK THAT NAMES AN ENGINE IS LAUNCHED WITH A DERIVED SCOPE', async () => {
  // the wiring, not the module: a task giving an engine rather than an argv
  // must reach the executor already carrying its rules
  const { runAttempt } = await import('../src/attemptPipeline.mjs');
  let sawArgv = null;
  const workspaces = {
    create: async () => ({ path: '/w' }),
    destroy: async () => {},
    quarantine: async () => {},
  };
  const executor = {
    id: 'spy', capabilities: ['shell', 'write', 'commit'],
    run: async (spec) => { sawArgv = spec.argv; return { outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }; },
  };
  await runAttempt({
    task: { task_id: 't1', engine: 'claude-code', branch: 'work/t1', lease_ms: 900000, timeout_ms: 60000 },
    /*
     * A CLOCK FUNCTION, WHICH IS WHAT THE PIPELINE'S `io.now` ACTUALLY IS.
     * Passing the ISO string here is what surfaced the collision: the policy
     * classifier wants a timestamp and the executor adapter wants a clock, and
     * one field was carrying both.
     */
    executor, workspaces, io: { now: () => Date.parse(now) },
  });
  assert.ok(sawArgv, 'the executor was never given an argv');
  const joined = sawArgv.join(' ');
  assert.ok(joined.includes('--permission-mode'), 'launched without a non-interactive mode');
  assert.ok(joined.includes('Bash(git commit:*)'), 'the derived rules did not reach the launch');
  assert.equal(joined.includes('Bash(git push:*)'), false, 'a denied command reached the launch');
});
