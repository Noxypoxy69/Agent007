/**
 * THE TWO COPIES OF THE TASK VALIDATOR MUST AGREE, BEHAVIOURALLY.
 *
 * `supabase/functions/mcp/_shared.js` is a hand-maintained splice of `src/`,
 * because a Supabase edge function cannot import from outside its own
 * directory. The tests exercise the ORIGINALS, so a splice that drifts is
 * invisible: every gate stays green while the deployed surface does something
 * else.
 *
 * That is not hypothetical here. `revokeDecision` was anchored in `src/` and
 * left untouched in `_shared.js` for three commits while the commit message
 * said "Anchored." — the two surfaces disagreed in three directions and nothing
 * noticed, because no test imported it from either file.
 *
 * COMPARED BY BEHAVIOUR, NOT BY TEXT. A source comparison agrees with itself
 * through a reformat and disagrees over a comment; and CLAUDE.md's own note is
 * that a splice gate's fixtures must reach the branch that diverged. So this
 * drives both copies over the same corpus and compares the ANSWERS, including
 * the error text, because a refusal that names the wrong field is a different
 * refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask, validateTask, pathsCollide,
  RUNNABLE_STATES, TASK_ID,
} from '../src/taskRecord.mjs';
import {
  createTask as hostedCreate,
  validateTask as hostedValidate,
  pathsCollide as hostedCollide,
  RUNNABLE_STATES as HOSTED_STATES,
  TASK_ID as HOSTED_TASK_ID,
} from '../supabase/functions/mcp/_shared.js';

const AT = '2026-09-18T23:00:00.000Z';

/*
 * BUILT BY HAND, SO IT MUST CARRY `state` EXPLICITLY.
 *
 * The first version omitted it and every "well-formed" assertion failed: the
 * parameter default lives in `createTask`, and a record handed straight to
 * `validateTask` never passes through it. Worth leaving visible — a corpus
 * whose baseline case is invalid makes the whole comparison agree on "both
 * refuse", which is exactly the vacuous agreement the next test exists to
 * refuse.
 */
const base = {
  task_id: 't-splice', title: 'x', lane_id: 'agentbridge', repo_id: 'Agent007',
  state: 'runnable',
  allowed_paths: ['src/a.mjs'], created_at: AT, created_by: 'code-b',
};

/**
 * Every shape that has ever been wrong here, plus the ordinary one.
 *
 * Generated where it can be: each single-field omission is derived from the
 * record's own keys, so a field added later is covered without anybody
 * remembering (rule 7).
 */
const CORPUS = [
  base,
  { ...base, state: 'assigned' },
  { ...base, state: 'returned' },
  { ...base, state: '' },
  { ...base, allowed_paths: [] },
  { ...base, allowed_paths: ['../escape'] },
  { ...base, allowed_paths: ['/abs'] },
  { ...base, allowed_paths: ['C:/x'] },
  { ...base, allowed_paths: ['a\\b'] },
  { ...base, allowed_paths: [''] },
  { ...base, allowed_paths: 'src/' },
  { ...base, allowed_paths: null },
  { ...base, depends_on: ['t-splice'] },
  { ...base, depends_on: 'nope' },
  { ...base, task_id: 't with space' },
  { ...base, task_id: 'x'.repeat(65) },
  { ...base, task_id: '' },
  { ...base, forbidden_paths: 'nope' },
  { ...base, shared_paths: 42 },
  null, undefined, 42, 'task', [],
  ...Object.keys(base).map((k) => ({ ...base, [k]: '' })),
  ...Object.keys(base).map((k) => ({ ...base, [k]: undefined })),
];

test('THE POSITIVE FIRST: both copies accept a well-formed task', () => {
  /*
   * Rule 5. A parity loop over two validators that both refuse everything
   * agrees perfectly and proves nothing.
   */
  assert.equal(validateTask(base).ok, true, 'src refused a well-formed task');
  assert.equal(hostedValidate(base).ok, true, 'hosted refused a well-formed task');
});

