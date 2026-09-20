/**
 * THE STOP GATE SHOULD NOT BE A TEST RUNNER. IT SHOULD CONSUME A RESULT.
 *
 * ═══ THE PROBLEM, MEASURED OVER ONE NIGHT ═══
 *
 * The gate spawns `npm test` on every turn end. A session that also runs the
 * suite -- which is the normal way to check your own work -- puts two full
 * copies on one machine. Measured on this repository: a solo run is ~185s, two
 * concurrent runs are ~400-430s, and the gate's budget is 420s. So the gate
 * killed its own suite and reported NOTHING WAS VERIFIED five times in one
 * session, every time because a second copy of the same work was running
 * beside it.
 *
 * Raising the budget to 900s moves that wall; it does not remove it. Two copies
 * of a growing suite will find 900 the same way they found 420, and the second
 * copy was never doing anything the first was not.
 *
 * ═══ WHAT REPLACES IT ═══
 *
 *   1. LOOK FOR A COMPLETED RESULT WITH THE SAME KEY  -> reuse it
 *   2. LOOK FOR A RUNNING ONE WITH THE SAME KEY       -> attach, never start
 *   3. OTHERWISE                                       -> start exactly one
 *
 * This is single-flight, and the pattern is borrowed rather than invented:
 * node-core-utils refuses to launch CI for a commit that already has a run in
 * flight, and agent-studio caches baseline verification keyed by repository,
 * baseline sha, command and toolchain, reusing the parsed result across
 * attempts. Both were pointed at by Danny; neither idea is mine.
 *
 * ═══ THE KEY IS THE WHOLE SAFETY ARGUMENT ═══
 *
 * A cache that returns a PASS for a tree that was not tested is not a
 * performance improvement, it is a forged verification -- and it would be the
 * worst defect this repository has ever shipped, because every other control
 * sits behind the suite. So the key is an IDENTITY, and it includes everything
 * that can change what the run would do:
 *
 *   tree_digest    THE WORKING TREE, not HEAD. An uncommitted edit changes what
 *                  the suite executes, and `npm test`'s glob is expanded by node
 *                  rather than by git -- an untracked test file runs. Keying on
 *                  a commit would reuse a PASS across an edit. This is the same
 *                  reason src/auditPin.mjs measures `git status` and not
 *                  `HEAD^{tree}`, a defect a blind audit demonstrated live.
 *   command        the exact argv. A narrower command proves less.
 *   toolchain      node version and platform. Two suite failures in this repo
 *                  are Windows/node-24 specific and structurally cannot fail
 *                  elsewhere, so a result from another runtime is about a
 *                  different question.
 *   env_digest     the environment variables the suite reads. AGENTBRIDGE_HOME
 *                  alone decides whether a test sees the operator's real grants.
 *
 * ANY FIELD MISSING MEANS NO KEY, AND NO KEY MEANS RUN IT. A partial identity
 * that still produced a key would match trees it should not.
 *
 * PURE. No filesystem, no clock, no child processes -- the caller measures and
 * passes readings in. Rule 10, and the only reason the interesting cases are
 * testable: no test can race two real suites, but any test can hand this a
 * record that claims to be running and a clock that says otherwise.
 */

import { createHash } from 'node:crypto';

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** §-style states, so a reader can tell a crash from a refusal from a pass. */
export const VERIFY = Object.freeze({
  REQUESTED: 'VERIFY_REQUESTED',
  RUNNING: 'VERIFY_RUNNING',
  PARTIAL: 'VERIFY_PARTIAL',
  PASSED: 'VERIFY_PASSED',
  FAILED: 'VERIFY_FAILED',
  TIMED_OUT: 'VERIFY_TIMED_OUT',
});

/** What a caller should do about an existing record. */
export const ACTION = Object.freeze({
  REUSE: 'REUSE',     // a completed result for this exact identity
  ATTACH: 'ATTACH',   // one is in flight; wait for it, never start a second
  START: 'START',     // nothing usable; this caller runs it
});

/**
 * A record is only in flight while something is proving it.
 *
 * UNKNOWN IS NOT DEAD, and this repository has the scar: a dead watcher and a
 * working one produced byte-identical evidence for a night, because absence of
 * news was read as health. So a RUNNING record must keep saying so. Two
 * missed heartbeats is dead -- one allows for a slow write, two does not.
 */
