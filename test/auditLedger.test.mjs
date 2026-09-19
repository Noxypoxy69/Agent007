/**
 * RULE 20 WAS ENFORCED BY WHETHER THE AUTHOR REMEMBERED.
 *
 * On 2026-09-18 the author shipped twelve commits touching the guard, the shell
 * rail, the grant channel and the Stop gate without a single audit, during a
 * session spent insisting on rule 20 to two other agents. The operator noticed;
 * nothing in the repository did. That is rule 17 pointed at rule 20 -- a control
 * that is never consulted is not a control -- and CLAUDE.md's own opening ranks
 * a check script above the file rule 20 lives in.
 *
 * These tests are about the REPORTER, not about whether any audit was good. It
 * cannot tell a real audit from a typed line and it approves nothing; the only
 * thing it can honestly report is an ABSENCE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isAuditBearing, parseLedger, auditCoverage, formatCoverage, AUDIT_BEARING_EXTRAS,
  auditEscalation, scriptsChanged,
  defaultAuditRange,
} from '../src/auditLedger.mjs';
import { PROTECTED_PATHS } from '../src/guardSession.mjs';

function lab(t) {
  // realpath.native: tmpdir() is an 8.3 short path on Windows and git reports
  // the long form, which has produced wrong verdicts elsewhere in this suite.
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ab-ledger-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoWithCommits(t) {
  const dir = lab(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');

  writeFileSync(path.join(dir, 'docs', 'notes.md'), 'a\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();

  writeFileSync(path.join(dir, 'docs', 'notes.md'), 'b\n');
  g('add', '-A'); g('commit', '-qm', 'ordinary doc change');
  const ordinary = g('rev-parse', 'HEAD').trim();

  writeFileSync(path.join(dir, 'src', 'claudeGuard.mjs'), '// changed\n');
  g('add', '-A'); g('commit', '-qm', 'touch the guard');
  const bearing = g('rev-parse', 'HEAD').trim();

  return { dir, base, ordinary, bearing };
}

/* ------------------------------------------------------------------ */

test('audit-bearing paths are DERIVED from PROTECTED_PATHS, not typed again', () => {
  /*
   * Two lists of one thing drift the moment somebody edits one. A file worth
   * refusing a write to is a file worth auditing a change to, so both answers
   * come from one source -- and this asserts the derivation rather than trusting
   * the comment that claims it.
   */
  for (const entry of PROTECTED_PATHS) {
    const probe = String(entry).endsWith('/') ? `${entry}something.json` : String(entry);
    assert.equal(isAuditBearing(probe), true,
      `${probe} is protected but would not require an audit`);
  }
  for (const extra of AUDIT_BEARING_EXTRAS) {
    assert.equal(isAuditBearing(extra), true, `${extra} must require an audit`);
  }
});

test('ordinary files do not require an audit — the negative that keeps this usable', () => {
  // A reporter that flags everything gets ignored, which loses the whole layer.
  for (const rel of ['docs/notes.md', 'README.md', 'src/collect.mjs', 'test/foo.test.mjs']) {
    assert.equal(isAuditBearing(rel), false, `${rel} must not require an audit`);
  }
});

test('path spelling does not decide the answer', () => {
  for (const spelling of ['src/claudeGuard.mjs', './src/claudeGuard.mjs', 'SRC/CLAUDEGUARD.MJS']) {
    assert.equal(isAuditBearing(spelling), true, `${spelling} must be recognised`);
  }
});

test('a malformed ledger line is reported, never thrown', () => {
  /*
   * A reporter that crashes reports nothing, and nothing is indistinguishable
   * from "everything is audited" -- the exact failure this file exists to stop.
   */
  const { audited, malformed } = parseLedger([
    '# a comment',
    '',
    '{"commit":"abc1234","auditor":"blind-subagent"}',
    'not json at all',
    '{"commit":"","auditor":"x"}',
    '{"commit":"def5678"}',
  ].join('\n'));

  assert.equal(audited.size, 1, 'only the usable line counts');
  assert.ok(audited.has('abc1234'));
  assert.equal(malformed.length, 3, 'each unusable line must be reported');
});

test('an entry with no auditor is not an entry', () => {
  // "Audited by nobody" is the shape this is built to make visible, so it must
  // not be satisfiable by writing a line that omits who did it.
  const { audited } = parseLedger('{"commit":"abc1234","auditor":"   "}');
  assert.equal(audited.size, 0);
});

