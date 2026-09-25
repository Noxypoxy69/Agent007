import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * REGRESSION GATE FOR 8d71f6d.
 *
 * One writeSnapshot call in test/claudeGuard.test.mjs ran before any
 * AGENTBRIDGE_HOME was set, so snapshotPath fell back to <homedir>/.agentbridge
 * and a fixture snapshot landed in the operator's live guard-sessions store on
 * every run. 8d71f6d moved the isolation line above the call. Nothing went red
 * when it was missing, because every suite run that could have noticed already
 * had AGENTBRIDGE_HOME set -- and with it set, the defect cannot occur.
 *
 * WHAT THIS GATE CHECKS, EXACTLY, AND NOTHING MORE.
 * It runs the REAL test/claudeGuard.test.mjs in a child with AGENTBRIDGE_*
 * removed and exactly these environment variables redirected into one empty
 * temp directory (every case spelling of each removed first, because Windows
 * env names are case-insensitive):
 *
 * REDIRECTED (pinned): USERPROFILE HOME HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
 *
 * and it asserts, as an END-STATE TREE DIFF, that after the child exits that
 * directory holds exactly the skeleton the gate created. Through USERPROFILE
 * and HOME that also covers os.homedir(), which the precondition asserts.
 * The line above is PINNED: the first test in this file fails if it differs
 * from the set the code redirects, so the claim cannot drift from the code.
 *
 * OUT OF SCOPE, stated so nobody reads more into a green run than it proves:
 *   - OneDrive (%OneDrive%, %OneDriveConsumer%, %OneDriveCommercial%) and
 *     every other home-valued environment variable NOT on the pinned line;
 *   - os.userInfo().homedir, which reads the account database, not the env;
 *   - TEMP/TMP: the target writes its fixtures there legitimately (every
 *     repoFixture() and guard-home- store is an mkdtemp in os.tmpdir()), so a
 *     leak there cannot be told from a fixture; on a real Windows profile the
 *     temp dir sits under LOCALAPPDATA;
 *   - hard-coded absolute paths that name no variable;
 *   - write-then-delete: a file written and removed before the child exits
 *     leaves no end state for the diff to see.
 * This scope was set after two blind verifies (T-333, T-336) each found a
 * further home route; the Controller ruled the property unbounded and pinned
 * the claim to what is checked instead of chasing routes (T-338 rule of two).
 *
 * Preconditions are ASSERTED, not guarded on:
 *   - in the child, os.homedir(), snapshotPath(), HOMEDRIVE+HOMEPATH and every
 *     other redirected variable resolve INSIDE the fake home;
 *   - the child ran every top-level test in the file (count against a static
 *     count), failed none, and the test that holds the fixed call passed.
 * APPDATA / LOCALAPPDATA / XDG dirs are CREATED before the run, as they exist
 * on a real profile: a write into a missing directory throws, and the leak
 * would read as a failing claudeGuard test instead of as a leak.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const TARGET = 'test/claudeGuard.test.mjs';
const FIXED_TEST = 'a test created during the session stays editable; a baseline test does not';

// name -> location relative to the fake home ('' = the home itself). HOMEDRIVE/HOMEPATH are derived in childEnv.
const HOME_VARS = Object.freeze({
  USERPROFILE: '',
  HOME: '',
  APPDATA: 'AppData/Roaming',
  LOCALAPPDATA: 'AppData/Local',
  XDG_CONFIG_HOME: '.config',
  XDG_DATA_HOME: '.local/share',
  XDG_STATE_HOME: '.local/state',
  XDG_CACHE_HOME: '.cache',
});
const REDIRECTED = [...Object.keys(HOME_VARS), 'HOMEDRIVE', 'HOMEPATH'];

function childEnv(home) {
  const env = {};
  const drop = new RegExp(`^(NODE_TEST|AGENTBRIDGE|GIT_)|^(${REDIRECTED.join('|')})$`, 'i');
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.test(k)) continue;   // NODE_TEST_CONTEXT would swallow the TAP summary; case variants of redirected names
    env[k] = v;
  }
  for (const [k, rel] of Object.entries(HOME_VARS)) env[k] = rel ? path.join(home, rel) : home;
  const root = path.parse(home).root;                        // 'C:\\' on Windows, '/' elsewhere
  env.HOMEDRIVE = root.replace(/[\\/]+$/, '');               // 'C:' (or '' on POSIX)
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length);           // '\\Users\\...\\guard-fake-home-x'
  env.NO_COLOR = '1';
  return env;
}

const walk = (d) => (existsSync(d)
  ? readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? [p, ...walk(p)] : [p];
  })
  : []);