test('THE CORPUS REACHES BOTH ANSWERS, or the comparison is vacuous', () => {
  const verdicts = new Set(CORPUS.map((t) => validateTask(t).ok));
  assert.deepEqual([...verdicts].sort(), [false, true],
    'the corpus produces only one verdict, so agreement between the copies means nothing');
  assert.ok(CORPUS.length >= 25, `only ${CORPUS.length} cases`);
});

test('THE TWO COPIES AGREE, CASE FOR CASE, INCLUDING THE REASON', () => {
  const diverged = [];
  for (const t of CORPUS) {
    const a = validateTask(t);
    const b = hostedValidate(t);
    if (a.ok !== b.ok || JSON.stringify(a.errors) !== JSON.stringify(b.errors)) {
      diverged.push({ t, src: a, hosted: b });
    }
  }
  assert.deepEqual(diverged.map((d) => d.t), [],
    `the splice has drifted:\n${diverged.map((d) =>
      `  ${JSON.stringify(d.t)}\n    src:    ${JSON.stringify(d.src)}\n    hosted: ${JSON.stringify(d.hosted)}`,
    ).join('\n')}`);
});

test('THE CONSTRUCTORS PRODUCE THE SAME RECORD', () => {
  for (const t of [base, { ...base, allowed_paths: null }, { ...base, state: 'returned' }]) {
    assert.deepEqual(createTask(t), hostedCreate(t),
      `the constructors disagree for ${JSON.stringify(t)}`);
  }
});

test('THE COLLISION CHECK AGREES, including on segment boundaries', () => {
  /*
   * THE FIXTURE COULD NOT REACH THE BRANCH THAT DIVERGED — hollow gate 10, in
   * the gate written to catch a splice drifting.
   *
   * The six pairs below the audit found were all lowercase, single-slash and
   * dot-free, so making the hosted copy case-insensitive while leaving src/
   * alone was a MISSED mutation: parity green, deployed copy drifted. Every
   * alias the matcher now normalises is therefore in the corpus, because a
   * normalisation the fixture never exercises is one the parity gate cannot
   * pin.
   */
  const pairs = [
    [['src/'], ['src/a.mjs']],
    [['src'], ['src/a.mjs']],
    [['src/a'], ['src/ab']],
    [['a/b/c'], ['a/b']],
    [['x'], ['y']],
    [[], ['x']],
    // the aliases — each must agree across the splice, whatever the answer is
    [['src/a'], ['./src/a']],
    [['src/a'], ['src//a']],
    [['src/a'], ['SRC/a']],
    [['src/a'], ['src/./a']],
    [['src/a'], ['src/a ']],
    [['src/a'], ['src\\a']],
    [['SRC/'], ['src/a.mjs']],
    [['src/a'], ['src/A']],
    [[null], ['src/a']],
    [['', '  '], ['src/a']],
  ];
  for (const [a, b] of pairs) {
    assert.deepEqual(pathsCollide(a, b), hostedCollide(a, b),
      `the collision check disagrees for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('THE SHARED CONSTANTS ARE THE SAME', () => {
  assert.deepEqual([...RUNNABLE_STATES], [...HOSTED_STATES], 'the claimable states have drifted');
  assert.equal(String(TASK_ID), String(HOSTED_TASK_ID), 'the task id pattern has drifted');
});

test('THE CONTROL: this comparison can actually fail', () => {
  /*
   * Rule 1. If the comparison were inert, every assertion above would pass for
   * two validators that disagreed completely.
   */
  const a = { ok: true, errors: [] };
  const b = { ok: false, errors: ['x'] };
  assert.notEqual(a.ok, b.ok, 'the verdict comparison is inert');
  assert.notEqual(JSON.stringify(a.errors), JSON.stringify(b.errors), 'the reason comparison is inert');
});