test('a control-touching commit with no ledger line is reported', async (t) => {
  const { dir, base, bearing } = repoWithCommits(t);
  const r = auditCoverage({ repoRoot: dir, range: `${base}..HEAD`, ledgerText: '' });

  assert.equal(r.error, null);
  const shas = r.commits.map((c) => c.sha);
  assert.ok(shas.includes(bearing), 'the guard-touching commit must appear');
  assert.equal(r.commits.every((c) => !c.audited), true, 'with an empty ledger nothing is audited');
  assert.match(formatCoverage(r), /audit-missing/);
});

test('an ordinary commit is not reported at all', async (t) => {
  const { dir, base, ordinary } = repoWithCommits(t);
  const r = auditCoverage({ repoRoot: dir, range: `${base}..HEAD`, ledgerText: '' });
  assert.ok(!r.commits.map((c) => c.sha).includes(ordinary),
    'a doc-only commit must not demand an audit');
});

test('a recorded commit stops being reported, including by abbreviated sha', async (t) => {
  const { dir, base, bearing } = repoWithCommits(t);
  const ledger = `{"commit":"${bearing.slice(0, 8)}","auditor":"blind-subagent","found":0}`;
  const r = auditCoverage({ repoRoot: dir, range: `${base}..HEAD`, ledgerText: ledger });

  const row = r.commits.find((c) => c.sha === bearing);
  assert.ok(row, 'the commit must still be listed');
  assert.equal(row.audited, true, 'an abbreviated sha in the ledger must match the full one');
  assert.equal(formatCoverage(r), '', 'a fully-covered range reports nothing');
});

test('A FAILED LOOKUP IS NOT A CLEAN REPORT', async (t) => {
  /*
   * CLAUDE.md records this under check-first: "nothing found" is what you want
   * to hear, so it must never be what an error looks like. An unresolvable range
   * must produce an ERROR, not an empty list that reads as full coverage.
   */
  const { dir } = repoWithCommits(t);
  const r = auditCoverage({ repoRoot: dir, range: 'no-such-ref..HEAD', ledgerText: '' });

  assert.ok(r.error, 'an unanswerable range must report an error');
  assert.deepEqual(r.commits, []);
  assert.match(formatCoverage(r), /audit-coverage-unknown/);
  assert.ok(!/audit-missing/.test(formatCoverage(r)),
    'an unknown result must not be rendered as a clean or a missing one');
});

test('the default range is never empty-by-construction, and never undefined', async (t) => {
  /*
   * THIS FUNCTION HAS ALREADY FAILED TWICE, BOTH TIMES SILENTLY.
   *
   * First it resolved to a LOCAL branch name -- main, or master -- which equals
   * HEAD on the branch you are standing on, so the range was empty and the gate
   * reported a clean repository that contained an unaudited change to the shell
   * rail. Its own comment claimed the default "cannot silently mean nothing".
   *
   * Then a generator ate the template literal and it became `return ;`, so it
   * returned undefined. Both failures produce the SAME observable: no commits,
   * no notice, everything looks audited. A reporter that reports nothing is
   * indistinguishable from a repository with nothing to report, which is the one
   * confusion this whole module exists to remove.
   *
   * It is also deliberately NOT a diff from upstream: that answers "what have I
   * not pushed", and pushing audits nothing -- twelve unaudited commits went to
   * the remote in one afternoon, which would have emptied the range and reported
   * coverage by publishing.
   */
  const { dir } = repoWithCommits(t);

  for (const depth of [undefined, 1, 5, 50, 1000]) {
    const range = defaultAuditRange(dir, depth);
    assert.equal(typeof range, 'string', `depth ${depth}: must return a string, got ${range}`);
    assert.notEqual(range.trim(), '', `depth ${depth}: must not be empty`);

    // The range must actually resolve, and must cover at least one commit on a
    // repository that has commits. An unresolvable or empty range is the silent
    // failure above wearing a different shape.
    const r = auditCoverage({ repoRoot: dir, range, ledgerText: '' });
    assert.equal(r.error, null, `depth ${depth}: range ${range} did not resolve: ${r.error}`);
  }

  // And on this repo, which has more history than the window, it must name a
  // window rather than a branch.
  const deep = defaultAuditRange(dir, 1);
  assert.ok(/HEAD/.test(deep), `expected a HEAD-relative window, got ${deep}`);
});

