import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(REPO, 'bin', 'agentbridge-claude-guard.mjs');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WIRING, NOT THE CLASSIFIER.
 *
 * test/actionAuthority.test.mjs proves classifyAction returns the right verdict.
 * That is a different claim from "the shipped guard refuses the action", and
 * CLAUDE.md rule 17 is the whole reason the difference matters: the guard's unit
 * tests were green for a day while nothing on the machine consulted it, because
 * they call the module directly and the module was never the broken part.
 *
 * So every assertion here goes through bin/agentbridge-claude-guard.mjs as a
 * PROCESS, reading its real stdout. Rule 4: never assert on a proxy. The DEMAND
 * test in the sibling file checks that claudeGuard IMPORTS the classifier, which
 * is a proxy for consulting it -- an import satisfies that assertion while the
 * verdict is thrown away.
 *
 * WHY EACH GRANT GETS ITS OWN AGENTBRIDGE_HOME: without it these write fixtures
 * into the operator's live guard store. Rule 20 says an audit that does this has
 * contaminated the thing it is measuring; the same applies to a test.
 *
 * WHY THE GRANT KEY IS DERIVED AND NOT TYPED: the file is named
 * sha256(canonical git-common-dir)[0:16], so a literal here would be a fact
 * about one machine's checkout -- rule 21, which was written after a test
 * asserted an 8.3 alias that differs in every clone. This asks git.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function grantKey() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: REPO, encoding: 'utf8' }).trim();
  return crypto.createHash('sha256')
    .update(commonDir.split('\\').join('/').toLowerCase())
    .digest('hex').slice(0, 16);
}

/** A disposable AGENTBRIDGE_HOME, optionally carrying a grant. */
function homeWith(grant, t) {
  const home = mkdtempSync(path.join(tmpdir(), 'aa-wire-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (grant) {
    const f = path.join(home, 'overrides', `${grantKey()}.json`);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(grant));
  }
  return home;
}

/** Run the SHIPPED binary and report what it actually printed. */
function judge(toolName, input, home) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: toolName, tool_input: input, cwd: REPO }),
    encoding: 'utf8', cwd: REPO,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  const stdout = (r.stdout ?? '').trim();
  let decision = 'allow';
  let reason = '';
  if (stdout && stdout !== '{}') {
    try {
      const j = JSON.parse(stdout);
      const d = j.hookSpecificOutput?.permissionDecision ?? j.permissionDecision ?? null;
      if (d === 'deny') decision = 'deny';
      reason = j.hookSpecificOutput?.permissionDecisionReason ?? j.permissionDecisionReason ?? j.systemMessage ?? '';
    } catch {
      decision = 'unparseable';
      reason = stdout;
    }
  }
  return { decision, reason, stdout };
}

const OWNER_ACTIONS = [
  ['mcp__claude_ai_Supabase__apply_migration', 'production-state'],
  ['mcp__claude_ai_Supabase__deploy_edge_function', 'production-state'],
  ['mcp__claude_ai_Gmail__send_message', 'irreversible-outbound'],
  ['mcp__claude-in-chrome__computer', 'host-control'],
];

