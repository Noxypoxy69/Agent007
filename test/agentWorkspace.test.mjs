/**
 * ONE WORKTREE PER AGENT, and the ways the id could escape.
 *
 * The agent id becomes a DIRECTORY NAME. `agent.cmd` already carries a blind
 * audit scar about an id containing shell metacharacters executing as script,
 * and the fix for that was quoting -- which does nothing whatsoever about
 * `..`. So most of this file is about what the id may NOT be.
 *
 * The other half is the refusal. A launcher that cannot isolate a session and
 * carries on in the shared tree with a warning is the exact shape this
 * repository keeps shipping: a control that reports a problem and then does
 * the unsafe thing anyway, invisible because everything still runs.
 * `register-session` does it today -- prints "local only", exits 0, and the
 * agent is invisible to the bridge for a day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAgentId, agentWorkspacePlan, startupRefusal } from '../src/agentWorkspace.mjs';

const ROOT = 'C:/Users/someone/Agent007';

/* ── the ids actually in use ─────────────────────────────────────────── */

test('THE POSITIVE CONTROL: every id this machine really uses is accepted', () => {
  /*
   * Rule 5, and it is load-bearing here: a validator that refused everything
   * would satisfy every traversal assertion below perfectly, and would also
   * stop every agent from starting.
   */
  for (const id of ['code-a', 'code-b', 'code-c', 'code-d', 'fixer', 'main', 'b6', 'chatgpt-work']) {
    const v = validateAgentId(id);
    assert.equal(v.ok, true, `a real agent id was refused: ${id} — ${v.why}`);

    const plan = agentWorkspacePlan(id, { repoRoot: ROOT });
    assert.equal(plan.ok, true, plan.why);
    assert.equal(plan.dir, `C:/Users/someone/wt-${id}`);
    assert.equal(plan.branch, `agent/${id}`);
  }
});

/* ── the id becomes a path, so it must not traverse ──────────────────── */

test('AN ID CANNOT WALK OUT OF THE WORKTREE ROOT', () => {
  /*
   * The whole reason this is validated rather than escaped. Quoting protects
   * cmd.exe from executing the id; it does not stop the id being a path.
   */
  for (const bad of [
    '..', '../..', '..\\..', 'a/../..', 'code-a/../../..',
    '/etc/passwd', 'C:/Windows', '\\\\server\\share', 'a/b', 'a\\b',
  ]) {
    assert.equal(validateAgentId(bad).ok, false, `a traversing id was accepted: ${JSON.stringify(bad)}`);
    assert.equal(agentWorkspacePlan(bad, { repoRoot: ROOT }).ok, false,
      `a traversing id produced a plan: ${JSON.stringify(bad)}`);
  }
});

test('AN ID OF ONLY DOTS IS REFUSED, although dots are otherwise legal', () => {
  /*
   * THIS TEST DELETED A GUARD. I had written a dedicated `^\.+$` refusal for
   * `..` with its own message, and asserted the message here. It went red,
   * because `..` never reaches that line: the shape check refuses it first,
   * for starting with a dot. The dedicated guard could not fire.
   *
   * So the assertion is now on the OUTCOME, not on which rule produced it.
   * Pinning the reason was what made the dead code look alive, and an
   * unreachable guard is worse than none -- it tells the next reader that
   * traversal is handled somewhere it is not.
   */
  assert.equal(validateAgentId('a.b').ok, true, 'a dot in an ordinary id was refused');
  assert.equal(validateAgentId('1.2.3').ok, true, 'dots inside an id are legal and traverse nothing');
  for (const dots of ['.', '..', '...', '....']) {
    assert.equal(validateAgentId(dots).ok, false, `"${dots}" was accepted as an agent id`);
  }
});

test('THE cmd.exe METACHARACTERS THAT ONCE EXECUTED ARE REFUSED AS IDS', () => {
  /*
   * agent.cmd's own history: an id of the form a-AMP-echo-PWNED executed that
   * echo, found by blind audit after three gate versions only ever passed
   * "code-a". Quoting fixed the execution. This stops the id being that shape
   * at all, which is the layer that also covers the path.
   */
  for (const bad of ['a&echo', 'a|b', 'a>b', 'a<b', 'a^b', 'a%b%', 'a b', 'a"b', "a'b", 'a;b', 'a$b', 'a`b']) {
    assert.equal(validateAgentId(bad).ok, false, `a metacharacter id was accepted: ${JSON.stringify(bad)}`);
  }
});