test('the default range FINDS an unaudited control change — the wiring, not the logic', async (t) => {
  /*
   * Rule 17: the wiring is a separate claim from the logic, and only the logic
   * had tests. Measured -- with the branch-name default, this exact scenario
   * reported nothing at all.
   */
  const { dir } = repoWithCommits(t);
  const range = defaultAuditRange(dir);
  const r = auditCoverage({ repoRoot: dir, range, ledgerText: '' });

  assert.ok(r.commits.length > 0,
    `the default range ${range} found no control-touching commits in a repo that has one`);
  assert.match(formatCoverage(r), /audit-missing/);
});

test('the shipped ledger parses, and every line names an auditor', async () => {
  // The file is data the script depends on; a typo in it would silently reduce
  // coverage to "everything is unaudited" or, worse, drop a real entry.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const text = readFileSync(path.join(repoRoot, 'docs', 'audit-ledger.jsonl'), 'utf8');

  const { audited, malformed } = parseLedger(text);
  assert.deepEqual(malformed, [], 'the shipped ledger must have no unusable lines');
  assert.ok(audited.size > 0, 'the shipped ledger must record at least one audit');
  for (const [sha, row] of audited) {
    assert.ok(sha.length >= 7, `${sha} is too short to identify a commit`);
    assert.notEqual(row.auditor.trim(), '', `${sha} names no auditor`);
  }
});

/* ══ package.json is a dependency manifest AND an execution channel ══════ */

function repoWithPackageJson(t) {
  const dir = lab(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');

  const pkg = (scripts, deps) => JSON.stringify({ name: 'p', scripts, dependencies: deps }, null, 2);

  writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node --test' }, { a: '1.0.0' }));
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();

  /* Dependencies only: npm churn, nobody decided anything. */
  writeFileSync(path.join(dir, 'package.json'), pkg({ test: 'node --test' }, { a: '1.0.1', b: '2.0.0' }));
  g('add', '-A'); g('commit', '-qm', 'bump a dependency');
  const depsOnly = g('rev-parse', 'HEAD').trim();

  /* A new script: an executable name, which IS a decision. */
  writeFileSync(path.join(dir, 'package.json'),
    pkg({ test: 'node --test', pwn: 'node ./evil.mjs' }, { a: '1.0.1', b: '2.0.0' }));
  g('add', '-A'); g('commit', '-qm', 'add a script');
  const scripted = g('rev-parse', 'HEAD').trim();

  /* Reformat only: same scripts, different key order and whitespace. */
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { b: '2.0.0', a: '1.0.1' }, name: 'p', scripts: { pwn: 'node ./evil.mjs', test: 'node --test' } }));
  g('add', '-A'); g('commit', '-qm', 'reformat');
  const reformat = g('rev-parse', 'HEAD').trim();

  return { dir, base, depsOnly, scripted, reformat };
}

const blockFor = (dir, sha) => auditEscalation(
  auditCoverage({ repoRoot: dir, range: `${sha}^..${sha}`, ledgerText: '' }),
  [],
).block;

test('A NEW npm SCRIPT BLOCKS; A DEPENDENCY BUMP DOES NOT', async (t) => {
  /*
   * package.json was exempt whole, on the grounds that a lockfile bump is not
   * a decision. An auditor pointed out what that leaves open using this
   * repository's own docs: CLAUDE.md records that `npm run pwn` OVERWROTE
   * src/claudeGuard.mjs, that npm install/ci/run are all ALLOW through the
   * shipped rail, and that `npm test`'s glob is expanded by node rather than
   * judged. package.json is where those script names live.
   *
   * Neither whole-file answer works -- blocking it re-creates the outage the
   * exemption was added for (43672dc, an npm-script addition, was one of two
   * commits stopping every turn), and exempting it leaves an execution
   * channel unaudited. So it is split by KEY.
   */
  const r = repoWithPackageJson(t);

  const scripted = blockFor(r.dir, r.scripted);
  assert.ok(scripted, 'adding an npm script is adding an executable name, and must block');
  assert.match(scripted, /package\.json#scripts/,
    'and the report must say WHICH half of the file decided it');

  /*
   * The outage direction, and the reason this is a key split rather than a
   * path flip: dependency churn must stay quiet or every npm install stops
   * the machine.
   */
  assert.equal(blockFor(r.dir, r.depsOnly), null,
    'a dependency bump is not a decision and must not stop a turn');

  /* And it is still REPORTED, because unaudited is still worth saying. */
  const notice = auditEscalation(
    auditCoverage({ repoRoot: r.dir, range: `${r.depsOnly}^..${r.depsOnly}`, ledgerText: '' }), [],
  ).notice;
  assert.match(notice ?? '', /package\.json/, 'a dependency change is reported even though it does not block');
});