test('AN OWNER-LEVEL ACTION IS REFUSED BY THE SHIPPED GUARD WHEN NO GRANT APPROVES IT', (t) => {
  const home = homeWith(null, t);
  for (const [tool, consequence] of OWNER_ACTIONS) {
    const { decision, reason } = judge(tool, {}, home);
    assert.equal(decision, 'deny', `${tool} (${consequence}) must be refused without a grant`);
    assert.match(reason, /\[agentbridge:/,
      'the refusal must identify ITSELF as ours -- rule 18, a refusal from the wrong layer is a hollow gate wearing a pass');
  }
});

test('THE REFUSAL TELLS THE READER HOW TO GET APPROVAL, AND WHO MAY GIVE IT', (t) => {
  const home = homeWith(null, t);
  const { reason } = judge('mcp__claude_ai_Supabase__apply_migration', {}, home);
  /*
   * Rule 16's sibling problem: a refusal nobody can act on gets the guard
   * switched off. The registration recipe and the clone instruction were both
   * documented for people who could not perform them.
   */
  assert.match(reason, /actions/, 'must name the actions list a grant uses');
  assert.match(reason, /grant-path/, 'must name the command that prints WHICH file');
  assert.match(reason, /forged/, 'must say an agent writing its own approval has forged it');
});

test('THE REFUSAL DOES NOT CLAIM A SECOND LAYER IT DOES NOT HAVE', (t) => {
  const home = homeWith(null, t);
  const { reason } = judge('mcp__claude_ai_Gmail__send_message', { to: ['a@b.c'] }, home);
  /*
   * The old comment in claudeGuard said these were "detected at Stop", which was
   * an overclaim an audit caught: a sent email writes no repository file, so
   * protected-file drift has nothing to compare. Keep the honest sentence.
   */
  assert.match(reason, /writes no file|no second layer|no drift/i,
    'the refusal must not imply Stop will catch this, because Stop structurally cannot');
});

test('A GRANT NAMING THE EXACT ACTION PERMITS IT, AND ANNOUNCES ITSELF ON STDOUT', (t) => {
  const grant = {
    actions: ['mcp__claude_ai_Supabase__apply_migration'],
    reason: 'the migration the owner approved in chat',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 36e5).toISOString(),
  };
  const home = homeWith(grant, t);
  const { decision, stdout } = judge('mcp__claude_ai_Supabase__apply_migration', {}, home);
  assert.equal(decision, 'allow', 'an approved action must proceed');

  /*
   * THE FAR END, NOT THE RETURN VALUE. The path side of this channel shipped a
   * permit whose commit message said it "ANNOUNCES itself" while hookDecision
   * dropped the notice, because the test asserted on evaluateClaudeTool's return
   * value and never ran the binary. A silent permit is a clean run, and "a
   * forged grant does not vanish into a clean run" is this channel's entire
   * safety argument. So this reads stdout.
   */
  assert.notEqual(stdout, '{}', 'an approved permit must not be byte-identical to an ordinary allow');
  assert.match(stdout, /action-approved/, 'names the channel');
  assert.match(stdout, /danny/, 'names the grantor');
  assert.match(stdout, /the migration the owner approved in chat/, 'names the reason');
  assert.match(stdout, /\d{4}-\d{2}-\d{2}T/, 'carries the expiry');
});

test('A GRANT IS NOT A NAMESPACE: the approved action does not approve its neighbours', (t) => {
  const home = homeWith({
    actions: ['mcp__claude_ai_Supabase__apply_migration'],
    reason: 'one migration',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 36e5).toISOString(),
  }, t);
  assert.equal(judge('mcp__claude_ai_Supabase__apply_migration', {}, home).decision, 'allow',
    'RULE 5, the positive: the grant must actually work, or the refusals below prove nothing');
  for (const other of ['mcp__claude_ai_Supabase__deploy_edge_function', 'mcp__claude_ai_Gmail__send_message']) {
    assert.equal(judge(other, {}, home).decision, 'deny',
      `${other} is a different act and a different decision; a grant that leaked across the namespace `
      + 'would let one approval buy every action in it');
  }
});

test('A PATHS-ONLY GRANT APPROVES NO ACTION, AND AN ACTIONS-ONLY GRANT COVERS NO PATH', (t) => {
  const pathsOnly = homeWith({
    paths: ['src/claudeGuard.mjs'],
    reason: 'guard repair',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 36e5).toISOString(),
  }, t);
  assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, pathsOnly).decision, 'allow',
    'RULE 5: the path grant must work, or the refusal below is just a broken grant');
  assert.equal(judge('mcp__claude_ai_Supabase__apply_migration', {}, pathsOnly).decision, 'deny',
    'agreeing a FILE may be repaired is not agreeing a production migration may run');

  const actionsOnly = homeWith({
    actions: ['mcp__claude_ai_Supabase__apply_migration'],
    reason: 'one migration',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 36e5).toISOString(),
  }, t);
  assert.equal(judge('mcp__claude_ai_Supabase__apply_migration', {}, actionsOnly).decision, 'allow',
    'RULE 5: the action grant must work');
  assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, actionsOnly).decision, 'deny',
    'approving an ACTION is not approving a write to a protected control');
});

