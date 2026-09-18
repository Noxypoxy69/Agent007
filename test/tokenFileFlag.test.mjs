/**
 * --token-file: the flag that lets a GUARDED session present a credential.
 *
 * WHY THIS EXISTS. A guarded session cannot put anything in its own
 * environment. The shell rail refuses `export FOO=bar`, refuses a leading
 * `FOO=bar node ...`, and refuses `$(cat f)` as a metacharacter -- all three
 * correctly. The effect was that every guarded agent registered LOCAL-ONLY,
 * invisible to every other machine, WHILE EXITING 0. The repair was the
 * operator typing the secret into each session by hand.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE, because it is deliberately not built:
 * there is NO well-known default path. An earlier draft read
 * <AGENTBRIDGE_HOME>/registration-token when the flag was absent, which would
 * mean any code reaching registrationConfig() silently acquires a live
 * credential nobody handed it. The token arrives named on a command line or not
 * at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTokenFile, envWithTokenFile, TOKEN_FILE_MAX_BYTES } from '../src/tokenFile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'bin', 'agentbridge.mjs');

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ab-tokenfile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------------------------ */
/* readTokenFile                                                       */
/* ------------------------------------------------------------------ */

test('an absent file is not a problem — an unconfigured machine is normal', async (t) => {
  const dir = await tmp(t);
  const r = readTokenFile(join(dir, 'nope.txt'));
  assert.equal(r.token, '');
  assert.equal(r.problem, null);
});

test('a plain token reads back exactly', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_deadbeef');
  assert.deepEqual(readTokenFile(f), { token: 'abw_deadbeef', problem: null });
});

test('a trailing CRLF is trimmed — this is the entire Windows case', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_deadbeef' + CR + LF);
  const r = readTokenFile(f);
  assert.equal(r.problem, null);
  assert.equal(r.token, 'abw_deadbeef');
  // Assert the BYTE is gone, not merely that the string looks right: a token
  // carrying a stray CR fails auth with a 401, which this codebase reports as
  // REJECTED -- i.e. the agent is told its good credential was refused.
  assert.ok(!r.token.includes(CR), 'carriage return survived the trim');
  assert.ok(!r.token.includes(LF), 'line feed survived the trim');
});

test('leading and trailing whitespace is trimmed', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, '   abw_x   ' + LF + LF);
  assert.equal(readTokenFile(f).token, 'abw_x');
});

test('an empty or whitespace-only file is a PROBLEM, not an absence', async (t) => {
  const dir = await tmp(t);
  for (const [name, content] of [['empty', ''], ['spaces', '  ' + LF + ' ']]) {
    const f = join(dir, name);
    await writeFile(f, content);
    const r = readTokenFile(f);
    assert.equal(r.token, '');
    assert.equal(r.problem, 'is empty', `${name}: expected a problem, got ${r.problem}`);
  }
});

test('a multi-line file is refused rather than silently taking line one', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_real' + LF + '# a comment somebody added' + LF);
  const r = readTokenFile(f);
  assert.equal(r.token, '');
  assert.match(r.problem, /more than one line/);
});

test('the problem text never contains the token value', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  const SECRET = 'abw_SUPERSECRETVALUE';
  await writeFile(f, SECRET + LF + 'second line');
  const r = readTokenFile(f);
  assert.ok(r.problem, 'expected a problem');
  assert.ok(!r.problem.includes(SECRET), `problem text leaked the token: ${r.problem}`);
  assert.ok(!r.problem.includes('SUPERSECRET'), `problem text leaked part of the token: ${r.problem}`);
});

