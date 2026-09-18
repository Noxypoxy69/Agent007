import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_GIT_CONFIG, runGit, runGitAsync, redirectsRepository } from '../src/safeGit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * THE REASON THE FLAGS EXIST, PROVEN BOTH WAYS.
 *
 * `.git/config` is executable configuration. `core.fsmonitor` names a command
 * git runs during ordinary read-only operations, so a plain `git status`
 * executes it. This is not theory: it was demonstrated in a scratch repository
 * before this module was written, and the assertion below is that demonstration.
 *
 * It matters because `.git/` is not in PROTECTED_PATHS and is never tracked, so
 * the file is invisible to `git status`, to protectedDrift and to the guard's
 * path rules -- and the Stop gate shells out to git to decide whether a baseline
 * may be minted.
 */
function repoWithHostileConfig() {
  const root = mkdtempSync(path.join(tmpdir(), 'safegit-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main', '.');
  git('commit', '-q', '--allow-empty', '-m', 'x');

  const marker = path.join(root, 'EXECUTED');
  const hook = path.join(root, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker.split(path.sep).join('/')}"\nexit 1\n`);
  try { chmodSync(hook, 0o755); } catch { /* not meaningful on Windows */ }
  git('config', 'core.fsmonitor', hook.split(path.sep).join('/'));
  return { root, marker };
}

test('UNHARDENED git executes the repository own config — this is the bug', () => {
  const { root, marker } = repoWithHostileConfig();
  try {
    try {
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
    } catch { /* the hook exits 1 on purpose; the point is whether it RAN */ }

    // A control test: if this never fired, the negative below proves nothing.
    assert.equal(existsSync(marker), true,
      'the control failed: git did not run the fsmonitor command, so the hardening test below is vacuous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGit REFUSES to execute it — the same repository, the same command', () => {
  const { root, marker } = repoWithHostileConfig();
  try {
    try {
      runGit(['status', '--porcelain'], { cwd: root });
    } catch { /* ignore any git failure; the assertion is about execution */ }
    assert.equal(existsSync(marker), false, 'the hardened invocation must not run the repository command');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * AND NOBODY GETS TO BE THE EIGHTH CALL SITE.
 *
 * The flags previously existed twice, byte-identical, in verifier.mjs and
 * candidateTree.mjs, while SEVEN other invocations had none -- including the two
 * in guardSession.mjs that the Stop gate depends on. Consolidating them fixes
 * today; this test is what stops it recurring, because the next person adding a
 * git call will be told by a failing test rather than by a reviewer who happened
 * to look.
 */
function sourceFiles() {
  const out = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) visit(p);
      else if (/\.(mjs|js)$/.test(e)) out.push(p);
    }
  };
  for (const d of ['src', 'bin', 'scripts']) {
    const full = path.join(REPO, d);
    if (existsSync(full)) visit(full);
  }
  return out;
}

/*
 * THIS SCAN NAMED FOUR SPELLINGS AND CALLED IT A PROPERTY.
 *
 * It matched /(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/ and was
 * green across the whole tree. Two different accidents walked past it:
 *
 *   src/git.mjs      held `const GIT = 'git'` and passed the VARIABLE
 *   bin/agentbridge-attempt.mjs  passed the literal to run(), a WRAPPER
 *
 * Neither was deliberate. Both left a git invocation outside safeGit while a
 * test named "EVERY git invocation goes through safeGit" reported success --
 * rule 17, a control that is never consulted, except worse, because this one
 * answered and the answer was wrong.
 *
 * The property is not "which function was called". It is "this source hands the
 * NAME OF GIT to something that will spawn it". So the scan now matches any
 * call whose first argument is that literal, wrapper or not.
 *
 * WHAT A PATTERN OVER SOURCE STILL CANNOT SEE, said here rather than implied by
 * a confident test name: a variable. Put the name in a const, or compute it, and
 * no regex finds it. That is why the real enforcement is in the CODE --
 * src/exec.mjs throws when asked for git, inspecting the actual argument at
 * runtime, which is what caught bin/agentbridge-attempt.mjs. This scan is the
 * fast signal that fails at lint time instead of in somebody's worktree. It is a
 * second layer, not the boundary, and it is named for what it does.
 */
/*
 * TWO SHAPES, BECAUSE GIT IS SPAWNED TWO WAYS -- AND THE QUOTE CLASS IS THREE
 * CHARACTERS, NOT TWO.
 *
 * The previous pattern was /\b([A-Za-z_$][\w$.]*)\s*\(\s*['"](git…)['"]\s*,/gi
 * and the commit that shipped it said it "matches any call whose first argument
 * is that literal, wrapper or not". A blind audit falsified that sentence twice:
 *
 *   execFileSync(`git`, ['status'])       a BACKTICK. Not a variable, not
 *                                         computed -- the literal itself, in the
 *                                         one quoting style the class omitted.
 *                                         Unhardened git ran; gate stayed green.
 *   execSync('git status --porcelain')    SHELL form. The name heads a command
 *                                         string instead of being its own
 *                                         argument, so there is no comma to
 *                                         match. Worse than the wrapper case
 *                                         this scan was written for, because it
 *                                         spawns through a shell.
 *
 * Neither reaches refuseGit either -- both go straight to child_process -- so
 * both layers were bypassed at once. A codebase that writes template literals
 * constantly makes the backtick the likeliest ACCIDENTAL spelling in it.
 *
 * THE CALLEE IS NO LONGER PART OF THE MATCH. It was an identifier class, so
 * `runners['go']('git', …)` slipped past on the shape of the callee rather than
 * anything about git. The property is the ARGUMENT, so that is all these match;
 * the callee is recovered afterwards for the report only. Rule 8: fix the
 * matcher, not the strings the prober happened to try.
 */
const QUOTE = "['\"`]";
const GIT_ARGV = new RegExp(`\\(\\s*(${QUOTE})(git(?:\\.exe)?)\\1\\s*,`, 'gi');
const GIT_SHELL = new RegExp(`\\(\\s*(${QUOTE})(git\\s+[^'"\`]*)\\1`, 'gi');

/*
 * SIXTEEN CALL SITES THAT ARE NOT FIXED, LISTED RATHER THAN EXCLUDED.
 *
 * bin/agentbridge.mjs declares a local runner in three function scopes --
 * `const run = promisify(execFile)` -- which shadows the name and never reaches
 * src/exec.mjs. Measured, not assumed: a promisified execFile call to git from
 * this repo returns a branch name with no refusal. So these sixteen are outside
 * BOTH layers: invisible to the lint and invisible to refuseGit. No hooksPath,
 * fsmonitor or GIT_DIR hardening applies to them.
 *
 * They are not fixed here because routing them changes the behaviour of three
 * shipped commands, one of which clones a caller-supplied path. That is an
 * owner decision, and it is recorded as one rather than fixed quietly at the end
 * of a long night.
 *
 * THE COUNT IS ASSERTED EXACT, NOT AS A CEILING. Rule 19: enumeration fails in
 * both directions. A NEW unrouted call site in this file pushes the count above
 * the declared number and fails; a FIXED one pushes it below and fails too, so
 * the entry cannot rot into a permanent exemption nobody rereads.
 *
 * IT IS A COUNT AND NOT A LINE LIST ON PURPOSE. The first version of this
 * quarantine keyed on file:line, and the numbers were stale before it ever ran
 * -- every edit above a call site moves it, so the list would demand updating
 * for reasons that have nothing to do with git. A count is stable under edits
 * and still fails in both directions, which is the property that was wanted.
 */
/*
 * 18 -> 11 at ff35297 (12 argv sites raw, 11 once commented-out code is blanked), where code-a routed the observe-sha clone block -- clone,
 * checkout --detach, rev-parse, remote get-url, status. That was the sharpest of
 * the eighteen: it clones a repository and checks out a CALLER-SUPPLIED sha, so
 * a repository config that executes is at its most dangerous exactly there.
 *
 * THE AGENT DOING THE ROUTING CANNOT EDIT THIS NUMBER, WHICH IS A FLAW IN THE
 * HANDSHAKE I DESIGNED, NOT IN THEIR WORK. This file is a baseline test, so a
 * guarded session is refused any edit to it. I built a ratchet whose bookkeeping
 * lives in a file its only user is structurally unable to touch, and then wrote
 * a failure message instructing them to do it -- the same shape as the
 * registration recipe no guarded session could run and the clone check rule 21
 * told authors to perform inside a rail that forbids it. Third instance in two
 * days, this one mine.
 *
 * So the pen is held here, in the guard lane, and the message below says so
 * instead of issuing an instruction the reader cannot follow. The number still
 * only moves with a measurement.
 */
const KNOWN_UNROUTED = Object.freeze({ 'bin/agentbridge.mjs': 11 });

/*
 * BLANKING COMMENTS WITH A REGEX WAS DEFEATED BY A STRING, AND LOST 140 LINES.
 *
 * Both found by blind audit of the previous commit, both demonstrated running
 * real unhardened git while this file reported 9 of 9 green.
 *
 * ONE: `/\/\*[\s\S]*?\*\//g` has no idea what a string is. A file containing
 *   export const CENSOR_TOKEN = '/*';
 * opens a "comment" that runs to the next closer ANYWHERE in the file -- the
 * next JSDoc will do -- so every line between them vanished from the scanner's
 * view, including a genuine execFileSync('git', ...). The file still parses.
 * That is the fourth rediscovery of rule 13 in this repository.
 *
 * TWO: the line-comment pattern anchored with caret-backslash-s-star (spelled
 * out because writing it literally here would close this very comment, which is
 * how the first draft of this paragraph broke the file) matches NEWLINES under
 * /m, because backslash-s includes them. A line
 * comment preceded by a blank line swallowed that blank line and replaced it
 * with a space, so the blanked text had fewer lines than the file. Measured
 * tree-wide: 140 lines lost, worst offenders -34 in src/attemptPipeline.mjs and
 * -34 in scripts/claude-stop-gate.mjs. Every line number this scan reported was
 * wrong, by 2 to 27, while a comment directly above the code claimed "every
 * surviving line number still matches the real file".
 *
 * So this is a SCANNER, not a pattern. Knowing whether `/*` opens a comment
 * requires knowing whether you are inside a string, and that is not a thing a
 * regex can know. It preserves byte positions exactly -- comment characters
 * become spaces, newlines stay newlines -- so offsets and line numbers are the
 * file's own.
 */
function blankComments(src) {
  const out = Array.from(src);
  const n = src.length;
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  const blank = (at) => { if (out[at] !== '\n') out[at] = ' '; };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'") { state = 'single'; i += 1; continue; }
      if (c === '"') { state = 'double'; i += 1; continue; }
      if (c === '`') { state = 'template'; i += 1; continue; }
      i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i += 1; continue; }
      blank(i); i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; blank(i); blank(i + 1); i += 2; continue; }
      blank(i); i += 1; continue;
    }
    if (c === '\\') { i += 2; continue; } // an escape inside a string
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code'; i += 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Best-effort callee for the REPORT. The match never depends on it. */
function calleeBefore(code, index) {
  const head = code.slice(Math.max(0, index - 120), index);
  const m = head.match(/([A-Za-z_$][A-Za-z0-9_$.]*(?:\[[^\]]*\])?)\s*$/);
  return m ? m[1] : '(anonymous call)';
}

function gitCallSites() {
  const found = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (rel === 'src/safeGit.mjs') continue; // the one place allowed to spawn git directly

    const code = blankComments(readFileSync(file, 'utf8'));

    for (const [re, shape] of [[GIT_ARGV, 'argv'], [GIT_SHELL, 'shell']]) {
      for (const m of code.matchAll(re)) {
        const callee = calleeBefore(code, m.index);
        /*
         * THE SHELL SHAPE NEEDS A SHELL-SPAWNING CALLEE, AND THAT IS A
         * HEURISTIC -- SAID PLAINLY RATHER THAN DRESSED UP AS THE PROPERTY.
         *
         * "a string argument beginning with git" is not the same claim as "a git
         * invocation": the first version of this flagged three error MESSAGES
         * that happen to start with the word, including src/exec.mjs's own
         * refusal text and two die() calls reading "git worktree add failed".
         * An offender list full of prose is a list somebody deletes, and a
         * deleted lint protects nothing -- that is the silencer failure this
         * file already carries a warning about.
         *
         * So shell form additionally requires a callee that plausibly executes a
         * command STRING. In node that is exec and execSync; the test is a
         * substring so wrappers named around them are still caught, while die,
         * Error and log are not.
         *
         * WHAT THAT COSTS, stated so nobody reads this as airtight: a wrapper
         * called something else entirely -- sh('git status') -- is missed. The
         * ARGV shape above needs no callee and remains the strict property; this
         * one is a second net with a known hole, and refuseGit plus the
         * repository's own review are what stand behind it.
         */
        if (shape === 'shell' && !/exec|spawn|shell|sh$/i.test(callee)) continue;
        const line = code.slice(0, m.index).split('\n').length;
        found.push({ id: `${rel}:${line}`, rel, line, shape, callee, spelling: m[2] });
      }
    }
  }
  return found.sort((a, b) => (a.rel === b.rel ? a.line - b.line : a.rel.localeCompare(b.rel)));
}