test('AN EXPIRED OR MALFORMED ACTION GRANT IS NO GRANT', (t) => {
  const base = {
    actions: ['mcp__claude_ai_Supabase__apply_migration'],
    reason: 'x',
    granted_by: 'danny',
  };
  const cases = [
    ['expired an hour ago', { ...base, expires_at: new Date(Date.now() - 36e5).toISOString() }],
    ['expiry is not a string', { ...base, expires_at: { toString: 1 } }],
    ['expiry is an array', { ...base, expires_at: [new Date(Date.now() + 36e5).toISOString()] }],
    ['expiry beyond the 30-day horizon', { ...base, expires_at: '+275760-09-13T00:00:00.000Z' }],
    ['no reason', { actions: base.actions, granted_by: 'danny', expires_at: new Date(Date.now() + 36e5).toISOString() }],
    ['names nothing at all', { paths: [], actions: [], reason: 'x', granted_by: 'danny', expires_at: new Date(Date.now() + 36e5).toISOString() }],
  ];
  for (const [label, grant] of cases) {
    const home = homeWith(grant, t);
    const { decision, stdout } = judge('mcp__claude_ai_Supabase__apply_migration', {}, home);
    assert.equal(decision, 'deny', `${label}: must not approve`);
    /*
     * And it must fail CLOSED rather than crashing. A malformed grant that threw
     * out of readOverride exited the binary non-zero with empty stdout, which
     * Claude Code reads as non-blocking -- so a bad grant DISABLED the guard
     * instead of being ignored. Found by audit on the path side; asserted here
     * so the action side cannot repeat it.
     */
    assert.notEqual(stdout, '', `${label}: the guard must answer, not die silently`);
  }
});

test('ORDINARY WORK IS NOT A DEFAULT-DENY OUTAGE', (t) => {
  const home = homeWith(null, t);
  /*
   * RULE 19, and it is the reason this is deny-unless-approved rather than
   * deny-everything-unrecognised. Denying by unknown name refused 25 of a real
   * 54-tool roster once, and an outage gets the hook switched off -- which loses
   * every layer at once. The classifier answers `unrestricted` for all of these,
   * and this asserts that the WIRING did not change that.
   */
  const mustProceed = [
    ['Read', { file_path: 'README.md' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '*' }],
    ['TodoWrite', {}],
    ['Write', { file_path: 'notes-not-protected.md', content: 'x' }],
    ['Bash', { command: 'git status --porcelain' }],
    ['SomeToolInventedAfterThisTestWasWritten', { harmless: true }],
    ['mcp__claude_ai_Supabase__list_tables', {}],
    ['mcp__claude_ai_Supabase__get_advisors', {}],
    ['mcp__claude_ai_Gmail__search_threads', { q: 'x' }],
    ['mcp__agentbridge-live__list_agents', {}],
  ];
  for (const [tool, input] of mustProceed) {
    const { decision, reason } = judge(tool, input, home);
    assert.equal(decision, 'allow', `${tool} must not be refused: ${reason.slice(0, 200)}`);
  }
});

test('A MALFORMED TOOL NAME FAILS CLOSED RATHER THAN PASSING AS UNRECOGNISED', (t) => {
  const home = homeWith(null, t);
  for (const bad of ['', '   ']) {
    assert.equal(judge(bad, {}, home).decision, 'deny',
      'an unnameable action is not an unrestricted one');
  }
});