test('a byte that cannot appear in a header is refused, and NEVER echoed', async (t) => {
  /*
   * Refusing CR and LF was not enough. undici rejects a NUL in a header value
   * and puts THE WHOLE VALUE in the error message, which the CLI prints:
   *
   *   hosted UNREACHABLE (Headers.append: "Bearer <the entire token>" is an
   *   invalid header value.) -- registered LOCALLY ONLY
   *
   * NEW reachability rather than an old leak: a Windows environment variable
   * cannot contain a NUL, so before the file route the value could not reach
   * that code path. Found by blind audit on the commit that added the flag,
   * whose message claimed "the value never appears in an error string" -- true
   * of this module's own strings, false end to end.
   */
  const dir = await tmp(t);
  const SECRET = 'SECRETTOKEN_abc123';
  const NUL = String.fromCharCode(0);

  const cases = [
    ['nul-suffix', SECRET + NUL + 'x'],
    // What [IO.File]::WriteAllText with UnicodeEncoding(false,false) produces.
    ['utf16le-ish', [...SECRET].map((c) => c + NUL).join('')],
    ['tab', SECRET.slice(0, 5) + String.fromCharCode(9) + SECRET.slice(5)],
    ['non-ascii', `${SECRET}\u2014`],
    ['inner-space', 'SECRET TOKEN'],
  ];

  for (const [name, content] of cases) {
    const f = join(dir, name);
    await writeFile(f, content);
    const r = readTokenFile(f);
    assert.equal(r.token, '', `${name}: must not yield a token`);
    assert.ok(r.problem, `${name}: must report a problem`);
    // The position may be named. The value may not, in any form.
    const problemWithoutNuls = r.problem.split(NUL).join('');
    assert.ok(!problemWithoutNuls.includes('SECRET'),
      `${name}: the problem text leaked the token: ${r.problem}`);
  }

  // RULE 5: the positive. A well-formed token of the same shape still works, or
  // this is just a test that everything is refused.
  const good = join(dir, 'good');
  await writeFile(good, SECRET);
  assert.deepEqual(readTokenFile(good), { token: SECRET, problem: null });
});

test('an oversized file is refused — it would go into an Authorization header', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'big');
  await writeFile(f, 'x'.repeat(TOKEN_FILE_MAX_BYTES + 1));
  const r = readTokenFile(f);
  assert.equal(r.token, '');
  assert.match(r.problem, /larger than/);
});

test('a file exactly at the cap is still accepted — the bound is not off by one', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'atcap');
  await writeFile(f, 'x'.repeat(TOKEN_FILE_MAX_BYTES));
  const r = readTokenFile(f);
  assert.equal(r.problem, null);
  assert.equal(r.token.length, TOKEN_FILE_MAX_BYTES);
});

test('a directory is a problem, not an absence', async (t) => {
  const dir = await tmp(t);
  const d = join(dir, 'adir');
  await mkdir(d);
  const r = readTokenFile(d);
  assert.equal(r.token, '');
  assert.ok(r.problem, 'a directory should report a problem');
});

/* ------------------------------------------------------------------ */
/* envWithTokenFile                                                    */
/* ------------------------------------------------------------------ */

test('no flag leaves the env untouched and reports no error', () => {
  const base = { A: '1' };
  const r = envWithTokenFile(base, undefined);
  assert.equal(r.error, null);
  assert.equal(r.env, base);
});

test('a bare --token-file is a usage error, not a missing file', () => {
  // parseArgs turns a valueless flag into `true`.
  const r = envWithTokenFile({}, true);
  assert.equal(r.error, '--token-file needs a path');
});

test('a named file that does not exist is FATAL, not a quiet local-only fallback', async (t) => {
  const dir = await tmp(t);
  const r = envWithTokenFile({}, join(dir, 'absent'));
  assert.ok(r.error, 'a named-but-absent file must be an error');
  assert.match(r.error, /no such file/);
  assert.equal(r.env.AGENTBRIDGE_REGISTRATION_TOKEN, undefined);
});

test('a good file populates the variable without mutating the base env', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_fromfile' + CR + LF);
  const base = { EXISTING: 'kept' };
  const r = envWithTokenFile(base, f);
  assert.equal(r.error, null);
  assert.equal(r.env.AGENTBRIDGE_REGISTRATION_TOKEN, 'abw_fromfile');
  assert.equal(r.env.EXISTING, 'kept');
  assert.equal(base.AGENTBRIDGE_REGISTRATION_TOKEN, undefined, 'base env was mutated');
});

test('the flag BEATS an inherited environment variable', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_fromfile');
  const r = envWithTokenFile({ AGENTBRIDGE_REGISTRATION_TOKEN: 'abw_fromenv' }, f);
  assert.equal(r.env.AGENTBRIDGE_REGISTRATION_TOKEN, 'abw_fromfile');
});

/* ------------------------------------------------------------------ */
/* The far end: does the token reach the WIRE?                         */
/* ------------------------------------------------------------------ */

/**
 * RULE 4: NEVER ASSERT ON A PROXY. Every test above checks a config object.
 * A config object is a proxy for the credential actually being presented, and
 * the whole defect being fixed is a token that was configured and never sent.
 * So this one stands up a server and reads the Authorization header off the
 * request, which is the far end.
 */
async function captureRegistration(t, extraArgs, env) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? null, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));

  const home = await mkdtemp(join(tmpdir(), 'ab-tf-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CLI, 'register-session',
      '--agent', 'tokenfile-probe',
      '--session', 'sess-probe',
      '--lane', 'probe',
      '--capacity', 'idle',
      ...extraArgs,
    ], {
      cwd: join(here, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTBRIDGE_HOME: home,
        AGENTBRIDGE_REGISTER_URL: `http://127.0.0.1:${port}/register`,
        AGENTBRIDGE_REGISTRATION_TOKEN: '',
        ...env,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });

  return { seen, ...res };
}

