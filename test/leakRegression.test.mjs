import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import { scanPayload, machineIdentity, USERNAME, HOME_DIRECTORY, HOSTNAME, ABSOLUTE_PATH, SECRET } from '../src/payloadGuard.mjs';
import { OPERATOR, SINGLE_WORD_OPERATOR, MUST_LEAK, MUST_NOT_LEAK, leakyPayload, cleanPayload } from './fixtures/leakShapes.mjs';

/**
 * EVERY SHAPE payloadGuard CLAIMS TO CATCH, PROVEN — AND EVERY SHAPE IT MUST
 * NOT, PROVEN TOO.
 *
 * payloadGuard has its own unit tests. This suite is a different job: it is the
 * REGRESSION record, the place a shape goes once it has actually leaked or once
 * somebody has argued it should. It is deliberately data-driven, so adding a
 * newly-discovered leak is one entry in test/fixtures/leakShapes.mjs and not a
 * new test somebody has to remember to write.
 *
 * NOTHING HERE IS REAL. The operator is "Jane Doe" on "DESKTOP-ABC123" and does
 * not exist. A fixture built from a genuine collected payload would commit the
 * real operator's name to the repository for ever — the exact disclosure the
 * guard exists to prevent, in the one place git never forgets. A real payload is
 * scanned at the bottom of this file, ephemerally, and nothing about it is
 * written down.
 */

const scan = (payload, identity = OPERATOR) => scanPayload(payload, identity);
const kindsFor = (value, identity = OPERATOR) =>
  scan({ field: value }, identity).leaks.map((l) => l.kind);

/* ── every MUST_LEAK shape, one test each, named by shape ────────────── */

for (const c of MUST_LEAK) {
  test(`LEAKS: ${c.what}`, () => {
    const kinds = kindsFor(c.value);
    assert.ok(kinds.length > 0, `${c.what} was published clean.\n  why it matters: ${c.why}\n  value: ${c.value.slice(0, 60)}`);
  });
}

/* ── every MUST_NOT_LEAK shape, the silent half ──────────────────────── */

for (const c of MUST_NOT_LEAK) {
  test(`CLEAN: ${c.what}`, () => {
    const kinds = kindsFor(c.value);
    assert.deepEqual(kinds, [], `${c.what} was flagged, and it is not a leak.\n  why it matters: ${c.why}\n  value: ${c.value.slice(0, 60)}`);
  });
}

/* ── the shapes are classified as the RIGHT kind, not merely flagged ─── */

test('each shape is reported as the kind a person would expect', () => {
  // "Something is wrong somewhere" is not actionable. The kind is what tells a
  // reader whether to rename a machine or rotate a credential.
  assert.ok(kindsFor('C:\\Users\\Jane Doe\\Documents\\x').includes(HOME_DIRECTORY));
  assert.ok(kindsFor('jane-win').includes(USERNAME));
  assert.ok(kindsFor('DESKTOP-ABC123').includes(HOSTNAME));
  assert.ok(kindsFor('D:\\build\\out').includes(ABSOLUTE_PATH));
  assert.ok(kindsFor(`ghp_${'a'.repeat(30)}`).includes(SECRET));
});

test('BOTH separator spellings are recognised as the HOME DIRECTORY, not merely as a name', () => {
  /*
   * The kind matters here more than anywhere else, and mutation is what showed
   * why: making pathForms return a single spelling left this whole suite green,
   * because the forward-slash path still contains "Jane Doe" and the USERNAME
   * detector fired instead. A leak was still reported, so every
   * "something was found" assertion passed — while the detector whose entire
   * job is paths had stopped seeing half of them.
   *
   * That is the separator trap one level up: not a missed leak, a MISCLASSIFIED
   * one. It would go unnoticed until a path appeared that carried no name —
   * a build directory, a temp path — at which point nothing would catch it.
   */
  assert.ok(kindsFor('C:\\Users\\Jane Doe\\Documents\\x').includes(HOME_DIRECTORY), 'backslash spelling');
  assert.ok(kindsFor('C:/Users/Jane Doe/Documents/x').includes(HOME_DIRECTORY), 'forward-slash spelling');
});

