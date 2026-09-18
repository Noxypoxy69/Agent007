/**
 * A BASELINE TEST WAS THE ONE CONTROL WITH NO DOOR, AT EITHER LAYER.
 *
 * judgeWrite consulted the override only on the protected-path branch; the
 * baseline-test branch refused unconditionally. The Stop gate filtered
 * protectedDrift by the grant and never filtered baselineTestDrift. So a grant
 * naming a baseline test changed nothing at PreToolUse and nothing at Stop.
 *
 * Measured 2026-09-18: the over-block ratchet in test/guardToolRoster.test.mjs
 * went red DEMANDING the deletion of two stale entries, and no guarded session
 * could perform it. A guarded agent diagnosed the wall exactly and stopped. It
 * was cleared by the one session whose hooks had never loaded -- which is the
 * "bug being spent as a permission" that judgeWrite's own comment warns about,
 * happening in front of everyone.
 *
 * Both layers now honour the same grant. These tests assert that, and assert the
 * things that must NOT follow from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { overridePath, writeSnapshot } from '../src/guardSession.mjs';
import { evaluateClaudeTool, isSessionBaselineTest } from '../src/claudeGuard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'baseline-grant-session';

/*
 * realpath.native, because tmpdir() is an 8.3 short path on Windows and the
 * grant key canonicalises. An unresolved lab makes every grant look absent and
 * every denial look like correct behaviour -- which is how a previous probe
 * reported a working fix as broken.
 */
function lab(t, prefix) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scratchProject(t) {
  const dir = lab(t, 'ab-btg-');
  mkdirSync(path.join(dir, 'test'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'test', 'alpha.test.mjs'), "import {test} from 'node:test';\ntest('a', () => {});\n");
  writeFileSync(path.join(dir, 'test', 'beta.test.mjs'), "import {test} from 'node:test';\ntest('b', () => {});\n");
  writeFileSync(path.join(dir, 'docs', 'notes.md'), 'notes\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  g('add', '-A');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir, stdio: 'ignore' });
  return dir;
}

function withHome(t) {
  const home = lab(t, 'ab-btg-home-');
  mkdirSync(path.join(home, 'overrides'), { recursive: true });
  const prev = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = prev;
  });
  return home;
}

function grant(dir, home, paths, extra = {}) {
  writeFileSync(overridePath(dir, home), JSON.stringify({
    paths,
    reason: 'clear the stale over-block entries',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    ...extra,
  }));
}

const edit = (dir, file) => evaluateClaudeTool({
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  cwd: dir,
  session_id: SESSION,
});

/* ------------------------------------------------------------------ */
/* PreToolUse                                                          */
/* ------------------------------------------------------------------ */

test('without a grant a baseline test is still immutable', (t) => {
  const dir = scratchProject(t);
  withHome(t);
  writeSnapshot(dir, SESSION);

  // RULE 5: the positive first. If this file is not recognised as a baseline
  // test, every assertion below is about the wrong branch.
  assert.equal(isSessionBaselineTest('test/alpha.test.mjs', dir, SESSION), true,
    'precondition: the file must be recognised as a baseline test');

  const v = edit(dir, 'test/alpha.test.mjs');
  assert.equal(v.allowed, false);
  assert.equal(v.id, 'baseline-test-immutable');
});

test('a grant naming the test permits editing it, and says so', (t) => {
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);
  grant(dir, home, ['test/alpha.test.mjs']);

  const v = edit(dir, 'test/alpha.test.mjs');
  assert.equal(v.allowed, true, 'the grant must reach the baseline-test branch');
  assert.equal(v.overridden, true);
  assert.match(v.notice, /\[agentbridge:baseline-test-overridden\]/);
  assert.match(v.notice, /test\/alpha\.test\.mjs/);
  assert.match(v.notice, /granted by danny/i);
  assert.match(v.notice, /expires/i);
});

test('the grant reaches ONLY the test it names', (t) => {
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);
  grant(dir, home, ['test/alpha.test.mjs']);

  assert.equal(edit(dir, 'test/alpha.test.mjs').allowed, true);
  const other = edit(dir, 'test/beta.test.mjs');
  assert.equal(other.allowed, false, 'a grant for one test must not cover a sibling');
  assert.equal(other.id, 'baseline-test-immutable');
});

test('an expired grant is no grant', (t) => {
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);
  grant(dir, home, ['test/alpha.test.mjs'], { expires_at: new Date(Date.now() - 1000).toISOString() });

  const v = edit(dir, 'test/alpha.test.mjs');
  assert.equal(v.allowed, false, 'an expired grant must not reach this branch either');
  assert.equal(v.id, 'baseline-test-immutable');
});

