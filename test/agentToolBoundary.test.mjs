import test from 'node:test';
import assert from 'node:assert/strict';
import { decideToolUse, toHookOutput, splitShellCommand, opaqueReason, DECISION }
  from '../src/agentToolBoundary.mjs';
import { permissionScope } from '../src/agentPermissions.mjs';
import { guardExecution, OUTCOME } from '../src/preExecutionGuard.mjs';

/**
 * THE GUARD AT THE AGENT'S OWN TOOL BOUNDARY.
 *
 * The launch scope answers once. This answers every time the agent invents a
 * command, which is where the remaining hole in item 7b was. The engine half --
 * that Claude Code actually calls this and actually honours a `deny` -- is in
 * `test/realAgentLaunch.test.mjs`, because it needs a binary. This file is the
 * decision, which is pure and must be watchable without one.
 */

const now = '2026-09-16T12:00:00.000Z';
const holding = { isDisposable: true, branch: 'work/t1', leaseValid: true, fenceCurrent: true,
  task_id: 't-1', project: 'agentbridge', repo: 'agentbridge', lane: 'agentbridge' };
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

/**
 * The commands the guard REFUSES, taken from the policy rather than typed out.
 *
 * Rule 7: adversarial fixtures generated from the real list, so adding a
 * candidate command extends this coverage without anybody remembering to.
 */
const DENIED = permissionScope(holding, [], { now }).deny
  .map((d) => [d.command.file, ...d.command.args].join(' '));
const ALLOWED = permissionScope(holding, [], { now }).allow
  .map((a) => [a.command.file, ...a.command.args].join(' '));

test('THE POSITIVE FIRST: a command the policy allows is allowed here too', () => {
  /*
   * Without this every refusal below could be a guard that refuses everything,
   * which passes a negative test perfectly and is an outage.
   */
  assert.ok(ALLOWED.length > 0, 'the fixture list is empty and proves nothing');
  for (const line of ALLOWED) {
    const v = decideToolUse(bash(line), holding, [], { now });
    assert.equal(v.decision, DECISION.ALLOW, `${line}: ${v.reason}`);
    assert.deepEqual(v.refusals, []);
  }
});

test('EVERY PART OF A COMPOUND IS CLASSIFIED, NOT JUST THE FIRST', () => {
  /*
   * `git status && git push` is not a status command. A splitter that took the
   * first verdict would make this guard worse than not having one, because the
   * read verb in front is exactly what an agent writes.
   */
  assert.ok(DENIED.length > 0, 'the policy refuses nothing, so this proves nothing');
  for (const denied of DENIED) {
    for (const sep of ['&&', '||', ';', '|']) {
      const line = `git status ${sep} ${denied}`;
      const v = decideToolUse(bash(line), holding, [], { now });
      assert.equal(v.decision, DECISION.DENY, `hidden behind ${sep}: ${line}`);
      assert.ok(v.refusals.some((r) => r.command === denied),
        `${line} was refused, but not for ${denied}: ${JSON.stringify(v.refusals)}`);
    }
  }
});

test('A CONSTRUCT THAT HIDES A COMMAND IS REFUSED, NOT PARSED', () => {
  /*
   * A splitter is not a shell parser. Each wrapper below puts a real command
   * somewhere the separator scan cannot see it, and the honest answer is to
   * refuse the line rather than return a verdict about the half it could read.
   */
  const wrappers = [
    (c) => `git status $(${c})`,
    (c) => `git status \`${c}\``,
    (c) => `git status\n${c}`,
    (c) => `diff <(${c}) /dev/null`,
    (c) => `git status > out && ${c}`,
    (c) => `git status \${X:-${c}}`,
    (c) => `git status \\\n${c}`,
  ];
  for (const wrap of wrappers) {
    for (const denied of DENIED) {
      const line = wrap(denied);
      assert.notEqual(opaqueReason(line), null, `not detected as opaque: ${JSON.stringify(line)}`);
      assert.equal(splitShellCommand(line), null, `split anyway: ${JSON.stringify(line)}`);
      const v = decideToolUse(bash(line), holding, [], { now });
      assert.equal(v.decision, DECISION.DENY, `allowed: ${JSON.stringify(line)}`);
    }
  }
  // and the wrappers are not refusing everything: a plain line still splits
  assert.equal(opaqueReason('git status && git diff'), null);
  assert.deepEqual(splitShellCommand('git add -A && git commit -m x'),
    [{ file: 'git', args: ['add', '-A'] }, { file: 'git', args: ['commit', '-m', 'x'] }]);
});

test('THE BOUNDARY REFUSES ON STALE AUTHORITY EVEN WHEN THE ACTION IS ROUTINE', () => {
  /*
   * The case the launch allow-list structurally cannot cover: the scope was
   * derived while the lease was good, and the lease expired mid-run. The engine
   * still holds a configuration that says `git commit` is fine.
   */
  const stale = { ...holding, leaseValid: false };
  assert.equal(guardExecution({ file: 'git', args: ['commit', '-m', 'x'] }, holding, [], { now }).outcome,
    OUTCOME.ALLOW, 'the precondition is wrong: this command is not routine while holding the lease');

  const v = decideToolUse(bash('git commit -m x'), stale, [], { now });
  assert.equal(v.decision, DECISION.DENY);
  assert.equal(v.refusals[0].code, 'STALE_AUTHORITY');
});

test('AN UNREADABLE REQUEST OR PLACEMENT IS REFUSED, NEVER WAVED THROUGH', () => {
  assert.equal(decideToolUse(bash(''), holding, [], { now }).decision, DECISION.DENY);
  assert.equal(decideToolUse({ tool_name: 'Bash' }, holding, [], { now }).decision, DECISION.DENY);
  /*
   * AN EMPTY PLACEMENT MUST NOT READ AS A GOOD ONE. `guardExecution` refuses
   * only on an explicit `false`, so `{}` checks no lease at all -- which is why
   * the shim refuses a missing AGENTBRIDGE_PLACEMENT rather than defaulting.
   * Asserted here so nobody "simplifies" that away: this is the shape a typo in
   * the variable name produces.
   */
  assert.equal(decideToolUse(bash('git commit -m x'), {}, [], { now }).decision, DECISION.ALLOW,
    'an empty placement passes the guard, which is exactly why the shim refuses one');
  assert.throws(() => decideToolUse(bash('git status'), holding, []), /requires a `now`/);
});

test('A TOOL THE GUARD CANNOT CLASSIFY GETS NO OPINION, NOT A BLESSING', () => {
  const v = decideToolUse({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, holding, [], { now });
  assert.equal(v.decision, DECISION.ABSTAIN);
  // and abstaining emits no decision field at all, leaving the engine's own rules
  const out = toHookOutput(v);
  assert.equal('permissionDecision' in out.hookSpecificOutput, false);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('THE HOOK WIRE FORMAT CARRIES THE DECISION AND THE REASON', () => {
  const out = toHookOutput(decideToolUse(bash('git push'), holding, [], { now }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /COORDINATOR_REQUIRED/);
  const ok = toHookOutput(decideToolUse(bash('git status'), holding, [], { now }));
  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
});
