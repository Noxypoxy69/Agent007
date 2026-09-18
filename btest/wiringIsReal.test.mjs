import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';

/**
 * THE MODULES ARE CALLED. THAT IS THE WHOLE TEST.
 *
 * Three modules in this project shipped pure, correct, well-tested and invoked
 * by nothing: resolveWorker/bindDelegation, then src/supersession.mjs, then
 * src/tokenBudget.mjs. Each had a suite in front of it. None of them ran in
 * anger, because each contract forbade the shared store and CLI — so the
 * boundary that kept the work safe also guaranteed it was inert.
 *
 * A pure module's own tests can never catch this. They pass whether or not
 * anything calls it. So the check has to be behavioural and it has to go
 * through the binary.
 *
 * WHAT THIS ASSERTS THAT supersession.mjs's OWN TESTS CANNOT:
 *
 *   - `agentbridge supersede` exists and appends a correction to a real store
 *   - the CALLER runs assertAppendOnly against what WOULD be written, before
 *     writing, rather than trusting the module's promise
 *   - the caller passes a REAL git resolver, so a replacement sha that does not
 *     resolve is refused instead of recorded
 *   - `agentbridge token-budget --record` persists a measurement that survives
 *     the process
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const git = (cwd, a) => new Promise((r) =>
  execFile('git', a, { cwd, windowsHide: true, timeout: 60000 }, (e, o) => r({ ok: !e, out: String(o).trim() })));

/** A real git repo, plus a ledger holding one wrong record to correct. */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', 'repo']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'f.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;

  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const wrong = {
    id: 'd-wrong',
    assigning_session: 'lead', assigned_session: 'worker',
    task: 'work that actually shipped', lane_id: null,
    base_sha: head, allowed_paths: ['src/x.mjs'], forbidden_paths: [], shared_paths: [],
    notes: null, state: 'withdrawn', head_sha: null, audit: null,
    history: [{ state: 'assigned', at: '2026-09-15T05:00:00.000Z' },
              { state: 'withdrawn', at: '2026-09-15T06:00:00.000Z' }],
  };
  await writeFile(path.join(home, 'delegations.json'), `${JSON.stringify([wrong], null, 2)}\n`, 'utf8');

  return { root, repo, head, env: { AGENTBRIDGE_HOME: home } };
}

const ledger = async (env) =>
  JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8'));

test('supersede appends a correction and does NOT edit the mistake', async (t) => {
  const { repo, head, env } = await fixture(t);
  const before = await ledger(env);

  const r = await run(['supersede', '--id', 'c-1', '--supersedes', 'd-wrong',
    '--reason', 'withdrawn in error; the work shipped',
    '--replacement-task', 'd-right', '--replacement-head', head, '--repo', repo], env, repo);

  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /append-only verified/);

  const after = await ledger(env);
  assert.equal(after.length, before.length + 1, 'the correction did not land');
  // The mistake is untouched, byte for byte.
  assert.deepEqual(after[0], before[0], 'the wrong record was EDITED — this ledger forbids that');
  assert.equal(after[0].state, 'withdrawn', 'the mistake was quietly reopened');

  const correction = after[1];
  assert.equal(correction.supersedes, 'd-wrong');
  assert.equal(correction.replacement_task_id, 'd-right');
  assert.match(correction.reason, /withdrawn in error/);
});

test('the CALLER passes a real git resolver — a bogus sha is refused', async (t) => {
  // The module refuses a supplied sha when no resolver is given, so a caller
  // could "satisfy" it by passing none. That would make every replacement sha
  // unverifiable. This proves a real resolver is wired: a 40-char hex string
  // that never named an object must not be recorded.
  const { repo, env } = await fixture(t);
  const fabricated = 'e38ebd9d0e7a4cf7cc0e3c46c43e7ac8be9d9b0e';

  const r = await run(['supersede', '--id', 'c-bad', '--supersedes', 'd-wrong',
    '--reason', 'r', '--replacement-task', 'd-right',
    '--replacement-head', fabricated, '--repo', repo], env, repo);

  assert.equal(r.code, 2, `a fabricated sha was accepted: ${r.stdout}`);
  assert.equal((await ledger(env)).length, 1, 'a refused correction still wrote to disk');
});

test('a correction naming a target that does not exist is refused', async (t) => {
  const { repo, env } = await fixture(t);
  const r = await run(['supersede', '--id', 'c-x', '--supersedes', 'does-not-exist',
    '--reason', 'r', '--replacement-task', 'd-right', '--repo', repo], env, repo);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown supersedes target/);
  assert.equal((await ledger(env)).length, 1);
});

