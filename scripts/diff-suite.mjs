#!/usr/bin/env node
/**
 * RUN THE TESTS THE DIFF CAN ACTUALLY BREAK, NOT ALL OF THEM.
 *
 *   node scripts/diff-suite.mjs [--since <ref>] [--list] [--all-on-doubt]
 *
 * ═══ WHY ═══
 *
 * The full suite is ~537s against a ~400s Stop budget, on a machine that has
 * killed four background processes for memory today. Paying a full regression
 * sweep at every turn boundary -- including turns that changed a doc comment
 * -- is what starved the host. The suite and the audit do different jobs:
 *
 *   THE SUITE   a deterministic ratchet against BACKWARD motion. It caught a
 *               bare spawnSync('git'), two exports with no caller, and an
 *               over-broad classifier change today.
 *   THE AUDIT   an adversarial reader finding what nobody wrote a test for.
 *               It caught an ACE, a credential leak, two forged passes, and
 *               the suite's own 3x slowdown.
 *
 * A ratchet only has to cover what moved. Discovery is somebody else's job and
 * runs out of band.
 *
 * ═══ THE DANGER, AND WHAT IS DONE ABOUT IT ═══
 *
 * A scoped suite that misses a test is a FALSE GREEN, which is worse than
 * slow: it reports the ratchet held when nothing checked it. So:
 *
 *   IT FAILS CLOSED. If the graph cannot be built, or the diff cannot be
 *   read, it runs EVERYTHING and says why. "I could not work out the scope"
 *   must never render as "nothing to run" -- that is the failed-lookup-looks-
 *   like-success shape this repository is built against.
 *
 *   TRANSITIVE, NOT BY NAME. A test is selected if the changed file is
 *   anywhere in its import closure, asked of src/moduleGraph.mjs -- the module
 *   that already owns import resolution. Matching `src/foo.mjs` to
 *   `test/foo.test.mjs` by filename would miss every test that reaches a
 *   module indirectly, which is most of them.
 *
 *   THE GLOBAL GATES ALWAYS RUN. deadExports, noOrphanModules, safeGit,
 *   entryPointsParse and protectedPathParity SCAN THE WHOLE REPOSITORY rather
 *   than importing what they check, so no import edge connects them to a
 *   change. They are exactly the ones a diff-scoped run would silently drop --
 *   and they are the ones that caught me today.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 || i + 1 >= argv.length ? d : argv[i + 1];
};

const say = (s) => process.stderr.write(`${s}\n`);

/**
 * Gates that read the repository rather than importing it.
 *
 * NOT AN OPTIMISATION EXEMPTION -- THE OPPOSITE. These have no import edge to
 * anything, so a purely graph-driven selection drops all of them, and they are
 * the whole-repo invariants: an unrouted git call, an export with no caller, a
 * declared entry point that no longer parses. Dropping them would make the
 * scoped run green on precisely the changes they exist to catch.
 */
const ALWAYS = [
  'test/deadExports.test.mjs',
  'test/noOrphanModules.test.mjs',
  'test/safeGit.test.mjs',
  'test/entryPointsParse.test.mjs',
  'test/protectedPathParity.test.mjs',
  'test/guardDependenciesProtected.test.mjs',
].filter((t) => existsSync(path.join(REPO, t)));

const { runGit } = await import('../src/safeGit.mjs');

/** What changed: working tree against HEAD, or against an explicit ref. */
function changedFiles() {
  const since = flag('--since');
  try {
    const args = since ? ['diff', '--name-only', since] : ['diff', '--name-only', 'HEAD'];
    const tracked = String(runGit(args, { cwd: REPO })).split('\n').map((s) => s.trim()).filter(Boolean);
    const untracked = String(runGit(['ls-files', '--others', '--exclude-standard'], { cwd: REPO }))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    return { ok: true, files: [...new Set([...tracked, ...untracked])] };
  } catch (e) {
    return { ok: false, why: String(e?.stderr || e?.message || e).trim() };
  }
}

const diff = changedFiles();
if (!diff.ok) {
  say(`[diff-suite] could not read the diff (${diff.why}). Running EVERYTHING rather than guessing a scope.`);
  process.exit(spawnSync('npm', ['test'], { cwd: REPO, stdio: 'inherit', shell: true }).status ?? 1);
}

if (diff.files.length === 0) {
  say('[diff-suite] nothing changed against HEAD. Running only the whole-repo gates.');
}

let selected;
try {
  const { buildGraph } = await import('../src/moduleGraph.mjs');
  const { graph } = buildGraph(REPO);

  const changed = new Set(diff.files.map((f) => f.split(path.sep).join('/')));

  /*
   * A TEST IS SELECTED IF ANY CHANGED FILE IS IN ITS IMPORT CLOSURE. Walked
   * per test rather than inverted, because the graph is small and an inverted
   * index would be a second representation of the same edges.
   */
  const closureHits = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      if (changed.has(cur)) return true;
      for (const next of graph.get(cur) ?? []) queue.push(next);
    }
    return false;
  };

  const tests = [...graph.keys()].filter((f) => f.startsWith('test/') && f.endsWith('.test.mjs'));
  const hit = tests.filter((t) => changed.has(t) || closureHits(t));
  selected = [...new Set([...ALWAYS, ...hit])].sort();
} catch (e) {
  say(`[diff-suite] could not build the import graph (${e?.message ?? e}). Running EVERYTHING.`);
  process.exit(spawnSync('npm', ['test'], { cwd: REPO, stdio: 'inherit', shell: true }).status ?? 1);
}

say(`[diff-suite] ${diff.files.length} changed file(s) -> ${selected.length} test file(s)`);
for (const f of diff.files.slice(0, 12)) say(`    changed: ${f}`);
if (diff.files.length > 12) say(`    ...and ${diff.files.length - 12} more`);

if (LIST) {
  for (const t of selected) process.stdout.write(`${t}\n`);
  process.exit(0);
}

/*
 * THE COUNT IS THE EVIDENCE, NOT THE EXIT CODE. A non-zero exit says a process
 * was unhappy; it does not say a test ran. node --test prints the totals and
 * this passes them straight through, so the reader sees how much was measured
 * as well as whether it passed.
 */
const r = spawnSync(process.execPath, ['--test', ...selected], { cwd: REPO, stdio: 'inherit' });
process.exit(r.status ?? 1);
