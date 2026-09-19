/**
 * THE ESCALATION MUST REACH out(), NOT carriedNotice. THAT WIRING IS THE
 * WHOLE DEFECT, AND IT WAS THE ONE THING NOT TESTED.
 *
 * src/auditLedger.mjs has always been able to say which commits changed a
 * control with no audit recorded. scripts/check-audit-coverage.mjs exits 1
 * with the list. The Stop gate has imported and called it on every turn since
 * 6dc5750 -- and appended the answer to `carriedNotice`, which is a
 * systemMessage. It never reached `out()`, which is the only thing that
 * blocks a turn.
 *
 * So rule 20 -- nobody certifies their own work -- was enforced by whether
 * somebody read a notice. On the night this was written, 101 commits were
 * pushed with 13 audited and nothing objected; the gate had already said so,
 * in a line underneath the override-grant block that everyone had stopped
 * reading.
 *
 * e53b8c8 changed the notice to a block. A blind audit then found that the
 * CHANGE ITSELF had no test: reverting `out(block)` back to a carriedNotice
 * append left the entire suite green. The unit tests cover auditEscalation()
 * thoroughly and stop at the module boundary, and the two integration tests
 * that drive the real gate build sandboxes where the escalation is inert --
 * which is exactly why nothing noticed.
 *
 * That is rule 17: the logic and the WIRING are separate claims, and only the
 * logic had a test. This file tests the wiring, by driving the shipped hook
 * against a repository where an unaudited control commit really has been
 * pushed, and asserting a decision comes back -- not a message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseImports, resolveSpecifier } from '../src/moduleGraph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A sandbox repository carrying the real hooks, with a REMOTE, so that
 * "pushed" is a question git can actually answer.
 *
 * The upstream matters: the escalation deliberately blocks only on work that
 * has LEFT the machine, because blocking on a local commit would fire on the
 * turn that wrote it and make guard work impossible. A fixture with no
 * upstream cannot tell the two apart, and would test neither.
 */
function guardedRepoWithRemote(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'esc-wiring-'));
  const home = mkdtempSync(path.join(tmpdir(), 'esc-home-'));
  const origin = mkdtempSync(path.join(tmpdir(), 'esc-origin-'));
  t.after(() => {
    for (const d of [root, home, origin]) rmSync(d, { recursive: true, force: true });
  });
  for (const d of ['src', 'test', 'scripts', 'bin', '.claude', 'docs']) {
    mkdirSync(path.join(root, d), { recursive: true });
  }

  /* Copy the real hooks and everything they import, so this drives shipped code. */
  const closureOf = (entries) => {
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      let src;
      try { src = readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
      for (const spec of parseImports(src).specifiers) {
        const target = resolveSpecifier(repoRoot, rel, spec);
        if (!target) continue;
        const t2 = target.split(path.sep).join('/');
        if (!seen.has(t2)) queue.push(t2);
      }
    }
    return [...seen];
  };
  for (const f of closureOf(['bin/agentbridge-claude-guard.mjs', 'scripts/claude-stop-gate.mjs'])) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    cpSync(path.join(repoRoot, f), path.join(root, f));
  }
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{"hooks":{"disableAllHooks":false}}\n');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# rules\n');
  writeFileSync(path.join(root, 'test', 'a.test.mjs'), 'import test from "node:test"; test("ok",()=>{});\n');

  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '--bare', '.'], { cwd: origin, stdio: 'ignore' });
  git('init', '-q', '.'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '-A'); git('commit', '-qm', 'base');

  /*
   * THE BASE COMMIT IS ITSELF AN UNAUDITED CONTROL COMMIT, and the first
   * version of this fixture did not notice.
   *
   * It carries the copied hooks -- scripts/claude-stop-gate.mjs and
   * bin/agentbridge-claude-guard.mjs -- so once pushed it escalates, and
   * every test below saw a block that had nothing to do with its own
   * scenario. Two of the three "failures" on the first run were this fixture,
   * not the subject. Rule 9: a fixture that cannot construct the real case
   * cannot test for it.
   *
   * So the base is recorded as audited, leaving exactly one variable per
   * test: the commit that test makes.
   */
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(
    path.join(root, 'docs', 'audit-ledger.jsonl'),
    `${JSON.stringify({ commit: baseSha, auditor: 'fixture-baseline' })}
`,
  );
  git('add', 'docs/audit-ledger.jsonl'); git('commit', '-qm', 'record the fixture baseline as audited');

  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'HEAD');
  return { root, home, git };
}

