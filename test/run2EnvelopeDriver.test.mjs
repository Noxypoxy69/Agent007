import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE DRIVER, END TO END. CLAUDE.md rule 10, applied to T-117's own gap.
 *
 * T-118 mutated five decisions that live in scripts/run2-envelope.mjs --
 * untracked files dropped from status, drift stubbed to [], the roster checked
 * against itself, a missing token read as an empty list, a missing manifest
 * read as '' -- and all five survived, because only the pure classifier had
 * tests. These run the real script as a child process against a throwaway git
 * repository, a synthetic AGENTBRIDGE_HOME and a fake MCP server on 127.0.0.1,
 * and assert on the envelope it prints.
 *
 * Nothing here touches a live source: no real repo, no real home, no network
 * beyond loopback. Loopback also cannot reproduce the Windows exit-127 fetch
 * assertion (see test/rejectedIsNotUnreachable.test.mjs), so exit 0 here says
 * nothing about a remote run.
 */

const DRIVER = fileURLToPath(new URL('../scripts/run2-envelope.mjs', import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function tmp(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The fixture repository. Plain git on purpose: this is the thing under
 * observation, not code under test. */
const gitEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
  return env;
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', env: gitEnv() });

function repo(t) {
  const dir = tmp(t, 'run2-repo-');
  git(dir, 'init', '-q');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'CLAUDE.md'), 'rules\n');
  writeFileSync(path.join(dir, 'src/a.mjs'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/* A synthetic AGENTBRIDGE_HOME. Each part can be left out. */
function home(t, { candidates = 'consistent', registrations = 'fresh' } = {}) {
  const dir = tmp(t, 'run2-home-');
  const cand = path.join(dir, 'preserved', 'candidates');
  if (candidates !== 'no-dir') mkdirSync(cand, { recursive: true });
  if (candidates === 'consistent') {
    const body = Buffer.from('fixture patch\n');
    const d = sha256(body);
    const name = `T-900-${d.slice(0, 12)}.patch`;
    writeFileSync(path.join(cand, name), body);
    writeFileSync(path.join(cand, 'MANIFEST.txt'),
      `PRESERVED CANDIDATES\nOK        T-900  fixture\n          ${d}  ${body.length} B\n          to   ${path.join(cand, name)}\n`);
  }
  if (registrations === 'fresh') {
    writeFileSync(path.join(dir, 'registrations.json'), JSON.stringify([
      { agent_id: 'w1', session_id: 's1', capacity: 'idle', heartbeat_at: new Date().toISOString() },
    ]));
  } else if (registrations === 'empty') {
    writeFileSync(path.join(dir, 'registrations.json'), '[]');
  }
  return dir;
}

/* The fake reader surface: answers tools/call for list_tasks and list_agents. */
async function fakeMcp(t, { tasks, agents }) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const name = JSON.parse(body)?.params?.name;
      seen.push({ name, auth: req.headers.authorization });
      const rows = name === 'list_tasks' ? tasks : name === 'list_agents' ? agents : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(rows) }] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen };
}

const now = () => new Date().toISOString();
const freshTasks = () => [{ task_id: 't1', state: 'runnable', updated_at: now() }];
const liveAgent = (s) => ({ agentId: `w-${s}`, sessionId: s, capacity: 'idle', lastSeenAt: now() });

/* Run the real driver. ASYNC, so the in-process fake server can answer. */
function run({ repoDir, homeDir, mcp = null }) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // An inherited GIT_OPTIONAL_LOCKS would hide F2; inherited AGENTBRIDGE_*
    // would point the driver at a real home or a real server.
    if (/^(NODE_TEST|AGENTBRIDGE_|GIT_)/i.test(k)) delete env[k];
  }
  env.AGENTBRIDGE_HOME = homeDir;
  if (mcp) { env.AGENTBRIDGE_READER_TOKEN = 'fixture-reader'; env.AGENTBRIDGE_MCP_URL = mcp.url; }
  return new Promise((resolve) => {
    execFile(process.execPath, [DRIVER, '--repo', repoDir], { env, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
      const code = err ? err.code : 0;
      let envelope = null;
      try { envelope = JSON.parse(stdout); } catch { /* asserted below */ }
      resolve({ code, stdout, stderr, envelope });
    });
  });
}

