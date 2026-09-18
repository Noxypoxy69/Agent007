import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EVERY COMMAND'S EXIT CODE, BECAUSE NOTHING CHECKED ANY OF THEM.
 *
 * THE BUG THIS GENERALISES. register-session published its row, printed
 * "hosted published", and then called process.exit(0) — which after a fetch
 * trips a libuv assertion on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * The process died with 127. Callers checking an exit code saw a failure that
 * had not happened, and the --watch shutdown path crashed before it could
 * deregister. 655 tests were green throughout, and they had to be: every one
 * asserts on stdout or on a file, and the output was CORRECT. The bug lived
 * entirely in what the process did on its way out.
 *
 * WHY THIS FILE IS NOT ANOTHER ATTEMPT AT THE CRASH. registerSessionExit.test.mjs
 * already measured that carefully and honestly:
 *
 *   real remote endpoint          exit 127, assertion fires
 *   http://127.0.0.1:PORT         exit 0
 *   https://127.0.0.1:PORT (TLS)  exit 0
 *   http://localhost:PORT         exit 0
 *
 * Neither a real fetch, nor pooled sockets, nor TLS is sufficient; only a
 * genuinely remote lookup reaches libuv's threadpool signalling. A hermetic
 * test cannot have one, and reaching the live function would be a credentialed
 * network call pretending to be a unit test. Reproducing it again here would be
 * decoration, and that file says so about its own first version.
 *
 * SO THIS PROBES THE CLASS INSTEAD. The bug survived because NOTHING CHECKED AN
 * EXIT CODE ANYWHERE — not because register-session in particular was
 * untested. Every other command has the same exposure the moment it grows a
 * fetch, and there are now more than thirty of them. This runs the whole
 * dispatched surface and asserts each one exits with a code from the documented
 * contract and never with an abort.
 *
 *   0  allow / clean      2  cannot run        4  no_decision
 *   1  refuse / denied    3  owner_required
 *
 * 126 and above are the shell-and-abort range: 127 is the libuv death, 134 is
 * SIGABRT. A command landing there has crashed, whatever it printed first.
 *
 * IT IS HERMETIC, and that is load-bearing rather than tidy. A test that
 * inherits the operator's AGENTBRIDGE_* credentials consults the real hosted
 * registry, so its result depends on who ran it — green in a shell without a
 * token and red in the shell doing the work. The ambient credentials are
 * stripped rather than overridden, and the home directory is a temp dir, so
 * nothing here can touch the operator's real ledger.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

/** Credentials that must never leak from the operator's shell into a probe. */
const AMBIENT_CREDENTIALS = [
  'AGENTBRIDGE_READER_TOKEN',
  'AGENTBRIDGE_REGISTRATION_TOKEN',
  'AGENTBRIDGE_SUPABASE_URL',
  'AGENTBRIDGE_SUPABASE_KEY',
  'AGENTBRIDGE_MCP_URL',
  'AGENTBRIDGE_REGISTER_URL',
  'AGENTBRIDGE_COORDINATOR_TOKEN',
];

function hermetic(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of AMBIENT_CREDENTIALS) delete env[k];
  return env;
}

/** The documented contract. Anything outside it is a finding. */
const DOCUMENTED_CODES = new Set([0, 1, 2, 3, 4]);
const ABORT_FLOOR = 126;

/**
 * Commands excluded from the sweep, each with the reason.
 *
 * `daemon` is excluded because running it starts one — a probe that leaves a
 * background process behind on every CI run is worse than the gap it closes.
 * It is named here rather than silently skipped so the exclusion is reviewable.
 */
const NOT_SWEPT = {
  daemon: 'starts a long-lived process; a probe must not leave one behind',
};

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: hermetic(env), cwd, windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          signal: err?.signal ?? null,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** Every name the dispatch answers to, read from the source rather than listed. */
async function dispatchedCommands() {
  const src = await readFile(fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url)), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)) names.add(m[1]);
  return [...names].sort();
}

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ab-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ── the probe can see a bad exit at all ─────────────────────────────── */

test('POSITIVE CONTROL: the probe detects an abort-range exit', async () => {
  /*
   * Without this, "no command exits 127" passes vacuously the moment the runner
   * stops observing exit codes — which is exactly the failure mode being
   * probed, one level up. A negative needs the positive first.
   */
  const bad = await new Promise((resolve) => {
    execFile(process.execPath, ['-e', 'process.exit(127)'], { windowsHide: true }, (err) =>
      resolve(err?.code ?? 0),
    );
  });
  assert.equal(bad, 127, 'the runner cannot observe exit codes; every assertion below is meaningless');
  assert.ok(bad >= ABORT_FLOOR);
  assert.equal(DOCUMENTED_CODES.has(bad), false);
});

test('POSITIVE CONTROL: a clean exit is observed as 0', async () => {
  const good = await new Promise((resolve) => {
    execFile(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true }, (err) =>
      resolve(err?.code ?? 0),
    );
  });
  assert.equal(good, 0);
});

/* ── the dispatch is visible ─────────────────────────────────────────── */