test('--token-file puts the token on the wire', async (t) => {
  const dir = await tmp(t);
  const f = join(dir, 'tok');
  await writeFile(f, 'abw_onthewire' + CR + LF);

  const { seen, code, out, err } = await captureRegistration(t, ['--token-file', f], {});

  assert.ok(seen.length > 0, `the server was never called. exit=${code} out=${out} err=${err}`);
  assert.equal(seen[0].auth, 'Bearer abw_onthewire',
    `wrong Authorization header: ${seen[0].auth}. exit=${code} err=${err}`);
});

test('without the flag and without an env token, nothing is published', async (t) => {
  // The POSITIVE before the negative (rule 5): the test above proves the probe
  // CAN observe a registration, so an empty `seen` here means "did not publish"
  // rather than "the harness never worked".
  const { seen } = await captureRegistration(t, [], {});
  assert.equal(seen.length, 0, 'a session with no credential published anyway');
});

/* ------------------------------------------------------------------ */
/* Structural: no command may quietly opt out of the flag              */
/* ------------------------------------------------------------------ */

/**
 * RULE 17-ish, applied forward. The flag is folded into ONE env bag at the top
 * of the CLI. A future call site written as `f(process.env, ...)` would compile,
 * pass review, and produce a command where --token-file is accepted on the
 * command line and silently does nothing -- which is worse than not having the
 * flag, because the operator has been told it applied.
 *
 * So the shape is gated rather than the vocabulary: process.env may not be
 * passed as an env BAG anywhere in the CLI except the single line that creates
 * ENV. Reading one variable (process.env.AGENTBRIDGE_VERIFY_CMD) is untouched.
 */
/**
 * Blank out comment BODIES, preserving length and newlines so offsets and line
 * numbers stay correct.
 *
 * CLAUDE.md hollow gate 13: a check that greps for a token matches its own
 * explanatory comment. Three independent rediscoveries in this repository, and
 * this test made it a fourth -- the moment it was tightened to match the
 * property, it flagged lines 216 and 221 of bin/agentbridge.mjs, which are the
 * PROSE explaining why call sites must not read process.env.
 *
 * Known limitation, stated rather than hidden: a "//" inside a string literal
 * (a URL) is treated as a line comment, so anything after it on that line is
 * invisible to the scan. That direction under-reports, so it is worth knowing;
 * a real parse would be better if this ever guards something subtler.
 */
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

test('no CLI call site passes process.env as an env bag', async () => {
  const raw = await readFile(CLI, 'utf8');
  const src = blankComments(raw);
  const SANCTIONED = 'envWithTokenFile(process.env, ';

  const sanctioned = src.split(SANCTIONED).length - 1;
  assert.equal(sanctioned, 1,
    `expected exactly one place that reads process.env into ENV, found ${sanctioned}`);

  /*
   * MATCH THE PROPERTY, NOT ONE SPELLING. This scanned for "(process.env" and
   * an auditor walked three plausible future call sites straight past it, each
   * landed in the file and each leaving the suite at 18/18:
   *
   *   fetchHostedRegistrations({ ...process.env })
   *   const RAWENV = process.env; ... fetchHostedRegistrations(RAWENV)
   *   fetchHostedRegistrations(0 || process.env)
   *
   * It also could not see process.env in any argument position but the first.
   * Every one of those accepts --token-file and silently ignores it, which is
   * worse than not having the flag because the operator has been told it applied.
   *
   * The property is simpler than any of those spellings: the env BAG may not be
   * referenced at all outside the one line that builds ENV. Reading a single
   * variable -- process.env.AGENTBRIDGE_VERIFY_CMD -- is a different thing and
   * stays allowed, so the test is "process.env NOT followed by a property
   * access". That catches a spread, an alias, a boolean-or and any argument
   * position, because none of them can avoid naming it.
   */
  const offenders = [];
  for (const m of src.matchAll(/process\.env(?!\s*\.)/g)) {
    const isSanctioned = src.startsWith(SANCTIONED, m.index - 'envWithTokenFile('.length);
    if (isSanctioned) continue;
    offenders.push(src.slice(0, m.index).split(LF).length);
  }
  assert.deepEqual(offenders, [],
    `these lines pass process.env as an env bag and so ignore --token-file: ${offenders.join(', ')}`);
});
