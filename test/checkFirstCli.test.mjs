import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));

async function cf(args, cwd = REPO) {
  try {
    const { stdout } = await run(process.execPath, [CLI, 'check-first', ...args], { cwd, maxBuffer: 32e6 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) { return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }; }
}

test('a topic that HAS prior work says so rather than shrugging', async () => {
  /*
   * ASSERT THE BEHAVIOUR, NOT A PARTICULAR BRANCH — this test failed in a fresh
   * clone and the tool was right.
   *
   * It used to require the string "liveness-from-activity", the branch that
   * duplicated my work. Cloned from a bundle carrying only five branches, that
   * branch is absent and the assertion failed while check-first was working
   * perfectly: it still found the prior work through COMMITS, which is the
   * behaviour that matters and the one that survives anywhere.
   *
   * Pinning a test to a branch that exists on one remote is the same defect
   * class this repository keeps finding — green on the machine it was written
   * on, red on a clean checkout, for a reason that says nothing about the code.
   * The topic below matches committed history, which travels with the clone.
   */
  const r = await cf(['roster liveness heartbeat', '--hours', '24']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /SOMEBODY MAY ALREADY BE ON THIS/, 'prior work exists in history and must be reported');
  assert.match(r.stdout, /prior work matching/, 'and the matches must be listed, not merely counted');
  const matches = r.stdout.split('prior work matching')[1] ?? '';
  assert.ok(/\[\d+\]\s+(commit|branch)\s+\S+/.test(matches),
    `at least one scored match must be named; got:\n${matches.slice(0, 300)}`);
});

test('a topic with no prior work does NOT cry wolf', async () => {
  const r = await cf(['zzqqxx wombat telegraph', '--hours', '24']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.includes('SOMEBODY MAY ALREADY BE ON THIS'), false);
  assert.match(r.stdout, /\(none\)/);
});

test('an unreadable path contract degrades the overlap, not the topic verdict', async () => {
  /*
   * REGRESSION, 2026-09-17. The overlap check pushed its per-branch failures
   * into the same `errors` array that decides whether the PRIOR-WORK lookup can
   * be trusted. This repository has a branch, `main`, whose history is unrelated
   * to master, so `git merge-base main HEAD` fails as an ordinary condition --
   * and that one shrug marked the entire topic lookup UNKNOWN and exited 2.
   *
   * Two questions, two error channels. A branch whose contract cannot be read
   * is reported as unchecked and counted; it never votes on whether the topic
   * answer is sound.
   */
  const r = await cf(['roster liveness heartbeat', '--json']);
  const d = JSON.parse(r.stdout);
  assert.notEqual(d.verdict, 'unknown', 'a path-read failure must not void the topic answer');
  assert.equal(r.code, 0);
  assert.ok(Array.isArray(d.pathErrors), 'path failures are surfaced on their own channel');
  assert.ok(Array.isArray(d.overlaps), 'and overlaps remain a first-class field');
  assert.equal(
    typeof d.unreadableFronts,
    'number',
    'branches that could not be checked are COUNTED, never silently treated as clean',
  );
});

test('a flag value is not swallowed into the topic', async () => {
  // `check-first roster --hours 24` must not search for "roster 24".
  const r = await cf(['roster', '--hours', '24', '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(d.topic, 'roster', 'the flag value must not become part of the topic');
  assert.equal(d.hours, 24);
});

test('an unreachable server reports UNKNOWN and exits 2, never "nothing found"', async () => {
  const r = await cf(['roster liveness'], '/');
  assert.equal(r.code, 2, 'a failed lookup must not exit 0');
  assert.match(r.stderr + r.stdout, /LOOKUP INCOMPLETE|cannot|error/i);
  assert.equal(/\bSOMEBODY MAY ALREADY BE ON THIS\b/.test(r.stdout), false);
});

test('--hours refuses a value it cannot use', async () => {
  const r = await cf(['roster', '--hours', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--hours/);
});

test('STRUCTURAL: the check-first read path never touches FETCH_HEAD', async () => {
  /*
   * THE CONCURRENCY TEST BELOW IS REAL BUT PROBABILISTIC, AND I WATCHED IT MISS.
   * Restoring the fetch-then-read-FETCH_HEAD loop left it GREEN: two processes
   * raced by Promise.all do not reliably collide, while the same loop diverged
   * three pairs out of three when driven from a shell. A gate that catches a
   * regression sometimes is one that reports a pass on the run that mattered.
   *
   * So the mechanism is asserted instead of the symptom. FETCH_HEAD is shared
   * mutable state in the repository; a read path that writes it cannot be
   * concurrency-safe no matter what a timing test happens to observe. This is
   * deterministic, and it goes red the instant the loop comes back.
   */
  const src = await readFile(CLI, 'utf8');
  const start = src.indexOf("if (cmd === 'check-first')");
  assert.ok(start > 0, 'the check-first handler must be findable');
  const end = src.indexOf("if (cmd === 'who')", start);
  assert.ok(end > start, 'the handler boundary must be findable');
  /*
   * COMMENTS ARE STRIPPED FIRST, and the first version of this test did not do
   * that -- so it failed against the CORRECT code, matching the comment above
   * the fix that explains what FETCH_HEAD is and why the loop was removed. A
   * source-grep gate that fires on its own documentation of a bug is useless in
   * both directions: red when right, and silently encouraging the next person
   * to delete the explanation rather than the defect.
   */
  const handler = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, ' ');

  assert.equal(/FETCH_HEAD/.test(handler), false,
    'check-first must not read FETCH_HEAD: it is shared, so two agents asking at once get different answers');
  assert.equal(/'fetch'/.test(handler), false,
    'check-first must not fetch: its read path must not write to the repository at all');
  assert.ok(/ls-remote/.test(handler), 'it must still ask the server, which is the whole point of the command');
});

test('CONCURRENT runs give the same answer — two agents at once is the normal case', async () => {
  /*
   * THE DEFECT THIS REPLACED WAS THE TOOL BEING WRONG ABOUT ITS ONLY QUESTION.
   *
   * check-first used to run `git fetch origin <name>` per branch and read
   * FETCH_HEAD, which is SHARED. Two processes in one repository clobbered each
   * other. Measured before the fix: three concurrent pairs, three divergences,
   * including one pair where one process printed SOMEBODY MAY ALREADY BE ON
   * THIS and its twin did not, and exit codes of 0 and 2 for identical input.
   *
   * A tool that tells you whether somebody is already working on something, and
   * gives two answers when two people ask at once, is worse than no tool --
   * concurrency is the condition it exists for, not an edge case.
   *
   * The fix is that nothing in the read path writes: the sha comes from
   * ls-remote and metadata is read from local objects. Watch this fail by
   * restoring the fetch-then-read-FETCH_HEAD loop.
   */
  const [a, b] = await Promise.all([
    cf(['roster liveness', '--hours', '6']),
    cf(['roster liveness', '--hours', '6']),
  ]);
  assert.equal(a.code, b.code, `same input must give the same exit code; got ${a.code} and ${b.code}`);
  assert.equal(a.stdout, b.stdout, 'same input must give the same answer when two agents ask at once');
});

test('it is in HELP and the checklist is in CLAUDE.md', async () => {
  assert.match(await readFile(CLI, 'utf8'), /agentbridge check-first <topic>/);
  const md = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  assert.match(md, /check-first/, 'the checklist must name the command');
  assert.match(md, /ls-remote/, 'and must say to ask the server, since stale refs caused the duplication');
});
