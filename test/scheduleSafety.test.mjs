import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleSafety,
  classifyPair,
  globsIntersect,
  SAFE_PARALLEL,
  SHARED_OVERLAP,
  BLOCKING_COLLISION,
  STALE_BASE,
  UNRESOLVABLE_BASE,
} from '../src/schedule.mjs';

/**
 * EVERY BLOCKING CASE IS PAIRED WITH THE NEAREST ONE THAT MUST STAY RUNNABLE.
 *
 * A scheduler that refuses everything satisfies every "it blocks" test and is
 * worse than no scheduler: work stops, somebody disables it, and then nothing
 * is checked. So each refusal below has a twin differing in one field that must
 * come back runnable, and the twins are the half worth reading.
 */

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const fresh = { [BASE]: { resolved: true, changedPaths: [] } };

const D = (id, allowed, shared = [], base_sha = BASE) => ({ id, allowed_paths: allowed, shared_paths: shared, base_sha });
const run = (delegations, baseInfo = fresh) => scheduleSafety({ delegations, baseInfo });
const classOf = (rows, id) => rows.find((r) => r.id === id).classification;

/* ── disjoint paths stay runnable ────────────────────────────────────── */

test('disjoint paths are safe-parallel', () => {
  const rows = run([D('one', ['src/a.mjs']), D('two', ['src/b.mjs'])]);
  assert.equal(classOf(rows, 'one'), SAFE_PARALLEL);
  assert.equal(classOf(rows, 'two'), SAFE_PARALLEL);
  assert.ok(rows.every((r) => r.runnable));
});

test('disjoint GLOBS in different trees are safe-parallel', () => {
  const rows = run([D('one', ['src/lib/**']), D('two', ['test/**'])]);
  assert.equal(classOf(rows, 'one'), SAFE_PARALLEL);
});

test('a single contract with nobody to collide with is safe-parallel', () => {
  assert.equal(classOf(run([D('only', ['src/a.mjs'])]), 'only'), SAFE_PARALLEL);
});

/* ── overlapping exclusive paths block ───────────────────────────────── */

test('the same exact path claimed twice is a blocking collision', () => {
  const rows = run([D('one', ['src/a.mjs']), D('two', ['src/a.mjs'])]);
  assert.equal(classOf(rows, 'one'), BLOCKING_COLLISION);
  assert.equal(classOf(rows, 'two'), BLOCKING_COLLISION);
  assert.equal(rows[0].runnable, false);
});

test('a glob swallowing another contract literal blocks', () => {
  const rows = run([D('wide', ['src/**']), D('narrow', ['src/lib/x.mjs'])]);
  assert.equal(classOf(rows, 'wide'), BLOCKING_COLLISION);
});

test('two overlapping trees block', () => {
  const rows = run([D('one', ['src/lib/**']), D('two', ['src/**'])]);
  assert.equal(classOf(rows, 'one'), BLOCKING_COLLISION);
});

test('the collision NAMES the paths responsible', () => {
  // "these two collide" sends somebody reading two whole contracts. The glob
  // pair is the thing they can act on.
  const rows = run([D('one', ['src/a.mjs']), D('two', ['src/a.mjs'])]);
  const c = rows[0].collidesWith[0];
  assert.equal(c.id, 'two');
  assert.deepEqual(c.paths, [{ a: 'src/a.mjs', b: 'src/a.mjs' }]);
});

/* ── a DECLARED shared path does not falsely block ───────────────────── */

test('a path both declare shared is an overlap, NOT a block', () => {
  const rows = run([
    D('one', ['src/a.mjs', 'package.json'], ['package.json']),
    D('two', ['src/b.mjs', 'package.json'], ['package.json']),
  ]);
  assert.equal(classOf(rows, 'one'), SHARED_OVERLAP);
  assert.equal(rows[0].runnable, true, 'a declared shared file must not stop work');
});

