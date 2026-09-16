import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * --no-prior-deployment IS AN UNCONDITIONAL OVERRIDE OF THE DRIFT CHECK.
 *
 * The flag exists for an honest first deploy: without it there is one value --
 * absent -- for both "there is no prior deployment" and "nobody compared", and
 * the gate cannot refuse the second without blocking the first. That reasoning
 * is sound and it is written up in the CLI header.
 *
 * What it does not do is stop meaning that once a prior deployment exists. The
 * flag is read before the --record/--live branch and wins outright, so a caller
 * can hand the gate a record and a live reading that plainly DISAGREE and the
 * gate will print "live drift none recorded yet, declared explicitly" and skip
 * the one comparison it exists for. deploy/last-deployment.json has been in the
 * tree since version 24, so "no prior deployment" is not merely unchecked here,
 * it is checkably false.
 *
 * This is the shape the gate's own header warns about: "a skip is not a pass".
 * A flag that turns a check off is fine; a flag that turns it off while the
 * evidence to run it is sitting in the argv is a hollow gate with a switch on
 * it. The refusal has to be louder than the flag.
 */

const BIN = fileURLToPath(new URL('../bin/agentbridge-deploy-check.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

function runGate(args) {
  try {
    return { out: execFileSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8' }), code: 0 };
  } catch (err) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

async function pair(t, { recorded, live }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gate-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rec = path.join(dir, 'record.json');
  const liv = path.join(dir, 'live.json');
  await writeFile(rec, JSON.stringify(recorded));
  await writeFile(liv, JSON.stringify(live));
  return { rec, liv };
}

const RECORD = {
  schemaVersion: 1,
  headSha: 'd8235a060b4c6dd8b3040af11c55db1fda731ea1',
  sourceDigest: 'c8a63d7775a969d7c8a63d7775a969d7c8a63d7775a969d7c8a63d7775a969d7',
  liveArtifactHash: 'RECORDED_ARTIFACT_HASH',
  liveVersion: 24,
  deployedAt: '2026-09-16T23:21:56.329Z',
};

test('THE FLAG MAY NOT SILENCE A COMPARISON THE ARGV CAN ALREADY MAKE', async (t) => {
  /*
   * The positive first, so this is not a negative against a fixture that
   * stopped being one: WITHOUT the flag, this same pair is compared and the
   * drift is reported. If this half stops holding, the assertion below proves
   * nothing about the flag.
   */
  const { rec, liv } = await pair(t, {
    recorded: RECORD,
    live: { artifactHash: 'SOMETHING_ELSE_ENTIRELY', version: 25 },
  });

  const without = runGate(['--ref', 'origin/master', '--record', rec, '--live', liv]);
  assert.match(
    without.out,
    /live drift/,
    'precondition: the gate did not even mention drift for a supplied pair',
  );
  assert.doesNotMatch(
    without.out,
    /none recorded yet/,
    'precondition: a supplied, disagreeing pair was treated as "no prior deployment"',
  );

  /* And now the flag, with the very same disagreeing pair in the argv. */
  const withFlag = runGate([
    '--ref', 'origin/master', '--record', rec, '--live', liv, '--no-prior-deployment',
  ]);

  assert.doesNotMatch(
    withFlag.out,
    /none recorded yet, declared explicitly/,
    '--no-prior-deployment silenced a drift comparison the gate had everything it needed to run. '
      + 'A record and a live reading were both supplied and they disagree; the flag is for the '
      + 'case where there is nothing to compare, not for the case where comparing is inconvenient.',
  );
  assert.match(
    withFlag.out,
    /contradict|contradiction|cannot be combined|no-prior-deployment/i,
    'the gate must NAME the contradiction rather than quietly preferring one input over the other',
  );
});

test('THE HONEST FIRST DEPLOY STILL GETS ITS FLAG', () => {
  /*
   * The refusal above must not have been bought by disabling the flag. Alone --
   * with no record to contradict -- it still has to declare the first deploy,
   * or the fix has simply moved the problem to the caller it was written for.
   */
  const out = runGate(['--ref', 'origin/master', '--no-prior-deployment']).out;
  assert.match(
    out,
    /none recorded yet, declared explicitly/,
    'the flag stopped working in the case it exists for; the contradiction check is too broad',
  );
  assert.doesNotMatch(out, /contradicts --record/, 'refused a contradiction that was not there');
});

test('A RECORD WITH NO LIVE READING IS STILL NOT A COMPARISON', async (t) => {
  /*
   * --record alone cannot be compared to anything. It must not read as a
   * completed drift check, and it must not read as a declared first deploy
   * either: it is the unchecked case, which is the one the gate refuses.
   */
  const { rec } = await pair(t, { recorded: RECORD, live: {} });
  const out = runGate(['--ref', 'origin/master', '--record', rec]).out;
  assert.doesNotMatch(
    out,
    /none recorded yet, declared explicitly/,
    'a supplied record was reported as "no prior deployment"',
  );
});
