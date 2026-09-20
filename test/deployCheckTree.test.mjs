import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * THE GATE MUST ANSWER "IS THIS EVEN THE RIGHT TREE", AND IT COULD NOT.
 *
 * On 2026-09-16 at 19:37 the mcp function went from version 22 to 23,
 * byte-identical, reporting clean success, because the checkout did not carry
 * the branch. Every check in front of it passed: HEAD was an ancestor of the
 * release ref, and live matched the record. Neither question is "do the bytes
 * about to ship differ from the bytes already serving", which is the only one
 * that catches it.
 *
 * scripts/check-edge-deploy.mjs could answer it and was invoked by nothing but
 * its own test -- a gate nobody runs is a gate that does not exist. It is now
 * reachable from the deploy gate people actually run, and these are the three
 * behaviours that wiring has to have.
 */

const BIN = fileURLToPath(new URL('../bin/agentbridge-deploy-check.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Run the gate; it exits non-zero on refusal, so capture rather than throw. */
function runGate(args) {
  try {
    return { out: execFileSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8' }), code: 0 };
  } catch (err) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

async function liveDirWith(t, index, shared) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.ts'), index);
  await writeFile(path.join(dir, '_shared.js'), shared);
  return dir;
}

test('OMITTING THE TREE COMPARISON IS SAID OUT LOUD, NOT PASSED OVER', () => {
  const { out } = runGate(['--ref', 'origin/master']);
  assert.match(out, /tree\s+NOT COMPARED/, 'a skipped tree check was not reported at all');
  assert.match(out, /WRONG TREE/, 'the reason the check exists is not stated');
});

/** Refusal reasons from a --json run, so an assertion can name the one it means. */
function reasonsFrom(args) {
  const { out, code } = runGate([...args, '--json']);
  // runGate concatenates stderr AFTER stdout on a refusal, and the --live-dir
  // failure writes its explanation there, so slicing to the end of the string
  // swallows a trailing non-JSON line.
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  assert.ok(start !== -1 && end > start, `no JSON object in output:\n${out}`);
  const j = JSON.parse(out.slice(start, end + 1));
  return { reasons: (j.refusals ?? []).map((r) => r.reason).sort(), ok: j.ok, code };
}

test('THE 19:37 FAILURE: AN IDENTICAL TREE IS REFUSED, NOT DEPLOYED', async (t) => {
  /*
   * The regression itself. The live artifact and the tree are the same bytes,
   * so a deploy would bump the version and change nothing -- and every other
   * check in the gate is perfectly happy about it.
   *
   * THIS TEST USED TO PASS FOR THE WRONG REASON AND THAT IS WHY IT IS WRITTEN
   * THIS WAY NOW. It asserted only `code !== 0`, and ran WITHOUT --live and
   * --record -- so the gate was already refusing on live-drift-unchecked, and
   * that is what produced the non-zero code. Meanwhile the tree refusal set
   * process.exitCode = 1 and the final line called process.exit(verdict.ok ? 0
   * : 1), which DISCARDS process.exitCode. Supply the drift inputs so that
   * refusal goes away, and an identical tree printed REFUSED and exited 0.
   * Measured on 2026-09-17.
   *
   * So the assertion is a DIFFERENCE, not an absolute: the only thing that may
   * change between an identical tree and a differing one is this refusal. That
   * holds whatever else the gate happens to be unhappy about -- a dirty tree, a
   * missing drift reading -- and it cannot be satisfied by an unrelated
   * refusal, which is the whole failure being guarded against.
   */
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');
  const shd = readFileSync(path.join(REPO, 'supabase/functions/mcp/_shared.js'), 'utf8');

  const same = await liveDirWith(t, idx, shd);
  const differs = await liveDirWith(t, `${idx}\n// a line live does not have\n`, shd);

  const identical = reasonsFrom(['--ref', 'origin/master', '--live-dir', same]);
  const different = reasonsFrom(['--ref', 'origin/master', '--live-dir', differs]);

  assert.ok(
    identical.reasons.includes('nothing-would-change'),
    `an identical tree was not refused; reasons were ${identical.reasons.join(', ') || '(none)'}`,
  );
  assert.ok(
    !different.reasons.includes('nothing-would-change'),
    'a tree that DOES differ was still refused as nothing-would-change',
  );
  /*
   * `dirty-tree` IS DROPPED FROM BOTH SIDES, AND NOT BECAUSE IT IS
   * INCONVENIENT.
   *
   * The comment above says this difference holds "whatever else the gate
   * happens to be unhappy about -- a dirty tree". It only cancels out if it
   * is the SAME on both sides, and it is not: the two invocations each read
   * the LIVE SHARED WORKTREE, at different moments, on a machine where
   * several sessions commit and edit continuously. One session staging a file
   * between the two runs produces exactly
   *
   *   actual   [ 'dirty-tree', 'head-not-promoted', 'live-drift-unchecked' ]
   *   expected [ 'head-not-promoted', 'live-drift-unchecked' ]
   *
   * which is what an auditor measured here. It fails in the direction that
   * looks like the DEPLOY GATE is wrong, which is the expensive kind of
   * false red -- rule 21, a test encoding an accident of the tree it happens
   * to be standing in.
   *
   * Dropping it is safe because it is not what this test is about: the
   * property being asserted is that the ONLY difference between an identical
   * tree and a differing one is the tree comparison itself. A reason that is
   * a function of wall-clock worktree state cannot participate in that.
   */
  const stable = (rs) => rs.filter((r) => r !== 'nothing-would-change' && r !== 'dirty-tree');
  assert.deepEqual(
    stable(identical.reasons),
    stable(different.reasons),
    'the two runs differ by something other than the tree comparison, so this proves nothing',
  );
  assert.equal(identical.ok, false, 'the gate reported ok:true while refusing');
  assert.notEqual(identical.code, 0, 'the gate exited 0 on a deploy that would change nothing');

  const { out } = runGate(['--ref', 'origin/master', '--live-dir', same]);
  assert.match(out, /tree\s+\+0 -0/, 'an identical tree was not reported as identical');
});

test('A --live-dir THAT CANNOT BE READ IS A REFUSAL, NOT A SHRUG', async (t) => {
  /*
   * The check was ASKED FOR and could not run. Until 2026-09-17 that logged one
   * line to stderr, left treeCompared false -- the same state as never passing
   * the flag -- and printed DEPLOYABLE at exit 0. "I could not check" rendered
   * identically to "I checked and it was fine", which is the defect this
   * project has found more times than any other, here in the newest check in
   * the gate.
   *
   * Differenced against a run that omits the flag entirely, so the assertion
   * cannot be satisfied by whatever else the gate is refusing on.
   */
  const missing = path.join(tmpdir(), `gate-live-absent-${process.pid}-${Date.now()}`);
  t.after(() => rm(missing, { recursive: true, force: true }));

  const asked = reasonsFrom(['--ref', 'origin/master', '--live-dir', missing]);
  const never = reasonsFrom(['--ref', 'origin/master']);

  assert.ok(
    asked.reasons.includes('live-dir-unreadable'),
    `a failed tree comparison was not refused; reasons were ${asked.reasons.join(', ') || '(none)'}`,
  );
  assert.ok(
    !never.reasons.includes('live-dir-unreadable'),
    'not asking for the comparison was treated as asking and failing',
  );
  assert.deepEqual(
    asked.reasons.filter((r) => r !== 'live-dir-unreadable'),
    never.reasons,
    'the two runs differ by something other than the unreadable --live-dir',
  );
  assert.notEqual(asked.code, 0, 'the gate exited 0 after a tree comparison it could not perform');
});

test('A REAL DIFFERENCE IS COUNTED, AND COUNTED THE RIGHT WAY ROUND', async (t) => {
  /*
   * The direction is not cosmetic and I got it backwards first: the gate
   * reported +9 -358 for a tree that was a strict SUPERSET of what was live.
   * A reviewer reading that would conclude the deploy was reverting hundreds of
   * lines and refuse a correct release.
   */
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');
  const shd = readFileSync(path.join(REPO, 'supabase/functions/mcp/_shared.js'), 'utf8');

  // live is MISSING three lines the tree has => additions, no removals
  const trimmed = idx.split('\n').slice(0, -4).join('\n');
  const dir = await liveDirWith(t, trimmed, shd);

  const { out } = runGate(['--ref', 'origin/master', '--live-dir', dir]);
  const m = /tree\s+\+(\d+) -(\d+)/.exec(out);
  assert.ok(m, `no tree line in output:\n${out}`);
  assert.ok(Number(m[1]) > 0, 'lines only the tree has were not counted as ADDED');
  assert.equal(Number(m[2]), 0, 'lines were reported REMOVED when the tree only added');
});

test('CRLF IN THE DEPLOYED BUNDLE IS NOT A DIFFERENCE', async (t) => {
  /*
   * The deployed bundle is CRLF and the repo is LF. An unnormalised comparison
   * reports all 1813 lines of index.ts as changed and means nothing, which is
   * the documented trap.
   */
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');
  const shd = readFileSync(path.join(REPO, 'supabase/functions/mcp/_shared.js'), 'utf8');
  const dir = await liveDirWith(t, idx.replace(/\n/g, '\r\n'), shd.replace(/\n/g, '\r\n'));

  const { out } = runGate(['--ref', 'origin/master', '--live-dir', dir]);
  assert.match(out, /tree\s+\+0 -0/, 'line endings alone were reported as a difference');
});

test('A STALE CONTROL-PLANE READING IS REFUSED, BECAUSE IT AGREES WITH ITSELF', async (t) => {
  /*
   * Twice in one night the drift check passed against a reading that no longer
   * described production. code-c fed it a live.json written 63 minutes earlier
   * and it printed "live drift none" at the exact moment there WAS an
   * unrecorded hand-deploy -- the thing it exists to catch. code-d gated on a
   * reading taken before an upload, somebody landed a version in the six
   * minutes between, and the result re-shipped identical bytes as a new
   * version.
   *
   * The gate holds no credential and cannot re-read the control plane. What it
   * can check is the age of the reading it was handed, which is the property
   * both failures had.
   */
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-age-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reading = path.join(dir, 'live.json');
  await writeFile(reading, JSON.stringify({ version: 1, artifactHash: 'x'.repeat(64) }));

  const fresh = runGate(['--ref', 'origin/master', '--live', reading, '--record', 'deploy/last-deployment.json']);
  assert.doesNotMatch(fresh.out, /stale-live-reading/, 'a reading written seconds ago was called stale');

  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(reading, old, old);

  const stale = runGate(['--ref', 'origin/master', '--live', reading, '--record', 'deploy/last-deployment.json']);
  assert.match(stale.out, /stale-live-reading/, 'a ten-minute-old reading was accepted');
  assert.notEqual(stale.code, 0, 'the gate exited 0 on a stale reading');
  assert.match(
    stale.out,
    /does not close it/i,
    'the refusal must say freshness bounds the window rather than closing it, or it overclaims',
  );
});