async function envelopeOf(opts) {
  const r = await run(opts);
  assert.equal(r.code, 0, `driver exit ${r.code}\n${r.stderr}`);
  assert.ok(r.envelope?.fields, `driver printed no envelope\n${r.stdout}\n${r.stderr}`);
  return r.envelope.fields;
}

test('POSITIVE CONTROL: clean repo, consistent home, matching roster -- 3 and 4 TRUSTED; 2 and 6 held for want of an anchor', async (t) => {
  const mcp = await fakeMcp(t, { tasks: freshTasks(), agents: [liveAgent('s1')] });
  const f = await envelopeOf({ repoDir: repo(t), homeDir: home(t), mcp });
  for (const id of ['baseline', 'protected_frozen']) {
    assert.equal(f[id].trust_state, 'TRUSTED', `${id}: ${f[id].reason}`);
  }
  // AMENDMENT 2: every row fresh and the registries in agreement, and still no
  // promotion -- the driver supplies no completeness anchor, and says so.
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    assert.equal(f[id].trust_state, 'UNTRUSTWORTHY', id);
    assert.equal(f[id].reason, 'no completeness anchor', `${id}: ${f[id].reason}`);
  }
  assert.deepEqual(mcp.seen.map((s) => s.name).sort(), ['list_agents', 'list_tasks']);
  assert.ok(mcp.seen.every((s) => s.auth === 'Bearer fixture-reader'), 'the reader token was not presented');
});

test('A1 through the driver: an untracked file leaves identity TRUSTED and populated', async (t) => {
  const repoDir = repo(t);
  const head = git(repoDir, 'rev-parse', 'HEAD').trim();
  writeFileSync(path.join(repoDir, 'stray.txt'), 'x\n');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  const c = f.baseline.value.components;
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
  assert.equal(c.head.trust_state, 'TRUSTED');
  assert.equal(c.head.value, head);
  assert.equal(c.repo_identity.value, path.basename(repoDir));
  assert.match(c.tree.value, /^[0-9a-f]{40}$/);
  assert.equal(c.cleanliness.trust_state, 'UNTRUSTWORTHY');
  assert.match(c.cleanliness.reason, /\?\? stray\.txt/);
});

test('A1 through the driver: a repository with NO HEAD keeps its identity and nulls HEAD and tree', async (t) => {
  const repoDir = tmp(t, 'run2-nohead-');
  git(repoDir, 'init', '-q');
  assert.equal(git(repoDir, 'status', '--porcelain', '--untracked-files=all'), '', 'precondition: clean porcelain');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  const c = f.baseline.value.components;
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
  assert.equal(c.repo_identity.trust_state, 'TRUSTED', c.repo_identity.reason);
  for (const k of ['head', 'tree']) {
    assert.equal(c[k].trust_state, 'UNTRUSTWORTHY', k);
    assert.equal(c[k].value, null, k);
  }
  assert.equal(c.cleanliness.trust_state, 'TRUSTED', c.cleanliness.reason);
});

test('T-129 D04: a FAILED drift query is unmeasured, never an empty drift list', async (t) => {
  // A corrupt index: refs still resolve, so identity is established, while
  // `git status` -- the drift query's first step -- cannot run. Asserted on the
  // DRIFT COMPONENT, because cleanliness fails here too and would mask a driver
  // that turned the failed query into [].
  const repoDir = repo(t);
  writeFileSync(path.join(repoDir, '.git', 'index'), Buffer.from('this is not a git index\n'));
  assert.match(git(repoDir, 'rev-parse', 'HEAD'), /^[0-9a-f]{40}/, 'precondition: refs still resolve');
  assert.throws(() => git(repoDir, 'status', '--porcelain'), 'precondition: status cannot read the index');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  const c = f.baseline.value.components;
  assert.equal(c.head.trust_state, 'TRUSTED', c.head.reason);
  assert.equal(c.drift.trust_state, 'UNTRUSTWORTHY', 'a failed drift query read as clean');
  assert.equal(c.drift.value, null);
  assert.match(c.drift.reason, /could not be measured/);
});