test('a grant for a DECOY path cannot reach a baseline test through a symlink', (t) => {
  /*
   * The protected branch already had this hardening: the grant must cover EVERY
   * spelling the path resolves to, or a grant for docs/notes.md becomes a write
   * permit for whatever it points at. Giving the baseline branch a grant check
   * by copying four lines is exactly how that hole would be reintroduced in a
   * second place, so the resolution is SHARED. This asserts the sharing.
   *
   * THE DEFENCE IS REDUNDANT, AND A ONE-LAYER MUTATION CANNOT SHOW THAT. Two
   * mechanisms stop this independently and either is sufficient: grantFor's
   * rels.every(...), and repoRelative resolving the link before overrideCovers
   * matches. Mutating either alone leaves this green, which reads as a hollow
   * gate and is not. Removing BOTH produces the real hole -- measured:
   * allowed=true, overridden=true, announcing "docs/notes.md" while editing a
   * baseline test -- and this goes red. CLAUDE.md rule 11.
   */
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);
  grant(dir, home, ['docs/notes.md']);

  const link = path.join(dir, 'docs', 'notes.md');
  rmSync(link);
  try {
    symlinkSync(path.join(dir, 'test', 'alpha.test.mjs'), link);
  } catch (e) {
    t.skip(`symlinks not permitted here (${e.code})`);
    return;
  }

  const v = edit(dir, 'docs/notes.md');
  assert.equal(v.allowed, false,
    'a grant for docs/notes.md became a permit to edit the baseline test it points at');
});

test('FOLLOWING the refusal, literally, works — for every spelling it quotes back', (t) => {
  /*
   * THIS TEST USED TO ASSERT /override/i AND NOTHING ELSE. It would have stayed
   * green if the advice were "ask a wizard for an override", and it was: the
   * message said "naming this exact path" and echoed the caller's spelling,
   * while grant.paths is compared LITERALLY against the canonical form. An
   * operator who copied TEST/ALPHA.TEST.MJS or ./test/alpha.test.mjs out of the
   * refusal wrote a grant that did nothing, and the pressure went straight back
   * to the session whose hooks had never loaded.
   *
   * Found by audit, in the commit that added the message specifically to stop
   * naming routes that do not work -- the fourth instance of that class here in
   * two days. So the test now DOES what the refusal says and asserts the result,
   * which is the only form of this assertion that can fail for the real reason.
   */
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);

  const spellings = [
    'test/alpha.test.mjs',
    './test/alpha.test.mjs',
    'test/./alpha.test.mjs',
    'TEST/ALPHA.TEST.MJS',
  ];

  for (const spelling of spellings) {
    // A grant that names something else entirely, so each round starts refused.
    grant(dir, home, ['nothing/at/all.txt']);

    const refused = edit(dir, spelling);
    assert.equal(refused.allowed, false, `${spelling}: precondition — must be refused before the grant`);

    const named = /override naming (\S+)/.exec(refused.reason);
    assert.ok(named, `${spelling}: the refusal must name a path to grant. Got: ${refused.reason}`);

    // Do exactly what it says, with exactly the string it printed.
    grant(dir, home, [named[1]]);
    const after = edit(dir, spelling);
    assert.equal(after.allowed, true,
      `${spelling}: the refusal said to grant "${named[1]}", and that grant did not work`);
  }
});

test('the announcement names the file that is WRITTEN, not the one that was typed', (t) => {
  /*
   * grantFor returned rels[0] -- the lexical candidate, i.e. the caller's
   * spelling. So a grant for the test, exercised through a symlink, permitted
   * correctly and then announced the symlink: the transcript recorded a doc
   * edit while a baseline test was rewritten. The permit half of this hazard was
   * hardened and the announcement half was not, in the commit whose own comment
   * says the hardening exists because a grant "announced the wrong file".
   */
  const dir = scratchProject(t);
  const home = withHome(t);
  writeSnapshot(dir, SESSION);
  grant(dir, home, ['test/alpha.test.mjs']);

  const link = path.join(dir, 'docs', 'notes.md');
  rmSync(link);
  try {
    symlinkSync(path.join(dir, 'test', 'alpha.test.mjs'), link);
  } catch (e) {
    t.skip(`symlinks not permitted here (${e.code})`);
    return;
  }

  const v = edit(dir, 'docs/notes.md');
  assert.equal(v.allowed, true, 'precondition: the grant names the real file, so the write is permitted');
  assert.match(v.notice, /test\/alpha\.test\.mjs/,
    `the notice must name the file actually written. Got: ${v.notice}`);
  assert.ok(!/docs\/notes\.md/.test(v.notice),
    `the notice named the typed path instead of the written file: ${v.notice}`);
});

