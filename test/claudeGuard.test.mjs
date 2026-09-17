import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateClaudeTool, hookDecision, isProtectedPath } from '../src/claudeGuard.mjs';
import { buildSnapshot, writeSnapshot, protectedDrift, discoverTests, snapshotPath } from '../src/guardSession.mjs';

function repoFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agentbridge-guard-'));
  mkdirSync(path.join(root, 'test'));
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(path.join(root, 'test', 'real.test.mjs'), 'test("real", () => {});');
  return root;
}

test('fails closed on malformed hook input', () => {
  const result = evaluateClaudeTool();
  assert.equal(result.allowed, false);
  assert.equal(result.id, 'malformed-hook-input');
  assert.equal(hookDecision(result).hookSpecificOutput.permissionDecision, 'deny');
});

test('protects guard configuration through relative, absolute, and symlinked paths', () => {
  const root = repoFixture();
  assert.equal(isProtectedPath('.claude/settings.json', root), true);
  assert.equal(isProtectedPath(path.join(root, 'package.json'), root), true);
  assert.equal(evaluateClaudeTool({ tool_name: 'Write', tool_input: { file_path: '.claude/settings.json', content: '{}' }, cwd: root }).allowed, false);
});

test('blocks deleting tests and destructive or protected pushes', () => {
  /*
   * The DONOR asserted a specific refusal id per command. Those ids described a
   * denylist that could not hold -- node -e, python3 -c, eval, find -delete and
   * perl -e all walked through it. The allowlist refuses the same commands and
   * more, under one id, so the assertion is on the REFUSAL rather than on which
   * rule happened to catch it.
   */
  const root = repoFixture();
  for (const command of [
    'rm test/real.test.mjs',
    'git reset --hard HEAD~1',
    'git push origin master',
    'git push --force origin feature',
    'printf "fake" > test/real.test.mjs',
    'git restore test/real.test.mjs',
  ]) {
    assert.equal(evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root }).allowed, false, command);
  }
});

test('blocks self-modification through Claude and npm configuration commands', () => {
  const root = repoFixture();
  for (const command of [
    'claude plugin disable guard-pack',
    'claude config set permissions.default allow',
    'npm pkg set scripts.test="printf fake"',
  ]) {
    assert.equal(evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root }).allowed, false, command);
  }
});

test('does not confuse harmless reads with mutations', () => {
  const root = repoFixture();
  // sed and node --test were here and are now refused by policy, not by
  // accident: both can write, and running tests is executing repository code.
  for (const command of ['git diff -- test/real.test.mjs', 'git status --porcelain', 'cat CLAUDE.md']) {
    assert.equal(evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root }).allowed, true, command);
  }
});

test('mutation proof: restoring the donor fail-open behavior makes malformed input pass', () => {
  const broken = () => hookDecision({ allowed: true });
  assert.deepEqual(broken(), {});
  assert.notDeepEqual(hookDecision(evaluateClaudeTool()), {});
});

/* ============================================================================
 * THE BASH BYPASS, FOUND BY RUNNING THE SHIPPED GUARD AGAINST ITSELF.
 *
 * PROTECTED regexes are anchored (?:^|\/) ... $ because they describe PATHS.
 * The Bash branch applied them to the whole COMMAND, where `rm src/claudeGuard.mjs`
 * has `src` preceded by a space, so every anchor failed. Measured through the
 * real hook binary: rm src/claudeGuard.mjs, cat > .claude/settings.json and
 * printf "" > scripts/claude-stop-gate.mjs were all ALLOWED.
 * ==========================================================================*/

test('a shell command cannot reach a protected control, in any spelling', () => {
  const root = repoFixture();
  const cases = [
    'rm src/claudeGuard.mjs',
    'cat > .claude/settings.json',
    'printf "" > scripts/claude-stop-gate.mjs',
    'printf "" > THIRD_PARTY_CODE.md',
    'git restore src/claudeGuard.mjs',
    'mv src/claudeGuard.mjs /tmp/x',
    'rm "src/claudeGuard.mjs"',
    'rm ./src/claudeGuard.mjs',
    'rm src/../src/claudeGuard.mjs',
  ];
  for (const command of cases) {
    const r = evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root });
    assert.equal(r.allowed, false, `ALLOWED: ${command}`);
  }
});

