import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = join(here, '..', 'supabase', 'functions', 'mcp', 'index.ts');

/**
 * GUARDS FOR THE ONE FILE THE SUITE CANNOT IMPORT.
 *
 * ═══ WHY THIS EXISTS, AND IT IS A FAILURE OF MY OWN ═══
 *
 * `supabase/functions/mcp/index.ts` is Deno-only. Nothing in this suite can
 * import it, so everything in it is untested by construction — which is exactly
 * where `confirm_proposal` sat while it threw `Cannot read properties of
 * undefined (reading 'assignTask')` on EVERY CALL IT EVER RECEIVED. 538
 * proposals prepared, zero confirmed, read all day as the coordinator failing
 * to do its job.
 *
 * I fixed it (83cd087) and wrote test/toolsCanActuallyRun.test.mjs to catch a
 * regression. Then I audited my own work and reinstated the bug:
 *
 *     FULL SUITE, 1033 tests, with the exact bug restored:  ALL GREEN.
 *
 * toolsCanActuallyRun proves the CLASS is detectable — it builds a `this`-shaped
 * store and asserts the specific TypeError. It cannot guard the real file,
 * because it cannot see the real file. A positive control on a fake is not a
 * gate on the original, and I had been treating it as one.
 *
 * ═══ SO THIS READS index.ts AS TEXT ═══
 *
 * A source-level check is a weak instrument and it is the only one available
 * here. It is worth having anyway: the alternative is that the single most
 * expensive bug this project has produced has no regression gate at all.
 *
 * COMMENTS ARE BLANKED BEFORE MATCHING. A check that greps for `this.` matches
 * its own explanatory prose and every comment discussing the bug — including
 * this one, if it were in the same file. Three independent rediscoveries of
 * that trap in one day; it is rule 13 in CLAUDE.md.
 */

/** Strip comments and strings so a match is CODE, never prose or a literal. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/^[ \t]*\/\/.*$/gm, ' ')        // whole-line comments
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''"); // string literals
}

test('THE STORES USE NO `this`, because toolDefs DESTRUCTURES them', () => {
  /*
   * THE BUG, EXACTLY. toolDefs does:
   *
   *     const { listProposals, confirmProposal, ... } = store;
   *     run: async (a) => jsonResult(await confirmProposal(a))
   *
   * which detaches every method from its object. Any method reaching a sibling
   * through `this` is therefore undefined AT THE MOMENT IT RUNS — not
   * sometimes, every time, since the day it shipped.
   *
   * The fix is to name the object and call siblings through the name. This
   * asserts the file never goes back.
   */
  const code = codeOnly(readFileSync(INDEX, 'utf8'));
  const hits = [...code.matchAll(/\bthis\s*\./g)];

  assert.deepEqual(hits.map((h) => code.slice(Math.max(0, h.index - 60), h.index + 30).trim()), [],
    'a `this.` reference is back in the edge function; toolDefs destructures the '
    + 'store, so it will be undefined at call time — this is the confirm_proposal bug');
});

test('THE CONTROL: this gate can actually fail', () => {
  /*
   * Rule 1. A gate nobody has watched fail is a gate nobody has proven can. The
   * mutation is applied to a COPY of the real source rather than to disk, so
   * the proof costs nothing and cannot leave the file damaged — which is its
   * own small lesson, since a mutation harness that writes to disk is one
   * crashed process away from committing the bug it was testing for.
   */
  const real = readFileSync(INDEX, 'utf8');
  const broken = real.replace('? await store.assignTask(', '? await this.assignTask(');
  assert.notEqual(broken, real, 'the mutation did not apply, so this control proves nothing');

  const hits = [...codeOnly(broken).matchAll(/\bthis\s*\./g)];
  assert.equal(hits.length, 1, 'the gate did not see the reinstated bug');
});

test('comment-blanking works, or the gate matches its own prose', () => {
  // Rule 13, held directly rather than assumed: the word appears in comments
  // and strings in this very file and in index.ts, and must not count.
  const sample = `
    /* a comment mentioning this.assignTask */
    // another this.thing
    const msg = 'this.notCode';
    const ok = store.assignTask();
  `;
  assert.deepEqual([...codeOnly(sample).matchAll(/\bthis\s*\./g)], []);

  // And the positive half: real code IS still seen after blanking.
  assert.equal([...codeOnly('const x = this.y;').matchAll(/\bthis\s*\./g)].length, 1,
    'blanking ate real code, so the gate would be blind');
});

test('every store method that reaches a sibling does so BY NAME', () => {
  /*
   * The structural half. `confirmProposal` is the method that has to call
   * siblings, and the fix was to bind through the named object. If the store
   * ever goes back to an anonymous `return { ... }` literal, `store` is not in
   * scope and this breaks loudly at import rather than quietly at call time.
   */
  const code = codeOnly(readFileSync(INDEX, 'utf8'));
  assert.match(code, /const store = \{/,
    'coordinatorStore returned an anonymous object again; sibling calls have nothing to bind to');
  assert.match(code, /await store\.assignTask\(/);
  assert.match(code, /await store\.acceptTask\(/);
});

test('THE ROSTER READ PATH DERIVES CAPACITY, it does not report the stored column', () => {
  /*
   * FOUND BY MUTATION, AND IT IS THE SAME SHAPE AS THE `this` BUG ABOVE.
   *
   * code-d found the live roster describing code-b as `idle` after 898 minutes
   * of silence — the only real agent among the stale rows, and the only wrong
   * one. The fix was to derive capacity through observedCapacity instead of
   * handing out `r.capacity`.
   *
   * Reverting that fix left every test in rosterDoesNotLie.test.mjs GREEN,
   * because the fix is in index.ts and nothing can import index.ts. The pure
   * rule is well covered; the SITE THAT USES IT was not covered at all. That is
   * the second time today the same gap has swallowed a fix.
   */
  const code = codeOnly(readFileSync(INDEX, 'utf8'));

  assert.match(code, /capacity:\s*observedCapacity\(/,
    'the roster read path reports the stored capacity again; a worker that died '
    + 'while claiming "idle" will be listed as available forever');

  assert.doesNotMatch(code, /capacity:\s*r\.capacity\s*\?\?\s*null/,
    'the undesired form is back');
});

test('THE CONTROL: that roster assertion can fail', () => {
  const real = readFileSync(INDEX, 'utf8');
  const broken = real.replace(
    'capacity: observedCapacity(r, { now: new Date().toISOString() }),',
    'capacity: r.capacity ?? null,',
  );
  assert.notEqual(broken, real, 'the mutation did not apply, so this proves nothing');
  assert.doesNotMatch(codeOnly(broken), /capacity:\s*observedCapacity\(/);
});