/* ------------------------------------------------------------------ */
/* Stop                                                                */
/* ------------------------------------------------------------------ */

function scratchRepoWithGuard(t) {
  const dir = lab(t, 'ab-btg-stop-');
  for (const d of ['src', 'scripts', 'bin']) cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  for (const d of ['.claude', 'docs', 'test']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'CLAUDE.md', 'THIRD_PARTY_CODE.md']) {
    writeFileSync(path.join(dir, f), '{}\n');
  }
  for (const f of ['docs/ORDER.md', 'docs/ROADMAP.md', 'docs/CLAUDE_GUARD_PROVENANCE.md',
    '.claude/settings.json', 'test/claudeGuard.test.mjs']) {
    writeFileSync(path.join(dir, f), 'x\n');
  }
  writeFileSync(path.join(dir, 'test', 'inherited.test.mjs'), "import {test} from 'node:test';\ntest('i', () => {});\n");
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '.');
  run('add', '-A');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir, stdio: 'ignore' });
  return dir;
}

function stop(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'claude-stop-gate.mjs')], {
    input: JSON.stringify({ session_id: SESSION }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AGENTBRIDGE_HOME: path.join(dir, 'home') },
  });
  let parsed = {};
  try { parsed = JSON.parse(r.stdout || '{}'); } catch { parsed = {}; }
  return { reason: parsed.reason ?? '', systemMessage: parsed.systemMessage ?? '' };
}

test('Stop APPENDS its notices — a granted control and a granted test are both announced', (t) => {
  /*
   * carriedNotice may already hold the protected-control announcement when the
   * baseline-test one is produced. Assigning over it drops one of two records
   * silently, and "recorded anyway" is the entire mitigation this design rests
   * on. The commit argued for APPEND at length and tested it nowhere: an audit
   * mutated it to an assignment and 104 guard/stop/override/roster tests stayed
   * green while an announcement disappeared.
   */
  const dir = scratchRepoWithGuard(t);
  const home = path.join(dir, 'home');
  stop(dir);                                   // mints the baseline

  // Drift BOTH a protected control and an inherited test, and grant both.
  writeFileSync(path.join(dir, 'docs', 'ROADMAP.md'), 'roadmap, edited\n');
  writeFileSync(path.join(dir, 'test', 'inherited.test.mjs'), "import {test} from 'node:test';\n// repaired\n");
  mkdirSync(path.join(home, 'overrides'), { recursive: true });
  writeFileSync(overridePath(dir, home), JSON.stringify({
    paths: ['docs/ROADMAP.md', 'test/inherited.test.mjs'],
    reason: 'repair both',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
  }));

  const after = stop(dir);
  const all = `${after.systemMessage}${after.reason}`;
  assert.match(all, /protected-control-overridden/,
    'the protected-control announcement was dropped');
  assert.match(all, /baseline-test-overridden/,
    'the baseline-test announcement was dropped');
});

test('Stop still reports an UNGRANTED baseline-test change', (t) => {
  const dir = scratchRepoWithGuard(t);
  stop(dir);                                  // mints the baseline
  writeFileSync(path.join(dir, 'test', 'inherited.test.mjs'), "import {test} from 'node:test';\n// weakened\n");

  const after = stop(dir);
  assert.match(after.reason, /baseline-test-changed/,
    'an ungranted change to an inherited test must still be reported');
});

test('Stop does NOT report a GRANTED baseline-test change, and records it instead', (t) => {
  /*
   * Both layers or neither. If PreToolUse permits the write and Stop still
   * refuses the result, the grant buys the edit and then blocks the turn -- a
   * permission that cannot be spent, which is worse than no permission because
   * it looks like one.
   */
  const dir = scratchRepoWithGuard(t);
  const home = path.join(dir, 'home');
  stop(dir);                                  // mints the baseline

  writeFileSync(path.join(dir, 'test', 'inherited.test.mjs'), "import {test} from 'node:test';\n// repaired\n");
  mkdirSync(path.join(home, 'overrides'), { recursive: true });
  writeFileSync(overridePath(dir, home), JSON.stringify({
    paths: ['test/inherited.test.mjs'],
    reason: 'repair the stale ratchet',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
  }));

  const after = stop(dir);
  assert.ok(!/baseline-test-changed/.test(after.reason),
    `a granted change must not be reported as drift, got: ${after.reason}`);
  assert.match(`${after.systemMessage}${after.reason}`, /baseline-test-overridden/,
    'a granted change must still be ANNOUNCED, not silently accepted');
});
