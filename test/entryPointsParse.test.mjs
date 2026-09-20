/**
 * A PROGRAM THAT DOES NOT PARSE MUST NEVER REACH A BEHAVIOURAL TEST.
 *
 * bin/agentbridge.mjs was committed with a SyntaxError and stayed broken for
 * three commits. A word quoted in backticks inside the help template literal
 * closed the literal, and the rest of the help became code:
 *
 *     node --check bin/agentbridge.mjs
 *     SyntaxError: Unexpected identifier 'observed'    line 192
 *
 * Every entry point that shells out to the CLI was dead for those three
 * commits, including `register-session`, which the SessionStart poll hook
 * spawns -- so sessions silently stopped registering and the roster emptied.
 * The symptom was read as a liveness problem for hours.
 *
 * WHY IT SURVIVED, CORRECTED. I first wrote here that the existing suites
 * stayed green because they assert on stdout and a dead process produces
 * none. A blind audit measured that and it is FALSE -- with the broken CLI
 * restored, taskChecklistCli goes 0 pass / 6 fail and cliDiscoverable 2/1.
 * They were never hollow. I reproduced it before accepting it.
 *
 * The outage survived three commits because NOBODY RAN THE SUITE, including
 * me. This gate does not fix that and must not be read as fixing it.
 *
 * It is still worth having for a different and smaller reason: it is the
 * cheapest possible question, it needs no fixture, and it answers before any
 * behavioural test spends a second -- a program that cannot parse should
 * never reach one. Verified against real history: green at cba3c0d, red at
 * 1a1a35c and the two commits after, green at the fix.
 *
 * So this gate asks the cheapest possible question, structurally, and asks it
 * of the DECLARED list rather than a list typed here: does every shipped
 * entry point parse? It costs milliseconds and it cannot be satisfied by
 * output, because it never runs the program.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENTRY_POINTS } from '../src/moduleGraph.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `node --check` on one file: parses, or the reason it does not.
 *
 * THE WHOLE STDERR IS KEPT, and the first version of this truncated it to
 * three lines -- which is where node echoes the offending SOURCE, not the
 * diagnosis. The assertion looking for "SyntaxError" therefore failed on a
 * fixture that had failed to parse exactly as intended. Truncation belongs
 * at the point of display, never at the point of measurement.
 */
function parses(abs) {
  const r = spawnSync(process.execPath, ['--check', abs],
    { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, err: String(r.stderr ?? '').trim() };
}

/** One line of it, for a message a person has to read. */
const brief = (err) => err.split('\n').find((l) => /Error/.test(l))?.trim()
  ?? err.split('\n')[0]?.trim() ?? '(no stderr)';

test('EVERY DECLARED ENTRY POINT PARSES', () => {
  /*
   * DERIVED FROM DEFAULT_ENTRY_POINTS, not typed here (rule 7). An entry
   * point added tomorrow is covered the day it is added, with nobody
   * remembering to extend this file.
   */
  assert.ok(DEFAULT_ENTRY_POINTS.length >= 10,
    `only ${DEFAULT_ENTRY_POINTS.length} entry points declared -- this gate is not covering the repo`);

  const broken = [];
  for (const rel of DEFAULT_ENTRY_POINTS) {
    const abs = path.join(REPO, rel);
    /*
     * A MISSING ENTRY POINT IS A FINDING, NOT A SKIP. Silently passing over
     * a file that is not there is how a declared-but-deleted executable
     * stops being checked by anything.
     */
    if (!existsSync(abs)) { broken.push(`${rel}: declared but does not exist`); continue; }
    const r = parses(abs);
    if (!r.ok) broken.push(`${rel}: ${brief(r.err)}`);
  }

  assert.deepEqual(broken, [],
    `a shipped entry point does not parse, so nothing it provides works:\n  ${broken.join('\n  ')}`);
});

test('the check can FAIL, so a green result means something (rule 1)', (t) => {
  /*
   * Without this, a `parses()` that always returned ok would satisfy the test
   * above forever. The fixture reproduces the real defect rather than an
   * arbitrary one: a backtick closing a template literal early.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'entrycheck-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const good = path.join(dir, 'good.mjs');
  writeFileSync(good, 'const HELP = `usage: thing --flag`;\nexport default HELP;\n');
  assert.equal(parses(good).ok, true, 'the control file must parse');

  const bad = path.join(dir, 'bad.mjs');
  writeFileSync(bad, 'const HELP = `usage:\n  the record is `observed` and cannot pass\n`;\nexport default HELP;\n');
  const r = parses(bad);
  assert.equal(r.ok, false, 'a backtick inside a template literal must be caught');
  assert.match(r.err, /SyntaxError/, brief(r.err));
});

test('THE REAL REGRESSION: the shipped CLI parses, and its help is a template literal', () => {
  /*
   * The specific file, named, because a list-driven test says "one of
   * thirteen is wrong" and the next reader deserves the name. This is also
   * the positive control for the fix: the help text still IS a template
   * literal, so the hazard is live and the gate is load-bearing rather than
   * guarding a shape that no longer exists.
   */
  const cli = path.join(REPO, 'bin', 'agentbridge.mjs');
  const r = parses(cli);
  assert.equal(r.ok, true, `bin/agentbridge.mjs does not parse: ${brief(r.err)}`);

  const src = readFileSync(cli, 'utf8');
  assert.match(src, /const HELP = `/,
    'the help is no longer a template literal -- if that is deliberate, this note is stale');
});
