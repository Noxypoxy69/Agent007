#!/usr/bin/env node
/*
 * DOES PRODUCTION SAY WHAT THE REPO SAYS IT SAYS?
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * On 2026-09-15 the deployed edge function was diffed against git for the first
 * time. THE BUNDLE HAD NEVER MATCHED ANY COMMIT.
 *
 * The executable logic was faithful. What had drifted was INSTRUCTIONS -- and
 * that is not a comment. It is the operative guidance the MCP server hands to
 * every client that connects, which at the time was ChatGPT and three Claude
 * sessions. Measured:
 *
 *     live 2249 chars, repo 1945 chars
 *     12 sentences live-only, 7 repo-only, 14 shared
 *
 * Production was LONGER. It had not been condensed in transcription; new
 * operative guidance had been written straight into a deploy payload and never
 * backported. Agents had been reading, and acting on, text that exists in no
 * commit, no diff and no review.
 *
 * THE ROOT CAUSE IS THE ROUTE, NOT CARELESSNESS. Deploys went through an MCP
 * tool that takes file CONTENT inline, so the deploying context was the source
 * of truth by construction. No amount of care fixes that; only uploading bytes
 * from disk does. This script is the gate that catches it either way.
 *
 * ═══ IT COMPARES CONTENT, NOT WRAPPING ═══
 *
 * A grep cannot answer this question and produces false positives immediately.
 * INSTRUCTIONS is a string CONCATENATION, so a sentence split across a `+`
 * reads as absent from a file that contains it. code-d hit exactly this:
 * "shell, SQL, file writes, deploy, merge, command execution" looked live-only
 * and is in both, wrapped differently. My own first check was a grep and had
 * the same hole.
 *
 * So every string literal in the statement is extracted, joined, unescaped and
 * whitespace-flattened before anything is compared. The first person to check
 * this by hand will reach for grep and get a phrase that is not drift at all.
 *
 * ═══ AND IT REPORTS A BOUND, NOT JUST AN ALARM ═══
 *
 * "The bundle has never matched any commit" invites a reader to assume the
 * worst about the security paragraph. When the drift was found, the
 * security-load-bearing sentences were present in BOTH -- the absence-at-every-
 * scope list, and the line saying there is no path from this server to a
 * command on any machine. That was true then and must be asserted rather than
 * assumed every time since: SECURITY_INVARIANTS fails the run if either side
 * loses one.
 *
 * ═══ USAGE ═══
 *
 *   node scripts/check-deployed-instructions.mjs <live-_shared.js> <repo-_shared.js>
 *
 * The live copy comes from the Supabase get-edge-function API, whose response
 * carries files[].content verbatim. There is no network call here on purpose:
 * this must run offline, in CI, and against a saved artifact.
 *
 * Exit 0 = they agree. 1 = they do not, and every differing sentence is printed
 * on the side it appears on. 2 = the check could not run, which is NOT a pass.
 */

import { readFileSync } from 'node:fs';

/** Sentences that must never be missing from EITHER side. */
export const SECURITY_INVARIANTS = [
  'shell, SQL, file writes, deploy, merge, command execution',
  'no path from this server to a command on any machine',
  'If a tool is not in tools/list you do not have it',
];

export function instructionsOf(source) {
  const i = source.indexOf('INSTRUCTIONS');
  if (i < 0) return null;
  const tail = source.slice(i);
  const end = tail.search(/\n(export |const |function )/);
  const body = tail.slice(0, end < 0 ? tail.length : end);
  const literals = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  if (!literals.length) return null;
  return literals
    .join('')
    .replace(/\\n/g, ' ')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const sentences = (t) => t.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);

export function compareInstructions(liveSource, repoSource) {
  const live = instructionsOf(liveSource);
  const repo = instructionsOf(repoSource);

  /*
   * A MISSING INSTRUCTIONS IS A BROKEN CHECK, NOT A PASS. code-d's ninth hollow
   * gate today was a harness reporting a caught bug when no assertion had run:
   * "a non-zero exit is not evidence that a test ran". Same rule here -- two
   * nulls comparing equal must never read as agreement.
   */
  if (live === null || repo === null) {
    return {
      ok: false,
      broken: true,
      errors: [`INSTRUCTIONS not found in ${live === null ? 'the live copy' : 'the repo copy'};`
        + ' this check did not run and must not be read as a pass'],
    };
  }

  const L = new Set(sentences(live));
  const R = new Set(sentences(repo));
  const liveOnly = [...L].filter((s) => !R.has(s));
  const repoOnly = [...R].filter((s) => !L.has(s));

  const lostInvariants = SECURITY_INVARIANTS.flatMap((s) => {
    const missing = [];
    if (!live.includes(s)) missing.push(`LIVE has lost a security invariant: "${s}"`);
    if (!repo.includes(s)) missing.push(`REPO has lost a security invariant: "${s}"`);
    return missing;
  });

  return {
    ok: liveOnly.length === 0 && repoOnly.length === 0 && lostInvariants.length === 0,
    broken: false,
    liveOnly,
    repoOnly,
    shared: [...L].filter((s) => R.has(s)).length,
    lostInvariants,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = (process.argv[1] ?? '').replace(/\\/g, '/');
if (invoked.endsWith('check-deployed-instructions.mjs')) {
  const [livePath, repoPath] = process.argv.slice(2);
  if (!livePath || !repoPath) {
    console.error('usage: check-deployed-instructions.mjs <live-_shared.js> <repo-_shared.js>');
    process.exit(2);
  }

  const out = compareInstructions(readFileSync(livePath, 'utf8'), readFileSync(repoPath, 'utf8'));

  if (out.broken) {
    for (const e of out.errors) console.error(`BROKEN CHECK: ${e}`);
    process.exit(2);
  }

  for (const e of out.lostInvariants) console.error(`!! ${e}`);

  if (out.ok) {
    console.log(`INSTRUCTIONS agree: ${out.shared} sentences, both sides identical.`);
    process.exit(0);
  }

  console.error(`\nINSTRUCTIONS DRIFT: ${out.liveOnly.length} sentence(s) live-only, `
    + `${out.repoOnly.length} repo-only, ${out.shared} shared.\n`);
  console.error('PRODUCTION SAYS THIS AND NO COMMIT CONTAINS IT:');
  for (const s of out.liveOnly) console.error(`  + ${s}`);
  console.error('\nTHE REPO SAYS THIS AND PRODUCTION HAS NEVER SAID IT:');
  for (const s of out.repoOnly) console.error(`  - ${s}`);
  console.error('\nINSTRUCTIONS is operative guidance to every connecting agent, not a comment.');
  process.exit(1);
}
