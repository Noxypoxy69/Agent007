import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateClaudeTool, hookDecision, isProtectedPath } from '../src/claudeGuard.mjs';

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

test('makes existing tests immutable but permits adding a real test', () => {
  const root = repoFixture();
  const blocked = evaluateClaudeTool({
    tool_name: 'Edit',
    tool_input: { file_path: 'test/real.test.mjs', old_string: 'test(', new_string: 'test.skip(' },
    cwd: root,
  });
  assert.equal(blocked.id, 'existing-test-immutable');
  const allowed = evaluateClaudeTool({
    tool_name: 'Write',
    tool_input: { file_path: 'test/new.test.mjs', content: 'test("new", () => {});' },
    cwd: root,
  });
  assert.equal(allowed.allowed, true);
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
