/**
 * Live proof, not a unit test: spawn a REAL process whose argv contains a real
 * secret, inside a REAL worktree, then run the actual probe and assert the
 * secret is absent from the published payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/exec.mjs';
import { probeProcesses } from '../src/processes.mjs';
import { collect } from '../src/collect.mjs';

const TOKEN = 'ghp_zZyYxXwWvVuUtTsSrRqQpPoOnNmMlLkK9876';
const DBURL = 'postgres://admin:sup3rs3cretpw@db.internal:5432/prod';

test('a real process with a secret in argv publishes nothing sensitive', async (t) => {
  if (process.platform === 'win32') return t.skip('probe path differs on windows');

  const root = await mkdtemp(path.join(tmpdir(), 'ab-argv-'));
  const repo = path.join(root, 'wt');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '-b', 'main', repo]);
  for (const [k, v] of [['user.email', 'a@b.c'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
    await run('git', ['config', k, v], { cwd: repo });
  }
  await writeFile(path.join(repo, 'README.md'), '# x\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['commit', '-m', 'init'], { cwd: repo });

  // A realistic gate-harness invocation carrying secrets in argv, running with
  // cwd inside the worktree so attribution is exact rather than heuristic.
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'scripts/check-gates-can-fail.mjs'), 'setTimeout(()=>{}, 15000);\n');
  const child = spawn(process.execPath, [
    'scripts/check-gates-can-fail.mjs',
    '--token', TOKEN, '--database-url', DBURL, 'SUPABASE_SERVICE_KEY=' + TOKEN,
  ], { cwd: repo, stdio: 'ignore', detached: false });

  try {
    await new Promise((r) => setTimeout(r, 700));

    const probe = await probeProcesses([repo]);
    assert.equal(probe.probeOk, true);
    const mine = (probe.byWorktree[repo] ?? []).find((p) => p.pid === child.pid);
    assert.ok(mine, 'the spawned process was found in its own worktree');
    assert.equal(mine.kind, 'gates-can-fail');
    assert.equal(mine.confidence, 'cwd');

    // The probe result itself.
    const asJson = JSON.stringify(mine);
    assert.equal(asJson.includes(TOKEN), false, 'github token leaked from argv');
    assert.equal(asJson.includes('sup3rs3cretpw'), false, 'db password leaked from argv');
    assert.equal('command' in mine, false, 'raw command line must not be published');
    assert.ok(mine.redactedCount >= 3, `expected redactions, got ${mine.redactedCount}`);
    assert.equal(mine.executable, path.basename(process.execPath));

    // The full heartbeat payload as it would go over the wire.
    const cfg = { machineId: 'x', machineLabel: 'test', mainRef: 'origin/main',
      redactSensitivePaths: true, lockDirs: ['.agentbridge/locks'], lanesFile: null };
    const payload = await collect(cfg, { agents: [{ agentId: 'code-c', lane: 'messaging', worktree: repo }] });
    const wire = JSON.stringify(payload);
    assert.equal(wire.includes(TOKEN), false, 'token reached the heartbeat payload');
    assert.equal(wire.includes('sup3rs3cretpw'), false, 'password reached the heartbeat payload');
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