test('DRIVER a: an UNTRACKED file reaches field 3', async (t) => {
  const repoDir = repo(t);
  writeFileSync(path.join(repoDir, 'stray.txt'), 'x\n');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
  assert.match(f.baseline.reason, /\?\? stray\.txt/);
});

test('DRIVER b: the shipped drift query reaches field 3, by name', async (t) => {
  const repoDir = repo(t);
  git(repoDir, 'update-index', '--assume-unchanged', 'CLAUDE.md');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
  // Only baselineBlockingDriftFromGit classifies a path as `protected`.
  assert.match(f.baseline.reason, /baseline drift: CLAUDE\.md assume-unchanged protected/);
});

test('F3 through the driver: a skip-worktree file outside protected and test paths reaches field 3', async (t) => {
  const repoDir = repo(t);
  git(repoDir, 'update-index', '--skip-worktree', 'src/a.mjs');
  writeFileSync(path.join(repoDir, 'src/a.mjs'), 'export const a = 2;\n');
  assert.equal(git(repoDir, 'status', '--porcelain', '--untracked-files=all'), '', 'precondition: status hides the edit');
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
  assert.match(f.baseline.reason, /hidden from status: src\/a\.mjs skip-worktree/);
});

test('DRIVER c: the roster is checked against registrations.json, not against itself', async (t) => {
  const mcp = await fakeMcp(t, { tasks: freshTasks(), agents: [liveAgent('s1'), liveAgent('s-phantom')] });
  const f = await envelopeOf({ repoDir: repo(t), homeDir: home(t), mcp });
  assert.equal(f.channel_liveness.trust_state, 'UNTRUSTWORTHY');
  assert.match(f.channel_liveness.reason, /live in roster but not observed: s-phantom/);
});

test('DRIVER d: no reader token is a failed read, never an empty list', async (t) => {
  const f = await envelopeOf({ repoDir: repo(t), homeDir: home(t, { registrations: 'empty' }) });
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    assert.equal(f[id].trust_state, 'UNTRUSTWORTHY', id);
    assert.match(f[id].reason, /AGENTBRIDGE_READER_TOKEN is not set/, id);
  }
});

test('DRIVER e / D03: a MISSING manifest is ABSENT, with or without a candidates directory', async (t) => {
  for (const candidates of ['empty-dir', 'no-dir']) {
    const f = await envelopeOf({ repoDir: repo(t), homeDir: home(t, { candidates }) });
    assert.equal(f.protected_frozen.trust_state, 'ABSENT', `${candidates}: ${f.protected_frozen.reason}`);
    assert.equal(f.protected_frozen.value, null);
  }
});

test('F1: a MISSING registrations.json never gives field 6 TRUSTED', async (t) => {
  // An empty roster would agree with an empty observation. The file is absent,
  // so nothing was observed -- and that must not read as agreement.
  const mcp = await fakeMcp(t, { tasks: freshTasks(), agents: [] });
  const f = await envelopeOf({ repoDir: repo(t), homeDir: home(t, { registrations: 'none' }), mcp });
  assert.equal(f.channel_liveness.trust_state, 'UNTRUSTWORTHY');
  assert.match(f.channel_liveness.reason, /registrations\.json does not exist/);
});

