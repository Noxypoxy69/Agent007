#!/usr/bin/env node
/**
 * RUN THE TESTS THE DIFF CAN ACTUALLY BREAK, NOT ALL OF THEM.
 *
 *   node scripts/diff-suite.mjs [--since <ref>] [--list]
 *
 * `--all-on-doubt` used to be documented here and was never implemented --
 * blind audit D-F. Running everything on doubt is UNCONDITIONAL: an
 * unreadable diff or an import graph that will not build both fall back to
 * `npm test`, and neither is optional, because a scoping tool that narrows
 * when it is confused is the whole failure this file exists to avoid. A flag
 * offering to turn that off would have been a footgun; a documented flag that
 * does not exist is just a refusal waiting to confuse somebody, which is what
 * it became when the parser started refusing unknown arguments.
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

/**
 * AN UNRECOGNISED FLAG IS AN ERROR, NOT A DEFAULT.
 *
 * Measured 2026-09-20: `--since` is the flag and somebody invoked
 * `--base 553724b`. Nothing complained. The unknown pair was ignored, the
 * scope silently fell back to "working tree against HEAD", and the run
 * reported 66/66 GREEN having selected SIX of the thirty-three test files the
 * real range needed. A narrower green than you asked for, announced as a
 * pass.
 *
 * That is the hollow-gate signature exactly: the check ran, concluded
 * cheerfully, and proved something other than what was asked. And it is worse
 * on a scoping tool than anywhere else, because the whole point of this script
 * is to decide what gets checked -- a silent mis-scope removes coverage
 * everywhere downstream while looking like a fast suite.
 *
 * Strict, and deliberately so: this is an operator tool, not the rail, so
 * rule 19's "an outage gets the hook switched off" does not apply. Refusing
 * costs one re-typed command; accepting costs a false green.
 */
/*
 * ═══ AND THE FIRST VERSION OF THIS CHECK ONLY CLOSED TWO SPELLINGS ═══
 *
 * It filtered for arguments beginning with `--`. Measured 2026-09-20, after
 * the commit whose message said the class was closed -- every one of these
 * exits 0, selects the 6 whole-repo gates instead of the 39 files the range
 * needed, and prints a green summary:
 *
 *     diff-suite.mjs -s 553724b --list          short flag, never inspected
 *     diff-suite.mjs 553724b --list             bare positional, ignored
 *     diff-suite.mjs --since CLAUDE.md --list   git reads it as a PATHSPEC
 *     diff-suite.mjs --since HEAD --since X     indexOf takes the first
 *
 * The third is the sharpest: the output says "nothing changed against HEAD"
 * while `--since` was on the command line. The message contradicts the
 * invocation and still reads as success.
 *
 * So this is rule 8 applied to my own fix: the defect was never "unknown
 * long-flag names", it was "an argument this script does not understand is
 * silently discarded". CONSUME-AND-CHECK is the property -- every argument
 * must be claimed by something, or the run is refused. That covers spellings
 * nobody has thought of yet, which an enumeration cannot.
 */
const KNOWN_FLAGS = new Set(['--list', '--since']);
const VALUE_FLAGS = new Set(['--since']);

const consumed = new Array(argv.length).fill(false);
const seen = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!KNOWN_FLAGS.has(a)) continue;
  consumed[i] = true;
  seen.set(a, (seen.get(a) ?? 0) + 1);
  if (VALUE_FLAGS.has(a) && i + 1 < argv.length && !KNOWN_FLAGS.has(argv[i + 1])) {
    consumed[i + 1] = true;
  }
}

const refuse = (lines) => {
  process.stderr.write(`[diff-suite] ${lines.join('\n  ')}\n`);
  process.exit(2);
};

const leftover = argv.filter((_, i) => !consumed[i]);
if (leftover.length) {
  refuse([
    `unrecognised argument(s): ${leftover.join(', ')}`,
    `known: ${[...KNOWN_FLAGS].join(', ')}`,
    'Refusing rather than falling back to a default scope. An argument this script',
    'does not understand is otherwise discarded silently, which produces a NARROWER',
    'run than you asked for and reports it as a pass. Short flags and bare',
    'positionals are refused for the same reason long ones are.',
  ]);
}

/*
 * A REPEATED FLAG IS REFUSED, NOT RESOLVED. `argv.indexOf` takes the FIRST
 * occurrence, so somebody correcting a typo by retyping the flag gets the
 * value they replaced -- and the run looks fine. Picking the last would also
 * be defensible; refusing is the only option that cannot be silently wrong,
 * and this is a hand-typed operator tool where the cost is one retype.
 */
