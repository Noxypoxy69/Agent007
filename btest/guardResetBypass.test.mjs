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
import { parseImports, resolveSpecifier } from '../src/moduleGraph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway repository carrying the guard's own shipped files. */
function guardedRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'reset-bypass-'));
  const home = mkdtempSync(path.join(tmpdir(), 'reset-home-'));
  t.after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });
  for (const d of ['src', 'test', 'scripts', 'bin', '.claude']) mkdirSync(path.join(root, d), { recursive: true });
  /*
   * THE FILE LIST IS DERIVED, BECAUSE THE TYPED ONE KEPT GOING STALE.
   *
   * It used to be six literal paths, with a note explaining that safeGit.mjs had
   * been added after guardSession started importing it. That note was the
   * warning: the list tracks the guard's imports by hand, so it is wrong from
   * the moment anybody adds one. Measured 2026-09-18 -- the Action Authority
   * wiring added src/actionAuthority.mjs to claudeGuard and all four tests in
   * this file broke at once with
   *
   *   agentbridge guard: NOT INITIALISED -- the guard could not be loaded
   *   (ERR_MODULE_NOT_FOUND). No snapshot was written
   *
   * which is the positive control doing its job, and a list doing the opposite.
   *
   * So the fixture now asks the module graph what the guard actually needs.
   * Same move as asking git what a pathspec covers: the importer owns the
   * answer, and deriving it means the NEXT import needs no edit here.
   * CLAUDE.md rule 19 -- a list of names fails in both directions.
   */
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
        if (!target) continue; // node: builtin or npm package
        const t = target.split(path.sep).join('/');
        if (!seen.has(t)) queue.push(t);
      }
    }
    return [...seen];
  };
  const needed = closureOf(['bin/agentbridge-claude-guard.mjs', 'scripts/claude-stop-gate.mjs']);
  assert.ok(needed.length >= 6,
    `the guard closure resolved to ${needed.length} files, too few to be real -- `
    + 'import parsing has stopped working, and a fixture built from nothing would make '
    + 'every refusal below pass for the wrong reason');
  for (const f of needed) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
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

/*
 * APPROVED MEANS "NOT BLOCKED". IT DID NOT USED TO, AND THAT CONFLATION BROKE
 * THESE TESTS FOR A REASON THAT HAD NOTHING TO DO WITH BASELINING.
 *
 * The control assertions were `deepEqual(stop(...), {})`, which asserts approved
 * AND SILENT in one breath. The fixture then started copying src/auditLedger.mjs
 * -- it is in the guard's import closure, and the file list is now derived
 * rather than typed -- so the print-only audit-coverage reporter began running
 * here and correctly observed that the fixture's single "base" commit touches
 * control files with no audit recorded. An advisory message appeared, the
 * session was still approved, and three tests failed anyway.
 *
 * These tests are about whether a damaged tree can be baselined. Asserting the
 * whole return object makes every future advisory a failure in a file that does
 * not care about advisories -- CLAUDE.md rule 4, do not assert on a proxy: the
 * property is the DECISION, and `{}` was standing in for it.
 *
 * It stays strict in the directions that matter: a block fails, an unexpected
 * field fails, and any systemMessage other than the known print-only reporter
 * fails. Loosening it to "ignore everything" would be the other error.
 */
const assertApproved = (result, label) => {
  assert.equal(result.decision, undefined,
    `${label}: must not be blocked${result.reason ? ` -- ${result.reason}` : ''}`);
  const unexpected = Object.keys(result).filter((k) => k !== 'systemMessage');
  assert.deepEqual(unexpected, [], `${label}: unexpected field(s) in an approval: ${unexpected.join(', ')}`);
  if (result.systemMessage !== undefined) {
    assert.match(result.systemMessage, /\[agentbridge:audit-missing\]/,
      `${label}: the only advisory expected on an approved turn is the print-only audit reporter`);
  }
};