test('the two structured-tool protections that were missing', () => {
  const root = repoFixture();
  for (const f of ['scripts/claude-stop-gate.mjs', 'THIRD_PARTY_CODE.md']) {
    assert.equal(isProtectedPath(f, root), true, `${f} must be protected`);
    assert.equal(
      evaluateClaudeTool({ tool_name: 'Write', tool_input: { file_path: f, content: 'x' }, cwd: root }).allowed,
      false,
    );
  }
});

/* ---- the session snapshot: HEAD was the wrong baseline ---- */

test('a committed change to a protected file still shows as drift', async () => {
  /*
   * The old gate ran `git diff --name-only HEAD`, so committing hid the change.
   * Content against a pre-session snapshot cannot be hidden that way -- and the
   * same check catches a write that never passed through PreToolUse at all.
   */
  const { writeFileSync } = await import('node:fs');
  const root = repoFixture();
  writeFileSync(path.join(root, 'package.json'), '{"name":"before"}');
  const snapshot = buildSnapshot(root);
  writeFileSync(path.join(root, 'package.json'), '{"name":"after"}');
  const drift = protectedDrift(root, snapshot);
  assert.ok(drift.some((d) => d.file === 'package.json'), 'a content change must be visible however it arrived');
});

test('an absent snapshot is not a clean one', () => {
  const root = repoFixture();
  const snapshot = buildSnapshot(root);
  assert.equal(typeof snapshot.files, 'object');
  assert.ok(snapshotPath(root).includes('guard-sessions'), 'the snapshot lives outside the worktree');
  assert.ok(!snapshotPath(root).startsWith(root), 'and it must not be inside the repository it describes');
});

test('tests are discovered recursively, matching the test/** glob npm test uses', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = repoFixture();
  mkdirSync(path.join(root, 'test', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'test', 'nested', 'deep.test.mjs'), 'x');
  const found = discoverTests(root);
  assert.ok(found.includes('test/nested/deep.test.mjs'), 'a flat readdir runs a different suite than npm test');
  assert.ok(found.includes('test/real.test.mjs'));
});

test('a test created during the session stays editable; a baseline test does not', async () => {
  /*
   * The shipped rule made every existing test immutable, so a typo in a test
   * written sixty seconds ago could not be fixed -- and inverting a test that
   * asserted a vulnerability was correct behaviour would have been impossible.
   * Seven of eleven commits on this branch modified an existing test.
   */
  const { writeFileSync } = await import('node:fs');
  const root = repoFixture();
  writeSnapshot(root, 'sess-1');                      // real.test.mjs is baseline
  writeFileSync(path.join(root, 'test', 'fresh.test.mjs'), 'x');

  const fresh = evaluateClaudeTool({
    tool_name: 'Edit', tool_input: { file_path: 'test/fresh.test.mjs', old_string: 'x', new_string: 'y' },
    cwd: root, session_id: 'sess-1',
  });
  assert.equal(fresh.allowed, true, 'a test this session created must remain editable');

  const baseline = evaluateClaudeTool({
    tool_name: 'Edit', tool_input: { file_path: 'test/real.test.mjs', old_string: 'x', new_string: 'y' },
    cwd: root, session_id: 'sess-1',
  });
  assert.equal(baseline.id, 'baseline-test-immutable');
});

/* ================= THE THREE REPAIRS THAT HAD NO GATE =================
 * Each of these was proven by hand in a scratch clone and then had no test, so
 * a mutation restoring the defect stayed green. Demonstrated is not gated.
 * ====================================================================== */

test('an interpreter cannot be used to write, whatever it names', async () => {
  /*
   * Measured against the shipped guard: all five ALLOWED. An interpreter builds
   * paths at runtime, so no list of filename spellings reaches them.
   */
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'node -e "require(\'fs\').unlinkSync(\'src/claudeGuard.mjs\')"',
    'python3 -c "open(\'scripts/claude-stop-gate.mjs\',\'w\').write(\'\')"',
    'perl -e "unlink q(src/claudeGuard.mjs)"',
    'node --eval "x"',
    'eval "$COMMAND"',
    'find src -name claudeGuard.mjs -delete',
    'find . -name x -exec rm {} ;',
    'cat f | xargs rm',
    'echo x > src/claudeGuard.mjs',
    'echo $(rm -rf src)',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

test('read-only work is still allowed, or the guard gets turned off', async () => {
  /*
   * npm test, node --test and sed are NO LONGER here. Running the suite is
   * executing repository code, and the Stop gate runs it in a process the turn
   * does not control. An agent gets a suite run at Stop, not on demand.
   */
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'git status --porcelain', 'git diff --stat HEAD', 'git log --oneline -5',
    'rg pattern src/', 'ls -la', 'cat package.json', 'head -20 CLAUDE.md',
    'git branch --list', 'git ls-remote --heads origin',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, true, `refused: ${command}`);
  }
});