/*
 * T-179 F1, THROUGH THE REAL DRIVER. `git ls-files -v` is one line per TRACKED
 * file, and it used to share one work budget with HEAD and tree: a large
 * sparse index nulled the whole of field 3. The fixture is 9000 index entries
 * with 12 000-character paths, no files on disk, every entry skip-worktree --
 * about 108M characters of index flags, over the old 10M-unit budget at one
 * unit per 8 characters -- built with plumbing in ~10 s. The driver runs as a
 * child with a kill timeout (run(): 60 s); the build has its own git timeouts.
 */
const gitIn = (cwd, args, input) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', env: gitEnv(), input, maxBuffer: 1 << 30, timeout: 90_000 });

test('T-179 F1 through the driver: an index too large for the cleanliness budget leaves HEAD, tree and identity TRUSTED', async (t) => {
  const repoDir = tmp(t, 'run2-bigindex-');
  gitIn(repoDir, ['init', '-q']);
  const blob = gitIn(repoDir, ['hash-object', '-w', '--stdin'], 'x\n').trim();
  const prefix = Array.from({ length: 60 }, (_, i) => `${'p'.repeat(195)}${String(i).padStart(4, '0')}`).join('/');
  const paths = Array.from({ length: 9000 }, (_, i) => `${prefix}/f${i}`);
  gitIn(repoDir, ['update-index', '--add', '--index-info'], `${paths.map((p) => `100644 ${blob}\t${p}`).join('\n')}\n`);
  const commit = gitIn(repoDir, ['commit-tree', gitIn(repoDir, ['write-tree']).trim(), '-m', 'big'], '').trim();
  gitIn(repoDir, ['update-ref', 'HEAD', commit]);
  gitIn(repoDir, ['update-index', '--skip-worktree', '--stdin'], `${paths.join('\n')}\n`);
  const flags = gitIn(repoDir, ['ls-files', '-v']);
  assert.ok(flags.length > 80_000_000, `premise: the index flags exceed the OLD budget (${flags.length} chars, needs > 8e7)`);
  assert.equal(gitIn(repoDir, ['status', '--porcelain', '--untracked-files=all']), '', 'premise: status is clean (every entry skip-worktree)');

  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  assert.ok(f.baseline.value, `field 3 lost its value: ${f.baseline.reason}`);
  const c = f.baseline.value.components;
  for (const k of ['repo_identity', 'head', 'tree']) assert.equal(c[k].trust_state, 'TRUSTED', `${k}: ${c[k].reason}`);
  assert.equal(c.head.value, commit, 'HEAD is the commit git answered');
  assert.equal(c.cleanliness.trust_state, 'UNTRUSTWORTHY', 'a sparse index is not clean');
  assert.equal(f.baseline.trust_state, 'UNTRUSTWORTHY');
});

test('F2: the driver leaves .git/index byte-identical and unmodified after a forced stat mismatch', async (t) => {
  const staleStat = (dir) => {
    const old = new Date('2001-01-01T00:00:00Z');
    utimesSync(path.join(dir, 'src/a.mjs'), old, old);
    utimesSync(path.join(dir, 'CLAUDE.md'), old, old);
  };
  const snap = (dir) => {
    const p = path.join(dir, '.git', 'index');
    return { sha: sha256(readFileSync(p)), mtime: statSync(p).mtimeMs };
  };

  // POSITIVE CONTROL: the fixture really does make a plain `git status` write.
  const twin = repo(t);
  staleStat(twin);
  const tBefore = snap(twin);
  git(twin, 'status', '--porcelain');
  assert.notEqual(snap(twin).sha, tBefore.sha, 'precondition: plain git status did not rewrite the index');

  const repoDir = repo(t);
  staleStat(repoDir);
  const before = snap(repoDir);
  const f = await envelopeOf({ repoDir, homeDir: home(t) });
  assert.equal(f.baseline.trust_state, 'TRUSTED', f.baseline.reason);
  const after = snap(repoDir);
  assert.equal(after.sha, before.sha, 'the driver rewrote .git/index');
  assert.equal(after.mtime, before.mtime, 'the driver touched .git/index');
});
