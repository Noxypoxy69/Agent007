/**
 * WHAT COUNTS AS COMPARING TWO COPIES OF A SPLICED MODULE.
 *
 * `_shared.js` is a hand-maintained copy of eight `src/` modules. `verifySplices`
 * checks that the NAMES match and never the bodies -- deliberately, because a
 * splice legitimately differs in its imports. The behaviour half is a test that
 * drives both copies over the same inputs, and `behaviourComparedModules` is
 * what counts how many modules actually have one. That count is the only thing
 * standing between "ten declared splices" and "two of them are checked".
 *
 * THIS FILE EXISTS BECAUSE THE COUNT WAS WRONG IN BOTH DIRECTIONS IN ONE DAY.
 *
 * First it read a single hardcoded filename, so a pair written in its own file
 * was invisible and `src/taskRecord.mjs` -- which has a real, thorough pair --
 * was reported as trusted to a name check only.
 *
 * Then the fix for that credited any test importing the module AND the splice
 * target, on the reasoning that comparing them is the only reason to hold both.
 * Measured by blind audit: SEVEN of the eight name-only entries were credited
 * on incidental imports, including `src/coordination.mjs`, which carries
 * `validateMessage` and is the one the declaration list itself calls highest
 * risk. The gate read ~10 of 11 compared where the truth is 3 of 11.
 *
 * Over-crediting is the worse direction, and that is the argument for this file
 * rather than a comment. Under-crediting annoys an author into using the escape
 * hatch; over-crediting removes the reason to write the pair at all, silently,
 * while the gate reports the ratio improving.
 *
 * THE SHAPE IS THE SAME EXPORT NAMED ON BOTH SIDES. A test comparing two copies
 * has to name one export twice -- once out of `src/`, once out of `_shared.js`,
 * however it aliases them locally. A test that merely uses a helper names it
 * once. That is a property of the comparison; a filename is a property of who
 * wrote it, and an import list is a property of what else the test needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { behaviourComparedModules, DEFAULT_SPLICES, NAME_ONLY_SPLICES } from '../src/moduleGraph.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET = 'supabase/functions/mcp/_shared.js';

/** A throwaway tree, so the synthetic cases are not facts about this machine. */
async function repo(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'bps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

const SPLICES = { [TARGET]: ['src/m.mjs', 'src/other.mjs'] };

/* ── the synthetic cases, where the answer is not in doubt ────────────── */

test('THE POSITIVE FIRST: the same export named on both sides IS a pair', async (t) => {
  /*
   * Rule 5. Every refusal below is satisfied by a function that credits
   * nothing, and a gate that credits nothing reports every splice as name-only
   * -- which reads as an emergency and gets the whole check ignored.
   */
  const root = await repo(t, {
    [TARGET]: 'export function go() {}\n',
    'src/m.mjs': 'export function go() {}\n',
    'test/pair.test.mjs':
      `import { go } from '../${TARGET}';\n`
      + "import { go as srcGo } from '../src/m.mjs';\n",
  });
  const compared = behaviourComparedModules(root, SPLICES);
  assert.ok(compared.has('src/m.mjs'),
    'a test naming the same export from both copies was not counted as comparing them');
});

test('AN INCIDENTAL IMPORT IS NOT A COMPARISON -- the measured false credit', async (t) => {
  /*
   * THE DEFECT, in one fixture. This is `test/messagesQueryInbox.test.mjs`
   * reduced to its shape: it takes one name out of the splice target and a
   * DIFFERENT name out of a spliced module, and never holds two copies of
   * anything.
   */
  const root = await repo(t, {
    [TARGET]: 'export function query() {}\nexport function go() {}\n',
    'src/m.mjs': 'export function go() {}\n',
    'test/incidental.test.mjs':
      `import { query } from '../${TARGET}';\n`
      + "import { go } from '../src/m.mjs';\n"
      + "// uses go() as a precondition; never touches the spliced copy of it\n",
  });
  const compared = behaviourComparedModules(root, SPLICES);
  assert.equal(compared.has('src/m.mjs'), false,
    'a test that imports a module and the target, sharing no export name, was credited '
      + 'as a behaviour pair');
});

test('A MODULE THE TEST NEVER IMPORTS IS NOT CREDITED BY PROXIMITY', async (t) => {
  /*
   * The first fix added EVERY `../` import of a qualifying test, so one pair
   * credited every other module that file happened to reach.
   */
  const root = await repo(t, {
    [TARGET]: 'export function go() {}\n',
    'src/m.mjs': 'export function go() {}\n',
    'src/other.mjs': 'export function elsewhere() {}\n',
    'test/pair.test.mjs':
      `import { go } from '../${TARGET}';\n`
      + "import { go as srcGo } from '../src/m.mjs';\n"
      + "import { elsewhere } from '../src/other.mjs';\n",
  });
  const compared = behaviourComparedModules(root, SPLICES);
  assert.ok(compared.has('src/m.mjs'), 'the real pair stopped being counted');
  assert.equal(compared.has('src/other.mjs'), false,
    'a module that merely shares a file with a behaviour pair was credited too');
});

test('NO TEST HOLDS THE TARGET AT ALL means NOT KNOWN, not zero', async (t) => {
  /*
   * A null is the honest answer for a tree this check cannot speak about --
   * the synthetic roots other gates build, for one. Returning an empty set
   * would report every declared splice as unchecked, which is a different
   * claim and a much louder one.
   */
  const root = await repo(t, {
    'src/m.mjs': 'export function go() {}\n',
    'test/alone.test.mjs': "import { go } from '../src/m.mjs';\n",
  });
  assert.equal(behaviourComparedModules(root, SPLICES), null,
    'a tree with no splice target was reported as having zero comparisons');
});

/* ── the real repository ──────────────────────────────────────────────── */

test('THE REAL REPO: the three genuine pairs are credited', () => {
  /*
   * DERIVED, NOT TYPED, where it can be: these three are the modules whose
   * tests drive both copies. If a fourth pair is written this assertion keeps
   * passing and the NAME_ONLY assertion below tightens on its own.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  assert.notEqual(compared, null, 'the real repo has a splice target; this must not be null');
  for (const m of ['src/taskRecord.mjs', 'src/livenessProbe.mjs']) {
    assert.ok(compared.has(m), `${m} has a behaviour pair and is not being credited`);
  }
});

test('THE REAL REPO: coordination.mjs is NOT credited, which is the whole finding', () => {
  /*
   * The specific module, named, because a count can drift back without anybody
   * noticing which member moved. `src/coordination.mjs` carries validateMessage
   * and the executable-text guard; NAME_ONLY_SPLICES calls it "HIGHEST RISK of
   * the eight" and says it wants a behaviour pair next. Crediting it on an
   * incidental import is how that entry quietly stops being true.
   *
   * THIS ASSERTION IS MEANT TO GO AWAY. When somebody writes the pair, this
   * test fails and the NAME_ONLY_SPLICES entry can go with it. That is the
   * intended direction and the comment is here so the next reader deletes both
   * rather than weakening this one.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  assert.equal(
    compared.has('src/coordination.mjs'), false,
    'src/coordination.mjs is credited as behaviour-compared. If a pair was just written, '
      + 'delete this test AND its NAME_ONLY_SPLICES entry. If not, a test is being counted '
      + 'that does not compare the two copies.',
  );
});

/**
 * Declared name-only, and ALSO holding at least one doubly-named export.
 *
 * NOT STALE ENTRIES, AND THAT DISTINCTION IS THE OPEN QUESTION HERE. Each of
 * these has ONE export named on both sides by some test that is not a splice
 * comparison -- `leaseTokenIsDelivered` takes `eventsFor` out of src/events.mjs
 * and out of the target because it needs both, and that is a real comparison of
 * that one function. It is not a comparison of the MODULE, and the
 * NAME_ONLY_SPLICES entry saying the rest is trusted to a name check remains
 * substantially true.
 *
 * WHICH MEANS THIS GATE IS STILL MODULE-GRANULAR AND THE TRUTH IS PER-EXPORT.
 * That is the same finding deadExports already made in the other direction --
 * "a module is not wired because one export is" -- and the answer there was to
 * classify per export rather than per module. The same move is owed here, and
 * it is a refactor of `findOrphans`'s contract rather than a patch, so it is
 * named rather than attempted.
 *
 * A RATCHET, NOT AN ALLOWANCE. The list may only shrink: a module that acquires
 * a real whole-module pair comes off it along with its NAME_ONLY_SPLICES entry,
 * and a NEW module appearing here fails, which is the case that matters.
 */
const ONE_EXPORT_COMPARED = [
  'mcp/toolDefs.mjs',
  'src/events.mjs',
  'src/liveRegistry.mjs',
  'src/ownWork.mjs',
  'src/ownerDecisions.mjs',
  'src/permissionRequest.mjs',
];

test('NO NAME-ONLY ENTRY IS CREDITED BEYOND THE KNOWN PER-EXPORT CASES', () => {
  /*
   * Rule 7: generated from the real list, so adding a NAME_ONLY entry extends
   * this without anybody remembering to. An entry claims "trusted to a weaker
   * check"; a module credited as compared AND carrying that entry is either a
   * stale debt or the per-export case above, and the gate has to say which
   * rather than averaging them into a number.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  const credited = Object.keys(NAME_ONLY_SPLICES).filter((m) => compared.has(m)).sort();
  assert.deepEqual(
    credited, [...ONE_EXPORT_COMPARED].sort(),
    'the set of name-only modules credited as compared has changed. If a real pair was '
      + 'written, delete the module from ONE_EXPORT_COMPARED and from NAME_ONLY_SPLICES. '
      + 'If a NEW module appeared, the crediting rule has loosened again',
  );
});

test('AND THE HEADLINE FALSE CREDIT IS GONE: an incidental import credits nothing', () => {
  /*
   * The two the audit named specifically, kept as named assertions rather than
   * folded into the count above -- a count can drift back without anybody
   * seeing which member moved, which is how this went wrong the first time.
   *
   * src/coordination.mjs was credited because messagesQueryInbox.test.mjs
   * imports `messagesQuery` from the target and `inboxNames` from it, sharing
   * no name. src/glob.mjs was the only one of the eight NOT credited, so it is
   * the control: if it ever appears, the rule has loosened.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  assert.equal(compared.has('src/coordination.mjs'), false,
    'src/coordination.mjs -- validateMessage, "HIGHEST RISK of the eight" -- is credited '
      + 'again on an import that shares no export name with the target');
  assert.equal(compared.has('src/glob.mjs'), false,
    'src/glob.mjs has no doubly-named export and is credited anyway');
});

test('THE CANONICAL PAIR IS SEEN, which a parser bug had hidden', () => {
  /*
   * bridge/collisions.mjs is compared by test/sharedSpliceMatches.test.mjs --
   * the one file in the repository whose entire job is comparing splices -- and
   * the first version of the import parser read it as importing `test`. A lazy
   * `[\s\S]*?` began at `import { test } from 'node:test'` and ran forward to
   * the first `../` specifier, so the braces it found belonged to a different
   * statement. The file that exists to compare splices was read as comparing
   * nothing, and the gate went green.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  assert.ok(compared.has('bridge/collisions.mjs'),
    'bridge/collisions.mjs is compared by sharedSpliceMatches and is not being credited -- '
      + 'the import parser is reading the wrong clause again');
  assert.ok(compared.has('src/dispatch.mjs'),
    'src/dispatch.mjs is compared by sharedSpliceMatches and is not being credited');
});

test('THE CONTROL: this check can actually fail', () => {
  /*
   * Rule 1, held permanently. Every assertion above is satisfied by a function
   * returning an empty set, and most of them by one returning everything. One
   * of each verdict is demanded here from the real repository.
   */
  const compared = behaviourComparedModules(REPO_ROOT);
  assert.ok(compared.size > 0, 'nothing is credited -- the check is inert');
  const declared = DEFAULT_SPLICES[TARGET];
  assert.ok(declared.some((m) => !compared.has(m)),
    'every declared splice is credited -- the check is crediting indiscriminately, '
      + 'which is the defect this file was written for');
});