test('a session snapshot is initialised ONCE and cannot be replaced', async () => {
  /*
   * THE RESET BYPASS. --session-start overwrote unconditionally, so: damage a
   * protected file, re-run --session-start, and Stop approves the damage as the
   * new baseline. A baseline the measured thing can rewrite is not a baseline.
   */
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const home = mkdtempSync(path.join(td(), 'guard-home-'));
  process.env.AGENTBRIDGE_HOME = home;
  const root = repoFixture();

  const first = writeSnapshot(root, 'sess-A');
  assert.equal(first.ok, true);
  const second = writeSnapshot(root, 'sess-A');
  assert.equal(second.ok, false, 'a second call must refuse');
  assert.match(second.reason, /may not be replaced/);
});

test('concurrent sessions do not share one baseline', () => {
  /*
   * The key was the repository path alone, so every Claude session in a repo
   * overwrote the same file. Two agents in one worktree is this project's normal
   * operating condition, not a corner case.
   */
  const root = repoFixture();
  assert.notEqual(snapshotPath(root, 'sess-A'), snapshotPath(root, 'sess-B'));
  assert.equal(snapshotPath(root, 'sess-A'), snapshotPath(root, 'sess-A'), 'and it is stable per session');
  assert.notEqual(snapshotPath(root, 'sess-A'), snapshotPath(root, undefined), 'a missing id is its own key, not a merge');
});

test('baseline test drift is detected, not merely recorded', async () => {
  /*
   * snapshot.tests was collected and never compared, so a weakened inherited
   * test would be RUN by the Stop gate and pass -- the suite grading itself
   * against rules the session had just relaxed.
   */
  const { writeFileSync } = await import('node:fs');
  const { baselineTestDrift } = await import('../src/guardSession.mjs');
  const root = repoFixture();
  const snapshot = buildSnapshot(root);
  writeFileSync(path.join(root, 'test', 'real.test.mjs'), 'test("weakened", () => {});');
  const drift = baselineTestDrift(root, snapshot);
  assert.ok(drift.some((d) => d.file === 'test/real.test.mjs'), 'a weakened baseline test must be visible');
});

/* ========== THE THREE REGRESSIONS IN 59a3b3c, EACH REPRODUCED FIRST ========== */

test('REGRESSION: a protected PREFIX is in the Stop snapshot, not filtered out', async () => {
  /*
   * PROTECTED_FILES was PROTECTED_PATHS.filter(p => !p.endsWith('/')), which
   * dropped every prefix -- so `.claude/` was protected at PreToolUse and ABSENT
   * from the snapshot, recreating the two-layer gap the single definition
   * existed to close. Measured: snapshot hashed no .claude file at all.
   */
  const { protectedFilesIn } = await import('../src/guardSession.mjs');
  const root = repoFixture();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  const files = protectedFilesIn(root);
  assert.ok(files.includes('.claude/settings.json'), 'a file under a protected prefix must be hashed');

  const snapshot = buildSnapshot(root);
  assert.ok('.claude/settings.json' in snapshot.files);
});

test('REGRESSION: a file ADDED or DELETED under a protected prefix is drift', async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const root = repoFixture();
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  const snapshot = buildSnapshot(root);

  writeFileSync(path.join(root, '.claude', 'sneaky-hook.mjs'), 'x');
  const added = protectedDrift(root, snapshot);
  assert.ok(added.some((d) => d.file === '.claude/sneaky-hook.mjs' && d.now === 'added'),
    'a new file under a protected prefix must be visible');

  rmSync(path.join(root, '.claude', 'settings.json'));
  const gone = protectedDrift(root, snapshot);
  assert.ok(gone.some((d) => d.file === '.claude/settings.json' && d.now === 'deleted'));
});

test('REGRESSION: the session id reaches the baseline-test check', async () => {
  /*
   * readSnapshot became session-scoped; this call site was not updated, so it
   * looked under the key 'no-session-id', found nothing, and every inherited
   * test was editable through Edit/Write.
   */
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  process.env.AGENTBRIDGE_HOME = mkdtempSync(path.join(td(), 'guard-home-'));
  const root = repoFixture();
  writeSnapshot(root, 'sess-X');

  const withId = evaluateClaudeTool({
    tool_name: 'Edit',
    tool_input: { file_path: 'test/real.test.mjs', old_string: 'a', new_string: 'b' },
    cwd: root, session_id: 'sess-X',
  });
  assert.equal(withId.id, 'baseline-test-immutable', 'with the id, the baseline test is protected');

  const withoutId = evaluateClaudeTool({
    tool_name: 'Edit',
    tool_input: { file_path: 'test/real.test.mjs', old_string: 'a', new_string: 'b' },
    cwd: root,
  });
  assert.equal(withoutId.allowed, false,
    'and without one it must still refuse -- an unknown session is not a permitted one');
});