export const HEARTBEAT_MS = 30_000;
export const DEAD_AFTER_MS = HEARTBEAT_MS * 2;

/**
 * The identity of a verification run.
 *
 * @returns {{ok:true, key:string, parts:object} | {ok:false, errors:string[]}}
 */
export function verifyKey({
  tree_digest, command, toolchain, env_digest,
} = {}) {
  const parts = {
    tree_digest: str(tree_digest),
    command: str(command),
    toolchain: str(toolchain),
    env_digest: str(env_digest),
  };
  const errors = Object.entries(parts)
    .filter(([, v]) => v === null)
    .map(([k]) => `${k} is required: a key missing it would match a tree that was never tested`);
  if (errors.length) return { ok: false, errors };

  /*
   * NUL-FRAMED, like the digests elsewhere in this repository. Without length
   * framing two different field sets can concatenate to one string -- a tree
   * digest ending in a command prefix, say -- and a cache whose key collides
   * returns a PASS for the wrong tree. That is the one failure this module
   * cannot be allowed to have.
   */
  const NUL = String.fromCharCode(0);
  const key = createHash('sha256')
    .update([parts.tree_digest, parts.command, parts.toolchain, parts.env_digest].join(NUL))
    .digest('hex')
    .slice(0, 32);
  return { ok: true, key, parts };
}

/**
 * Given what is on disk for this key, what should the caller do?
 *
 * FAILS TOWARDS RUNNING IT. Every unclear case returns START: an extra suite
 * costs minutes, and a wrongly reused PASS costs the whole control surface.
 *
 * @param {object|null} record  the stored record for this key, if any
 * @param {object} opts         { now, key }
 * @returns {{action:string, why:string, record:object|null}}
 */
export function decideVerify(record, { now = 0, key = null } = {}) {
  if (!record || typeof record !== 'object') {
    return { action: ACTION.START, why: 'no verification exists for this identity', record: null };
  }
  /*
   * THE KEY IS RE-CHECKED HERE, not trusted from the lookup. A caller that
   * fetched the wrong file, or a store that collided, must not be able to hand
   * this a foreign result and have it reused. Cheap, and it is the assertion
   * that makes every other line safe.
   */
  if (key !== null && str(record.key) !== str(key)) {
    return {
      action: ACTION.START,
      why: `the stored record is for a different identity (${String(record.key).slice(0, 8)}), so it says nothing about this tree`,
      record: null,
    };
  }

  const state = str(record.state);

  if (state === VERIFY.PASSED || state === VERIFY.FAILED) {
    /*
     * A COMPLETED RESULT IS REUSED WHATEVER ITS VERDICT. A cached FAILED is as
     * useful as a cached PASS and is the half people forget: re-running a suite
     * to re-learn that it is red is the same waste, and it is the case that
     * happens on every turn while somebody fixes something.
     */
    return { action: ACTION.REUSE, why: `a completed ${state} for this exact identity`, record };
  }

  if (state === VERIFY.TIMED_OUT || state === VERIFY.PARTIAL) {
    /*
     * NOT REUSED. A timeout proved nothing and a partial run proved part of
     * something; treating either as an answer is the "nothing was verified"
     * shape the gate already refuses out loud.
     */
    return { action: ACTION.START, why: `the previous run ended ${state}, which is not a result`, record };
  }

  if (state === VERIFY.RUNNING || state === VERIFY.REQUESTED) {
    /*
     * `Number(null)` IS 0, NOT NaN, and my own test caught that. A record whose
     * heartbeat_at was null coerced to epoch zero, so instead of "nobody has
     * ever beaten this" the refusal said "last beat 1000000s ago". Both refuse,
     * so the behaviour was safe -- but the reason is what a reader acts on, and
     * a wrong reason sends them to diagnose a stalled process that never
     * existed. Only a finite number is a heartbeat.
     */
    const beat = typeof record.heartbeat_at === 'number' && Number.isFinite(record.heartbeat_at)
      ? record.heartbeat_at
      : null;
    const age = beat === null ? Number.POSITIVE_INFINITY : now - beat;
    if (age <= DEAD_AFTER_MS) {
      return {
        action: ACTION.ATTACH,
        why: `a verification for this identity has been running for ${Math.max(0, Math.round((now - Number(record.started_at || beat)) / 1000))}s `
          + `(pid ${record.pid ?? 'unknown'}, last beat ${Math.round(age / 1000)}s ago). Attaching rather than starting a second copy`,
        record,
      };
    }
    return {
      action: ACTION.START,
      why: age === Number.POSITIVE_INFINITY
        ? 'a record claims to be running but has never beaten, so nobody is proving it'
        : `the running record last beat ${Math.round(age / 1000)}s ago, past the ${DEAD_AFTER_MS / 1000}s limit, so it is dead rather than slow`,
      record,
    };
  }

  return { action: ACTION.START, why: `unrecognised state ${JSON.stringify(record.state ?? null)}`, record };
}