const inside = (home, p) => {
  const rel = path.relative(home, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

test('the header\'s pinned REDIRECTED list is exactly the set this gate redirects', () => {
  const lines = readFileSync(SELF, 'utf8').split(/\r?\n/).filter((l) => /^ \* REDIRECTED \(pinned\):/.test(l));
  assert.equal(lines.length, 1, 'exactly one pinned REDIRECTED line in the header');
  const claimed = lines[0].replace(/^ \* REDIRECTED \(pinned\):/, '').trim().split(/\s+/).filter(Boolean);
  assert.ok(claimed.length > 0, 'the pinned list is not empty');
  assert.equal(new Set(claimed).size, claimed.length, 'the pinned list has no duplicates');
  assert.deepEqual([...claimed].sort(), [...REDIRECTED].sort(),
    `header pin drifted from the code: header ${JSON.stringify(claimed)} vs code ${JSON.stringify(REDIRECTED)}`);
  // And REDIRECTED is what childEnv really does: every name is set, and nothing else points into the fake home.
  const pinHome = mkdtempSync(path.join(tmpdir(), 'guard-pin-'));
  try {
    const probeEnv = childEnv(pinHome);
    const intoHome = Object.keys(probeEnv).filter((k) => k !== 'HOMEDRIVE' && typeof probeEnv[k] === 'string'
      && probeEnv[k] !== '' && inside(pinHome, path.resolve(k === 'HOMEPATH' ? probeEnv.HOMEDRIVE + probeEnv.HOMEPATH : probeEnv[k])));
    assert.deepEqual([...intoHome, 'HOMEDRIVE'].sort(), [...REDIRECTED].sort(),
      `childEnv points ${JSON.stringify(intoHome)} (+HOMEDRIVE) into the fake home, but REDIRECTED is ${JSON.stringify(REDIRECTED)}`);
    assert.equal(typeof probeEnv.HOMEDRIVE, 'string', 'HOMEDRIVE is set by childEnv');
  } finally {
    rmSync(pinHome, { recursive: true, force: true });
  }
});

test('claudeGuard.test.mjs leaves no new path under the pinned REDIRECTED variables or os.homedir() (end-state tree diff) when AGENTBRIDGE_HOME is unset', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'guard-fake-home-'));
  try {
    const env = childEnv(home);
    assert.equal(Object.keys(env).some((k) => /^AGENTBRIDGE/i.test(k)), false, 'AGENTBRIDGE_* must be absent in the child');
    for (const k of REDIRECTED) {
      assert.equal(Object.keys(env).filter((x) => x.toUpperCase() === k).length, 1, `exactly one spelling of ${k} in the child env`);
    }
    for (const rel of Object.values(HOME_VARS)) if (rel) mkdirSync(path.join(home, rel), { recursive: true });
    const skeleton = walk(home).map((p) => path.relative(home, p)).sort();

    // PRECONDITION: every redirected road, as the CHILD sees it, ends inside the fake home.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { snapshotPath } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'guardSession.mjs')).href)};`
      + " import { homedir } from 'node:os';"
      + ` const e = process.env; const vars = ${JSON.stringify(Object.keys(HOME_VARS))};`
      + ` process.stdout.write(JSON.stringify({ homedir: homedir(), snapshot: snapshotPath(${JSON.stringify(ROOT)}, 'sess-1'),`
      + ' homedrivepath: (e.HOMEDRIVE ?? "") + (e.HOMEPATH ?? ""), vars: Object.fromEntries(vars.map((k) => [k, e[k] ?? null])) }));',
    ], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, `probe failed: ${probe.stderr}`);
    const seen = JSON.parse(probe.stdout);
    const roads = { homedir: seen.homedir, snapshotPath: seen.snapshot, 'HOMEDRIVE+HOMEPATH': seen.homedrivepath, ...seen.vars };
    assert.equal(Object.keys(roads).length, Object.keys(HOME_VARS).length + 3, 'every road was probed');
    for (const [k, v] of Object.entries(roads)) {
      assert.ok(typeof v === 'string' && v !== '' && inside(home, v), `in the child, ${k} must resolve inside the fake home, got ${v}`);
    }

    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TARGET], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    });
    const out = r.stdout ?? '';
    const num = (k) => { const m = out.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
    const expected = (readFileSync(path.join(ROOT, TARGET), 'utf8').match(/^test(\.\w+)?\(/gm) ?? []).length;
    assert.ok(expected > 0, 'static count of top-level tests must be positive');
    assert.equal(num('tests'), expected, `the child must run every top-level test in ${TARGET}\n${out.slice(-2000)}`);
    assert.equal(num('fail'), 0, `${TARGET} must pass in the child\n${out.slice(-2000)}`);
    assert.equal(r.status, 0, `child exit\n${r.stderr}`);
    const okLine = out.split(/\r?\n/).some((l) => /^ok \d+ - /.test(l) && l.replace(/^ok \d+ - /, '').trim() === FIXED_TEST);
    assert.ok(okLine, `the test holding the fixed writeSnapshot call must have run and passed: "${FIXED_TEST}"`);

    // THE PROPERTY: end state of the fake home is exactly the skeleton this gate made.
    const after = walk(home).map((p) => path.relative(home, p)).sort();
    const landed = after.filter((p) => !skeleton.includes(p));
    const vanished = skeleton.filter((p) => !after.includes(p));
    assert.deepEqual({ landed, vanished }, { landed: [], vanished: [] },
      `${TARGET} left ${landed.length} new path(s) under the redirected home variables: ${JSON.stringify(landed)}; removed ${vanished.length}: ${JSON.stringify(vanished)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