test('REGRESSION: a snapshot from another repo or session is not adopted', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  process.env.AGENTBRIDGE_HOME = mkdtempSync(path.join(td(), 'guard-home-'));
  const root = repoFixture();
  const { readSnapshot, snapshotPath } = await import('../src/guardSession.mjs');
  writeSnapshot(root, 'sess-A');
  assert.ok(readSnapshot(root, 'sess-A'), 'control: its own snapshot reads');

  // Same bytes, filed under a different session key.
  const stolen = JSON.parse(readFileSync(snapshotPath(root, 'sess-A'), 'utf8'));
  writeFileSync(snapshotPath(root, 'sess-B'), JSON.stringify(stolen), { mode: 0o600 });
  assert.equal(readSnapshot(root, 'sess-B'), null, 'a snapshot carrying another sessionId must be refused');
});

test('REGRESSION: known writers are refused by exact shape', async () => {
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'git fetch origin', 'git branch newref', 'git branch -D main',
    'git remote set-url origin http://evil', 'npm ci', 'npm run build', 'npx cowsay',
    'node scripts/anything.mjs', 'env rm -rf src',
    'find . -name x -fprintf out.txt %p', 'sed -n "w target.txt" CLAUDE.md',
    'git -c core.pager=rm log', 'git log --output=x',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

/* ============ THE CLASS, NOT THE INSTANCE ============
 * Two reviews and this repository's own history say the same thing: filtering a
 * programming language does not converge. Tokenising missed node -e and friends.
 * Approving binaries missed nine of ten writers. Exact shapes missed
 * `sort -o package.json package.json` -- no metacharacter, approved shape, plain
 * arguments, rewrites in place -- and a thirty-second audit then found five more.
 * These tests pin the instances AND the framing, so nobody reads a green run as
 * a boundary.
 * ==================================================== */

test('write flags on otherwise read-only tools are refused', async () => {
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'sort -o package.json package.json',      // rewrites in place, reported by review
    'sort --output=CLAUDE.md a',
    'jq -f evil.jq package.json',
    'jq --argfile x /etc/passwd .',
    'diff --to-file=CLAUDE.md a b',
    'column -o x',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

test('test running is ALLOWED even though it executes repository code', async () => {
  /*
   * Deliberate, and the reason matters more than the rule. Refusing node and npm
   * outright makes iterative debugging impossible, and a rail that blocks
   * ordinary work is disabled by the first person in a hurry -- which loses the
   * Stop gate too. An override incentive is a vulnerability. A malicious test is
   * caught by Stop, not here.
   */
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  assert.equal(judgeShellCommand('node --test test/a.test.mjs').allowed, true);
  assert.equal(judgeShellCommand('npm test').allowed, true);
  // ...but not the arbitrary-execution forms, which buy nothing for iteration.
  assert.equal(judgeShellCommand('node -e "x"').allowed, false);
  assert.equal(judgeShellCommand('npm run build').allowed, false);
  assert.equal(judgeShellCommand('npm ci').allowed, false);
});

test('THE BOUNDARY: Stop catches what the rail lets through', async () => {
  /*
   * The load-bearing test of the whole design. PreToolUse allowed
   * `sort -o package.json package.json` before the write-flag rule existed; the
   * file was rewritten; the Stop gate blocked -- knowing nothing about `sort` or
   * `-o`. A check that inspects the RESULT does not need to enumerate the ways
   * of producing it, which is why the rail may leak and the gate may not.
   */
  const { writeFileSync } = await import('node:fs');
  const root = repoFixture();
  writeFileSync(path.join(root, 'package.json'), '{"name":"before"}');
  const snapshot = buildSnapshot(root);

  // However it happened -- any tool, any spelling, any bypass.
  writeFileSync(path.join(root, 'package.json'), '{"name":"after"}');

  const drift = protectedDrift(root, snapshot);
  assert.ok(
    drift.some((d) => d.file === 'package.json' && d.now === 'changed'),
    'the boundary must not depend on knowing which command did it',
  );
});
