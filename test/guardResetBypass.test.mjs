/**
 * THE RESET BYPASS, ACROSS SESSIONS. Measured 2026-09-17, not theorised.
 *
 * The Stop gate is the boundary. shellAllowlist.mjs says so in its own header --
 * "THE BOUNDARY IS NOT HERE. It is the Stop gate" -- and deliberately stays
 * porous because filtering a programming language does not work. Everything
 * therefore rests on Stop comparing the tree against a baseline the measured
 * thing cannot rewrite.
 *
 * It could rewrite it, by starting another session. writeSnapshot's exclusive
 * create carried a comment claiming it closed this ("Initialise once; a second
 * call says so"), and that claim was true only WITHIN one session: the snapshot
 * path is keyed on sha256(repoRoot, sessionId), so a new session is a new key
 * and EEXIST never fires. The defence that would have caught it existed and was
 * correct -- baselineBlockingDriftFromGit -- but lived only in the Stop gate's
 * rarely-taken recovery path, while the path every session takes had none.
 *
 * Six steps, reproduced end to end below: session A baselines a clean tree,
 * .claude/settings.json is edited to disable hooks, A's Stop blocks correctly, A
 * cannot re-baseline, session B baselines the SAME damaged tree, and B's Stop
 * reports no drift. The damage had become the baseline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway repository carrying the guard's own shipped files. */
function guardedRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'reset-bypass-'));
  const home = mkdtempSync(path.join(tmpdir(), 'reset-home-'));
  t.after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });
  for (const d of ['src', 'test', 'scripts', 'bin', '.claude']) mkdirSync(path.join(root, d), { recursive: true });
  /* safeGit.mjs is copied because guardSession imports it: the gate's own git
   * calls go through the hardened path. A fixture missing it makes the guard
   * unloadable, which the positive control below catches rather than letting the
   * refusal assertions pass for the wrong reason. */
  for (const f of ['src/guardSession.mjs', 'src/claudeGuard.mjs', 'src/shellAllowlist.mjs', 'src/safeGit.mjs',
    'scripts/claude-stop-gate.mjs', 'bin/agentbridge-claude-guard.mjs']) {
    cpSync(path.join(repoRoot, f), path.join(root, f));
  }
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":false}}\n');
  writeFileSync(path.join(root, 'test', 'a.test.mjs'), 'import test from "node:test"; test("ok",()=>{});\n');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { root, home };
}

const hook = ({ root, home }, script, sessionId, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGENTBRIDGE_HOME: home, CLAUDE_PROJECT_DIR: root },
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { unparseable: r.stdout, stderr: r.stderr }; }
};
const sessionStart = (env, id) => hook(env, 'bin/agentbridge-claude-guard.mjs', id, ['--session-start']);
const stop = (env, id) => hook(env, 'scripts/claude-stop-gate.mjs', id);
const damage = (env) => writeFileSync(path.join(env.root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":true}}\n');

test('a NEW session cannot baseline a tree whose protected controls were already damaged', (t) => {
  const env = guardedRepo(t);

  /* THE POSITIVE FIRST: on a clean tree this all works, or the refusal below
   * proves only that the guard refuses everything. */
  assert.match(sessionStart(env, 'A').systemMessage ?? '', /initialised/, 'control: a clean tree baselines');
  assert.deepEqual(stop(env, 'A'), {}, 'control: an undamaged session is approved');

  damage(env);
  assert.equal(stop(env, 'A').decision, 'block', 'the damaged session is blocked');
  assert.match(sessionStart(env, 'A').systemMessage ?? '', /NOT replaced/, 'and cannot re-baseline itself');

  /* THE BYPASS. This minted a baseline over the damage and returned {} at Stop. */
  const fresh = sessionStart(env, 'B');
  assert.match(fresh.systemMessage ?? '', /NOT replaced/, 'a new session must not baseline a damaged tree');
  assert.doesNotMatch(fresh.systemMessage ?? '', /initialised/, 'no snapshot may be minted here');

  const verdict = stop(env, 'B');
  assert.equal(verdict.decision, 'block', 'and the new session must not be approved either');
  assert.match(verdict.reason, /\.claude\/settings\.json/, 'naming the file that differs');
});

test('the refusal lifts once the damage is repaired -- it is a gate, not a wall', (t) => {
  const env = guardedRepo(t);
  sessionStart(env, 'A');
  damage(env);
  assert.match(sessionStart(env, 'B').systemMessage ?? '', /NOT replaced/);

  execFileSync('git', ['checkout', '--', '.claude/settings.json'], { cwd: env.root, stdio: 'ignore' });

  /*
   * A CONTROL WITH NO RECOVERY PATH IS AN OUTAGE, and this repository has
   * already paid for one: every terminal blocked at once on 2026-09-17.
   */
  assert.match(sessionStart(env, 'C').systemMessage ?? '', /initialised/, 'a repaired tree baselines again');
  assert.deepEqual(stop(env, 'C'), {}, 'and the session proceeds normally');
});

test('unknown is not clean: a tree git cannot describe does not get a baseline', (t) => {
  const env = guardedRepo(t);

  /* Remove git's view of the tree. The files are untouched and look perfect;
   * what is gone is any way to tell whether they were always this way. */
  rmSync(path.join(env.root, '.git'), { recursive: true, force: true });

  const r = sessionStart(env, 'A');
  assert.doesNotMatch(r.systemMessage ?? '', /initialised/, 'no baseline from an undescribable tree');
  assert.match(r.systemMessage ?? '', /NOT replaced/);
  assert.equal(stop(env, 'A').decision, 'block', 'and Stop refuses rather than approving the unknown');
});