/*
 * THE CANARY, WHICH IS WHAT THE "FLOOR" WAS TRYING AND FAILING TO BE.
 *
 * The floor asserted `sites.length >= declared`, comparing a TREE-WIDE total
 * against the sum of the quarantine -- and every quarantined site lives in one
 * file. A blind audit defeated it in one move: narrow the callee back to a name
 * list, add a real violation in a clean file, and the total still clears the
 * floor because bin/agentbridge.mjs alone satisfies it. Green, with unhardened
 * git in the tree. A coverage claim satisfiable by one file's contents is a
 * claim about that file.
 *
 * So the pattern is checked against FIXED SAMPLES that do not depend on what is
 * in the repository today. If the matcher degrades, these fail immediately and
 * name the spelling that stopped matching, whatever the tree happens to hold.
 * Every entry below is a spelling that was PROVEN to run real unhardened git
 * while this file reported success.
 */
const MUST_MATCH = Object.freeze([
  ["a plain single-quoted spawn", "execFileSync('git', ['status'], {});"],
  ['a double-quoted spawn', 'execFileSync("git", ["status"], {});'],
  ['a BACKTICK spawn -- audit D1, ran unhardened git with the gate green', 'execFileSync(`git`, [`status`], {});'],
  ['an uppercase name', "execFileSync('GIT', ['status'], {});"],
  ['git.exe', "spawnSync('git.exe', ['status'], {});"],
  ['a wrapper -- the case this scan was written for', "run('git', ['status'], {});"],
  ['a wrapper nobody has listed', "someFutureRunner('git', ['status'], {});"],
  ['a member callee', "deps.run('git', ['status'], {});"],
  ['a computed callee -- audit D7', "runners['go']('git', ['status'], {});"],
  ['SHELL form -- audit D6, spawns through a shell so it is worse', "execSync('git status --porcelain', {});"],
  ['shell form, async', "exec('git rev-parse HEAD', {}, cb);"],
  ['the first argument on the next line', "execFileSync(\n  'git',\n  ['status'],\n);"],
]);

