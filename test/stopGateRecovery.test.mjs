/*
 * WHY THIS FILE EXISTS.
 *
 * On 2026-09-17 every terminal on the operator's machine wedged at once. The
 * Stop gate refuses when a session has no baseline -- correctly, because an
 * absent baseline is not a clean one -- but there was NO WAY BACK. A session
 * whose SessionStart never ran cannot write its own baseline (only
 * --session-start does) and cannot run that command either (`node` is
 * allowlisted only with --test). Block, retry, block, forever.
 *
 * A control with no recovery path is an outage, and an outage is how a guard
 * gets switched off entirely -- losing every layer, which is the thing this
 * whole subsystem exists to prevent.
 *
 * Both directions are asserted. The recovery must WORK (or the outage stands)
 * and it must REFUSE to mint a baseline from a modified tree (or it becomes the
 * reset bypass that writeSnapshot's exclusive create was added to close).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway git repo carrying the guard and the protected paths. */
function scratchRepo({ git = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-gate-'));
  for (const d of ['src', 'scripts', 'bin']) cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  for (const d of ['.claude', 'docs', 'test']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'CLAUDE.md', 'THIRD_PARTY_CODE.md']) {
    writeFileSync(path.join(dir, f), '{}\n');
  }
  for (const f of ['docs/ORDER.md', 'docs/ROADMAP.md', 'docs/CLAUDE_GUARD_PROVENANCE.md',
    '.claude/settings.json', 'test/claudeGuard.test.mjs']) {
    writeFileSync(path.join(dir, f), 'x\n');
  }
  if (git) {
    const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    run('init', '-q', '.');
    run('add', '-A');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
      { cwd: dir, stdio: 'ignore' });
  }
  return dir;
}

function stop(dir, sessionId) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'claude-stop-gate.mjs')], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AGENTBRIDGE_HOME: path.join(dir, 'home') },
  });
  let parsed = {};
  try { parsed = JSON.parse(r.stdout || '{}'); } catch { parsed = {}; }
  return { status: r.status, reason: parsed.reason ?? '', blocked: parsed.decision === 'block' };
}

test('a session with no baseline recovers instead of wedging forever', (t) => {
  const dir = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = stop(dir, 'session-alpha');
  assert.equal(first.blocked, true, 'the unverified turn must still be blocked -- nothing here approves anything');
  assert.match(first.reason, /baseline-created/, `expected a minted baseline, got: ${first.reason}`);

  /*
   * THE POINT OF THE WHOLE FILE. Before the fix this second call returned the
   * SAME no-session-snapshot refusal, forever. It must now get past the snapshot
   * branch -- whatever it decides afterwards on other grounds.
   */
  const second = stop(dir, 'session-alpha');
  assert.doesNotMatch(second.reason, /no-session-snapshot/,
    `the second turn must not repeat the dead end, got: ${second.reason}`);
  assert.doesNotMatch(second.reason, /baseline-created/,
    `the baseline must persist rather than being minted again, got: ${second.reason}`);
});

test('a baseline is NEVER minted from a tree whose protected files already differ', (t) => {
  const dir = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /* POSITIVE FIRST: prove a clean tree DOES mint, or the refusal below proves nothing. */
  assert.match(stop(dir, 'control-session').reason, /baseline-created/,
    'control: a clean tree must mint, otherwise this test passes for the wrong reason');

  appendFileSync(path.join(dir, 'src', 'claudeGuard.mjs'), '\n// tampered\n');
  const verdict = stop(dir, 'tampering-session');
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /no-session-snapshot/, `expected a refusal, got: ${verdict.reason}`);
  assert.match(verdict.reason, /claudeGuard\.mjs/, 'the refusal must name the file that differs');
  assert.doesNotMatch(verdict.reason, /baseline-created/,
    'minting here would adopt the damage as normal -- the reset bypass, rebuilt');
});

test('a weakened baseline test also blocks minting, not just a protected file', (t) => {
  /*
   * FOUND BY AUDIT, AFTER THE FIRST VERSION OF THIS RECOVERY SHIPPED IN THE
   * WORKING TREE. A snapshot records EVERY test file, but only
   * test/claudeGuard.test.mjs is a PROTECTED path. So the first git check --
   * which looked at protected paths alone -- called a tree clean while an
   * ordinary test sat weakened in it, and minted a baseline recording the
   * weakened test as normal. The reset bypass, rebuilt through a different door.
   */
  const dir = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const testFile = path.join(dir, 'test', 'important.test.mjs');
  writeFileSync(testFile, 'import {test} from "node:test";\ntest("real check", () => {});\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add test'],
    { cwd: dir, stdio: 'ignore' });

  /* POSITIVE FIRST: with that test intact, minting must work -- otherwise the
   * refusal below could be caused by anything at all. */
  assert.match(stop(dir, 'control-2').reason, /baseline-created/,
    'control: a clean tree with this test committed must mint');

  writeFileSync(testFile, 'import {test} from "node:test";\ntest.skip("real check", () => {});\n');
  const verdict = stop(dir, 'weakener-session');
  assert.equal(verdict.blocked, true);
  assert.doesNotMatch(verdict.reason, /baseline-created/,
    'minting here records the weakened test as the baseline');
  assert.match(verdict.reason, /important\.test\.mjs/, 'the refusal must name the weakened test');
  assert.match(verdict.reason, /baseline-test/, 'and say which kind of file it is');
});

test('when git cannot be consulted the gate refuses rather than assuming clean', (t) => {
  const dir = scratchRepo({ git: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const verdict = stop(dir, 'no-git-session');
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /unknown is not clean/, `expected an explicit unknown, got: ${verdict.reason}`);
  assert.doesNotMatch(verdict.reason, /baseline-created/, 'an unmeasurable tree must not mint a baseline');
});