test('a reformat of package.json is not a decision', async (t) => {
  /*
   * Keys are sorted before comparison. A gate that fires on whitespace is one
   * people route around, and reordering a scripts block changes nothing about
   * what runs.
   */
  const r = repoWithPackageJson(t);
  assert.equal(blockFor(r.dir, r.reformat), null,
    'same script names, same commands, different order -- nothing was decided');
});

test('scriptsChanged FAILS CLOSED when it cannot read either side', async (t) => {
  /*
   * A root commit has no parent, and a malformed manifest cannot be parsed.
   * Unreadable is UNKNOWN, and unknown must not render as "nothing happened"
   * -- that is the direction that loses a finding.
   */
  const r = repoWithPackageJson(t);
  assert.equal(scriptsChanged(r.dir, r.base), true,
    'the root commit has no parent to compare against, so it cannot be cleared');
  assert.equal(scriptsChanged(r.dir, 'not-a-sha'), true,
    'an unreadable revision is unknown, not unchanged');
});

test('A MERGE COMMIT THAT CARRIES A CONTROL IS NOT INVISIBLE', async (t) => {
  /*
   * Found by audit and reproduced here before fixing. `git log --name-only`
   * prints a header and NO FILE LIST for a merge -- git declines to pick a
   * side -- so files=[], touched=[], and auditCoverage's loop `continue`s.
   * The commit is not reported as unaudited; it is not reported AT ALL.
   *
   * Measured on the real repository before the fix:
   *
   *   git log --format=%x1e%H%x09%s --name-only -1 cbbe34c
   *     -> header only
   *   ...with --diff-merges=first-parent
   *     -> header, then the file
   *
   * And it does not age out. An EVIL MERGE, whose conflict resolution
   * matches neither parent, exists in no other commit -- so what it carried
   * was invisible permanently rather than until the range moved.
   */
  const dir = lab(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');

  writeFileSync(path.join(dir, 'README.md'), 'base\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  /*
   * THE DEFAULT BRANCH NAME IS DERIVED, NOT TYPED. An auditor caught this
   * hard-coded as 'master': git init uses init.defaultBranch, which is 'main'
   * on most machines and only 'master' on this one. The test failed with
   * 'Command failed: git checkout -q master' -- rule 21, a property of the
   * author's checkout wearing the shape of a property of git.
   */
  const mainBranch = g('rev-parse', '--abbrev-ref', 'HEAD').trim();
  g('branch', 'side');

  /* Mainline moves, so the merge is a real one rather than a fast-forward. */
  writeFileSync(path.join(dir, 'README.md'), 'main\n');
  g('add', '-A'); g('commit', '-qm', 'mainline');

  g('checkout', '-q', 'side');
  writeFileSync(path.join(dir, 'src', 'claudeGuard.mjs'), '// changed on the side branch\n');
  g('add', '-A'); g('commit', '-qm', 'touch the guard on a side branch');

  g('checkout', '-q', mainBranch);
  g('merge', '--no-ff', '-q', 'side', '-m', 'Merge side');
  const merge = g('rev-parse', 'HEAD').trim();

  /*
   * THE RANGE IS THE MERGE ALONE. `merge^..merge` would also contain the
   * SIDE-BRANCH commit, which carries src/claudeGuard.mjs in its own file
   * list -- so the assertion passed while the merge itself stayed invisible.
   * That was this test's first version and a mutation caught it: removing
   * --diff-merges left it green. `<sha>^!` excludes every parent, so the
   * range is that one commit and nothing else.
   */
  const cov = auditCoverage({ repoRoot: dir, range: `${merge}^!`, ledgerText: '' });
  const seen = cov.commits.map((c) => `${c.sha.slice(0, 7)}:${c.touched.join(',')}`);

  const mergeRow = cov.commits.find((c) => c.sha.trim().startsWith(merge.slice(0, 7)));
  assert.ok(mergeRow,
    `THE MERGE ITSELF carried src/claudeGuard.mjs and was reported by nothing. saw: ${JSON.stringify(seen)}`);
  assert.ok(mergeRow.touched.some((f) => /claudeGuard/.test(f)),
    `the control the merge carried must be named against the merge. got: ${JSON.stringify(mergeRow.touched)}`);

  /* And it must BLOCK, not merely appear: it is decision logic, unaudited. */
  assert.ok(auditEscalation(cov, []).block,
    'a merge carrying an unaudited control must stop the turn like any other commit');
});