test('posix home prefixes are recognised as absolute paths in their own right', () => {
  // The detector for /home/ and /Users/ is separate from the Windows one, and
  // a payload collected on a Linux runner exercises only this half.
  assert.ok(kindsFor('/home/someone-else/src').includes(ABSOLUTE_PATH));
  assert.ok(kindsFor('/Users/someone-else/src').includes(ABSOLUTE_PATH));
  assert.ok(kindsFor('ENOENT: open /home/someone-else/.env').includes(ABSOLUTE_PATH));
});

/* ── depth: the walk, not the top level ──────────────────────────────── */

test('a leaky payload is caught at every depth it hides at', () => {
  const r = scan(leakyPayload());
  assert.equal(r.ok, false);
  // Every session carries its shape twice: once at sessions[i].worktree and
  // once at sessions[i].git.note.deeper[0].deepest, four levels down.
  const deep = r.leaks.filter((l) => l.path.includes('/deeper/0/deepest'));
  assert.equal(deep.length >= MUST_LEAK.length, true, 'the deep copies were not all found');
});

test('THE CLEAN PAYLOAD SCANS COMPLETELY CLEAN', () => {
  /*
   * The single most important assertion here. A guard that refuses everything
   * passes every leak test above and is removed from the publish path within a
   * day, after which nothing is checked at all.
   */
  const r = scan(cleanPayload());
  assert.deepEqual(r.leaks, [], `ordinary payload content was flagged:\n${r.leaks.map((l) => `  ${l.kind} ${l.path}`).join('\n')}`);
  assert.equal(r.ok, true);
});

/* ── a single-word operator, where whole and part coincide ───────────── */

test('a single-word username is caught in a home path and in a derived label', () => {
  assert.ok(kindsFor('C:\\Users\\jdoe\\src', SINGLE_WORD_OPERATOR).includes(HOME_DIRECTORY));
  assert.ok(kindsFor('jdoe-laptop', SINGLE_WORD_OPERATOR).includes(USERNAME));
});

test('KNOWN GAP: a SHORT single-word username matches inside unrelated words', () => {
  /*
   * CHARACTERISATION, NOT APPROVAL — the second of two known gaps, and the
   * mirror image of the 8.3 one: that gap misses a leak, this one invents one.
   *
   * The name is searched for twice, with different rules. PARTS require a
   * boundary, so "doe" does not match "doesn't". The WHOLE name does not,
   * deliberately: a multi-word name like "Jane Doe" is distinctive enough that
   * an unbounded match is safe, and it is the only thing that catches the name
   * buried inside a longer token ("abcJane Doexyz"), which payloadGuard has a
   * test for.
   *
   * For a SINGLE-WORD username those two rules collapse into one, and the
   * unbounded form is all that is left. "jdoe" therefore matches
   * "jdoexyz-unrelated". A more realistic version of the same thing: an
   * operator called "sam" flags "samples", "same" and "sample-rate" — and
   * MIN_NAME is 3, so "sam" qualifies.
   *
   * Nothing leaks because of this; the cost is noise, and noise is how a guard
   * gets switched off. The fix is to require a boundary when the username has
   * no separator, which is inside payloadGuard and outside this delegation.
   *
   * WHEN FIXED, this test fails. Change it to assert [] and move on; do not
   * delete it.
   */
  const kinds = kindsFor('jdoexyz-unrelated', SINGLE_WORD_OPERATOR);
  assert.deepEqual(kinds, [USERNAME], 'GAP CLOSED? assert [] here and say so in the handoff');
});

/* ── the sample never republishes what it found ──────────────────────── */

test('no leak report contains the operator name in the clear', () => {
  const r = scan(leakyPayload());
  const rendered = JSON.stringify(r.leaks);
  assert.doesNotMatch(rendered, /Jane Doe/);
  assert.doesNotMatch(rendered, /DESKTOP-ABC123/);
});

test('no leak report contains a usable credential', () => {
  const r = scan({ t: `ghp_${'a'.repeat(30)}` });
  assert.doesNotMatch(JSON.stringify(r.leaks), new RegExp('a'.repeat(20)));
});