test('ONE-SIDED sharing still blocks — the other contract believes it owns the file', () => {
  /*
   * The asymmetry is the point. If A calls package.json shared and B claims it
   * exclusively, honouring only A's declaration lets A edit a file B believes
   * nobody else is in. That is the collision wearing a permission slip.
   */
  const rows = run([
    D('generous', ['package.json'], ['package.json']),
    D('exclusive', ['package.json'], []),
  ]);
  assert.equal(classOf(rows, 'generous'), BLOCKING_COLLISION);
  assert.equal(classOf(rows, 'exclusive'), BLOCKING_COLLISION);
});

test('sharing one file does not make an unrelated collision safe', () => {
  const rows = run([
    D('one', ['package.json', 'src/a.mjs'], ['package.json']),
    D('two', ['package.json', 'src/a.mjs'], ['package.json']),
  ]);
  // package.json is fine; src/a.mjs is not, and the worst answer wins.
  assert.equal(classOf(rows, 'one'), BLOCKING_COLLISION);
});

/* ── a stale base is detected ────────────────────────────────────────── */

test('a base whose commits touched THIS contract path is stale', () => {
  const rows = run([D('one', ['src/a.mjs'])], {
    [BASE]: { resolved: true, changedPaths: ['src/a.mjs'] },
  });
  assert.equal(classOf(rows, 'one'), STALE_BASE);
});

test('NEAREST CLEAN: a base that moved under SOMEBODY ELSE paths is not stale', () => {
  /*
   * Marking every contract stale the moment master advances flags all of them,
   * all the time — a signal nobody can act on and therefore nobody reads.
   */
  const rows = run([D('one', ['src/a.mjs'])], {
    [BASE]: { resolved: true, changedPaths: ['docs/readme.md', 'src/zzz.mjs'] },
  });
  assert.equal(classOf(rows, 'one'), SAFE_PARALLEL);
});

test('a SHARED path moving under you is also stale — that is when you must reconcile', () => {
  const rows = run([D('one', ['src/a.mjs'], ['package.json'])], {
    [BASE]: { resolved: true, changedPaths: ['package.json'] },
  });
  assert.equal(classOf(rows, 'one'), STALE_BASE);
});

test('a current base stays runnable', () => {
  assert.equal(classOf(run([D('one', ['src/a.mjs'])]), 'one'), SAFE_PARALLEL);
});

/* ── a dead base REFUSES rather than resolving to HEAD ───────────────── */

test('A NONEXISTENT BASE IS REFUSED, not silently resolved', () => {
  const rows = run([D('one', ['src/a.mjs'], [], OTHER)], {
    [OTHER]: { resolved: false },
  });
  assert.equal(classOf(rows, 'one'), UNRESOLVABLE_BASE);
  assert.equal(rows[0].runnable, false);
  assert.match(rows[0].reasons[0], /REFUSED/);
});

test('A BASE WITH NO INFORMATION AT ALL IS REFUSED, not assumed fresh', () => {
  // An absent fact is not a reassuring one. Defaulting to "fine" would make a
  // typo in a sha read as a clean bill of health.
  const rows = run([D('one', ['src/a.mjs'], [], OTHER)], {});
  assert.equal(classOf(rows, 'one'), UNRESOLVABLE_BASE);
});

test('naming no base at all is refused', () => {
  const rows = run([D('one', ['src/a.mjs'], [], null)]);
  assert.equal(classOf(rows, 'one'), UNRESOLVABLE_BASE);
  assert.match(rows[0].reasons[0], /no base/);
});

test('an unresolvable base OUTRANKS a collision, because it cannot even be judged', () => {
  const rows = run([D('one', ['src/a.mjs'], [], OTHER), D('two', ['src/a.mjs'])], {
    ...fresh,
    [OTHER]: { resolved: false },
  });
  assert.equal(classOf(rows, 'one'), UNRESOLVABLE_BASE);
  assert.equal(classOf(rows, 'two'), BLOCKING_COLLISION);
});

/* ── it reports and refuses, and does nothing else ───────────────────── */

