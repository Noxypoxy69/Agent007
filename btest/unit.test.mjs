import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegex, matchesAny, ownerOf } from '../src/glob.mjs';
import { sign, verify, newNonce } from '../src/sign.mjs';
import { parseStatusZ, parseWorktreeList } from '../src/git.mjs';
import { parsePs, parseWinJson, classifyCommand } from '../src/processes.mjs';
import { classifyPath, redactPath } from '../src/redact.mjs';

test('glob: * stays within a path segment', () => {
  assert.ok(globToRegex('scripts/check-gates-*.mjs').test('scripts/check-gates-can-fail.mjs'));
  assert.ok(!globToRegex('scripts/*.mjs').test('scripts/lib/outboundSenders.mjs'));
});

test('glob: ** crosses segments', () => {
  assert.ok(globToRegex('src/**').test('src/a/b/c.ts'));
  assert.ok(globToRegex('**/*.test.ts').test('a/b/c.test.ts'));
  assert.ok(globToRegex('**/*.test.ts').test('c.test.ts'));
  assert.ok(!globToRegex('src/**').test('other/a.ts'));
});

test('glob: regex metacharacters in a path are literal', () => {
  assert.ok(globToRegex('docs/route-inventory.md').test('docs/route-inventory.md'));
  assert.ok(!globToRegex('docs/route-inventory.md').test('docs/routeXinventory.md'));
});

test('glob: windows separators normalise', () => {
  assert.ok(matchesAny('src\\lib\\merchantPhone.server.ts', ['src/**']));
});

test('ownerOf resolves lane, first match wins', () => {
  const lanes = {
    messaging: ['scripts/check-gates-*.mjs', 'src/lib/reply/**'],
    onboarding: ['src/lib/merchantPhone.server.ts'],
  };
  assert.equal(ownerOf('scripts/check-gates-can-fail.mjs', lanes), 'messaging');
  assert.equal(ownerOf('src/lib/merchantPhone.server.ts', lanes), 'onboarding');
  assert.equal(ownerOf('README.md', lanes), null);
});

test('signature verifies and rejects tampering', () => {
  const secret = 'deadbeef'.repeat(8);
  const base = { machineId: 'm1', timestamp: Date.now(), nonce: newNonce(), body: '{"a":1}' };
  const signature = sign({ ...base, secret });
  assert.equal(verify({ ...base, signature, secret }).ok, true);
  assert.equal(verify({ ...base, body: '{"a":2}', signature, secret }).reason, 'bad-signature');
  assert.equal(verify({ ...base, signature, secret: 'f'.repeat(64) }).reason, 'bad-signature');
});

test('signature rejects stale and future timestamps', () => {
  const secret = 'abc';
  const mk = (ts) => { const b = { machineId: 'm1', timestamp: ts, nonce: newNonce(), body: '{}' };
    return { ...b, signature: sign({ ...b, secret }), secret }; };
  assert.equal(verify(mk(Date.now() - 300_000)).reason, 'timestamp-out-of-window');
  assert.equal(verify(mk(Date.now() + 300_000)).reason, 'timestamp-out-of-window');
  assert.equal(verify(mk(Date.now())).ok, true);
});

test('signature rejects malformed nonce', () => {
  const secret = 'abc';
  const b = { machineId: 'm1', timestamp: Date.now(), nonce: 'short', body: '{}' };
  assert.equal(verify({ ...b, signature: sign({ ...b, secret }), secret }).reason, 'bad-nonce');
});

test('status -z parses renames without shifting later entries', () => {
  const buf = 'R  new.ts\0old.ts\0 M src/a.ts\0?? junk.log\0M  staged.ts\0';
  const e = parseStatusZ(buf);
  assert.equal(e.length, 4);
  assert.deepEqual(e[0], { x: 'R', y: ' ', path: 'new.ts', from: 'old.ts', staged: true, dirty: false, untracked: false });
  assert.equal(e[1].path, 'src/a.ts');
  assert.equal(e[1].dirty, true);
  assert.equal(e[1].staged, false);
  assert.equal(e[2].untracked, true);
  assert.equal(e[3].staged, true);
});

test('status -z handles paths containing spaces', () => {
  const e = parseStatusZ(' M src/my file.ts\0');
  assert.equal(e[0].path, 'src/my file.ts');
});

test('worktree list --porcelain parses branches and detached heads', () => {
  const text = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /repo-c', 'HEAD bbb', 'branch refs/heads/code-c/messaging-gates', '',
    'worktree /repo-d', 'HEAD ccc', 'detached', '',
  ].join('\n');
  const w = parseWorktreeList(text);
  assert.equal(w.length, 3);
  assert.equal(w[1].branch, 'code-c/messaging-gates');
  assert.equal(w[2].detached, true);
});

test('ps parsing and command classification', () => {
  const p = parsePs('  123  1 npm run verify\n  456 123 node --test test/\nbad line\n');
  assert.equal(p.length, 2);
  assert.equal(p[0].pid, 123);
  assert.equal(classifyCommand(p[0].command), 'verify');
  assert.equal(classifyCommand('node scripts/check-gates-can-fail.mjs'), 'gates-can-fail');
  assert.equal(classifyCommand('code .'), null);
});

test('windows process JSON parses single object and array', () => {
  assert.equal(parseWinJson('{"ProcessId":7,"ParentProcessId":1,"CommandLine":"npm run verify"}').length, 1);
  assert.equal(parseWinJson('[{"ProcessId":7,"CommandLine":"x"},{"ProcessId":8,"CommandLine":"y"}]').length, 2);
  assert.deepEqual(parseWinJson('not json'), []);
});

test('sensitive paths are classified and redacted', () => {
  assert.equal(classifyPath('.env'), 'env');
  assert.equal(classifyPath('apps/web/.env.local'), 'env');
  assert.equal(classifyPath('certs/server.pem'), 'key-material');
  assert.equal(classifyPath('src/lib/reply.ts'), null);
  assert.equal(redactPath('.env.production').path, '<<redacted:env>>');
  assert.equal(redactPath('.env.production', false).path, '.env.production');
  assert.equal(redactPath('src/a.ts').sensitive, false);
});

test('ambiguous command-line matches are flagged, not asserted into both worktrees', async () => {
  const { probeProcesses } = await import('../src/processes.mjs');
  const r = await probeProcesses(['/tmp/nonexistent-wt-a', '/tmp/nonexistent-wt-b']);
  // Probe itself must succeed on this platform; no process should be claimed
  // by a worktree that does not exist.
  assert.equal(r.probeOk, true);
  for (const list of Object.values(r.byWorktree)) {
    for (const p of list) {
      if (p.ambiguous) assert.ok(Array.isArray(p.alsoMatched) && p.alsoMatched.length > 0);
    }
  }
});