/* ── KNOWN GAP: the 8.3 short name ───────────────────────────────────── */

test('KNOWN GAP: a home path in its 8.3 alias is NOT recognised as identity', () => {
  /*
   * CHARACTERISATION, NOT APPROVAL. This asserts what the guard does today so
   * that fixing it fails this test loudly rather than passing unnoticed.
   *
   * Windows gives one directory two names. On the machine this was found on:
   *
   *   os.homedir()  C:\Users\JANE DOE
   *   os.tmpdir()   C:\Users\JANEDO~1\AppData\Local\Temp
   *   realpathSync.native() resolves BOTH to the same directory
   *
   * The 8.3 form contains no part of the long username, so the username and
   * home-directory detectors both miss it. It is caught ONLY as a generic
   * absolute path — which is a real catch and is why nothing shipped, but it
   * means the classification is wrong and a field that is not a path would
   * escape entirely.
   *
   * This is the separator trap in different clothes: one directory, two
   * spellings, and the guard knows one of them.
   *
   * WHEN THIS IS FIXED (payloadGuard resolving identity paths through
   * realpathSync.native and searching both spellings) this test will fail.
   * Change the assertion to HOME_DIRECTORY at that point; do not delete it.
   */
  const shortForm = 'C:\\Users\\JANEDO~1\\AppData\\Local\\Temp\\ab-e2e-1a2b3c\\code-a';
  const kinds = kindsFor(shortForm);

  assert.ok(kinds.includes(ABSOLUTE_PATH), 'the absolute-path detector is the only thing standing between this and publication');
  assert.equal(kinds.includes(HOME_DIRECTORY), false, 'GAP CLOSED? change this assertion to true and move the case into MUST_LEAK');
  assert.equal(kinds.includes(USERNAME), false, 'GAP CLOSED? as above');
});

/* ── a real payload: scanned, never written down ─────────────────────── */

test('a REAL collected payload is scanned ephemerally and never becomes a fixture', (t) => {
  /*
   * The point of scanning a real payload is that synthetic data only proves the
   * guard catches what somebody already thought of. The real one is the only
   * sample that can carry a shape nobody predicted.
   *
   * It is read from a temp file if the harness left one, held in memory, and
   * NEVER written into this repository. Only counts and kinds are asserted; no
   * value from it is printed, because a failure message is a thing people paste
   * into chat.
   */
  const candidate = process.env['AGENTBRIDGE_REAL_PAYLOAD'];
  if (!candidate || !fs.existsSync(candidate)) {
    return t.skip('no real payload offered via AGENTBRIDGE_REAL_PAYLOAD; synthetic coverage above still applies');
  }
  const payload = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  const r = scanPayload(payload, machineIdentity());
  assert.equal(
    r.ok,
    true,
    `the real payload carries ${r.leaks.length} leak(s): ${r.leaks.map((l) => `${l.kind} at ${l.path}`).join(', ')}`,
  );
});

/**
 * Does `text` name the machine described by `identity`? Returns the offending
 * value, or null.
 *
 * A HOMEDIR AND A HOSTNAME ARE ALREADY IDENTITY-SHAPED — `/home/jane`,
 * `DESKTOP-ABC123` — so a bare substring is the right question for them.
 *
 * A USERNAME IS JUST A WORD, AND THAT IS WHAT BROKE THIS. On a GitHub runner
 * `os.userInfo().username` is `runner`, and leakShapes.mjs contains the line
 * "the runner finished in 4s" — deliberate English prose, the baseline entry
 * proving that clean text scans clean. Matching the username as a bare
 * substring turned that into a failure, so this test was red on a repository
 * with nothing wrong with it, and would be on any clean machine whose operator
 * is called runner, admin, build, ci or root.
 *
 * It went unseen for the same reason it was hard to diagnose: nobody had run
 * this suite anywhere but their own desktop, where the username is a name
 * nobody writes in a sentence.
 *
 * A gate that fires for a correct repo is worse than no gate — it is the one
 * people learn to skip, and then the real red goes unread too. So a username
 * counts only where it IDENTIFIES somebody: after a path separator or a `~`,
 * or on either side of an `@`. Never inside a sentence.
 */
