/**
 * THE RESOLVER IS WIRED IN, AND THE WIRING IS A SEPARATE CLAIM FROM THE LOGIC.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * `921230a` added src/watcherIdentity.mjs with twelve unit tests and landed it
 * with exactly ONE call site:
 *
 *     scripts/bridge-session-poll.mjs:753  await import('../src/watcherIdentity.mjs')
 *     scripts/bridge-session-poll.mjs:769  resolveAgentId({...})
 *
 * Nothing in test/ reached that call site. Twelve green tests proved the
 * decision was right and nothing at all proved anybody asked for it -- CLAUDE.md
 * rule 17, which is about a guard that concluded nothing because the path never
 * got to it, and rule 10, which is why the logic was put in src/ in the first
 * place.
 *
 * ═══ AND THE WIRING HAS ALREADY BEEN BROKEN ONCE, MEASURABLY ═══
 *
 * `readRegistrations()` is async. The first wire called it WITHOUT await, so the
 * resolver received a Promise, and every session refused with "no prior
 * registration" -- byte-identical to the bug being fixed, against a store that
 * held the answer. All twelve unit tests passed a plain array, so not one of
 * them could see it. It was found by hand, on a dry run, once.
 *
 * That is the defect this file is a gate for. Delete the `await` on line 759
 * and THE WIRING test below goes red naming it. Verified both directions before
 * this was committed; see the commit message for the transcript.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 * Nothing here reaches the live bridge or the operator's store.
 * AGENTBRIDGE_REGISTER_URL points at an unreachable host, so registration stays
 * local and the supervisor's first poll fails transport; AGENTBRIDGE_HOME is a
 * fresh temp dir, so the fixture store is the only store in scope. Same fixture
 * discipline as test/bridgeSessionPoll.test.mjs, for the same reasons.
 *
 * ═══ NOTHING BELOW IS TYPED THAT THE MACHINE CAN BE ASKED FOR ═══
 *
 * CLAUDE.md rule 21. `repo_id` and `worktree_id` are `basename(g.worktree)` at
 * registration time, which in THIS checkout is "Agent007" and in an auditor's
 * clone is a mkdtemp name like "ab-audit-Gv9K6i". A literal here would pass for
 * the author and fail for the one reader whose job is to check it, in the
 * direction that looks like the code is wrong. So it is derived from REPO at
 * run time, and `machineId` is written into the fixture config rather than read
 * from the operator's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RUNNER = path.join(REPO, 'scripts', 'bridge-session-poll.mjs');

/**
 * DERIVED, NOT TYPED -- and this is the value the whole file turns on.
 *
 * bin/agentbridge.mjs writes `repo_id: basename(g.worktree)` and
 * `worktree_id: basename(g.worktree)`; the poll supervisor passes
 * `path.basename(REPO)` for both. If a fixture row disagrees with this, the
 * resolver's worktree filter drops it and every assertion below would pass by
 * refusing -- a hollow gate of exactly the shape in row 9 of the table.
 */
const WORKTREE = path.basename(REPO);

const UUID = 'wire-test-7c1d4b02-91a6-4f3e-b5d8-6e2a0c9f7431';
const SESSION = `claude-${UUID}`;
const MACHINE = 'wire-test-machine-6f2b8a44';

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-wire-'));

/**
 * A row in the shape bin/agentbridge.mjs:1545 actually writes.
 *
 * Copied field for field from the register-session path rather than invented,
 * because a fixture the system never produces cannot fail for the real case.
 * `session_id` is stored WITHOUT the `claude-` prefix, which is what the live
 * store holds and what makes sameSession's normalisation load-bearing here.
 */
const row = (over = {}) => ({
  agent_id: 'wire-agent',
  session_id: UUID,
  repo_id: WORKTREE,
  worktree_id: WORKTREE,
  lane_id: null,
  capacity: 'idle',
  head_sha: '0'.repeat(40),
  heartbeat_at: new Date().toISOString(),
  verification: 'runtime-self-registration',
  machine_id: MACHINE,
  ...over,
});

/**
 * A fixture home with a machine id and a registration store.
 *
 * The machine id goes in config.json because readMachineId() in the supervisor
 * reads exactly that file and key. Writing it here rather than reading the
 * operator's means the machine-match branch is exercised by the fixture instead
 * of by whatever machine happens to run the suite.
 */
function fixtureHome(rows) {
  const home = mkTemp();
  fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ machineId: MACHINE }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, 'registrations.json'), `${JSON.stringify(rows, null, 2)}\n`);
  const tokenFile = path.join(home, 'token.txt');
  fs.writeFileSync(tokenFile, 'dummy-token-value\n');
  return { home, tokenFile };
}

function baseEnv(home, tokenFile, over = {}) {
  return {
    ...process.env,
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_TOKEN_FILE: tokenFile,
    // The defect is about a session that arrived WITHOUT this set -- a
    // teleport, a fresh terminal, an IDE. Empty is the case under test.
    AGENTBRIDGE_AGENT_ID: '',
    AGENTBRIDGE_LANE: '',
    // Nothing may reach the real bridge. Unreachable, not merely wrong.
    AGENTBRIDGE_REGISTER_URL: 'https://x.invalid/mcp/register',
    ...over,
  };
}

