import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateClaudeTool, hookDecision, isProtectedPath } from '../src/claudeGuard.mjs';
import { buildSnapshot, writeSnapshot, protectedDrift, discoverTests, snapshotPath } from '../src/guardSession.mjs';

/*
 * A REAL GIT REPOSITORY, BECAUSE THE GUARD ONLY EVER RUNS IN ONE.
 *
 * This was a bare temp directory, which was invisible until writeSnapshot began
 * asking git whether the tree it is about to adopt as normal is clean. A plain
 * mkdtemp directory is unmeasurable, and unmeasurable is refused -- so the old
 * fixture would exercise the refusal path in every test instead of the behaviour
 * each one is about, and three tests here failed for a reason none of them is
 * about. Not one asserts anything concerning a directory outside git.
 *
 * Every assertion in those tests is unchanged. Only the setup became honest.
 *
 * commit.gpgsign=false because a contributor with commit signing configured
 * globally would otherwise have the fixture fail for reasons unrelated to it.
 */
function repoFixture({ commit = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentbridge-guard-'));
  mkdirSync(path.join(root, 'test'));
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(path.join(root, 'test', 'real.test.mjs'), 'test("real", () => {});');
  const git = (...args) => execFileSync('git', [
    '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  if (commit) {
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  }
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
    'git branch newref', 'git branch -D main',
    'git remote set-url origin http://evil', 'npx cowsay', 'env rm -rf src',
    'find . -name x -fprintf out.txt %p', 'sed -n "w target.txt" CLAUDE.md',
    'git -c core.pager=rm log', 'git log --output=x',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

/*
 * FOUR COMMANDS LEFT THE LIST ABOVE ON 2026-09-17, AND THE REASON IS AN OUTAGE
 * RATHER THAN A PREFERENCE.
 *
 * This rail refused everything not provably READ-ONLY, which also refused
 * `git pull`, `git fetch`, `git commit`, `npm ci` and `npm run` -- the things
 * agents do all day. That stopped all work on the operator's machine; every
 * terminal blocked at once. The rail's own comments say an override incentive is
 * a vulnerability and that a guard blocking ordinary work gets switched off,
 * losing the Stop gate with it. This is that, measured.
 *
 * The criterion was wrong. What needed stopping was DESTRUCTION OF THE CONTROL
 * FILES, not writing. These execute repository code or move the tree, which is
 * the risk `npm test` already carries and which the test below accepts by name.
 * Caught at Stop by protected-file and baseline-test drift.
 *
 * The nine above stay refused, so this is a narrowing of the rule, not its
 * removal.
 */
test('ordinary writes are allowed, because a rail that blocks Tuesday gets switched off', async () => {
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'git fetch origin', 'git pull origin main', 'git commit -m msg', 'git checkout a-branch',
    'npm ci', 'npm run build', 'node scripts/anything.mjs',
    'git status ; ls', 'git status && ls -la', 'npm test 2>&1',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, true, `REFUSED: ${command}`);
  }
});

/*
 * AND THE LINE THE WIDENING MUST NOT CROSS: a permitted write may not be turned
 * into a DISARM. `git restore src/claudeGuard.mjs` overwrites the guard's own
 * source, and the hook re-reads that module on every invocation -- so the guard
 * is gone for the rest of the session the moment the command returns. "Caught at
 * Stop" is the right posture for `npm test` and the wrong one for a command
 * whose whole effect is replacing the control being evaded.
 *
 * Every one of these passed when the widening was first written, and each was
 * caught by a baseline test older than this rail. That is the whole argument for
 * not editing inherited tests to make a change look clean.
 */
test('a permitted git write may not name a control or a baseline test', async () => {
  const { judgeShellCommand } = await import('../src/shellAllowlist.mjs');
  for (const command of [
    'git restore src/claudeGuard.mjs',
    'git checkout HEAD~5 -- src/guardSession.mjs',
    'git checkout -- .claude/settings.json',
    'git add CLAUDE.md',
    'git restore test/real.test.mjs',
    'git checkout -- test/a.test.mjs',
    'git push origin master',
    'git push origin main',
    'git push --force origin feature',
    'git push --force-with-lease origin feature',
    'git push origin HEAD:master',
    'git push --mirror origin',
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

  /*
   * `npm run build` AND `npm ci` USED TO BE ASSERTED REFUSED HERE, AND THE
   * REASONING ABOVE IS WHY THEY NO LONGER ARE. They execute repository code --
   * so does `npm test`, two lines up, and this test's own comment accepts that
   * risk on the grounds that refusing it gets the rail switched off. Refusing
   * install and build drew the line in a place that stopped all work on the
   * operator's machine on 2026-09-17 while `npm test` sat permitted beside it.
   * Both are caught at Stop, by the same drift checks, for the same reason.
   */
  assert.equal(judgeShellCommand('npm run build').allowed, true);
  assert.equal(judgeShellCommand('npm ci').allowed, true);

  /*
   * The arbitrary-execution forms stay refused, and the distinction is not
   * arbitrary: a script in the repository is visible, reviewable and covered by
   * baseline-test drift at Stop. A -e string is composed on the spot and is none
   * of those things -- there is nothing for any later check to compare against.
   */
  assert.equal(judgeShellCommand('node -e "x"').allowed, false);
  assert.equal(judgeShellCommand('node --eval x').allowed, false);
  assert.equal(judgeShellCommand('node -p 1+1').allowed, false);
  assert.equal(judgeShellCommand('npm publish').allowed, false);
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

test('shell segmentation respects quoted separators instead of inventing commands', async () => {
  const { segments } = await import('../src/shellAllowlist.mjs');
  assert.deepEqual(segments('git status && ls'), ['git status', 'ls']);
  assert.deepEqual(segments('git commit -m "fix; still one command"'), ['git commit -m "fix; still one command"']);
  assert.deepEqual(segments("git commit -m 'fix && still one command'"), ["git commit -m 'fix && still one command'"]);
});

test('quoted arguments are tokenized as data and unbalanced quotes fail closed', async () => {
  const { judgeShellCommand, tokenize } = await import('../src/shellAllowlist.mjs');
  assert.deepEqual(tokenize('grep "a;b && c" CLAUDE.md'), {
    tokens: [
      { value: 'grep', quoted: false },
      { value: 'a;b && c', quoted: true },
      { value: 'CLAUDE.md', quoted: false },
    ],
    balanced: true,
  });
  assert.equal(judgeShellCommand('grep "a;b" CLAUDE.md').allowed, true);
  assert.equal(judgeShellCommand('echo "a && b"').allowed, true);
  assert.equal(judgeShellCommand('grep "unterminated CLAUDE.md').allowed, false);
});

/*
 * THE RESET BYPASS, ACROSS SESSIONS. This is the one the exclusive create does
 * not close.
 *
 * writeSnapshot refuses to REPLACE a snapshot, and the test above proves it. But
 * snapshotPath keys on sha256(repoRoot + sessionId), so a NEW session id is a
 * NEW file and the exclusive create never fires. Damage a protected control, let
 * the session end, start another, and SessionStart mints a baseline from the
 * damaged tree -- after which the Stop gate compares damage against damage and
 * finds no drift. The control the shell rail and the MCP path both defer to is
 * then silently disarmed.
 *
 * Measured before the fix: session B minted, and protectedDrift returned [].
 *
 * The Stop gate's own recovery path already refused this correctly. The check
 * lived in that ONE caller, and SessionStart -- the path that mints almost every
 * baseline -- had none. So it moves into writeSnapshot, where every caller
 * inherits it and the next one cannot forget.
 */
test('a NEW session may not mint a baseline over a damaged tree', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'guard-home-'));
  process.env.AGENTBRIDGE_HOME = home;
  const root = repoFixture();

  assert.equal(writeSnapshot(root, 'sess-A').ok, true, 'a clean tree mints normally');

  // A protected control is damaged: local settings can switch the hooks off.
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{"disableAllHooks":true}');

  const second = writeSnapshot(root, 'sess-B');
  assert.equal(second.ok, false, 'a new session must not adopt the damaged tree as normal');
  assert.match(second.reason, /already differ|not clean|drift/i);
});

test('a WEAKENED BASELINE TEST also blocks minting, not just protected paths', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'guard-home-'));
  process.env.AGENTBRIDGE_HOME = home;
  const root = repoFixture();

  // Only test/claudeGuard.test.mjs is a PROTECTED path; every other test is
  // merely a baseline test. Weakening one is the same bypass through a different
  // door, and git-drift covers both.
  writeFileSync(path.join(root, 'test', 'real.test.mjs'), 'test("real", () => { /* gutted */ });');

  const r = writeSnapshot(root, 'sess-C');
  assert.equal(r.ok, false, 'a weakened inherited test must not become the baseline');
});

