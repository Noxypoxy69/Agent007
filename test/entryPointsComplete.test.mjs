/**
 * A SCRIPT THAT IMPORTS FROM src/ IS DECLARED, OR IT IS EXEMPTED WITH A REASON.
 *
 * ═══ WHY THIS EXISTS: THE SAME INCIDENT FOUR TIMES ═══
 *
 * `DEFAULT_ENTRY_POINTS` is the only thing that can tell an entry point from an
 * orphan, because a `scripts/` file invoked by a person, npm or a hook is
 * imported by nothing and looks identical to dead code from the graph. And
 * CLAUDE.md rule 10 tells everyone to keep moving decision logic OUT of scripts
 * and INTO src/ so the suite can reach it.
 *
 * Those two pull against each other by construction. Every extraction rule 10
 * asks for orphans its new module until the calling script is declared:
 *
 *     src/auditWorkspace.mjs     caller scripts/audit-daemon.mjs
 *     src/auditWindow.mjs        caller scripts/check-audit-coverage.mjs
 *     src/watcherIdentity.mjs    caller scripts/bridge-session-poll.mjs
 *     src/suiteSummary.mjs       caller scripts/audit-workspace.mjs
 *
 * Four times, each fixed by hand-adding that one caller, each with a comment
 * predicting the next -- and the predictions were right and did not help. A
 * blind auditor made the point that ended it: nine MORE scripts imported from
 * src/ undeclared, two named in package.json, latent only because nothing was
 * exclusively reachable through them yet.
 *
 * ═══ WHY THIS GATE AND NOT A DERIVED LIST ═══
 *
 * Deriving `DEFAULT_ENTRY_POINTS` automatically would defeat its purpose. The
 * list's own header says an entry point and an orphan are indistinguishable
 * from the graph, so "the difference has to be stated by a person" -- and a
 * list that states itself states nothing. Auto-declaring every script would
 * also silently make anything reachable from a probe count as shipped.
 *
 * So the person still decides. What changes is that FORGETTING is no longer
 * silent: an undeclared importer fails here, by name, instead of surfacing
 * later as a mystery orphan in an unrelated module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_ENTRY_POINTS } from '../src/moduleGraph.mjs';

const SCRIPTS = new URL('../scripts/', import.meta.url);

/**
 * Scripts that import from src/ and are deliberately NOT entry points.
 *
 * A BARE PATH IS A SNOOZE BUTTON. Each entry is a sentence a later reader can
 * disagree with, exactly as `DEFAULT_ALLOWED_ORPHANS` requires -- because the
 * way a gate like this dies is somebody adding a line on a Friday and nobody
 * ever being able to tell whether it is still true.
 *
 * Empty today, and that is the honest state: every script here is run by a
 * person, by npm, or by a hook.
 */
const NOT_AN_ENTRY_POINT = Object.freeze({});

/** Scripts whose source contains a relative import from src/. */
function importersOfSrc() {
  const found = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.mjs')) continue;
    /*
     * COMMENT-BLANKED BEFORE MATCHING (rule 13). A script DISCUSSING
     * `../src/foo.mjs` in prose is not an importer, and this file's whole
     * subject is comments about src/ modules -- so matching raw source would
     * make this gate fire on documentation.
     */
    const src = readFileSync(new URL(name, SCRIPTS), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/(?:from|import\()\s*['"]\.\.\/src\//.test(src)) found.push(`scripts/${name}`);
  }
  return found.sort();
}

test('THE FIXTURE IS REAL: scripts do import from src, and this gate can see them', () => {
  /*
   * Rule 5, and the specific way this file could go hollow: if the blanking or
   * the pattern stopped matching, `importersOfSrc()` returns [] and every
   * assertion below passes by looking at nothing.
   */
  const importers = importersOfSrc();
  assert.ok(importers.length >= 10,
    `only ${importers.length} importer(s) found; the scan is broken, not the repository`);
  assert.ok(importers.includes('scripts/audit-workspace.mjs'),
    'a known importer was not detected, so this gate is reading the wrong thing');
});

test('EVERY SCRIPT THAT IMPORTS FROM src/ IS DECLARED OR EXEMPTED', () => {
  const declared = new Set(DEFAULT_ENTRY_POINTS);
  const undeclared = importersOfSrc()
    .filter((p) => !declared.has(p) && !Object.hasOwn(NOT_AN_ENTRY_POINT, p));

  assert.deepEqual(undeclared, [],
    'these scripts import from src/ but are neither declared entry points nor exempted. '
    + 'Something they import EXCLUSIVELY will be reported as an orphan the moment it exists. '
    + 'Add them to DEFAULT_ENTRY_POINTS, or to NOT_AN_ENTRY_POINT with a reason.');
});

test('AN EXEMPTION WITHOUT A REASON IS ITSELF A FINDING', () => {
  /*
   * Same rule the orphan allowlist enforces. Checked even while the map is
   * empty, so the constraint is in place before the first entry is added --
   * which is when nobody is thinking about it.
   */
  for (const [p, reason] of Object.entries(NOT_AN_ENTRY_POINT)) {
    assert.equal(typeof reason, 'string', `${p} is exempted with no reason`);
    assert.ok(reason.trim().length > 30,
      `${p}'s exemption is too short to disagree with: ${JSON.stringify(reason)}`);
  }
});

test('AN EXEMPTION FOR A SCRIPT THAT NO LONGER IMPORTS src/ IS STALE', () => {
  /*
   * The list may only SHRINK, the same property noOrphanModules pins for its
   * allowlist. A stale exemption is a standing permission nobody can evaluate.
   */
  const importers = new Set(importersOfSrc());
  for (const p of Object.keys(NOT_AN_ENTRY_POINT)) {
    assert.ok(importers.has(p), `${p} is exempted but no longer imports from src/ -- remove the entry`);
  }
});
