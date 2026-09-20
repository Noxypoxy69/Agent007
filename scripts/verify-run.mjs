#!/usr/bin/env node
/**
 * THE VERIFIER, AS A COMMAND. ONE SUITE PER IDENTITY, SHARDED, PERSISTED.
 *
 * The Stop gate used to spawn `npm test` at every turn end. A session that also
 * ran the suite made that two copies on one machine; a second AGENT made it
 * three. Measured here: a solo run is ~185s, a pair is ~400-430s, and the
 * budget is 420s -- so the gate killed its own suite and reported NOTHING WAS
 * VERIFIED six times in one session, every time over a duplicate of work
 * already in flight.
 *
 *   1. a completed result for this exact identity  -> print it, exit its verdict
 *   2. one already running for this identity       -> ATTACH: poll, never spawn
 *   3. otherwise                                    -> run exactly one, sharded
 *
 * ALL THE JUDGEMENT IS ELSEWHERE. `src/verifyCache.mjs` decides (pure, tested),
 * `src/verifyIdentity.mjs` measures the key that the Stop gate looks results up
 * by -- one derivation, imported by both, because two would drift and the gate
 * would silently start another run -- and `src/verifyRunner.mjs` does the
 * running. This file is argv and printing.
 *
 * USAGE
 *   npm run verify
 *   npm run verify -- --status            read the result, run nothing
 *   npm run verify -- --shards 4 --concurrency 2 [--json]
 *
 * EXIT
 *   0  VERIFY_PASSED for this exact tree
 *   1  VERIFY_FAILED
 *   2  could not run, or could not tell -- NEVER folded into 1, because a
 *      caller that cannot tell a refusal from a crash retries the one it should
 *      escalate
 *   3  a run is in flight elsewhere; this process started nothing
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyKey, decideVerify, VERIFY, ACTION } from '../src/verifyCache.mjs';
import { verificationIdentity, verifyRecordPath } from '../src/verifyIdentity.mjs';
import { runVerification, readRecord } from '../src/verifyRunner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');
const statusOnly = argv.includes('--status');

const EXIT = {
  [VERIFY.PASSED]: 0,
  [VERIFY.FAILED]: 1,
  [VERIFY.PARTIAL]: 2,
  [VERIFY.TIMED_OUT]: 2,
  [VERIFY.RUNNING]: 3,
};

function report(record, extra = {}) {
  if (asJson) { console.log(JSON.stringify({ ...record, ...extra }, null, 2)); return; }
  console.log(`state     ${record?.state ?? '(none)'}`);
  console.log(`key       ${record?.key ?? ''}`);
  if (record?.why) console.log(`why       ${record.why}`);
  if (record?.tests != null) console.log(`tests     ${record.tests} (fail ${record.fail ?? 0})`);
  if (record?.duration_ms != null) console.log(`duration  ${Math.round(record.duration_ms / 1000)}s`);
  if (record?.shards) {
    for (const s of record.shards) {
      console.log(`  shard ${s.index}  exit ${s.exitCode ?? '-'}  tests ${s.tests ?? '-'}  fail ${s.fail ?? '-'}`);
    }
  }
  for (const [k, v] of Object.entries(extra)) console.log(`${k.padEnd(9)} ${v}`);
}

const identity = verificationIdentity(root, process.env);
const keyed = verifyKey(identity);
if (!keyed.ok) {
  console.error('verify: cannot form an identity for this tree, so no result could be trusted');
  for (const e of keyed.errors) console.error(`  ${e}`);
  process.exit(2);
}
const key = keyed.key;

const existing = readRecord(key);
const decision = decideVerify(existing, { now: Date.now(), key });

if (decision.action === ACTION.REUSE) {
  report(existing, { source: 'cached for this exact tree', file: verifyRecordPath(key) });
  process.exit(EXIT[existing.state] ?? 2);
}

if (decision.action === ACTION.ATTACH) {
  if (statusOnly) { report(existing, { why2: decision.why }); process.exit(3); }
  /*
   * POLL, DO NOT SPAWN. This is the whole point: the second caller waits for
   * the first rather than doubling the load that made both slow. It gives up on
   * the HEARTBEAT going stale, never on a wall clock, because a slow run and a
   * dead one are different and only the heartbeat distinguishes them.
   */
  console.error(`verify: ${decision.why}`);
  let takeOver = false;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5_000); });
    const now = readRecord(key);
    const d = decideVerify(now, { now: Date.now(), key });
    if (d.action === ACTION.REUSE) {
      report(now, { source: 'waited for the run already in flight' });
      process.exit(EXIT[now.state] ?? 2);
    }
    if (d.action === ACTION.START) {
      /*
       * THE HOLDER DIED, SO TAKE OVER. Giving up here was a livelock.
       *
       * "POLL, DO NOT SPAWN" above is about not running a SECOND CONCURRENT
       * suite, which is the duplication that made every run miss the
       * deadline. When the holder is dead there is no second -- there is
       * zero, and a stale RUNNING record that the next caller will attach to
       * exactly as this one did.
       *
       * Measured: the Stop gate started a run, hit its deadline, reaped its
       * children and left the record RUNNING. An out-of-band verify attached
       * to that corpse, correctly reported "dead rather than slow", and
       * exited having verified nothing -- so the tree still had no result and
       * the next attempt would repeat the whole cycle.
       *
       * Deciding to run is safe precisely BECAUSE the heartbeat says nobody
       * else is: that is the one thing `decideVerify` is sure of here, and it
       * is the same evidence the gate itself uses to start.
       */
      console.error(`verify: the run we attached to ${d.why}. Taking over rather than leaving this tree unverified`);
      takeOver = true;
      break;
    }
  }
  /*
   * ONLY GIVE UP WHILE THE OTHER RUN IS STILL ALIVE. A holder that is still
   * beating after thirty minutes is a machine to look at, and starting a
   * second suite beside it would be the duplication this design removes. A
   * holder that DIED is the opposite case and falls through to run it.
   */
  if (!takeOver) {
    console.error('verify: gave up waiting; the other run is still beating but has not finished');
    process.exit(3);
  }
}

if (statusOnly) {
  console.log('state     (none)');
  console.log(`key       ${key}`);
  console.log('why       no verification exists for this tree');
  process.exit(2);
}

const final = await runVerification({
  root,
  key,
  identity,
  shards: Number(flag('--shards', 4)),
  concurrency: Number(flag('--concurrency', 2)),
});
report(final, { source: 'ran now', file: verifyRecordPath(key) });
process.exit(EXIT[final.state] ?? 2);