test('AN EMPTY, BLANK OR NON-STRING ID IS REFUSED, not defaulted', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const v = validateAgentId(bad);
    assert.equal(v.ok, false, `${JSON.stringify(bad)} was accepted as an agent id`);
  }
  assert.match(validateAgentId('').why, /required/);
});

test('AN ID MUST START WITH A LETTER OR DIGIT, and is bounded', () => {
  /* A leading dash is an argument to whatever reads it next. */
  for (const bad of ['-rf', '--help', '.hidden', '_x']) {
    assert.equal(validateAgentId(bad).ok, false, `${bad} was accepted`);
  }
  assert.equal(validateAgentId('a'.repeat(64)).ok, true);
  assert.equal(validateAgentId('a'.repeat(65)).ok, false, 'an unbounded id becomes an unbounded path component');
});

/* ── where the worktree goes ─────────────────────────────────────────── */

test('THE WORKTREE IS A SIBLING, NEVER INSIDE THE REPOSITORY', () => {
  /*
   * A worktree inside the repo is walked by every tool that scans the tree --
   * the dead-export ratchet, the import-closure gates, git status -- and each
   * agent would then see every other agent's copy of the source.
   */
  const plan = agentWorkspacePlan('code-b', { repoRoot: ROOT });
  assert.equal(plan.ok, true);
  assert.ok(!plan.dir.toLowerCase().startsWith(`${ROOT.toLowerCase()}/`),
    `the worktree ${plan.dir} is inside the repository ${ROOT}`);
});

test('A PLAN THAT LANDS ON THE REPOSITORY ITSELF IS REFUSED', () => {
  /*
   * The failure that would make this whole change a no-op while looking like
   * it worked: the "isolated" worktree resolving onto the shared tree.
   */
  const plan = agentWorkspacePlan('Agent007', { repoRoot: ROOT, parentDir: 'C:/Users/someone' });
  assert.equal(plan.dir, 'C:/Users/someone/wt-Agent007');
  assert.notEqual(plan.dir.toLowerCase(), ROOT.toLowerCase());

  const collide = agentWorkspacePlan('x', { repoRoot: 'C:/p/wt-x', parentDir: 'C:/p' });
  assert.equal(collide.ok, false, 'a worktree computed onto the repository itself was allowed');
  assert.match(collide.why, /IS the repository/);
});

test('A REPO ROOT IS REQUIRED, so the worktree is never placed relative to cwd', () => {
  for (const bad of [undefined, '', '   ', null, 7]) {
    const p = agentWorkspacePlan('code-b', { repoRoot: bad });
    assert.equal(p.ok, false, `repoRoot=${JSON.stringify(bad)} produced a plan`);
  }
});

test('BACKSLASH ROOTS AND TRAILING SEPARATORS BOTH WORK', () => {
  /* Windows hands these in every shape; a literal would be a machine fact. */
  for (const root of ['C:/Users/someone/Agent007', 'C:/Users/someone/Agent007/']) {
    const p = agentWorkspacePlan('code-b', { repoRoot: root });
    assert.equal(p.ok, true, p.why);
    assert.equal(p.dir, 'C:/Users/someone/wt-code-b');
  }
});

/* ── the refusal ─────────────────────────────────────────────────────── */

test('A SESSION THAT CANNOT BE ISOLATED DOES NOT START', () => {
  /*
   * The one that matters. A warning plus carrying on is how every other
   * degraded path in this repository behaves, and it is why an agent can be
   * invisible to the bridge for a day while reporting success.
   */
  const refusal = startupRefusal(agentWorkspacePlan('..', { repoRoot: ROOT }));
  assert.ok(refusal, 'a refused plan produced no refusal message');
  assert.match(refusal, /^\[agentbridge:/, 'the refusal does not name this layer (rule 18)');
  assert.match(refusal, /REFUSING TO START/);
  assert.match(refusal, /two sessions in one tree/);

  /* And a good plan refuses nothing, or every agent is blocked. */
  assert.equal(startupRefusal(agentWorkspacePlan('code-b', { repoRoot: ROOT })), null);
});
