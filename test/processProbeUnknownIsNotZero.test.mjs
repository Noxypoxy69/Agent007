/**
 * A FAILED PROCESS PROBE MUST NOT RENDER AS A MEASURED ZERO.
 *
 * THE DEFECT. `probeProcesses` returns `byWorktree: {}` when the probe itself
 * fails, and the collector fills the missing key with an empty array. So a
 * worktree whose process list COULD NOT BE READ and a worktree that genuinely
 * has nothing running both arrive at the renderer as `processes: []`. The old
 * `if (s.processes.length)` printed no `running` line in either case, and the
 * two SESSION BLOCKS were byte-identical.
 *
 * WHY THE SESSION BLOCK AND NOT THE WHOLE OUTPUT, which is the whole reason this
 * file is shaped the way it is. `status` already prints a machine-level banner
 * ("! process probe failed: ...") when the probe fails, so THE TWO FULL OUTPUTS
 * ALREADY DIFFER AT BASE. An assertion that the outputs differ is therefore
 * GREEN BEFORE THE REPAIR EXISTS -- the strongest-looking assertion available
 * here is a hollow gate. Measured against base caa8797, not argued:
 *
 *     whole output differs : true    <- proves nothing
 *     session block differs: false   <- the defect
 *
 * The banner is also not a substitute for the fix: it says SOME probe failed,
 * and on a multi-session roster it does not say which blocks are unmeasured.
 *
 * BOTH STATES ARE REAL AND ARE BUILT BY THE REAL PRODUCER. Nothing here
 * constructs a payload by hand. The failing probe is produced by restricting
 * PATH so `powershell.exe` (or `ps`) cannot be resolved, which drives
 * exec.mjs's `run()` to a genuine ENOENT. git stays resolvable on purpose --
 * without it `gitState` returns ok:false, the renderer `continue`s, and the line
 * under test is never reached.
 *
 * THE ENVIRONMENT ASSUMPTION IS AN ASSERTION, NOT A GUARD. If the PATH trick
 * fails to break the probe on some machine, the preconditions below go RED with
 * a message saying so. They do not skip and they do not pass quietly: CLAUDE.md
 * rule 6, and rule 4 -- the payload is read for the actual flag rather than an
 * exit code being taken as proof the state was reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';

const CLI = path.resolve(new URL('../bin/agentbridge.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0));

/*
 * A FRESH DIRECTORY PER RUN, never a fixed name under the repo.
 *
 * test/checkFirstCli.test.mjs writes a fixed-name probe file into the real repo
 * root and is flaky under concurrency for exactly that reason. mkdtemp costs
 * nothing and removes the whole class.
 */
/*
 * THE FIXTURE'S OWN NAMES MUST NOT CONTAIN THE WORDS BEING MATCHED.
 *
 * A first version used the lane `unknownprobe` and the prefix
 * `ab-probeunknown-`. The session header line carries both the lane and the
 * worktree path, so `assert.doesNotMatch(block, /unknown/i)` matched the
 * FIXTURE'S OWN NAME and failed in BOTH trees -- identically to CLAUDE.md rule
 * 13, where a check matched its own explanatory comment. Failing in both trees
 * is the signature worth knowing: an assertion that does not move when the code
 * does is not measuring the code.
 */
const WORK = mkdtempSync(path.join(tmpdir(), 'ab-procstate-'));
const HOME = path.join(WORK, 'home');
const WT = path.join(WORK, 'wt');
mkdirSync(HOME, { recursive: true });
mkdirSync(WT, { recursive: true });