for (const [f, n] of seen) {
  if (n > 1) {
    /*
     * THE REASON DIFFERS BY FLAG, AND SAYING THE WRONG ONE IS ITS OWN DEFECT.
     * Blind audit D-H: this told somebody who typed `--list --list` that "the
     * scope is computed from the value you meant to replace". `--list` has no
     * value. A refusal that explains itself wrongly teaches the reader a
     * false model of the tool, which is worse than a bare refusal.
     */
    refuse(VALUE_FLAGS.has(f)
      ? [
        `${f} was given ${n} times`,
        'The first occurrence wins, so a corrected retype is silently ignored and the',
        'scope is computed from the value you meant to replace. Give it once.',
      ]
      : [
        `${f} was given ${n} times`,
        'It takes no value, so this is harmless -- but it is refused rather than',
        'ignored, because a command line nobody read carefully is how the wrong',
        'scope gets run and reported as a pass. Give it once.',
      ]);
  }
}

/*
 * SAME DEFECT, SECOND SPELLING. `--since` with nothing after it -- a shell
 * that swallowed the ref, a trailing flag -- makes `flag()` return its
 * default, which is the HEAD fallback again. Fixing only the unknown-name
 * case would be rule 8: patching the strings the prober happened to try
 * instead of the way the option is read.
 */
/*
 * ANY FLAG-SHAPED VALUE, not only a known flag. Blind audit D-G.
 *
 * The first version tested `KNOWN_FLAGS.has(next)`, which narrowed what the
 * version before it had caught with `startsWith('--')`. So `--since --foo`
 * fell past this check and was refused further down by the revision
 * validator, which told the operator that git "would accept it as a
 * PATHSPEC instead". git would do no such thing with `--foo`; it would
 * reject it as an unknown option.
 *
 * The refusal direction was safe and the REASON was invented. A control that
 * refuses for a reason that is not true of the input is teaching the next
 * reader a false model of git, and this file already has one finding about
 * exactly that.
 */
const sinceAt = argv.indexOf('--since');
const sinceVal = sinceAt === -1 ? null : argv[sinceAt + 1];
if (sinceAt !== -1 && (sinceAt + 1 >= argv.length || String(sinceVal ?? '').startsWith('-'))) {
  refuse([
    `--since needs a revision after it${sinceVal === undefined ? '' : `, and got ${sinceVal}`}.`,
    'Given none, this would silently scope to "working tree against HEAD" and',
    'call that a pass.',
  ]);
}

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

/*
 * ASK GIT WHETHER THE VALUE IS A COMMIT, BEFORE DIFFING AGAINST IT.
 *
 * `git diff --name-only CLAUDE.md` is a VALID command: git reads an argument
 * it cannot resolve as a revision as a PATHSPEC, and diffs the working tree
 * against HEAD limited to that path. So `--since CLAUDE.md` produced an empty
 * scope and exit 0, and the output said "nothing changed against HEAD" while
 * `--since` was on the command line -- the message contradicting the
 * invocation, and still reading as a pass.
 *
 * Arity and spelling checks cannot catch this: the argument is present, it is
 * a string, and it is in the right place. Only the thing that OWNS the meaning
 * can answer, which is git -- the same move as asking git what a pathspec
 * covers rather than matching spellings.
 *
 * `^{commit}` and not bare `--verify`, because a tree or a blob sha verifies
 * happily and then diffs to something meaningless.
 */
const since = flag('--since');
if (since === '') {
  /*
   * EXPLICIT, BECAUSE IT WAS CLOSED ONLY BY LUCK. `--since ""` survives the
   * arity check (it is not flag-shaped) and reaches the validator, where
   * `rev-parse '^{commit}'` happens to fail. But `changedFiles` guards with
   * `since ? ... : 'HEAD'`, and `''` IS FALSY -- so had that rev-parse ever
   * succeeded, an empty revision would have silently scoped to HEAD and
   * reported a green run over six gates. Depending on an unrelated command
   * to fail is not a check.
   */
  refuse([
    '--since was given an empty revision.',
    'That would fall through to "working tree against HEAD" and report a green',
    'run over the whole-repo gates alone.',
  ]);
}
if (since !== null) {
  try {
    runGit(['rev-parse', '--verify', '--quiet', `${since}^{commit}`], { cwd: REPO });
  } catch {
    refuse([
      `--since ${since} does not resolve to a commit.`,
      'git would accept it as a PATHSPEC instead, diff the working tree against',
      'HEAD limited to that path, find nothing, and exit 0 -- a full green run',
      'that tested six whole-repo gates and nothing else.',
    ]);
  }
}

/** What changed: working tree against HEAD, or against an explicit ref. */
function changedFiles() {
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
