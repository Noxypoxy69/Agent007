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

test('THE 19:37 FAILURE: AN IDENTICAL TREE IS REFUSED, NOT DEPLOYED', async (t) => {
  /*
   * The regression itself. The live artifact and the tree are the same bytes,
   * so a deploy would bump the version and change nothing -- and every other
   * check in the gate is perfectly happy about it.
   */
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');
  const shd = readFileSync(path.join(REPO, 'supabase/functions/mcp/_shared.js'), 'utf8');
  const dir = await liveDirWith(t, idx, shd);

  const { out, code } = runGate(['--ref', 'origin/master', '--live-dir', dir]);
  assert.match(out, /tree\s+\+0 -0/, 'an identical tree was not reported as identical');
  assert.match(out, /nothing-would-change/, 'shipping nothing was not refused');
  assert.notEqual(code, 0, 'the gate exited 0 on a deploy that would change nothing');
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