test('minting is REFUSED where git cannot answer: unknown is not clean', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'guard-home-'));
  process.env.AGENTBRIDGE_HOME = home;
  const root = mkdtempSync(path.join(tmpdir(), 'agentbridge-nogit-'));
  mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, 'test', 'real.test.mjs'), 'test("real", () => {});');

  const r = writeSnapshot(root, 'sess-D');
  assert.equal(r.ok, false, 'an unmeasurable tree is not a clean one');
  assert.match(r.reason, /could not|unknown|not a git/i);
});

test('AND IT STILL MINTS on a clean tree — a gate that only refuses is an outage', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'guard-home-'));
  process.env.AGENTBRIDGE_HOME = home;
  const root = repoFixture();
  const r = writeSnapshot(root, 'sess-E');
  assert.equal(r.ok, true, `a clean committed tree must still mint: ${r.reason ?? ''}`);
});

test('REPORTING A PROTECTED FILE IS NOT WRITING ONE', () => {
  /*
   * Both of these were REFUSED for naming a protected path, and both refusals
   * landed on the work this guard exists to support: SendUserFile could not send
   * CLAUDE.md or .claude/settings.json, and ReportFindings was refused whenever a
   * finding named src/claudeGuard.mjs -- so a security review of the guard could
   * not be filed through the normal channel.
   *
   * THE NEGATIVE NEEDS THE POSITIVE, so the writes are asserted in the same test.
   * "SendUserFile is allowed" alone would also pass on a guard that allowed
   * everything, and that is the failure direction that matters here.
   */
  const root = repoFixture();
  const at = (tool, input) => evaluateClaudeTool({ tool_name: tool, tool_input: input, cwd: root });

  for (const f of ['CLAUDE.md', '.claude/settings.json', 'src/claudeGuard.mjs']) {
    assert.equal(at('SendUserFile', { files: [f] }).allowed, true, `sending ${f} is a read, not a write`);
  }
  assert.equal(
    at('ReportFindings', { findings: [{ file: 'src/claudeGuard.mjs', summary: 's', failure_scenario: 'f' }] }).allowed,
    true,
    'a finding about the guard must be reportable',
  );

  /* The same paths, actually written, are still refused. */
  for (const [tool, input] of [
    ['Edit', { file_path: 'src/claudeGuard.mjs', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '.claude/settings.json', content: '{}' }],
    ['Write', { file_path: 'CLAUDE.md', content: 'x' }],
  ]) {
    const r = at(tool, input);
    assert.equal(r.allowed, false, `${tool} on ${input.file_path} must still be refused`);
    assert.equal(r.id, 'protected-control');
  }
});

test('Workflow is NOT read-only, and the comment about it names the real control', () => {
  /*
   * The comment above COMMAND_FIELDS claimed the fix was "Workflow's entry in
   * READ_ONLY_TOOLS above". There is no such entry and there must never be one:
   * Workflow carries executable script content. The tool is in fact handled by
   * its own deny. This asserts both halves, because a comment naming the wrong
   * control is how the next reader "fixes" something that was already right.
   */
  const src = readFileSync(new URL('../src/claudeGuard.mjs', import.meta.url), 'utf8');
  const list = src.slice(src.indexOf('const READ_ONLY_TOOLS'), src.indexOf('const COMMAND_FIELDS'));
  assert.equal(/'Workflow'/.test(list), false, 'Workflow must never be listed as read-only');

  const r = evaluateClaudeTool({
    tool_name: 'Workflow', tool_input: { script: 'export const meta = {}' }, cwd: repoFixture(),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'workflow-exec-untrusted', 'and it is refused by its own rule, not by the shell rail');
});