const MUST_NOT_MATCH = Object.freeze([
  ['a line comment mentioning it', "// execFileSync('git', ['status']);\nconst x = 1;"],
  ['a block comment mentioning it', "/*\n * execFileSync('git', ['status']);\n */\nconst x = 1;"],
  ['a different program', "execFileSync('node', ['--test'], {});"],
  ['a program whose name starts with git', "execFileSync('github-cli', ['x'], {});"],
  ['the word in prose', "const msg = 'git is a program';"],
]);

test('THE MATCHER STILL RECOGNISES EVERY SPELLING, independent of what the tree contains', () => {
  for (const [label, sample] of MUST_MATCH) {
    const hits = [];
    const code = blankComments(sample);
    for (const [re] of [[GIT_ARGV], [GIT_SHELL]]) for (const m of code.matchAll(re)) hits.push(m);
    assert.ok(hits.length >= 1, `the matcher no longer catches ${label}: ${JSON.stringify(sample)}`);
  }
});

test('AND IT DOES NOT MATCH THINGS THAT ARE NOT GIT INVOCATIONS', () => {
  /*
   * RULE 5. Without this, a matcher that matched EVERYTHING would satisfy the
   * canary above perfectly, and the offender list would fill with noise until
   * somebody deleted the test.
   */
  for (const [label, sample] of MUST_NOT_MATCH) {
    const hits = [];
    const code = blankComments(sample);
    for (const [re] of [[GIT_ARGV], [GIT_SHELL]]) for (const m of code.matchAll(re)) hits.push(m);
    assert.deepEqual(hits.map((m) => m[0]), [], `the matcher wrongly flags ${label}`);
  }
});

