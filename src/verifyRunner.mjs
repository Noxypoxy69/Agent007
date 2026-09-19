/**
 * RUNNING THE SUITE ONCE, SHARDED, AND WRITING THE RESULT DOWN.
 *
 * ═══ WHY THIS IS A MODULE AND NOT A SCRIPT ═══
 *
 * The Stop gate needs to produce a result when none exists. The first version
 * had it SPAWN `scripts/verify-run.mjs`, and a test caught what that costs: the
 * dependency was a path string, so no static analysis could see it. Every
 * fixture that copies "the hooks and everything they import" -- three test files
 * do exactly that, by walking the import closure -- built a repo without the
 * verifier in it, and the gate failed to load a file it needed.
 *
 * An invisible dependency is the thing this repository already refuses
 * everywhere else: the guard's import closure is COMPUTED so a new import
 * cannot sneak in unprotected, and `noOrphanModules` exists because an entry
 * point and an orphan look identical from the graph. A spawn by filename is
 * outside all of it.
 *
 * So the gate imports this, the closure walker sees it, fixtures copy it, and
 * `guardDependenciesProtected` will demand it be a protected path the moment it
 * enters the guard's closure -- which is the correct outcome, because a file
 * that decides whether a turn is verified decides what the guard does.
 *
 * ═══ WHAT IT DOES NOT DECIDE ═══
 *
 * Nothing. Every judgement -- reuse, attach, start, shard planning, folding
 * shard outcomes into a verdict -- is `src/verifyCache.mjs`, pure and tested.
 * This spawns node, collects counts, and persists. That split is rule 10.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { aggregateShards, shardPlan, VERIFY, HEARTBEAT_MS } from './verifyCache.mjs';
import { verifyRecordPath } from './verifyIdentity.mjs';

/**
 * ATOMIC. Two sessions can reach the store at once, and a half-written record
 * read by the other has no `state` -- which `decideVerify` treats as
 * unrecognised and answers START, quietly making two suites again, which is the
 * one outcome this whole mechanism exists to prevent. Write beside, then rename.
 */
export function writeRecord(key, record, home) {
  const file = verifyRecordPath(key, home);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

export function readRecord(key, home) {
  try { return JSON.parse(readFileSync(verifyRecordPath(key, home), 'utf8')); } catch { return null; }
}

/** How many test files there are, so a shard plan cannot outnumber them. */
export function countTestFiles(root) {
  try {
    return readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  } catch { return 0; }
}

/**
 * THE COUNTS COME FROM THE REPORTER, NEVER FROM THE EXIT CODE.
 *
 * A non-zero exit is evidence a process was unhappy, not that a test ran --
 * rule 3 -- and a ZERO exit with no tests is what a broken glob looks like.
 * `aggregateShards` refuses that case, but only if it is given the number.
 */
function countFrom(output, label) {
  const m = output.match(new RegExp(`^#\\s*${label}\\s+(\\d+)$`, 'm'))
    ?? output.match(new RegExp(`ℹ\\s*${label}\\s+(\\d+)`));
  return m ? Number(m[1]) : 0;
}

function runShard(root, shard) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', shard.arg, 'test/**/*.test.mjs'], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({
      index: shard.index, exitCode: 1, tests: 0, fail: 0, output: `spawn failed: ${e?.message ?? e}`,
    }));
    child.on('close', (code) => resolve({
      index: shard.index,
      exitCode: code,
      tests: countFrom(out, 'tests'),
      fail: countFrom(out, 'fail'),
      output: out.slice(-6000),
    }));
  });
}

/**
 * Run exactly one verification and persist it.
 *
 * THE CALLER HAS ALREADY DECIDED IT SHOULD. This does not re-check for a run in
 * flight; `decideVerify` owns that, and duplicating the check here would be two
 * answers to one question -- the failure this repository has a header about.
 *
 * @returns {Promise<object>} the persisted record
 */
export async function runVerification({
  root, key, identity, shards = 4, concurrency = 2, home = undefined, now = () => Date.now(),
} = {}) {
  /*
   * THE SHARD COUNT IS CLAMPED TO THE FILES THAT EXIST, and the caller's number
   * is a ceiling rather than a demand.
   *
   * `shardPlan` refuses more shards than files, correctly: an empty shard exits
   * 0 having executed nothing, which is a pass proving nothing. But refusing is
   * the wrong answer to give a CALLER who simply asked for a sensible default
   * against a small tree -- and it produced a real fail-open. A fixture with one
   * test file made a four-shard plan refuse, runVerification returned PARTIAL in
   * 400ms, and the Stop gate approved the turn because PARTIAL took a branch
   * that returned no state.
   *
   * The module's refusal stays exactly as strict; choosing a number it will
   * accept is this function's job.
   */
  const files = countTestFiles(root);
  const wanted = Number.isInteger(shards) && shards > 0 ? shards : 1;
  const plan = shardPlan({ total: files > 0 ? Math.min(wanted, files) : 1, files });
  if (!plan.ok) {
    const rec = {
      key, identity, state: VERIFY.PARTIAL, why: plan.errors.join('; '), pid: process.pid,
      started_at: now(), heartbeat_at: now(), finished_at: now(), tests: 0, fail: 0,
    };
    writeRecord(key, rec, home);
    return rec;
  }

  const started = now();
  const base = {
    key,
    identity,
    state: VERIFY.RUNNING,
    pid: process.pid,
    started_at: started,
    heartbeat_at: started,
    shards: plan.shards.map((s) => ({ index: s.index, total: s.total })),
  };
  writeRecord(key, base, home);

  /*
   * THE HEARTBEAT IS WHAT MAKES "ATTACH" SAFE. Without it a crashed run leaves a
   * RUNNING record forever and every later caller waits on a process that is
   * gone -- this repository spent a night unable to tell a dead watcher from a
   * working one for exactly that reason. Beating at a third of the limit means
   * two consecutive misses are needed before anyone calls it dead.
   */
  const beat = setInterval(() => {
    try { writeRecord(key, { ...base, heartbeat_at: now() }); } catch { /* a failed beat is not fatal */ }
  }, Math.max(1000, Math.floor(HEARTBEAT_MS / 3)));
  if (typeof beat.unref === 'function') beat.unref();

  const queue = [...plan.shards];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const shard = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      results.push(await runShard(root, shard));
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, plan.shards.length)) }, worker),
    );
  } finally {
    clearInterval(beat);
  }

  const verdict = aggregateShards(results, { total: plan.shards.length });
  const final = {
    ...base,
    state: verdict.state,
    why: verdict.why,
    tests: verdict.tests,
    fail: verdict.fail,
    finished_at: now(),
    duration_ms: now() - started,
    heartbeat_at: now(),
    shards: results
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((r) => ({ index: r.index, exitCode: r.exitCode, tests: r.tests, fail: r.fail })),
    /*
     * THE FAILING OUTPUT IS KEPT, and only the failing output. A reader whose
     * gate says "5 failing" and cannot see which five runs the suite again --
     * which is the cost this whole mechanism exists to remove.
     */
    failing_output: verdict.state === VERIFY.PASSED
      ? null
      : results.filter((r) => r.exitCode !== 0).map((r) => r.output).join('\n---\n').slice(-16000),
  };
  writeRecord(key, final, home);
  return final;
}
