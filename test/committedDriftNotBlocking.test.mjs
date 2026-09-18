import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImports, resolveSpecifier } from '../src/moduleGraph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * A TEAMMATE'S LANDED COMMIT IS NOT THIS SESSION TAMPERING.
 *
 * The snapshot is minted once at SessionStart and never refreshed. In a shared
 * worktree with three agents, every control another agent legitimately commits
 * drifts you for the life of your session -- and committing does not clear it,
 * because the gate re-mints only at SessionStart and only from a clean tree.
 *
 * Measured 2026-09-18: code-b was refused on every turn with eleven lines,
 * eight caused by commits that landed after its snapshot was taken. It was
 * blocked from ENDING A TURN, not from working, and each one cost the operator
 * a manual unblock.
 *
 * The gate exists to stop THIS session quietly mutating a control. A committed
 * change is not quiet: it is attributable, diffable and revertible. So it is
 * reported and does not block. An UNCOMMITTED change still blocks, and that is
 * the half these tests exist to keep honest.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function guardedRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'committed-drift-'));
  const home = mkdtempSync(path.join(tmpdir(), 'committed-home-'));
  t.after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });
  for (const d of ['src', 'test', 'scripts', 'bin', '.claude']) mkdirSync(path.join(root, d), { recursive: true });

  const closureOf = (entries) => {
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      let src;
      try { src = readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
      for (const spec of parseImports(src).specifiers) {
        const target = resolveSpecifier(repoRoot, rel, spec);
        if (!target) continue;
        const t2 = target.split(path.sep).join('/');
        if (!seen.has(t2)) queue.push(t2);
      }
    }
    return [...seen];
  };
  for (const f of closureOf(['bin/agentbridge-claude-guard.mjs', 'scripts/claude-stop-gate.mjs'])) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    cpSync(path.join(repoRoot, f), path.join(root, f));
  }
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":false}}\n');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# rules\n');
  writeFileSync(path.join(root, 'test', 'a.test.mjs'), 'import test from "node:test"; test("ok",()=>{});\n');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { root, home, git };
}

const hook = ({ root, home }, script, sessionId, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    timeout: 120000,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGENTBRIDGE_HOME: home, CLAUDE_PROJECT_DIR: root,
    },
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { unparseable: r.stdout, stderr: r.stderr }; }
};
const sessionStart = (env, id) => hook(env, 'bin/agentbridge-claude-guard.mjs', id, ['--session-start']);
const stop = (env, id) => hook(env, 'scripts/claude-stop-gate.mjs', id);

test('A CONTROL COMMITTED AFTER THE SNAPSHOT DOES NOT BLOCK THE TURN', (t) => {
  const env = guardedRepo(t);
  assert.match(sessionStart(env, 'A').systemMessage ?? '', /initialised/, 'control: a clean tree baselines');

  // Another agent lands a legitimate change to a protected control, and commits.
  writeFileSync(path.join(env.root, 'CLAUDE.md'), '# rules\n\nrule 22: something new\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'a teammate lands a rule');

  const verdict = stop(env, 'A');
  assert.notEqual(verdict.decision, 'block',
    `a COMMITTED control change must not block the turn -- this is what left a session unable to `
    + `end any turn for hours: ${verdict.reason ?? ''}`);
});

test('BUT IT IS REPORTED, so not blocking is not the same as not noticing', (t) => {
  const env = guardedRepo(t);
  sessionStart(env, 'A');
  writeFileSync(path.join(env.root, 'CLAUDE.md'), '# rules\n\nrule 22\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'landed');

  const verdict = stop(env, 'A');
  assert.match(verdict.systemMessage ?? '', /protected-control-committed/,
    'the whole argument for permitting this is that the change is on the record, so the gate must '
    + 'put it on the record');
  assert.match(verdict.systemMessage ?? '', /CLAUDE\.md/, 'and name the file');
});

test('AN UNCOMMITTED CHANGE TO A CONTROL STILL BLOCKS', (t) => {
  /*
   * RULE 5, and it is the entire point. If this passes only because the gate
   * stopped refusing anything, the change above is not a fix, it is a hole.
   */
  const env = guardedRepo(t);
  sessionStart(env, 'A');
  writeFileSync(path.join(env.root, 'CLAUDE.md'), '# rules\n\nquietly edited, never committed\n');

  const verdict = stop(env, 'A');
  assert.equal(verdict.decision, 'block',
    'a live modification nobody has recorded is exactly what this gate is for');
  assert.match(verdict.reason ?? '', /protected-control-changed/);
});

test('A DELETED CONTROL STILL BLOCKS EVEN IF THE DELETION IS COMMITTED', (t) => {
  /*
   * Deletion is not the same claim as modification. A committed edit to a
   * control leaves something to read and revert; a committed deletion of the
   * guard's own source is the incident this repository was built around -- a
   * real session deleted src/claudeGuard.mjs and nothing refused.
   */
  const env = guardedRepo(t);
  sessionStart(env, 'A');
  rmSync(path.join(env.root, 'CLAUDE.md'));
  env.git('add', '-A');
  env.git('commit', '-qm', 'remove a control');

  const verdict = stop(env, 'A');
  assert.equal(verdict.decision, 'block',
    'committing a deletion must not buy silence: deleted is not modified');
});

test('AND THE GATE CONFIGURATION IS NOT EXEMPTED BY COMMITTING IT', (t) => {
  /*
   * .claude/settings.json decides whether the guard runs at all. Committing a
   * change to it must not be a way to disarm quietly -- the gate refuses an
   * override for it, and committing is not a stronger permission than a grant.
   */
  const env = guardedRepo(t);
  sessionStart(env, 'A');
  writeFileSync(path.join(env.root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":true}}\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'disable the hooks, committed');

  const verdict = stop(env, 'A');
  assert.equal(verdict.decision, 'block',
    'the hook configuration is the one file no permission reaches, and a commit is not an exception');
});
