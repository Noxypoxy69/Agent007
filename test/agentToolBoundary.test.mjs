import test from 'node:test';
import assert from 'node:assert/strict';
import { decideToolUse, toHookOutput, splitShellCommand, opaqueReason, relocatesWorkspace,
  hookSettings, SEPARATOR_TOKENS, DECISION } from '../src/agentToolBoundary.mjs';
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

test('EVERY SEPARATOR IS A SEPARATOR, GENERATED FROM THE REAL LIST', () => {
  /*
   * THE ONE THAT WAS MISSED, AND HOW IT WAS MISSED. The first version of this
   * file listed the separators it split on and tested the ones it listed. `&`
   * was not among them, so `git status & git push` parsed as a SINGLE command
   * whose first token was a read verb and was ALLOWED -- the publish rode
   * behind the status, which is the exact sentence the test above uses to
   * explain why compounds are split at all.
   *
   * Generated from SEPARATOR_TOKENS now, so a separator added to the module
   * extends this coverage without anybody remembering to.
   */
  /*
   * GENERATED FROM THE MODULE'S LIST **AND** FROM AN INDEPENDENT ONE, because
   * the first version used only the module's and that cannot catch a shrink:
   * delete `&` from SEPARATOR_TOKENS and the loop below stops generating the
   * `&` case, so the test follows the bug down. That is hollow gate 2 — a check
   * that reconstructs the rule instead of reading the shipped one agrees with
   * itself through the regression.
   *
   * SHELL_SEPARATORS is a claim about what a POSIX shell does, not about what
   * this module says it handles, so it stays true when the module is wrong.
   */
  const SHELL_SEPARATORS = ['&&', '||', ';', '|', '&', '\n'];
  assert.ok(SEPARATOR_TOKENS.length > 0 && DENIED.length > 0, 'the fixtures are empty');
  for (const sep of [...new Set([...SEPARATOR_TOKENS, ...SHELL_SEPARATORS])]) {
    for (const denied of DENIED) {
      for (const line of [`git status ${sep} ${denied}`, `git status ${sep}${denied}`]) {
        const v = decideToolUse(bash(line), holding, [], { now });
        /*
         * THE ASSERTION IS THE OUTCOME, NOT THE MECHANISM. A separator this
         * module models is split and the hidden half is refused by name; one it
         * does not model is refused as an unmodelled character. Both are
         * correct and only the first names the command, so requiring the named
         * refusal would fail a version that is safe for a different reason.
         */
        assert.equal(v.decision, DECISION.DENY, `hidden behind ${JSON.stringify(sep)}: ${line}`);
      }
    }
  }
  // for the separators this module DOES model, the refusal must name the command,
  // because an unnamed refusal tells a reviewer nothing about what was stopped
  for (const sep of SEPARATOR_TOKENS) {
    for (const denied of DENIED) {
      const v = decideToolUse(bash(`git status ${sep} ${denied}`), holding, [], { now });
      assert.ok(v.refusals.some((r) => r.command === denied),
        `${sep} is modelled, so the refusal must name ${denied}: ${JSON.stringify(v.refusals)}`);
    }
  }

  // and a legitimate compound of two allowed commands still runs
  assert.equal(decideToolUse(bash('git status && git diff'), holding, [], { now }).decision,
    DECISION.ALLOW, 'a guard that refuses every compound passes every negative test here');
});

