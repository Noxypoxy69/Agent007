import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImports, resolveSpecifier } from '../src/moduleGraph.mjs';
import { isProtectedRelPath, PROTECTED_PATHS } from '../src/guardSession.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * A FILE THE GUARD IMPORTS DECIDES WHAT THE GUARD DOES.
 *
 * PROTECTED_PATHS was an enumeration: every entry is there because somebody
 * noticed it. The guard's import closure had quietly grown past it. Computed
 * 2026-09-18 across the guard binary and the Stop gate, eight local files were
 * reachable and three were unprotected -- src/safeGit.mjs (the guard runs git
 * through it), src/auditLedger.mjs (the audit-coverage reporter, which is the D5
 * finding an audit raised the same day) and src/actionAuthority.mjs (added by
 * the Action Authority wiring hours earlier, by the author of this test).
 *
 * WHY IT IS WORSE THAN A GAP IN COVERAGE. The guard binary fails CLOSED when a
 * module is missing -- "NOT INITIALISED ... the guard could not be loaded
 * (ERR_MODULE_NOT_FOUND). No snapshot was written" -- which is the right
 * direction and also means deleting ONE unprotected file takes the entire
 * control offline. Measured: that is exactly how this was discovered, when a new
 * import broke four baselining tests at once.
 *
 * SO THIS ASSERTS THE PROPERTY, NOT THE THREE NAMES. The lesson is the same one
 * the safeGit lint learned on the same day: a list of spellings is not the thing
 * you meant. Adding those three files closes today's hole; deriving the closure
 * is what stops the fourth import from reopening it, and nobody has to remember
 * a paragraph in a frozen array. CLAUDE.md rules 8 and 19.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ENTRY_POINTS = Object.freeze([
  'bin/agentbridge-claude-guard.mjs',
  'scripts/claude-stop-gate.mjs',
]);

/** Every local file reachable from the guard's entry points, repo-relative. */
function importClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    for (const spec of parseImports(src).specifiers) {
      const target = resolveSpecifier(REPO, rel, spec);
      if (!target) continue; // node: builtin or npm package, not ours to protect
      const t = target.split(path.sep).join('/');
      if (!seen.has(t)) queue.push(t);
    }
  }
  return [...seen].sort();
}

test('EVERY LOCAL FILE THE GUARD IMPORTS IS A PROTECTED PATH', () => {
  const closure = importClosure(ENTRY_POINTS);

  /*
   * RULE 5, AND IT IS NOT DECORATIVE. If parseImports stopped matching, or a
   * specifier form changed, the closure would shrink to the two entry points and
   * this test would pass by finding nothing to check -- silence reported as a
   * clean result, which is the exact failure the safeGit scan shipped with.
   */
  assert.ok(closure.length >= 6,
    `the closure resolved to ${closure.length} files, which is too few to be real -- `
    + 'import parsing has stopped working and an empty result proves nothing');
  for (const entry of ENTRY_POINTS) {
    assert.ok(closure.includes(entry), `${entry} must be in its own closure`);
  }
  assert.ok(closure.includes('src/claudeGuard.mjs'),
    'the closure must reach the guard module itself, or it is not following imports');

  const unprotected = closure.filter((f) => !isProtectedRelPath(f));
  assert.deepEqual(unprotected, [],
    'these files decide what the guard does and are writable without a grant. '
    + 'A guard whose dependency can be rewritten is not guarded, and because the binary fails to '
    + `load when one is missing, deleting any of them disables it outright:\n  ${unprotected.join('\n  ')}`);
});

test('THE ENTRY POINTS EXIST, so this does not pass by auditing nothing', () => {
  /*
   * A closure built from a path that does not exist is empty, and an empty
   * closure has no unprotected members. Rule 6: assert the precondition rather
   * than letting a missing file quietly satisfy the claim.
   */
  for (const entry of ENTRY_POINTS) {
    assert.ok(existsSync(path.join(REPO, entry)), `${entry} is missing`);
  }
});

test('THE PROTECTION IS REAL, not an artefact of matching everything', () => {
  /*
   * The negative half. If isProtectedRelPath returned true for every input, the
   * assertion above would pass while protecting nothing -- hollow gate 5, a
   * negative needs the positive first.
   */
  for (const ordinary of ['README.md', 'src/collect.mjs', 'test/e2e.test.mjs', 'docs/notes.md']) {
    assert.equal(isProtectedRelPath(ordinary), false,
      `${ordinary} is not a control and must not be protected, or the check means nothing`);
  }
  assert.equal(isProtectedRelPath('src/claudeGuard.mjs'), true,
    'and a real control must still be protected');
});

test('PROTECTED_PATHS names the guard dependencies explicitly, so a reader can see them', () => {
  /*
   * The derived check above is the control. This one exists so the list a person
   * READS is not silently narrower than the property a machine enforces -- the
   * gap between those two is what this whole file is about.
   */
  for (const dep of ['src/safeGit.mjs', 'src/auditLedger.mjs', 'src/actionAuthority.mjs']) {
    assert.ok(PROTECTED_PATHS.includes(dep),
      `${dep} is a guard dependency and belongs in the list a human reads, not only in the closure`);
  }
});