test('the dispatch is not empty — this probe can actually see the commands', async () => {
  const cmds = await dispatchedCommands();
  assert.ok(cmds.length > 10, `expected the full CLI surface, saw ${cmds.length}`);
  assert.ok(cmds.includes('register-session'), 'the command this bug came from must be in the sweep');
});

/* ── the sweep ───────────────────────────────────────────────────────── */

test('NO COMMAND EXITS IN THE ABORT RANGE', async (t) => {
  /*
   * 127 is the libuv death this generalises; 134 is SIGABRT. A command landing
   * here has crashed on its way out, whatever it printed first — which is
   * precisely the shape that walked past 655 passing tests.
   */
  const dir = await home(t);
  const cmds = (await dispatchedCommands()).filter((c) => !(c in NOT_SWEPT));
  const crashed = [];

  for (const cmd of cmds) {
    const r = await run([cmd], { AGENTBRIDGE_HOME: dir }, dir);
    if (r.code >= ABORT_FLOOR || r.signal) {
      crashed.push(`${cmd} -> code ${r.code}${r.signal ? ` signal ${r.signal}` : ''}`);
    }
  }
  assert.deepEqual(crashed, [], `commands crashed on exit:\n  ${crashed.join('\n  ')}`);
});

test('EVERY COMMAND EXITS WITH A DOCUMENTED CODE', async (t) => {
  const dir = await home(t);
  const cmds = (await dispatchedCommands()).filter((c) => !(c in NOT_SWEPT));
  const undocumented = [];

  for (const cmd of cmds) {
    const r = await run([cmd], { AGENTBRIDGE_HOME: dir }, dir);
    if (!DOCUMENTED_CODES.has(r.code)) undocumented.push(`${cmd} -> ${r.code}`);
  }
  assert.deepEqual(
    undocumented,
    [],
    `codes outside {0,1,2,3,4}:\n  ${undocumented.join('\n  ')}\n` +
      'A caller cannot branch on a code that is not in the contract.',
  );
});

test('NO COMMAND PRINTS A RUNTIME ASSERTION', async (t) => {
  /*
   * The libuv failure announces itself on stderr before dying. Checking the
   * text as well as the code catches the case where a crash is swallowed into
   * a normal-looking exit — the output was correct all through this bug, so
   * output alone proves nothing, but an assertion in it proves something.
   */
  const dir = await home(t);
  const cmds = (await dispatchedCommands()).filter((c) => !(c in NOT_SWEPT));
  const noisy = [];

  for (const cmd of cmds) {
    const r = await run([cmd], { AGENTBRIDGE_HOME: dir }, dir);
    if (/Assertion failed|UV_HANDLE_CLOSING|node:internal\/.*\bthrow\b/.test(r.stderr)) {
      noisy.push(`${cmd}: ${r.stderr.split('\n')[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(noisy, [], `runtime assertions on stderr:\n  ${noisy.join('\n  ')}`);
});

/* ── refusals are refusals, not crashes ──────────────────────────────── */

test('A REFUSAL IS 1 OR 2, NEVER 127 — the distinction this bug destroyed', async (t) => {
  /*
   * The original failure made a successful publish look like a failed command.
   * The inverse matters just as much: a command that genuinely cannot run must
   * say so with 2, not die. Both are "non-zero" to a careless caller and they
   * mean opposite things.
   */
  const dir = await home(t);
  const r = await run(['register-session'], { AGENTBRIDGE_HOME: dir }, dir);
  assert.equal(r.code, 2, 'missing required arguments is "cannot run"');
  assert.ok(r.stderr.length > 0, 'and it must say why');
  assert.doesNotMatch(r.stderr, /Assertion failed/);
});

test('an unknown command refuses with a documented code', async (t) => {
  const dir = await home(t);
  const r = await run(['no-such-command'], { AGENTBRIDGE_HOME: dir }, dir);
  assert.ok(DOCUMENTED_CODES.has(r.code), `unknown command exited ${r.code}`);
  assert.ok(r.code !== 0, 'and it must not report success');
});

/* ── the probe is hermetic ───────────────────────────────────────────── */

test('the probe strips ambient credentials rather than inheriting them', async (t) => {
  /*
   * A suite whose result depends on who ran it is not evidence. With a reader
   * token exported, commands consult the REAL hosted registry — green in one
   * shell, red in another, and silently green on a credential-free CI box while
   * failing on the machine doing the work.
   */
  const dir = await home(t);
  const env = hermetic({ AGENTBRIDGE_HOME: dir });
  for (const k of AMBIENT_CREDENTIALS) {
    assert.equal(k in env, false, `${k} leaked into the probe environment`);
  }
  assert.equal(env.AGENTBRIDGE_HOME, dir, 'and the home is redirected to a temp dir');
});

test('a command run by the probe cannot reach the operator ledger', async (t) => {
  const dir = await home(t);
  const r = await run(['delegations'], { AGENTBRIDGE_HOME: dir }, dir);
  assert.ok(DOCUMENTED_CODES.has(r.code));
  // A fresh temp home has no delegations; seeing the operator's would mean the
  // redirect failed and every other assertion here is measuring the wrong state.
  assert.doesNotMatch(r.stdout, /d-orphan-modules|d-audit-range|d-claims-authz/);
});