test('a rejected correction never half-lands', async (t) => {
  // applySupersession returns new rows and never touches disk, so a refusal
  // must leave the file byte-identical. Proving the CALLER preserved that.
  const { repo, env } = await fixture(t);
  const raw = await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8');

  await run(['supersede', '--id', 'c-y', '--supersedes', 'nope',
    '--reason', 'r', '--replacement-task', 't', '--repo', repo], env, repo);

  assert.equal(await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8'), raw);
});

test('token-budget --record PERSISTS a measurement across processes', async (t) => {
  // tokenBudget measured into nothing for exactly as long as nothing called it.
  const { repo, root, env } = await fixture(t);
  const handoff = path.join(root, 'handoff.txt');
  await writeFile(handoff, [
    'Integrated the guard and proved it fails.',
    '',
    '```',
    'RED   remove the check',
    'GREEN restored',
    '```',
  ].join('\n'), 'utf8');

  const rec = await run(['token-budget', '--record', '--handoff', handoff,
    '--task', 'd-token-budget', '--tier', 'complete', '--mutation-evidence'], env, repo);
  assert.equal(rec.code, 0, `${rec.stdout}${rec.stderr}`);

  // A separate process must see it, or it was never persisted.
  const shown = await run(['token-budget', '--json'], env, repo);
  assert.equal(shown.code, 0);
  const rows = JSON.parse(shown.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, 'd-token-budget');
  assert.ok(rows[0].metrics, 'a measurement was stored with no metrics');
  assert.ok(Number.isFinite(rows[0].total_tokens ?? rows[0].tokens ?? NaN)
    || Object.keys(rows[0].metrics).length > 0, 'the stored row carries no numbers');
});

test('measurements append rather than replace', async (t) => {
  const { repo, root, env } = await fixture(t);
  const handoff = path.join(root, 'h.txt');
  await writeFile(handoff, 'a short handoff', 'utf8');

  await run(['token-budget', '--record', '--handoff', handoff, '--task', 'one'], env, repo);
  await run(['token-budget', '--record', '--handoff', handoff, '--task', 'two'], env, repo);

  const rows = JSON.parse((await run(['token-budget', '--json'], env, repo)).stdout);
  assert.deepEqual(rows.map((r) => r.task_id), ['one', 'two'],
    'a measurement overwrote an earlier one — these are observations, not state');
});

test('the caller PROVES it appended — before writing and after', async () => {
  /*
   * A STRUCTURAL CHECK, AND HONESTLY LABELLED AS ONE.
   *
   * assertAppendOnly is defence in depth: while applySupersession is correct it
   * cannot fire, so removing it from the caller changes nothing observable and
   * two behavioural mutations came back GREEN against an earlier draft of this
   * file. That is the "guard nobody proved can fail" pattern, arrived at from a
   * new direction — the guard is right, the module it guards is right, and so
   * the guard is untestable by behaviour alone.
   *
   * The choice is to delete it or to check it structurally. Deleting it is
   * wrong: it is the one assertion that would catch a future change to
   * applySupersession, and c8 exported it precisely so the caller could make
   * the claim rather than reviewers taking it on trust. So it is checked here,
   * and this test says plainly what kind of check it is.
   *
   * The post-write call IS behaviourally meaningful — it re-reads the file and
   * would catch a concurrent writer — but it too cannot be provoked from a test
   * without a second process racing this one.
   */
  const src = await readFile(CLI, 'utf8');
  const block = src.slice(src.indexOf("cmd === 'supersede'"), src.indexOf("cmd === 'token-budget'"));
  assert.ok(block.length > 500, 'could not locate the supersede block — this check has gone blind');

  const calls = [...block.matchAll(/assertAppendOnly\(/g)];
  assert.equal(calls.length, 2,
    'the supersede wiring must assert append-only TWICE: once on the rows it is about '
    + 'to write, and once on what actually landed on disk. Found ' + calls.length + '.');

  // And it must refuse rather than warn-and-continue on the pre-write check.
  assert.match(block, /REFUSED[\s\S]{0,400}?process\.exit\(2\)/,
    'a failed pre-write append-only proof must stop the write, not warn past it');
});

test('token-budget produces no message text a model could be fed', async (t) => {
  // It reports numbers. If it ever emitted rewritten prose, an agent could be
  // handed its own compressed handoff back as instructions.
  const { repo, root, env } = await fixture(t);
  const handoff = path.join(root, 'h2.txt');
  const secret = 'PLEASE-REWRITE-ME-INTO-SOMETHING-SHORTER';
  await writeFile(handoff, secret, 'utf8');

  await run(['token-budget', '--record', '--handoff', handoff, '--task', 't'], env, repo);
  const out = (await run(['token-budget', '--json'], env, repo)).stdout;
  assert.ok(!out.includes(secret), 'the handoff text was stored back — this must report only numbers');
});
