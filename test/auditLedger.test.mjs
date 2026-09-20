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
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isAuditBearing, parseLedger, auditCoverage, formatCoverage, AUDIT_BEARING_EXTRAS,
  auditEscalation, scriptsChanged,
  defaultAuditRange,
  standingAudit,
} from '../src/auditLedger.mjs';
import { PROTECTED_PATHS } from '../src/guardSession.mjs';

/** The repository this test file lives in, derived rather than typed. */
function repoRootOf() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

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

test('scriptsChanged separates CANNOT READ from HAS NO PARENT', async (t) => {
  /*
   * ═══ THIS TEST USED TO PIN THE DEFECT, AND A BLIND AUDIT SHOWED THE COST ═══
   *
   * It asserted `scriptsChanged(root) === true` with the reason "the root
   * commit has no parent to compare against, so it cannot be cleared". That IS
   * the finding: every repository with fewer commits than the default window,
   * and every `git clone --depth 1`, blocked unconditionally on every turn --
   * and the ONLY thing that cleared it was a ledger line claiming "a reader who
   * did NOT write the commit has actually looked at it" for a root commit
   * nobody audited. A gate whose false positives are cleared by fabricating an
   * audit record corrupts the artefact rule 20 rests on.
   *
   * THE SECURITY PROPERTY IS UNCHANGED, which is why this is a correction and
   * not a weakening: a root commit that INTRODUCES an executable key still
   * blocks. What stopped is blocking one that introduces none.
   *
   * Three answers now, because these are three different questions and
   * collapsing them is what produced the over-block.
   */
  const r = repoWithPackageJson(t);

  /* A real root: nothing to compare against, and this fixture's root defines
   * scripts, so it IS an addition and must still be reported as one. */
  assert.equal(scriptsChanged(r.dir, r.base), 'changed',
    'a root commit that introduces scripts is still introducing scripts');

  /* Unreadable is UNKNOWN. Not "changed" -- that was the over-block -- and
   * emphatically not "same", which is the direction that loses a finding. */
  assert.equal(scriptsChanged(r.dir, 'not-a-sha'), 'unknown',
    'an unresolvable revision was given a definite answer');
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

/* ══ two audits of one commit, and which one stands ═════════════════════ */

test('THE STANDING AUDIT DOES NOT DEPEND ON THE ORDER OF THE FILE', () => {
  /*
   * d81e9643 carries two blind audits that disagree: an early pass reporting
   * found:0, "no defect specific to this commit", and a later independent
   * pass reporting found:8 with two HIGH. Both are real records and neither
   * should be deleted.
   *
   * The old resolver took the first prefix match in map-insertion order, so
   * the answer was decided by where somebody pasted a line. MEASURED on the
   * real rows, both orders:
   *
   *     as written     OLD -> found:8    NEW -> found:8
   *     rows swapped   OLD -> found:0    NEW -> found:8
   *
   * Moving one line past another silently turned "eight findings, two HIGH"
   * into "no defect specific to this commit". That is not a verdict a text
   * editor should be able to change.
   */
  const early = JSON.stringify({
    commit: 'abc1234', auditor: 'first blind pass', at: '2026-01-01T00:00:00Z', found: 0,
  });
  const later = JSON.stringify({
    commit: 'abc12345', auditor: 'second blind pass', at: '2026-02-01T00:00:00Z', found: 8,
  });
  const key = 'abc123456789abcdef0123456789abcdef012345';

  for (const [label, text] of [['as written', `${early}\n${later}`], ['swapped', `${later}\n${early}`]]) {
    const row = standingAudit(parseLedger(text), key);
    assert.equal(row?.found, 8, `${label}: the newer audit must stand, not whichever line came first`);
  }
});

test('TWO ROWS SPELLED THE SAME ARE TWO ROWS, NOT ONE', () => {
  /*
   * THE CASE THE FIRST VERSION OF THIS RULE COULD NOT SEE, found by an
   * auditor. parseLedger keyed a Map by the sha string, so two audits of one
   * commit written the SAME way -- which is the house style, all 69 shipped
   * rows are 7 characters -- collapsed to whichever line came last.
   * standingAudit never saw a conflict, and neither did the contradiction
   * gate below. MEASURED before the fix:
   *
   *     a then b   map size 1   standing found:8   (the newer)
   *     b then a   map size 1   standing found:0   (the OLDER wins)
   *
   * The mismatched spellings that made d81e9643 visible were an accident.
   * The likelier shape was the one nothing caught.
   */
  const older = JSON.stringify({
    commit: 'abc1234', auditor: 'first blind pass', at: '2026-01-01T00:00:00Z', found: 0,
  });
  const newer = JSON.stringify({
    commit: 'abc1234', auditor: 'second blind pass', at: '2026-02-01T00:00:00Z', found: 8,
  });
  const key = 'abc123456789abcdef0123456789abcdef012345';

  for (const [label, text] of [['older first', `${older}\n${newer}`], ['newer first', `${newer}\n${older}`]]) {
    const parsed = parseLedger(text);
    assert.equal(parsed.rows.length, 2, `${label}: a row was discarded by the parser`);
    assert.equal(standingAudit(parsed, key)?.found, 8,
      `${label}: the older audit stood over the newer one`);
  }
});

test('AND A SUPERSEDED ROW NEVER STANDS WHILE ANOTHER DOES', () => {
  /*
   * The newest-wins rule alone is not enough: an audit can be retracted or
   * replaced by one that is not newer in wall-clock terms, for instance when
   * a transcription is corrected after the fact. An explicit marker has to
   * beat a timestamp.
   */
  const superseded = JSON.stringify({
    commit: 'def1234', auditor: 'withdrawn pass', at: '2026-03-01T00:00:00Z', found: 0,
    superseded_by: 'the pass below',
  });
  const standing = JSON.stringify({
    commit: 'def1234a', auditor: 'the pass that stands', at: '2026-02-01T00:00:00Z', found: 5,
  });
  const key = 'def1234abcdef0123456789abcdef0123456789a';

  for (const text of [`${superseded}\n${standing}`, `${standing}\n${superseded}`]) {
    const row = standingAudit(parseLedger(text), key);
    assert.equal(row?.found, 5, 'the superseded row stood even though it is newer');
  }

  /* But a superseded row is still an audit if it is the only one there is. */
  assert.ok(standingAudit(parseLedger(superseded), key),
    'a lone superseded row must still count as audited');
});

test('THE SHIPPED LEDGER HAS NO UNRESOLVED CONTRADICTION', async () => {
  /*
   * The class, not the instance. Two live rows for one commit that disagree
   * on the count are a contradiction a reader cannot resolve, and the gate
   * reports one of them as the truth. Either the rows agree, or all but one
   * says which pass replaced it.
   *
   * SHORT AND LONG SPELLINGS ARE THE SAME COMMIT. "d81e964" and "d81e9643"
   * were two separate map keys, so a check that grouped by exact key would
   * have found no contradiction at all and passed while one sat in the file.
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { rows } = parseLedger(readFileSync(path.join(repoRoot, 'docs', 'audit-ledger.jsonl'), 'utf8'));

  /*
   * GROUPED FROM ROWS, NOT FROM MAP KEYS, because the Map holds one row per
   * spelling and the duplicate spelling is the likelier contradiction. The
   * first version of this gate grouped keys and could not see it.
   */
  const groups = new Map();
  for (const row of [...rows].sort((a, b) => String(a.commit).length - String(b.commit).length)) {
    const k = String(row.commit).trim().toLowerCase();
    const head = [...groups.keys()].find((g) => k.startsWith(g) || g.startsWith(k));
    if (head) groups.get(head).push(row);
    else groups.set(k, [row]);
  }

  const unresolved = [];
  for (const [head, members] of groups) {
    if (members.length < 2) continue;
    const live = members.filter((r) => !r.superseded_by);
    const counts = new Set(live.map((r) => r.found).filter((f) => f !== undefined));
    if (counts.size > 1) {
      unresolved.push(`${head}: ${members.map((r) => r.commit).join(', ')} -- live counts ${[...counts].join(' vs ')}`);
    }
  }

  assert.deepEqual(unresolved, [],
    'a commit has two live audits that disagree, and nothing says which one stands:\n  '
    + unresolved.join('\n  '));
});

test('AN EQUAL TIMESTAMP IS THE NORMAL CASE, AND THE LAST LINE WINS (A-1)', () => {
  /*
   * MEASURED ON THE SHIPPED LEDGER by an auditor: 69 rows, 18 distinct `at`
   * values, 64 of the 69 sharing theirs with another row, largest batch 15 --
   * because passes are transcribed in batches under one minute-rounded
   * timestamp. So a tie is the convention, not an edge case.
   *
   * The previous rule compared with a strict `>`, which kept whichever row
   * the FILE listed first. That made "does not depend on the order of the
   * file" false in exactly the shape the ledger produces -- the same defect
   * as the duplicate-spelling one it had just replaced, one field along.
   *
   * The ledger is append-only, so the LAST line is the later record and wins.
   * Asserted in both orderings: the answer must be the same row either way,
   * and it must be the one written second.
   */
  const first = JSON.stringify({"commit":"abc1234","auditor":"batch row written first","at":"2026-09-20T02:10:00Z","found":0});
  const second = JSON.stringify({"commit":"abc1234","auditor":"batch row written second","at":"2026-09-20T02:10:00Z","found":8});
  const key = 'abc123456789abcdef0123456789abcdef012345';

  assert.equal(standingAudit(parseLedger(`${first}\n${second}`), key)?.found, 8,
    'the row written second must stand');
  assert.equal(standingAudit(parseLedger(`${second}\n${first}`), key)?.found, 0,
    'and reversing the file must give the row written second there -- the rule is '
    + '"last line", which is deterministic, not "whichever came first", which is not');
});

test('AND THE TIMESTAMP IS COMPARED AS A TIME, NOT AS A STRING (A-3)', () => {
  /*
   * Lexicographic order is wrong across offsets. "2026-02-01T09:00:00+09:00"
   * is midnight UTC and sorts ABOVE "2026-02-01T05:00:00Z", which is five
   * hours genuinely later. Every shipped row is Z at second resolution, so
   * this was latent -- and latent is not fixed.
   */
  const early = JSON.stringify({"commit":"def1234","auditor":"tokyo morning","at":"2026-02-01T09:00:00+09:00","found":0});
  const later = JSON.stringify({"commit":"def1234","auditor":"five hours later","at":"2026-02-01T05:00:00Z","found":7});
  const key = 'def1234abcdef0123456789abcdef0123456789a';

  for (const text of [`${early}\n${later}`, `${later}\n${early}`]) {
    assert.equal(standingAudit(parseLedger(text), key)?.found, 7,
      'the genuinely later audit must stand regardless of how its offset is spelled');
  }

  /* An undated row still loses to a dated one, as it did before. */
  const undated = JSON.stringify({"commit":"def1234","auditor":"no timestamp","found":3});
  assert.equal(standingAudit(parseLedger(`${undated}\n${later}`), key)?.found, 7,
    'a dated audit must beat an undated one');
});

test('A BARE MAP IS REFUSED RATHER THAN QUIETLY MISREAD (A-2)', () => {
  /*
   * standingAudit used to accept `parseLedger(t).audited` "for callers that
   * still hold one". There are none, so nothing exercised it -- and a caller
   * writing the obvious destructure would have got back the lossy
   * one-row-per-spelling behaviour this function exists to fix, silently.
   * An unexercised compatibility branch that reintroduces the bug is worse
   * than no branch, so it now throws.
   */
  const parsed = parseLedger(JSON.stringify({"commit":"abc1234","auditor":"x","at":"2026-01-01T00:00:00Z","found":1}));
  const key = 'abc123456789abcdef0123456789abcdef012345';

  assert.ok(standingAudit(parsed, key), 'the parse result must still work');
  assert.throws(() => standingAudit(parsed.audited, key), /not its \.audited Map/,
    'passing the Map must fail loudly, not return a row derived from discarded data');
});

test('EVERY REGISTERED CONTROL NAMES A FILE THAT EXISTS', () => {
  /*
   * A ONE-CHARACTER TYPO SILENTLY REVERTS THE GATE TO GREEN, and an auditor
   * measured it: renaming the entry 'src/principalresolution.mjs' to
   * '...resolutoin.mjs' left 46 tests passing and turned
   * check-audit-coverage from "1 commit touching a control" into
   * "every control-touching commit in range has a ledger entry", exit 0.
   *
   * Nothing asked the filesystem. Both tests that iterate the list feed
   * each entry back into the predicate that was BUILT from it, so they
   * agree with themselves through any regression -- hollow gate #2 from the
   * table, in the gate that decides what needs auditing.
   *
   * CASE IS DERIVED, NOT ASSUMED (rule 21). The registry spells entries in
   * lower case and isAuditBearing lowercases both sides, so the spelling is
   * correct on any filesystem -- but existsSync would answer yes on Windows
   * and no on the ubuntu-latest CI runner for 'principalresolution.mjs'.
   * So the comparison is against the real tracked file list, lowercased,
   * which is the same answer on both.
   */
  const tracked = execFileSync('git', ['ls-files'],
    { cwd: repoRootOf(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
  const known = new Set(tracked);

  assert.ok(known.size > 100,
    `git ls-files returned ${known.size} paths, which is too few to be real`);

  const ghosts = AUDIT_BEARING_EXTRAS
    .filter((e) => !String(e).includes('#'))
    .filter((e) => !known.has(String(e).toLowerCase()));

  assert.deepEqual(ghosts, [],
    'these are registered as controls and name no tracked file, so the gate they '
    + `are supposed to arm is silently off for them:\n  ${ghosts.join('\n  ')}`);
});
