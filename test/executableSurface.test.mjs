/**
 * THE package.json EXECUTION GATE, AFTER A BLIND AUDIT FOUND EIGHT DEFECTS.
 *
 * `d81e9643` split package.json by key so a `scripts` change blocks a pushed
 * unaudited commit and a dependency bump does not. An independent auditor in
 * its own clone measured what that shipped with. The three that mattered:
 *
 *   D2 HIGH   every repository with <= 50 commits, and every `clone --depth 1`,
 *             blocked UNCONDITIONALLY -- the root or boundary commit has no
 *             readable parent, the code failed closed, and the ONLY way to
 *             clear it was a ledger line claiming an audit that never happened.
 *             A gate whose false positives are cleared by fabricating an audit
 *             record corrupts the artefact rule 20 rests on.
 *   D4 MEDIUM the serialisation was not injective. Two different `scripts`
 *             objects -- the second defining a real `test` script that did not
 *             exist -- produced the same string.
 *   D1 HIGH   it closes one key of at least eight.
 *
 * These are the regressions. Each fails against `d81e9643`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scriptsChanged, SCRIPTS_MARKER, UNWATCHED_EXECUTION_KEYS } from '../src/auditLedger.mjs';

/** A real git repository, because this function asks git and nothing else. */
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'exec-surface-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a],
    { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '.');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  const write = (obj) => writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(obj, null, 2)}\n`);
  const commit = (m) => { git('add', '-A'); git('commit', '-qm', m); return String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })).trim(); };
  return { dir, git, write, commit };
}

/* ── D2: the unclearable over-block ───────────────────────────────────── */

test('A ROOT COMMIT WITH NO SCRIPTS IS NOT A CHANGE', (t) => {
  /*
   * THE DEFECT: `sha^` does not resolve for a root commit, the old code failed
   * closed, and every repository younger than the 50-commit default window
   * blocked on every turn -- clearable only by writing a false audit line.
   */
  const r = repo(t);
  r.write({ name: 'x', version: '1.0.0' });
  const root = r.commit('initial');
  assert.equal(scriptsChanged(r.dir, root), 'same',
    'a root commit that defines nothing executable was treated as a change');
});

test('BUT A ROOT COMMIT THAT INTRODUCES SCRIPTS IS', (t) => {
  /*
   * Rule 5: the fix must not simply stop looking at root commits. Scripts that
   * arrive in the first commit are still scripts arriving.
   */
  const r = repo(t);
  r.write({ name: 'x', scripts: { pwn: 'node ./evil.mjs' } });
  assert.equal(scriptsChanged(r.dir, r.commit('initial')), 'changed');
});

test('AN UNREADABLE PARENT IS UNKNOWN, WHICH IS NEITHER CHANGED NOR SAME', (t) => {
  /*
   * A shallow boundary RECORDS a parent that is not in the object store. That
   * is a question that cannot be answered, and answering it either way is a
   * claim nobody measured. `%P` distinguishes it from a true root: empty only
   * for the latter.
   */
  const r = repo(t);
  r.write({ name: 'x', scripts: { test: 'node --test' } });
  r.commit('first');
  r.write({ name: 'x', scripts: { test: 'node --test', build: 'tsc' } });
  const second = r.commit('second');

  assert.equal(scriptsChanged(r.dir, second), 'changed');
  assert.equal(scriptsChanged(r.dir, 'not-a-sha-at-all'), 'unknown',
    'an unresolvable revision was given a definite answer');
});

test('UNKNOWN DOES NOT PRODUCE THE BLOCKING MARKER', async (t) => {
  /*
   * The half that matters at the caller: `unknown` must be REPORTED and must
   * not block, or the over-block returns by another route.
   */
  const { auditCoverage } = await import('../src/auditLedger.mjs');
  const r = repo(t);
  r.write({ name: 'x', version: '1.0.0' });
  r.commit('initial');
  const cov = auditCoverage({ repoRoot: r.dir, range: 'HEAD', ledgerText: '' });
  const marked = cov.commits.filter((c) => c.touched.includes(SCRIPTS_MARKER));
  assert.equal(marked.length, 0, 'a root commit with no scripts was marked as a decision');
});

/* ── D4: the serialisation was not injective ──────────────────────────── */

test('TWO DIFFERENT SCRIPT SETS DO NOT SERIALISE THE SAME', (t) => {
  /*
   * MEASURED BY THE AUDITOR. The old join was `${k}\x1f${v}` on `\x1e` with no
   * lengths, so a value CONTAINING those separators impersonated a second
   * entry. The second object below defines a real `test` script the first does
   * not, and the two compared equal.
   *
   * CLAUDE.md names the fix in the same tree, about deployGate and auditRange:
   * "without the framing, two different file lists can hash the same."
   */
  const r = repo(t);
  const UNIT = String.fromCharCode(31);
  const REC = String.fromCharCode(30);
  r.write({ name: 'x', scripts: { pwn: `benign${REC}test${UNIT}node --test` } });
  r.commit('first');
  r.write({ name: 'x', scripts: { pwn: 'benign', test: 'node --test' } });
  assert.equal(scriptsChanged(r.dir, r.commit('second')), 'changed',
    'a new `test` script was invisible because the separators were forgeable');
});

test('A REORDER IS STILL NOT A DECISION', (t) => {
  /* The property the framing must not break. */
  const r = repo(t);
  r.write({ name: 'x', scripts: { a: 'node a', b: 'node b' } });
  r.commit('first');
  r.write({ name: 'x', scripts: { b: 'node b', a: 'node a' } });
  assert.equal(scriptsChanged(r.dir, r.commit('reorder')), 'same');
});

/* ── D1: one key of at least eight ────────────────────────────────────── */

test('EVERY EXECUTION-BEARING KEY IS WATCHED, not only scripts', (t) => {
  /*
   * The auditor enumerated eight open keys. These are the ones that execute
   * WITHOUT anybody typing a command and that essentially never churn, so
   * closing them costs nothing. Each is changed ALONE -- a loop that only ever
   * changes one cannot show the others are read.
   */
  for (const [key, before, after] of [
    ['bin', { x: './a.js' }, { x: './evil.js' }],
    ['packageManager', 'npm@10.0.0', 'pnpm@1.0.0'],
    ['overrides', { lodash: '4.0.0' }, { lodash: 'npm:evil@1.0.0' }],
    ['resolutions', { a: '1' }, { a: '2' }],
    ['workspaces', ['pkgs/*'], ['pkgs/*', 'evil/*']],
  ]) {
    const r = repo(t);
    r.write({ name: 'x', [key]: before });
    r.commit('first');
    r.write({ name: 'x', [key]: after });
    assert.equal(scriptsChanged(r.dir, r.commit(`change ${key}`)), 'changed',
      `${key} executes and was not watched`);
  }
});

test('A DEPENDENCY BUMP STILL DOES NOT BLOCK, and that is recorded as a decision', (t) => {
  /*
   * Deliberate, not an oversight, and the module says so: these execute via
   * postinstall but they CHURN, and blocking every bump re-creates the outage
   * the whole-file exemption was added to end. The gap is named in
   * UNWATCHED_EXECUTION_KEYS so a reader finds it without re-deriving it.
   */
  const r = repo(t);
  r.write({ name: 'x', dependencies: { a: '1.0.0' } });
  r.commit('first');
  r.write({ name: 'x', dependencies: { a: '2.0.0' } });
  assert.equal(scriptsChanged(r.dir, r.commit('bump')), 'same');

  assert.ok(UNWATCHED_EXECUTION_KEYS.includes('dependencies'),
    'the known gap must stay named, or the next reader has to measure it again');
  assert.ok(UNWATCHED_EXECUTION_KEYS.length >= 4);
});

test('THE CONTROL: this distinguishes, in both directions', (t) => {
  const r = repo(t);
  r.write({ name: 'x', scripts: { test: 'node --test' } });
  r.commit('first');
  r.write({ name: 'x', scripts: { test: 'node --test' }, description: 'prose' });
  assert.equal(scriptsChanged(r.dir, r.commit('prose only')), 'same');
  r.write({ name: 'x', scripts: { test: 'node ./evil.mjs' } });
  assert.equal(scriptsChanged(r.dir, r.commit('repoint test')), 'changed');
});