const hook = ({ root, home }, script, sessionId, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    timeout: 180000,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp',
      AGENTBRIDGE_HOME: home, CLAUDE_PROJECT_DIR: root,
    },
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { unparseable: r.stdout, stderr: r.stderr }; }
};
const sessionStart = (env, id) => hook(env, 'bin/agentbridge-claude-guard.mjs', id, ['--session-start']);
const stop = (env, id) => hook(env, 'scripts/claude-stop-gate.mjs', id);

/** Land a change to a DECISION-LOGIC control and push it, with no ledger entry. */
function pushUnauditedControl(env, note) {
  const rail = path.join(env.root, 'src', 'shellAllowlist.mjs');
  writeFileSync(rail, `${readFileSync(rail, 'utf8')}\n/* ${note} */\n`);
  env.git('commit', 'src/shellAllowlist.mjs', '-m', note);
  env.git('push', '-q', 'origin', 'HEAD');
}

test('A PUSHED UNAUDITED CONTROL COMMIT RETURNS A DECISION, NOT A MESSAGE', (t) => {
  const env = guardedRepoWithRemote(t);
  assert.match(sessionStart(env, 'W1').systemMessage ?? '', /initialised/,
    'precondition: a clean tree baselines');

  pushUnauditedControl(env, 'a rail change nobody audited');

  const verdict = stop(env, 'W1');

  /*
   * THE ASSERTION THAT WAS MISSING. `decision: 'block'` is what ends a turn.
   * A systemMessage carrying the same words is what the gate did for its
   * whole life before e53b8c8, and is indistinguishable from this if you only
   * check the text.
   */
  assert.equal(verdict.decision, 'block',
    `the escalation must BLOCK, not merely mention. Got: ${JSON.stringify(verdict).slice(0, 400)}`);
  assert.match(verdict.reason ?? '', /audit-escaped/,
    'and the reason must be the escalation, not some other refusal');
  assert.match(verdict.reason ?? '', /shellAllowlist/,
    'naming the file, or the reader cannot act on it');
});

test('A PUSHED DOCS COMMIT IS REPORTED BUT DOES NOT BLOCK', (t) => {
  /*
   * The outage direction, and the reason this gate nearly got switched off.
   * isAuditBearing derives from PROTECTED_PATHS, which includes CLAUDE.md and
   * package.json -- worth protecting a write to, but not rule-20 control
   * changes. Blocking on them stopped every turn on the operator's machine.
   */
  const env = guardedRepoWithRemote(t);
  sessionStart(env, 'W2');

  writeFileSync(path.join(env.root, 'CLAUDE.md'), '# rules\n\nrule 22: prose\n');
  env.git('commit', 'CLAUDE.md', '-m', 'a documentation edit');
  env.git('push', '-q', 'origin', 'HEAD');

  const verdict = stop(env, 'W2');
  assert.notEqual(verdict.decision, 'block',
    `a docs commit must not stop the turn. Got: ${JSON.stringify(verdict).slice(0, 400)}`);
});

test('AN UNPUSHED CONTROL COMMIT DOES NOT BLOCK THE TURN THAT WROTE IT', (t) => {
  /*
   * The other outage direction. If writing a guard commit blocked the very
   * turn that produced it, no guard change could ever land, the gate would be
   * disabled, and the drift check would go with it.
   */
  const env = guardedRepoWithRemote(t);
  sessionStart(env, 'W3');

  const rail = path.join(env.root, 'src', 'shellAllowlist.mjs');
  writeFileSync(rail, `${readFileSync(rail, 'utf8')}\n/* local only */\n`);
  env.git('commit', 'src/shellAllowlist.mjs', '-m', 'a rail change still local');

  const verdict = stop(env, 'W3');
  assert.notEqual(verdict.reason ?? '', undefined);
  assert.doesNotMatch(verdict.reason ?? '', /audit-escaped/,
    'unpushed work must not be escalated; the audit is ahead of the author');
});
