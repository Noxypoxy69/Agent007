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
 * A STANDING BROAD GRANT, AND THE ONE THING IT STILL CANNOT REACH.
 *
 * The channel accepted exact paths only -- "no prefixes, no globs" -- and that
 * argument assumes MANY NARROW ACTORS each needing a few files. This machine
 * has THREE generalists who work across the whole repository. Danny, after
 * asking roughly ten times: "Then we have idle agents there's only 3 of you, I
 * can't make 200 agents so they can all have small access."
 *
 * Under no-globs the only expressible full grant is an enumeration of twenty
 * protected paths plus every test file. Nobody writes that by hand, so what
 * actually got written was a four-path grant and the work stayed blocked. The
 * rule did not produce least privilege. It produced idle agents.
 *
 * So "*" is accepted as a WHOLE ENTRY. The tests below pin what that does and
 * -- more importantly -- what it still does not do, because a wildcard that
 * quietly became an off switch would be the worst outcome available here.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function grantKey() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: REPO, encoding: 'utf8' }).trim();
  return crypto.createHash('sha256')
    .update(commonDir.split('\\').join('/').toLowerCase())
    .digest('hex').slice(0, 16);
}

function homeWith(grant, t) {
  const home = mkdtempSync(path.join(tmpdir(), 'wildcard-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const f = path.join(home, 'overrides', `${grantKey()}.json`);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(grant));
  return home;
}

function judge(tool, input, home) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: REPO, session_id: 's' }),
    encoding: 'utf8', cwd: REPO, env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  const out = (r.stdout ?? '').trim();
  if (!out || out === '{}') return { decision: 'allow', text: '' };
  const j = JSON.parse(out);
  const d = j.hookSpecificOutput?.permissionDecision ?? null;
  return {
    decision: d === 'deny' ? 'deny' : 'allow',
    text: j.hookSpecificOutput?.permissionDecisionReason ?? j.systemMessage ?? '',
  };
}

const WILDCARD = {
  paths: ['*'],
  actions: ['*'],
  reason: 'full access, directed by the owner',
  granted_by: 'danny',
  expires_at: new Date(Date.now() + 36e5).toISOString(),
};

test('A WILDCARD GRANT COVERS PROTECTED CONTROLS, which is the whole point', (t) => {
  const home = homeWith(WILDCARD, t);
  for (const rel of ['src/claudeGuard.mjs', 'src/guardSession.mjs', 'CLAUDE.md', 'package.json']) {
    const { decision, text } = judge('Write', { file_path: rel, content: '// x\n' }, home);
    assert.equal(decision, 'allow', `${rel} must be writable under a full grant: ${text.slice(0, 160)}`);
  }
});

test('AND IT ANNOUNCES ITSELF, so a broad permit is not a silent one', (t) => {
  const home = homeWith(WILDCARD, t);
  const { text } = judge('Write', { file_path: 'src/claudeGuard.mjs', content: '// x\n' }, home);
  assert.match(text, /danny/, 'the grantor must be named');
  assert.match(text, /full access, directed by the owner/, 'the reason must be carried');
  assert.match(text, /\d{4}-\d{2}-\d{2}T/, 'the expiry must be carried');
});

test('BUT IT DOES NOT REACH THE GATE OWN CONFIGURATION -- the one hard limit', (t) => {
  /*
   * This is what keeps a wildcard from being an off switch. .claude/settings.json
   * decides whether the guard runs AT ALL, and the Stop gate refuses an override
   * for it regardless of what any grant says. If this ever passes, the wildcard
   * has stopped being "broad" and become "disarm".
   */
  const home = homeWith(WILDCARD, t);
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const { decision, text } = judge('Write', { file_path: rel, content: '{}' }, home);
    assert.equal(decision, 'deny', `${rel} must stay refused even under a wildcard grant`);
    assert.match(text, /\[agentbridge:/, 'and ours must be the layer refusing it');
  }
});

test('A WILDCARD ACTION GRANT PERMITS OWNER-GATED TOOLS', (t) => {
  const home = homeWith(WILDCARD, t);
  for (const tool of [
    'mcp__claude_ai_Supabase__execute_sql',
    'mcp__claude_ai_Supabase__apply_migration',
    'mcp__claude_ai_Gmail__send_message',
  ]) {
    assert.equal(judge(tool, {}, home).decision, 'allow', `${tool} must be permitted under a full grant`);
  }
});

test('AN EXPIRED WILDCARD IS STILL NO GRANT', (t) => {
  /*
   * Every other protection on this channel survives the wildcard. If breadth
   * also bought permanence, a forgotten grant would be a permanent disarm --
   * and "narrow, expiring and loud" was the whole safety argument, of which
   * only "narrow" was traded away.
   */
  const home = homeWith({ ...WILDCARD, expires_at: new Date(Date.now() - 1000).toISOString() }, t);
  assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, home).decision, 'deny');
  assert.equal(judge('mcp__claude_ai_Supabase__execute_sql', {}, home).decision, 'deny');
});

test('A WILDCARD BEYOND THE HORIZON IS NO GRANT EITHER', (t) => {
  const home = homeWith({ ...WILDCARD, expires_at: '+275760-09-13T00:00:00.000Z' }, t);
  assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, home).decision, 'deny',
    'MAX_GRANT_MS still bounds it: breadth must not buy permanence');
});

test('A WILDCARD WITH NO REASON IS NO GRANT', (t) => {
  const home = homeWith({ paths: ['*'], actions: ['*'], granted_by: 'danny', expires_at: new Date(Date.now() + 36e5).toISOString() }, t);
  assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, home).decision, 'deny',
    'somebody still has to say why, in a sentence another person can disagree with');
});

test('ONLY THE WHOLE TOKEN, not a prefix and not a pattern language', (t) => {
  /*
   * "*" is accepted because it means exactly what it looks like. Accepting
   * "src/*" would require a reader to reason about what a glob covers, and the
   * original no-globs argument is right about that.
   */
  for (const bogus of ['src/*', '*.mjs', 'src/**', '.claude/*']) {
    const home = homeWith({ ...WILDCARD, paths: [bogus] }, t);
    assert.equal(judge('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, home).decision, 'deny',
      `${bogus} must not be treated as a pattern; only the exact token "*" is a wildcard`);
  }
});