/**
 * May a turn be approved on this record?
 *
 * SEPARATE FROM decideVerify ON PURPOSE. "Do I need to run one" and "is this
 * turn verified" are different questions, and collapsing them is how ATTACH
 * would quietly become approval -- a turn passing because somebody ELSE is
 * still running the suite.
 */
export function admitVerification(record, { now = 0, key = null } = {}) {
  const d = decideVerify(record, { now, key });
  if (d.action === ACTION.REUSE && str(record?.state) === VERIFY.PASSED) {
    return { ok: true, state: VERIFY.PASSED, why: 'the suite passed for this exact tree', record };
  }
  if (d.action === ACTION.REUSE) {
    return { ok: false, state: str(record?.state), why: 'the suite failed for this exact tree', record };
  }
  if (d.action === ACTION.ATTACH) {
    return {
      ok: false,
      state: VERIFY.RUNNING,
      why: `${d.why}. A run in flight is not a result`,
      record,
    };
  }
  return { ok: false, state: null, why: d.why, record: null };
}

/**
 * Deterministic shards, so one long suite becomes several short ones.
 *
 * node's test runner takes `--test-shard=<i>/<n>` and splits by file. Bun's
 * duration-balanced variant is better once timing history exists; this does not
 * have that history yet and says so rather than pretending to balance.
 *
 * REFUSES A SHARD COUNT THAT WOULD NOT HELP. One shard is the status quo with
 * extra machinery, and more shards than files leaves empty runs that report a
 * pass having executed nothing -- which is the hollow shape this whole
 * repository is about.
 */
export function shardPlan({ total = 1, files = 0 } = {}) {
  const n = Number.isInteger(total) && total > 0 ? total : 0;
  if (n < 1) return { ok: false, errors: ['shard count must be a positive integer'] };
  if (n === 1) return { ok: true, shards: [{ index: 1, total: 1, arg: '--test-shard=1/1' }] };
  if (Number.isInteger(files) && files > 0 && n > files) {
    return {
      ok: false,
      errors: [`${n} shards for ${files} test files would leave empty shards, and a shard that `
        + 'executed nothing still exits 0 -- a pass proving nothing'],
    };
  }
  return {
    ok: true,
    shards: Array.from({ length: n }, (_, i) => ({
      index: i + 1, total: n, arg: `--test-shard=${i + 1}/${n}`,
    })),
  };
}

/**
 * Fold shard outcomes into one verdict.
 *
 * EVERY SHARD MUST HAVE REPORTED. A missing shard is the difference between
 * "all green" and "all the ones that ran were green", and this repository has
 * shipped that exact confusion: a harness that counted failures reported a
 * caught mutation as missed because the total did not move.
 */