test('COMMENT BLANKING PRESERVES BYTES AND LINES, which the regex version did not', () => {
  /*
   * Audit D5: the old blanker lost 140 lines tree-wide, so every reported line
   * number was wrong by 2 to 27 while a comment above it claimed otherwise.
   * Audit D2: an unbalanced comment opener inside a STRING blanked out real code
   * and hid a genuine violation.
   */
  const withUnbalancedOpener = "export const CENSOR = '/*';\nexecFileSync('git', ['status'], {});\n/** doc */\n";
  const blanked = blankComments(withUnbalancedOpener);
  assert.equal(blanked.length, withUnbalancedOpener.length, 'byte positions must be preserved');
  assert.equal(blanked.split('\n').length, withUnbalancedOpener.split('\n').length, 'line count must be preserved');
  assert.match(blanked, /execFileSync\('git'/,
    'a comment opener inside a STRING must not blank out the code after it -- audit D2 hid a real '
    + 'violation this way while the gate reported nine of nine green');

  const withBlankLineBeforeComment = "const a = 1;\n\n  // a comment\nrun('git', ['x']);\n";
  const b2 = blankComments(withBlankLineBeforeComment);
  assert.equal(b2.split('\n').length, withBlankLineBeforeComment.split('\n').length);
  const first = [...b2.matchAll(GIT_ARGV)][0];
  assert.equal(b2.slice(0, first.index).split('\n').length, 4,
    'the call is on line 4 of the real file and must be reported there');
});

test('EVERY git invocation under src, bin and scripts goes through safeGit, wrapper or not', () => {
  const sites = gitCallSites();

  /*
   * RULE 5, and it is not decorative here: the previous scan's failure mode was
   * matching NOTHING and reporting success. A scan that silently stops finding
   * call sites is indistinguishable from a clean tree, so assert it still sees
   * the ones we know exist before trusting an empty offender list.
   */
  const declared = Object.values(KNOWN_UNROUTED).reduce((a, b) => a + b, 0);
  assert.ok(sites.length >= declared,
    `the scan found ${sites.length} git call sites, fewer than the ${declared} known to exist -- ` +
    'the pattern has stopped matching, and an empty result means nothing');

  const offenders = sites
    .filter((s) => !(s.rel in KNOWN_UNROUTED))
    .map((s) => `${s.id}: ${s.callee}('${s.spelling}', ...)`);

  assert.deepEqual(offenders, [],
    'these hand the name of git to something that spawns it, instead of importing runGit ' +
    `from src/safeGit.mjs:\n  ${offenders.join('\n  ')}`);
});

test('the unrouted count is exact in both directions', () => {
  /*
   * The other direction. Without this, the quarantine is a place to park a
   * finding forever: route the calls and the stale entry sits there implying
   * debt that no longer exists, which is how an exemption stops being read.
   */
  const actual = {};
  for (const s of gitCallSites()) actual[s.rel] = (actual[s.rel] ?? 0) + 1;

  const wrong = [];
  for (const [rel, expected] of Object.entries(KNOWN_UNROUTED)) {
    const got = actual[rel] ?? 0;
    if (got === expected) continue;
    wrong.push(got < expected
      ? `${rel}: ${got} unrouted git calls, quarantine still declares ${expected}. Routing happened and the `
        + 'count has not caught up. THIS FILE IS A BASELINE TEST, so if you are the session that did the '
        + 'routing you are refused the edit -- that is expected and is not your problem to solve. Say so to '
        + 'the guard lane with your commit sha and the number becomes that; do not work around this test'
      : `${rel}: ${got} unrouted git calls, quarantine declares ${expected} -- ${got - expected} new one(s) went in outside safeGit`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the hardening list itself is frozen and names all three surfaces', () => {
  assert.equal(Object.isFrozen(SAFE_GIT_CONFIG), true);
  const joined = SAFE_GIT_CONFIG.join(' ');
  for (const surface of ['core.hooksPath', 'core.fsmonitor', 'protocol.ext.allow']) {
    assert.ok(joined.includes(surface), `${surface} is not refused`);
  }
});

/*
 * WHICH GIT_ VARIABLES ARE STRIPPED, AND THE ONE THAT MUST NOT BE.
 *
 * The strip started as /^GIT_/i and that was too wide by exactly one variable
 * that matters. Git sets GIT_INDEX_FILE AS PROTOCOL when it invokes a hook for a
 * partial commit -- `git commit -- <paths>`, `git commit -p` -- pointing the
 * hook at a TEMPORARY index holding only what is being committed.
 *
 * bin/agentbridge-precommit.mjs passes no env of its own, so the blanket strip
 * removed the variable git had just handed it. Measured by audit: the lane
 * collision guard saw an EMPTY staged list and exited 0, waving through a commit
 * it had blocked one commit earlier. A control turned fail-open by a commit
 * whose subject was about closing a hole.
 */
test('the strip removes what redirects the REPOSITORY and keeps per-operation protocol', () => {
  for (const key of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_17',
  ]) {
    assert.equal(redirectsRepository(key), true, `${key} changes which repository or config git uses`);
  }

  /*
   * THE COUNTEREXAMPLE THAT PROVED THE PREFIX RULE WRONG. These are
   * per-operation protocol -- which index this commit uses, whose name it is
   * made under -- not which repository git is looking at.
   */
  for (const key of [
    'GIT_INDEX_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_EDITOR', 'GIT_ASKPASS',
  ]) {
    assert.equal(redirectsRepository(key), false, `${key} is protocol and must survive`);
  }
});

test('a hook still reads the TEMPORARY INDEX git handed it, and still cannot be redirected', async (t) => {
  /*
   * The end-to-end shape of the regression, through runGitAsync, which is what
   * the pre-commit hook actually calls.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'safegit-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-qm', 'init');

  // Exactly what git builds for `git commit -- a.txt`: a temporary index in
  // which ONLY a.txt is staged, while both files differ in the worktree.
  const tmpIndex = path.join(dir, 'next-index.lock');
  writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
  const withIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, env: withIndex, stdio: 'ignore' });
  execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: withIndex, stdio: 'ignore' });

  const prevIndex = process.env.GIT_INDEX_FILE;
  const prevDir = process.env.GIT_DIR;
  process.env.GIT_INDEX_FILE = tmpIndex;
  process.env.GIT_DIR = path.join(dir, 'NOT-A-REPO', '.git');   // must not take effect
  try {
    const staged = await new Promise((resolve) => {
      runGitAsync(['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }, (err, out) => {
        resolve(err ? `ERROR: ${err.message}` : String(out).trim().split('\n').filter(Boolean));
      });
    });
    assert.deepEqual(staged, ['a.txt'],
      'the hook must see the temporary index git handed it, not an empty one');
  } finally {
    if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = prevIndex;
    if (prevDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevDir;
  }
});

/*
 * THE SCAN THAT SAID "EVERY git INVOCATION GOES THROUGH safeGit" WAS WRONG.
 *
 * It matches /(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/ -- a
 * LITERAL. src/git.mjs held `const GIT = 'git'` and passed the variable, so the
 * scan never saw it. The test was green, with that name, while the file called
 * git.mjs was the one invocation that did not go through safeGit.
 *
 * Measured consequences, through the shipped CLI: a repository config saying
 * `fsmonitor = sh -c 'touch MARKER; exit 1'` EXECUTED, and GIT_DIR redirected
 * `agentbridge status --json` so it reported another repository's HEAD under
 * this worktree's name.
 *
 * A pattern over source can always be spelled around. So the property is
 * enforced IN THE CODE -- src/exec.mjs throws if asked for git -- and these
 * assert that refusal exists and covers the spellings, rather than asserting
 * that a particular string does not appear.
 */
test('exec.mjs REFUSES git, whatever it is called, so the lint cannot be spelled around', async () => {
  const { run } = await import('../src/exec.mjs');

  for (const spelling of ['git', 'git.exe', 'GIT', '/usr/bin/git', 'C:\\Program Files\\Git\\bin\\git.exe']) {
    await assert.rejects(
      () => run(spelling, ['--version'], { cwd: REPO }),
      /safeGit/,
      `${spelling} must be refused by exec.mjs and pointed at safeGit`,
    );
  }

  /*
   * RULE 5: the positive. exec.mjs must still run everything else, or this
   * "fix" is just a broken module and the assertions above mean nothing.
   */
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("fine")'], { cwd: REPO });
  assert.equal(ok.ok, true, 'exec.mjs must still run ordinary commands');
  assert.match(ok.stdout, /fine/);
});

test('src/git.mjs goes through safeGit, not exec.mjs', async () => {
  // The structural half: the module that was exempt must not reach for the
  // unhardened runner at all.
  const src = readFileSync(path.join(REPO, 'src', 'git.mjs'), 'utf8');
  assert.ok(!/from '\.\/exec\.mjs'/.test(src),
    'src/git.mjs must not import the unhardened runner');
  assert.match(src, /from '\.\/safeGit\.mjs'/,
    'src/git.mjs must invoke git through safeGit');
});
