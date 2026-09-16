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
    //  /jane  \jane  ~jane  @jane   or   jane@
    if (new RegExp(`[/\\\\~@]${u}(?![a-z0-9_-])|(?<![a-z0-9_-])${u}@`).test(hay)) return user;
    /*
     * AND A MACHINE LABEL BUILT FROM THE NAME — `jane-win`, `jdoe_laptop`.
     *
     * THE FIRST VERSION OF THIS NARROWING DROPPED THIS SHAPE SILENTLY, which is
     * the risk its own comment named and did not cover: separator-anchored
     * cases were controlled for, a hyphenated label was not, and the fixtures
     * contained one. `payloadGuard` classifies `jane-win` as a USERNAME leak and
     * this matcher called it clean — the same question answered two ways in one
     * repository.
     *
     * A DOT IS DELIBERATELY NOT A SEPARATOR HERE. Including it matched
     * `test.mjs` for an operator called `test`, which is a filename in every
     * directory of this project.
     */
    if (new RegExp(`(?<![a-z0-9_-])${u}[-_][a-z0-9]`).test(hay)) return user;
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
    // a machine label built from the name — the shape the first narrowing dropped
    'worker runner-win reported',
    'slot runner_laptop-3 registered',
  ]) {
    assert.notEqual(namesMachine(leak, me), null, `should have been flagged: ${leak}`);
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

test('KNOWN COST: an english hyphenation is indistinguishable from a machine label', () => {
  /*
   * CHARACTERISATION, NOT APPROVAL, in the style of the two gaps above it.
   *
   * `runner-up` and `jane-win` are the SAME SHAPE — a name, a hyphen, a word —
   * and no lexical rule separates them. So catching the machine label costs a
   * false positive on the hyphenation, for an operator whose username happens
   * to be an english word. `root-cause` is the realistic one in this repository.
   *
   * IT IS ACCEPTED RATHER THAN SOLVED, and the reason is the direction of the
   * damage. Missing `jane-win` publishes a real operator's machine name for
   * ever; flagging `runner-up` costs one fixture edit and says exactly which
   * word did it. The first is silent, the second is loud.
   *
   * MEASURED AGAINST THE COMMITTED FIXTURES: adding this rule reddens NOTHING
   * that was green. runner, root, admin, test and node all still scan clean
   * against leakShapes.mjs; the only operator this newly flags is one whose
   * name is actually in the file, which is the whole point.
   *
   * WHEN SOMEBODY FINDS A RULE THAT SEPARATES THEM, this test fails. Assert the
   * hyphenation is clean, keep the label flagged, and say so in the handoff.
   */
  const runner = { username: 'runner', hostname: '', homedir: '' };
  assert.equal(namesMachine('the runner-up was not recorded', runner), 'runner',
    'GAP CLOSED? if this is clean now, keep the label case flagged and say so');
  assert.equal(namesMachine('runners up were not recorded', runner), null,
    'no hyphen, no label: this must stay clean or the CI failure is back');
});

test('KNOWN GAP: a username that collides with a path segment still reddens a clean repo', () => {
  /*
   * THE HALF THE CI FIX DID NOT REACH, recorded because it is the same defect
   * class and it is still live.
   *
   * The fixtures deliberately contain leak examples with real-looking paths --
   * `D:\build\artifacts\out` and `https://deploy:hunter2...` among them. The
   * homedir and hostname rules are bare substrings, correctly, and a username
   * sitting after a path separator is exactly what the matcher looks for. So an
   * operator called `build` or `deploy` sees this suite go red on a repository
   * with nothing wrong with it -- which is what happened to `runner`, one
   * mechanism over.
   *
   * NOT FIXED HERE because the fix is to change the fixture VALUES, and those
   * values are asserted by the MUST_LEAK cases above; editing them is a
   * separate change with its own review. Filed so the next person who sees red
   * on a clean checkout reads this instead of bisecting.
   */
  const text = fs.readFileSync(new URL('./fixtures/leakShapes.mjs', import.meta.url), 'utf8');
  for (const colliding of ['build', 'deploy']) {
    assert.notEqual(
      namesMachine(text, { username: colliding, hostname: '', homedir: '' }), null,
      `GAP CLOSED for ${colliding}? assert null here and say so in the handoff`,
    );
  }
  // and the ones that are genuinely fixed, asserted so a widening shows up here.
  // `test` is the dot case: treating `.` as a label separator matches `test.mjs`,
  // a filename in every directory of this project, and reddens a clean repo again.
  for (const fine of ['runner', 'root', 'test', 'node', 'admin']) {
    assert.equal(namesMachine(text, { username: fine, hostname: '', homedir: '' }), null,
      `a clean repo went red for an operator called ${fine}`);
  }
});

test('this suite committed no real identity: the fixtures name nobody on this machine', () => {
  /*
   * The guard on the guard. If somebody ever pastes a real payload into
   * leakShapes.mjs, this fails on the machine it was pasted from — which is the
   * machine whose owner would be disclosed.
   */
  const text = fs.readFileSync(new URL('./fixtures/leakShapes.mjs', import.meta.url), 'utf8');
  const hit = namesMachine(text, machineIdentity());
  assert.equal(hit, null, `a real identity value is present in the committed fixtures: ${hit}`);
  // And the 8.3 alias of the home directory, which is the spelling that would
  // slip in through a copied temp path.
  const short = os.tmpdir().split(/[\\/]/).find((seg) => seg.includes('~'));
  if (short) {
    assert.equal(text.toLowerCase().includes(short.toLowerCase()), false, 'a real 8.3 identity segment is present in the committed fixtures');
  }
});
