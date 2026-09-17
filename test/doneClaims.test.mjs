import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../', import.meta.url));
const ORDER = new URL('../docs/ORDER.md', import.meta.url);

/**
 * A CLAIM THAT SOMETHING IS DONE MUST CARRY EVIDENCE, OR IT IS A RUMOUR.
 *
 * Two of this map's own claims were wrong on 2026-09-16, in both directions:
 *
 *   Item 1 said "nothing below can start until the pipeline is on master". It
 *   had been on master for hours. The whole queue sat behind a blocker that had
 *   already cleared, because the document said not to bother looking.
 *
 *   Item 3 said "BUILT AND WIRED", crediting me with the wiring. The attempts
 *   table held zero rows, and runAttempt is imported by exactly one file that
 *   nothing spawns. It was built. It was never wired. I wrote that line.
 *
 * Both are the same failure: a state written once by hand and then believed,
 * with no way to notice it had drifted. Nothing re-measured because nothing
 * could -- prose has no handle to check.
 *
 * THIS GATE IS PARTIAL AND THE NUMBER IS WRITTEN DOWN SO NOBODY OVER-TRUSTS IT.
 * It matches a FORMAT -- `**N. ~~thing~~ DONE` -- and across every document in
 * this repository it sees four claims, while ORDER.md alone carries thirty-seven
 * state-ish lines. Two genuinely stale claims (a table cell reading "still v20"
 * against a live v26, and a sentence saying "deployed version 20 right now")
 * were invisible to it, because prose has infinite shapes and a regex has one.
 * Widening it chases an infinite set. The complementary gate is
 * test/measurableStateInProse.test.mjs, which lints the rot-prone VALUE rather
 * than the sentence, and that is the direction that scales.
 *
 * So a done-claim needs an EVIDENCE line, and the git-checkable kinds are
 * re-verified on every run. `unverifiable` is allowed on purpose, because
 * forcing a machine-checkable token where none exists produces a fake one; it
 * must carry a real reason, and that reason is what a reader argues with.
 */

const CLAIM = /^\*\*[0-9A-Za-z]+\.\s.*(?:~~|DONE|BUILT|ALREADY|CLOSED)/;
const EVIDENCE = /^EVIDENCE:\s+(commit|merged|unverifiable)\s+(.+)$/;

async function claims() {
  const lines = (await readFile(ORDER, 'utf8')).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!CLAIM.test(lines[i])) continue;
    // Evidence belongs to the claim it follows: scan forward to the next claim.
    const found = [];
    for (let j = i + 1; j < lines.length && !CLAIM.test(lines[j]); j += 1) {
      const m = lines[j].match(EVIDENCE);
      if (m) found.push({ kind: m[1], value: m[2].trim() });
    }
    out.push({ line: i + 1, text: lines[i], evidence: found });
  }
  return out;
}

test('the map still contains claims of doneness — otherwise this gate is decoration', async () => {
  const all = await claims();
  assert.ok(all.length >= 3, `expected the map to claim things are done, found ${all.length}`);
});

test('EVERY claim that something is done carries evidence', async () => {
  const missing = (await claims()).filter((c) => c.evidence.length === 0);
  assert.deepEqual(
    missing.map((c) => `ORDER.md:${c.line} ${c.text.slice(0, 70)}`),
    [],
    'a done-claim with no EVIDENCE line is a rumour; add EVIDENCE: commit <sha> | merged <ref> | unverifiable <reason>',
  );
});

test('every git-checkable piece of evidence still holds, re-measured now', async (t) => {
  const failures = [];
  /*
   * A SHALLOW CLONE CANNOT ANSWER THIS, AND MUST NOT GUESS.
   *
   * `merge-base --is-ancestor` walks the graph. Truncate the graph and it
   * returns FALSE for a commit that IS an ancestor -- not an error, a wrong
   * answer. That turned this gate red on five consecutive master runs and
   * named six commits as unmerged when all six were merged, which is a control
   * accusing a correct repository. Under CLAUDE.md's own rule, a shallow clone
   * makes this UNKNOWN, and unknown is not "not done".
   *
   * CI now checks out with fetch-depth 0. This refuses loudly if anything else
   * ever runs it shallow, because a silent skip renders "I could not check"
   * identically to "I checked and it was fine".
   */
  const { stdout: shallow } = await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO });
  if (shallow.trim() === 'true') {
    return t.skip('NOT CHECKED: this clone is shallow, so ancestry is unknowable here. '
      + 'A truncated graph reports a merged commit as NOT an ancestor, which is a wrong '
      + 'answer rather than a missing one. Re-run with full history (fetch-depth 0).');
  }

  for (const c of await claims()) {
    for (const e of c.evidence) {
      if (e.kind === 'unverifiable') continue;
      const ref = e.value.split(/\s+/)[0];
      try {
        await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO });
      } catch {
        failures.push(`ORDER.md:${c.line} ${e.kind} ${ref} — no such commit`);
        continue;
      }
      try {
        await run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: REPO });
      } catch {
        failures.push(`ORDER.md:${c.line} ${e.kind} ${ref} — NOT an ancestor of HEAD, so it is not done here`);
      }
    }
  }
  assert.deepEqual(failures, [], 'evidence must still hold when re-measured, not when it was written');
});

test('an unverifiable claim must say WHY, at length — a blank reason is a shrug', async () => {
  const thin = [];
  for (const c of await claims()) {
    for (const e of c.evidence) {
      if (e.kind === 'unverifiable' && e.value.length < 20) {
        thin.push(`ORDER.md:${c.line} unverifiable "${e.value}"`);
      }
    }
  }
  assert.deepEqual(thin, [], 'say what cannot be checked and why, so a reader can disagree with it');
});
