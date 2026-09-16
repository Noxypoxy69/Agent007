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
   *   os.homedir()  C:\Users\DANNY GARCIA
   *   os.tmpdir()   C:\Users\DANNYG~1\AppData\Local\Temp
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

/*
 * A SERVICE ACCOUNT IS NOT SOMEBODY, and that distinction is the fix for a CI
 * failure that stayed anonymous for a day.
 *
 * The check below asks whether this machine's identity is sitting in the
 * committed fixtures. It asked with a bare substring search for the username,
 * and on every GitHub-hosted runner the username is `runner` -- a word that
 * appears in leakShapes.mjs as `the runner finished in 4s`, whose entire job is
 * to be the baseline proving that ordinary prose scans clean. The one string in
 * the fixture asserting cleanliness was read as the operator's name. Master went
 * red on a suite that is green on every desktop in the project, because no human
 * account is called `runner` and `os.userInfo()` cannot be faked with an env
 * var, so nobody could reproduce it.
 *
 * TIGHTENING THE MATCHER DOES NOT FIX IT, and the dead end is recorded so nobody
 * walks it twice. A word boundary still matches `the runner finished`. A
 * path-segment rule still matches `D:\build\artifacts` for an account named
 * `build`, `/src/app` for one named `app`, and `C:\Users\` for one named `users`
 * -- all load-bearing fixture content that exists precisely to be realistic. No
 * string rule separates a generic word used as prose from the same generic word
 * used as a login.
 *
 * So the QUESTION changes rather than the matcher. This test exists to stop a
 * real PERSON being disclosed; the comment on it says so -- "the machine whose
 * owner would be disclosed". A shared service account has no owner to disclose,
 * so skipping these names costs no disclosure protection at all. Home directory
 * and hostname are still searched for unconditionally, which is what actually
 * catches a paste: a payload genuinely captured on a runner carries
 * `/home/runner/work/...`. That is asserted below, not argued here.
 *
 * Do not "fix" this by editing the fixture. The `runner` line is now the
 * permanent regression case for this bug: remove the word and the next person
 * to change this rule has nothing to watch fail.
 */
const GENERIC_ACCOUNTS = new Set([
  'runner', 'runneradmin', 'root', 'admin', 'administrator', 'user', 'users',
  'ubuntu', 'debian', 'build', 'builder', 'deploy', 'agent', 'app', 'node', 'ci',
  'jenkins', 'docker', 'vagrant', 'worker', 'guest', 'service', 'travis',
  'circleci', 'buildkite', 'ec2-user', 'azureuser', 'containeradmin',
]);

/**
 * A home directory as it would appear IN SOURCE, which is not how it appears in
 * a payload.
 *
 * Found while writing the control below, and it is a real hole rather than a
 * detail: this check reads leakShapes.mjs as TEXT, and a Windows path written in
 * a JavaScript string literal is escaped -- `C:\\Users\\jdoe` on disk for
 * `C:\Users\jdoe` in the value. Searching for the unescaped spelling therefore
 * missed every Windows home directory ever pasted into this file, on the one
 * platform the operators actually use. Both spellings, plus the forward-slash
 * form, exactly as payloadGuard does for payloads.
 */
function sourceFormsOf(p) {
  const s = String(p).toLowerCase();
  return [...new Set([s.replace(/\//g, '\\'), s.replace(/\\/g, '/'), s.replace(/\\/g, '\\\\')])];
}

/**
 * WHICH identity field this text discloses, or null. Named rather than boolean
 * on purpose: the assertion this replaces said only "a real identity value is
 * present", so the CI log could not say which of three fields had matched, and
 * that is most of why the failure survived several attempts to read it.
 *
 * Identity is a parameter so the rule can be tested against somebody else's
 * name -- the same reason payloadGuard takes one.
 */
function disclosedField(text, identity) {
  const low = text.toLowerCase();
  const { username = '', hostname = '', homedir = '' } = identity ?? {};
  if (username.length >= 3 && !GENERIC_ACCOUNTS.has(username.toLowerCase()) && low.includes(username.toLowerCase())) {
    return 'username';
  }
  if (hostname.length >= 3 && low.includes(hostname.toLowerCase())) return 'hostname';
  if (homedir.length >= 3 && sourceFormsOf(homedir).some((form) => low.includes(form))) return 'homedir';
  return null;
}

/** A name no fixture contains, proven so in the control below rather than assumed. */
const ABSENT = 'zzqqxx';

function fixtureText() {
  return fs.readFileSync(new URL('./fixtures/leakShapes.mjs', import.meta.url), 'utf8');
}

test('this suite committed no real identity: the fixtures name nobody on this machine', () => {
  /*
   * The guard on the guard. If somebody ever pastes a real payload into
   * leakShapes.mjs, this fails on the machine it was pasted from -- which is the
   * machine whose owner would be disclosed.
   */
  const field = disclosedField(fixtureText(), machineIdentity());
  assert.equal(field, null, `the committed fixtures contain this machine's ${field}`);

  // And the 8.3 alias of the home directory, which is the spelling that would
  // slip in through a copied temp path.
  const short = os.tmpdir().split(/[\\/]/).find((seg) => seg.includes('~'));
  if (short) {
    assert.equal(fixtureText().toLowerCase().includes(short.toLowerCase()), false, 'a real 8.3 identity segment is present in the committed fixtures');
  }
});

test('CONTROL: the identity guard still fires, on all three fields', () => {
  /*
   * Without this the test above passes on a machine named nobody, which is every
   * machine, and proves nothing. Each of these names an INVENTED identity that
   * the fixtures genuinely contain, so each must be caught. If the relaxation
   * above ever switches the check off, these go red and the one above does not.
   */
  const text = fixtureText();
  /*
   * The placeholder has to be absent from the fixture, and the first draft used
   * "nobody" -- which appears in it three times, in the very sentence naming
   * this test. It reported a username disclosure for a machine called nobody.
   * That is the same collision this whole change is about, one layer up, so the
   * sentinel is asserted absent rather than assumed absent.
   */
  assert.equal(text.toLowerCase().includes(ABSENT), false, 'the sentinel must not occur in the fixture or these controls prove nothing');
  assert.equal(disclosedField(text, { username: 'jdoe', hostname: ABSENT, homedir: '/nowhere' }), 'username');
  assert.equal(disclosedField(text, { username: ABSENT, hostname: 'build-box-7', homedir: '/nowhere' }), 'hostname');
  assert.equal(disclosedField(text, { username: ABSENT, hostname: ABSENT, homedir: 'C:\\Users\\jdoe' }), 'homedir');
});

test('CONTROL: a generic account has its username skipped and its HOME searched anyway', () => {
  /*
   * The exact GitHub-runner shape, both directions. The prose that reddened
   * master is clean; a payload actually captured on that runner is not, and it
   * is the home directory that catches it.
   */
  const runner = { username: 'runner', hostname: 'pkrvmabc123', homedir: '/home/runner' };
  assert.equal(disclosedField('the runner finished in 4s', runner), null, 'prose naming a service account is not a disclosure');
  assert.equal(disclosedField("value: '/home/runner/work/Agent007/src'", runner), 'homedir', 'a real capture from that runner must still be caught');
});
