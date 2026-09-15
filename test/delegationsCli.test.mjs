import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHAT AN AGENT ACTUALLY CONSUMES ON STARTUP.
 *
 * delegationsForSession is unit-tested, but a pull an agent cannot trust the
 * exit code of is not a pull. The three codes have to mean different things:
 *
 *   0  here is your work  --  or, equally, you have none
 *   2  I could not find out
 *
 * The distinction between "nothing outstanding" and "the store is unreadable"
 * is the entire reliability claim. Both print to a terminal; only the exit code
 * separates them, and only this file asserts it.
 *
 * Real CLI process, temp AGENTBRIDGE_HOME so the operator's own delegations are
 * never read or touched.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const SHA = 'b364b84489a9e5cd0860e60f56ac5302634dc1bb';

const del = (over = {}) => ({
  id: 'd-x',
  assigning_session: 'lead',
  assigned_session: 'worker',
  task: 'a bounded task',
  lane_id: 'agentbridge',
  base_sha: SHA,
  allowed_paths: ['src/x.mjs', 'test/x.test.mjs'],
  forbidden_paths: ['package.json'],
  shared_paths: [],
  notes: null,
  state: 'assigned',
  head_sha: null,
  history: [],
  ...over,
});

/** A temp AGENTBRIDGE_HOME containing exactly `rows` (or raw text). */
async function withHome(t, rows) {
  const home = await mkdtemp(path.join(tmpdir(), 'ab-deleg-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, 'delegations.json'),
    typeof rows === 'string' ? rows : JSON.stringify(rows, null, 2),
    'utf8',
  );
  return { AGENTBRIDGE_HOME: home };
}

test('delegations --for: an agent WITH work sees it, exit 0', async (t) => {
  const env = await withHome(t, [
    del({ id: 'd-mine', state: 'assigned' }),
    del({ id: 'd-theirs', assigned_session: 'worker-2' }),
  ]);
  const r = await run(['delegations', '--for', 'worker'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /d-mine/);
  assert.doesNotMatch(r.stdout, /d-theirs/, 'another session\'s contract was printed');
  // The four things the contract is useless without.
  assert.match(r.stdout, /a bounded task/);
  assert.match(r.stdout, new RegExp(SHA));
  assert.match(r.stdout, /src\/x\.mjs/);
  assert.match(r.stdout, /package\.json/);
});

test('delegations --for: an agent with NO work sees nothing, and exits 0', async (t) => {
  // Absence is not an error. If this exited non-zero, every clean startup
  // would look like a failure and the check would be turned off.
  const env = await withHome(t, [
    del({ id: 'd-theirs', assigned_session: 'worker-2' }),
    del({ id: 'd-done', state: 'accepted' }),
  ]);
  const r = await run(['delegations', '--for', 'worker'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no outstanding delegations for worker/);
  assert.doesNotMatch(r.stdout, /d-theirs|d-done/);
});

test('delegations --for: an empty store is still exit 0', async (t) => {
  const env = await withHome(t, []);
  const r = await run(['delegations', '--for', 'worker'], env);
  assert.equal(r.code, 0, r.stderr);
});

test('delegations --for --all: widens state, never ownership', async (t) => {
  const env = await withHome(t, [
    del({ id: 'd-done', state: 'accepted' }),
    del({ id: 'd-theirs', assigned_session: 'worker-2', state: 'accepted' }),
  ]);
  const plain = await run(['delegations', '--for', 'worker'], env);
  assert.equal(plain.code, 0);
  assert.doesNotMatch(plain.stdout, /d-done/, 'accepted work was shown as outstanding');

  const all = await run(['delegations', '--for', 'worker', '--all'], env);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /d-done/);
  assert.doesNotMatch(all.stdout, /d-theirs/, '--all leaked another session\'s contract');
});

test('delegations --for --json: machine output is the same filtered set', async (t) => {
  const env = await withHome(t, [
    del({ id: 'd-mine' }),
    del({ id: 'd-theirs', assigned_session: 'worker-2' }),
  ]);
  const r = await run(['delegations', '--for', 'worker', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'd-mine');
  assert.equal(parsed[0].base_sha, SHA);
});

test('delegations --for with no value refuses instead of reporting "no work"', async (t) => {
  // `--for` bare parses to boolean true. Filtering on it matches nothing, so
  // the dangerous outcome is a confident "nothing outstanding" to an agent
  // that has work. It must be exit 2, not exit 0 with an empty list.
  const env = await withHome(t, [del({ id: 'd-mine' })]);
  const r = await run(['delegations', '--for'], env);
  assert.equal(r.code, 2, `expected usage refusal, got ${r.code}: ${r.stdout}`);
  assert.doesNotMatch(r.stdout, /no outstanding/);
});

test('delegations --for: an unreadable store is exit 2, not exit 0', async (t) => {
  // "I could not find out" must not be indistinguishable from "you have
  // nothing to do". This is the reliability claim of the whole command.
  const env = await withHome(t, '{ not json at all');
  const r = await run(['delegations', '--for', 'worker'], env);
  assert.equal(r.code, 2, `expected 2 for a corrupt store, got ${r.code}`);
  assert.doesNotMatch(r.stdout, /no outstanding/);
});

test('delegations --for: a store that is valid JSON but not an array is exit 2', async (t) => {
  // provenanceStore treats this as corrupt rather than empty, deliberately:
  // returning [] would discard every record on the next write.
  const env = await withHome(t, '{"delegations": []}');
  const r = await run(['delegations', '--for', 'worker'], env);
  assert.equal(r.code, 2, `expected 2 for a non-array store, got ${r.code}`);
});

test('delegations: the unfiltered listing still works', async (t) => {
  // --for is additive. The existing command keeps its behaviour.
  const env = await withHome(t, [del({ id: 'd-mine' }), del({ id: 'd-theirs', assigned_session: 'w2' })]);
  const r = await run(['delegations'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /d-mine/);
  assert.match(r.stdout, /d-theirs/);
});