process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
git(['init', '-q', '-b', 'main'], WT);
git(['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], WT);

/**
 * A PATH from which the process probe cannot be resolved but git still can.
 *
 * win32: the directory holding git.exe (Git's `cmd` dir), which does not contain
 * powershell.exe. posix: a scratch directory holding only a symlink to git, so
 * `ps` is unresolvable.
 *
 * Discovered at runtime rather than hardcoded -- CLAUDE.md's note that guessing
 * what exists on a machine that is not the one under test has caused two
 * separate outages.
 */
function probeBreakingPath() {
  const which = platform() === 'win32' ? ['where', 'git'] : ['which', 'git'];
  const resolved = execFileSync(which[0], [which[1]], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  assert.ok(resolved, 'could not locate git, so this test cannot build a PATH that keeps git and drops the probe');
  if (platform() === 'win32') return path.dirname(resolved);
  const dir = path.join(WORK, 'pathonly');
  mkdirSync(dir, { recursive: true });
  symlinkSync(resolved, path.join(dir, 'git'));
  return dir;
}

function runCli(argv, { breakProbe = false } = {}) {
  const env = { ...process.env, AGENTBRIDGE_HOME: HOME };
  if (breakProbe) env.PATH = probeBreakingPath();
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env, stdio: 'pipe', timeout: 120_000 }) };
  } catch (e) {
    return { code: e.status ?? null, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

/* Build the fixture with the shipped commands, so the config and registry are
 * whatever this code actually writes rather than a guess at their shape. */
const init = runCli(['init']);
assert.equal(init.code, 0, `fixture init failed: ${init.err ?? ''}`);
const reg = runCli(['register', '--agent', 'probe1', '--lane', 'procstate', '--worktree', WT]);
assert.equal(reg.code, 0, `fixture register failed: ${reg.err ?? ''}`);

/** Everything from this session's header line to the end of its block. */
function sessionBlock(out) {
  const lines = out.replace(/20\d\d-\d\d-\d\dT[\d:.]+Z/g, '<TS>').split('\n');
  const start = lines.findIndex((l) => /^probe1 \[procstate\]/.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l) && l.trim().length);
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n').trimEnd();
}

/**
 * The block's INDENTED BODY, without the header.
 *
 * The header carries the lane and the worktree path -- fixture-chosen text that
 * has no business satisfying or defeating an assertion about what the renderer
 * decided. The body is the rendered fields and nothing else.
 */
function sessionBody(out) {
  const b = sessionBlock(out);
  return b === null ? null : b.split('\n').slice(1).join('\n');
}

const MEASURED = { json: runCli(['status', '--json']), human: runCli(['status']) };
const FAILED = { json: runCli(['status', '--json'], { breakProbe: true }), human: runCli(['status'], { breakProbe: true }) };

const payload = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

test('precondition: the measured-empty state is real -- probe succeeded, list empty, git readable', () => {
  const p = payload(MEASURED.json);
  assert.ok(p, 'status --json did not produce a parseable payload');
  assert.equal(p.sessions.length, 1);
  assert.equal(p.processProbe.ok, true, 'the probe was expected to SUCCEED here');
  assert.equal(p.sessions[0].processProbeOk, true);
  assert.deepEqual(p.sessions[0].processes, [], 'the throwaway worktree should match no processes');
  assert.equal(p.sessions[0].git.ok, true, 'git must be readable or the renderer skips this session');
});

test('precondition: the probe-failed state is real -- probe failed, list still empty, git readable', () => {
  const p = payload(FAILED.json);
  assert.ok(p, 'status --json did not produce a parseable payload');
  assert.equal(p.sessions.length, 1);
  assert.equal(p.processProbe.ok, false,
    'the restricted PATH did not break the process probe on this machine, so the state under test was never reached');
  assert.equal(p.sessions[0].processProbeOk, false);
  assert.deepEqual(p.sessions[0].processes, [], 'a failed probe still arrives as an empty array -- this is the defect');
  assert.equal(p.sessions[0].git.ok, true,
    'git must stay resolvable under the restricted PATH, or bin/agentbridge.mjs continues past the line under test');
});

/* Rule 5: assert the block was found before asserting anything about its
 * contents. "the unknown marker is absent" passes perfectly against a block
 * that was never located. */
test('control: a session block is located in both renderings', () => {
  assert.ok(sessionBlock(MEASURED.human.out), 'no session block in the measured-empty rendering');
  assert.ok(sessionBlock(FAILED.human.out), 'no session block in the probe-failed rendering');
});

test('THE PROPERTY: an unmeasured process list renders differently from a measured empty one', () => {
  const a = sessionBlock(MEASURED.human.out);
  const b = sessionBlock(FAILED.human.out);
  assert.notEqual(a, b,
    'the session block is IDENTICAL whether the process list was measured as empty or could not be read at all, '
    + 'so the operator cannot tell "nothing is running" from "we do not know"');
});

test('the probe-failed block says the list is unavailable rather than staying silent', () => {
  const b = sessionBody(FAILED.human.out);
  assert.match(b, /unknown/i, 'the probe-failed session block does not mark the process list as unknown');
  assert.match(b, /cannot be confirmed/,
    'the wording should match bridge/collisions.mjs, which already raises this for the same payload');
});

/*
 * THE HALF THAT MAKES IT A PROOF. Without this, a renderer that printed the
 * unknown marker unconditionally would pass every assertion above while being a
 * worse bug than the one being fixed -- it would claim every measured zero was
 * unmeasured.
 */
test('the measured-empty block does NOT claim the list is unknown', () => {
  const a = sessionBody(MEASURED.human.out);
  assert.doesNotMatch(a, /unknown/i,
    'a successful probe that found nothing must still read as a measured zero, not as unknown');
  assert.doesNotMatch(a, /cannot be confirmed/);
});