test('it never mutates the delegations it is given', () => {
  const d = D('one', ['src/a.mjs']);
  const before = JSON.stringify(d);
  run([d, D('two', ['src/a.mjs'])]);
  assert.equal(JSON.stringify(d), before, 'a reporter must not edit the contracts it reports on');
});

test('the result carries no merge, rebase or ordering instruction', () => {
  /*
   * Structural, because the temptation is real and the next person adding
   * "suggestedRebase" would be doing somebody a favour. The failure this
   * replaces was agents acting confidently on a picture only one of them had.
   */
  const rows = run([D('one', ['src/a.mjs']), D('two', ['src/a.mjs'])]);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['classification', 'collidesWith', 'id', 'reasons', 'runnable']);
  }
  assert.doesNotMatch(JSON.stringify(rows), /rebase|merge|reorder|autofix/i);
});

/* ── no dependency on federation ─────────────────────────────────────── */

test('classification ignores who holds a contract', () => {
  /*
   * A scheduling answer that needed identity resolution could not be given
   * while the registry was unconfigured -- which is exactly when you most want
   * to know what is safe to run. Same paths, different holders, same answer.
   */
  const withHolders = run([
    { ...D('one', ['src/a.mjs']), agent_id: 'worker-x', session_id: 's1', lane_id: 'bridge' },
    { ...D('two', ['src/a.mjs']), agent_id: 'worker-y', session_id: 's2', lane_id: 'product' },
  ]);
  const without = run([D('one', ['src/a.mjs']), D('two', ['src/a.mjs'])]);
  assert.deepEqual(
    withHolders.map((r) => r.classification),
    without.map((r) => r.classification),
  );
});

test('the same agent holding both still collides — files collide, not people', () => {
  const rows = run([
    { ...D('one', ['src/a.mjs']), agent_id: 'same' },
    { ...D('two', ['src/a.mjs']), agent_id: 'same' },
  ]);
  assert.equal(classOf(rows, 'one'), BLOCKING_COLLISION);
});

/* ── glob intersection, both directions ──────────────────────────────── */

test('globsIntersect decides the exact cases exactly', () => {
  assert.equal(globsIntersect('src/a.mjs', 'src/a.mjs'), true);
  assert.equal(globsIntersect('src/a.mjs', 'src/b.mjs'), false);
  assert.equal(globsIntersect('src/**', 'src/lib/x.mjs'), true);
  assert.equal(globsIntersect('src/lib/x.mjs', 'src/**'), true);
  assert.equal(globsIntersect('src/a/**', 'src/b/**'), false);
  assert.equal(globsIntersect('src/**', 'test/**'), false);
});

test('WHEN UNSURE IT SAYS YES — a missed collision costs more than a wait', () => {
  // Two patterns sharing a fixed prefix are reported as intersecting even where
  // the tails might not meet. A false collision costs a conversation; a missed
  // one costs two agents editing one file.
  assert.equal(globsIntersect('src/**/a.mjs', 'src/**/b.mjs'), true);
});

test('different fixed prefixes never intersect, whatever follows', () => {
  assert.equal(globsIntersect('alpha/**/x', 'beta/**/x'), false);
});

/* ── shape ───────────────────────────────────────────────────────────── */

test('classifyPair is symmetric', () => {
  const a = D('a', ['src/**'], ['package.json']);
  const b = D('b', ['src/lib/x.mjs']);
  assert.equal(classifyPair(a, b).classification, classifyPair(b, a).classification);
});

test('an empty schedule is not an error', () => {
  assert.deepEqual(scheduleSafety({ delegations: [], baseInfo: {} }), []);
  assert.deepEqual(scheduleSafety({}), []);
  assert.deepEqual(scheduleSafety(), []);
});

test('a contract claiming no paths collides with nobody', () => {
  const rows = run([D('empty', []), D('two', ['src/a.mjs'])]);
  assert.equal(classOf(rows, 'empty'), SAFE_PARALLEL);
});
