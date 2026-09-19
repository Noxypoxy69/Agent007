/**
 * `git stash` WAS FILED UNDER "IMPORTS SOMEBODY ELSE'S COMMITS", AND IT IMPORTS
 * NOTHING.
 *
 * It sat in GIT_IMPORTS_HISTORY beside merge, rebase, pull, cherry-pick and
 * revert. That set's comment explains why those five are deliberately left
 * alone: refusing them outright is a workflow outage for every session in the
 * clone, the residual is real, and Stop's protected drift is what catches a
 * weakened guard arriving in a merge.
 *
 * Every word of that is true of those five and none of it is true of stash. A
 * bare `git stash` does not bring anything in -- it takes every modified
 * tracked file and resets the working tree to HEAD. That is the effect the
 * sweep branch exists to refuse, and the sweep branch never saw it, because the
 * verb was in the wrong bucket.
 *
 * WHAT IT COST, had anyone run it: the same outcome as `git restore .`, which
 * the sweep comment singles out -- "the hook re-imports that module on every
 * call, so reverting the tree disarms PreToolUse for the rest of the session".
 * Plus, in a clone three sessions share, every one of their uncommitted changes,
 * gone in one permitted command with no operand for anything to inspect.
 *
 * Found by blind audit. Neither the auditor nor I executed the destructive form
 * -- there was uncommitted work from two other sessions in the tree at the time,
 * which is precisely the thing it would have destroyed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const judge = (c) => judgeShellCommand(c, { pathspecCovers: () => [] });

test('THE POSITIVE FIRST: the reading forms still work', () => {
  /*
   * Rule 5. Every refusal below is satisfied by refusing `git stash` outright,
   * which would break the ordinary way of looking at a stash and earn the rail
   * exactly the reputation that gets it switched off.
   */
  for (const cmd of ['git stash list', 'git stash show', 'git stash list --stat']) {
    const v = judge(cmd);
    assert.equal(v.allowed, true, `a reading form was refused: ${cmd} -- ${v.reason}`);
  }
});

test('A STASH REF IS UNREACHABLE FOR AN UNRELATED, PRE-EXISTING REASON', () => {
  /*
   * `git stash show stash@{0}` is refused -- and NOT by this branch. Braces are
   * FORBIDDEN_CHARS, which predates all of this and applies to every command,
   * so the canonical way to name a stash entry cannot be typed at all.
   *
   * Recorded rather than fixed: it is a property of the metacharacter list, not
   * of the stash classification, and widening that list is a much larger change
   * than this one. My own first fixture asserted this spelling worked, which is
   * rule 21 -- I wrote down what I assumed the rail did instead of asking it.
   * Pinning it here means the day somebody makes braces reachable, this test
   * tells them a stash ref became typable and the read set may need revisiting.
   */
  const v = judge('git stash show stash@{0}');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /metacharacter/,
    'a stash ref is now reachable -- the refusal no longer comes from the metacharacter check, '
      + 'so re-check which stash forms this rail can actually see');
});

test('THE BARE FORM IS A SWEEP, and it is the dangerous one', () => {
  const v = judge('git stash');
  assert.equal(v.allowed, false, 'git stash with no subcommand was allowed');
  assert.match(v.reason, /resets the working tree/,
    'the refusal does not say what it would actually do');
  assert.match(v.reason, /uncommitted/,
    'the refusal does not mention the other sessions whose work it discards');
});

test('EVERY WRITING SUBCOMMAND IS REFUSED, including the ones that only touch the stack', () => {
  /*
   * push/save sweep the worktree. pop/apply overwrite tree files. drop/clear
   * destroy a stash entry that may be the only copy of another session's work
   * -- they do not touch the worktree, and refusing them anyway is deliberate:
   * the thing being protected is somebody's work, not one directory.
   */
  for (const sub of ['push', 'save', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store']) {
    const v = judge(`git stash ${sub}`);
    assert.equal(v.allowed, false, `git stash ${sub} was allowed`);
  }
});

test('AN UNKNOWN SUBCOMMAND IS REFUSED, NOT ASSUMED SAFE', () => {
  /*
   * The opposite of rule 19's usual direction, and deliberate. Rule 19 warns
   * that denying by unknown name is an outage -- true when the unknown case is
   * ordinary work. Here the DANGEROUS form is the bare one and the safe set is
   * two words long, so an unrecognised subcommand is far likelier to be a new
   * way to move the tree than a new way to read it.
   */
  for (const sub of ['whatever', 'export', 'import', '--all']) {
    assert.equal(judge(`git stash ${sub}`).allowed, false, `git stash ${sub} was allowed`);
  }
});

test('THE COMPLETENESS ASSERTION COULD NOT HAVE CAUGHT THIS, and that is the wider finding', () => {
  /*
   * shellAllowlist asserts at module load that every GIT_WRITE verb is in SOME
   * bucket, and throws if one is unassigned. That check passed for the whole
   * life of the defect, because `stash` WAS assigned -- to the wrong set. A
   * completeness check cannot see correctness.
   *
   * This test is the narrow version of the missing one: for the verbs whose
   * bucket carries a behavioural promise, assert the BEHAVIOUR rather than the
   * membership. GIT_IMPORTS_HISTORY promises "allowed, and Stop catches it";
   * anything in it that is refused here has been moved out, and anything that
   * sweeps the tree does not belong in it.
   */
  // stash is still judged as a git WRITE -- it just reaches a different branch.
  // If it stopped being one, it would fall through to the read-only shape list
  // and be refused for an unrelated reason, which would hide this property.
  assert.match(judge('git stash').reason, /resets the working tree/,
    'git stash is no longer reaching its own branch');

  // The five that genuinely import history are still allowed in their bare form
  // -- that is the documented residual, and moving stash must not have moved them.
  for (const verb of ['merge', 'rebase', 'pull', 'cherry-pick', 'revert']) {
    const v = judge(`git ${verb}`);
    assert.equal(v.allowed, true,
      `git ${verb} is now refused; the documented import residual changed without being argued`);
  }
});

test('THE CONTROL: this gate can actually fail', () => {
  /*
   * Rule 1, held permanently. Every assertion above is satisfied by a judge
   * that refuses everything, and most by one that allows everything. Both
   * verdicts are demanded here from the real rail.
   */
  assert.equal(judge('git stash list').allowed, true, 'the rail refuses everything');
  assert.equal(judge('git stash').allowed, false, 'the rail allows everything');
});