function namesMachine(text, identity) {
  const hay = String(text).toLowerCase();

  for (const needle of [identity.homedir, identity.hostname]) {
    if (needle && needle.length >= 3 && hay.includes(needle.toLowerCase())) return needle;
  }

  const user = identity.username;
  if (user && user.length >= 3) {
    const u = user.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /*
     * A USERNAME IDENTIFIES SOMEBODY WHERE IT OWNS A HOME OR AN ACCOUNT, NOT
     * AFTER ANY SEPARATOR AT ALL.
     *
     * Matching after any slash or backslash reddened a clean checkout for an
     * operator called node, work or deploy, because the repo's own vocabulary
     * contains those path segments: the nodejs executable path in argv.mjs, the
     * /work/ab containment examples in workspaceManager, and two docs headings.
     * Six files across three names, none of them anybody's home directory.
     *
     * That is the same failure this matcher was narrowed for once already, when
     * it read the CI account name out of ordinary prose: a gate that fires on a
     * correct repo is the one people learn to skip, and then the real red goes
     * unread too.
     *
     * So the separator has to be a HOME prefix, /home/u or Users\u, or a tilde,
     * or an account form on either side of an @. The tilde excludes a doubled
     * one: markdown strikethrough is not a home directory and was matching as
     * one.
     */
    const owns = new RegExp(
      `(?:home|users)[/\\\\]${u}(?![a-z0-9_-])`
      + `|(?<!~)~${u}(?![a-z0-9_-])`
      + `|(?<![a-z0-9_-])${u}@`
      + `|@${u}(?![a-z0-9_-])`,
    );
    if (owns.test(hay)) return user;
  }

  return null;
}

test('the identity matcher fires on a real leak and stays quiet on prose', () => {
  /*
   * THE POSITIVE CONTROL, WITHOUT WHICH THE ASSERTION BELOW PROVES NOTHING.
   * "The fixtures do not name me" passes trivially against a matcher that
   * never matches anything — and a matcher that was just narrowed is exactly
   * where that would hide. So it is shown to fire BEFORE it is trusted to
   * stay quiet.
   */
  const me = { username: 'runner', hostname: 'DESKTOP-ABC123', homedir: '/home/runner' };

  for (const leak of [
    'path: /home/runner/work/x',
    'path: C:\\Users\\runner\\AppData',
    'from: runner@build-01',
    'home: ~runner/.ssh',
    'host DESKTOP-ABC123 reported',
  ]) {
    assert.notEqual(namesMachine(leak, me), null, `should have been flagged: ${leak}`);
  }

  /*
   * A SEPARATOR IS NOT OWNERSHIP. Each of these is a real line from the six
   * files that reddened a clean checkout for an operator named node, work or
   * deploy: the repo's own vocabulary, not anybody's home directory.
   */
  for (const [name, clean] of [
    ['node', 'spawn "C:\\Program Files\\nodejs\\node.exe" with args'],
    ['work', 'isInside("/work/ab", "/work/ab-evil") is false'],
    ['deploy', '0. ~~Deploy the edge function.~~ done'],
  ]) {
    assert.equal(
      namesMachine(clean, { username: name, hostname: '', homedir: '' }),
      null,
      `a path segment was read as ownership by "${name}": ${clean}`,
    );
  }

  // The username alone, in prose. This is the case that was failing CI.
  const wordOnly = { username: 'runner', hostname: '', homedir: '' };
  for (const clean of [
    'the runner finished in 4s',
    'a test runner, not a person',
    'runners up were not recorded',
  ]) {
    assert.equal(namesMachine(clean, wordOnly), null, `should NOT have been flagged: ${clean}`);
  }
});

