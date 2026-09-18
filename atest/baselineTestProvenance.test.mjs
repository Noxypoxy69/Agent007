import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(REPO, 'bin', 'agentbridge-claude-guard.mjs');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * "EXISTS" WAS STANDING IN FOR "WAS INHERITED".
 *
 * The baseline-test rule stops a session weakening a test it INHERITED. With no
 * snapshot to consult, the guard fell back to asking whether the file exists
 * NOW -- so a test file the session had just written became immutable the
 * instant it hit disk.
 *
 * Measured by a blind auditor, 2026-09-18: it created test/zzaudit2.test.mjs
 * and one second later was refused an edit with "was present when the session
 * began". It was not; the auditor created it. That breaks iterating on a probe,
 * which is the workflow rule 20 depends on -- the fifth time a documented step
 * has been blocked for precisely the people required to perform it.
 *
 * Sessions WITH a snapshot were never affected: a file absent from the snapshot
 * is not baseline. This is the snapshot-less path, which is the one an auditor
 * and any session started outside the repo actually take.
 *
 * Both directions are pinned below. A rule that cannot refuse anything is not a
 * rule, and a rule that refuses everything is an outage.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'provenance-'));
  const home = mkdtempSync(path.join(tmpdir(), 'provenance-home-'));
  t.after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });

  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'test', 'inherited.test.mjs'),
    'import test from "node:test"; test("inherited", () => {});\n');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '-A'); git('commit', '-qm', 'base');

  // Written AFTER the commit: this is the auditor's own probe.
  writeFileSync(path.join(root, 'test', 'zzprobe.test.mjs'),
    'import test from "node:test"; test("probe", () => {});\n');
  return { root, home };
}

function judgeEdit({ root, home }, rel) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: rel, old_string: 'a', new_string: 'b' },
      cwd: root,
      session_id: 'a-session-with-no-snapshot',
    }),
    encoding: 'utf8', cwd: REPO,
    env: { ...process.env, AGENTBRIDGE_HOME: home, CLAUDE_PROJECT_DIR: root },
  });
  const out = (r.stdout ?? '').trim();
  if (!out || out === '{}') return { decision: 'allow', reason: '' };
  const j = JSON.parse(out);
  const d = j.hookSpecificOutput?.permissionDecision ?? null;
  return { decision: d === 'deny' ? 'deny' : 'allow', reason: j.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

test('A TEST THE SESSION JUST CREATED IS NOT A BASELINE TEST', (t) => {
  const env = fixture(t);
  const { decision, reason } = judgeEdit(env, 'test/zzprobe.test.mjs');
  assert.equal(decision, 'allow',
    'an auditor must be able to iterate on its own probe; it was refused with '
    + `"was present when the session began" for a file it had just written. Got: ${reason.slice(0, 200)}`);
});

test('BUT AN INHERITED TEST IS STILL IMMUTABLE WITHOUT A SNAPSHOT', (t) => {
  /*
   * RULE 5, and it is the whole reason the fallback existed. If this passes only
   * because the rule stopped refusing anything, the fix above is a hole.
   */
  const env = fixture(t);
  const { decision, reason } = judgeEdit(env, 'test/inherited.test.mjs');
  assert.equal(decision, 'deny', 'a committed test came with the checkout and must stay immutable');
  assert.match(reason, /\[agentbridge:/, 'and ours must be the layer that said so');
});

test('A TREE GIT CANNOT DESCRIBE FAILS CLOSED', (t) => {
  /*
   * The fallback now asks git, so what happens when git has no answer matters.
   * Unknown is not permitted -- it is only no longer the answer when a better
   * one exists.
   */
  const root = mkdtempSync(path.join(tmpdir(), 'provenance-nogit-'));
  const home = mkdtempSync(path.join(tmpdir(), 'provenance-nogit-home-'));
  t.after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'test', 'orphan.test.mjs'),
    'import test from "node:test"; test("x", () => {});\n');
  // deliberately NOT a git repository

  const { decision } = judgeEdit({ root, home }, 'test/orphan.test.mjs');
  assert.equal(decision, 'deny',
    'with no snapshot AND no repository to ask, an existing test stays immutable: '
    + 'cannot-establish is not permitted');
});
