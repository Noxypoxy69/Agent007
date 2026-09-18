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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
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

/* ============================================================================
 * THE SAME BYPASS, ARRIVING CLEAN. a24d499 closed the DIRTY route and not this.
 *
 * The test above damages the tree by writing the file, so the tree is dirty
 * against HEAD and the new session's baseline check refuses. Damage that arrives
 * by FORCED CHECKOUT is committed on the branch it came from, so the tree is
 * CLEAN against HEAD and that check sees nothing to refuse.
 *
 * RUN FOR REAL, 2026-09-18, in a throwaway clone at 1489931 with an isolated
 * AGENTBRIDGE_HOME -- the shipped hook binary, not a reconstruction:
 *
 *   session A --session-start        baseline minted, guard sha 26b7c207
 *   git checkout --force weak        guard sha 2f3c6169, TREE CLEAN, 0 entries
 *   session A protectedDrift         1 drift: src/claudeGuard.mjs   (sees it)
 *   session B --session-start        DID NOT REFUSE. Baseline minted.
 *   session B protectedDrift         0. Clean, and clean permanently after.
 *   rm src/claudeGuard.mjs           allowed by the guard B adopted
 *
 * This is the residual already named at guardSession.mjs 176-200, not a new
 * hole, and it must not be reported as one. What the real run adds is that the
 * stated mitigation -- that reviewing the commit catches it -- assumes the
 * commit was authored here and passed under someone's eyes. A forced checkout
 * imports another branch's commit wholesale. There is no review event in the
 * session that adopts it, so the mitigation and the delivery route never meet.
 *
 * The rail now refuses all three forced-checkout spellings, which closes the
 * DELIVERY half only. shellAllowlist.mjs's own header says it is a rail and not
 * a boundary: a forced checkout from a terminal, an IDE or any non-Bash path
 * still lands, and the minting below still adopts it. The fix belongs in
 * --session-start, which is why this test demands it there.
 *
 * EXPECTED RED until that lands. It asserts what the guard SHOULD do. Inverting
 * it to match current behaviour would be asserting that a vulnerability is
 * correct, which is the one move CLAUDE.md names as never acceptable.
 * ==========================================================================*/

test('DEMAND (expected red): a new session must not baseline damage that arrived by forced checkout', (t) => {
  const env = guardedRepo(t);
  const git = (...a) => execFileSync('git', a, { cwd: env.root, stdio: 'ignore' });

  /* POSITIVE CONTROL FIRST, so a refusal below cannot pass for the wrong reason. */
  assert.match(sessionStart(env, 'A').systemMessage ?? '', /initialised/, 'control: a clean tree baselines');
  assert.deepEqual(stop(env, 'A'), {}, 'control: an undamaged session is approved');

  /* The damage is COMMITTED on another branch, exactly as a real one would be. */
  const base = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: env.root, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'weak');
  writeFileSync(path.join(env.root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":true}}\n');
  git('add', '-A'); git('commit', '-qm', 'weaken the controls on this branch');
  git('checkout', '-q', base);

  /* THE DELIVERY ROUTE: a forced checkout, which is how the damage arrives
   * without ever being dirty. */
  git('checkout', '--force', 'weak');

  const settings = readFileSync(path.join(env.root, '.claude', 'settings.json'), 'utf8');
  assert.match(settings, /disableAllHooks":true/, 'precondition: the controls really are damaged now');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: env.root, encoding: 'utf8' }).trim(),
    '',
    'precondition: and the tree is CLEAN, which is the whole point -- the dirty check cannot see this',
  );

  /* Session A still catches it. The baseline it holds predates the swap. */
  assert.equal(stop(env, 'A').decision, 'block', 'the session that was already open still blocks');

  /* THE DEMAND. Measured behaviour today: mints, and Stop returns {}. */
  const fresh = sessionStart(env, 'B');
  assert.doesNotMatch(fresh.systemMessage ?? '', /initialised/,
    'a new session must not mint a baseline over controls that arrived damaged by forced checkout');

  const verdict = stop(env, 'B');
  assert.equal(verdict.decision, 'block',
    'and the new session must not be approved either -- otherwise the tree reads clean permanently');
});