/*
 * WHICH FILES ARE SCANNED, AND WHY NOT ALL OF THEM.
 *
 * This check read leakShapes.mjs and nothing else, on the reasonable theory
 * that a pasted payload lands in a fixture. The disclosure it missed was
 * somewhere else entirely: the operator's real home directory, and its real 8.3
 * alias, written into a comment in THIS file, plus the same path in src/redact
 * and src/collect and a worktree convention in docs. None of it was a pasted
 * payload. All of it was somebody documenting a bug accurately, which is the
 * normal way a real path gets committed and is not going to stop happening.
 *
 * So src and docs are scanned too. test/ is NOT, and the reason is load-bearing
 * rather than laziness: the controls for this very guard must contain
 * identity-shaped strings. leakRegression.test.mjs carries /home/runner and
 * DESKTOP-ABC123 as the positive control for the runner fix, and three /root
 * paths live elsewhere under test/. Scanning test/ would therefore be red on
 * every GitHub runner and on any container running as root -- the exact failure
 * this guard has just been fixed for, reintroduced one directory over. Measured,
 * not assumed.
 *
 * THE COST IS NAMED: a real path committed into a test file outside this one is
 * still not caught. The fix for that is a marker comment exempting control lines
 * so the scan can cover everything, and it is a bigger change than this one.
 */
function scannedFiles() {
  const files = [new URL('./fixtures/leakShapes.mjs', import.meta.url)];
  for (const dir of ['src', 'docs']) {
    const base = new URL(`../${dir}/`, import.meta.url);
    for (const name of fs.readdirSync(base, { recursive: true })) {
      if (/\.(mjs|js|md)$/.test(name)) files.push(new URL(name.split(/[\\/]/).join('/'), base));
    }
  }
  return files;
}

test('this suite committed no real identity: the tree names nobody on this machine', () => {
  /*
   * The guard on the guard. If somebody ever pastes a real payload, or writes a
   * real path into a comment, this fails on the machine it came from -- which is
   * the machine whose owner would be disclosed.
   */
  const me = machineIdentity();
  // The 8.3 alias of the home directory, which is the spelling that slips in
  // through a copied temp path and contains no part of the long name.
  const short = os.tmpdir().split(/[\\/]/).find((seg) => seg.includes('~'));

  for (const file of scannedFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const where = file.pathname.split('/').slice(-2).join('/');
    const hit = namesMachine(text, me);
    assert.equal(hit, null, `a real identity value is committed in ${where}: ${hit}`);
    if (short) {
      assert.equal(text.toLowerCase().includes(short.toLowerCase()), false, `a real 8.3 identity segment is committed in ${where}`);
    }
  }
});

test('CONTROL: the widened scan really does reach src and docs', () => {
  /*
   * Without this, deleting a directory from scannedFiles leaves the test above
   * green, and a check that scans fewer files than it claims is the hollow kind:
   * it passes because it looked nowhere, and reads exactly like it passed
   * because there was nothing to find.
   */
  const names = scannedFiles().map((u) => u.pathname);
  assert.ok(names.some((n) => n.endsWith('fixtures/leakShapes.mjs')), 'the fixture must be scanned');
  assert.ok(names.some((n) => n.includes('/src/redact.mjs')), 'src must be scanned -- it held a real home path');
  assert.ok(names.some((n) => n.includes('/docs/')), 'docs must be scanned -- it held the worktree convention');
  assert.ok(names.length > 20, `expected the scan to reach the whole of src and docs, got ${names.length} files`);
});

test('CONTROL: a real path in a scanned file IS caught, for each identity field', () => {
  /*
   * The scan above passes trivially against a matcher that matches nothing. This
   * fires it first. The identities are invented; the shapes are the real ones
   * that were actually committed -- a Windows home in a comment, an 8.3 alias,
   * a hostname.
   */
  const jane = { username: 'Jane Doe', hostname: 'DESKTOP-ZZQQXX', homedir: 'C:\\Users\\JANE DOE' };
  assert.equal(namesMachine(' *   os.homedir()  C:\\Users\\JANE DOE', jane), 'C:\\Users\\JANE DOE');
  assert.equal(namesMachine('reported by DESKTOP-ZZQQXX at noon', jane), 'DESKTOP-ZZQQXX');
  assert.equal(namesMachine('nothing identifying in this sentence at all', jane), null);
});
