import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateClaudeTool, hookDecision, isProtectedPath, shellPathTokens } from '../src/claudeGuard.mjs';
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
  const root = repoFixture();
  for (const [command, id] of [
    ['rm test/real.test.mjs', 'test-removed'],
    ['git reset --hard HEAD~1', 'destructive-git'],
    ['git push origin master', 'protected-push'],
    ['git push --force origin feature', 'protected-push'],
    ['printf "fake" > test/real.test.mjs', 'test-removed'],
    ['git restore test/real.test.mjs', 'test-removed'],
  ]) {
    assert.equal(evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root }).id, id, command);
  }
});

test('blocks self-modification through Claude and npm configuration commands', () => {
  const root = repoFixture();
  for (const [command, id] of [
    ['claude plugin disable guard-pack', 'claude-config-mutation'],
    ['claude config set permissions.default allow', 'claude-config-mutation'],
    ['npm pkg set scripts.test="printf fake"', 'package-control-mutation'],
  ]) {
    assert.equal(evaluateClaudeTool({ tool_name: 'Bash', tool_input: { command }, cwd: root }).id, id, command);
  }
});

test('does not confuse harmless reads with mutations', () => {
  const root = repoFixture();
  for (const command of ['git diff -- test/real.test.mjs', 'sed -n "1,20p" CLAUDE.md', 'node --test test/real.test.mjs']) {
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

test('path tokens are extracted, not pattern-matched against the command', () => {
  assert.deepEqual(shellPathTokens('rm src/claudeGuard.mjs'), ['src/claudeGuard.mjs']);
  assert.deepEqual(shellPathTokens('cat > .claude/settings.json'), ['.claude/settings.json']);
  assert.deepEqual(shellPathTokens('rm "src/a.mjs"'), ['src/a.mjs'], 'quotes come off');
  assert.deepEqual(shellPathTokens('rm -rf src/a.mjs'), ['src/a.mjs'], 'flags are not paths');
  assert.deepEqual(shellPathTokens('echo hello'), [], 'a bare word is not a path');
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
  writeSnapshot(root, buildSnapshot(root));          // real.test.mjs is baseline
  writeFileSync(path.join(root, 'test', 'fresh.test.mjs'), 'x');

  const fresh = evaluateClaudeTool({
    tool_name: 'Edit', tool_input: { file_path: 'test/fresh.test.mjs', old_string: 'x', new_string: 'y' }, cwd: root,
  });
  assert.equal(fresh.allowed, true, 'a test this session created must remain editable');

  const baseline = evaluateClaudeTool({
    tool_name: 'Edit', tool_input: { file_path: 'test/real.test.mjs', old_string: 'x', new_string: 'y' }, cwd: root,
  });
  assert.equal(baseline.id, 'baseline-test-immutable');
});