test('EVERY CHARACTER A SHELL CAN MEAN SOMETHING BY IS REFUSED — EXHAUSTIVELY', () => {
  /*
   * NOT A LIST OF CONSTRUCTS I THOUGHT OF. That is what the first version was:
   * command substitution, backticks, process substitution, newline,
   * redirection, parameter expansion, line continuation. It passed against
   * exactly those seven and `&` went straight through.
   *
   * So this sweeps EVERY printable ASCII character plus the control characters
   * that matter, and requires each one to be either understood or refused.
   * A character this file has never heard of cannot pass by being unthought-of,
   * which is the only version of this property worth asserting.
   */
  const understood = new Set([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ...' \t_-./=:,@+%\'"', ...SEPARATOR_TOKENS.join('')]);

  let refusedCount = 0;
  for (let code = 1; code <= 126; code += 1) {
    const ch = String.fromCharCode(code);
    if (understood.has(ch)) continue;
    const line = `git status ${ch} git push`;
    const v = decideToolUse(bash(line), holding, [], { now });
    assert.equal(v.decision, DECISION.DENY,
      `${JSON.stringify(ch)} (0x${code.toString(16)}) passed through unmodelled: ${line}`);
    refusedCount += 1;
  }
  assert.ok(refusedCount > 20, `only ${refusedCount} characters were exercised; the sweep is broken`);

  // THE POSITIVE, or the sweep above is satisfied by refusing everything
  for (const ok of ['git add -A', 'npm run verify', 'git commit -m "raise the value"',
    'git log --oneline -5', 'git diff --name-only']) {
    assert.equal(decideToolUse(bash(ok), holding, [], { now }).decision, DECISION.ALLOW, ok);
  }
});

test('A FLAG THAT MOVES GIT TO ANOTHER TREE IS REFUSED, IN BOTH SPELLINGS', () => {
  /*
   * `git -C /other/repo commit` is classified `commit`, correctly, and the
   * placement says disposable worktree on a work branch, correctly. Both are
   * true and they are about DIFFERENT REPOSITORIES -- so an agent in a
   * throwaway worktree could commit into the main clone with every check
   * passing on the way through. `normalizeCommand` parses past these flags to
   * find the subcommand, which is right for naming the action and says nothing
   * about where it lands.
   *
   * Both spellings, because `--work-tree /x` and `--work-tree=/x` are the same
   * instruction and only one is a separate token. The first version compared
   * whole tokens and granted the equals form.
   */
  for (const flag of ['-C', '--git-dir', '--work-tree', '--namespace']) {
    for (const line of [`git ${flag} /other commit -m x`, `git ${flag}=/other commit -m x`]) {
      if (flag === '-C' && line.includes('=')) continue; // -C has no equals form
      const v = decideToolUse(bash(line), holding, [], { now });
      assert.equal(v.decision, DECISION.DENY, `escaped the workspace: ${line}`);
      assert.equal(v.refusals[0].code, 'OUTSIDE_WORKSPACE', line);
    }
  }
  assert.equal(relocatesWorkspace({ file: 'git', args: ['commit', '-m', 'x'] }), null,
    'an ordinary commit must not be read as a relocation');
  assert.equal(relocatesWorkspace({ file: 'npm', args: ['-C', 'x'] }), null,
    'this is a git flag and npm is not git');
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

test('THE SETTINGS NAME THE SHIM AND MATCH THE TOOL THE GUARD CLASSIFIES', () => {
  /*
   * The matcher and the tool name must agree or the hook is never called, and
   * a hook that is never called is indistinguishable from one that allows
   * everything. Asserted against DECISION rather than a literal, so a rename
   * of the classified tool cannot leave the matcher pointing at the old one.
   */
  const cfg = hookSettings('/opt/bin/guard.mjs');
  const entry = cfg.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.match(entry.hooks[0].command, /\/opt\/bin\/guard\.mjs$/);
  assert.equal(entry.hooks[0].type, 'command');

  // the matcher is the tool decideToolUse has an opinion about, not a guess
  assert.notEqual(
    decideToolUse({ tool_name: entry.matcher, tool_input: { command: 'git push' } },
      holding, [], { now }).decision,
    DECISION.ABSTAIN,
    'the settings point the engine at a tool this guard abstains on',
  );
  assert.throws(() => hookSettings(''), /requires a path/);
});

test('THE HOOK WIRE FORMAT CARRIES THE DECISION AND THE REASON', () => {
  const out = toHookOutput(decideToolUse(bash('git push'), holding, [], { now }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /COORDINATOR_REQUIRED/);
  const ok = toHookOutput(decideToolUse(bash('git status'), holding, [], { now }));
  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
});
