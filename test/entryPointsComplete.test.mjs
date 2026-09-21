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
import { DEFAULT_ENTRY_POINTS, parseImports } from '../src/moduleGraph.mjs';

const SCRIPTS = new URL('../scripts/', import.meta.url);

/**
 * Scripts that import from src/ and are deliberately NOT entry points.
 *
 * A BARE PATH IS A SNOOZE BUTTON. Each entry is a sentence a later reader can
 * disagree with, exactly as `DEFAULT_ALLOWED_ORPHANS` requires -- because the
 * way a gate like this dies is somebody adding a line on a Friday and nobody
 * ever being able to tell whether it is still true.
 *
 * AND THE COMMIT THAT ADDED THIS CLAIMED THE MAP "MAY ONLY SHRINK". IT DOES
 * NOT, and nothing here makes it. Blind audit M-5. Staleness is checked -- an
 * exemption must still be an importer -- which is a DIFFERENT property, and
 * conflating the two is how a snooze button gets described as a ratchet.
 * Nothing prevents growth, so a thirty-one-character sentence still disarms
 * this gate for any one script. The honest statement is: growth is permitted
 * and visible in review, and that is the whole protection.
 *
 * Empty today, and that is the honest state: every script here is run by a
 * person, by npm, or by a hook.
 */
const NOT_AN_ENTRY_POINT = Object.freeze({});

/**
 * Scripts that import from src/ — ASKED OF THE SHIPPED PARSER, not re-matched.
 *
 * THIS HAND-ROLLED A REGEX NEXT TO THE PARSER THAT GETS IT RIGHT, which is the
 * finding and the irony together: the gate exists because a hand-typed sweep
 * kept being one spelling short, and it was itself a hand-typed sweep one
 * spelling wider. Blind audit M-4 enumerated what the regex missed:
 *
 *     import '../src/x.mjs';                side-effect: no `from`, no `(`
 *     import(someVariable)                  not a literal specifier at all
 *     import(new URL('../src/x.mjs', …))    and template-literal specifiers
 *
 * The repository USES the side-effect form — `test/noOrphanModules.test.mjs`
 * ships a fixture written for it. And `src/moduleGraph.mjs`, which this file
 * already imports for DEFAULT_ENTRY_POINTS, exports `parseImports`: it covers
 * every one of those forms and returns variable-argument dynamic imports
 * SEPARATELY as `dynamic`, so a specifier it cannot resolve is surfaced rather
 * than silently dropped.
 *
 * Rule 8 — fix the matcher, not the spelling somebody happened to notice. Ask
 * whatever owns the mapping.
 *
 * The comment blanking goes with the regex: `parseImports` handles comments
 * itself, and the old `/\/\*[\s\S]*?\*\//` also blanked a `/*` inside a string
 * or regex literal, which could eat live code with only an aggregate count to
 * notice.
 */
function importersOfSrc() {
  const found = [];
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.mjs')) continue;
    const { specifiers, dynamic } = parseImports(readFileSync(new URL(name, SCRIPTS), 'utf8'));
    /*
     * A NON-LITERAL DYNAMIC IMPORT COUNTS AS AN IMPORTER. It may resolve into
     * src/ and nothing here can tell. Counting it is the safe direction: the
     * worst it can do is demand a declaration a person then makes or exempts
     * with a reason, and the alternative is a silent blind spot.
     */
    if (dynamic.length || specifiers.some((s) => s.startsWith('../src/'))) {
      found.push(`scripts/${name}`);
    }
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

  /*
   * THE FLOOR IS DERIVED, NOT TYPED. This asserted `>= 10` against ~20 real
   * importers, so a parseImports regression that lost HALF the spellings would
   * still clear it — a constant that only catches a scan returning nothing.
   * Rule 21: ask the filesystem at run time.
   *
   * The independent measure is a crude text search for the specifier. It is
   * deliberately cruder than parseImports and will undercount (it cannot see a
   * dynamic import built from a variable), so it is a FLOOR and not an equality
   * — but it moves with the repository instead of with whoever typed 10.
   */
  const crude = readdirSync(SCRIPTS)
    .filter((n) => n.endsWith('.mjs'))
    .filter((n) => readFileSync(new URL(n, SCRIPTS), 'utf8').includes('../src/'))
    .length;
  assert.ok(crude > 0, 'even a crude text search finds no importer; the scan is broken, not the repository');
  assert.ok(importers.length >= crude,
    `parseImports found ${importers.length} importer(s) but a plain text search finds ${crude} — the parser is missing spellings`);
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

/**
 * The exemption rules, as a function so a FIXTURE can exercise them.
 *
 * THE RULES WERE WRITTEN AS LOOPS OVER AN EMPTY MAP AND ASSERTED NOTHING.
 * Blind audit M-5, measured: both tests passed having executed zero
 * assertions, so `> 30` could have been `> 3000` or deleted and the suite
 * would not have moved. A rule that has never been applied to a single input
 * is not a rule; it is a comment with a `test(` in front of it.
 *
 * Extracted so the real map and a hostile fixture go through the SAME code —
 * otherwise the fixture proves something about a copy.
 *
 * @returns array of complaints; empty means the map is well-formed
 */
export function exemptionFindings(map, importers) {
  const out = [];
  for (const [p, reason] of Object.entries(map)) {
    if (typeof reason !== 'string') { out.push(`${p} is exempted with no reason`); continue; }
    if (reason.trim().length <= 30) {
      out.push(`${p}'s exemption is too short to disagree with: ${JSON.stringify(reason)}`);
    }
    if (!importers.has(p)) {
      out.push(`${p} is exempted but no longer imports from src/ -- remove the entry`);
    }
  }
  return out;
}

test('THE EXEMPTION RULES FIRE, proven on a fixture rather than on an empty map', () => {
  /*
   * Rule 1 applied to a rule that had never been watched doing anything. Each
   * case is differenced against a well-formed entry, so a complaint cannot be
   * "everything is rejected".
   */
  const importers = new Set(['scripts/real.mjs']);
  const ok = { 'scripts/real.mjs': 'a reason long enough for a later reader to disagree with it' };
  assert.deepEqual(exemptionFindings(ok, importers), [],
    'a well-formed exemption was reported as a finding, so every rejection below proves nothing');

  assert.match(exemptionFindings({ 'scripts/real.mjs': null }, importers)[0] ?? '', /no reason/);
  assert.match(exemptionFindings({ 'scripts/real.mjs': 'too short' }, importers)[0] ?? '', /too short to disagree/);
  assert.match(exemptionFindings({ 'scripts/gone.mjs': ok['scripts/real.mjs'] }, importers)[0] ?? '', /no longer imports/);
});

test('THE REAL EXEMPTION MAP IS WELL-FORMED', () => {
  assert.deepEqual(exemptionFindings(NOT_AN_ENTRY_POINT, new Set(importersOfSrc())), []);
});
