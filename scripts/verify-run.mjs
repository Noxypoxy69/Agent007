#!/usr/bin/env node
/**
 * THE VERIFIER. ONE SUITE PER IDENTITY, SHARDED, PERSISTED.
 *
 * The Stop gate has been spawning `npm test` at every turn end. A session that
 * also runs the suite makes that two copies on one machine: a solo run here is
 * ~185s, a pair is ~400-430s, and the budget is 420s. The gate then killed its
 * own suite and reported NOTHING WAS VERIFIED -- five times in one session, and
 * again once a SECOND AGENT started running suites, which is the same collision
 * with a different second party.
 *
 * So the gate stops running tests and starts consuming a result. This produces
 * the result.
 *
 *   1. a completed result for this exact identity  -> print it, exit its verdict
 *   2. one already running for this identity       -> ATTACH: poll, never spawn
 *   3. otherwise                                    -> run exactly one, sharded
 *
 * Every decision above is `src/verifyCache.mjs`, pure and tested. This file is
 * I/O: it measures the identity, spawns, heartbeats and writes. That split is
 * rule 10, and it is the only reason the interesting cases -- a stale heartbeat,
 * a missing shard, a green run that executed nothing -- are testable at all.
 *
 * USAGE
 *   node scripts/verify-run.mjs [--shards <n>] [--concurrency <n>] [--json]
 *   node scripts/verify-run.mjs --status      read the result, run nothing
 *
 * EXIT
 *   0  VERIFY_PASSED for this exact tree
 *   1  VERIFY_FAILED
 *   2  could not run, or could not tell -- NEVER conflated with 1, because a
 *      caller that cannot distinguish a refusal from a crash will retry the one
 *      it should escalate
 *   3  VERIFY_RUNNING elsewhere; this process started nothing
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  verifyKey, decideVerify, aggregateShards, shardPlan,
  VERIFY, ACTION, HEARTBEAT_MS, DEAD_AFTER_MS,
} from '../src/verifyCache.mjs';
import { runGit } from '../src/safeGit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');
const statusOnly = argv.includes('--status');

const home = process.env.AGENTBRIDGE_HOME || path.join(os.homedir(), '.agentbridge');
const storeDir = path.join(home, 'verify');

/* ── measuring the identity ───────────────────────────────────────────── */

const COMMAND = 'node --test test/**/*.test.mjs';

/**
 * THE WORKING TREE, NOT HEAD.
 *
 * An uncommitted edit changes what the suite executes, and `npm test`'s glob is
 * expanded by node rather than by git -- so an UNTRACKED test file runs. Keying
 * on a commit would reuse a PASS across an edit, which is the defect a blind
 * audit demonstrated live against audit-pin: it certified a commit while an
 * auditor read a working tree.
 *
 * Content, not just names: `git status` alone says a file changed, not what it
 * now contains, so two different edits to one file would share a key.
 */