const run = (env, payload = { session_id: UUID }) => spawnSync(
  process.execPath, [RUNNER, '--session-start'],
  { cwd: REPO, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 90_000, windowsHide: true },
);

/**
 * The LAST thing the hook said -- its verdict.
 *
 * Same helper test/bridgeSessionPoll.test.mjs uses, and it is correct for a
 * verdict because the polling-or-refusing line is always last.
 */
const message = (r) => {
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()).systemMessage; } catch { return String(r.stdout); }
};

/**
 * EVERYTHING the hook said, and the distinction cost this file a red run.
 *
 * `say()` writes ONE JSON OBJECT PER LINE, and sessionStart calls it more than
 * once: the resolution announcement, then the dark-watcher alarm, then the
 * verdict. Asserting the announcement against the last line failed while the
 * announcement was sitting two lines above it -- an assertion on a proxy for
 * "what was said" (rule 4), in my own gate, on the first run.
 *
 * So anything about what the operator was TOLD reads every line. Only the
 * verdict reads the last one.
 *
 * WHAT THIS DOES NOT ESTABLISH, and it is a separate open question rather than
 * something this file quietly settles: whether the hook CONSUMER renders a
 * second `{"systemMessage":...}` line at all. These assertions prove the bytes
 * leave the process, which is the half a test here can measure. The pattern
 * predates this work -- the darkWatchers alarm on line 901 does the same thing
 * -- so it is not a regression, but "emitted" is not "seen" and nothing should
 * be read as claiming it is.
 */
const allMessages = (r) => String(r.stdout).trim().split('\n')
  .map((line) => { try { return JSON.parse(line).systemMessage ?? ''; } catch { return line; } })
  .join('\n');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidPath = (home) => path.join(home, 'polls', `${SESSION}.json`);

function cleanup(home, pid) {
  if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(home, { recursive: true, force: true });
}

/* ── the wiring ──────────────────────────────────────────────────────────── */

test('THE WIRING: an unset AGENTBRIDGE_AGENT_ID resolves from the store and DOES poll', () => {
  /*
   * THE FAR END, NOT A PROXY (rule 4). Exit 0 proves nothing -- this hook exits
   * 0 on every refusal by design, because a hook must never fail a session. So
   * the assertion is the pid RECORD, which the supervisor writes only after it
   * resolved an identity, registered under it, and detached a child.
   *
   * THIS IS THE TEST THAT GOES RED IF THE `await` IS DROPPED. Without it the
   * resolver gets a Promise, returns "not an array", and the supervisor prints
   * NOT POLLING -- no pid file, no agentId, and the assertion names the reason.
   */
  const { home, tokenFile } = fixtureHome([row()]);
  let pid = null;
  try {
    const r = run(baseEnv(home, tokenFile));
    const msg = message(r);
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);

    assert.doesNotMatch(msg, /NOT POLLING/,
      `the supervisor refused a session the store could identify: ${msg}`);
    assert.match(msg, /is polling \(pid \d+\)/, `expected a polling message, got: ${msg}`);

    assert.equal(fs.existsSync(pidPath(home)), true,
      'no pid record: the resolver was never consulted, or its answer was not used');
    const rec = JSON.parse(fs.readFileSync(pidPath(home), 'utf8'));
    pid = rec.pid;

    /*
     * THE VALUE, NOT MERELY THE FACT. A watcher that started under the WRONG
     * name is the failure the resolver exists to prevent, and it would satisfy
     * every assertion above.
     */
    assert.equal(rec.agentId, 'wire-agent',
      'the watcher started under an identity that is not the one the store names');
    assert.equal(rec.sessionId, SESSION);
  } finally {
    cleanup(home, pid);
  }
});

test('THE WIRING SAYS WHICH RUNG ANSWERED, so a resolved id is not read as a declared one', () => {
  /*
   * A name nobody typed must announce where it came from. Without this the
   * operator cannot tell `wire-agent` came from the store rather than from the
   * environment, and the next person debugging the roster has to read source to
   * find out.
   */
  const { home, tokenFile } = fixtureHome([row()]);
  let pid = null;
  try {
    const r = run(baseEnv(home, tokenFile));
    const said = allMessages(r);
    // THE POSITIVE FIRST (rule 5): an announcement asserted against a hook that
    // refused would pass for the wrong reason on any refusal that mentions the
    // variable, and this file has three such refusals.
    assert.match(message(r), /is polling/, `the hook refused, so the announcement proves nothing: ${said}`);
    assert.match(said, /AGENTBRIDGE_AGENT_ID is not set; resolved this session as wire-agent/, said);
    assert.match(said, /this-session/, `the source rung was not named: ${said}`);
    try { pid = JSON.parse(fs.readFileSync(pidPath(home), 'utf8')).pid; } catch { /* refused */ }
  } finally {
    cleanup(home, pid);
  }
});