export function aggregateShards(results, { total = 0 } = {}) {
  const rows = Array.isArray(results) ? results.filter((r) => r && typeof r === 'object') : [];
  const expected = Number.isInteger(total) && total > 0 ? total : rows.length;

  const seen = new Set(rows.map((r) => Number(r.index)).filter(Number.isInteger));
  const missing = [];
  for (let i = 1; i <= expected; i += 1) if (!seen.has(i)) missing.push(i);

  /*
   * A SHARD WITHOUT AN INTEGER EXIT CODE IS A FAILED SHARD, NEVER A GREEN ONE.
   *
   * `Number(null) === 0`, and node sets `code = null` when a child dies by
   * SIGNAL -- the OOM killer, or a cancellation. Under the old `Number()` the
   * killed shard was not counted as failed, and if any surviving shard
   * reported tests the whole run aggregated to VERIFY_PASSED. A forged pass,
   * produced by the machine being under exactly the load that makes a suite
   * get killed.
   *
   * Strict, and it matches how the same question is already asked at
   * src/verifyRunner.mjs -- two spellings of one predicate is the pair nobody
   * watches when they disagree.
   */
  /*
   * A SHARD THE OS REFUSED TO START IS NOT EVIDENCE ABOUT THE CODE.
   *
   * Measured on this machine: two shards came back
   *
   *   exit 3221225794   tests 0   fail 0
   *
   * 3221225794 is 0xC0000142, STATUS_DLL_INIT_FAILED -- Windows telling us
   * the process could not initialise because the box was out of resources.
   * It never ran a line of the suite. The other two shards, running under the
   * same pressure, produced 89 failures where a healthy run of the same tree
   * produced 3.
   *
   * Counting that as FAILED makes the gate answer a question it was never
   * asked. "The machine could not run the tests" and "the tests failed" are
   * different answers, and only one of them is about the tree -- and because
   * `decideVerify` REUSES a completed FAILED result, the wrong one pins a
   * permanent red on code nobody tested. That is the identical trap the
   * cancellation path had, in this same function, and I fixed it there and
   * did not generalise it. Rule 8: fix the matcher, not the one value the
   * prober happened to try.
   *
   * THE DISCRIMINATOR IS DELIBERATELY NARROW. A test file with a syntax
   * error also reports zero tests, and that IS a real red -- but it exits 1
   * with a stack trace on stderr. Only a code in the NTSTATUS failure range
   * means the process itself never got off the ground, and only then with
   * nothing produced. Both conditions are required.
   */
  const NTSTATUS_FAILURE = 0xC0000000;
  const couldNotStart = rows.filter((r) => Number.isInteger(r.exitCode)
    && r.exitCode >= NTSTATUS_FAILURE
    && (Number(r.tests) || 0) === 0);

  const failed = rows.filter((r) => !Number.isInteger(r.exitCode) || r.exitCode !== 0);
  const tests = rows.reduce((n, r) => n + (Number(r.tests) || 0), 0);
  const fail = rows.reduce((n, r) => n + (Number(r.fail) || 0), 0);

  if (missing.length) {
    return {
      state: VERIFY.PARTIAL,
      why: `shard(s) ${missing.join(', ')} of ${expected} never reported, so "green" would mean `
        + 'only that the ones which ran were green',
      tests,
      fail,
    };
  }
  /*
   * CHECKED BEFORE `failed`, because a shard the OS refused to start is also
   * a non-zero exit and would otherwise be counted as a verdict about the
   * tree. PARTIAL, not FAILED, so it is never reused: "could not measure" has
   * to stay distinguishable from "measured a failure", and the other shards'
   * numbers are not trustworthy either when the box is in that state.
   */
  if (couldNotStart.length) {
    return {
      state: VERIFY.PARTIAL,
      why: `${couldNotStart.length} of ${expected} shard(s) could not start at all `
        + `(exit ${couldNotStart[0].exitCode}, no tests run) -- the machine refused to launch the process, `
        + 'so this run says nothing about the tree and must not be reused as if it did',
      tests,
      fail,
    };
  }
  if (failed.length) {
    return {
      state: VERIFY.FAILED,
      why: `${failed.length} of ${expected} shard(s) failed`,
      tests,
      fail,
    };
  }
  /*
   * A RUN THAT EXECUTED NOTHING IS NOT A PASS. Every shard exiting 0 having
   * found no tests is what a broken glob looks like, and it is indistinguishable
   * from success by exit code alone -- rule 3.
   */
  if (tests === 0) {
    return {
      state: VERIFY.PARTIAL,
      why: 'every shard exited 0 and no test ran at all; that is a broken invocation, not a pass',
      tests,
      fail,
    };
  }
  return { state: VERIFY.PASSED, why: `${tests} test(s) across ${expected} shard(s)`, tests, fail };
}