function treeDigest() {
  try {
    const head = String(runGit(['-C', root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' })).trim();
    const status = String(runGit(['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }));
    const dirty = status.split('\n').map((s) => s.trim()).filter(Boolean).sort();

    const h = createHash('sha256').update(head);
    const NUL = String.fromCharCode(0);
    for (const line of dirty) {
      const rel = line.slice(line.indexOf(' ') + 1).trim().replace(/^"|"$/g, '');
      let body = '';
      try { body = readFileSync(path.join(root, rel), 'utf8'); } catch { body = '(unreadable)'; }
      h.update(`${NUL}${rel}${NUL}${body.length}${NUL}${createHash('sha256').update(body).digest('hex')}`);
    }
    return h.digest('hex');
  } catch {
    return null;   // no digest means no key means run it
  }
}

/**
 * The environment the suite reads. AGENTBRIDGE_HOME alone decides whether a test
 * sees the operator's real grants, which is the difference between a result
 * about this repository and a result about this machine's live state.
 */
function envDigest() {
  const READS = ['AGENTBRIDGE_HOME', 'AGENTBRIDGE_AGENT_ID', 'CLAUDE_PROJECT_DIR', 'CI', 'NODE_OPTIONS'];
  const NUL = String.fromCharCode(0);
  return createHash('sha256')
    .update(READS.map((k) => `${k}=${process.env[k] ?? ''}`).join(NUL))
    .digest('hex')
    .slice(0, 16);
}

const toolchain = `${process.version}-${process.platform}-${process.arch}`;

/* ── the store ────────────────────────────────────────────────────────── */

const fileFor = (key) => path.join(storeDir, `${key}.json`);

function readRecord(key) {
  try { return JSON.parse(readFileSync(fileFor(key), 'utf8')); } catch { return null; }
}

/**
 * ATOMIC. Two sessions can reach this at once, and a half-written record read by
 * the other is a record whose state field may be absent -- which decideVerify
 * would treat as unrecognised and answer START, quietly making two suites again.
 * Write beside, then rename.
 */
function writeRecord(key, record) {
  mkdirSync(storeDir, { recursive: true });
  const tmp = `${fileFor(key)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, fileFor(key));
}

/* ── reporting ────────────────────────────────────────────────────────── */

function report(record, extra = {}) {
  if (asJson) {
    console.log(JSON.stringify({ ...record, ...extra }, null, 2));
    return;
  }
  console.log(`state     ${record.state}`);
  console.log(`key       ${record.key}`);
  console.log(`why       ${record.why ?? ''}`);
  if (record.tests != null) console.log(`tests     ${record.tests} (fail ${record.fail ?? 0})`);
  if (record.shards) console.log(`shards    ${record.shards.length}`);
  if (record.duration_ms != null) console.log(`duration  ${Math.round(record.duration_ms / 1000)}s`);
  for (const [k, v] of Object.entries(extra)) console.log(`${k.padEnd(9)} ${v}`);
}

const EXIT = {
  [VERIFY.PASSED]: 0,
  [VERIFY.FAILED]: 1,
  [VERIFY.PARTIAL]: 2,
  [VERIFY.TIMED_OUT]: 2,
  [VERIFY.RUNNING]: 3,
};

/* ── main ─────────────────────────────────────────────────────────────── */

const identity = {
  tree_digest: treeDigest(),
  command: COMMAND,
  toolchain,
  env_digest: envDigest(),
};

const k = verifyKey(identity);
if (!k.ok) {
  console.error('verify-run: cannot form an identity for this tree, so no result could be trusted');
  for (const e of k.errors) console.error(`  ${e}`);
  process.exit(2);
}
const key = k.key;

const existing = readRecord(key);
const decision = decideVerify(existing, { now: Date.now(), key });

if (decision.action === ACTION.REUSE) {
  report(existing, { source: 'cached for this exact tree' });
  process.exit(EXIT[existing.state] ?? 2);
}

if (decision.action === ACTION.ATTACH) {
  if (statusOnly) {
    report({ ...existing, why: decision.why });
    process.exit(3);
  }
  /*
   * POLL, DO NOT SPAWN. This is the entire point of the exercise: the second
   * caller waits for the first rather than doubling the load that made both
   * of them slow. It gives up on the heartbeat going stale, never on a clock,
   * because a slow suite and a dead one are different and only the heartbeat
   * can tell them apart.
   */
  console.error(`verify-run: ${decision.why}`);
  const deadline = Date.now() + 30 * 60_000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 5_000); });
    const now = readRecord(key);
    const d = decideVerify(now, { now: Date.now(), key });
    if (d.action === ACTION.REUSE) { report(now, { source: 'waited for the run already in flight' }); process.exit(EXIT[now.state] ?? 2); }
    if (d.action === ACTION.START) {
      console.error(`verify-run: the run we attached to ${d.why}`);
      process.exit(2);
    }
  }
  console.error('verify-run: gave up waiting; the other run is still beating but has not finished');
  process.exit(3);
}

if (statusOnly) {
  console.log(`state     (none)`);
  console.log(`key       ${key}`);
  console.log('why       no verification exists for this tree');
  process.exit(2);
}

/* ── START: exactly one run, sharded ──────────────────────────────────── */

const testFiles = (() => {
  try {
    return readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  } catch { return 0; }
})();

const shardCount = Number(flag('--shards', '4'));
const plan = shardPlan({ total: shardCount, files: testFiles });
if (!plan.ok) {
  console.error('verify-run: refusing this shard plan');
  for (const e of plan.errors) console.error(`  ${e}`);
  process.exit(2);
}

const started = Date.now();
let beat = null;
const base = {
  key,
  identity,
  state: VERIFY.RUNNING,
  pid: process.pid,
  started_at: started,
  heartbeat_at: started,
  shards: plan.shards.map((s) => ({ index: s.index, total: s.total })),
};
writeRecord(key, base);
beat = setInterval(() => {
  writeRecord(key, { ...base, heartbeat_at: Date.now() });
}, HEARTBEAT_MS / 3);

const runShard = (shard) => new Promise((resolve) => {
  const child = spawn(process.execPath,
    ['--test', shard.arg, 'test/**/*.test.mjs'],
    { cwd: root, encoding: 'utf8' });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    /*
     * THE COUNTS COME FROM THE REPORTER, NOT FROM THE EXIT CODE. A non-zero exit
     * is evidence a process was unhappy, not that a test ran -- rule 3 -- and a
     * zero exit with no tests is what a broken glob looks like. aggregateShards
     * refuses that case, but only if it is given the number.
     */
    const num = (label) => {
      const m = out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
        ?? out.match(new RegExp(`ℹ ${label} (\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    resolve({
      index: shard.index, exitCode: code, tests: num('tests'), fail: num('fail'), output: out.slice(-4000),
    });
  });
});

const concurrency = Math.max(1, Number(flag('--concurrency', '2')));
const queue = [...plan.shards];
const results = [];
async function worker() {
  while (queue.length) {
    const shard = queue.shift();
    results.push(await runShard(shard));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, plan.shards.length) }, worker));

clearInterval(beat);

const verdict = aggregateShards(results, { total: plan.shards.length });
const final = {
  ...base,
  state: verdict.state,
  why: verdict.why,
  tests: verdict.tests,
  fail: verdict.fail,
  finished_at: Date.now(),
  duration_ms: Date.now() - started,
  heartbeat_at: Date.now(),
  shards: results.map((r) => ({
    index: r.index, exitCode: r.exitCode, tests: r.tests, fail: r.fail,
  })),
  failing_output: verdict.state === VERIFY.PASSED
    ? null
    : results.filter((r) => r.exitCode !== 0).map((r) => r.output).join('\n---\n').slice(-12000),
};
writeRecord(key, final);

report(final, { source: 'ran now' });
process.exit(EXIT[final.state] ?? 2);