test('THE DECLARED VARIABLE STILL WINS THROUGH THE WIRING, and says nothing about resolving', () => {
  /*
   * Rule 5: the negative below is worthless unless the ordinary path still
   * works, and this is the path every agent.cmd session takes. It must beat the
   * store rather than be overridden by it, end to end and not just in the unit.
   */
  const { home, tokenFile } = fixtureHome([row()]);
  let pid = null;
  try {
    const r = run(baseEnv(home, tokenFile, { AGENTBRIDGE_AGENT_ID: 'declared-agent' }));
    assert.match(message(r), /is polling/, allMessages(r));
    const rec = JSON.parse(fs.readFileSync(pidPath(home), 'utf8'));
    pid = rec.pid;
    assert.equal(rec.agentId, 'declared-agent', 'the store overrode an explicitly declared id');
    // EVERY line, not the last: the announcement is emitted before the verdict,
    // so checking the verdict alone would pass with the announcement present.
    assert.doesNotMatch(allMessages(r), /resolved this session as/,
      'a declared id must not be announced as a resolution');
  } finally {
    cleanup(home, pid);
  }
});

/* ── the refusals, through the same wire ─────────────────────────────────── */

test('AN AMBIGUOUS WORKTREE REFUSES THROUGH THE WIRE, AND NAMES THE CANDIDATES', () => {
  /*
   * The safety half. Two agents have registered here and this session is
   * neither, so there is no answer -- and inventing one puts a name on the
   * roster that assign_task routes real work by.
   *
   * DIFFERENCED against the passing case: the only change from the test above
   * is a second occupant and an unknown session id, so a refusal here cannot be
   * something else refusing.
   */
  const rows = [
    row({ agent_id: 'wire-agent', session_id: 'some-other-session' }),
    row({ agent_id: 'other-agent', session_id: 'a-third-session' }),
  ];
  const { home, tokenFile } = fixtureHome(rows);
  try {
    const msg = message(run(baseEnv(home, tokenFile)));
    assert.match(msg, /NOT POLLING/, msg);
    assert.match(msg, /cannot be established/, msg);
    assert.match(msg, /other-agent/, `the refusal did not name the candidates: ${msg}`);
    assert.match(msg, /wire-agent/, `the refusal did not name the candidates: ${msg}`);
    assert.equal(fs.existsSync(pidPath(home)), false, 'an unresolved session started a watcher');
  } finally {
    cleanup(home, null);
  }
});

test('A ROW FROM ANOTHER MACHINE DOES NOT LEND AN IDENTITY THROUGH THE WIRE', () => {
  /*
   * registrations.json is shared state, so without the machine check a session
   * here could adopt an agent that has only ever run elsewhere. This is the
   * branch readMachineId() feeds, and it is the one the fixture config.json
   * exists to exercise -- if that read broke, machineId would arrive null, the
   * filter would be skipped, and this row WOULD resolve.
   */
  const { home, tokenFile } = fixtureHome([row({ machine_id: 'a-different-machine' })]);
  try {
    const msg = message(run(baseEnv(home, tokenFile)));
    assert.match(msg, /NOT POLLING/, msg);
    assert.equal(fs.existsSync(pidPath(home)), false, 'a foreign row started a watcher');
  } finally {
    cleanup(home, null);
  }

  // THE DIFFERENCED CONTROL: the same row, this machine, resolves.
  const { home: h2, tokenFile: t2 } = fixtureHome([row()]);
  let pid = null;
  try {
    assert.match(message(run(baseEnv(h2, t2))), /is polling/,
      'the same row with our machine id did not resolve, so the refusal above proves nothing');
    pid = JSON.parse(fs.readFileSync(pidPath(h2), 'utf8')).pid;
  } finally {
    cleanup(h2, pid);
  }
});

test('AN EMPTY STORE STILL REFUSES, AND STILL NAMES THE VARIABLE THAT FIXES IT', () => {
  /*
   * The behaviour that shipped before any of this existed. A session with no
   * evidence anywhere must still be told what to set -- the resolution path is
   * an addition to the refusal, not a replacement for it.
   */
  const { home, tokenFile } = fixtureHome([]);
  try {
    const msg = message(run(baseEnv(home, tokenFile)));
    assert.match(msg, /NOT POLLING/, msg);
    assert.match(msg, /AGENTBRIDGE_AGENT_ID/, msg);
    /*
     * AND IT MUST NOT READ LIKE AN UNREADABLE STORE. "no prior registration" and
     * "the caller handed over a Promise" are different diagnoses, and collapsing
     * them is what hid the un-awaited read for a whole build.
     */
    assert.doesNotMatch(msg, /not an array/,
      'an empty store was reported as an unreadable one');
    assert.equal(fs.existsSync(pidPath(home)), false);
  } finally {
    cleanup(home, null);
  }
});