test('a NEW session cannot baseline a tree whose protected controls were already damaged', (t) => {
  const env = guardedRepo(t);

  /* THE POSITIVE FIRST: on a clean tree this all works, or the refusal below
   * proves only that the guard refuses everything. */
  assert.match(sessionStart(env, 'A').systemMessage ?? '', /initialised/, 'control: a clean tree baselines');
  assertApproved(stop(env, 'A'), 'control: an undamaged session is approved');

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
  assertApproved(stop(env, 'C'), 'and the session proceeds normally');
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

test('RATCHET: a new session DOES baseline damage that arrived by forced checkout', (t) => {
  /*
   * THIS TEST PASSES BECAUSE THE HOLE IS OPEN. It is not an endorsement.
   *
   * It was first written as a DEMAND asserting the refusal, and that was wrong
   * for a reason worth keeping: the Stop gate refuses on counts.fail !== 0
   * (claude-stop-gate.mjs:324), so a test designed never to pass blocks every
   * session on this branch, permanently. Rule 16 -- a red gate nobody has shown
   * can go green is a countdown, not a ratchet -- and an independent audit found
   * no green path at all: the obvious implementation refuses a baseline whenever
   * protected files differ from the newest prior snapshot, which fires on every
   * legitimate committed change to a protected path. This branch contains three.
   *
   * So it pins the MEASURED behaviour instead, and fails in the useful
   * direction: when somebody fixes minting, this goes red and tells them they
   * succeeded. At that point delete this test and close the residual.
   */
  const env = guardedRepo(t);
  const git = (...a) => execFileSync('git', a, { cwd: env.root, stdio: 'ignore' });

  assert.match(sessionStart(env, 'A').systemMessage ?? '', /initialised/, 'control: a clean tree baselines');
  assertApproved(stop(env, 'A'), 'control: an undamaged session is approved');

  const base = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: env.root, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'weak');
  damage(env);
  git('add', '-A'); git('commit', '-qm', 'weaken the controls on this branch');
  git('checkout', '-q', base);
  git('checkout', '--force', 'weak');

  assert.match(readFileSync(path.join(env.root, '.claude', 'settings.json'), 'utf8'),
    /disableAllHooks":true/, 'precondition: the controls really are damaged');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: env.root, encoding: 'utf8' }).trim(), '',
    'precondition: and the tree is CLEAN -- the dirty check a24d499 added cannot see this',
  );
  assert.equal(stop(env, 'A').decision, 'block', 'the session already open still blocks');

  /* THE RESIDUAL, PINNED. Both assertions describe a hole, not a requirement. */
  assert.match(sessionStart(env, 'B').systemMessage ?? '', /initialised/,
    'RATCHET: a new session still mints over forced-checkout damage. If this line fails, '
    + 'minting now refuses -- the residual is CLOSED and this test should be deleted.');
  /*
   * THE RESIDUAL IS STILL OPEN, BUT IT IS NARROWER THAN IT WAS, AND THE
   * DIFFERENCE IS WORTH WRITING DOWN RATHER THAN ASSERTING AWAY.
   *
   * This asserted `deepEqual(stop(...), {})` -- approved AND silent. It now
   * reports an advisory, because the fixture derives its file list and therefore
   * carries src/auditLedger.mjs, and the print-only audit reporter NAMES the
   * damaging commit:
   *
   *   [agentbridge:audit-missing] 2 commit(s) changed a control with no audit
   *     59f7a130  weaken the controls on this branch
   *               .claude/settings.json
   *
   * So the imported damage is no longer entirely invisible at Stop -- it is
   * visible and UNENFORCED. That is not the residual closing: the gate still
   * approves the turn, which is exactly the hole this test pins. Blocking is
   * what would close it.
   *
   * Asserting on the DECISION says that precisely. The old form would have gone
   * red for a change that made the hole more visible, which teaches the next
   * reader to delete a test that is still describing a real gap.
   */
  assertApproved(stop(env, 'B'),
    'RATCHET: and that session still reads clean. If the DECISION here ever becomes block, the '
    + 'Stop gate now catches imported damage -- the residual is CLOSED and this test should be deleted.');
});
